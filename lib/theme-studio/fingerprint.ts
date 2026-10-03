import type { ThemeDefinition } from "@/lib/themes/types";
import {
  DESIGN_DIRECTION_IDS,
  type DesignDirection,
  type PaletteFamily,
} from "./design-directions";

export interface ThemeFingerprint {
  composition: string;
  card: string;
  hero: string;
  sections: string[];
  sectionStyles: string[];
  pageColour: string;
  accentHue: string;
  bodyFont: string;
  displayFont: string;
  buttons: string;
  width: string;
  grid: string;
  shape: string;
  heading: string;
  motion: string;
  category: string;
  newsletter: string;
}
export interface ExistingThemeFingerprint {
  themeId: string;
  direction: DesignDirection | null;
  fingerprint: ThemeFingerprint;
}
/** Expand compound fingerprint fields for transparent catalogue frequency
 * hints and the evaluation's individual-setting convergence checks. */
export function fingerprintChoiceValues(
  fingerprint: ThemeFingerprint,
): Record<string, string> {
  const [mobile, desktop, filters, sticky, hover, banner, gap] =
    fingerprint.grid.split("/");
  const [buttonShape, primary, secondary] = fingerprint.buttons.split("/");
  const [categoryDisplay, categoryLayout] = fingerprint.category
    .split("|")[0]
    .split("/");
  return {
    card: fingerprint.card,
    gridColumnsMobile: mobile,
    gridColumnsDesktop: desktop,
    shopFilters: filters,
    stickyAddToCart: sticky,
    cardHoverImage: hover,
    collectionBanner: banner,
    gridGap: gap,
    categoryDisplay,
    categoryLayout: categoryLayout ?? "none",
    primaryButton: primary,
    secondaryButton: secondary,
    buttonShape,
    pageWidth: fingerprint.width,
    pageColour: fingerprint.pageColour,
    motion: fingerprint.motion,
    bodyFont: fingerprint.bodyFont,
    displayFont: fingerprint.displayFont,
    hero: fingerprint.hero,
    newsletter: fingerprint.newsletter,
  };
}
export const DISTINCTNESS_THRESHOLD = 0.35;
/** Major axes counted by `changedAxes`: composition, card, hero, page colour,
 * buttons, typography and homepage structure. */
export const MAJOR_AXES = 7;
/** Section-sequence edit distance at which homepage structure counts as a
 * changed major axis. */
