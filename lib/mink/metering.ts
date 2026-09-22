import type { MinkUsage } from "./types";

export type MinkCostCohort =
  | "read_lookup"
  | "read_analysis"
  | "read_failed"
  | "read_unknown";

/**
 * Output tokens per input token, by price.
 *
 * ★ THE SAME 5 IN EVERY RATE VARIANT cost.ts knows — global and regional, 2026
 * intro and 2027 standard (0.75/3.75, 0.825/4.125, 1.5/7.5, 1.65/8.25). That
 * is what lets one weighted unit stand in for cost without importing a rate,
 * a region or a date: `weightedMinkUnits` is EXACTLY proportional to the money
 * for every combination. `metering.test.ts` pins the invariant against cost.ts
 * itself, so a future price change that breaks the proportionality fails there
 * rather than silently skewing every band.
 */
export const MINK_OUTPUT_WEIGHT = 5;

/**
 * One run's size on a single cost-proportional scale.
 *
 * ★★ RAW PROMPT TOKENS, DELIBERATELY IGNORING THE CACHE. A cached prefix is
 * genuinely cheaper for us (lib/mink/cost.ts prices it), but a merchant who
 * asks the same question twice must not be charged two different amounts
 * because our cache happened to be cold the first time. The band measures the
 * WORK REQUESTED; the cache saving accrues to StoreMink as margin, which is
 * the right way round — it rewards making the platform cheaper rather than
 * making the bill unpredictable.
 *
 * ★ Thought tokens are output. The provider bills reasoning at the output
 * rate and the SDK reports it separately, so omitting it would under-band
 * exactly the expensive HIGH-thinking runs (storefront code) that most need
 * banding correctly.
 */
export interface MinkRunSize {
  usage: MinkUsage;
  /** Model turns. Every turn after the first re-sends the initial prompt. */
  steps: number;
}

/**
 * The prompt tokens a run is CHARGED for: the total, less the INITIAL prompt
 * that every step after the first re-sent.
 *
 * ★★ THE PREFIX IS OUR COST STRUCTURE, NOT THE MERCHANT'S REQUEST. The system
 * prompt plus the permission-filtered tool declarations run to 92,689
 * characters for a superadmin with drafting on, and every step re-sends all of
 * it. MEASURED on `mink_usage_ledger`, not estimated: single-step runs report
 * 16,542–17,072 input tokens, and input per step across 12 recorded runs sits
 * between 16,542 and 20,029. A question answered with ONE tool call therefore
 * accumulated ~35,000 prompt tokens even when the merchant's own input and the
 * tool result were tiny. That is what put "how do I upload a photo?" in the
 * standard band at 3 credits and made the light band unreachable for any run
 * that touched a tool. The recorded two-step lookup is the exact shape: 34,941
 * input, 164 output.
 *
 * ★ The provider gives us the whole first prompt, not a token count for the
 * system-and-tools prefix alone. That first prompt also contains conversation
 * history, memory and the merchant's message, so it MUST remain billable once.
 * Subtracting only `(steps - 1) × base` removes repeated copies while leaving
 * the initial prompt plus the tool results and model turns that accumulated
 * along the run. A result fetched early still costs more than one fetched late,
 * which is real because we genuinely pay to re-send it.
 *
 * ⚠ AN UNKNOWN BASE CHARGES THE WHOLE PROMPT, which is what this did before.
 * A run whose provider reported no usage, or a ledger row written before the
 * figure was recorded, therefore keeps its old band rather than silently
 * becoming free.
 *
 * ⚠ Clamped at zero: `steps` counts turns the provider may not have reported
 * usage for, so the subtraction can exceed the total. Erring to zero errs
 * toward the merchant.
 */
export function billablePromptTokens(size: MinkRunSize): number {
  const repeatedInitialPrompt =
    Math.max(0, size.usage.basePromptTokens) * Math.max(0, size.steps - 1);
  return Math.max(0, size.usage.promptTokens - repeatedInitialPrompt);
}

export function weightedMinkUnits(size: MinkRunSize): number {
  return Math.max(
    0,
    billablePromptTokens(size) +
      MINK_OUTPUT_WEIGHT * (size.usage.outputTokens + size.usage.thoughtTokens),
  );
}

export type MinkCreditBandName = "light" | "standard" | "heavy";

export interface MinkCreditBand {
  name: MinkCreditBandName;
  /** Inclusive ceiling on weighted units; null = the top band. */
  maxUnits: number | null;
  credits: number;
}

/**
 * What a run of a given size would consume, in the SAME credits a product
 * description spends (lib/ai/quota.ts): one pool, one currency.
 *
 * ⚠ PROVISIONAL BOUNDARIES, AND THAT IS THE POINT OF SHADOW MODE. They are
 * round numbers chosen so each band's ceiling is a round rupee cost (a
 * weighted unit costs exactly 0.75 µUSD at the current global intro rate, so
 * 30,000 ≈ ₹2.00 and 90,000 ≈ ₹5.94 at ₹88/USD), and they are sized against
 * only 16 recorded runs — all `low` thinking, none of them a HIGH-thinking
 * storefront proposal. Tune them from real shadow data before anything is
 * charged; `mink_usage_ledger` stores the raw token counts, so every
 * historical row can be re-banded without a migration.
 */
