import "server-only";

import { after } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { aiCreditBalances, aiUsage, stores } from "@/drizzle/schema";
import {
  aiAllowanceFor,
  effectivePlan,
  planAllows,
  PLAN_META,
  NO_COMP,
} from "@/lib/plans";
import { getMinkConfig } from "@/lib/mink/config";
import { recordEvent } from "@/lib/notifications/record";

// Per-store AI generation quota — the first real enforcement of a plan limit.
// Every AI copy feature (product description, SEO, coupon email, brand-voice
// setup) consumes one generation; the monthly cap comes from the store's plan
// (lib/plans.ts aiGenerationsPerMonth; null = unlimited → no metering at all).
// Once the month's allowance is spent, purchased/granted AI CREDITS
// (supabase/ai_credits.sql, never expire) are consumed as the fallback —
// the expiring resource burns before the permanent one.
//
// Counting is atomic via the try_ai_generation / try_spend_ai_credit functions
// (single conditional UPDATE, the increment_coupon_usage pattern) so
// concurrent clicks can never overshoot the cap. A transient error fails
// OPEN — the quota is a cost guard rail, not a security boundary, and must
// never break a merchant's save flow.

/**
 * The month's allowance for this plan, in credits.
 *
 * ★★ IT DEPENDS ON WHETHER MINK CHARGES, because there is ONE pool. The legacy
 * caps (3/10/50) are sized for ~₹0.90 product descriptions; once a Mink
 * conversation spends from the same balance the allowance has to be the larger
 * one, or a Free store gets a single question a month. Read here rather than at
 * each call site so the quota gate, the dashboard's "X of Y used", the Mink
 * affordability check and settlement can never quote different numbers.
 */
function allowanceFor(plan: Parameters<typeof aiAllowanceFor>[0]) {
  return aiAllowanceFor(plan, getMinkConfig().chargeCredits);
}

/** Calendar month bucket, UTC — e.g. "2026-07". */
export function currentPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export interface QuotaResult {
  allowed: boolean;
  /** What the generation was drawn from ("plan" allowance or a purchased
   *  "credit") — lets callers phrase UI copy accurately. */
  source?: "plan" | "credit";
  /** Friendly, plan-aware message when blocked. */
  error?: string;
}

/**
 * Reserve one AI generation for the store: the plan's monthly allowance
 * first, then one purchased/granted credit once the month is spent.
 * Call BEFORE the Gemini request in every AI action.
 */
export async function consumeAiQuota(storeId: string): Promise<QuotaResult> {
  let storeRow:
    | {
        plan: string;
        plan_expires_at: string | null;
        comp_plan: string | null;
        comp_expires_at: string | null;
      }
    | undefined;
  try {
    [storeRow] = await withService((db) =>
      db
        .select({
          plan: stores.plan,
          plan_expires_at: stores.planExpiresAt,
          comp_plan: stores.compPlan,
          comp_expires_at: stores.compExpiresAt,
        })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1),
    );
  } catch (err) {
    console.error(
      "consumeAiQuota (plan read, failing open):",
      err instanceof Error ? err.message : err,
    );
    return { allowed: true };
  }

  const plan = effectivePlan(storeRow ?? NO_COMP);
  const cap = allowanceFor(plan);
  if (cap === null) return { allowed: true, source: "plan" }; // unlimited

  let ok: boolean;
  try {
    const res = await withService((db) =>
      db.execute(
        sql`select try_ai_generation(p_store => ${storeId}, p_period => ${currentPeriod()}, p_cap => ${cap}) as ok`,
      ),
    );
    ok = (res.rows[0] as { ok: boolean } | undefined)?.ok === true;
  } catch (err) {
    console.error(
      "consumeAiQuota (RPC, failing open):",
      err instanceof Error ? err.message : err,
    );
    return { allowed: true };
  }
  if (ok) {
    reportAiBalance(storeId);
    return { allowed: true, source: "plan" };
  }

  // Monthly allowance spent — fall back to the purchased-credit balance.
  let spent: boolean;
  try {
    const res = await withService((db) =>
      db.execute(sql`select try_spend_ai_credit(p_store => ${storeId}) as ok`),
    );
    spent = (res.rows[0] as { ok: boolean } | undefined)?.ok === true;
  } catch (err) {
    console.error(
      "consumeAiQuota (credits, failing open):",
      err instanceof Error ? err.message : err,
    );
    return { allowed: true };
  }
  if (spent) {
    reportAiBalance(storeId);
    return { allowed: true, source: "credit" };
  }

  return {
    allowed: false,
    error: planAllows(plan, "basic")
      ? `You've used all ${cap} AI generations included in the ${PLAN_META[plan].name} plan this month and have no AI credits left. Buy AI credits (Dashboard → Plans & Billing) or upgrade your plan.`
      : `You've used all ${cap} AI generations included in the ${PLAN_META[plan].name} plan this month. Upgrade your plan for more.`,
  };
}

