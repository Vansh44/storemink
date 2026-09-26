import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_DEFINITIONS } from "./index";
import {
  cleanPage,
  PADDED_PAGE_WIDTH_CONTAINERS,
  PAGE_WIDTH_CONTAINERS,
  PAGE_WIDTH_VALUE,
  pageCssVars,
  pageIssues,
  pageRootClasses,
} from "./page";
import { designToCssVars } from "./types";
import { validateThemeDesign } from "./validation";

const norm = (css: string) => css.replace(/\s+/g, " ");
const read = (path: string) => norm(readFileSync(path, "utf8"));

const SHEETS = {
  home: read("app/(storefront)/components/homepage/homepage.css"),
  shop: read("app/(storefront)/(pages)/shop/shop.css"),
  cart: read("app/(storefront)/(pages)/cart/cart.css"),
  footer: read("app/(storefront)/components/footer/Footer.module.css"),
  header: read("app/(storefront)/components/header/Header.module.css"),
};
const ALL = Object.values(SHEETS).join(" ");

/** The body of the rule whose selector is exactly `selector` — not a longer
 *  selector that merely ends with it. */
function ruleBody(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[}/] )${escaped} \\{([^}]*)\\}`).exec(css);
  return match ? match[1] : null;
}

describe("page width and spacing are opt-in", () => {
  it("emit nothing when a theme sets nothing", () => {
    expect(pageCssVars(undefined)).toEqual({});
    expect(pageCssVars({})).toEqual({});
    expect(pageRootClasses(undefined)).toEqual([]);
    expect(pageRootClasses({})).toEqual([]);
  });

  it("no bundled theme changes: none writes a page variable", () => {
    for (const theme of THEME_DEFINITIONS) {
      const vars = designToCssVars(theme.preset.design, "#000000");
      expect(
        Object.keys(vars).filter((k) =>
          /^--sm-(page|section-gap|grid-gap)/.test(k),
        ),
      ).toEqual([]);
    }
  });

  it("a standard section gap is today's gap, so it emits nothing", () => {
    expect(pageCssVars({ sectionGap: "standard" })).toEqual({});
  });
});

describe("pageCssVars and root classes", () => {
  it("writes only the chosen settings", () => {
    expect(
      pageCssVars({ width: "narrow", sectionGap: "airy", gridGap: "tight" }),
    ).toEqual({
      "--sm-page-width": "1080px",
      "--sm-section-gap": "clamp(64px, 9vw, 120px)",
      "--sm-grid-gap": "12px",
    });
    expect(pageCssVars({ width: "full" })).toEqual({
      "--sm-page-width": "100%",
    });
    expect(pageCssVars({ gridGap: "standard" })).toEqual({
      "--sm-grid-gap": "22px",
    });
  });

  it("only a width needs a root class", () => {
    expect(pageRootClasses({ width: "wide" })).toEqual(["sm-page-width"]);
    expect(pageRootClasses({ sectionGap: "airy", gridGap: "roomy" })).toEqual(
      [],
    );
  });

  it("drops unknown settings rather than writing them into a style", () => {
    expect(
      cleanPage({ width: "1600px", gutter: "x", sectionGap: "compact" }),
    ).toEqual({ sectionGap: "compact" });
    expect(pageCssVars({ width: "wide; color: red" } as never)).toEqual({});
  });

  it("designToCssVars carries a theme's page settings", () => {
    const theme = THEME_DEFINITIONS[0];
    const vars = designToCssVars(
      { ...theme.preset.design, page: { width: "wide" } },
      "#000000",
    );
    expect(vars["--sm-page-width"]).toBe(PAGE_WIDTH_VALUE.wide);
  });
});

describe("pageIssues", () => {
  it("names unknown keys and values, and ignores an absent block", () => {
    expect(pageIssues(undefined)).toEqual([]);
    expect(pageIssues("wide")).toEqual(["page must be an object."]);
    const issues = pageIssues({ width: "huge", gutter: "large" }).join(" ");
    expect(issues).toContain('page.width "huge"');
    expect(issues).toContain("page.gutter is not");
    expect(pageIssues({ width: "wide", sectionGap: "airy" })).toEqual([]);
  });

  it("theme validation reports it under the page code", () => {
    const theme = THEME_DEFINITIONS[0];
    const codes = (page: object) =>
      validateThemeDesign({
        ...theme,
        preset: { ...theme.preset, design: { ...theme.preset.design, page } },
      }).filter((f) => f.code === "page");
    expect(codes({ width: "huge" })).toHaveLength(1);
    expect(codes({ width: "wide" })).toHaveLength(0);
  });
});

describe("the stylesheets follow the page settings", () => {
  it("every page-wide container caps at the page width, today's width unset", () => {
    for (const selector of PAGE_WIDTH_CONTAINERS) {
      const bodies = Object.values(SHEETS)
        .map((css) => ruleBody(css, selector))
        .filter((b): b is string => b !== null);
      expect(bodies.length, selector).toBeGreaterThan(0);
      expect(bodies.join(" "), selector).toMatch(
        /max-width: var\(--sm-page-width, \d+px\);/,
      );
    }
  });

  it("containers padded inside their cap add that padding to the page width", () => {
    const expected: Record<string, [string, string]> = {
      // Each base + 128 is today's width: 1400, 1480, 1180.
      ".mainGrid": ["footer", "1272px"],
      ".bottomSection": ["footer", "1272px"],
      ".sm-pdp-editorial .shop-main.pdp-page": ["shop", "1352px"],
      ".sm-storefront-grocery .gpdp-main": ["shop", "1052px"],
    };
    expect(Object.keys(expected).sort()).toEqual(
      [...PADDED_PAGE_WIDTH_CONTAINERS].sort(),
    );
    for (const [selector, [sheet, base]] of Object.entries(expected)) {
      expect(
        ruleBody(SHEETS[sheet as keyof typeof SHEETS], selector),
        selector,
      ).toContain(`max-width: calc(var(--sm-page-width, ${base}) + 128px);`);
    }
    // Their 64px padding is what the 128px accounts for.
    for (const selector of [".mainGrid", ".bottomSection"]) {
      expect(ruleBody(SHEETS.footer, selector), selector).toMatch(
        /padding: \d+px 64px/,
      );
    }
    expect(SHEETS.shop).toContain(
      "@media (min-width: 768px) { .shop-main { padding: 140px 64px 96px; } }",
    );
  });

  it("the editorial product page is centred and does not cap the shop listing", () => {
    // It once matched every .shop-main and set no margins, pinning the shop
    // and product pages to the left on screens wider than 1480px.
    expect(ruleBody(SHEETS.shop, ".sm-pdp-editorial .shop-main")).toBeNull();
    expect(
      ruleBody(SHEETS.shop, ".sm-pdp-editorial .shop-main.pdp-page"),
    ).toContain("margin-inline: auto;");
  });

  it("sections and the shop listing reach the width through their padding", () => {
    const pad =
      "max( clamp(20px, 5vw, 64px), calc((100% - var(--sm-page-width, 100%)) / 2) )";
    expect(ruleBody(SHEETS.home, ".home-section")).toContain(
      `padding-inline: ${pad};`,
    );
    expect(ruleBody(SHEETS.shop, ".shop-panel-body")).toContain(
      "padding: 24px max(clamp(20px, 5vw, 64px), calc((100% - var(--sm-page-width, 100%)) / 2)) 24px;",
    );
  });

  it("a Full width section opts out of the theme width, only when one is set", () => {
    expect(
      ruleBody(
        SHEETS.home,
        ".sm-page-width.storefront-root .home-section.is-fullbleed",
      )?.trim(),
    ).toBe("--sm-page-width: 100%;");
  });

  it("the header lines up with the page width on desktop only", () => {
    const at = SHEETS.header.indexOf(
      "@media (min-width: 1025px) { :global(.sm-page-width) .header {",
    );
    expect(at).toBeGreaterThan(-1);
    expect(SHEETS.header.slice(at, SHEETS.header.indexOf("}", at))).toContain(
      "padding-inline: max( clamp(20px, 5vw, 64px), calc((100% - var(--sm-page-width)) / 2) );",
    );
  });

  it("the section gap and grid gap reach every place they are measured", () => {
    const gap = "var(--sm-section-gap, clamp(40px, 6vw, 72px))";
    const sections = ruleBody(SHEETS.home, ".home-sections") ?? "";
    expect(sections).toContain(`gap: ${gap};`);
    expect(sections).toContain(`padding: ${gap} 0;`);
    expect(
      ruleBody(SHEETS.home, ".home-sections > .home-custom-code:first-child"),
    ).toContain(`margin-top: calc(-1 * ${gap});`);

    expect(ruleBody(SHEETS.home, ".home-product-scroll")).toContain(
      "gap: var(--sm-grid-gap, 22px);",
    );
    // A carousel card's width subtracts two gaps, so it must read the same one.
    expect(ruleBody(SHEETS.home, ".home-product-scroll .shop-card")).toContain(
      "flex: 0 0 calc((100% - 2 * var(--sm-grid-gap, 22px)) / 3);",
    );
    expect(ruleBody(SHEETS.shop, ".shop-grid")).toContain(
      "gap: var(--sm-grid-gap, 28px);",
    );
    expect(ruleBody(SHEETS.shop, ".shop-listing .shop-grid")).toContain(
      "gap: var(--sm-grid-gap, 22px);",
    );
  });

  it("every variable the settings write is read somewhere", () => {
    const vars = pageCssVars({
      width: "wide",
      sectionGap: "airy",
      gridGap: "roomy",
    });
    for (const name of Object.keys(vars)) {
      expect(ALL, name).toContain(`var(${name}`);
    }
  });

  it("the storefront layout puts the root class on the themed root", () => {
    expect(read("app/(storefront)/layout.tsx")).toContain(
      "...pageRootClasses(design?.page)",
    );
  });
});
