import { describe, expect, it } from "vitest";
import { EMPTY_DESIGN_OVERRIDES } from "@/lib/chrome/design";
import { getThemeDefinition } from "@/lib/themes";
import type { StorefrontDesignOverrides } from "@/lib/chrome/design";
import {
  digestMinkStorefrontDesign,
  summarizeDesignChange,
  validateMinkStorefrontDesignPatch,
} from "./storefront-design-contract";

// A real shipped preset rather than a hand-built literal: `ThemePalette` has
// 21 required fields, and a fixture that drifts from what stores actually run
// would test the contract against a theme nobody has.
const THEME = getThemeDefinition("basket")?.preset.design ?? null;
const DIGEST = "a".repeat(64);

const patch = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  operation: "replace_design_overrides",
  target: { expectedDesignDigest: DIGEST },
  design: {
    palette: { cream: "#ffffff", ink: "#101010" },
    fonts: { body: "jost", display: "instrumentSerif" },
    shape: { card: 4, pill: 999 },
  },
  ...over,
});

describe("validateMinkStorefrontDesignPatch", () => {
  it("accepts a well-formed brief and normalises it", () => {
    const result = validateMinkStorefrontDesignPatch(patch(), THEME);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.design).toEqual({
      palette: { cream: "#ffffff", ink: "#101010" },
      fonts: { body: "jost", display: "instrumentSerif" },
      shape: { card: 4, pill: 999 },
    });
    expect(result.value.target.expectedDesignDigest).toBe(DIGEST);
  });

  it("expands a three-digit hex, because the storefront writes the resolved value", () => {
    const result = validateMinkStorefrontDesignPatch(
      patch({
        design: {
          palette: { cream: "#FFF", ink: "#000" },
          fonts: { body: null, display: null },
          shape: {},
        },
      }),
      THEME,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.design.palette).toEqual({
      cream: "#ffffff",
      ink: "#000000",
    });
  });

  it("★ NAMES a rejected colour instead of silently dropping it", () => {
    // The 9A validator discards it and returns the rest — right for a colour
    // picker, dishonest for a model: "set the accent to brand red" would
    // become a proposal that never mentions the accent, approved by a merchant
    // who then sees nothing change.
    const result = validateMinkStorefrontDesignPatch(
      patch({
        design: {
          palette: { cream: "#ffffff", ink: "#101010", accent: "brand red" },
          fonts: { body: null, display: null },
          shape: {},
        },
      }),
      THEME,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.stringContaining("design.palette.accent"),
    ]);
  });

  it("★ NAMES a rejected typeface and a rejected radius too", () => {
    const result = validateMinkStorefrontDesignPatch(
      patch({
        design: {
          palette: { cream: "#ffffff", ink: "#101010" },
          fonts: { body: "Helvetica Neue", display: null },
          shape: { card: 400 },
        },
      }),
      THEME,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      expect.stringContaining("design.fonts.body"),
      expect.stringContaining("design.shape.card"),
    ]);
  });

  it("treats null as INHERIT, never as a rejected value", () => {
    const result = validateMinkStorefrontDesignPatch(
      patch({
        design: {
          palette: { cream: "#ffffff", ink: "#101010", accent: null },
          fonts: { body: null, display: null },
          shape: {},
        },
      }),
      THEME,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.design.palette.accent).toBeUndefined();
  });

  it("★ and a null RADIUS inherits too, rather than squaring the corners", () => {
    // ★★ The one place `null` used to mean something else. `Number(null)` is 0
    //    and `Number.isInteger(0)` is true, so the validator wrote a real 0px
    //    override — and this contract's dropped-value pass exempts null by
    //    design, so "put the corners back to the theme" stored square corners
    //    with nothing named back to the model or shown on the review card.
    const result = validateMinkStorefrontDesignPatch(
      patch({
        design: {
          palette: {},
          fonts: { body: null, display: null },
          shape: { card: null, control: null, sm: null, pill: null },
        },
      }),
      THEME,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.design.shape).toEqual({});
  });

  it("★ REFUSES an illegible palette, though 9A makes contrast a publish gate", () => {
    // The panel cannot refuse a merchant mid-edit; a model produces a complete
    // brief in one shot and optimises for resemblance. Refusing keeps Mink to
    // what the merchant could publish anyway.
    const result = validateMinkStorefrontDesignPatch(
      patch({
        design: {
          palette: { cream: "#f5f5f5", ink: "#eeeeee" },
          fonts: { body: null, display: null },
          shape: {},
        },
      }),
      THEME,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toMatch(/hard to read/i);
  });

  it("checks contrast against the RESOLVED pair, not only the overridden one", () => {
    // Overriding the page background alone can break text inherited from the
    // theme that the merchant never touched.
    const themed = THEME?.palette.ink ?? "#000000";
    const result = validateMinkStorefrontDesignPatch(
      patch({
        design: {
          palette: { cream: themed },
          fonts: { body: null, display: null },
          shape: {},
        },
      }),
      THEME,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toMatch(/hard to read/i);
  });

  it("refuses unknown fields at every level", () => {
    for (const bad of [
      patch({ mode: "dark" }),
      patch({ target: { expectedDesignDigest: DIGEST, pageSlug: "home" } }),
      patch({
        design: {
          palette: {},
          fonts: { body: null, display: null },
          shape: {},
          spacing: 4,
        },
      }),
      patch({
        design: {
          palette: { headerBackground: "#fff" },
          fonts: { body: null, display: null },
          shape: {},
        },
      }),
    ]) {
      const result = validateMinkStorefrontDesignPatch(bad, THEME);
      expect(result.ok).toBe(false);
    }
  });

  it("refuses a digest that is not the exact 64-character value", () => {
    for (const digest of ["", "abc", DIGEST.toUpperCase(), 12]) {
      const result = validateMinkStorefrontDesignPatch(
        patch({ target: { expectedDesignDigest: digest } }),
        THEME,
      );
      expect(result.ok).toBe(false);
    }
  });

  it("accepts an EMPTY design — resetting every token back to the theme", () => {
    // Unlike 9B, omission here is not deletion: it restores a designed state
    // the storefront renders correctly.
    const result = validateMinkStorefrontDesignPatch(
      patch({ design: EMPTY_DESIGN_OVERRIDES }),
      THEME,
    );
    expect(result.ok).toBe(true);
  });
});