/** Remaining generations at which the merchant gets a heads-up. */
export const LOW_REMAINING = 3;

/**
 * Should a store with `remaining` generations left be warned right now? PURE,
 * so the once-only rule can be tested without a database.
 *
 * EXACT equality, not "≤ 3 left": a consume moves the count by exactly one, so
 * matching a point instead of a band is what keeps this to ONE notification
 * rather than one per generation for the rest of the month (the same rule the
 * stock alerts use). Buying credits raises the count and re-arms it.
 *
 * TWO points, not one. The FREE plan's cap IS 3, so its remaining count goes
 * 3 → 2 on the very first generation and would never equal LOW_REMAINING —
 * the entire free tier would silently never be warned. Zero catches that case
 * and is the more useful signal anyway ("your allowance is gone"), while a
 * bigger plan still gets the earlier heads-up.
 */
export function aiWarnAt(remaining: number): boolean {
  return remaining === LOW_REMAINING || remaining === 0;
}

/**
 * Warn once when a store's AI allowance runs low (see aiWarnAt).
 *
 * Deferred and fully swallowed: a quota warning must never affect the
 * generation that triggered it.
 */
function reportAiBalance(storeId: string): void {
  try {
    after(async () => {
      try {
        const usage = await getAiUsage(storeId);
        if (usage.cap === null) return; // unlimited plan — nothing to warn about
        const remaining =
          Math.max(0, usage.cap - usage.used) + usage.creditBalance;
        if (!aiWarnAt(remaining)) return;

        await recordEvent({
          type: "ai.credits_low",
          storeId,
          actor: { type: "system" },
          payload: {
            remaining,
            used: usage.used,
            cap: usage.cap,
            credits: usage.creditBalance,
          },
        });
      } catch (err) {
        console.error(
          "reportAiBalance:",
          err instanceof Error ? err.message : err,
        );
      }
    });
  } catch {
    // No request scope (a script or a test) — nothing to defer onto.
  }
}

export interface AiUsageSummary {
  used: number;
  /** null = unlimited on this plan. */
  cap: number | null;
  /** Purchased/granted credits remaining (never expire). */
  creditBalance: number;
}

/** Current month's usage for the dashboard ("X of Y used this month"). */
export async function getAiUsage(storeId: string): Promise<AiUsageSummary> {
  try {
    return await withService(async (db) => {
      const storeRows = await db
        .select({
          plan: stores.plan,
          plan_expires_at: stores.planExpiresAt,
          comp_plan: stores.compPlan,
          comp_expires_at: stores.compExpiresAt,
        })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      const usageRows = await db
        .select({ used: aiUsage.used })
        .from(aiUsage)
        .where(
          and(
            eq(aiUsage.storeId, storeId),
            eq(aiUsage.period, currentPeriod()),
          ),
        )
        .limit(1);
      const creditRows = await db
        .select({ balance: aiCreditBalances.balance })
        .from(aiCreditBalances)
        .where(eq(aiCreditBalances.storeId, storeId))
        .limit(1);
      return {
        used: usageRows[0]?.used ?? 0,
        cap: allowanceFor(effectivePlan(storeRows[0] ?? {})),
        creditBalance: creditRows[0]?.balance ?? 0,
      };
    });
  } catch (err) {
    console.error("getAiUsage:", err instanceof Error ? err.message : err);
    return { used: 0, cap: null, creditBalance: 0 };
  }
}
