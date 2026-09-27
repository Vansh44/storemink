import { THEME_IMAGE_PROBLEMS, type ThemeImageProblem } from "./image-review";

// ---------------------------------------------------------------------------
// What the Studio screens show about generated images (Track 3.5), read from
// the image runs already stored: each run's `outcome_detail.outcomes` (one per
// slot) and its `usage` telemetry (one entry per image call and per review).
//
// Pure and defensive: the rows are stored JSON written by the worker, and a
// run written before a field existed (3.2 runs have no attempts or review)
// must still read as something sensible rather than break the page.
// ---------------------------------------------------------------------------

export type SlotDrawStatus =
  | "generated"
  | "rejected"
  | "refused"
  | "failed"
  | "unusable"
  | "skipped";

export interface SlotDrawHistory {
  runId: string;
  createdAt: string;
  status: SlotDrawStatus;
  /** Images drawn for this slot in that run (1, or 2 with a redraw). */
  attempts: number;
  /** For a generated image: how the check went. Older runs: "unreviewed". */
  review: "passed" | "flagged" | "unreviewed" | null;
  problems: ThemeImageProblem[];
  note: string;
  /** Why the provider refused, or the failure code. */
  reason: string | null;
  /** This slot's image and review calls in that run, estimated. */
  costMicroUsd: number;
  /** The run was a redraw of chosen slots, not a full run. */
  redraw: boolean;
}

export interface ImageRunSummary {
  redraw: boolean;
  slots: number;
  generated: number;
  /** Kept its placeholder because a serious problem survived the redraw. */
  rejected: number;
  /** Refused, failed or unusable: kept its placeholder. */
  failed: number;
  skipped: number;
  /** Slots drawn twice. */
  redrawn: number;
  /** Kept with a minor problem noted. */
  flagged: number;
  unreviewed: number;
  imageCostMicroUsd: number;
  reviewCostMicroUsd: number;
}

