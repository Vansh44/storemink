import { describe, expect, it } from "vitest";
import {
  DESIGN_FONTS,
  DESIGN_MIN_CONTRAST,
  DESIGN_PALETTE_TOKENS,
  contrastIssuesFor,
  contrastRatio,
  designOverrideCssVars,
  EMPTY_DESIGN_OVERRIDES,
  hasDesignOverrides,
  validateStorefrontDesign,
} from "./design";
import { designToCssVars } from "@/lib/themes/types";
import { getThemeDefinition } from "@/lib/themes";

const theme = getThemeDefinition("basket").preset.design;
const legible = {
  palette: { ink: "#111111", cream: "#ffffff", surface: "#ffffff" },
};

describe("validateStorefrontDesign", () => {
  it("keeps a clean palette, font and radius", () => {
    const { design } = validateStorefrontDesign(
      {
        palette: { ink: "#101010", accent: "#C2185B" },
        fonts: { body: "jost", display: "fraunces" },
        shape: { card: 0, pill: 999 },
      },
      theme,
    );
    expect(design).toEqual({
      palette: { ink: "#101010", accent: "#c2185b" },
      fonts: { body: "jost", display: "fraunces" },
      shape: { card: 0, pill: 999 },
    });
  });

  it("expands three-digit hex so stored colours are one shape", () => {
    // The contrast maths indexes fixed byte offsets; a #abc left unexpanded
    // would be parsed as garbage rather than rejected.
    const { design } = validateStorefrontDesign(
      { palette: { ink: "#ABC" } },
      theme,
    );
    expect(design.palette.ink).toBe("#aabbcc");
  });

  it("DROPS anything that is not a plain hex colour, in both modes", () => {
    // These land in an inline style attribute, so the rule is the one
    // SectionStyle.background follows: it is one of ours, or it is absent.
    for (const mode of ["draft", "publish"] as const) {
      const { design } = validateStorefrontDesign(
        {
          palette: {
            ink: "url(https://evil.example/x.png)",
            cream: "rgb(255,0,0)",
            surface: "red",
            border: "#12345",
          },
        },
        theme,
        mode,
      );
      expect(design.palette).toEqual({});
    }
  });

  it("drops a font it does not load rather than passing the name through", () => {
    // app/layout.tsx loads a fixed set; naming another renders the fallback
    // stack with nothing to explain why.
    const { design } = validateStorefrontDesign(
      { fonts: { body: "comic-sans", display: "var(--anything)" } },
      theme,
    );
    expect(design.fonts).toEqual({ body: null, display: null });
  });

  it("drops radii outside their range, and lets pill be fully round", () => {
    const { design } = validateStorefrontDesign(
      { shape: { card: 999, control: -1, sm: 8.5, pill: 999 } },
      theme,
    );
    expect(design.shape).toEqual({ pill: 999 });
  });

  it("reads absent input as inherit-everything rather than failing", () => {
    expect(validateStorefrontDesign(undefined, theme).design).toEqual(
      EMPTY_DESIGN_OVERRIDES,
    );
    expect(validateStorefrontDesign(null, null).design).toEqual(
      EMPTY_DESIGN_OVERRIDES,
    );
  });
});

describe("contrast", () => {
  it("computes the WCAG ratio symmetrically", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("reports an unreadable pair at publish and stays silent at draft", () => {
    // A half-picked palette must not fail the builder's autosave; the merchant
    // can see the problem in the live preview long before Publish.
    const grey = { palette: { ink: "#999999", cream: "#aaaaaa" } };
    expect(
      validateStorefrontDesign(grey, theme, "publish").contrastIssues.length,
    ).toBeGreaterThan(0);
    expect(
      validateStorefrontDesign(grey, theme, "draft").contrastIssues,
    ).toEqual([]);
  });

  it("passes a legible palette", () => {
    expect(
      validateStorefrontDesign(legible, theme, "publish").contrastIssues,
    ).toEqual([]);
  });

  it("catches text the merchant never touched", () => {
    // ★ Changing ONLY the page background can break body text inherited from
    // the theme, so each pair is judged on what will actually render.
    const dark = { palette: { cream: "#1a1a1a" } };
    const issues = contrastIssuesFor(
      validateStorefrontDesign(dark, theme, "publish").design,
      theme,
    );
    expect(issues.join(" ")).toContain("body text on the page background");
  });

  it("skips a pair it cannot parse instead of calling it a failure", () => {
    // With no theme and only one side overridden there is nothing to compare;
    // an unparseable value must not read as unreadable.
    expect(
      contrastIssuesFor(
        validateStorefrontDesign({ palette: { ink: "#111111" } }, null).design,
        null,
      ),
    ).toEqual([]);
  });

  it("names the measured ratio and the threshold", () => {
    const issues = contrastIssuesFor(
      validateStorefrontDesign(
        { palette: { ink: "#999999", cream: "#aaaaaa", surface: "#aaaaaa" } },
        theme,
      ).design,
      theme,
    );
    expect(issues[0]).toContain(`needs ${DESIGN_MIN_CONTRAST}:1`);
  });
});

describe("designOverrideCssVars", () => {
  // ★★ THE GUARD THAT MATTERS. These variable names are the entire contract
  // with the storefront: emit `--sm-page-bg` instead of `--sm-cream` and the
  // override is a silent no-op — no error, no failing render, just a colour
  // that never changes. Pinned against designToCssVars, which is what the
  // storefront actually consumes.
  it("emits only variable names the theme engine also writes", () => {
    const themeVars = new Set(Object.keys(designToCssVars(theme, "#000000")));
    const all = validateStorefrontDesign(
      {
        palette: Object.fromEntries(
          DESIGN_PALETTE_TOKENS.map((t) => [t, "#123456"]),
        ),
        fonts: { body: "jost", display: "fraunces" },
        shape: { card: 4, control: 4, sm: 2, pill: 999 },
      },
      theme,
    ).design;
    const emitted = Object.keys(designOverrideCssVars(all));
    expect(emitted.length).toBeGreaterThan(0);
    for (const name of emitted) expect(themeVars, name).toContain(name);
  });

  it("re-points BOTH body font slots, not just one", () => {
    // designToCssVars aims --font-outfit AND --font-roboto at fonts.body.
    // Overriding one leaves the storefront in two typefaces (§11, Vitrine).
    const { design } = validateStorefrontDesign(
      { fonts: { body: "jost", display: null } },
      theme,
    );
    const vars = designOverrideCssVars(design);
    expect(vars["--font-outfit"]).toBe(DESIGN_FONTS.jost);
    expect(vars["--font-roboto"]).toBe(DESIGN_FONTS.jost);
  });

  it("emits NOTHING when nothing was overridden", () => {
    // ★ Writing a full palette for an un-overridden store would pin it to
    // today's theme values, so a preset upgrade would stop reaching it.
    expect(designOverrideCssVars(EMPTY_DESIGN_OVERRIDES)).toEqual({});
    expect(hasDesignOverrides(EMPTY_DESIGN_OVERRIDES)).toBe(false);
  });

  it("emits only the tokens actually set", () => {
    const { design } = validateStorefrontDesign(
      { palette: { accent: "#c2185b" }, shape: { card: 0 } },
      theme,
    );
    expect(designOverrideCssVars(design)).toEqual({
      "--brand-primary": "#c2185b",
      "--sm-radius-card": "0px",
    });
    expect(hasDesignOverrides(design)).toBe(true);
  });
});
