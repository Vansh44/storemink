// ---------------------------------------------------------------------------
// The Theme Studio release scorecard (docs/theme-acceptance.md §5), with no
// imports at all, so the review screen (a client component) and the server
// share one copy of the rows, the bar and the rejection conditions.
// ---------------------------------------------------------------------------

/** docs/theme-acceptance.md §5 — the two reviewer chairs. */
export const REVIEWER_ROLES = [
  {
    key: "design",
    label: "Product / design",
    prompt: "Art direction, distinctness, typography and imagery.",
  },
  {
    key: "commerce",
    label: "Commerce / QA",
    prompt: "Shopping clarity, responsive layouts and detail quality.",
  },
] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number]["key"];

/** The eight rows of the scorecard, scored 1–5, in the words of
 * docs/theme-acceptance.md §5 (change them together). `key` is the wire name
 * and `column` the database column; both are fixed by migration 0134. */
export const SCORECARD_DIMENSIONS = [
  {
    key: "artDirection",
    column: "art_direction",
    label: "Art direction",
    question:
      "A coherent and intentional point of view, not a collection of fashionable effects.",
  },
  {
    key: "distinctness",
    column: "distinctness",
    label: "Distinctness",
    question:
      "Homepage, shop, product, cart, header and footer cannot be mistaken for another StoreMink theme with new colours.",
  },
  {
    key: "commerceClarity",
    column: "commerce_clarity",
    label: "Commerce clarity",
    question:
      "Discovery, price, variant, stock, add-to-cart, cart and checkout matter more than decoration.",
  },
  {
    key: "typography",
    column: "typography",
    label: "Typography",
    question:
      "Clear hierarchy, readable measures, suitable weights and graceful long-content behaviour.",
  },
  {
    key: "imagery",
    column: "imagery",
    label: "Imagery",
    question:
      "Consistent crop language, useful focal points, licensed sources and no obvious stock-photo collage.",
  },
  {
    key: "responsiveComposition",
    column: "responsive_composition",
    label: "Responsive composition",
    question:
      "Mobile is deliberately composed rather than a collapsed desktop design.",
  },
  {
    key: "detailQuality",
    column: "detail_quality",
    label: "Detail quality",
    question:
      "Spacing, icons, borders, motion, empty states and error states feel finished.",
  },
  {
    key: "brandAdaptability",
    column: "brand_adaptability",
    label: "Brand adaptability",
    question:
      "A merchant logo, primary colour and real catalogue can replace the seed without destroying the design.",
  },
] as const;
export type ScorecardKey = (typeof SCORECARD_DIMENSIONS)[number]["key"];
export type Scores = Record<ScorecardKey, number>;

/** The automatic-rejection conditions of §5. Ticking any one makes an
 * approving verdict impossible, whatever the scores say. */
export const REJECTION_CONDITIONS = [
  {
    key: "palette_only",
    label:
      "An existing StoreMink theme with only palette, font, radius or section order changes",
  },
  {
    key: "copied",
    label: "Copies another company's theme, screenshots, copy or assets",
  },
  {
    key: "generic_surface",
    label: "Shop, product, cart or mobile views are generic or unfinished",
  },
  {
    key: "needs_custom_code",
    label: "Needs custom code to render its core advertised design",
  },
  { key: "placeholder_copy", label: "Placeholder copy is visible in the demo" },
  {
    key: "inaccessible_copy",
    label: "Inaccessible text is visible in the demo",
  },
] as const;
export type RejectionCondition = (typeof REJECTION_CONDITIONS)[number]["key"];

/** Every row must reach this… */
export const MIN_ROW_SCORE = 4;
/** …and the eight rows must total this: an average of 4.2 over eight rows
 * is 33.6, and scores are whole numbers. */
export const MIN_TOTAL_SCORE = 34;
export const REJECT_NOTE_MIN = 10;
export const REVIEW_NOTE_MAX = 2000;

export interface Scorecard {
  role: ReviewerRole;
  scores: Scores;
  rejections: RejectionCondition[];
  verdict: "approve" | "reject";
  notes: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Does this set of scores clear the approval bar? */
export function scorecardClearsBar(
  scores: Scores,
  rejections: readonly RejectionCondition[],
): boolean {
  const values = SCORECARD_DIMENSIONS.map((d) => scores[d.key]);
  const total = values.reduce((sum, value) => sum + value, 0);
  return (
    rejections.length === 0 &&
    Math.min(...values) >= MIN_ROW_SCORE &&
    total >= MIN_TOTAL_SCORE
  );
}

export function scorecardAverage(scores: Scores): number {
  const total = SCORECARD_DIMENSIONS.reduce((s, d) => s + scores[d.key], 0);
  return total / SCORECARD_DIMENSIONS.length;
}
