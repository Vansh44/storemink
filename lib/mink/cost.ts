import type { MinkUsage } from "./types";

/**
 * Share of the ordinary input rate charged for a prompt token the provider
 * served from a context cache — the published context-caching discount.
 *
 * ⚠ AN ASSUMED RATE, AND DELIBERATELY THE ONLY ASSUMED NUMBER HERE. The ledger
 * stores `cached_tokens` as a raw provider fact alongside the derived cost, so
 * every historical row can be repriced if this proves wrong; the multiplier is
 * stamped into `pricingVersion` precisely so rows priced under a wrong rate are
 * identifiable rather than silently mixed with correct ones. Change this and
 * the version string changes with it, for free.
 */
export const CACHED_INPUT_RATE_MULTIPLIER = 0.25;

/**
 * The cached-token count as it may safely be priced AND stored: never negative,
 * never above the prompt count it is a subset of.
 *
 * ⚠ ONE implementation, exported, because it has TWO callers that must agree —
 * the cost estimate and the ledger insert. The ledger's CHECK constraint
 * (cached_tokens <= input_tokens) sits inside the same transaction as the run's
 * completion row and its assistant message, so a value that violated it would
 * roll back an answer the merchant has already been shown. A second, drifting
 * copy of this clamp is therefore not a rounding bug; it is a lost reply.
 */
export function cachedPromptTokens(usage: MinkUsage): number {
  return Math.min(
    Math.max(0, usage.cachedTokens),
    Math.max(0, usage.promptTokens),
  );
}

export interface MinkCostEstimate {
  estimatedCostMicrousd: number | null;
  pricingVersion: string | null;
}

/**
 * Shadow-cost one run using the public on-demand token price in effect when it
 * ran. A null estimate is deliberate: an unknown model must not be presented
 * to operators as free.
 */
export function estimateMinkCost(input: {
  model: string;
  location: string;
  usage: MinkUsage;
  at?: Date;
}): MinkCostEstimate {
  if (!isGemini37Flash(input.model)) {
    return { estimatedCostMicrousd: null, pricingVersion: null };
  }

  const global = input.location.trim().toLowerCase() === "global";
  const intro = (input.at ?? new Date()) < new Date("2027-01-01T00:00:00Z");
  const inputRate = intro ? (global ? 0.75 : 0.825) : global ? 1.5 : 1.65;
  const outputRate = intro ? (global ? 3.75 : 4.125) : global ? 7.5 : 8.25;
  // The provider prices visible response and reasoning as text output. The SDK
  // reports candidate and thought tokens separately, so both are billable here.
  const outputTokens = input.usage.outputTokens + input.usage.thoughtTokens;
  // Cached prompt tokens are a SUBSET of promptTokens, never an addition, so
  // they are subtracted before the full rate is applied. Clamped because a
  // provider that ever reported more cached than prompt tokens must not be
  // able to drive the fresh count — and therefore the estimate — negative.
  const cachedTokens = cachedPromptTokens(input.usage);
  const freshTokens = input.usage.promptTokens - cachedTokens;
  return {
    // A USD-per-million-token rate is numerically equal to micro-USD per token.
    estimatedCostMicrousd: Math.max(
      0,
      Math.round(
        freshTokens * inputRate +
          cachedTokens * inputRate * CACHED_INPUT_RATE_MULTIPLIER +
          outputTokens * outputRate,
      ),
    ),
    // The multiplier is part of the identity: a ledger row can be recomputed
    // against a corrected rate only if the version says which one produced it.
    pricingVersion: `gemini-3.7-flash-${global ? "global" : "regional"}-${intro ? "2026-intro" : "2027-standard"}-c${CACHED_INPUT_RATE_MULTIPLIER}`,
  };
}

function isGemini37Flash(model: string): boolean {
  const leaf = model.trim().toLowerCase().split("/").at(-1) ?? "";
  return leaf === "gemini-3.7-flash";
}
