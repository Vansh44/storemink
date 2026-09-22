import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { getAiUsage, getMinkCreditCycle } from "@/lib/ai/quota";
import { aiAllowanceFor, PLAN_META } from "@/lib/plans";
import { getPlanAllowancesLive } from "@/lib/plans/allowances";
import { logError, logInfo } from "@/lib/observability/logger";
import { minkCreditBand, minkRunCreditCharge } from "./metering";
import type { MinkActorContext, MinkUsage } from "./types";

// ---------------------------------------------------------------------------
// Spending a merchant's AI credits on a Mink conversation.
//
// ★★ THE SAME CREDITS A PRODUCT DESCRIPTION SPENDS — the monthly plan
// allowance first, then the purchased balance, through the same ai_usage and
// ai_credit_balances rows lib/ai/quota.ts uses. One pool and one currency, so
// "AI credits" and "Mink credits" are the same thing and a merchant never has
// to reason about two balances.
//
// ⚠ EVERY PATH HERE IS GATED ON `config.chargeCredits`, which is ON by default
// since 2026-09-21. With it off (`MINK_CHARGE_CREDITS=false`) this module reads
// nothing and spends nothing, and the shadow meter keeps recording what it
// WOULD have cost. The flag also raises every plan's allowance, and the two
// must move together (lib/plans.ts) or merchants get billed against caps sized
// for product descriptions.
// ---------------------------------------------------------------------------

/** Settled outcome, or null when charging is switched off. */
export type MinkRunCreditSource =
  | "none"
  | "plan"
  | "credit"
  | "mixed"
  | "plan_unlimited"
  | "short";

/**
 * Can this store afford to start a run at all?
 *
 * ★ THE FLOOR IS ONE CREDIT, NOT THE HEAVIEST BAND. Requiring the 8 a heavy
 * run could cost would refuse a store with 5 credits the simple question it
 * can plainly afford — and the band is not knowable until the run has already
 * happened. So the gate is "has anything left", and settlement clamps to what
 * is actually there (`consume_mink_run_credits` records 'short').
 * ⚠ The bounded consequence, accepted deliberately: a store's LAST run can
 * overrun its balance by at most one band. The alternative is refusing work a
 * merchant has credits for, which is worse and far more common.
 *
 * Fails OPEN on an unreadable balance, matching consumeAiQuota: the quota is a
 * cost guard rail, not a security boundary, and a database blip must not take
 * the assistant offline.
 */
export async function minkRunAffordability(
  actor: MinkActorContext,
  chargeCredits: boolean,
): Promise<{ allowed: boolean; error?: string }> {
  if (!chargeCredits) return { allowed: true };
  try {
    const usage = await getAiUsage(actor.storeId);
    if (usage.cap === null) return { allowed: true };
    const remaining = Math.max(0, usage.cap - usage.used) + usage.creditBalance;
    if (remaining >= 1) return { allowed: true };
    return {
      allowed: false,
      error: `This store has used all ${usage.cap} Mink credits included in the ${PLAN_META[actor.effectivePlan].name} plan for this cycle and has no top-up Mink credits left. Buy Mink credits under Plans & Billing, or upgrade the plan.`,
    };
  } catch (error) {
    logError("mink.affordability_read_failed", error, {
      storeId: actor.storeId,
    });
    return { allowed: true };
  }
}

/**
 * Charge a finished run, exactly once.
 *
 * ★★ CALLED AFTER THE RUN ROW HAS COMMITTED, IN ITS OWN TRANSACTION, AND IT
 * NEVER THROWS. The merchant has already been shown the answer, so a billing
 * failure must not roll back the conversation, fail the request, or lose the
 * reply — the same rule that keeps the cached_tokens CHECK out of
 * completeMinkRun's transaction. An unsettled run is visible as a NULL
 * credit_source on the ledger and can be reconciled; a lost answer cannot.
 *
 * ★ Idempotent on the ledger's run row, so a retry returns the original
 * outcome rather than charging twice.
 */
export async function settleMinkRunCredits(input: {
  /**
   * ★ NARROWED TO THE THREE FIELDS SETTLEMENT READS, so a row from the ledger
   * is a valid input. A full `MinkActorContext` still satisfies it, so no
   * caller changed; requiring one would have forced the reconciler to rebuild
   * a request-scoped context (permissions, locations, brand voice) it has no
   * request for and does not use.
   */
  actor: Pick<MinkActorContext, "storeId" | "adminId" | "effectivePlan">;
  runId: string;
  usage: MinkUsage;
  /**
   * Model turns. Needed because each one re-sent the prefix, and the charge is
   * based on what accumulated on top of it (`weightedMinkUnits`).
   */
  steps: number;
  status: "succeeded" | "failed" | "cancelled";
  usageKnown: boolean;
  /** Credits Phase 3+ proposals in this run already reserved for themselves. */
  alreadyCharged: number;
  chargeCredits: boolean;
}): Promise<MinkRunCreditSource | null> {
  if (!input.chargeCredits) return null;
  // A run that did not succeed owes nothing (lib/mink/metering.ts), but it is
  // still SETTLED — recording that is what stops a reconciler picking it up
  // forever as unbilled.
  const bandCredits =
    input.status === "succeeded" && input.usageKnown
      ? minkCreditBand({ usage: input.usage, steps: input.steps }).band.credits
      : 0;
  const outstanding = minkRunCreditCharge({
    bandCredits,
    alreadyCharged: input.alreadyCharged,
  });
  try {
    // Parallel with the cycle read this already awaited, so honouring an
    // operator override costs no extra wall-clock on the settlement path.
    const [cycle, allowances] = await Promise.all([
      getMinkCreditCycle(input.actor.storeId),
      getPlanAllowancesLive(),
    ]);
    // The RAISED allowance: this path only runs when charging is on, and the
    // two are the same switch (lib/plans.ts aiAllowanceFor).
    const planCap = aiAllowanceFor(input.actor.effectivePlan, true, allowances);
    const result = await withService((db) =>
      db.execute(sql`
        select public.consume_mink_run_credits(
          p_store => ${input.actor.storeId}::uuid,
          p_admin => ${input.actor.adminId},
          p_run => ${input.runId}::uuid,
          p_period => ${cycle.period},
          p_plan_cap => ${planCap},
          p_credits => ${outstanding}
        ) as source
      `),
    );
    const source = (result.rows[0] as { source?: string } | undefined)?.source;
    if (source === "short") {
      // Worth a line: it means a merchant received work the store could not
      // fully pay for, which the affordability floor allows exactly once.
      logInfo("mink.run_credits_short", {
        storeId: input.actor.storeId,
        runId: input.runId,
        wanted: outstanding,
      });
    }
    return (source as MinkRunCreditSource | undefined) ?? null;
  } catch (error) {
    logError("mink.run_credit_settlement_failed", error, {
      storeId: input.actor.storeId,
      runId: input.runId,
      outstanding,
    });
    return null;
  }
}
