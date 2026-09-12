// ---------------------------------------------------------------------------
// The per-store visual skin — palette, type and shape a merchant owns.
//
// ★★ UNTIL NOW THERE WAS NO PER-STORE DESIGN LAYER AT ALL. The storefront's
// palette, fonts and radii came SOLELY from the pinned immutable theme preset
// (app/(storefront)/layout.tsx resolves `design` from `getThemeDefinition`),
// and `StorefrontAppearance` carried only layout VARIANT overrides. The single
// per-store visual control was `--brand-primary` plus the logo. So "make my
// shop look like this" could not change one colour or one typeface — for a
// merchant OR for Mink — and no amount of new agent tooling would have fixed
// that, because the value had nowhere to live.
//
// Pure, so the builder inspector, the storefront renderer and the server action
// agree on what a design IS by importing one file — the rule chrome/types.ts
// already follows. It rides in the SAME store_chrome draft/published payload,
// so there is no new table, no migration, and a design edit inherits the
// draft → publish safety that page sections and chrome already have.
// ---------------------------------------------------------------------------

import type { ThemeDesign, ThemePalette } from "@/lib/themes/types";

/**
 * The palette tokens a store may override.
 *
 * ★ A SUBSET, AND A CURATED ONE. `ThemePalette` has 22 fields, most of them
 * semantic states (success, error, star) that belong to the theme's designer
 * rather than to a shop owner, and exposing all of them makes the panel
 * unreadable and the AI brief unfalsifiable. These eight are the ones that
 * change what a storefront LOOKS like; everything else keeps flowing from the
 * pinned preset.
 */
export const DESIGN_PALETTE_TOKENS = [
  "cream",
  "creamDeep",
  "surface",
  "ink",
  "inkSoft",
  "inkFaint",
  "border",
  "accent",
] as const satisfies readonly (keyof ThemePalette)[];

export type DesignPaletteToken = (typeof DESIGN_PALETTE_TOKENS)[number];

/**
 * Typefaces already loaded by the root layout, keyed to their CSS variables.
 *
 * ★ AN ALLOWLIST, NOT A FREE STRING. The resolved value is written into an
 * inline `style` attribute on `.storefront-root`, so an arbitrary font value
 * is an injection surface — the same reason `SectionStyle.background` is
 * `safeColor`-only. It is also the truth: `app/layout.tsx` loads exactly these
 * with `preload: false`, and naming one it does not load renders the fallback
 * stack with no error to explain why.
 */
export const DESIGN_FONTS = {
  inter: "var(--font-inter)",
  fraunces: "var(--font-fraunces)",
  spaceGrotesk: "var(--font-space-grotesk)",
  jakarta: "var(--font-jakarta)",
  jost: "var(--font-jost)",
  instrumentSerif: "var(--font-instrument-serif)",
  outfit: "var(--font-outfit)",
  roboto: "var(--font-roboto)",
  stickNoBills: "var(--font-stick-no-bills)",
} as const;

export type DesignFont = keyof typeof DESIGN_FONTS;
export const DESIGN_FONT_NAMES = Object.keys(DESIGN_FONTS) as DesignFont[];

/** Corner radii, in px. A slider, not a text box. */
export const DESIGN_SHAPE_KEYS = ["card", "control", "sm", "pill"] as const;
export type DesignShapeKey = (typeof DESIGN_SHAPE_KEYS)[number];
export const DESIGN_RADIUS_MAX = 48;
/** The pill token is legitimately "fully round"; the others are not. */
export const DESIGN_PILL_MAX = 999;

/** `null` on any field means "inherit the pinned theme". */
export interface StorefrontDesignOverrides {
  palette: Partial<Record<DesignPaletteToken, string>>;
  fonts: { body: DesignFont | null; display: DesignFont | null };
  shape: Partial<Record<DesignShapeKey, number>>;
}

export const EMPTY_DESIGN_OVERRIDES: StorefrontDesignOverrides = {
  palette: {},
  fonts: { body: null, display: null },
  shape: {},
};

// ★ HEX ONLY, deliberately narrower than sections' COLOR_RE (which also takes
// rgb()/hsl()). Two reasons, and the second is the important one: a colour
// picker emits hex anyway, and the contrast guard below has to PARSE these —
// accepting `hsl(...)` would mean either writing an hsl parser or silently
// skipping the accessibility check on exactly the values most likely to fail.
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  if (!HEX_RE.test(s)) return null;
  return s.length === 4 ? `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}` : s;
}

