import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_DEFINITIONS } from "./index";
import { designToCssVars } from "./types";
import {
  cleanTypography,
  fakesBold,
  HEADING_SELECTORS,
  typographyCssVars,
  typographyIssues,
  typographyRootClasses,
  UNSCALED_HEADING_SELECTORS,
} from "./typography";
import { validateThemeDesign } from "./validation";

const norm = (css: string) => css.replace(/\s+/g, " ");

describe("typography is opt-in", () => {
  it("emits nothing when a theme sets nothing", () => {
    expect(typographyCssVars(undefined)).toEqual({});
    expect(typographyCssVars({})).toEqual({});
    expect(typographyRootClasses(undefined)).toEqual([]);
    expect(typographyRootClasses({})).toEqual([]);
  });

  it("no bundled theme changes: none writes a heading variable", () => {
    for (const theme of THEME_DEFINITIONS) {
      const vars = designToCssVars(theme.preset.design, "#000000");
      expect(
        Object.keys(vars).filter((k) => k.startsWith("--sm-heading")),
      ).toEqual([]);
    }
  });

  it("a medium scale and an unset case are the same as nothing", () => {
    expect(typographyCssVars({ headingScale: "medium" })).toEqual({});
    expect(typographyRootClasses({ headingCase: "none" })).toEqual([]);
  });
});

describe("typographyCssVars and root classes", () => {
  it("writes only the chosen settings", () => {
    expect(
      typographyCssVars({
        headingFont: "display",
        headingScale: "large",
        headingWeight: "semibold",
        headingTracking: "wide",
      }),
    ).toEqual({
      "--sm-heading-font": "var(--font-stick-no-bills)",
      "--sm-heading-scale": "1.12",
      "--sm-heading-weight": "600",
      "--sm-heading-tracking": "0.06em",
    });
    expect(typographyCssVars({ headingFont: "body" })).toEqual({
      "--sm-heading-font": "var(--font-outfit)",
    });
  });

  it("switches each property on with its own class", () => {
    expect(typographyRootClasses({ headingWeight: "regular" })).toEqual([
      "sm-h-weight",
    ]);
    expect(
      typographyRootClasses({
        headingFont: "display",
        headingWeight: "bold",
        headingCase: "uppercase",
        headingTracking: "tight",
        headingScale: "xlarge",
      }),
    ).toEqual([
      "sm-h-scale",
      "sm-h-font",
      "sm-h-weight",
      "sm-h-upper",
      "sm-h-track",
    ]);
  });

  it("drops unknown settings rather than writing them into a style", () => {
    expect(
      cleanTypography({
        headingFont: "comic-sans",
        headingWeight: "900",
        extra: "x",
        headingCase: "uppercase",
      }),
    ).toEqual({ headingCase: "uppercase" });
    expect(
      typographyCssVars({ headingFont: "red; color: red" } as never),
    ).toEqual({});
  });

  it("designToCssVars carries a theme's typography", () => {
    const theme = THEME_DEFINITIONS[0];
    const vars = designToCssVars(
      { ...theme.preset.design, typography: { headingWeight: "medium" } },
      "#000000",
    );
    expect(vars["--sm-heading-weight"]).toBe("500");
  });
});

describe("typographyIssues", () => {
  const jost = { body: "var(--font-jost)", display: "var(--font-inter)" };
  const serif = {
    body: "var(--font-inter)",
    display: "var(--font-instrument-serif)",
  };

  it("a face without a bold weight cannot carry bold headings", () => {
    expect(fakesBold("var(--font-jost)", 700)).toBe(true);
    expect(fakesBold("var(--font-jost)", 500)).toBe(false);
    expect(fakesBold("var(--font-instrument-serif)", 600)).toBe(true);
    expect(fakesBold("var(--font-roboto)", 800)).toBe(false);
    expect(fakesBold("var(--font-unknown)", 800)).toBe(false);
  });

  it("names a heading face that would render in faked bold", () => {
    // No weight: headings keep 600–800, which Jost does not have.
    expect(typographyIssues({ headingCase: "uppercase" }, jost)[0]).toMatch(
      /faked bold.*no bold weight/,
    );
    expect(
      typographyIssues(
        { headingFont: "display", headingWeight: "bold" },
        serif,
      )[0],
    ).toMatch(/faked bold.*near 700/);
    // A weight the face really has is fine.
    expect(typographyIssues({ headingWeight: "medium" }, jost)).toEqual([]);
    expect(
      typographyIssues(
        { headingFont: "display", headingWeight: "regular" },
        serif,
      ),
    ).toEqual([]);
    // Variable fonts have every weight.
    expect(typographyIssues({ headingFont: "body" }, serif)).toEqual([]);
  });

  it("names unknown keys and values, and ignores an absent block", () => {
    expect(typographyIssues(undefined, serif)).toEqual([]);
    expect(typographyIssues("big", serif)).toEqual([
      "typography must be an object.",
    ]);
    const issues = typographyIssues(
      { headingScale: "huge", colour: "red" },
      serif,
    );
    expect(issues.join(" ")).toContain('typography.headingScale "huge"');
    expect(issues.join(" ")).toContain("typography.colour is not");
  });

  it("theme validation reports it under the typography code", () => {
    const theme = THEME_DEFINITIONS.find((t) => t.id === "vitrine")!;
    // Vitrine sets Jost as its body face.
    expect(theme.preset.design.fonts.body).toBe("var(--font-jost)");
    const code = (typography: object) =>
      validateThemeDesign({
        ...theme,
        preset: {
          ...theme.preset,
          design: { ...theme.preset.design, typography },
        },
      }).filter((f) => f.code === "typography");
    expect(code({ headingCase: "uppercase" })).toHaveLength(1);
    expect(
      code({ headingCase: "uppercase", headingWeight: "regular" }),
    ).toHaveLength(0);
    // Opt-in: a theme with no typography is not judged on it.
    expect(
      validateThemeDesign(theme).filter((f) => f.code === "typography"),
    ).toEqual([]);
  });
});

