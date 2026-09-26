// ---------------------------------------------------------------------------
// Heading typography a theme may set: which face headings use, how large they
// run, their weight, case and letter spacing.
//
// ★ OPT-IN, AND ABSENT MEANS TODAY'S HEADINGS EXACTLY. Every storefront
// heading already has its own size, weight and spacing in CSS. A theme that
// sets nothing here emits no variable and no root class, so each heading keeps
// the values it has now. A theme that sets one key changes that one property
// and nothing else.
//
// Pure: the storefront layout, theme validation, the Theme Studio compiler and
// the tests all import this one file.
// ---------------------------------------------------------------------------

import type { ThemeFonts } from "./types";

export const HEADING_FONTS = ["body", "display"] as const;
export const HEADING_SCALES = ["small", "medium", "large", "xlarge"] as const;
export const HEADING_WEIGHTS = [
  "regular",
  "medium",
  "semibold",
  "bold",
  "heavy",
] as const;
export const HEADING_CASES = ["none", "uppercase"] as const;
export const HEADING_TRACKINGS = ["tight", "normal", "wide"] as const;

export type HeadingFont = (typeof HEADING_FONTS)[number];
export type HeadingScale = (typeof HEADING_SCALES)[number];
export type HeadingWeight = (typeof HEADING_WEIGHTS)[number];
export type HeadingCase = (typeof HEADING_CASES)[number];
export type HeadingTracking = (typeof HEADING_TRACKINGS)[number];

export interface ThemeTypography {
  /** "display" sets headings in the theme's display face; "body" in its body
   *  face. Absent: each heading keeps the face it has today. */
  headingFont?: HeadingFont;
  /** Multiplies every heading size. Phones get half the difference, so a
   *  large scale does not push hero copy off a 375px screen. */
  headingScale?: HeadingScale;
  headingWeight?: HeadingWeight;
  headingCase?: HeadingCase;
  headingTracking?: HeadingTracking;
}

export const HEADING_SCALE_FACTOR: Record<HeadingScale, number> = {
  small: 0.88,
  medium: 1,
  large: 1.12,
  xlarge: 1.25,
};

export const HEADING_WEIGHT_VALUE: Record<HeadingWeight, number> = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  heavy: 800,
};

export const HEADING_TRACKING_VALUE: Record<HeadingTracking, string> = {
  tight: "-0.03em",
  normal: "0em",
  wide: "0.06em",
};

/**
 * The face each choice points at. ★ THE LEGACY SLOTS, NOT THE THEME'S FONT
 * VALUE: `designToCssVars` and a merchant's font override both re-point
 * `--font-outfit` (body) and `--font-stick-no-bills` (display), so pointing
 * headings at the slot follows whichever face the store really shows.
 */
export const HEADING_FONT_VAR: Record<HeadingFont, string> = {
  body: "var(--font-outfit)",
  display: "var(--font-stick-no-bills)",
};

/**
 * Every heading the settings reach. The CSS rules live in
 * storefront-theme.css ("Theme heading typography"); a test fails if one of
 * these is missing from them, or if its base rule does not read the scale.
 *
 * ★ PAGE AND SECTION HEADINGS, NOT UTILITY TITLES. Checkout, account and
 * order pages keep their plain titles: a display serif in capitals on
 * "My orders" is decoration nobody asked for.
 */
export const HEADING_SELECTORS = [
  ".home-section-title",
  ".home-hero-heading",
  ".home-carousel-heading",
  ".home-banner-heading",
  ".home-media-text-heading",
  ".home-newsletter-heading",
  ".home-tile-title",
  ".home-rich-text-content h1",
  ".home-rich-text-content h2",
  ".home-rich-text-content h3",
  ".shop-title",
  ".shop-title-grocery",
  ".shop-collection-title",
  ".pdp-name",
  ".gpdp-name",
  ".cart-title",
  ".gcart-title",
  ".blog-detail-title",
] as const;

/** Tile titles are card labels, sized for their tile: they take the face,
 *  weight, case and spacing but not the scale. */
export const UNSCALED_HEADING_SELECTORS = [".home-tile-title"] as const;

