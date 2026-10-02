// Log retention — the stopping rules.
//
// ── What these tests can and cannot cover ─────────────────────────────────
// `deleteBatch` is injected, so everything with a decision in it — when to
// stop, how big the final batch may be, whether one table's failure stops the
// next — is exercised here without a database. What is NOT covered is the
// drizzle closure `batchDeleter` builds: that it selects by `created_at` and
// deletes those ids is verified by reading it, the same way
// lib/domains/reconcile.ts is. The invariant it depends on (a `created_at`
// index on all three tables) is asserted in the SQL files, not here.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

// The module builds real drizzle closures at import time; nothing here calls
// them, but the client must not open a pool just to load the file.
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: (db: unknown) => Promise<unknown>) => fn({})),
}));

import {
  RETENTION_POLICIES,
  retentionFloor,
  runRetentionSweep,
  sweepPolicy,
  type RetentionPolicy,
} from "./prune";

/** A policy whose batches return the given counts, in order. */
function policyReturning(
  counts: number[],
  table = "t",
): RetentionPolicy & { calls: number[] } {
  const calls: number[] = [];
  let i = 0;
  return {
    table,
    days: 90,
    reason: "test",
    calls,
    deleteBatch: async (_floor: string, limit: number) => {
      calls.push(limit);
      // Clamped to `limit` because the real deleter selects with .limit(n) and
      // so cannot return more than it was asked for. A fake that overshoots
      // tests a contract the database would never break.
      return Math.min(counts[i++] ?? 0, limit);
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("retentionFloor", () => {
  it("returns the instant a row of that age was created", () => {
    const now = new Date("2026-08-07T00:00:00.000Z");
    expect(retentionFloor(90, now)).toBe("2026-05-09T00:00:00.000Z");
  });

  it("treats 0 days as 'delete everything up to now'", () => {
    const now = new Date("2026-08-07T00:00:00.000Z");
    expect(retentionFloor(0, now)).toBe(now.toISOString());
  });
});

describe("sweepPolicy", () => {
  it("drains heavy rows using the policy's smaller batches", async () => {
    const policy = { ...policyReturning([50, 50, 3]), batchSize: 50 };
    expect(await sweepPolicy(policy)).toMatchObject({
      deleted: 103,
      stop: "drained",
    });
    expect(policy.calls).toEqual([50, 50, 50]);
  });
  it("stops as soon as a batch comes back short", async () => {
    const policy = policyReturning([10]);
    const result = await sweepPolicy(policy, { batchSize: 1000 });

    expect(result).toMatchObject({ deleted: 10, stop: "drained" });
    expect(policy.calls).toHaveLength(1);
  });

  it("keeps going while batches come back full", async () => {
    const policy = policyReturning([100, 100, 40]);
    const result = await sweepPolicy(policy, { batchSize: 100 });

    expect(result).toMatchObject({ deleted: 240, stop: "drained" });
    expect(policy.calls).toEqual([100, 100, 100]);
  });

  it("costs one extra empty batch when the table drains exactly", async () => {
    // A full final batch is indistinguishable from more work, so the loop asks
    // once more and gets nothing. Cheap, and the alternative is stopping early
    // on a table that still has rows.
    const policy = policyReturning([100, 0]);
    const result = await sweepPolicy(policy, { batchSize: 100 });

    expect(result).toMatchObject({ deleted: 100, stop: "drained" });
    expect(policy.calls).toEqual([100, 100]);
  });

  it("stops at the cap and never deletes past it", async () => {
    const policy = policyReturning([100, 100, 100]);
    const result = await sweepPolicy(policy, { batchSize: 100, maxRows: 250 });

    expect(result).toMatchObject({ deleted: 250, stop: "cap" });
    // The final batch is narrowed to the remaining headroom, not the full size.
    expect(policy.calls).toEqual([100, 100, 50]);
  });

  it("stops when the time budget is spent, keeping what it deleted", async () => {
    let t = 0;
    const clock = () => (t += 50); // each check advances 50ms
    const policy = policyReturning([100, 100, 100, 100]);

    const result = await sweepPolicy(policy, {
      batchSize: 100,
      clock,
      deadline: 150,
    });

    expect(result.stop).toBe("budget");
    expect(result.deleted).toBeGreaterThan(0);
  });

  it("reports a failed batch without losing the rows already deleted", async () => {
    const policy: RetentionPolicy = {
      table: "t",
      days: 90,
      reason: "test",
      deleteBatch: vi
        .fn()
        .mockResolvedValueOnce(100)
        .mockRejectedValueOnce(new Error("deadlock detected")),
    };

    const result = await sweepPolicy(policy, { batchSize: 100 });

    expect(result).toMatchObject({
      deleted: 100,
      stop: "error",
      error: "deadlock detected",
    });
  });

  it("passes the same floor to every batch of a run", async () => {
    const floors: string[] = [];
    const policy: RetentionPolicy = {
      table: "t",
      days: 90,
      reason: "test",
      deleteBatch: async (floor) => {
        floors.push(floor);
        return floors.length < 3 ? 100 : 0;
      },
    };

    await sweepPolicy(policy, { batchSize: 100 });

    // A floor recomputed per batch would creep forward mid-run.
    expect(new Set(floors).size).toBe(1);
  });
});

describe("runRetentionSweep", () => {
  it("keeps sweeping after one table fails, and flags the run", async () => {
    const failing: RetentionPolicy = {
      table: "first",
      days: 90,
      reason: "test",
      deleteBatch: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const healthy = policyReturning([7], "second");

    const sweep = await runRetentionSweep([failing, healthy]);

    expect(sweep.failed).toBe(true);
    expect(sweep.deleted).toBe(7);
    expect(sweep.results.map((r) => r.stop)).toEqual(["error", "drained"]);
  });

  it("is not 'failed' merely because a backlog is still draining", async () => {
    const policy = policyReturning([100, 100], "big");
    const sweep = await runRetentionSweep([policy], {
      batchSize: 100,
      maxRows: 200,
    });

    expect(sweep.failed).toBe(false);
    expect(sweep.incomplete).toBe(true);
  });

  it("shares one deadline across tables rather than resetting per table", async () => {
    // Otherwise N tables could each burn the full budget and the route would
    // be killed before it reported anything.
    let t = 0;
    const clock = () => (t += 100);
    const first = policyReturning([100, 100, 100, 100], "first");
    const second = policyReturning([50], "second");

    const sweep = await runRetentionSweep([first, second], {
      batchSize: 100,
      clock,
      deadline: 250,
    });

    expect(sweep.results[0].stop).toBe("budget");
    expect(sweep.results[1].stop).toBe("budget");
    expect(sweep.results[1].deleted).toBe(0);
  });
});

describe("RETENTION_POLICIES", () => {
  it("keeps raw storefront events and attribution for only 14 days", () => {
    const byTable = new Map(
      RETENTION_POLICIES.map((policy) => [policy.table, policy.days]),
    );
    expect(byTable.get("storefront_events")).toBe(14);
    expect(byTable.get("storefront_order_attribution")).toBe(14);
  });

  it("prunes notifications before activity_events", () => {
    // notifications.event_id → activity_events ON DELETE CASCADE, so doing it
    // the other way round leaves the event sweep cascading through rows the
    // notification sweep would have taken cheaply.
    const order = RETENTION_POLICIES.map((p) => p.table);
    expect(order.indexOf("notifications")).toBeLessThan(
      order.indexOf("activity_events"),
    );
  });

  it("keeps the audit trail longest and the bodies shortest", () => {
    const days = Object.fromEntries(
      RETENTION_POLICIES.map((p) => [p.table, p.days]),
    );
    expect(days.activity_events).toBe(365);
    expect(days.notifications).toBe(90);
    expect(days.email_logs).toBe(90);
    expect(days.store_search_metrics).toBe(488);
  });

  it("★★ expires held sales, because the CAP is what runs out", () => {
    // pos_parked_sales allows 20 per LOCATION. Abandoned carts do not merely
    // accumulate — they fill the list and eventually stop a counter parking a
    // real one. A ceiling with nothing ageing out of it becomes a wall.
    const byTable = new Map(
      RETENTION_POLICIES.map((policy) => [policy.table, policy.days]),
    );
    expect(byTable.get("pos_parked_sales")).toBe(7);
  });

  it("★ a held sale is the shortest-lived thing here", () => {
    // Deliberate: it holds no stock and no prices, so discarding one costs a
    // re-scan. Everything else in this registry is history somebody may need.
    const days = Object.fromEntries(
      RETENTION_POLICIES.map((p) => [p.table, p.days]),
    );
    const others = Object.entries(days)
      .filter(([t]) => t !== "pos_parked_sales")
      .map(([, d]) => d as number);
    expect(Math.min(...others)).toBeGreaterThan(
      days.pos_parked_sales as number,
    );
  });

  it("documents why every window is what it is", () => {
    // The number and its reason live together so they cannot drift apart.
    for (const policy of RETENTION_POLICIES) {
      expect(policy.reason.length).toBeGreaterThan(20);
      expect(policy.days).toBeGreaterThan(0);
    }
  });
});
