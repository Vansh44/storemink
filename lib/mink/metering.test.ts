import { describe, expect, it } from "vitest";
import {
  billablePromptTokens,
  MINK_CREDIT_BANDS,
  minkCreditBand,
  minkRunCreditCharge,
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
  basePromptTokens: 0,
  ...over,
});

/** A one-step run of a given size; the prefix subtraction has its own tests. */
const size = (over: Partial<MinkUsage> = {}, steps = 1) => ({
  usage: usage(over),
  steps,
});

const meter = (over: Partial<Parameters<typeof minkShadowMeter>[0]> = {}) =>
  minkShadowMeter({
    status: "succeeded",
    toolCalls: 1,
    usageKnown: true,
    usage: usage(),
    steps: 1,
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
      Math.round(weightedMinkUnits({ usage: sample, steps: 1 }) * inputRate),
    );
  });

  it("counts reasoning as output — the provider bills it at the output rate", () => {
    // Omitting it would under-band exactly the HIGH-thinking storefront runs
    // that most need banding correctly.
    expect(weightedMinkUnits(size({ thoughtTokens: 1_000 }))).toBe(5_000);
    expect(weightedMinkUnits(size({ outputTokens: 1_000 }))).toBe(5_000);
  });

  it("ignores the cache, so one question costs the same twice", () => {
    // A cached prefix is cheaper for StoreMink, but a merchant must not be
    // billed differently because our cache happened to be cold. The saving is
    // margin, not a variable bill.
    const cold = size({ promptTokens: 20_000, cachedTokens: 0 });
    const warm = size({ promptTokens: 20_000, cachedTokens: 19_000 });
    expect(weightedMinkUnits(warm)).toBe(weightedMinkUnits(cold));
    expect(minkCreditBand(warm).band).toEqual(minkCreditBand(cold).band);
  });
});

// ---------------------------------------------------------------------------
// ★★ THE PREFIX IS NOT THE MERCHANT'S REQUEST.
//
// The system prompt plus the permission-filtered tool declarations measured
// 92,689 characters (~23,200 tokens) for a superadmin with drafting on, and
// every model turn re-sends all of it. Charging the raw prompt total therefore
// priced a question by how many tool rounds the MODEL chose, and made the
// 1-credit band unreachable for any run that touched a tool at all.
// ---------------------------------------------------------------------------
describe("billablePromptTokens", () => {
  it("keeps the initial prompt once and subtracts only repeated copies", () => {
    expect(
      billablePromptTokens({
        usage: usage({ promptTokens: 50_000, basePromptTokens: 20_000 }),
        steps: 2,
      }),
    ).toBe(30_000);
  });

  it("★★ charges merchant input on a one-step run", () => {
    // The initial count includes the message, history and memories as well as
    // platform instructions. None of it is a repeated copy on turn one.
    expect(
      billablePromptTokens({
        usage: usage({ promptTokens: 50_000, basePromptTokens: 20_000 }),
        steps: 1,
      }),
    ).toBe(50_000);
  });

  it("★★ prices the reported one-tool-call run at ONE credit", () => {
    // The production report: "how can i upload a photo" → one
    // search_help_centre call → two model turns → 269 → 266 credits. The
    // figures are a REAL `mink_usage_ledger` row of that shape (a two-step
    // lookup: 34,941 input, 164 output) against the smallest single-step
    // prompt the same table records, 17,072 — so the baseline is measured
    // rather than assumed. The initial prompt remains once; only its second
    // copy is removed.
    const run = {
      usage: usage({
        promptTokens: 34_941,
        outputTokens: 164,
        basePromptTokens: 17_072,
      }),
      steps: 2,
    };
    expect(minkCreditBand(run).band.credits).toBe(1);
    // …and it is the standard band, 3 credits, without the subtraction.
    expect(
      minkCreditBand({
        ...run,
        usage: usage({ promptTokens: 34_941, outputTokens: 164 }),
      }).band.credits,
    ).toBe(3);
  });

  it("★ an unknown base charges the whole prompt, as it did before", () => {
    // A provider that reported no usage, or a ledger row written before the
    // column existed. Silently becoming free would be the worse failure.
    const legacy = size({ promptTokens: 34_941 }, 2);
    expect(billablePromptTokens(legacy)).toBe(34_941);
    expect(minkCreditBand(legacy).band.credits).toBe(3);
  });

  it("★ clamps at zero rather than crediting an over-subtraction", () => {
    // `steps` counts turns the provider may not have reported usage for, so
    // the subtraction can exceed the total. Erring to zero errs to the
    // merchant.
    expect(
      billablePromptTokens({
        usage: usage({ promptTokens: 10_000, basePromptTokens: 9_000 }),
        steps: 5,
      }),
    ).toBe(0);
  });

  it("★★ still charges the initial prompt and re-sent tool results", () => {
    // Removing repeated overhead must not make the merchant's initial context
    // or accumulated reads free: this six-step run is still standard.
    const busy = {
      usage: usage({
        promptTokens: 6 * 17_072 + 60_000,
        outputTokens: 2_000,
        basePromptTokens: 17_072,
      }),
      steps: 6,
    };
    expect(billablePromptTokens(busy)).toBe(77_072);
    expect(minkCreditBand(busy).band.name).toBe("standard");
  });
});

describe("minkCreditBand", () => {
  it("places the recorded run shapes in the intended bands", () => {
    // Real values from mink_usage_ledger, not invented ones.
    const lookup = size({
      promptTokens: 22_347,
      outputTokens: 283,
      thoughtTokens: 319,
    });
    const analysis = size({ promptTokens: 33_860, outputTokens: 1_296 });
    const storefront = size({
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
    expect(minkCreditBand(size({ promptTokens: light })).band.name).toBe(
      "light",
    );
    expect(minkCreditBand(size({ promptTokens: light + 1 })).band.name).toBe(
      "standard",
    );
  });

  it("has an open-ended top band, so no run can fall through unpriced", () => {
    expect(MINK_CREDIT_BANDS.at(-1)?.maxUnits).toBeNull();
    expect(
      minkCreditBand(size({ promptTokens: 50_000_000 })).band.credits,
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

describe("minkRunCreditCharge", () => {
  it("charges the band when nothing was reserved during the run", () => {
    expect(minkRunCreditCharge({ bandCredits: 3, alreadyCharged: 0 })).toBe(3);
  });

  it("FOLDS a proposal's weight into the band rather than stacking it", () => {
    // A storefront proposal reserves 5 up front and the composer quotes 5. A
    // heavy run costs 8 in total, so 3 more — never 13.
    expect(minkRunCreditCharge({ bandCredits: 8, alreadyCharged: 5 })).toBe(3);
  });

  it("keeps a proposal's documented price when its run was cheaper", () => {
    // The merchant agreed to the proposal's number; a light run must neither
    // top it up nor claw any of it back.
    expect(minkRunCreditCharge({ bandCredits: 1, alreadyCharged: 5 })).toBe(0);
  });

  it("never returns a negative charge", () => {
    // A refund is not this function's job, and a negative would be spent as a
    // credit grant by the settlement statement.
    expect(minkRunCreditCharge({ bandCredits: 0, alreadyCharged: 20 })).toBe(0);
  });
});