const STRUCTURE_CHANGE = 0.5;
const WEIGHTS: Record<keyof ThemeFingerprint, number> = {
  composition: 10,
  card: 10,
  hero: 10,
  sections: 12,
  sectionStyles: 6,
  pageColour: 12,
  accentHue: 4,
  bodyFont: 5,
  displayFont: 8,
  buttons: 5,
  width: 4,
  grid: 4,
  shape: 3,
  heading: 4,
  motion: 1,
  category: 3,
  newsletter: 3,
};
export function colourBand(hex: string): string {
  if (/^#[0-9a-f]{3}$/i.test(hex))
    hex = `#${hex
      .slice(1)
      .split("")
      .map((c) => c + c)
      .join("")}`;
  const values = /^#[0-9a-f]{6}$/i.test(hex)
    ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    : [1, 1, 1];
  const [r, g, b] = values;
  const max = Math.max(...values),
    min = Math.min(...values),
    delta = max - min;
  const luma = values
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  if (delta < 0.12 && luma > 0.8) return "near-white";
  if (delta < 0.08)
    return luma < 0.08
      ? "near-black"
      : luma < 0.4
        ? "neutral-mid"
        : "neutral-light";
  const hue =
    delta === 0
      ? 0
      : max === r
        ? ((g - b) / delta + 6) % 6
        : max === g
          ? (b - r) / delta + 2
          : (r - g) / delta + 4;
  return `${luma < 0.12 ? "dark" : luma > 0.65 ? "tinted" : "colour"}:${Math.floor(hue)}`;
}
export function paletteFamilyIssues(
  family: PaletteFamily | undefined,
  page: string,
): string[] {
  const pageBand = colourBand(page);
  if (family === "dark" && !/^(near-black|dark:)/.test(pageBand))
    return [
      "The dark palette family needs a dark page background (cream), not only dark accents.",
    ];
  if (family === "colour-field" && !/^(colour:|tinted:|dark:)/.test(pageBand))
    return [
      "The colour-field palette family needs a visibly coloured page background (cream), not only a coloured accent on a neutral page.",
    ];
  if (family === "tinted-neutral" && pageBand === "near-white")
    return [
      "The tinted-neutral palette family needs a visible sage, clay, mineral or neutral page background (cream); a barely tinted white belongs to the light family.",
    ];
  return [];
}
export function themeFingerprint(theme: ThemeDefinition): ThemeFingerprint {
  const design = theme.preset.design;
  const layout = design.layout ?? {};
  const grocery = layout.storefront === "grocery";
  const home = (theme.preset.pages.find((p) => !p.slug)?.sections ?? []).slice(
    0,
    30,
  );
  const configs = (type: string) =>
    home
      .filter((s) => s.type === type)
      .map((s) => s.config as unknown as Record<string, unknown>);
  const radius = parseFloat(design.shape.card);
  const radiusBucket = radius < 2 ? "square" : radius < 12 ? "soft" : "round";
  const hero = home.find(
    (s) => s.type === "hero" || s.type === "hero_carousel",
  );
  const heroConfig = hero?.config as unknown as
    | Record<string, unknown>
    | undefined;
  return {
    composition: `${layout.header ?? "classic"}/${layout.productDetail ?? (grocery ? "grocery" : "classic")}/${layout.cart ?? (grocery ? "grocery" : "classic")}/${layout.footer ?? "rich"}/${grocery ? "grocery" : "classic"}`,
    card: grocery ? "grocery" : (layout.card ?? "classic"),
    hero: `${hero?.type ?? "none"}:${heroConfig?.variant ?? (hero?.type === "hero" ? "banner" : "")}:${heroConfig?.height ?? "auto"}`,
    sections: home.map((s) => s.type),
    sectionStyles: home.map(
      (s) =>
        `${s.type}:${s.style?.scheme ?? "page"}:${s.style?.padding_y ?? "md"}:${s.style?.width ?? "contained"}`,
    ),
    pageColour: colourBand(design.palette.cream),
    accentHue: colourBand(design.palette.accent ?? design.palette.ink),
    bodyFont: design.fonts.body,
    displayFont: design.fonts.display,
    buttons: `${design.buttons?.shape ?? "rounded"}/${design.buttons?.primary ?? "solid"}/${design.buttons?.secondary ?? "outline"}`,
    width: design.page?.width ?? "standard",
    grid: `${layout.gridColumnsMobile ?? 1}/${layout.gridColumnsDesktop ?? 4}/${!!layout.shopFilters}/${!!layout.stickyAddToCart}/${!!layout.cardHoverImage}/${!!layout.collectionBanner}/${design.page?.gridGap ?? "standard"}`,
    shape: radiusBucket,
    heading: `${design.typography?.headingFont ?? "body"}/${design.typography?.headingScale ?? "medium"}/${design.typography?.headingCase ?? "none"}/${design.typography?.headingTracking ?? "normal"}`,
    motion: design.motion?.reveal ?? "none",
    category:
      configs("shop_by_category")
        .map((c) => `${c.display ?? "circles"}/${c.layout ?? "scroll"}`)
        .join("|")
        .slice(0, 160) || "none",
    newsletter:
      configs("newsletter")
        .map((c) => `${c.theme ?? "dark"}/${c.alignment ?? "center"}`)
        .join("|")
        .slice(0, 160) || "none",
  };
}
function sequenceDistance(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++)
      next.push(
        Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)),
      );
    row = next;
  }
  return row[b.length] / Math.max(a.length, b.length);
}
export function fingerprintDistance(
  a: ThemeFingerprint,
  b: ThemeFingerprint,
): number {
  const total = Object.values(WEIGHTS).reduce((s, w) => s + w, 0);
  return (
    Object.entries(WEIGHTS).reduce((sum, [key, w]) => {
      const k = key as keyof ThemeFingerprint;
      return (
        sum +
        w *
          (Array.isArray(a[k])
            ? sequenceDistance(a[k] as string[], b[k] as string[])
            : a[k] === b[k]
              ? 0
              : 1)
      );
    }, 0) / total
  );
}
export interface DistinctnessReport {
  version: 1;
  score: number | null;
  threshold: number;
  nearestThemeId: string | null;
  sharedAttributes: (keyof ThemeFingerprint)[];
  changedAxes: number;
  status: "distinct" | "similar" | "reference-led" | "not-compared";
  repairAttempted: boolean;
  beforeScore?: number | null;
}
export function measureDistinctness(
  theme: ThemeDefinition,
  existing: readonly ExistingThemeFingerprint[],
  referenceLed = false,
): DistinctnessReport {
  const current = themeFingerprint(theme);
  const nearest = existing
    .map((t) => ({ ...t, score: fingerprintDistance(current, t.fingerprint) }))
    .sort((a, b) => a.score - b.score || a.themeId.localeCompare(b.themeId))[0];
  const changedAxes = nearest
    ? ["composition", "card", "hero", "pageColour", "buttons"].filter(
        (k) =>
          current[k as keyof ThemeFingerprint] !==
          nearest.fingerprint[k as keyof ThemeFingerprint],
      ).length +
      (current.bodyFont !== nearest.fingerprint.bodyFont ||
      current.displayFont !== nearest.fingerprint.displayFont
        ? 1
        : 0) +
      // Homepage structure is the heaviest-weighted axis; a substantially
      // different section sequence is a major change, not a minor one.
      (sequenceDistance(current.sections, nearest.fingerprint.sections) >=
      STRUCTURE_CHANGE
        ? 1
        : 0)
    : 0;
  return {
    version: 1,
    score: nearest ? Math.round(nearest.score * 1000) / 1000 : null,
    threshold: DISTINCTNESS_THRESHOLD,
    nearestThemeId: nearest?.themeId ?? null,
    sharedAttributes: nearest
      ? (Object.keys(WEIGHTS) as (keyof ThemeFingerprint)[]).filter(
          (k) =>
            JSON.stringify(current[k]) ===
            JSON.stringify(nearest.fingerprint[k]),
        )
      : [],
    changedAxes,
    status: referenceLed
      ? "reference-led"
      : !nearest
        ? "not-compared"
        : nearest.score < DISTINCTNESS_THRESHOLD || changedAxes < 3
          ? "similar"
          : "distinct",
    repairAttempted: false,
  };
}

