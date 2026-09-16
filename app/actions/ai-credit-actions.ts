"use server";

// AI-credit purchases + the AI-usage page's data. Credits revenue is
// STOREMINK's, so purchases run on the PLATFORM's Razorpay account (env
// RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) — a store does NOT need its own
// Channels gateway to buy credits.
//
// Lifecycle: startCreditPurchase (pending row + platform Razorpay order) →
// client pays in the Razorpay modal → confirmCreditPurchase (HMAC verify →
// paid → add_ai_credits). The add_ai_credits RPC is idempotent per payment id
// (unique partial index), so double-confirmation / reconcile races can never
// double-credit. Dropped callbacks are reconciled on AI-page load (the same
// reconcile-on-read pattern as order payments — no webhook in v1).

import { and, desc, eq, lte, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { emitEvent } from "@/lib/notifications/record";
import {
  draftCreditInvoice,
  issueCreditInvoice,
} from "@/lib/billing/credit-invoice";
import { aiCreditLedger, aiCreditPurchases, stores } from "@/drizzle/schema";
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
import { effectivePlan, NO_COMP } from "@/lib/plans";
import {
  getMinkCreditPackLive,
  getMinkCreditPacksLive,
} from "@/lib/ai/credit-pricing";
import { getAiUsage, type AiUsageSummary } from "@/lib/ai/quota";
import { getPlatformRazorpayCreds } from "@/lib/payments/provider";
import {
  capturedPayment,
  rzpCreateOrder,
  rzpFetchOrderPayments,
  verifyCapturedCheckoutPayment,
  verifyCheckoutSignature,
} from "@/lib/payments/razorpay";

// A purchase left `pending` this long is presumed dropped and gets reconciled
// against Razorpay on the next AI-page load.
const RECONCILE_AFTER_MS = 3 * 60_000;

export interface AiLedgerEntry {
  id: string;
  delta: number;
  kind: "purchase" | "grant" | "spend";
  note: string | null;
  created_at: string;
}

export interface AiUsagePageData {
  usage: AiUsageSummary;
  /** The store's EFFECTIVE plan (an expired timed plan resolves to free). */
  plan: string;
  /** ISO expiry of a timed plan (null = indefinite). */
  planExpiresAt: string | null;
  /** How the plan was granted: comp / paid / trial (or null). */
  planSource: string | null;
  /**
   * A comped plan the operator has offered but the merchant has NOT accepted.
   * Null once accepted — the window is what makes it `compActive` instead.
   */
  compOffer: { plan: string; durationDays: number } | null;
  /** A comped plan currently running (docs/comped-plans-spec.md). */
  compActive: { plan: string; expiresAt: string } | null;
  /**
   * The plan UNDERNEATH any comp — what they pay for and fall back to.
   *
   * ★ `plan` above is the EFFECTIVE plan, which during a comp IS the comped
   * one. The offer copy promises "your Basic plan continues", so it needs the
   * paid entitlement specifically; deriving it in the component would mean a
   * second copy of the resolution rule.
   */
  paidPlan: string;
  /** Whether this store's plan may buy credits (basic+). */
  canBuyCredits: boolean;
  /** Whether the platform's payment account is configured at all. */
  purchasesAvailable: boolean;
  ledger: AiLedgerEntry[];
}

// Mark a paid purchase + grant its credits, idempotently. Shared by the
// client confirm path and the reconcile pass.
async function settlePurchase(
  purchase: { id: string; store_id: string; credits: number; pack_id: string },
  rzpPaymentId: string,
): Promise<void> {
  try {
    const claimed = await withService((db) =>
      db
        .update(aiCreditPurchases)
        .set({
          status: "paid",
          rzpPaymentId,
          updatedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(aiCreditPurchases.id, purchase.id),
            eq(aiCreditPurchases.status, "pending"),
          ),
        )
        .returning({ id: aiCreditPurchases.id }),
    );
    // The status update lost the race (already paid). A concurrent winner may
    // still be between granting credits and issuing the receipt, or a previous
    // best-effort invoice write may have failed. Retrying the paid-finalization
    // is idempotent and repairs that document without granting credits twice.
    if (claimed.length === 0) {
      await issueCreditInvoice(purchase.id);
      return;
    }
  } catch (err) {
    console.error(
      "settlePurchase (status):",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  // Credits keyed on the payment id — a repeat call is a no-op (returns false).
  try {
    await withService((db) =>
      db.execute(
        sql`select add_ai_credits(p_store => ${purchase.store_id}, p_delta => ${purchase.credits}, p_kind => ${"purchase"}, p_ref => ${rzpPaymentId}, p_note => ${`pack ${purchase.pack_id}`})`,
      ),
    );
  } catch (err) {
    console.error(
      "settlePurchase (credits):",
      err instanceof Error ? err.message : err,
    );
  }

  // ★★ ISSUE THE DOCUMENT HERE, because this is the ONE place a purchase becomes
  // paid — the confirm path AND the reconcile-on-read sweep both arrive here.
  // Hooking only `confirmCreditPurchase` would leave every purchase settled by
  // reconciliation without an invoice, which is exactly the case where the
  // merchant is already unsure what happened.
  //
  // ★ AFTER the credits, and best-effort: a merchant who paid gets what they
  // bought even if the document fails to issue.
  await issueCreditInvoice(purchase.id);
}

// Reconcile-on-read: any stale pending purchase for this store is checked
// against Razorpay; captured ⇒ settle, nothing captured ⇒ leave pending (the
// shopper may still be mid-payment — there is no reaper for credit purchases,
// an old pending row is harmless).
async function reconcilePendingPurchases(storeId: string): Promise<void> {
  const creds = getPlatformRazorpayCreds();
  if (!creds) return;
  const cutoff = new Date(Date.now() - RECONCILE_AFTER_MS).toISOString();
  let stale: {
    id: string;
    store_id: string;
    credits: number;
    pack_id: string;
    rzp_order_id: string | null;
  }[];
  try {
    stale = await withService((db) =>
      db
        .select({
          id: aiCreditPurchases.id,
          store_id: aiCreditPurchases.storeId,
          credits: aiCreditPurchases.credits,
          pack_id: aiCreditPurchases.packId,
          rzp_order_id: aiCreditPurchases.rzpOrderId,
        })
        .from(aiCreditPurchases)
        .where(
          and(
            eq(aiCreditPurchases.storeId, storeId),
            eq(aiCreditPurchases.status, "pending"),
            lte(aiCreditPurchases.createdAt, cutoff),
          ),
        )
        .limit(10),
    );
  } catch (err) {
    console.error("reconcilePendingPurchases:", err);
    return;
  }
  for (const p of stale) {
    if (!p.rzp_order_id) continue;
    const res = await rzpFetchOrderPayments(creds, p.rzp_order_id);
    if (!res.ok) continue;
    const captured = capturedPayment(res.data);
    if (captured) {
      await settlePurchase(p, captured.id);
    }
  }
}

/** Everything the /dashboard/plans (Plans & Billing) page renders. Also runs
 *  the pending-purchase reconcile pass so a dropped payment callback self-heals
 *  on next visit. */
export async function getAiUsagePageData(): Promise<AiUsagePageData> {
  const storeId = await getActingStoreId();

  await reconcilePendingPurchases(storeId);

  const [dbResult, usage] = await Promise.all([
    withService(async (db) => {
      const [storeRows, ledgerRows] = await Promise.all([
        db
          .select({
            plan: stores.plan,
            plan_expires_at: stores.planExpiresAt,
            comp_plan: stores.compPlan,
            comp_expires_at: stores.compExpiresAt,
            comp_duration_days: stores.compDurationDays,
            comp_starts_at: stores.compStartsAt,
            plan_source: stores.planSource,
          })
          .from(stores)
          .where(eq(stores.id, storeId))
          .limit(1),
        db
          .select({
            id: aiCreditLedger.id,
            delta: aiCreditLedger.delta,
            kind: aiCreditLedger.kind,
            note: aiCreditLedger.note,
            created_at: aiCreditLedger.createdAt,
          })
          .from(aiCreditLedger)
          .where(eq(aiCreditLedger.storeId, storeId))
          .orderBy(desc(aiCreditLedger.createdAt))
          .limit(20),
      ]);
      return { storeRows, ledgerRows };
    }).catch((err) => {
      console.error("getAiUsagePageData:", err);
      return { storeRows: [], ledgerRows: [] };
    }),
    getAiUsage(storeId),
  ]);
  const store = dbResult.storeRows[0];
  const ledger = dbResult.ledgerRows as AiLedgerEntry[];

  const plan = effectivePlan(store ?? {});
  // The same resolver with the overlay switched off — never a separate rule.
  const paidPlan = effectivePlan({ ...(store ?? {}), ...NO_COMP });
  return {
    usage,
    plan,
    paidPlan,
    planExpiresAt: store?.plan_expires_at ?? null,
    planSource: store?.plan_source ?? null,
    // ★ An offer and a running comp are mutually exclusive by construction:
    // accepting is the write that fills the window, and `offerCompPlan` refuses
    // while one is open. Splitting them here keeps that out of the component.
    compOffer:
      store?.comp_plan && store.comp_duration_days && !store.comp_starts_at
        ? { plan: store.comp_plan, durationDays: store.comp_duration_days }
        : null,
    compActive:
      store?.comp_plan && store.comp_starts_at && store.comp_expires_at
        ? { plan: store.comp_plan, expiresAt: store.comp_expires_at }
        : null,
    canBuyCredits: true,
    purchasesAvailable: getPlatformRazorpayCreds() !== null,
    ledger,
  };
}

export type StartPurchaseResult =
  | {
      success: true;
      purchaseId: string;
      rzpOrderId: string;
      keyId: string;
      amountPaise: number;
      packName: string;
    }
  | { error: string };

export async function startCreditPurchase(
  packId: string,
): Promise<StartPurchaseResult> {
  const userId = await getManagerUserId("ai");
  if (!userId) return { error: "You don't have permission to do this." };

  // Live, uncached: the number inserted into the purchase and sent to Razorpay
  // must be the same operator-controlled price the merchant just saw.
  const pack = await getMinkCreditPackLive(packId);
  if (!pack) return { error: "Unknown credit pack." };

  const storeId = await getActingStoreId();

  const creds = getPlatformRazorpayCreds();
  if (!creds) {
    return { error: "Credit purchases aren't available right now." };
  }

  let purchaseId: string;
  try {
    const [inserted] = await withService((db) =>
      db
        .insert(aiCreditPurchases)
        .values({
          storeId,
          packId: pack.id,
          credits: pack.credits,
          amountInr: pack.priceInr,
          status: "pending",
        })
        .returning({ id: aiCreditPurchases.id }),
    );
    purchaseId = inserted.id;
  } catch (err) {
    console.error(
      "startCreditPurchase (insert):",
      err instanceof Error ? err.message : err,
    );
    return { error: "Couldn't start the purchase. Please try again." };
  }

  const amountPaise = pack.priceInr * 100;
  const rzpRes = await rzpCreateOrder(creds, {
    amountPaise,
    receipt: `aicr_${purchaseId.slice(0, 30)}`,
    notes: { store_id: storeId, purchase_id: purchaseId },
  });
  if (!rzpRes.ok) {
    console.error("startCreditPurchase (rzp):", rzpRes.error);
    await withService((db) =>
      db
        .update(aiCreditPurchases)
        .set({ status: "failed", updatedAt: new Date().toISOString() })
        .where(eq(aiCreditPurchases.id, purchaseId)),
    ).catch(() => {});
    return { error: "Couldn't start the payment. Please try again." };
  }

  try {
    await withService((db) =>
      db
        .update(aiCreditPurchases)
        .set({
          rzpOrderId: rzpRes.data.id,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(aiCreditPurchases.id, purchaseId)),
    );
  } catch (err) {
    console.error(
      "startCreditPurchase (pin):",
      err instanceof Error ? err.message : err,
    );
    return { error: "Couldn't start the payment. Please try again." };
  }

  // ★ A DRAFT invoice, raised only once the order exists — so a purchase that
  // died at the gateway leaves no document behind at all. It carries no number
  // yet; `settlePurchase` finalizes it when the money lands, which is what keeps
  // an abandoned checkout from burning one in the gapless GST series.
  //
  // Best-effort and AFTER everything the sale depends on: a merchant must be able
  // to buy credits even if the document cannot be prepared.
  await draftCreditInvoice({
    storeId,
    purchaseId,
    packLabel: pack.name,
    credits: pack.credits,
    amountPaise,
  });

  return {
    success: true,
    purchaseId,
    rzpOrderId: rzpRes.data.id,
    keyId: creds.keyId,
    amountPaise,
    packName: pack.name,
  };
}

export interface ConfirmPurchaseResult {
  success?: boolean;
  creditsAdded?: number;
  error?: string;
}

export async function confirmCreditPurchase(
  purchaseId: string,
  rzpPaymentId: string,
  rzpSignature: string,
): Promise<ConfirmPurchaseResult> {
  const userId = await getManagerUserId("ai");
  if (!userId) return { error: "You don't have permission to do this." };
  if (
    typeof purchaseId !== "string" ||
    !purchaseId ||
    typeof rzpPaymentId !== "string" ||
    !rzpPaymentId ||
    typeof rzpSignature !== "string" ||
    !rzpSignature
  ) {
    return { error: "Invalid payment confirmation." };
  }

  const storeId = await getActingStoreId();

  const purchaseRows = await withService((db) =>
    db
      .select({
        id: aiCreditPurchases.id,
        store_id: aiCreditPurchases.storeId,
        credits: aiCreditPurchases.credits,
        pack_id: aiCreditPurchases.packId,
        amount_inr: aiCreditPurchases.amountInr,
        status: aiCreditPurchases.status,
        rzp_order_id: aiCreditPurchases.rzpOrderId,
      })
      .from(aiCreditPurchases)
      .where(
        and(
          eq(aiCreditPurchases.id, purchaseId),
          eq(aiCreditPurchases.storeId, storeId),
        ),
      )
      .limit(1),
  ).catch(() => []);
  const purchase = purchaseRows[0];
  if (!purchase) return { error: "Purchase not found." };
  if (purchase.status === "paid") {
    // A dropped response can make the browser repeat confirmation after the
    // purchase committed. Re-issue idempotently so a transient document write
    // self-heals; the credits ledger itself remains untouched.
    await issueCreditInvoice(purchase.id);
    return { success: true, creditsAdded: purchase.credits };
  }
  if (purchase.status !== "pending" || !purchase.rzp_order_id) {
    return { error: "This purchase can no longer be completed." };
  }

  const creds = getPlatformRazorpayCreds();
  if (!creds) return { error: "Payment verification is unavailable." };

  const valid = verifyCheckoutSignature(
    creds.keySecret,
    purchase.rzp_order_id,
    rzpPaymentId,
    rzpSignature,
  );
  if (!valid) {
    console.error("confirmCreditPurchase: bad signature for", purchaseId);
    return { error: "Payment verification failed." };
  }

  const observedPayment = await verifyCapturedCheckoutPayment(creds, {
    paymentId: rzpPaymentId,
    orderId: purchase.rzp_order_id,
    amountPaise: purchase.amount_inr * 100,
  });
  if (!observedPayment.ok) {
    console.error(
      "confirmCreditPurchase: gateway mismatch for",
      purchaseId,
      observedPayment.error,
    );
    return { error: observedPayment.error };
  }

  await settlePurchase(
    {
      id: purchase.id,
      store_id: purchase.store_id,
      credits: purchase.credits,
      pack_id: purchase.pack_id,
    },
    rzpPaymentId,
  );
  emitEvent({
    type: "ai.credits_purchased",
    storeId: purchase.store_id,
    actor: { type: "admin", id: userId },
    subject: { type: "credits", id: purchase.id, label: purchase.pack_id },
    payload: { credits: purchase.credits },
  });

  return { success: true, creditsAdded: purchase.credits };
}

/** The pack catalog for the buy panel (server → client serializable). */
export async function getCreditPacks() {
  return getMinkCreditPacksLive();
}