export interface StoredImageRun {
  id: string;
  createdAt: string;
  imageSlotIds: readonly string[];
  outcomeDetail: unknown;
  usage: unknown;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const STATUSES: readonly SlotDrawStatus[] = [
  "generated",
  "rejected",
  "refused",
  "failed",
  "unusable",
  "skipped",
];
const PROBLEMS = new Set<string>(THEME_IMAGE_PROBLEMS);

function outcomesOf(detail: unknown): Rec[] {
  return isRec(detail) && Array.isArray(detail.outcomes)
    ? detail.outcomes.filter(isRec)
    : [];
}

function entriesOf(usage: unknown, key: "calls" | "reviews"): Rec[] {
  return isRec(usage) && Array.isArray(usage[key])
    ? usage[key].filter(isRec)
    : [];
}

function costFor(usage: unknown, slotId: string): number {
  return [...entriesOf(usage, "calls"), ...entriesOf(usage, "reviews")]
    .filter((entry) => entry.briefId === slotId)
    .reduce((sum, entry) => sum + num(entry.estimatedCostMicroUsd), 0);
}

function readOutcome(
  outcome: Rec,
): Omit<
  SlotDrawHistory,
  "runId" | "createdAt" | "costMicroUsd" | "redraw"
> | null {
  const status = STATUSES.find((s) => s === outcome.status);
  if (!status) return null;
  const review = ["passed", "flagged", "unreviewed"].includes(
    str(outcome.review),
  )
    ? (outcome.review as SlotDrawHistory["review"])
    : status === "generated"
      ? "unreviewed"
      : null;
  return {
    status,
    // A run before redraws existed drew each slot once.
    attempts: status === "skipped" ? 0 : Math.max(1, num(outcome.attempts)),
    review,
    problems: Array.isArray(outcome.problems)
      ? outcome.problems.filter((p): p is ThemeImageProblem =>
          PROBLEMS.has(p as string),
        )
      : [],
    note: str(outcome.note).slice(0, 300),
    reason:
      status === "refused"
        ? str(outcome.reason) || null
        : status === "failed" || status === "unusable"
          ? str(outcome.code) || null
          : null,
  };
}

/**
 * How each slot's current image came to be: the NEAREST run (runs arrive
 * nearest first — the version's own run, then its parents') that drew it. A
 * skipped slot is passed over, so a redraw that was cut short does not hide
 * the run that really drew the image.
 */
export function slotDrawHistory(
  runs: readonly StoredImageRun[],
): Map<string, SlotDrawHistory> {
  const history = new Map<string, SlotDrawHistory>();
  for (const run of runs) {
    for (const raw of outcomesOf(run.outcomeDetail)) {
      const slotId = str(raw.slotId);
      if (!slotId || history.has(slotId)) continue;
      const outcome = readOutcome(raw);
      if (!outcome || outcome.status === "skipped") continue;
      history.set(slotId, {
        ...outcome,
        runId: run.id,
        createdAt: run.createdAt,
        costMicroUsd: costFor(run.usage, slotId),
        redraw: run.imageSlotIds.length > 0,
      });
    }
  }
  return history;
}

/** One image run, summarised for the run list. */
export function imageRunSummary(run: StoredImageRun): ImageRunSummary | null {
  const outcomes = outcomesOf(run.outcomeDetail)
    .map(readOutcome)
    .filter((o): o is NonNullable<typeof o> => o !== null);
  const calls = entriesOf(run.usage, "calls");
  const reviews = entriesOf(run.usage, "reviews");
  if (outcomes.length === 0 && calls.length === 0) return null;
  const count = (test: (o: (typeof outcomes)[number]) => boolean) =>
    outcomes.filter(test).length;
  return {
    redraw: run.imageSlotIds.length > 0,
    slots: outcomes.length,
    generated: count((o) => o.status === "generated"),
    rejected: count((o) => o.status === "rejected"),
    failed: count((o) => ["refused", "failed", "unusable"].includes(o.status)),
    skipped: count((o) => o.status === "skipped"),
    redrawn: count((o) => o.attempts > 1),
    flagged: count((o) => o.review === "flagged"),
    unreviewed: count(
      (o) => o.status === "generated" && o.review === "unreviewed",
    ),
    imageCostMicroUsd: calls.reduce(
      (sum, c) => sum + num(c.estimatedCostMicroUsd),
      0,
    ),
    reviewCostMicroUsd: reviews.reduce(
      (sum, r) => sum + num(r.estimatedCostMicroUsd),
      0,
    ),
  };
}

/** Whether any of these runs recorded an art-direction image to reuse. */
export function hasReusableAnchor(runs: readonly StoredImageRun[]): boolean {
  return runs.some(
    (run) =>
      isRec(run.outcomeDetail) &&
      typeof run.outcomeDetail.anchorAssetId === "string",
  );
}

/** Short names for the check's problems, for the operator's screens. */
export const THEME_IMAGE_PROBLEM_LABEL: Record<ThemeImageProblem, string> = {
  wrong_subject: "wrong subject",
  text_or_logo: "lettering or a logo",
  person: "a person",
  malformed: "something malformed",
  multiple_subjects: "more than one product",
  off_style: "off-style",
  staging_mismatch: "a different setup from the other products",
  poor_crop: "a poor crop",
};

/**
 * What redrawing `count` slots is expected to cost and the most it can cost:
 * one image and one check each, plus a new art-direction image when there is
 * none to reuse, and at most every one of them redrawn once. The same list
 * prices as imageRunEstimate (image-generation-core.ts), passed in so this
 * stays importable by a client component.
 */
export function redrawEstimate(
  count: number,
  anchorReusable: boolean,
  prices: { imageUsd: number; reviewUsd: number },
): { images: number; expectedUsd: number; mostUsd: number } {
  const images = count + (anchorReusable ? 0 : 1);
  const once = images * (prices.imageUsd + prices.reviewUsd);
  return {
    images,
    expectedUsd: Math.round(once * 100) / 100,
    mostUsd: Math.round(once * 2 * 100) / 100,
  };
}
