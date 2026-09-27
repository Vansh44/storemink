import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateSectionStyle } from "@/lib/homepage/section-types";
import { validateSections } from "@/lib/sections/registry";
import { THEME_DEFINITIONS } from "./index";
import {
  FALLBACK_SCHEME_PALETTE,
  mixHex,
  resolveScheme,
  SCHEME_MIX,
  schemeContrast,
  schemeContrastIssues,
  schemeCssVars,
  schemeDesignFor,
  schemePreviews,
  schemesUsed,
  SECTION_SCHEMES,
  withPaletteOverrides,
  type SchemeDesign,
} from "./schemes";
import { designToCssVars } from "./types";
import { validateThemeDesign } from "./validation";

const design: SchemeDesign = {
  palette: {
    cream: "#ffffff",
    creamDeep: "#f2f0ec",
    surface: "#ffffff",
    ink: "#111111",
    onInk: "#ffffff",
    onAccent: "#ffffff",
    accent: "#2542c7",
  },
};

describe("resolveScheme — derived from the palette", () => {
  it("soft is the deep page colour with page text and buttons", () => {
    const s = resolveScheme("soft", design, "#000000");
    expect(s.background).toBe("#f2f0ec");
    expect(s.text).toBe("#111111");
    expect(s.accent).toBe("#2542c7");
  });

  it("tint washes the accent into the page", () => {
    expect(resolveScheme("tint", design, "#000000").background).toBe(
      mixHex("#2542c7", "#ffffff", SCHEME_MIX.tint),
    );
  });

  it("accent and inverse invert their buttons so they always read", () => {
    const a = resolveScheme("accent", design, "#000000");
    expect([a.background, a.text, a.accent, a.onAccent]).toEqual([
      "#2542c7",
      "#ffffff",
      "#ffffff",
      "#2542c7",
    ]);
    const d = resolveScheme("inverse", design, "#000000");
    expect([d.background, d.text, d.accent, d.onAccent]).toEqual([
      "#111111",
      "#ffffff",
      "#ffffff",
      "#111111",
    ]);
  });

  it("an un-accented theme follows the brand colour", () => {
    const { accent: _omit, ...palette } = design.palette;
    void _omit;
    expect(resolveScheme("accent", { palette }, "#aa3300").background).toBe(
      "#aa3300",
    );
  });

  it("muted text and hairlines are mixes of text into the band", () => {
    const s = resolveScheme("inverse", design, "#000000");
    expect(s.textSoft).toBe(mixHex("#ffffff", "#111111", SCHEME_MIX.textSoft));
    expect(s.border).toBe(mixHex("#ffffff", "#111111", SCHEME_MIX.border));
  });
});

describe("resolveScheme — declared by the theme", () => {
  it("uses the declared colours over the derived ones", () => {
    const s = resolveScheme(
      "soft",
      {
        ...design,
        schemes: { soft: { background: "#dfe4ff", text: "#1a1a40" } },
      },
      "#000000",
    );
    expect(s.background).toBe("#dfe4ff");
    expect(s.text).toBe("#1a1a40");
  });

  it("keeps the theme's button when it reads on the band", () => {
    const s = resolveScheme(
      "soft",
      {
        ...design,
        schemes: { soft: { background: "#f5f5f5", text: "#111111" } },
      },
      "#000000",
    );
    expect(s.accent).toBe("#2542c7");
    expect(s.onAccent).toBe("#ffffff");
  });

  it("inverts the button when the theme's would vanish into the band", () => {
    const s = resolveScheme(
      "accent",
      {
        ...design,
        schemes: { accent: { background: "#2a45c9", text: "#ffffff" } },
      },
      "#000000",
    );
    // #2542c7 on #2a45c9 is ~1:1, so the button becomes text-on-band.
    expect(s.accent).toBe("#ffffff");
    expect(s.onAccent).toBe("#2a45c9");
  });

  it("honours explicit button colours", () => {
    const s = resolveScheme(
      "inverse",
      {
        ...design,
        schemes: {
          inverse: {
            background: "#101010",
            text: "#fafafa",
            accent: "#f5c542",
            onAccent: "#101010",
          },
        },
      },
      "#000000",
    );
    expect([s.accent, s.onAccent]).toEqual(["#f5c542", "#101010"]);
  });

  it("lifts cards above a light band, never sinks them", () => {
    const s = resolveScheme(
      "tint",
      {
        ...design,
        schemes: { tint: { background: "#e8ecff", text: "#111111" } },
      },
      "#000000",
    );
    expect(schemeContrast(s.surface, "#ffffff")).toBeLessThan(
      schemeContrast(s.background, "#ffffff"),
    );
  });
});

