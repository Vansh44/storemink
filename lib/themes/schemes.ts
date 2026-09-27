// ---------------------------------------------------------------------------
// Per-section colour schemes (theme parity Track 2.1).
//
// A scheme is a named set of colours a section can wear: its background, its
// text, the cards inside it and its buttons. Picking "Dark" for a section
// turns the whole block dark at once, text and buttons included. A raw
// background colour could not do that: text stayed dark on a dark band unless
// somebody also found the section's own text setting.
//
// ★ A FIXED VOCABULARY OF FOUR, like Shopify's "scheme 1…5". `soft` is a quiet
//   neutral band, `tint` a light wash of the brand colour, `accent` the brand
//   colour itself, `inverse` a dark band. No scheme = the page's own colours,
//   exactly as before — every section stored without one renders unchanged.
// ★ A THEME MAY DECLARE ANY OF THEM (`ThemeDesign.schemes`). One it does not
//   declare is DERIVED from the palette in CSS (storefront-theme.css), as
//   var() references on `.storefront-root`, so a merchant's own palette
//   overrides reach the derived schemes live. A declared scheme is concrete
//   hex, emitted inline by `designToCssVars`, and beats the CSS default.
// ★ THE SECTION ONLY GETS A CLASS (`sm-scheme sm-scheme-<id>`, SectionShell).
//   homepage.css re-points the page tokens (--sm-cream, --sm-ink, --sm-accent,
//   …) inside it, so every section's existing CSS follows with no per-section
//   wiring. `resolveScheme` below mirrors that CSS exactly, so contrast can be
//   checked on the colours the shopper will actually see.
// ---------------------------------------------------------------------------

import type { ThemeDesign, ThemePalette } from "./types";

export const SECTION_SCHEMES = ["soft", "tint", "accent", "inverse"] as const;
export type SectionScheme = (typeof SECTION_SCHEMES)[number];

export function isSectionScheme(value: unknown): value is SectionScheme {
  return (SECTION_SCHEMES as readonly unknown[]).includes(value);
}

/** Merchant-facing names, in the builder's own words. */
export const SECTION_SCHEME_META: Record<
  SectionScheme,
  { label: string; description: string }
> = {
  soft: { label: "Soft", description: "A quiet neutral band" },
  tint: { label: "Tinted", description: "A light wash of your brand colour" },
  accent: { label: "Brand", description: "Your brand colour, bold" },
  inverse: { label: "Dark", description: "A dark band with light text" },
};

/**
 * Sections a scheme does not apply to. A carousel and a promo banner are
 * covered edge to edge by their own photo, so a scheme would only change
 * their copy's colour behind the merchant's back; custom code runs in a
 * sandboxed frame that cannot see the storefront's tokens at all.
 */
export const SCHEMELESS_SECTION_TYPES: readonly string[] = [
  "hero_carousel",
  "promo_banner",
  "custom_code",
];

/** A scheme a theme declares. Colours are 6-digit hex. */
export interface ThemeColorScheme {
  background: string;
  text: string;
  /** Cards inside the band. Absent = derived (see `declaredSurface`). */
  surface?: string;
  /** Buttons inside the band. Absent = the theme accent when it reads on
   *  this background, otherwise the band's text colour. */
  accent?: string;
  onAccent?: string;
}

export type ThemeColorSchemes = Partial<
  Record<SectionScheme, ThemeColorScheme>
>;

/** The palette colours a scheme is derived from. */
export type SchemePalette = Pick<
  ThemePalette,
  "cream" | "creamDeep" | "surface" | "ink" | "onInk" | "onAccent" | "accent"
>;

/** What the schemes derive from on a store with no theme: the globals.css
 *  `:root` defaults, which ARE the un-themed storefront's colours. */
export const FALLBACK_SCHEME_PALETTE: SchemePalette = {
  cream: "#fdfcfb",
  creamDeep: "#f4f2ee",
  surface: "#ffffff",
  ink: "#17130f",
  onInk: "#ffffff",
  onAccent: "#ffffff",
};

export interface SchemeDesign {
  palette: SchemePalette;
  schemes?: ThemeColorSchemes;
}

/** The colours a scheme resolves to, all concrete hex. */
export interface ResolvedScheme {
  background: string;
  text: string;
  textSoft: string;
  surface: string;
  border: string;
  accent: string;
  onAccent: string;
}

// The mix weights homepage.css uses. Changing one without the other makes the
// contrast check judge colours nobody sees; schemes.test.ts reads the CSS.
export const SCHEME_MIX = {
  textSoft: 76,
  textFaint: 56,
  border: 16,
  deep: 6,
  tint: 12,
} as const;

const HEX = /^#[0-9a-f]{6}$/i;