export function readDistinctnessReport(
  value: unknown,
): DistinctnessReport | null {
  const r = value as DistinctnessReport | null;
  return r &&
    r.version === 1 &&
    (r.score === null ||
      (typeof r.score === "number" && r.score >= 0 && r.score <= 1)) &&
    typeof r.threshold === "number" &&
    r.threshold > 0 &&
    r.threshold <= 1 &&
    (r.nearestThemeId === null ||
      (typeof r.nearestThemeId === "string" &&
        r.nearestThemeId.length <= 80)) &&
    Number.isInteger(r.changedAxes) &&
    r.changedAxes >= 0 &&
    r.changedAxes <= MAJOR_AXES &&
    ["distinct", "similar", "reference-led", "not-compared"].includes(
      r.status,
    ) &&
    typeof r.repairAttempted === "boolean" &&
    Array.isArray(r.sharedAttributes) &&
    r.sharedAttributes.length <= Object.keys(WEIGHTS).length &&
    r.sharedAttributes.every((k) => Object.hasOwn(WEIGHTS, k)) &&
    (r.beforeScore === undefined ||
      r.beforeScore === null ||
      (typeof r.beforeScore === "number" &&
        r.beforeScore >= 0 &&
        r.beforeScore <= 1))
    ? {
        version: 1,
        score: r.score,
        threshold: r.threshold,
        nearestThemeId: r.nearestThemeId,
        changedAxes: r.changedAxes,
        status: r.status,
        repairAttempted: r.repairAttempted,
        sharedAttributes: [...r.sharedAttributes],
        ...(r.beforeScore !== undefined ? { beforeScore: r.beforeScore } : {}),
      }
    : null;
}

export function readVarietyContext(
  value: unknown,
): ExistingThemeFingerprint[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const keys = Object.keys(WEIGHTS) as (keyof ThemeFingerprint)[];
  const text = (v: unknown) => typeof v === "string" && v.length <= 160;
  if (
    !value.every(
      (t) =>
        t &&
        typeof t === "object" &&
        typeof t.themeId === "string" &&
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t.themeId) &&
        t.themeId.length <= 80 &&
        (t.direction === null || DESIGN_DIRECTION_IDS.includes(t.direction)) &&
        t.fingerprint &&
        keys.every((k) =>
          k === "sections" || k === "sectionStyles"
            ? Array.isArray(t.fingerprint[k]) &&
              t.fingerprint[k].length <= 30 &&
              t.fingerprint[k].every(text)
            : text(t.fingerprint[k]),
        ),
    )
  )
    return null;
  // Whitelist every field: database metadata can never carry copy or prompts.
  return value.map((t) => ({
    themeId: t.themeId,
    direction: t.direction,
    fingerprint: Object.fromEntries(
      keys.map((k) => [k, t.fingerprint[k]]),
    ) as unknown as ThemeFingerprint,
  }));
}