function pick<T extends string>(
  list: readonly T[],
  value: unknown,
): T | undefined {
  return typeof value === "string" &&
    (list as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Keep only the recognised settings. Unknown values are dropped, never
 *  guessed at; validation reports them separately. */
export function cleanTypography(raw: unknown): ThemeTypography {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const out: ThemeTypography = {};
  const font = pick(HEADING_FONTS, r.headingFont);
  const scale = pick(HEADING_SCALES, r.headingScale);
  const weight = pick(HEADING_WEIGHTS, r.headingWeight);
  const kase = pick(HEADING_CASES, r.headingCase);
  const tracking = pick(HEADING_TRACKINGS, r.headingTracking);
  if (font) out.headingFont = font;
  if (scale) out.headingScale = scale;
  if (weight) out.headingWeight = weight;
  if (kase) out.headingCase = kase;
  if (tracking) out.headingTracking = tracking;
  return out;
}

/**
 * The variables these settings write onto `.storefront-root`. Only what is
 * set: an absent key must leave every heading on its own value.
 */
export function typographyCssVars(
  raw: ThemeTypography | undefined,
): Record<string, string> {
  const t = cleanTypography(raw);
  const vars: Record<string, string> = {};
  if (t.headingFont)
    vars["--sm-heading-font"] = HEADING_FONT_VAR[t.headingFont];
  if (t.headingScale && t.headingScale !== "medium") {
    vars["--sm-heading-scale"] = String(HEADING_SCALE_FACTOR[t.headingScale]);
  }
  if (t.headingWeight) {
    vars["--sm-heading-weight"] = String(HEADING_WEIGHT_VALUE[t.headingWeight]);
  }
  if (t.headingTracking) {
    vars["--sm-heading-tracking"] = HEADING_TRACKING_VALUE[t.headingTracking];
  }
  return vars;
}

/**
 * Root classes that switch each property on.
 *
 * ★ A CLASS PER PROPERTY, because the headings do not share one default. The
 * hero is 800, the editorial band 650, the blog title 600, and several rules
 * set no face at all. A rule reading `var(--sm-heading-weight)` with nothing
 * set would reset every heading to normal weight, so each property is applied
 * only when the theme chose it. The scale needs no class: it multiplies each
 * heading's own size and is 1 when unset; its class only lets an over-long
 * word wrap instead of overflowing a narrow column.
 */
export function typographyRootClasses(
  raw: ThemeTypography | undefined,
): string[] {
  const t = cleanTypography(raw);
  const classes: string[] = [];
  if (t.headingScale && t.headingScale !== "medium") classes.push("sm-h-scale");
  if (t.headingFont) classes.push("sm-h-font");
  if (t.headingWeight) classes.push("sm-h-weight");
  if (t.headingCase === "uppercase") classes.push("sm-h-upper");
  if (t.headingTracking) classes.push("sm-h-track");
  return classes;
}

/**
 * The weights each loaded face really has (app/layout.tsx). A variable font
 * is a range; a static font is its list.
 */
const FONT_WEIGHTS: Record<string, { min: number; max: number }> = {
  "var(--font-outfit)": { min: 100, max: 900 },
  "var(--font-roboto)": { min: 400, max: 700 },
  "var(--font-stick-no-bills)": { min: 800, max: 800 },
  "var(--font-inter)": { min: 100, max: 900 },
  "var(--font-fraunces)": { min: 100, max: 900 },
  "var(--font-space-grotesk)": { min: 300, max: 700 },
  "var(--font-jakarta)": { min: 200, max: 800 },
  "var(--font-jost)": { min: 300, max: 500 },
  "var(--font-instrument-serif)": { min: 400, max: 400 },
};

/** The weights storefront headings use today, when a theme sets none. */
const DEFAULT_HEADING_WEIGHTS = [600, 650, 700, 800];

/**
 * Would a bold heading have to be faked in this face?
 *
 * A browser asked for 600+ from a face whose heaviest weight is 500 or less
 * smears the regular glyphs to fake bold. That is the one mismatch worth
 * refusing: asking a heavy face for a lighter weight just renders its lightest
 * real weight.
 */
export function fakesBold(fontValue: string, weight: number): boolean {
  const range = FONT_WEIGHTS[fontValue.trim()];
  if (!range) return false;
  return weight >= 600 && range.max < 600;
}

/**
 * Problems with a theme's typography, in words the Theme Studio repair loop
 * and a reviewer can act on. Unknown values are named; so is a heading face
 * that would render in faked bold.
 */
export function typographyIssues(
  raw: unknown,
  fonts: Pick<ThemeFonts, "body" | "display">,
): string[] {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return ["typography must be an object."];
  }
  const r = raw as Record<string, unknown>;
  const issues: string[] = [];
  const allowed: Record<string, readonly string[]> = {
    headingFont: HEADING_FONTS,
    headingScale: HEADING_SCALES,
    headingWeight: HEADING_WEIGHTS,
    headingCase: HEADING_CASES,
    headingTracking: HEADING_TRACKINGS,
  };
  for (const [key, value] of Object.entries(r)) {
    const list = allowed[key];
    if (!list) {
      issues.push(`typography.${key} is not a typography setting.`);
    } else if (value !== undefined && !list.includes(String(value))) {
      issues.push(
        `typography.${key} "${String(value)}" must be one of ${list.join(", ")}.`,
      );
    }
  }
  const t = cleanTypography(r);
  const face = t.headingFont === "display" ? fonts.display : fonts.body;
  const weights = t.headingWeight
    ? [HEADING_WEIGHT_VALUE[t.headingWeight]]
    : DEFAULT_HEADING_WEIGHTS;
  if (weights.some((w) => fakesBold(face, w))) {
    issues.push(
      t.headingWeight
        ? `Headings would be set in faked bold: the ${t.headingFont ?? "body"} face has no weight near ${HEADING_WEIGHT_VALUE[t.headingWeight]}. Choose a lighter headingWeight or another face.`
        : `Headings would be set in faked bold: the ${t.headingFont ?? "body"} face has no bold weight. Set headingWeight to regular or medium, or choose another face.`,
    );
  }
  return issues;
}
