import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/observability/logger";
import { normalizePhone } from "./customer-claim";
import { storedPhoneVariants } from "@/lib/phone";

// ---------------------------------------------------------------------------
// Adopting a till-created customer on signup (roadmap Step 4).
//
// ── ★★ ONE STATEMENT, AND EVERY GUARD INSIDE IT ────────────────────────────
// This rewrites a PRIMARY KEY that six other tables reference, so it is the
// single most dangerous write in the POS. It is therefore a conditional claim
// (roadmap invariant 3) with all four conditions in the WHERE — never
// check-then-act:
//
//   store_id = $store   the caller may not adopt another store's customer
//   phone    = $phone   from the VERIFIED auth identity, never from a form
//   id LIKE 'pos_%'     only a row the till invented
//   claimed_at IS NULL  and only one nobody has adopted already
//   NOT EXISTS (…$uid)  and only when this uid has no row of its own yet
//
// Two signups racing on one walk-in row: the loser matches zero rows and falls
// through to an ordinary insert. No lock, no window.
//
// ── Why the last condition is not optional ─────────────────────────────────
// `id` is the primary key. Someone who already has a `users` row — a returning
// shopper editing their profile — would hit a duplicate-key error instead of a
// clean no-op, and a raw PK violation surfacing on a profile save is both
// alarming and unactionable. Asking inside the statement keeps it a no-op.
//
// ── Why withService ────────────────────────────────────────────────────────
// Customer RLS is `auth.uid() = users.id`, and the row being adopted has a
// `pos_…` id by definition — so under the customer's own scope it is invisible
// and the UPDATE would match nothing. Service scope is what makes the write
// possible; the WHERE clause above is what makes it safe. Same trade placeOrder
// makes (convention #12): validate first, then write privileged.
// ---------------------------------------------------------------------------

export interface ClaimPosCustomerInput {
  /** The Firebase uid the row should become. */
  uid: string;
  /** The store whose customer this is — the HOST store, never caller input. */
  storeId: string;
  /**
   * The phone from the VERIFIED auth identity. A phone taken from a form would
   * let anyone type a stranger's number and inherit their order history — which
   * is the entire attack this feature has to not have.
   */
  verifiedPhone: string | null | undefined;
}

export interface ClaimResult {
  /** True when a till-created row was adopted. False means "nothing to adopt". */
  claimed: boolean;
  /** The id the adopted row used to have — for the audit line only. */
  previousId?: string;
}

/**
 * Adopt an unclaimed till-created customer for a freshly signed-up shopper.
 *
 * NEVER THROWS. A failure here means the shopper simply gets a new row and
 * loses the link to their in-store history — a disappointment, not an outage.
 * Failing their signup over it would be strictly worse.
 */
export async function claimPosCustomer(
  input: ClaimPosCustomerInput,
): Promise<ClaimResult> {
  const phone = normalizePhone(input.verifiedPhone);
  // No verified phone means nothing to match on. Not an error: most stores
  // never create a till customer, and most signups have nothing waiting.
  if (!phone || !input.uid || !input.storeId) return { claimed: false };
  // Rows written before the phone shape was canonicalised may hold the E.164
  // form. Matching both is what lets this adopt them; see storedPhoneVariants.
  const phones = storedPhoneVariants(input.verifiedPhone);

  try {
    const claimed = await withService(async (db) => {
      // `withService` wraps the callback in ONE transaction, which is what makes
      // the id rewrite and the repoints below atomic. A half-claimed customer —
      // a new id with their store credit still on the old one — is the outcome
      // this must never produce.
      //
      // The lookup is separate from the claim ONLY because the repoints need the
      // OLD id and `RETURNING` yields the new one. It is not a check-then-act:
      // the UPDATE still carries every guard, so two racing signups serialise on
      // the row lock and the second re-reads `claimed_at IS NULL` as false and
      // matches nothing.
      const found = (await db.execute(sql`
        select id from public.users
         where store_id = ${input.storeId}::uuid
           and phone = any(${phones}::text[])
           and id like 'pos\\_%'
           and claimed_at is null
         limit 1
      `)) as unknown;
      const posId = firstId(found);
      if (!posId) return false;

      const rows = await db.execute(sql`
        update public.users
           set id = ${input.uid},
               claimed_at = now()
         where id = ${posId}
           and claimed_at is null
           and not exists (
             select 1 from public.users u2 where u2.id = ${input.uid}
           )
        returning id
      `);
      if (rowCount(rows) === 0) return false;

      await repointUnreferencedTables(db, posId, input.uid);
      return true;
    });
    if (claimed) {
      // Worth a log line: it is a primary-key rewrite across six tables, and
      // "why does this account suddenly have in-store orders?" is a question
      // somebody will eventually ask.
      logInfo("pos customer claimed on signup", {
        storeId: input.storeId,
        uid: input.uid,
      });
    }
    return { claimed };
  } catch (err) {
    logError("pos customer claim failed", err, {
      storeId: input.storeId,
      uid: input.uid,
    });
    return { claimed: false };
  }
}

