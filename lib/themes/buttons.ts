// ---------------------------------------------------------------------------
// Button styles a theme may set: corner shape, how primary and secondary
// buttons are filled, their case, weight and letter spacing, and what a hover
// does.
//
// ★ OPT-IN, AND ABSENT MEANS TODAY'S BUTTONS EXACTLY. Every storefront button
// already has its own colours, radius and hover in CSS. A theme that sets
// nothing emits no variable and no root class, so each button keeps what it
// has now. A theme that sets one key changes that one property and nothing
// else.
//
// ★ BUTTONS WEAR THEIR ROLE AS A CLASS. `sm-btn-primary` marks the one action
// a screen exists for (Shop now, Buy now, Checkout); `sm-btn-secondary` marks
// the quieter one beside it (Add to cart next to Buy now, Load more, View
// cart). The CSS in storefront-theme.css ("Theme button styles") targets the
// role, so a button styled by a CSS module is reached too.
//
// Pure: the storefront layout, theme validation, the Theme Studio compiler and
// the tests all import this one file.
// ---------------------------------------------------------------------------

import type { ThemeFonts } from "./types";

export const BUTTON_SHAPES = ["square", "rounded", "pill"] as const;
export const BUTTON_PRIMARY_STYLES = ["solid", "outline"] as const;
export const BUTTON_SECONDARY_STYLES = ["solid", "outline", "text"] as const;
export const BUTTON_CASES = ["none", "uppercase"] as const;
export const BUTTON_WEIGHTS = [
  "regular",
  "medium",
  "semibold",
  "bold",
] as const;
export const BUTTON_TRACKINGS = ["normal", "wide"] as const;
export const BUTTON_HOVERS = ["darken", "lift", "invert"] as const;

export type ButtonShape = (typeof BUTTON_SHAPES)[number];
export type ButtonPrimaryStyle = (typeof BUTTON_PRIMARY_STYLES)[number];
export type ButtonSecondaryStyle = (typeof BUTTON_SECONDARY_STYLES)[number];
export type ButtonCase = (typeof BUTTON_CASES)[number];
export type ButtonWeight = (typeof BUTTON_WEIGHTS)[number];
export type ButtonTracking = (typeof BUTTON_TRACKINGS)[number];
export type ButtonHover = (typeof BUTTON_HOVERS)[number];

export interface ThemeButtons {
  /** Corners. Absent: each button keeps the radius it has today. */
  shape?: ButtonShape;
  /** "outline" draws primary buttons as a ring in their colour. "solid" is
   *  how every primary button is drawn today, so it changes nothing. */
  primary?: ButtonPrimaryStyle;
  /** Secondary buttons are mixed today (Add to cart is a ring, a grocery
   *  store's is filled), so every value here is a change. "text" is an
   *  underlined label with no box. */
  secondary?: ButtonSecondaryStyle;
  case?: ButtonCase;
  weight?: ButtonWeight;
  tracking?: ButtonTracking;
  /** "darken" tints, "lift" raises with a shadow, "invert" swaps filled and
   *  ringed. Absent: each button keeps its own hover. */
  hover?: ButtonHover;
}

export const BUTTON_RADIUS: Record<ButtonShape, string> = {
  square: "0px",
  rounded: "8px",
  pill: "999px",
};

export const BUTTON_WEIGHT_VALUE: Record<ButtonWeight, number> = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
};

export const BUTTON_TRACKING_VALUE: Record<ButtonTracking, string> = {
  normal: "0em",
  wide: "0.08em",
};

/** The role classes buttons wear in markup. */
export const BUTTON_ROLE_CLASSES = [
  "sm-btn-primary",
  "sm-btn-secondary",
] as const;

/**
 * The buttons that carry each role, by the class they already had. A test
 * fails if one of these is rendered without its role class, or if its base
 * CSS rule does not declare the colour pair the outline and hover rules read.
 *
 * ★ STOREFRONT ACTIONS, NOT FORMS. Checkout, sign-in and account buttons keep
 * their own look, for the reason 2.2 leaves those pages' titles alone.
 */
export const PRIMARY_BUTTON_SELECTORS = [
  ".home-hero-cta",
  ".home-banner-cta",
  ".home-media-text-cta",
  ".home-newsletter-button",
  ".pdp-btn-buy",
  ".gpdp-btn-buy",
  ".sm-sticky-atc-btn",
  ".cart-checkout-btn",
  ".gcart-checkout-btn",
  ".cart-empty-cta",
  ".gcart-empty-cta",
] as const;

export const SECONDARY_BUTTON_SELECTORS = [
  ".pdp-btn-cart",
  ".gpdp-btn-cart",
  ".shop-more-btn",
] as const;

/** Joined to the email field beside it, so it keeps that seam: taking the
 *  pill shape would round the corner that meets the input. */
export const UNSHAPED_BUTTON_SELECTORS = [".home-newsletter-button"] as const;

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
export function cleanButtons(raw: unknown): ThemeButtons {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const out: ThemeButtons = {};
  const shape = pick(BUTTON_SHAPES, r.shape);
  const primary = pick(BUTTON_PRIMARY_STYLES, r.primary);
  const secondary = pick(BUTTON_SECONDARY_STYLES, r.secondary);
  const kase = pick(BUTTON_CASES, r.case);
  const weight = pick(BUTTON_WEIGHTS, r.weight);
  const tracking = pick(BUTTON_TRACKINGS, r.tracking);
  const hover = pick(BUTTON_HOVERS, r.hover);
  if (shape) out.shape = shape;
  if (primary) out.primary = primary;
  if (secondary) out.secondary = secondary;
  if (kase) out.case = kase;
  if (weight) out.weight = weight;
  if (tracking) out.tracking = tracking;
  if (hover) out.hover = hover;
  return out;
}