describe("the Brand band's text", () => {
  // White on a mid-tone green reads on a button (3:1) and not as body copy.
  const green: SchemeDesign = {
    palette: { ...design.palette, accent: "#2e9e5b", onAccent: "#ffffff" },
  };

  it("keeps on-accent when it reads as body text", () => {
    expect(resolveScheme("accent", design, "#000").text).toBe("#ffffff");
    expect(schemeCssVars(design, "#000")).toEqual({});
  });

  it("switches to a theme text colour that does read", () => {
    const s = resolveScheme("accent", green, "#000");
    expect(schemeContrast("#ffffff", "#2e9e5b")).toBeLessThan(4.5);
    expect(s.text).toBe("#111111");
    // Body text now reads. Muted copy on a mid-tone band still falls short
    // (a 76% mix loses contrast), and is reported rather than hidden.
    const issues = schemeContrastIssues("accent", s).map((i) => i.message);
    expect(issues.some((m) => m.startsWith("Text in"))).toBe(false);
    expect(issues.some((m) => m.startsWith("Muted text"))).toBe(true);
    // CSS cannot pick by contrast, so the root carries the result.
    expect(schemeCssVars(green, "#000")).toEqual({
      "--sm-scheme-accent-fg": "#111111",
      "--sm-scheme-accent-surface": s.surface,
      "--sm-scheme-accent-accent": "#111111",
    });
  });

  it("falls back to black or white when no theme colour reads", () => {
    // Basket's orange: its white buttons and its ink both fall short.
    const orange: SchemeDesign = {
      palette: {
        ...design.palette,
        ink: "#1e2b28",
        accent: "#ef5a2a",
        onAccent: "#ffffff",
      },
    };
    const s = resolveScheme("accent", orange, "#000");
    expect(s.text).toBe("#000000");
    expect(schemeContrast(s.text, s.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("body text on any brand colour reads", () => {
    for (let i = 0; i < 4096; i += 7) {
      const hex = `#${[i >> 8, (i >> 4) & 15, i & 15]
        .map((n) => n.toString(16).repeat(2))
        .join("")}`;
      const s = resolveScheme(
        "accent",
        { palette: { ...design.palette, accent: hex } },
        "#000",
      );
      expect(schemeContrast(s.text, s.background), hex).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("follows a merchant's brand colour when the theme has no accent", () => {
    const { accent: _a, ...palette } = design.palette;
    void _a;
    expect(resolveScheme("accent", { palette }, "#ffd84d").text).toBe(
      "#111111",
    );
  });
});

describe("schemeCssVars", () => {
  it("emits only the schemes a theme declares", () => {
    expect(schemeCssVars(design, "#000000")).toEqual({});
    const vars = schemeCssVars(
      {
        ...design,
        schemes: { soft: { background: "#dfe4ff", text: "#1a1a40" } },
      },
      "#000000",
    );
    expect(Object.keys(vars).sort()).toEqual([
      "--sm-scheme-soft-accent",
      "--sm-scheme-soft-bg",
      "--sm-scheme-soft-fg",
      "--sm-scheme-soft-on-accent",
      "--sm-scheme-soft-surface",
    ]);
  });

  it("never emits a non-hex value into the inline style", () => {
    const vars = schemeCssVars(
      {
        ...design,
        schemes: {
          soft: { background: "red;background:url(x)", text: "#111111" },
        },
      },
      "#000000",
    );
    expect(vars).toEqual({});
  });

  it("reaches the storefront root through designToCssVars", () => {
    const theme = THEME_DEFINITIONS.find((t) => t.id === "studio")!;
    const vars = designToCssVars(
      {
        ...theme.preset.design,
        schemes: { inverse: { background: "#101010", text: "#fafafa" } },
      },
      "#000000",
    );
    expect(vars["--sm-scheme-inverse-bg"]).toBe("#101010");
  });
});

describe("contrast", () => {
  it("passes a readable scheme", () => {
    expect(
      schemeContrastIssues("inverse", resolveScheme("inverse", design, "#000")),
    ).toEqual([]);
  });

  it("names every pair a band fails", () => {
    const s = resolveScheme(
      "tint",
      {
        ...design,
        schemes: { tint: { background: "#dddddd", text: "#aaaaaa" } },
      },
      "#000000",
    );
    const issues = schemeContrastIssues("tint", s).map((i) => i.message);
    expect(issues.some((m) => m.startsWith("Text in the Tinted"))).toBe(true);
    expect(issues.some((m) => m.startsWith("Muted text"))).toBe(true);
  });

  it("the builder marks an unreadable scheme", () => {
    const previews = schemePreviews(
      {
        ...design,
        schemes: { soft: { background: "#dddddd", text: "#aaaaaa" } },
      },
      "#000000",
    );
    expect(previews.soft.readable).toBe(false);
    expect(previews.inverse.readable).toBe(true);
  });

  it("every bundled theme's derived schemes are readable", () => {
    for (const theme of THEME_DEFINITIONS) {
      const d = schemeDesignFor(theme.preset.design);
      for (const id of SECTION_SCHEMES) {
        if (id === "accent" || id === "tint") continue; // depend on the brand colour
        expect(
          schemeContrastIssues(
            id,
            resolveScheme(id, d, theme.preset.brand.primaryColor),
          ),
          `${theme.id}/${id}`,
        ).toEqual([]);
      }
    }
  });

  it("theme validation checks a scheme a page uses, and skips unused ones", () => {
    const theme = THEME_DEFINITIONS.find((t) => t.id === "studio")!;
    const bad = { background: "#dddddd", text: "#aaaaaa" };
    const withUnused = {
      ...theme,
      preset: {
        ...theme.preset,
        design: { ...theme.preset.design, schemes: { soft: bad } },
      },
    };
    // Declared ⇒ always checked.
    expect(
      validateThemeDesign(withUnused).some((f) => f.code === "scheme_contrast"),
    ).toBe(true);
    // Derived and unused ⇒ not checked; derived and used ⇒ checked.
    const unreadable = {
      ...theme,
      preset: {
        ...theme.preset,
        design: {
          ...theme.preset.design,
          palette: {
            ...theme.preset.design.palette,
            onInk: theme.preset.design.palette.ink,
          },
        },
      },
    };
    const flag = (t: typeof theme) =>
      validateThemeDesign(t).some(
        (f) => f.code === "scheme_contrast" && f.message.includes("Dark"),
      );
    expect(flag(unreadable)).toBe(false);
    const home = unreadable.preset.pages.find((p) => p.slug === "")!;
    const used = {
      ...unreadable,
      preset: {
        ...unreadable.preset,
        pages: [
          {
            ...home,
            sections: [
              { ...home.sections[0], style: { scheme: "inverse" as const } },
              ...home.sections.slice(1),
            ],
          },
        ],
      },
    };
    expect(flag(used)).toBe(true);
  });

  it("a malformed declared scheme is reported, not rendered", () => {
    const theme = THEME_DEFINITIONS.find((t) => t.id === "studio")!;
    const findings = validateThemeDesign({
      ...theme,
      preset: {
        ...theme.preset,
        design: {
          ...theme.preset.design,
          schemes: {
            soft: { background: "blue", text: "#111111", accent: "#ffffff" },
          },
        },
      },
    }).map((f) => f.message);
    expect(findings).toContain("schemes.soft.background must be a hex colour.");
    expect(findings).toContain(
      "schemes.soft must set accent and onAccent together, or neither.",
    );
  });
});

describe("section style", () => {
  it("stores a known scheme and refuses anything else", () => {
    expect(validateSectionStyle({ scheme: "inverse" })).toEqual({
      scheme: "inverse",
    });
    expect(validateSectionStyle({ scheme: "neon" })).toBeUndefined();
    expect(validateSectionStyle({ scheme: "inverse x" })).toBeUndefined();
  });

  it("drops a raw background beside a scheme", () => {
    expect(
      validateSectionStyle({ scheme: "soft", background: "#123456" }),
    ).toEqual({ scheme: "soft" });
    expect(validateSectionStyle({ background: "#123456" })).toEqual({
      background: "#123456",
    });
  });

  it("drops a scheme from a section that sits on its own photo", () => {
    expect(
      validateSectionStyle({ scheme: "inverse" }, "hero_carousel"),
    ).toBeUndefined();
    expect(validateSectionStyle({ scheme: "inverse" }, "media_text")).toEqual({
      scheme: "inverse",
    });
    const result = validateSections(
      [
        {
          id: "c",
          type: "hero_carousel",
          config: { slides: [], autoplay: true, interval_ms: 5000 },
          style: { scheme: "soft", padding_y: "md" },
        },
      ],
      { mode: "draft" },
    );
    expect("sections" in result && result.sections[0].style).toEqual({
      padding_y: "md",
    });
  });

  it("finds the schemes a theme's pages use", () => {
    expect([
      ...schemesUsed([
        {
          sections: [
            { style: { scheme: "soft" } },
            { style: {} },
            { style: { scheme: "bogus" } },
            {},
          ],
        },
      ]),
    ]).toEqual(["soft"]);
  });
});

describe("builder previews", () => {
  it("un-themed stores preview against the storefront defaults", () => {
    expect(schemeDesignFor(null).palette).toEqual(FALLBACK_SCHEME_PALETTE);
  });

  it("a merchant's palette edit reaches a derived swatch", () => {
    const edited = withPaletteOverrides(design, {
      ink: "#003300",
      cream: "not-a-colour",
    });
    expect(schemePreviews(edited, "#000").inverse.background).toBe("#003300");
    expect(edited.palette.cream).toBe("#ffffff");
  });
});

describe("the CSS mirrors resolveScheme", () => {
  // The contrast check judges resolveScheme's colours; the shopper sees the
  // CSS's. A weight changed in one place only would pass colours nobody sees.
  // Whitespace-normalised: Prettier wraps a long color-mix() over lines.
  const norm = (css: string) =>
    css.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
  const home = norm(
    readFileSync("app/(storefront)/components/homepage/homepage.css", "utf8"),
  );
  const root = norm(
    readFileSync("app/(storefront)/storefront-theme.css", "utf8"),
  );
  const block = home.slice(home.indexOf(".home-section.sm-scheme {"));
  const rule = block.slice(0, block.indexOf("}"));

  it("uses the same mix weights", () => {
    expect(rule).toContain(
      `--sm-ink-soft: color-mix(in srgb, var(--sm-scheme-fg) ${SCHEME_MIX.textSoft}%`,
    );
    expect(rule).toContain(
      `--sm-ink-faint: color-mix(in srgb, var(--sm-scheme-fg) ${SCHEME_MIX.textFaint}%`,
    );
    expect(rule).toContain(
      `--sm-border: color-mix(in srgb, var(--sm-scheme-fg) ${SCHEME_MIX.border}%`,
    );
    expect(rule).toContain(
      `--sm-cream-deep: color-mix(in srgb, var(--sm-scheme-fg) ${SCHEME_MIX.deep}%`,
    );
    expect(root).toContain(
      `--sm-scheme-tint-bg: color-mix(in srgb, var(--sm-accent) ${SCHEME_MIX.tint}%`,
    );
  });

  it("defines every scheme's variables and class", () => {
    for (const id of SECTION_SCHEMES) {
      for (const part of ["bg", "fg", "surface", "accent", "on-accent"]) {
        expect(root, `${id}-${part}`).toContain(`--sm-scheme-${id}-${part}:`);
        expect(home, `${id}-${part}`).toContain(
          `var(--sm-scheme-${id}-${part})`,
        );
      }
      expect(home).toContain(`.home-section.sm-scheme-${id} {`);
    }
  });

  it("blocks with their own fill keep the page's colours inside a band", () => {
    const restore = home.slice(
      home.indexOf(".home-section.sm-scheme .shop-card,"),
    );
    const body = restore.slice(0, restore.indexOf("}"));
    expect(body).toContain(".home-section.sm-scheme .home-tile,");
    expect(body).toContain(
      ".home-section.sm-scheme .home-hero.variant-banner,",
    );
    for (const token of ["ink", "ink-soft", "on-ink", "surface", "accent"]) {
      expect(body).toContain(`--sm-${token}: var(--sm-page-${token});`);
      expect(root).toContain(`--sm-page-${token}: var(--sm-${token});`);
    }
  });

  it("re-points on-ink to the band, so ink blocks invert inside it", () => {
    expect(rule).toContain("--sm-on-ink: var(--sm-scheme-bg);");
    expect(rule).toContain("--sm-accent: var(--sm-scheme-accent);");
  });
});