export function isHex(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** `color-mix(in srgb, a <weight>%, b)`: straight interpolation of the
 *  gamma-encoded channels, which is what the browser does in srgb. */
export function mixHex(a: string, b: string, weight: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  const w = weight / 100;
  return (
    "#" +
    x
      .map((c, i) =>
        Math.round(c * w + y[i] * (1 - w))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1–21. */
export function schemeContrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

/** Buttons are UI, not body text: WCAG's 3:1 for components. */
const BUTTON_CONTRAST = 3;
/** Body text: WCAG AA. */
const TEXT_CONTRAST = 4.5;

/** Cards on a declared band: a lighter lift of a light band, a faint lift
 *  of a dark one. A darker card on a light band reads as a hole. */
function declaredSurface(scheme: ThemeColorScheme): string {
  return luminance(scheme.background) > 0.4
    ? mixHex("#ffffff", scheme.background, 60)
    : mixHex(scheme.text, scheme.background, 8);
}

/** Button colours on a declared band. */
function declaredButtons(
  scheme: ThemeColorScheme,
  themeAccent: string,
  themeOnAccent: string,
): { accent: string; onAccent: string } {
  if (isHex(scheme.accent) && isHex(scheme.onAccent)) {
    return { accent: scheme.accent, onAccent: scheme.onAccent };
  }
  // The theme's own button still works on this band: keep it.
  if (schemeContrast(themeAccent, scheme.background) >= BUTTON_CONTRAST) {
    return { accent: themeAccent, onAccent: themeOnAccent };
  }
  // Otherwise invert against the band — always readable, by construction.
  return { accent: scheme.text, onAccent: scheme.background };
}

/**
 * Text for a Brand band. A theme's on-accent colour only has to read on a
 * BUTTON (3:1); a band carries body copy, which needs 4.5:1 — white on a
 * mid-tone green passes the first and fails the second. So the band takes
 * the first of the theme's own text colours that reads on it.
 * ★ When none does (a mid-tone orange defeats every one), black or white:
 *   on ANY colour one of the two reaches at least 4.58:1, so a Brand band's
 *   body text is always readable. Muted copy on a mid-tone may still fall
 *   short, and the builder says so.
 */
function brandBandText(accent: string, palette: SchemePalette): string {
  const candidates = [palette.onAccent, palette.onInk, palette.ink].filter(
    isHex,
  );
  const readable = candidates.find(
    (c) => schemeContrast(c, accent) >= TEXT_CONTRAST,
  );
  if (readable) return readable;
  return schemeContrast("#000000", accent) >= schemeContrast("#ffffff", accent)
    ? "#000000"
    : "#ffffff";
}

/**
 * The four colours a scheme is built from — background, text, cards and
 * buttons — declared or derived. Mirrors the `--sm-scheme-<id>-*` defaults in
 * storefront-theme.css.
 */
function schemeBase(
  id: SectionScheme,
  palette: SchemePalette,
  brandPrimary: string,
  declared: ThemeColorScheme | undefined,
): Omit<ResolvedScheme, "textSoft" | "border"> {
  const accent = palette.accent ?? brandPrimary;
  if (declared && isHex(declared.background) && isHex(declared.text)) {
    return {
      background: declared.background,
      text: declared.text,
      surface: isHex(declared.surface)
        ? declared.surface
        : declaredSurface(declared),
      ...declaredButtons(declared, accent, palette.onAccent),
    };
  }
  switch (id) {
    case "soft":
      return {
        background: palette.creamDeep,
        text: palette.ink,
        surface: palette.surface,
        accent,
        onAccent: palette.onAccent,
      };
    case "tint":
      return {
        background: mixHex(accent, palette.cream, SCHEME_MIX.tint),
        text: palette.ink,
        surface: palette.surface,
        accent,
        onAccent: palette.onAccent,
      };
    case "accent": {
      const text = brandBandText(accent, palette);
      return {
        background: accent,
        text,
        surface: mixHex(text, accent, 10),
        accent: text,
        onAccent: accent,
      };
    }
    case "inverse":
      return {
        background: palette.ink,
        text: palette.onInk,
        surface: mixHex(palette.onInk, palette.ink, 8),
        accent: palette.onInk,
        onAccent: palette.ink,
      };
  }
}

export function resolveScheme(
  id: SectionScheme,
  design: SchemeDesign,
  brandPrimary: string,
): ResolvedScheme {
  const base = schemeBase(
    id,
    design.palette,
    brandPrimary,
    design.schemes?.[id],
  );
  return {
    ...base,
    textSoft: mixHex(base.text, base.background, SCHEME_MIX.textSoft),
    border: mixHex(base.text, base.background, SCHEME_MIX.border),
  };
}

/**
 * The inline variables for the schemes a theme DECLARES. Derived schemes are
 * left to the CSS defaults, so a merchant's palette override still reaches
 * them. Values are validated hex only — they land in an inline style.
 */
export function schemeCssVars(
  design: SchemeDesign,
  brandPrimary: string,
): Record<string, string> {
  const vars: Record<string, string> = {};
  // A derived Brand band whose text had to change from on-accent (see
  // brandBandText) cannot be expressed in CSS, which has no contrast pick at
  // this browser floor. Its background still follows --sm-accent in CSS; the
  // text colours that go with it are written here.
  const declaredAccent = design.schemes?.accent;
  if (!declaredAccent) {
    const s = resolveScheme("accent", design, brandPrimary);
    if (s.text !== design.palette.onAccent) {
      vars["--sm-scheme-accent-fg"] = s.text;
      vars["--sm-scheme-accent-surface"] = s.surface;
      vars["--sm-scheme-accent-accent"] = s.accent;
    }
  }
  for (const id of SECTION_SCHEMES) {
    const declared = design.schemes?.[id];
    if (!declared || !isHex(declared.background) || !isHex(declared.text)) {
      continue;
    }
    const s = resolveScheme(id, design, brandPrimary);
    vars[`--sm-scheme-${id}-bg`] = s.background;
    vars[`--sm-scheme-${id}-fg`] = s.text;
    vars[`--sm-scheme-${id}-surface`] = s.surface;
    vars[`--sm-scheme-${id}-accent`] = s.accent;
    vars[`--sm-scheme-${id}-on-accent`] = s.onAccent;
  }
  return vars;
}

export interface SchemeContrastIssue {
  scheme: SectionScheme;
  message: string;
}

/** The pairs a band must keep legible. */
export function schemeContrastIssues(
  id: SectionScheme,
  scheme: ResolvedScheme,
): SchemeContrastIssue[] {
  const label = SECTION_SCHEME_META[id].label;
  const pairs: Array<[string, string, number, string]> = [
    [scheme.text, scheme.background, TEXT_CONTRAST, "Text"],
    [scheme.textSoft, scheme.background, TEXT_CONTRAST, "Muted text"],
    [scheme.text, scheme.surface, TEXT_CONTRAST, "Text on cards"],
    [scheme.onAccent, scheme.accent, BUTTON_CONTRAST, "Button labels"],
  ];
  const out: SchemeContrastIssue[] = [];
  for (const [fg, bg, minimum, what] of pairs) {
    const ratio = schemeContrast(fg, bg);
    if (ratio < minimum) {
      out.push({
        scheme: id,
        message: `${what} in the ${label} scheme is hard to read (${ratio.toFixed(2)}:1, needs ${minimum}:1).`,
      });
    }
  }
  return out;
}

/** Schemes used by any section of the given pages. */
export function schemesUsed(
  pages: ReadonlyArray<{
    sections: ReadonlyArray<{ style?: { scheme?: string } }>;
  }>,
): Set<SectionScheme> {
  const used = new Set<SectionScheme>();
  for (const page of pages) {
    for (const section of page.sections) {
      const scheme = section.style?.scheme;
      if (isSectionScheme(scheme)) used.add(scheme);
    }
  }
  return used;
}

/** The swatches the builder shows, one per scheme. */
export interface SchemePreview {
  background: string;
  text: string;
  accent: string;
  onAccent: string;
  /** Legible on every pair a section needs. */
  readable: boolean;
}

export function schemePreviews(
  design: SchemeDesign,
  brandPrimary: string,
): Record<SectionScheme, SchemePreview> {
  return Object.fromEntries(
    SECTION_SCHEMES.map((id) => {
      const s = resolveScheme(id, design, brandPrimary);
      return [
        id,
        {
          background: s.background,
          text: s.text,
          accent: s.accent,
          onAccent: s.onAccent,
          readable: schemeContrastIssues(id, s).length === 0,
        },
      ];
    }),
  ) as Record<SectionScheme, SchemePreview>;
}

/** The part of a theme the builder needs to preview schemes: small enough to
 *  cross to the client, with the un-themed defaults when there is no theme. */
export function schemeDesignFor(
  design: Pick<ThemeDesign, "palette" | "schemes"> | null,
): SchemeDesign {
  if (!design) return { palette: FALLBACK_SCHEME_PALETTE };
  const p = design.palette;
  return {
    palette: {
      cream: p.cream,
      creamDeep: p.creamDeep,
      surface: p.surface,
      ink: p.ink,
      onInk: p.onInk,
      onAccent: p.onAccent,
      ...(p.accent ? { accent: p.accent } : {}),
    },
    ...(design.schemes ? { schemes: design.schemes } : {}),
  };
}

/** A merchant's own palette overrides (the builder's Brand panel) on top, so
 *  a derived scheme's swatch shows what the storefront will paint. */
export function withPaletteOverrides(
  design: SchemeDesign,
  overrides: Partial<Record<string, string | undefined>>,
): SchemeDesign {
  const palette = { ...design.palette };
  for (const key of [
    "cream",
    "creamDeep",
    "surface",
    "ink",
    "accent",
  ] as const) {
    const value = overrides[key];
    if (isHex(value)) palette[key] = value;
  }
  return { ...design, palette };
}
