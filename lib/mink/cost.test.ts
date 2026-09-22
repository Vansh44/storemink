import { describe, expect, it } from "vitest";
import {
  basePromptTokens,
  CACHED_INPUT_RATE_MULTIPLIER,
  cachedPromptTokens,
  estimateMinkCost,
} from "./cost";

const usage = {
  promptTokens: 1_000,
  outputTokens: 200,
  thoughtTokens: 50,
  totalTokens: 1_250,
  cachedTokens: 0,
  basePromptTokens: 0,
};

describe("estimateMinkCost", () => {
  it("prices Gemini 3.7 Flash response and thought tokens as output", () => {
    expect(
      estimateMinkCost({
        model: "gemini-3.7-flash",
        location: "global",
        usage,
        at: new Date("2026-08-29T00:00:00Z"),
      }),
    ).toEqual({
      estimatedCostMicrousd: 1_688,
      pricingVersion: `gemini-3.7-flash-global-2026-intro-c${CACHED_INPUT_RATE_MULTIPLIER}`,
    });
  });

  it("uses the documented standard rate from 2027", () => {
    expect(
      estimateMinkCost({
        model: "gemini-3.7-flash",
        location: "global",
        usage,
        at: new Date("2027-01-01T00:00:00Z"),
      }).estimatedCostMicrousd,
    ).toBe(3_375);
  });

  it("keeps unknown models visibly unpriced instead of treating them as free", () => {
    expect(
      estimateMinkCost({
        model: "future-model",
        location: "global",
        usage,
      }),
    ).toEqual({ estimatedCostMicrousd: null, pricingVersion: null });
  });

  it("charges a cached prompt token at the reduced rate, not the full one", () => {
    // Same 1,000 prompt tokens, 400 of them served from cache. Only the input
    // side moves: 600 fresh + 400 × 0.25 = 700 effective input tokens.
    const cached = estimateMinkCost({
      model: "gemini-3.7-flash",
      location: "global",
      usage: { ...usage, cachedTokens: 400 },
      at: new Date("2026-08-29T00:00:00Z"),
    });
    const uncached = estimateMinkCost({
      model: "gemini-3.7-flash",
      location: "global",
      usage,
      at: new Date("2026-08-29T00:00:00Z"),
    });
    expect(cached.estimatedCostMicrousd).toBe(1_463);
    expect(cached.estimatedCostMicrousd).toBeLessThan(
      uncached.estimatedCostMicrousd!,
    );
  });

  it("never counts a cached token twice — it is a subset of the prompt count", () => {
    // A fully-cached prompt must cost the cached rate on every prompt token,
    // not the full rate plus a cached surcharge. Adding cachedTokens to
    // promptTokens instead of subtracting it is the misreading this pins.
    expect(
      estimateMinkCost({
        model: "gemini-3.7-flash",
        location: "global",
        usage: { ...usage, cachedTokens: 1_000 },
        at: new Date("2026-08-29T00:00:00Z"),
      }).estimatedCostMicrousd,
    ).toBe(1_125); // 1,000 × 0.75 × 0.25 + 250 × 3.75
  });

  it("stamps the cached multiplier into the pricing version so rows can be repriced", () => {
    // The multiplier is an ASSUMPTION. A ledger row is only recomputable
    // against a corrected rate if it records which rate produced it.
    expect(
      estimateMinkCost({ model: "gemini-3.7-flash", location: "global", usage })
        .pricingVersion,
    ).toContain(`-c${CACHED_INPUT_RATE_MULTIPLIER}`);
  });
});

describe("cachedPromptTokens", () => {
  it("clamps a provider count that exceeds the prompt it is a subset of", () => {
    // This value is written to a column whose CHECK sits in the SAME
    // transaction as the run completion and the assistant message, so an
    // unclamped provider oddity would roll back a reply already shown.
    expect(
      cachedPromptTokens({ ...usage, promptTokens: 100, cachedTokens: 900 }),
    ).toBe(100);
  });

  it("clamps a negative count to zero", () => {
    expect(cachedPromptTokens({ ...usage, cachedTokens: -5 })).toBe(0);
  });

  it("passes an ordinary count through untouched", () => {
    expect(cachedPromptTokens({ ...usage, cachedTokens: 400 })).toBe(400);
  });
});

// ★★ THE LEDGER'S base_prompt_tokens CHECK SHARES A TRANSACTION WITH THE
// MERCHANT'S REPLY, exactly as cached_tokens does. A value that tripped it
// would roll back an answer already on screen, so the clamp is not cosmetic.
describe("basePromptTokens", () => {
  it("never exceeds the prompt total it is a share of", () => {
    expect(
      basePromptTokens({ ...usage, promptTokens: 100, basePromptTokens: 900 }),
    ).toBe(100);
  });

  it("never goes negative", () => {
    expect(basePromptTokens({ ...usage, basePromptTokens: -5 })).toBe(0);
  });

  it("passes an ordinary value through untouched", () => {
    expect(basePromptTokens({ ...usage, basePromptTokens: 400 })).toBe(400);
  });
});
