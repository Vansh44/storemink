import type { ThemeStudioModelKey } from "./models";
import type { ProviderUsage } from "./provider";

// A cost ESTIMATE, recorded beside the raw token counts it was computed from.
//
// ★ The rates are Google's published Gemini list prices (ai.google.dev pricing
// page, standard tier, read 2026-09-23). Vertex AI's global endpoint has matched
// them for Gemini 3 Flash so far (lib/mink/cost.ts carries the same figures for
// 3.7 Flash), but Vertex billing is the source of truth. The pricing version
// names the source, so a wrong rate is repairable later from the stored raw
// counts rather than silently mixed with correct ones.
//
// ★★ PRICED PER CALL, NEVER FROM RUN TOTALS. Gemini 3.1 Pro's rate depends on
// the size of the PROMPT OF THAT REQUEST (≤200k vs >200k tokens), so summing a
// run's calls first and then pricing the sum would put two ordinary 120k-token
// requests into the >200k tier and double their price.
//
// ★ Cached tokens are a SUBSET of input tokens, never an addition (the provider
// counts cached content inside promptTokenCount — the lib/mink/cost.ts rule).
// Thinking tokens are billed as output.

export const THEME_STUDIO_PRICING_VERSION = "gemini-api-list-2026-09";

interface Rate {
  input: number;
  output: number;
  cached: number;
}

/** USD per million tokens for one request. */
export function ratesFor(
  modelKey: ThemeStudioModelKey,
  promptTokens: number,
  at: Date,
): Rate {
  switch (modelKey) {
    case "gemini-3.8-flash":
      return at < new Date("2027-01-01T00:00:00Z")
        ? { input: 0.75, output: 3.75, cached: 0.075 }
        : { input: 1.5, output: 7.5, cached: 0.15 };
    case "gemini-3.1-pro":
      return promptTokens > 200_000
        ? { input: 4, output: 18, cached: 0.4 }
        : { input: 2, output: 12, cached: 0.2 };
  }
}

/** Whole micro-USD for ONE request, so a run's calls sum exactly. */
export function estimateCostMicroUsd(
  modelKey: ThemeStudioModelKey,
  usage: ProviderUsage,
  at: Date = new Date(),
): number {
  const rate = ratesFor(modelKey, usage.inputTokens, at);
  const cached = Math.min(Math.max(usage.cachedTokens, 0), usage.inputTokens);
  const dollars =
    ((usage.inputTokens - cached) * rate.input +
      cached * rate.cached +
      (usage.outputTokens + usage.thinkingTokens) * rate.output) /
    1_000_000;
  return Math.round(dollars * 1_000_000);
}
