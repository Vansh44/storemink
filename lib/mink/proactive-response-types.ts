import type {
  BusinessBriefInput,
  BusinessBriefResult,
  BusinessBriefSignal,
} from "./business-brief-types";

export const RESPONSE_SIGNALS = [
  "inventory",
  "payments",
  "sales",
  "returns",
] as const;
export type ResponseSignal = (typeof RESPONSE_SIGNALS)[number];
export interface ProactiveResponseInput extends BusinessBriefInput {
  responseId: string;
  signal: ResponseSignal;
}
export interface ProactiveResponseResult {
  signal: ResponseSignal;
  evidence: BusinessBriefSignal;
  dataAsOf: string;
  locationLabel: string;
  timeZone: string;
  rangeLabel: string;
  rows: Array<{ label: string; detail: string; path: string }>;
  truncated: boolean;
  nextSteps: string[];
  limitations: string[];
}
export const RESPONSE_TITLES: Record<ResponseSignal, string> = {
  inventory: "Review local stock shortages",
  payments: "Review orders with failed payments",
  sales: "Investigate the sales change",
  returns: "Review increased return activity",
};
export const RESPONSE_LIMITS =
  "One read-only investigation; at most 20 detail rows, inventory detail from at most 3 affected locations. No business changes, messages, model calls or extra Mink credits. Any later action needs its own preview and approval.";
export function isResponseSignal(value: unknown): value is ResponseSignal {
  return (
    typeof value === "string" &&
    RESPONSE_SIGNALS.includes(value as ResponseSignal)
  );
}
/** A transparent triage order, not a revenue forecast or inferred cause. */
export function rankResponseSignals(result: BusinessBriefResult, kind: string) {
  return RESPONSE_SIGNALS.filter(
    (key) =>
      (kind === "brief" || kind === key) &&
      result.signals.some((s) => s.key === key && s.status === "attention"),
  ).map((signal, index) => ({
    signal,
    rank: index + 1,
    title: RESPONSE_TITLES[signal],
    evidence: result.signals.find((s) => s.key === signal)!.evidence,
    impact:
      signal === "inventory"
        ? "Review availability at the affected locations; the number of recoverable sales is unknown."
        : signal === "payments"
          ? "Identify orders needing investigation; recoverable payment value is unknown."
          : signal === "sales"
            ? "Check recorded changes before choosing a remedy; future revenue impact is unknown."
            : "Inspect return records before deciding a remedy; cost savings are unknown.",
  }));
}