/** The variables these settings write onto `.storefront-root`. Only what is
 *  set: an absent key must leave every button on its own value. */
export function buttonCssVars(
  raw: ThemeButtons | undefined,
): Record<string, string> {
  const t = cleanButtons(raw);
  const vars: Record<string, string> = {};
  if (t.shape) vars["--sm-btn-radius"] = BUTTON_RADIUS[t.shape];
  if (t.weight) vars["--sm-btn-weight"] = String(BUTTON_WEIGHT_VALUE[t.weight]);
  if (t.tracking) vars["--sm-btn-tracking"] = BUTTON_TRACKING_VALUE[t.tracking];
  return vars;
}

/**
 * Root classes that switch each property on — one per property, for 2.2's
 * reason: the buttons share no default, so an unconditional rule would reset
 * every button the theme left alone.
 *
 * ★ `primary: "solid"` EMITS NOTHING. Every primary button is solid today, so
 * the class would be a no-op that nonetheless takes over the hover.
 */
export function buttonRootClasses(raw: ThemeButtons | undefined): string[] {
  const t = cleanButtons(raw);
  const classes: string[] = [];
  if (t.shape) classes.push("sm-btn-shape");
  if (t.primary === "outline") classes.push("sm-btn-p-outline");
  if (t.secondary) classes.push(`sm-btn-s-${t.secondary}`);
  if (t.case === "uppercase") classes.push("sm-btn-upper");
  if (t.weight) classes.push("sm-btn-weight");
  if (t.tracking) classes.push("sm-btn-track");
  if (t.hover) classes.push(`sm-btn-hover-${t.hover}`);
  return classes;
}

/**
 * Does this setting draw a button's COLOUR as text on the page — a ring, an
 * underlined label, or the ringed half of an inverting hover? Then that colour
 * has to read on every background a button sits on, which validation checks.
 */
export function buttonsDrawColourAsText(
  raw: ThemeButtons | undefined,
): boolean {
  const t = cleanButtons(raw);
  return (
    t.primary === "outline" ||
    t.secondary === "outline" ||
    t.secondary === "text" ||
    t.hover === "invert"
  );
}

/** The weights each loaded face really has (app/layout.tsx), as in
 *  typography.ts. Buttons render in the body face. */
const FONT_MAX_WEIGHT: Record<string, number> = {
  "var(--font-outfit)": 900,
  "var(--font-roboto)": 700,
  "var(--font-stick-no-bills)": 800,
  "var(--font-inter)": 900,
  "var(--font-fraunces)": 900,
  "var(--font-space-grotesk)": 700,
  "var(--font-jakarta)": 800,
  "var(--font-jost)": 500,
  "var(--font-instrument-serif)": 400,
};

/** The weights storefront buttons use today, when a theme sets none. */
const DEFAULT_BUTTON_WEIGHTS = [600, 650, 700];

/**
 * Problems with a theme's buttons, in words the Theme Studio repair loop and a
 * reviewer can act on: unknown values, and a label that would be set in a
 * faked bold (a weight of 600+ from a body face whose heaviest is 500 or less).
 * Contrast needs the palette, so validation.ts checks it.
 */
export function buttonIssues(
  raw: unknown,
  fonts: Pick<ThemeFonts, "body">,
): string[] {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return ["buttons must be an object."];
  }
  const r = raw as Record<string, unknown>;
  const issues: string[] = [];
  const allowed: Record<string, readonly string[]> = {
    shape: BUTTON_SHAPES,
    primary: BUTTON_PRIMARY_STYLES,
    secondary: BUTTON_SECONDARY_STYLES,
    case: BUTTON_CASES,
    weight: BUTTON_WEIGHTS,
    tracking: BUTTON_TRACKINGS,
    hover: BUTTON_HOVERS,
  };
  for (const [key, value] of Object.entries(r)) {
    const list = allowed[key];
    if (!list) {
      issues.push(`buttons.${key} is not a button setting.`);
    } else if (value !== undefined && !list.includes(String(value))) {
      issues.push(
        `buttons.${key} "${String(value)}" must be one of ${list.join(", ")}.`,
      );
    }
  }
  const t = cleanButtons(r);
  const max = FONT_MAX_WEIGHT[fonts.body.trim()];
  if (max !== undefined && max < 600) {
    const weights = t.weight
      ? [BUTTON_WEIGHT_VALUE[t.weight]]
      : DEFAULT_BUTTON_WEIGHTS;
    if (weights.some((w) => w >= 600)) {
      issues.push(
        t.weight
          ? `Button labels would be set in faked bold: the body face has no weight near ${BUTTON_WEIGHT_VALUE[t.weight]}. Choose a lighter buttons.weight or another face.`
          : `Button labels would be set in faked bold: the body face has no bold weight. Set buttons.weight to regular or medium, or choose another face.`,
      );
    }
  }
  return issues;
}
