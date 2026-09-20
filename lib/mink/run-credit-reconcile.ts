import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { effectivePlan } from "@/lib/plans";
import { logError, logInfo } from "@/lib/observability/logger";
import { settleMinkRunCredits } from "./run-credits";
import type { MinkPlan } from "./types";

// ---------------------------------------------------------------------------
// Collecting credits a finished run never paid.
//
// ★★ SETTLEMENT IS DELIBERATELY ALLOWED TO FAIL. It runs AFTER the run row
// commits, in its own transaction, and never throws, because a billing failure
// must not roll back a reply the merchant is already reading. The cost of that
// rule is a row left with a NULL `credit_source`: the answer was delivered and
// the credits were never taken, and nothing retried. This is the retry.
//
// ★ NULL IS AN UNAMBIGUOUS SIGNAL, which is what makes the sweep safe. Every
// other outcome is recorded, INCLUDING a run that owed nothing ('none'), so a
// NULL means settlement genuinely did not happen rather than "happened and
// cost zero".
// ⚠ It picks up two different faults. One is the rare crash-shaped miss the
// comment above describes. The other is structural and constant: nothing calls
// `settleMinkRunCredits` for a run that FAILED, so every failed run's ledger
// row is NULL for ever. Settling those charges nothing — `minkRunCreditCharge`
// returns only the untaken part, and a failed run's band is 0 — but it records
// the fact, which is what stops this sweep re-reading them on every pass.
// ---------------------------------------------------------------------------

/**
 * ★★ NOTHING FROM BEFORE CHARGING WAS SWITCHED ON MAY BE COLLECTED. Every run
 * older than this was genuinely free when it was made — 28 of them on
 * production, all with a NULL `credit_source` for that reason and not because
 * anything went wrong. Sweeping "everything unsettled" would retroactively
 * bill merchants for questions that cost nothing at the time, which is not a
 * bill anybody could defend.
 * ⚠ Self-retiring: once it is more than `LOOKBACK_HOURS` in the past the
 * window can no longer reach it and the constant can be deleted.
 */
const CHARGING_STARTED_AT = "2026-09-22T00:00:00Z";

/**
 * ★ A BOUNDED WINDOW, NOT "EVERYTHING UNSETTLED". Settling a run from a
 * previous billing cycle spends THIS cycle's allowance on last cycle's work
 * (`consume_mink_run_credits` takes the current period), and a charge landing
 * days after the answer is one a merchant cannot connect to anything they did.
 * A day is long enough to survive a cron outage and short enough that neither
 * happens in practice.
 */
const LOOKBACK_HOURS = 24;

/**
 * ⚠ AND A MINIMUM AGE, or the sweep races the live path. Settlement fires
 * moments after the answer, so a row seconds old is far more likely to be
 * in flight than abandoned. `consume_mink_run_credits` is idempotent on the
 * run, so a collision would be harmless — this avoids the pointless work and
 * the confusing log line rather than a double charge.
 */
const MIN_AGE_MINUTES = 10;

/** Bounded per pass: this rides a per-minute heartbeat shared with the
 *  workflow worker, and a backlog drains across passes rather than in one. */
const BATCH = 25;

interface UnsettledRun {
  run_id: string;
  store_id: string;
  admin_id: string;
  status: string;
  usage_status: string;
  charged_credits: number;
  input_tokens: number;
  output_tokens: number;
  thought_tokens: number;
  cached_tokens: number;
  total_tokens: number;
  plan: string;
  comp_plan: string | null;
  comp_expires_at: string | null;
}

/**
 * Settle finished runs whose credits were never taken.
 *
 * Returns what it did rather than throwing: it is one independent pass of a
 * shared heartbeat, and a billing sweep must not take the workflow worker down
 * with it.
 */
export async function reconcileMinkRunCredits(
  chargeCredits: boolean,
): Promise<{ settled: number; failed: number }> {
  if (!chargeCredits) return { settled: 0, failed: 0 };
  let rows: UnsettledRun[];
  try {
    rows = await withService(async (db) => {
      const result = await db.execute(sql`
        select l.run_id, l.store_id, l.admin_id, r.status, l.usage_status,
               l.charged_credits, l.input_tokens, l.output_tokens,
               l.thought_tokens, l.cached_tokens, l.total_tokens,
               s.plan, s.comp_plan, s.comp_expires_at
          from mink_usage_ledger l
          join mink_runs r on r.id = l.run_id
          join stores s on s.id = l.store_id
         where l.credit_source is null
           and l.created_at >= ${CHARGING_STARTED_AT}::timestamptz
           and l.created_at >= now() - ${`${LOOKBACK_HOURS} hours`}::interval
           and l.created_at <= now() - ${`${MIN_AGE_MINUTES} minutes`}::interval
           and r.status in ('succeeded','failed','cancelled')
         order by l.created_at
         limit ${BATCH}
      `);
      return result.rows as unknown as UnsettledRun[];
    });
  } catch (error) {
    logError("mink.run_credit_reconcile_read_failed", error);
    return { settled: 0, failed: 0 };
  }

  let settled = 0;
  let failed = 0;
  for (const row of rows) {
    // ★ The SAME function the live path uses, so a reconciled run is charged
    //   by exactly the rule a timely one was, and there is no second copy of
    //   the band arithmetic to drift.
    const source = await settleMinkRunCredits({
      actor: {
        storeId: row.store_id,
        adminId: row.admin_id,
        effectivePlan: effectivePlan({
          plan: row.plan,
          comp_plan: row.comp_plan,
          comp_expires_at: row.comp_expires_at,
        }) as MinkPlan,
      },
      runId: row.run_id,
      usage: {
        promptTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        thoughtTokens: row.thought_tokens,
        cachedTokens: row.cached_tokens,
        totalTokens: row.total_tokens,
      },
      status: row.status as "succeeded" | "failed" | "cancelled",
      // ⚠ Recomputed from the STORED status, never assumed reported: a run
      //   whose usage was partial or unavailable must meter as it did live.
      usageKnown: row.usage_status === "reported",
      alreadyCharged: row.charged_credits,
      chargeCredits: true,
    });
    if (source) settled++;
    else failed++;
  }
  if (settled || failed)
    logInfo("mink.run_credits_reconciled", { settled, failed });
  return { settled, failed };
}