export const MINK_CREDIT_BANDS: readonly MinkCreditBand[] = [
  { name: "light", maxUnits: 30_000, credits: 1 },
  { name: "standard", maxUnits: 90_000, credits: 3 },
  { name: "heavy", maxUnits: null, credits: 8 },
] as const;

/** The most any single run can cost. Derived, so a re-banding moves the
 *  composer's low-balance warning with it. */
export const MINK_MAX_RUN_CREDITS = MINK_CREDIT_BANDS.reduce(
  (most, band) => Math.max(most, band.credits),
  0,
);

/** The band a run of this size falls in. Pure, and safe on the client so the
 *  composer can say what a request will cost before it is sent. */
export function minkCreditBand(size: MinkRunSize): {
  band: MinkCreditBand;
  weightedUnits: number;
} {
  const weightedUnits = weightedMinkUnits(size);
  const band =
    MINK_CREDIT_BANDS.find(
      (candidate) =>
        candidate.maxUnits === null || weightedUnits <= candidate.maxUnits,
    ) ?? MINK_CREDIT_BANDS[MINK_CREDIT_BANDS.length - 1];
  return { band, weightedUnits };
}

/**
 * Shadow-meter one run: what it WOULD consume once charging is switched on.
 *
 * ⚠ STILL SHADOW. Nothing here debits a merchant — `charged_credits` stays 0
 * for read work (persistence.ts), and Phase 3+ proposals keep reserving their
 * own documented weight atomically. This exists to be watched against live
 * traffic for a few weeks so the boundaries above can be set from evidence.
 *
 * ★★ IT USED TO RETURN A HARDCODED 3 FOR EVERY RUN, whatever its size — a
 * one-tool lookup and a six-step storefront proposal metered identically, so
 * the number told an operator nothing and the cohort was doing all the work.
 *
 * ★ A RUN THAT DID NOT SUCCEED METERS ZERO. Charging for an answer nobody got
 * is indefensible, and the tokens it burned are not lost from the record —
 * `estimated_cost_microusd` on the same row still carries them, so the cost of
 * failure stays visible without inventing a charge for it. Whether a CANCELLED
 * run should eventually cost something (a merchant can press Stop after the
 * expensive part) is a decision for the charging phase, not this one.
 */
export function minkShadowMeter(input: {
  status: "succeeded" | "failed" | "cancelled";
  toolCalls: number;
  usageKnown: boolean;
  usage: MinkUsage;
  /** Model turns, so repeated copies of the initial prompt can be excluded. */
  steps: number;
}): {
  shadowCredits: number;
  costCohort: MinkCostCohort;
  weightedUnits: number;
  band: MinkCreditBandName | null;
} {
  const weightedUnits = weightedMinkUnits(input);
  if (!input.usageKnown) {
    return {
      shadowCredits: 0,
      costCohort: "read_unknown",
      weightedUnits,
      band: null,
    };
  }
  if (input.status !== "succeeded") {
    return {
      shadowCredits: 0,
      costCohort: "read_failed",
      weightedUnits,
      band: null,
    };
  }
  const { band } = minkCreditBand(input);
  return {
    shadowCredits: band.credits,
    costCohort: input.toolCalls <= 1 ? "read_lookup" : "read_analysis",
    weightedUnits,
    band: band.name,
  };
}

/**
 * What a completed run still owes, on top of anything it already charged.
 *
 * ★★ A RUN'S BAND AND ITS DRAFT WEIGHTS FOLD; THEY DO NOT STACK. A Phase 3+
 * proposal reserves its own documented weight the moment it is created
 * (`consume_mink_draft_credits`), and that number is what the composer showed
 * the merchant before they asked. Adding the run's band on top would charge
 * twice for one request — 5 credits for a storefront proposal plus 8 for the
 * heavy run that produced it — and the merchant would have been quoted 5.
 *
 * So the run costs `max(band, alreadyCharged)` in total, and this returns only
 * the part not yet taken. Consequences worth stating:
 *   • a proposal cheaper than its run (a 2-credit product description produced
 *     by a standard 3-credit run) tops up to the run's real cost;
 *   • a proposal dearer than its run keeps its documented price, because that
 *     is the number the merchant agreed to;
 *   • a run with no proposal simply pays its band.
 *
 * ⚠ It does NOT clamp to the store's balance. Clamping must happen inside the
 * same statement that spends, or two runs settling at once both read the same
 * headroom and overdraw it — the conditional-UPDATE rule the coupon, credit
 * and inventory paths all follow.
 */
export function minkRunCreditCharge(input: {
  bandCredits: number;
  alreadyCharged: number;
}): number {
  const target = Math.max(input.bandCredits, input.alreadyCharged);
  return Math.max(0, target - input.alreadyCharged);
}
