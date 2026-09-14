import "server-only";

import {
  DESIGN_FONTS,
  DESIGN_PALETTE_TOKENS,
  DESIGN_PILL_MAX,
  DESIGN_RADIUS_MAX,
  DESIGN_MIN_CONTRAST,
  DESIGN_SHAPE_KEYS,
  contrastIssuesFor,
  themeDesignDefaults,
  validateStorefrontDesign,
  type DesignFont,
  type DesignPaletteToken,
  type DesignShapeKey,
  type StorefrontDesignOverrides,
} from "@/lib/chrome/design";
import type { ThemeDesign } from "@/lib/themes/types";
import { digestMinkStorefrontValue } from "./storefront-code-contract";
import type { MinkStorefrontDesignSummary } from "./types";

// ---------------------------------------------------------------------------
// Phase 9C - proposing a store's DESIGN: palette, typefaces and corner radii.
//
// WHY IT IS A THIRD CONTRACT. 7B replaces the code inside one section, 9B
// replaces one page's section list, and neither can change what the whole
// storefront LOOKS like -- a merchant saying "I like this site, make mine like
// it" is talking about colour and type before anything else. Phase 9A gave
// that a home (`lib/chrome/design.ts`): eight curated palette tokens, an
// allowlisted typeface pair and four radii, riding in the same `store_chrome`
// draft/published payload. This is the agent's typed route into it.
//
// THE WHOLE OVERRIDE SET IS REPLACED, like 9B's section list -- but the
// consequence is the opposite and worth stating, because the same shape reads
// as dangerous here by analogy. Omitting a token means INHERIT THE PINNED
// THEME, which is a designed, reversible state the storefront renders
// correctly; omitting a section means deleting it. So a design proposal has no
// destructive omission to guard, and "reset this back to the theme" is
// expressible simply by leaving a token out.
// ---------------------------------------------------------------------------

export const MINK_STOREFRONT_DESIGN_SCHEMA_VERSION = 1 as const;

export interface MinkStorefrontDesignPatch {
  schemaVersion: typeof MINK_STOREFRONT_DESIGN_SCHEMA_VERSION;
  operation: "replace_design_overrides";
  target: {
    /**
     * Digest of the store's CURRENT design overrides.
     *
     * ★★ THE LOCK IS THE DESIGN, NOT THE CHROME ROW, and that is a deliberate
     * departure from 9B (which locks the page's `updated_at`). `store_chrome`
     * carries the header, footer, appearance variants AND the design in one
     * row, and the builder inspector autosaves the whole thing on a keystroke.
     * The chat panel floats ABOVE the builder canvas by design
     * (`dashboard.css`, §11), so the ordinary way to review a design proposal
     * is with the builder open -- and locking the row would let an unrelated
     * footer edit kill an approval every time. Locking what is actually being
     * replaced keeps the guarantee ("nothing I am overwriting moved") without
     * inventing a conflict out of a different field.
     */
    expectedDesignDigest: string;
  };
  /** The COMPLETE override set. An absent token inherits the pinned theme. */
  design: StorefrontDesignOverrides;
}

const ROOT_KEYS = ["schemaVersion", "operation", "target", "design"] as const;
const TARGET_KEYS = ["expectedDesignDigest"] as const;
const DESIGN_KEYS = ["palette", "fonts", "shape"] as const;
const FONT_SLOTS = ["body", "display"] as const;
const SHA256_RE = /^[a-f0-9]{64}$/;

export type ValidatedMinkStorefrontDesignPatch =
  | { ok: true; value: MinkStorefrontDesignPatch }
  | { ok: false; issues: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  issues: string[],
): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    issues.push(`${label} has unsupported fields: ${extra.join(", ")}.`);
  }
}

/**
 * Validate one proposed design against the store's pinned theme.
 *
 * ★★ IT REFUSES WHAT `validateStorefrontDesign` WOULD SILENTLY DROP, and that
 * is the whole reason this wrapper exists. That validator discards an
 * unparseable colour, an unknown typeface or an out-of-range radius and
 * returns the rest -- exactly right for a colour picker, which cannot emit
 * junk, and dishonest for a model, which can. Dropped silently, "set the
 * accent to brand red" becomes a proposal that does not mention the accent at
 * all: the merchant approves it, nothing changes, and no error was ever
 * raised. Naming the field back is also what lets the model correct itself
 * inside the same run.
 *
 * ★★ CONTRAST IS ENFORCED HERE THOUGH 9A MAKES IT A PUBLISH GATE, and the
 * difference is the actor, not the rule. The panel cannot refuse a merchant
 * mid-edit -- a half-picked palette must not fail autosave, and they can see
 * the problem in the live preview. A model produces a COMPLETE brief in one
 * shot and, as `design.ts` says of exactly this case, optimises for
 * resemblance rather than readability. Refusing keeps Mink to what the
 * merchant could publish anyway, and hands the issues back so the next attempt
 * fixes them; warning instead would put an approve button under a shop whose
 * body text cannot be read.
 */