function channel(hex: string, at: number): number {
  return parseInt(hex.slice(at, at + 2), 16) / 255;
}

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const parts = [channel(hex, 1), channel(hex, 3), channel(hex, 5)].map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
}

/** WCAG contrast ratio, 1–21. Pure and order-independent. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG AA for normal text. */
export const DESIGN_MIN_CONTRAST = 4.5;

/**
 * Pairs that must stay legible, and the label a merchant will recognise.
 *
 * ★★ THE STOREFRONT HAS NO OTHER DEFENCE. A merchant nudging a colour picker
 * will occasionally land on grey-on-grey, and a MODEL asked to match a
 * screenshot will do it far more often — it optimises for resemblance, not for
 * readability. Checking here is what stops "make it look like that site"
 * shipping a shop whose body text cannot be read.
 */
const CONTRAST_PAIRS: ReadonlyArray<{
  fg: DesignPaletteToken;
  bg: DesignPaletteToken;
  label: string;
}> = [
  { fg: "ink", bg: "cream", label: "body text on the page background" },
  { fg: "ink", bg: "surface", label: "text on cards" },
  { fg: "inkSoft", bg: "cream", label: "muted text on the page background" },
];

export type DesignValidateMode = "draft" | "publish";

export interface DesignValidationResult {
  design: StorefrontDesignOverrides;
  /** Human-readable, one per failing pair. Empty when the design is legible. */
  contrastIssues: string[];
}

/**
 * Clean arbitrary input into overrides, and report contrast problems.
 *
 * ★ SAFETY IS UNCONDITIONAL, LEGIBILITY IS MODE-DEPENDENT — the split
 * `validateSections` already makes. An unparseable colour, an unknown font or
 * an out-of-range radius is DROPPED in both modes, so the value written to an
 * inline style attribute is always one of ours. Contrast is only ENFORCED by
 * the caller at publish: a half-picked palette mid-edit must not fail the
 * builder's autosave, and the merchant can see the problem in the live preview
 * long before they press Publish.
 */
export function validateStorefrontDesign(
  raw: unknown,
  theme: ThemeDesign | null,
  mode: DesignValidateMode = "publish",
): DesignValidationResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawPalette = (r.palette ?? {}) as Record<string, unknown>;
  const rawFonts = (r.fonts ?? {}) as Record<string, unknown>;
  const rawShape = (r.shape ?? {}) as Record<string, unknown>;

  const palette: Partial<Record<DesignPaletteToken, string>> = {};
  for (const token of DESIGN_PALETTE_TOKENS) {
    const hex = normalizeHex(rawPalette[token]);
    if (hex) palette[token] = hex;
  }

  const font = (value: unknown): DesignFont | null =>
    typeof value === "string" && value in DESIGN_FONTS
      ? (value as DesignFont)
      : null;

  const shape: Partial<Record<DesignShapeKey, number>> = {};
  for (const key of DESIGN_SHAPE_KEYS) {
    const n = Number(rawShape[key]);
    const max = key === "pill" ? DESIGN_PILL_MAX : DESIGN_RADIUS_MAX;
    if (Number.isInteger(n) && n >= 0 && n <= max) shape[key] = n;
  }

  const design: StorefrontDesignOverrides = {
    palette,
    fonts: { body: font(rawFonts.body), display: font(rawFonts.display) },
    shape,
  };

  return {
    design,
    contrastIssues: mode === "publish" ? contrastIssuesFor(design, theme) : [],
  };
}

/**
 * Which required pairs are illegible once these overrides are applied.
 *
 * ★ IT CHECKS THE RESOLVED PAIR, NOT ONLY THE OVERRIDDEN ONE. Changing the
 * page background alone can break text the merchant never touched, so each
 * pair is evaluated against what the storefront will actually render — theme
 * value included. A pair whose theme side is not plain hex is skipped rather
 * than guessed at: an unparseable value must not read as a failure.
 */
export function contrastIssuesFor(
  design: StorefrontDesignOverrides,
  // Structural, not `ThemeDesign`, so the builder panel can pass its own
  // lightweight defaults projection without a cast — the only thing this needs
  // is somewhere to look up a token's fallback colour.
  theme: { palette?: Partial<Record<DesignPaletteToken, string>> } | null,
): string[] {
  const resolve = (token: DesignPaletteToken): string | null =>
    normalizeHex(design.palette[token] ?? theme?.palette?.[token]);

  const issues: string[] = [];
  for (const pair of CONTRAST_PAIRS) {
    const fg = resolve(pair.fg);
    const bg = resolve(pair.bg);
    if (!fg || !bg) continue;
    const ratio = contrastRatio(fg, bg);
    if (ratio < DESIGN_MIN_CONTRAST) {
      issues.push(
        `${pair.label} is hard to read (contrast ${ratio.toFixed(1)}:1, needs ${DESIGN_MIN_CONTRAST}:1).`,
      );
    }
  }
  return issues;
}