describe("the stylesheets reach every heading", () => {
  const theme = norm(
    readFileSync("app/(storefront)/storefront-theme.css", "utf8"),
  );
  const sheets = [
    "app/(storefront)/components/homepage/homepage.css",
    "app/(storefront)/(pages)/shop/shop.css",
    "app/(storefront)/(pages)/cart/cart.css",
    "app/(storefront)/(pages)/blogs/blogs.css",
  ].map((path) => norm(readFileSync(path, "utf8")));

  it("each gated property rule names every heading and sets its property", () => {
    // The declaration must read the variable typographyCssVars writes.
    const vars = typographyCssVars({
      headingFont: "body",
      headingWeight: "bold",
      headingTracking: "wide",
    });
    const rules: Record<string, string> = {
      "sm-h-font": "font-family: var(--sm-heading-font), sans-serif;",
      "sm-h-weight": "font-weight: var(--sm-heading-weight);",
      "sm-h-upper": "text-transform: uppercase;",
      "sm-h-track": "letter-spacing: var(--sm-heading-tracking);",
    };
    for (const name of Object.keys(vars)) {
      expect(Object.values(rules).join(" ")).toContain(`var(${name})`);
    }
    for (const [cls, declaration] of Object.entries(rules)) {
      const start = theme.indexOf(`.${cls}.storefront-root :is(`);
      expect(start, cls).toBeGreaterThan(-1);
      const close = theme.indexOf(")", start);
      const list = theme.slice(start, close);
      for (const selector of HEADING_SELECTORS) {
        expect(list, `${cls} ${selector}`).toContain(selector);
      }
      const body = theme.slice(
        theme.indexOf("{", close) + 1,
        theme.indexOf("}", close),
      );
      expect(body.trim(), cls).toBe(declaration);
    }
  });

  it("any setting lets an over-long heading word wrap in its column", () => {
    const end = theme.indexOf("{ overflow-wrap: break-word; }");
    expect(end).toBeGreaterThan(-1);
    const rule = theme.slice(theme.lastIndexOf("*/", end), end);
    for (const cls of typographyRootClasses({
      headingFont: "body",
      headingScale: "large",
      headingWeight: "bold",
      headingCase: "uppercase",
      headingTracking: "wide",
    })) {
      expect(rule, cls).toContain(`.${cls}`);
    }
    for (const selector of HEADING_SELECTORS) {
      expect(rule, selector).toContain(selector);
    }
  });

  it("the scale is 1 unless a theme sets one, and halved on phones", () => {
    expect(theme).toContain(
      ".storefront-root { --sm-hs: var(--sm-heading-scale, 1); }",
    );
    expect(theme).toContain(
      "--sm-hs: calc(1 + (var(--sm-heading-scale, 1) - 1) * 0.5);",
    );
  });

  it("every size a scaled heading declares reads the scale", () => {
    const scaled = HEADING_SELECTORS.filter(
      (s) => !(UNSCALED_HEADING_SELECTORS as readonly string[]).includes(s),
    );
    for (const selector of scaled) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rule = new RegExp(
        `([^{}]*${escaped}(?![\\w-])[^{}]*)\\{([^{}]*)\\}`,
        "g",
      );
      let sizes = 0;
      for (const css of sheets) {
        for (const match of css.matchAll(rule)) {
          for (const size of match[2].matchAll(/font-size:([^;]+);/g)) {
            sizes += 1;
            expect(size[1], `${selector}: ${size[1]}`).toMatch(
              /^ calc\(.+ \* var\(--sm-hs, 1\)\)$/,
            );
          }
        }
      }
      expect(sizes, selector).toBeGreaterThan(0);
    }
  });
});
