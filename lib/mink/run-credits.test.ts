import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  execute: vi.fn(),
  usage: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({
  withService: async (fn: (db: unknown) => unknown) =>
    fn({ execute: h.execute }),
}));
vi.mock("@/lib/ai/quota", () => ({
  getMinkCreditCycle: () =>
    Promise.resolve({ period: "cycle:2026-09-15", resetsAt: "2026-10-15" }),
  getAiUsage: h.usage,
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { minkRunAffordability, settleMinkRunCredits } from "./run-credits";
import type { MinkActorContext, MinkUsage } from "./types";

const actor = {
  storeId: "store-1",
  adminId: "admin-1",
  effectivePlan: "free",
} as MinkActorContext;

const usage = (over: Partial<MinkUsage> = {}): MinkUsage => ({
  promptTokens: 12_000,
  outputTokens: 200,
  thoughtTokens: 0,
  totalTokens: 12_200,
  cachedTokens: 0,
  basePromptTokens: 0,
  ...over,
});

const settle = (
  over: Partial<Parameters<typeof settleMinkRunCredits>[0]> = {},
) =>
  settleMinkRunCredits({
    actor,
    runId: "run-1",
    usage: usage(),
    steps: 1,
    status: "succeeded",
    usageKnown: true,
    alreadyCharged: 0,
    chargeCredits: true,
    ...over,
  });

/**
 * The bind parameters handed to the spend function, in order:
 * store, admin, run, period, planCap, credits.
 *
 * Reads Drizzle's `queryChunks` — literal SQL arrives as objects, bound values
 * as plain scalars. Asserting on the LENGTH first is what keeps this honest: a
 * change to the function's signature then fails loudly here instead of silently
 * checking a different argument.
 */
function spendParams(): unknown[] {
  const call = h.execute.mock.calls[0]?.[0] as
    | { queryChunks?: unknown[] }
    | undefined;
  const params = (call?.queryChunks ?? []).filter(
    (chunk) => chunk === null || typeof chunk !== "object",
  );
  expect(params).toHaveLength(6);
  return params;
}

const creditsSentToDb = () => Number(spendParams()[5]);
const planCapSentToDb = () => Number(spendParams()[4]);

beforeEach(() => {
  vi.clearAllMocks();
  h.execute.mockResolvedValue({ rows: [{ source: "plan" }] });
  h.usage.mockResolvedValue({ used: 0, cap: 20, creditBalance: 0 });
});

describe("minkRunAffordability", () => {
  it("is inert while charging is switched off — it does not even read", async () => {
    // The whole feature must be a no-op until it is a deliberate pricing
    // decision, including making no extra query on every request.
    await expect(minkRunAffordability(actor, false)).resolves.toEqual({
      allowed: true,
    });
    expect(h.usage).not.toHaveBeenCalled();
  });

  it("allows a store with anything left, not only one that could afford the heaviest run", async () => {
    // Requiring the 8 a heavy run might cost would refuse a store the simple
    // question it can plainly afford — and the band is unknowable up front.
    h.usage.mockResolvedValue({ used: 20, cap: 20, creditBalance: 1 });
    await expect(minkRunAffordability(actor, true)).resolves.toEqual({
      allowed: true,
    });
  });

  it("refuses only when nothing at all remains, and says how to fix it", async () => {
    h.usage.mockResolvedValue({ used: 20, cap: 20, creditBalance: 0 });
    const result = await minkRunAffordability(actor, true);
    expect(result.allowed).toBe(false);
    expect(result.error).toContain("Buy Mink credits");
  });

  it("never blocks an unlimited plan", async () => {
    h.usage.mockResolvedValue({ used: 999, cap: null, creditBalance: 0 });
    await expect(minkRunAffordability(actor, true)).resolves.toEqual({
      allowed: true,
    });
  });

  it("fails OPEN when the balance cannot be read", async () => {
    // A cost guard rail, not a security boundary: a database blip must not
    // take the assistant offline.
    h.usage.mockRejectedValue(new Error("db down"));
    await expect(minkRunAffordability(actor, true)).resolves.toEqual({
      allowed: true,
    });
  });
});

describe("settleMinkRunCredits", () => {
  it("spends nothing while charging is switched off", async () => {
    await expect(settle({ chargeCredits: false })).resolves.toBeNull();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("charges the run's band when no proposal reserved anything", async () => {
    await settle();
    expect(creditsSentToDb()).toBe(1); // 13,000 weighted units -> light
  });

  it("spends against the RAISED allowance, not the legacy product-description cap", async () => {
    // The two are one switch (lib/plans.ts aiAllowanceFor). Billing a Mink run
    // against Free's legacy cap of 3 would give a store one question a month.
    await settle();
    expect(planCapSentToDb()).toBe(20);
  });

  it("FOLDS a proposal's weight into the band instead of stacking it", async () => {
    // A storefront proposal already reserved 5 and the merchant was quoted 5.
    // A heavy run tops up to 8 in total, so 3 more — never 5 + 8.
    await settle({
      alreadyCharged: 5,
      usage: usage({ promptTokens: 100_000, outputTokens: 2_000 }),
    });
    expect(creditsSentToDb()).toBe(3);
  });

  it("charges nothing extra when the proposal already cost more than the run", async () => {
    // The documented draft weight is the number the merchant agreed to; a
    // cheaper run must not claw any of it back or top it up.
    await settle({ alreadyCharged: 5 });
    expect(creditsSentToDb()).toBe(0);
  });

  it("charges nothing for a run that did not succeed", async () => {
    for (const status of ["failed", "cancelled"] as const) {
      h.execute.mockClear();
      await settle({ status });
      expect(creditsSentToDb()).toBe(0);
    }
  });

  it("charges nothing when the provider never reported usage", async () => {
    // Banding a zeroed usage object would meter an unknown run as a cheap one.
    await settle({ usageKnown: false });
    expect(creditsSentToDb()).toBe(0);
  });

  it("never throws when settlement fails — the reply has already been read", async () => {
    // An unsettled run is a NULL credit_source that can be reconciled; a
    // rolled-back answer cannot be recovered.
    h.execute.mockRejectedValue(new Error("deadlock"));
    await expect(settle()).resolves.toBeNull();
  });

  it("returns the outcome the database decided, including a short charge", async () => {
    h.execute.mockResolvedValue({ rows: [{ source: "short" }] });
    await expect(settle()).resolves.toBe("short");
  });
});