/**
 * The CSS custom properties these overrides contribute, on top of whatever
 * `designToCssVars` already produced for the pinned theme.
 *
 * ★ IT RETURNS ONLY WHAT WAS OVERRIDDEN. Emitting the full token map would
 * mean a store with no overrides writing a complete palette inline and
 * silently pinning itself to today's theme values — so a preset upgrade, or a
 * theme change, would stop reaching it. Absent means inherit, at every layer.
 */
export function designOverrideCssVars(
  design: StorefrontDesignOverrides,
): Record<string, string> {
  const vars: Record<string, string> = {};
  const token: Record<DesignPaletteToken, string> = {
    cream: "--sm-cream",
    creamDeep: "--sm-cream-deep",
    surface: "--sm-surface",
    ink: "--sm-ink",
    inkSoft: "--sm-ink-soft",
    inkFaint: "--sm-ink-faint",
    border: "--sm-border",
    accent: "--brand-primary",
  };
  for (const key of DESIGN_PALETTE_TOKENS) {
    const value = design.palette[key];
    if (value) vars[token[key]] = value;
  }
  // ★★ THE BODY FACE OCCUPIES *TWO* SLOTS. `designToCssVars` points BOTH
  // --font-outfit and --font-roboto at `fonts.body`, because the storefront's
  // font call-sites are split across those two legacy variables. Overriding
  // only one leaves every --font-roboto element on the theme's face — a
  // storefront rendered in two typefaces, which is exactly the defect §11
  // records for Vitrine and is invisible unless you count elements.
  if (design.fonts.body) {
    const face = DESIGN_FONTS[design.fonts.body];
    vars["--font-outfit"] = face;
    vars["--font-roboto"] = face;
  }
  if (design.fonts.display)
    vars["--font-stick-no-bills"] = DESIGN_FONTS[design.fonts.display];

  const shape: Record<DesignShapeKey, string> = {
    card: "--sm-radius-card",
    control: "--sm-radius-control",
    sm: "--sm-radius-sm",
    pill: "--sm-radius-pill",
  };
  for (const key of DESIGN_SHAPE_KEYS) {
    const value = design.shape[key];
    if (value !== undefined) vars[shape[key]] = `${value}px`;
  }
  return vars;
}

/** Has the merchant overridden anything at all? */
export function hasDesignOverrides(design: StorefrontDesignOverrides): boolean {
  return (
    Object.keys(design.palette).length > 0 ||
    design.fonts.body !== null ||
    design.fonts.display !== null ||
    Object.keys(design.shape).length > 0
  );
}

/**
 * What the pinned theme supplies for the tokens a merchant may override.
 *
 * ★ A PROJECTION, NOT THE WHOLE ThemeDesign. The builder panel is a client
 * component, so this crosses the server boundary on every load; sending the
 * full preset would ship 22 palette entries, layout variants and shape strings
 * to render eight swatches. It is also what the panel needs to be HONEST — an
 * un-overridden colour has to show the value the storefront will actually use,
 * not an empty box.
 */
export interface ThemeDesignDefaults {
  palette: Partial<Record<DesignPaletteToken, string>>;
  fonts: { body: string | null; display: string | null };
  shape: Partial<Record<DesignShapeKey, number>>;
}

/** Radii are authored as CSS lengths ("20px"); the panel edits numbers. */
function pxNumber(value: unknown): number | undefined {
  const match = /^(\d+)px$/.exec(String(value ?? "").trim());
  return match ? Number(match[1]) : undefined;
}

export function themeDesignDefaults(
  theme: ThemeDesign | null,
): ThemeDesignDefaults {
  const palette: Partial<Record<DesignPaletteToken, string>> = {};
  for (const token of DESIGN_PALETTE_TOKENS) {
    const hex = normalizeHex(theme?.palette?.[token]);
    if (hex) palette[token] = hex;
  }
  const shape: Partial<Record<DesignShapeKey, number>> = {};
  for (const key of DESIGN_SHAPE_KEYS) {
    const n = pxNumber(theme?.shape?.[key]);
    if (n !== undefined) shape[key] = n;
  }
  return {
    palette,
    fonts: {
      body: theme?.fonts?.body ?? null,
      display: theme?.fonts?.display ?? null,
    },
    shape,
  };
}