export function validateMinkStorefrontDesignPatch(
  input: unknown,
  theme: ThemeDesign | null,
): ValidatedMinkStorefrontDesignPatch {
  const issues: string[] = [];
  if (!isRecord(input)) {
    return { ok: false, issues: ["The design patch must be an object."] };
  }
  rejectUnknownKeys(input, ROOT_KEYS, "The design patch", issues);

  if (input.schemaVersion !== MINK_STOREFRONT_DESIGN_SCHEMA_VERSION) {
    issues.push(
      `schemaVersion must be ${MINK_STOREFRONT_DESIGN_SCHEMA_VERSION}.`,
    );
  }
  if (input.operation !== "replace_design_overrides") {
    issues.push("operation must be replace_design_overrides.");
  }

  const target = input.target;
  if (!isRecord(target)) {
    issues.push("target must be an object.");
  } else {
    rejectUnknownKeys(target, TARGET_KEYS, "target", issues);
    if (
      typeof target.expectedDesignDigest !== "string" ||
      !SHA256_RE.test(target.expectedDesignDigest)
    ) {
      issues.push(
        "target.expectedDesignDigest must be the exact lowercase designDigest returned by the current design context.",
      );
    }
  }

  const raw = input.design;
  if (!isRecord(raw)) {
    issues.push("design must be an object.");
    return { ok: false, issues };
  }
  rejectUnknownKeys(raw, DESIGN_KEYS, "design", issues);

  const validated = validateStorefrontDesign(raw, theme, "publish");
  issues.push(...droppedValueIssues(raw, validated.design));
  issues.push(...validated.contrastIssues);

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      schemaVersion: MINK_STOREFRONT_DESIGN_SCHEMA_VERSION,
      operation: "replace_design_overrides",
      target: {
        expectedDesignDigest: String(
          (target as Record<string, unknown>).expectedDesignDigest,
        ),
      },
      design: validated.design,
    },
  };
}

/**
 * Every field the caller supplied that validation threw away.
 *
 * ⚠ `null` is NOT a dropped value: it is how a caller says "inherit the
 * theme", which is the whole vocabulary for clearing an override. Only a
 * present, non-null value that failed to survive is reported.
 */
function droppedValueIssues(
  raw: Record<string, unknown>,
  design: StorefrontDesignOverrides,
): string[] {
  const issues: string[] = [];
  const rawPalette = isRecord(raw.palette) ? raw.palette : {};
  const rawFonts = isRecord(raw.fonts) ? raw.fonts : {};
  const rawShape = isRecord(raw.shape) ? raw.shape : {};

  rejectUnknownKeys(
    rawPalette,
    DESIGN_PALETTE_TOKENS,
    "design.palette",
    issues,
  );
  rejectUnknownKeys(rawFonts, FONT_SLOTS, "design.fonts", issues);
  rejectUnknownKeys(rawShape, DESIGN_SHAPE_KEYS, "design.shape", issues);

  for (const token of DESIGN_PALETTE_TOKENS) {
    const supplied = rawPalette[token as string];
    if (supplied === undefined || supplied === null) continue;
    if (design.palette[token] === undefined) {
      issues.push(
        `design.palette.${token} must be a hex colour such as #1a1a1a; ${JSON.stringify(supplied)} was rejected.`,
      );
    }
  }
  for (const slot of FONT_SLOTS) {
    const supplied = rawFonts[slot];
    if (supplied === undefined || supplied === null) continue;
    if (design.fonts[slot] === null) {
      issues.push(
        `design.fonts.${slot} must be one of ${Object.keys(DESIGN_FONTS).join(", ")}; ${JSON.stringify(supplied)} was rejected.`,
      );
    }
  }
  for (const key of DESIGN_SHAPE_KEYS) {
    const supplied = rawShape[key as string];
    if (supplied === undefined || supplied === null) continue;
    if (design.shape[key] === undefined) {
      const max = key === "pill" ? DESIGN_PILL_MAX : DESIGN_RADIUS_MAX;
      issues.push(
        `design.shape.${key} must be a whole number of pixels between 0 and ${max}; ${JSON.stringify(supplied)} was rejected.`,
      );
    }
  }
  return issues;
}

/** Stable digest of one override set, for the optimistic lock. */
export function digestMinkStorefrontDesign(
  design: StorefrontDesignOverrides,
): string {
  // Normalised through the validator's own field order rather than the
  // caller's object literal, so two equal designs written in different key
  // orders cannot produce different digests.
  return digestMinkStorefrontValue(canonicalDesign(design));
}

function canonicalDesign(design: StorefrontDesignOverrides) {
  const palette: Record<string, string> = {};
  for (const token of DESIGN_PALETTE_TOKENS) {
    const value = design.palette[token];
    if (value) palette[token] = value;
  }
  const shape: Record<string, number> = {};
  for (const key of DESIGN_SHAPE_KEYS) {
    const value = design.shape[key];
    if (value !== undefined) shape[key] = value;
  }
  return {
    palette,
    fonts: { body: design.fonts.body, display: design.fonts.display },
    shape,
  };
}

