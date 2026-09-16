import "server-only";

// ---------------------------------------------------------------------------
// Resolved Mink credit allowances: the code defaults in lib/plans.ts,
// overridden by what a platform operator has set in `mink_plan_allowances`
// (drizzle/migrations/sql/20260916_0115_mink_plan_allowances.sql).
//
// Deliberately the same shape as lib/plans/pricing.ts — code default ← stored
// override, with an empty table behaving exactly like the constants. Nothing
// has to be seeded, so shipping this ahead of the migration changes no store's
// allowance, and a later change to the compiled-in defaults still reaches every
// plan nobody has overridden.
//
// ★ THE PURE MERGE IS NOT HERE. `resolvePlanAllowances` lives in lib/plans.ts,
// beside the constants it overrides, because this module is `server-only` and a
// client component cannot import even a TYPE from one without failing the build
// (the trap lib/logs/failure-types.ts and EXTRA_LOCATION_KEY already exist for).
// ---------------------------------------------------------------------------

import { unstable_cache, revalidateTag } from "next/cache";
import { withService } from "@/lib/db/client";
import { minkPlanAllowances } from "@/drizzle/schema";
import {
  resolvePlanAllowances,
  type PlanAllowanceRow,
  type PlanAllowances,
} from "@/lib/plans";
import { logError } from "@/lib/observability/logger";

/** Cache tag — bust it whenever an operator saves an allowance. */
export const PLAN_ALLOWANCES_TAG = "plan-allowances";

async function queryAllowanceRows(): Promise<PlanAllowanceRow[]> {
  return withService((db) =>
    db
      .select({
        plan: minkPlanAllowances.plan,
        generations_per_month: minkPlanAllowances.generationsPerMonth,
        credits_per_month: minkPlanAllowances.creditsPerMonth,
      })
      .from(minkPlanAllowances),
  );
}

/**
 * FAILS TO THE CONSTANTS. The table is an override, so its absence is a valid
 * state rather than an error — and refusing every AI action because one read
 * failed would be far worse than enforcing the compiled-in cap for a moment.
 * This is also what makes the deploy order-independent: before the migration
 * runs, the relation does not exist and every plan simply keeps its default.
 */
async function readAllowances(): Promise<PlanAllowances> {
  try {
    return resolvePlanAllowances(await queryAllowanceRows());
  } catch (error) {
    logError("plan allowances: read failed, using code defaults", error);
    return resolvePlanAllowances([]);
  }
}

/**
 * Cached, for anywhere the allowance is only being DISPLAYED. Tag-busted on
 * save, so an operator's change shows immediately rather than after the window.
 *
 * ⚠ RENDER SCOPE ONLY. `unstable_cache` throws "Invariant: incrementalCache
 * missing" in a server action, a route handler or a script, which is exactly
 * where enforcement runs — use `getPlanAllowancesLive` there.
 */
export const getPlanAllowances = unstable_cache(
  readAllowances,
  ["plan-allowances"],
  { tags: [PLAN_ALLOWANCES_TAG], revalidate: 300 },
);

/**
 * Uncached. Use wherever this number decides whether a merchant is BLOCKED —
 * the rule `getPlanPricingLive` follows for what someone is charged. It is also
 * the only safe form outside a render scope (see above), and every enforcement
 * call site folds it into a `Promise.all` it was already awaiting, so it costs
 * no extra wall-clock.
 */
export const getPlanAllowancesLive = readAllowances;

export function bustPlanAllowances() {
  // Next 16 requires the cache profile — `revalidateTag(tag)` alone no longer
  // compiles (AGENTS.md: this is a breaking-changes release).
  revalidateTag(PLAN_ALLOWANCES_TAG, "max");
}
