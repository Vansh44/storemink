import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { minkCreditCycleAt } from "./quota";

describe("minkCreditCycleAt", () => {
  it("keeps calendar months when the store has no paid-plan start", () => {
    expect(minkCreditCycleAt(new Date("2026-09-16T04:00:00.000Z"))).toEqual({
      period: "2026-09",
      resetsAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("refreshes every 30 days from the paid plan-cycle start", () => {
    expect(
      minkCreditCycleAt(
        new Date("2026-11-02T10:00:00.000Z"),
        "2026-09-15T06:30:00.000Z",
      ),
    ).toEqual({
      period: "cycle:2026-10-15T06:30:00.000Z",
      resetsAt: "2026-11-14T06:30:00.000Z",
    });
  });

  it("uses the same 30-day duration as StoreMink billing at month end", () => {
    expect(
      minkCreditCycleAt(
        new Date("2027-02-28T12:00:00.000Z"),
        "2027-01-31T08:00:00.000Z",
      ),
    ).toEqual({
      period: "cycle:2027-01-31T08:00:00.000Z",
      resetsAt: "2027-03-02T08:00:00.000Z",
    });
  });
});

// ---------------------------------------------------------------------------
// ★★ THE PERIOD KEY IS A DATABASE VALUE, AND ONE TABLE CHECKS ITS FORMAT.
// `consume_mink_draft_credits` writes this key into BOTH `ai_usage`, which has
// no format check, and `mink_draft_credit_usage`, which does. So when the key
// moved from a calendar month to a 30-day cycle, conversational metering and
// run settlement moved cleanly while every draft proposal on a paying store
// started failing on a CHECK constraint — reported to the merchant only as
// "Mink AI couldn't complete that request."
//
// This reads the constraint out of the migration that owns it rather than
// restating the pattern, because a second copy of a regex is exactly how the
// two drift apart again. Change the key's shape and this fails in CI.
// ---------------------------------------------------------------------------
describe("the period key the draft credit ledger will accept", () => {
  /** The live CHECK, lifted from the migration that installed it. */
  function ledgerPeriodCheck(): RegExp[] {
    const sql = readFileSync(
      join(
        process.cwd(),
        "drizzle/migrations/sql/20260919_0117_mink_draft_credit_cycle_period.sql",
      ),
      "utf8",
    );
    const body = sql.slice(sql.lastIndexOf("ADD CONSTRAINT"));
    const patterns = [...body.matchAll(/period ~ '([^']+)'/g)].map(
      (match) => new RegExp(match[1]),
    );
    // A scan that silently stops matching passes forever; assert it found the
    // two alternatives the constraint actually carries.
    expect(patterns).toHaveLength(2);
    return patterns;
  }

  const accepted = (period: string) =>
    ledgerPeriodCheck().some((pattern) => pattern.test(period));

  it("★★ accepts every key minkCreditCycleAt can emit", () => {
    const keys = [
      // No paid cycle: the calendar key a free store keeps.
      minkCreditCycleAt(new Date("2026-09-16T04:00:00.000Z")).period,
      // Anchored to a paid cycle — the shape that was being rejected.
      minkCreditCycleAt(
        new Date("2026-11-02T10:00:00.000Z"),
        "2026-09-15T06:30:00.000Z",
      ).period,
      // A whole-second anchor, so the milliseconds are '000' rather than absent.
      minkCreditCycleAt(
        new Date("2026-09-19T12:00:00.000Z"),
        "2026-09-11T11:37:15.000Z",
      ).period,
      // An anchor carrying real milliseconds.
      minkCreditCycleAt(
        new Date("2026-09-19T12:00:00.000Z"),
        "2026-09-11T11:37:15.482Z",
      ).period,
    ];
    for (const key of keys) expect([key, accepted(key)]).toEqual([key, true]);
  });

  it("★ and still refuses a key from neither vocabulary", () => {
    expect(accepted("september")).toBe(false);
    expect(accepted("cycle:2026-09-11T11:37:15Z")).toBe(false);
  });
});
