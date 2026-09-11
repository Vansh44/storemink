import { describe, expect, it } from "vitest";
import {
  MINK_CREDIT_BANDS,
  minkCreditBand,
  minkShadowMeter,
  weightedMinkUnits,
} from "./metering";
import { estimateMinkCost } from "./cost";
import type { MinkUsage } from "./types";

const usage = (over: Partial<MinkUsage> = {}): MinkUsage => ({
  promptTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
  ...over,
});

const meter = (over: Partial<Parameters<typeof minkShadowMeter>[0]> = {}) =>
  minkShadowMeter({
    status: "succeeded",
    toolCalls: 1,
    usageKnown: true,
    usage: usage(),
    ...over,
  });

describe("weightedMinkUnits", () => {
  // ★★ THE INVARIANT THE WHOLE BAND SCHEME RESTS ON. If a weighted unit stops
  // being exactly proportional to money, every boundary silently starts
  // measuring the wrong thing — and nothing else would notice, because the
  // bands would keep returning plausible numbers. Pinned against cost.ts
  // itself rather than against a copied rate.
  it.each([
    ["global", "2026-08-29T00:00:00Z", 0.75],
    ["asia-south1", "2026-08-29T00:00:00Z", 0.825],
    ["global", "2027-06-01T00:00:00Z", 1.5],
    ["asia-south1", "2027-06-01T00:00:00Z", 1.65],
  ])("is exactly proportional to cost (%s, %s)", (location, at, inputRate) => {
    const sample = usage({
      promptTokens: 22_347,
      outputTokens: 283,
      thoughtTokens: 319,
      totalTokens: 22_949,
    });
    const cost = estimateMinkCost({
      model: "gemini-3.7-flash",
      location,
      usage: sample,
      at: new Date(at),
    });
    expect(cost.estimatedCostMicrousd).toBe(
      Math.round(weightedMinkUnits(sample) * inputRate),
    );
  });

  it("counts reasoning as output — the provider bills it at the output rate", () => {
    // Omitting it would under-band exactly the HIGH-thinking storefront runs
    // that most need banding correctly.
    expect(weightedMinkUnits(usage({ thoughtTokens: 1_000 }))).toBe(5_000);
    expect(weightedMinkUnits(usage({ outputTokens: 1_000 }))).toBe(5_000);
  });

  it("ignores the cache, so one question costs the same twice", () => {
    // A cached prefix is cheaper for StoreMink, but a merchant must not be
    // billed differently because our cache happened to be cold. The saving is
    // margin, not a variable bill.
    const cold = usage({ promptTokens: 20_000, cachedTokens: 0 });
    const warm = usage({ promptTokens: 20_000, cachedTokens: 19_000 });
    expect(weightedMinkUnits(warm)).toBe(weightedMinkUnits(cold));
    expect(minkCreditBand(warm).band).toEqual(minkCreditBand(cold).band);
  });
});

describe("minkCreditBand", () => {
  it("places the recorded run shapes in the intended bands", () => {
    // Real values from mink_usage_ledger, not invented ones.
    const lookup = usage({
      promptTokens: 22_347,
      outputTokens: 283,
      thoughtTokens: 319,
    });
    const analysis = usage({ promptTokens: 33_860, outputTokens: 1_296 });
    const storefront = usage({
      promptTokens: 100_680,
      outputTokens: 2_048,
      thoughtTokens: 4_000,
    });
    expect(minkCreditBand(lookup).band.name).toBe("light");
    expect(minkCreditBand(analysis).band.name).toBe("standard");
    expect(minkCreditBand(storefront).band.name).toBe("heavy");
  });

  it("treats a band ceiling as inclusive and the next unit as the next band", () => {
    const light = MINK_CREDIT_BANDS[0].maxUnits!;
    expect(minkCreditBand(usage({ promptTokens: light })).band.name).toBe(
      "light",
    );
    expect(minkCreditBand(usage({ promptTokens: light + 1 })).band.name).toBe(
      "standard",
    );
  });

  it("has an open-ended top band, so no run can fall through unpriced", () => {
    expect(MINK_CREDIT_BANDS.at(-1)?.maxUnits).toBeNull();
    expect(
      minkCreditBand(usage({ promptTokens: 50_000_000 })).band.credits,
    ).toBe(8);
  });

  // ★ THE OPERATOR CONSOLE'S BAND MIX INDEXES [0], [1] AND [2] AND FILTERS ON
  // EACH BAND'S CREDIT VALUE (lib/platform/mink-runs.ts). A fourth band would
  // simply go uncounted there, and two bands sharing a credit value would be
  // double-counted — both silent. Fail here instead.
  it("stays a three-band table with distinct credit values", () => {
    expect(MINK_CREDIT_BANDS).toHaveLength(3);
    expect(new Set(MINK_CREDIT_BANDS.map((b) => b.credits)).size).toBe(3);
    // 0 is reserved for "not metered", so no band may claim it.
    expect(MINK_CREDIT_BANDS.every((b) => b.credits > 0)).toBe(true);
  });

  it("keeps the bands ordered and strictly increasing in price", () => {
    // A band that cost less than a smaller one would make a bigger request the
    // cheaper option.
    const ceilings = MINK_CREDIT_BANDS.map((b) => b.maxUnits ?? Infinity);
    const credits = MINK_CREDIT_BANDS.map((b) => b.credits);
    expect(ceilings).toEqual([...ceilings].sort((a, b) => a - b));
    expect(credits).toEqual([...credits].sort((a, b) => a - b));
  });
});

describe("minkShadowMeter", () => {
  it("meters a run by its measured size, not by a fixed number", () => {
    // It used to return a hardcoded 3 whatever the run did, so a one-tool
    // lookup and a six-step proposal were indistinguishable.
    const small = meter({ usage: usage({ promptTokens: 12_000 }) });
    const large = meter({
      toolCalls: 4,
      usage: usage({ promptTokens: 100_000, outputTokens: 2_000 }),
    });
    expect(small.shadowCredits).toBe(1);
    expect(large.shadowCredits).toBe(8);
    expect(small.shadowCredits).not.toBe(large.shadowCredits);
  });

  it("still segments lookup from analysis by tool count", () => {
    expect(meter({ toolCalls: 1 }).costCohort).toBe("read_lookup");
    expect(meter({ toolCalls: 3 }).costCohort).toBe("read_analysis");
  });

  it("meters nothing for a run that did not succeed, however big it was", () => {
    // Charging for an answer nobody received is indefensible; the tokens stay
    // visible in estimated_cost_microusd on the same row.
    const big = usage({ promptTokens: 150_000, outputTokens: 3_000 });
    for (const status of ["failed", "cancelled"] as const) {
      const result = meter({ status, usage: big });
      expect(result.shadowCredits).toBe(0);
      expect(result.costCohort).toBe("read_failed");
      expect(result.band).toBeNull();
      // …but the size is still reported, so the cost of failure is knowable.
      expect(result.weightedUnits).toBeGreaterThan(0);
    }
  });

  it("never presents unknown usage as free pilot consumption", () => {
    const result = meter({
      status: "cancelled",
      toolCalls: 0,
      usageKnown: false,
    });
    expect(result).toMatchObject({
      shadowCredits: 0,
      costCohort: "read_unknown",
      band: null,
    });
  });

  it("reports unknown usage as unknown even when the status succeeded", () => {
    // usageKnown is checked FIRST: a succeeded run whose usage the provider
    // never reported must not be banded off a zeroed usage object and metered
    // as a cheap Light run.
    expect(meter({ usageKnown: false }).costCohort).toBe("read_unknown");
  });
});