describe("digestMinkStorefrontDesign", () => {
  it("is independent of the caller's key order", () => {
    const a: StorefrontDesignOverrides = {
      palette: { ink: "#101010", cream: "#ffffff" },
      fonts: { body: "jost", display: null },
      shape: { pill: 999, card: 4 },
    };
    const b: StorefrontDesignOverrides = {
      palette: { cream: "#ffffff", ink: "#101010" },
      fonts: { display: null, body: "jost" },
      shape: { card: 4, pill: 999 },
    };
    expect(digestMinkStorefrontDesign(a)).toBe(digestMinkStorefrontDesign(b));
  });

  it("moves when any one field moves", () => {
    const base = EMPTY_DESIGN_OVERRIDES;
    const digests = new Set([
      digestMinkStorefrontDesign(base),
      digestMinkStorefrontDesign({ ...base, palette: { ink: "#101010" } }),
      digestMinkStorefrontDesign({
        ...base,
        fonts: { body: "jost", display: null },
      }),
      digestMinkStorefrontDesign({ ...base, shape: { card: 4 } }),
    ]);
    expect(digests.size).toBe(4);
  });
});

describe("summarizeDesignChange", () => {
  const current: StorefrontDesignOverrides = {
    palette: { ink: "#101010" },
    fonts: { body: "jost", display: null },
    shape: { card: 4 },
  };

  it("reports only what moved, and what the theme supplies underneath", () => {
    const summary = summarizeDesignChange(
      {
        palette: { ink: "#101010", cream: "#fffdf8" },
        fonts: { body: null, display: null },
        shape: { card: 4 },
      },
      current,
      THEME,
    );
    // ink and card are unchanged, so they are absent entirely.
    expect(summary.palette).toEqual([
      {
        token: "cream",
        before: null,
        after: "#fffdf8",
        themeDefault: THEME?.palette.cream ?? null,
      },
    ]);
    // Clearing the body font is a real change, and the card must be able to
    // name the typeface it falls back to.
    expect(summary.fonts).toEqual([
      { slot: "body", before: "jost", after: null, themeDefault: "inter" },
    ]);
    expect(summary.shape).toEqual([]);
  });

  it("says nothing at all when the design is identical", () => {
    const summary = summarizeDesignChange(current, current, THEME);
    expect(summary.palette).toEqual([]);
    expect(summary.fonts).toEqual([]);
    expect(summary.shape).toEqual([]);
  });
});
