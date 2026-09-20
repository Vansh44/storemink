import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ execute: vi.fn(), settle: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  withService: (fn: (db: unknown) => unknown) => fn({ execute: h.execute }),
}));
vi.mock("./run-credits", () => ({ settleMinkRunCredits: h.settle }));

import { reconcileMinkRunCredits } from "./run-credit-reconcile";
import { PgDialect } from "drizzle-orm/pg-core";

const row = (over: Record<string, unknown> = {}) => ({
  run_id: "11111111-1111-4111-8111-111111111111",
  store_id: "22222222-2222-4222-8222-222222222222",
  admin_id: "admin-1",
  status: "succeeded",
  usage_status: "reported",
  charged_credits: 0,
  input_tokens: 10_000,
  output_tokens: 500,
  thought_tokens: 0,
  cached_tokens: 0,
  total_tokens: 10_500,
  plan: "pro",
  comp_plan: null,
  comp_expires_at: null,
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  h.execute.mockResolvedValue({ rows: [] });
  h.settle.mockResolvedValue("plan");
});

describe("collecting credits a run never paid", () => {
  // ★★ CHARGING OFF MUST TOUCH NOTHING, not even read. With the switch off the
  // live path settles nothing by design, so every row is legitimately NULL.
  it("does no work at all while charging is off", async () => {
    expect(await reconcileMinkRunCredits(false)).toEqual({
      settled: 0,
      failed: 0,
    });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.settle).not.toHaveBeenCalled();
  });

  // ★★ THE BACKLOG IS FENCED OFF. Everything before charging went on was free
  // when it happened; billing it later is indefensible.
  it("never reaches back before charging started", async () => {
    await reconcileMinkRunCredits(true);
    const { sql: text, params } = new PgDialect().sqlToQuery(
      h.execute.mock.calls[0][0],
    );
    expect(params).toContain("2026-09-22T00:00:00Z");
    expect(text).toMatch(/credit_source is null/);
    // and a bounded, settled-enough window rather than "everything unsettled"
    expect(params).toContain("24 hours");
    expect(params).toContain("10 minutes");
  });

  it("settles each row with the live path's own function", async () => {
    h.execute.mockResolvedValue({ rows: [row(), row({ run_id: "b" })] });
    expect(await reconcileMinkRunCredits(true)).toEqual({
      settled: 2,
      failed: 0,
    });
    expect(h.settle).toHaveBeenCalledTimes(2);
    expect(h.settle.mock.calls[0][0]).toMatchObject({
      actor: { storeId: row().store_id, adminId: "admin-1" },
      status: "succeeded",
      chargeCredits: true,
    });
  });

  // ⚠ A failed run's band is 0 and minkRunCreditCharge returns only the
  //   untaken part, so settling it records the fact and charges nothing. The
  //   status must be passed through, not assumed succeeded, or a failed run
  //   would be metered as if it had produced an answer.
  it("passes the stored status through rather than assuming success", async () => {
    h.execute.mockResolvedValue({ rows: [row({ status: "failed" })] });
    await reconcileMinkRunCredits(true);
    expect(h.settle.mock.calls[0][0]).toMatchObject({ status: "failed" });
  });

  // ⚠ Partial or unavailable usage must meter exactly as it did live.
  it("recomputes usageKnown from the stored usage status", async () => {
    h.execute.mockResolvedValue({
      rows: [
        row({ usage_status: "partial" }),
        row({ usage_status: "reported" }),
      ],
    });
    await reconcileMinkRunCredits(true);
    expect(h.settle.mock.calls[0][0].usageKnown).toBe(false);
    expect(h.settle.mock.calls[1][0].usageKnown).toBe(true);
  });

  // ⚠ Credits a proposal already took are carried through, so the fold charges
  //   only the untaken part instead of billing the proposal twice.
  it("carries the credits already charged", async () => {
    h.execute.mockResolvedValue({ rows: [row({ charged_credits: 5 })] });
    await reconcileMinkRunCredits(true);
    expect(h.settle.mock.calls[0][0].alreadyCharged).toBe(5);
  });

  it("resolves an active comp rather than the stored plan", async () => {
    h.execute.mockResolvedValue({
      rows: [
        row({
          plan: "free",
          comp_plan: "pro",
          comp_expires_at: "2099-01-01T00:00:00Z",
        }),
      ],
    });
    await reconcileMinkRunCredits(true);
    expect(h.settle.mock.calls[0][0].actor.effectivePlan).toBe("pro");
  });

  // ★ One independent pass of a shared heartbeat: a billing sweep must never
  //   take the workflow worker down with it.
  it("swallows a read failure instead of throwing", async () => {
    h.execute.mockRejectedValue(new Error("db unavailable"));
    expect(await reconcileMinkRunCredits(true)).toEqual({
      settled: 0,
      failed: 0,
    });
  });

  it("counts a row settlement declined to settle", async () => {
    h.execute.mockResolvedValue({ rows: [row()] });
    h.settle.mockResolvedValue(null);
    expect(await reconcileMinkRunCredits(true)).toEqual({
      settled: 0,
      failed: 1,
    });
  });
});