/**
 * ★★ THE CASCADE ONLY REACHES TABLES WITH A FOREIGN KEY, AND THREE THAT HOLD A
 * CUSTOMER ID HAVE NONE.
 *
 * `pos_13` put `ON UPDATE CASCADE` on all six FKs to `users.id`, which is what
 * makes adoption one statement — but `customer_credit_balances`,
 * `customer_credit_ledger` and `notifications`/`notification_email_queue` have
 * no FK at all, so the rewrite sails past them and leaves their rows pointing at
 * an id nobody can reach.
 *
 * ★ THE CREDIT TABLES ARE THE SERIOUS ONE: THEY HOLD MONEY. A walk-in refunded
 * to store credit at the till (§29) and then signing up would have their balance
 * orphaned BY THEIR OWN SIGNUP — the store's books still say it is owed, and the
 * customer's profile shows zero. Silent, and discovered by a complaint.
 *
 * ⚠ A HAND-WRITTEN LIST IS EXACTLY WHAT `pos_13` EXISTS TO AVOID, so keep this
 * one honest: `claim-customer.test.ts` pins every table named here, and a new
 * table holding a customer id belongs in this function OR behind a real FK.
 * Prefer the FK. The risk here is narrower than the one the migration replaced —
 * these are UPDATEs, so forgetting one orphans data rather than
 * cascade-DELETING somebody's orders — but orphaned money is still money.
 *
 * ★ `notification_preferences` IS DELIBERATELY ABSENT. The customer audience has
 * no preference layer (§24 — transactional mail is not switchable), so a
 * `pos_` customer can never have a row there.
 */
async function repointUnreferencedTables(
  db: Pick<Parameters<Parameters<typeof withService>[0]>[0], "execute">,
  posId: string,
  uid: string,
): Promise<void> {
  // Money first. If any of these fails the whole transaction rolls back and the
  // claim reports false — which is the right way round: no claim at all beats a
  // claim that moved the person and left their balance behind.
  await db.execute(sql`
    update public.customer_credit_balances set customer_id = ${uid}
     where customer_id = ${posId}
  `);
  await db.execute(sql`
    update public.customer_credit_ledger set customer_id = ${uid}
     where customer_id = ${posId}
  `);
  // Their notification history, so the bell isn't empty for someone who has been
  // buying here for months.
  await db.execute(sql`
    update public.notifications set recipient_id = ${uid}
     where recipient_id = ${posId} and recipient_type = 'customer'
  `);
  await db.execute(sql`
    update public.notification_email_queue set recipient_id = ${uid}
     where recipient_id = ${posId} and recipient_type = 'customer'
  `);
  // Who physically collected a pickup. Cosmetic, but it is their name on it.
  await db.execute(sql`
    update public.orders set collected_by = ${uid}
     where collected_by = ${posId}
  `);
}

/** The `id` of the first row, across the driver's Result and a mock's array. */
function firstId(result: unknown): string | null {
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] })?.rows ?? []);
  const row = rows[0] as { id?: unknown } | undefined;
  return typeof row?.id === "string" ? row.id : null;
}

/**
 * `db.execute` returns a pg Result in this driver and a plain array in some
 * mocks; both shapes have to answer "did anything match?" the same way, because
 * the whole exactly-once guarantee is read from that number.
 */
function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === "object") {
    const r = result as { rowCount?: number | null; rows?: unknown[] };
    if (typeof r.rowCount === "number") return r.rowCount;
    if (Array.isArray(r.rows)) return r.rows.length;
  }
  return 0;
}
