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