/**
 * The design half of the Phase 7A reader's answer.
 *
 * ★★ WITHOUT `designDigest` THE TOOL COULD NOT BE CALLED AT ALL -- the same
 * gap 9B closed with `page.sectionsDigest`. The patch's optimistic lock is a
 * digest of the CURRENT override set, and nothing in the reader returned one,
 * so the model had no value to echo back. `themeDefaults` is the other half:
 * contrast is judged against the RESOLVED pair, so a model that cannot see the
 * theme's ink and page colours is being marked against a rubric it was never
 * shown.
 *
 * ★ FONTS COME BACK AS KEYS, NOT CSS VARIABLES. `themeDesignDefaults` returns
 * `var(--font-inter)` because that is what the storefront writes; the patch
 * vocabulary is `inter`. Handing the model the CSS form would have it propose
 * a value the validator then rejects as an unknown typeface.
 */
export function describeMinkStorefrontDesign(
  design: StorefrontDesignOverrides,
  theme: ThemeDesign | null,
): MinkStorefrontDesignContext {
  const defaults = themeDesignDefaults(theme);
  return {
    current: design,
    designDigest: digestMinkStorefrontDesign(design),
    themeDefaults: {
      palette: defaults.palette,
      fonts: {
        body: fontKeyForCss(defaults.fonts.body),
        display: fontKeyForCss(defaults.fonts.display),
      },
      shape: defaults.shape,
    },
    // Reported rather than enforced HERE: the store may already be sitting on
    // a failing pair (9A gates publishing, not saving), and a reader that
    // refused to describe such a store would leave the model unable to see the
    // very thing it needs to repair.
    contrastIssues: contrastIssuesFor(design, defaults),
    vocabulary: {
      paletteTokens: DESIGN_PALETTE_TOKENS,
      fonts: Object.keys(DESIGN_FONTS) as DesignFont[],
      shapeKeys: DESIGN_SHAPE_KEYS,
      radiusMax: DESIGN_RADIUS_MAX,
      pillMax: DESIGN_PILL_MAX,
      minContrast: DESIGN_MIN_CONTRAST,
      nullMeans: "inherit_the_pinned_theme" as const,
    },
  };
}

export interface MinkStorefrontDesignContext {
  current: StorefrontDesignOverrides;
  designDigest: string;
  themeDefaults: {
    palette: Partial<Record<DesignPaletteToken, string>>;
    fonts: { body: DesignFont | null; display: DesignFont | null };
    shape: Partial<Record<DesignShapeKey, number>>;
  };
  contrastIssues: string[];
  vocabulary: {
    paletteTokens: readonly DesignPaletteToken[];
    fonts: readonly DesignFont[];
    shapeKeys: readonly DesignShapeKey[];
    radiusMax: number;
    pillMax: number;
    minContrast: number;
    nullMeans: "inherit_the_pinned_theme";
  };
}

/** `var(--font-jost)` -> `jost`; the reverse of `DESIGN_FONTS`. */
function fontKeyForCss(value: string | null): DesignFont | null {
  if (!value) return null;
  const hit = Object.entries(DESIGN_FONTS).find(([, css]) => css === value);
  return hit ? (hit[0] as DesignFont) : null;
}

/** What changed, for the human review card. */
export function summarizeDesignChange(
  proposed: StorefrontDesignOverrides,
  current: StorefrontDesignOverrides,
  theme: ThemeDesign | null,
): MinkStorefrontDesignSummary {
  const defaults = themeDesignDefaults(theme);

  const palette = DESIGN_PALETTE_TOKENS.flatMap((token) => {
    const before = current.palette[token] ?? null;
    const after = proposed.palette[token] ?? null;
    if (before === after) return [];
    return [
      {
        token: token as DesignPaletteToken,
        before,
        after,
        // The colour the storefront will really paint, so a card can show the
        // inherited value rather than an empty swatch labelled "theme".
        themeDefault: defaults.palette[token] ?? null,
      },
    ];
  });

  const fonts = FONT_SLOTS.flatMap((slot) => {
    const before = current.fonts[slot];
    const after = proposed.fonts[slot];
    if (before === after) return [];
    return [
      {
        slot,
        before,
        after,
        themeDefault: fontKeyForCss(defaults.fonts[slot]),
      },
    ];
  });

  const shape = DESIGN_SHAPE_KEYS.flatMap((key) => {
    const before = current.shape[key] ?? null;
    const after = proposed.shape[key] ?? null;
    if (before === after) return [];
    return [
      {
        key: key as DesignShapeKey,
        before,
        after,
        themeDefault: defaults.shape[key] ?? null,
      },
    ];
  });

  return {
    palette,
    fonts,
    shape,
    // Recomputed against the RESOLVED pair, so a card can repeat what the
    // publish gate will say rather than implying the design is unconditionally
    // safe. An accepted proposal has none by construction; a stored one
    // re-read after a theme change may.
    contrastIssues: contrastIssuesFor(proposed, defaults),
  };
}
