import { parseAnalyticsRange } from "@/lib/analytics/range";
import type { MinkWorkflowAuthorityInput } from "./workflow-types";

export type BusinessBriefPeriod = "daily" | "weekly";
export interface BusinessBriefInput extends MinkWorkflowAuthorityInput {
  period: BusinessBriefPeriod;
  defaultLowStockThreshold: number;
}

export interface BusinessBriefSnapshot {
  period: BusinessBriefPeriod;
  rangeLabel: string;
  comparisonLabel: string;
  fromInclusive: string;
  toExclusive: string;
  timeZone: string;
  currency: string;
  locationLabel: string;
  netSales: number;
  previousNetSales: number;
  orders: number;
  previousOrders: number;
  returns: number;
  previousReturns: number;
  createdOrders: number;
  failedPaymentOrders: number;
  locations: Array<{
    id: string;
    name: string;
    trackedItems: number;
    lowStock: number;
    outOfStock: number;
  }>;
  dataAsOf: string;
}

export interface BusinessBriefSignal {
  key: "sales" | "inventory" | "returns" | "payments";
  status: "attention" | "no_signal" | "insufficient_data";
  title: string;
  evidence: string;
  nextStep: string;
  path: string;
}

export interface BusinessBriefResult extends BusinessBriefSnapshot {
  rulesVersion: "business-brief-v1";
  signals: BusinessBriefSignal[];
  limitations: string[];
}

/** Compare complete local calendar days, including across DST changes. */
export function businessBriefRange(
  input: Pick<BusinessBriefInput, "period" | "timeZone" | "requestedAt">,
) {
  const now = new Date(input.requestedAt);
  const yesterday = parseAnalyticsRange(
    { range: "yesterday", compare: "none" },
    input.timeZone,
    now,
  );
  const days = input.period === "weekly" ? 7 : 1;
  const end = yesterday.customFrom;
  const shift = (offset: number) => {
    const date = new Date(`${end}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  };
  return parseAnalyticsRange(
    {
      range: "custom",
      from: shift(1 - days),
      to: end,
      compare: "custom",
      compareFrom: shift(1 - 2 * days),
      compareTo: shift(-days),
    },
    input.timeZone,
    now,
  );
}

/** Deterministic, bounded evidence rules; never infer causes from correlations. */
export function buildBusinessBriefResult(
  snapshot: BusinessBriefSnapshot,
): BusinessBriefResult {
  const salesBaseline =
    snapshot.previousOrders >= 5 && snapshot.previousNetSales > 0;
  const decline = salesBaseline
    ? ((snapshot.previousNetSales - snapshot.netSales) /
        snapshot.previousNetSales) *
      100
    : null;
  const affectedLocations = snapshot.locations.filter(
    (location) => location.lowStock > 0 || location.outOfStock > 0,
  ).length;
  const tracked = snapshot.locations.some(
    (location) => location.trackedItems > 0,
  );
  const returnBaseline = snapshot.previousReturns >= 5;
  const returnsRise =
    returnBaseline && snapshot.returns >= snapshot.previousReturns * 1.5;
  const failedShare =
    snapshot.createdOrders > 0
      ? (snapshot.failedPaymentOrders / snapshot.createdOrders) * 100
      : 0;
  return {
    ...snapshot,
    rulesVersion: "business-brief-v1",
    signals: [
      {
        key: "sales",
        title: "Sales comparison",
        status: !salesBaseline
          ? "insufficient_data"
          : decline! >= 20
            ? "attention"
            : "no_signal",
        evidence: salesBaseline
          ? `Net sales ${decline! > 0 ? "fell" : "rose"} ${Math.abs(decline!).toFixed(1)}% against the preceding period (${snapshot.previousOrders} recognized orders). The attention threshold is a 20% decline.`
          : "A sales trend needs at least 5 recognized orders and positive net sales in the preceding period.",
        nextStep:
          "Review orders and channel changes before deciding what caused the movement.",
        path: "/dashboard/analytics",
      },
      {
        key: "inventory",
        title: "Stock by location",
        status: !tracked
          ? "insufficient_data"
          : affectedLocations > 0
            ? "attention"
            : "no_signal",
        evidence: tracked
          ? `${affectedLocations} of ${snapshot.locations.length} locations have low-stock or out-of-stock tracked SKUs. Stock elsewhere does not hide a local shortage.`
          : "No tracked inventory was found at the accessible active locations.",
        nextStep:
          "Open the affected location's inventory and review its individual SKUs.",
        path: "/dashboard/inventory",
      },
      {
        key: "returns",
        title: "Return activity",
        status: !returnBaseline
          ? "insufficient_data"
          : returnsRise
            ? "attention"
            : "no_signal",
        evidence: `${snapshot.returns} non-rejected, non-cancelled return records opened in this period; ${snapshot.previousReturns} in the preceding period. ${returnBaseline ? "Attention starts at a 50% increase." : "At least 5 preceding records are needed for a trend."}`,
        nextStep:
          "Review return records and reasons. These are record counts, not a return rate.",
        path: "/dashboard/orders/returns",
      },
      {
        key: "payments",
        title: "Orders with failed payments",
        status:
          snapshot.createdOrders === 0
            ? "insufficient_data"
            : snapshot.failedPaymentOrders >= 3 && failedShare >= 20
              ? "attention"
              : "no_signal",
        evidence: `${snapshot.failedPaymentOrders} of ${snapshot.createdOrders} orders created in this period currently have failed payment status (${failedShare.toFixed(1)}%). Attention requires at least 3 and at least 20%.`,
        nextStep:
          "Review these orders before investigating checkout or contacting customers. This is not a gateway-attempt failure rate.",
        path: "/dashboard/orders",
      },
    ],
    limitations: [
      "Daily covers yesterday; weekly covers the last 7 completed local days. Today's partial sales are excluded.",
      "Sales use dashboard-recognized orders. Returns use their creation time and original order location, not the receiving location.",
      "Inventory is current at collection time, counts SKUs per location, and excludes untracked stock. Counts across locations are not unique products.",
      "Payment status is current for orders created in the selected period, not a history of payment attempts or when a failure occurred.",
      "No signal means these fixed rules did not trigger; it is not an all-clear. Source reads may finish at slightly different times.",
      "This is one requested brief. Recurring watches and automatic business actions are not enabled by this request.",
    ],
  };
}
