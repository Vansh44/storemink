import { describe, expect, it } from "vitest";
import {
  businessBriefRange,
  buildBusinessBriefResult,
  type BusinessBriefSnapshot,
} from "./business-brief-types";

export const briefSnapshot: BusinessBriefSnapshot = {
  period: "daily",
  rangeLabel: "4 Sep 2026",
  comparisonLabel: "3 Sep 2026",
  fromInclusive: "2026-09-03T18:30:00.000Z",
  toExclusive: "2026-09-04T18:30:00.000Z",
  timeZone: "Asia/Kolkata",
  currency: "INR",
  locationLabel: "Shop and Delhi",
  netSales: 800,
  previousNetSales: 1000,
  orders: 8,
  previousOrders: 10,
  returns: 9,
  previousReturns: 6,
  createdOrders: 15,
  failedPaymentOrders: 3,
  locations: [
    { id: "shop", name: "Shop", trackedItems: 8, lowStock: 1, outOfStock: 2 },
    { id: "delhi", name: "Delhi", trackedItems: 8, lowStock: 0, outOfStock: 6 },
  ],
  dataAsOf: "2026-09-05T04:00:00.000Z",
};

describe("business brief completed calendar periods", () => {
  it("excludes today's partial day in Kolkata", () => {
    const range = businessBriefRange({
      period: "daily",
      timeZone: "Asia/Kolkata",
      requestedAt: "2026-09-05T04:00:00Z",
    });
    expect(range.current.from.toISOString()).toBe("2026-09-03T18:30:00.000Z");
    expect(range.current.to.toISOString()).toBe("2026-09-04T18:30:00.000Z");
    expect(range.compare?.to).toEqual(range.current.from);
  });
  it("uses 7 completed local days and the preceding 7", () => {
    const range = businessBriefRange({
      period: "weekly",
      timeZone: "Asia/Kolkata",
      requestedAt: "2026-09-05T04:00:00Z",
    });
    expect([
      range.customFrom,
      range.customTo,
      range.compareFrom,
      range.compareTo,
    ]).toEqual(["2026-08-29", "2026-09-04", "2026-08-22", "2026-08-28"]);
  });
  it.each([
    [
      "2026-03-09T12:00:00Z",
      "2026-03-08T05:00:00.000Z",
      "2026-03-09T04:00:00.000Z",
    ],
    [
      "2026-11-02T12:00:00Z",
      "2026-11-01T04:00:00.000Z",
      "2026-11-02T05:00:00.000Z",
    ],
  ])("preserves local midnight across DST at %s", (requestedAt, from, to) => {
    const range = businessBriefRange({
      period: "daily",
      timeZone: "America/New_York",
      requestedAt,
    });
    expect(range.current.from.toISOString()).toBe(from);
    expect(range.current.to.toISOString()).toBe(to);
    expect(range.compare?.to).toEqual(range.current.from);
  });
});

describe("business brief evidence rules", () => {
  it("triggers all four rules at their inclusive thresholds", () => {
    const result = buildBusinessBriefResult(briefSnapshot);
    expect(result.signals.map((signal) => signal.status)).toEqual(
      Array(4).fill("attention"),
    );
    expect(result.locations).toEqual(briefSnapshot.locations);
    expect(result.signals[1].evidence).toContain("2 of 2");
  });
  it("does not manufacture trends from zero or sparse baselines", () => {
    const result = buildBusinessBriefResult({
      ...briefSnapshot,
      previousOrders: 4,
      previousReturns: 4,
      createdOrders: 0,
      failedPaymentOrders: 0,
      locations: [],
    });
    expect(result.signals.map((signal) => signal.status)).toEqual(
      Array(4).fill("insufficient_data"),
    );
    expect(JSON.stringify(result)).not.toMatch(/NaN|Infinity/);
  });
  it("does not flag values just below the thresholds", () => {
    const result = buildBusinessBriefResult({
      ...briefSnapshot,
      netSales: 801,
      returns: 8,
      createdOrders: 16,
      locations: [
        { ...briefSnapshot.locations[0], lowStock: 0, outOfStock: 0 },
      ],
    });
    expect(
      result.signals.every((signal) => signal.status === "no_signal"),
    ).toBe(true);
  });
  it("requires both payment count and share; two failures do not trigger", () => {
    expect(
      buildBusinessBriefResult({
        ...briefSnapshot,
        createdOrders: 2,
        failedPaymentOrders: 2,
      }).signals[3].status,
    ).toBe("no_signal");
  });
  it("labels refunds-driven non-positive baselines insufficient", () => {
    expect(
      buildBusinessBriefResult({ ...briefSnapshot, previousNetSales: -100 })
        .signals[0].status,
    ).toBe("insufficient_data");
  });
  it("keeps the four outputs bounded and states their measurement limitations", () => {
    const result = buildBusinessBriefResult(briefSnapshot);
    expect(result.signals).toHaveLength(4);
    expect(result.limitations.join(" ")).toMatch(/not an all-clear/);
    expect(result.signals[2].nextStep).toContain("not a return rate");
    expect(result.signals[3].nextStep).toContain(
      "not a gateway-attempt failure rate",
    );
    expect(result.rulesVersion).toBe("business-brief-v1");
  });
});
