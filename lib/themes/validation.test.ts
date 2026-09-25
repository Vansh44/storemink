import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { THEME_DEFINITIONS } from "./index";
import type { ThemeDefinition } from "./types";
import {
  STOREFRONT_CODE_ROUTES,
  collectThemeHrefs,
  collectThemeImageUrls,
  validateThemeCatalogMeta,
  validateThemeDefinition,
  validateThemeDesign,
  validateThemeHomepage,
  validateThemeImage,
  validateThemeLinks,
  validateThemePages,
  validateThemeSampleData,
} from "./validation";

// The bundled themes are the positive cases (themes.test.ts asserts each
// returns no findings). Every test here breaks ONE rule on a clone and
// asserts that rule — and only a finding from it — is reported, so deleting a
// check makes a test fail rather than leaving the suite green.

function clone(): ThemeDefinition {
  return structuredClone(THEME_DEFINITIONS[0]);
}

function codes(findings: Array<{ code: string }>): string[] {
  return findings.map((f) => f.code);
}

describe("theme validation", () => {
  it("a bundled theme is clean", () => {
    expect(validateThemeDefinition(clone(), { bundledAssets: true })).toEqual(
      [],
    );
  });

  it("catalog: placeholder copy, short description and bad demo slug", () => {
    const theme = clone();
    theme.name = "Theme 1";
    theme.description = "Too short";
    theme.demo.slug = "demo-other";
    expect(
      codes(validateThemeCatalogMeta(theme, { bundledAssets: false })),
    ).toEqual(
      expect.arrayContaining(["name_placeholder", "description", "demo_slug"]),
    );
  });

  it("catalog: a public release must be published with a healthy demo", () => {
    const theme = clone();
    theme.catalog.visibility = "public";
    theme.release.status = "draft";
    theme.demo.status = "unavailable";
    expect(
      codes(validateThemeCatalogMeta(theme, { bundledAssets: true })),
    ).toEqual(expect.arrayContaining(["public_unpublished", "public_demo"]));
  });

  it("catalog: bundled paths are enforced only for bundled themes", () => {
    const theme = clone();
    theme.catalog.previewImage = "theme-asset://preview";
    expect(
      codes(validateThemeCatalogMeta(theme, { bundledAssets: true })),
    ).toContain("preview_path");
    expect(
      codes(validateThemeCatalogMeta(theme, { bundledAssets: false })),
    ).not.toContain("preview_path");
  });

  it("pages: a second homepage, a duplicate slug and custom code", () => {
    const theme = clone();
    const home = theme.preset.pages.find((p) => p.slug === "")!;
    theme.preset.pages.push({ ...structuredClone(home) });
    const content = theme.preset.pages.find((p) => p.slug !== "")!;
    content.sections.push({
      ...content.sections[0],
      id: "code-1",
      type: "custom_code",
    } as never);
    const found = codes(validateThemePages(theme));
    expect(found).toEqual(
      expect.arrayContaining([
        "homepage_count",
        "slug_duplicate",
        "custom_code",
      ]),
    );
  });

  it("pages: an id-based product source is refused", () => {
    const theme = clone();
    const section = theme.preset.pages
      .flatMap((p) => p.sections)
      .find((s) => s.type === "featured_products");
    expect(section).toBeDefined();
    (section!.config as unknown as Record<string, unknown>).source = "manual";
    expect(codes(validateThemePages(theme))).toContain("id_source");
  });

  it("homepage: fewer than five sections is below the floor", () => {
    const theme = clone();
    const home = theme.preset.pages.find((p) => p.slug === "")!;
    home.sections = home.sections.slice(0, 2);
    expect(codes(validateThemeHomepage(theme))).toEqual(
      expect.arrayContaining(["sections", "variety"]),
    );
  });

  it("sample: thin catalogue, dangling category and inverted price", () => {
    const theme = clone();
    const sample = theme.preset.sampleData!;
    sample.categories = sample.categories.slice(0, 2);
    sample.products = sample.products
      .slice(0, 3)
      .map((p) => ({ ...p, featured: false }));
    sample.products[0].category_slug = "nowhere";
    sample.products[1].selling_price = sample.products[1].base_price + 1;
    expect(codes(validateThemeSampleData(theme))).toEqual(
      expect.arrayContaining([
        "categories",
        "products",
        "category_ref",
        "product_price",
        "featured",
      ]),
    );
  });

  it("links: a menu link to an unseeded product is reported", () => {
    const theme = clone();
    theme.preset.menus.header.push({
      label: "Ghost",
      href: "/shop/ghost",
    } as never);
    expect(collectThemeHrefs(theme)).toContain("/shop/ghost");
    expect(codes(validateThemeLinks(theme))).toEqual(["product"]);
  });

  it("links: a nested header link is checked, a heading without one is not", () => {
    const theme = clone();
    theme.preset.menus.header.push({
      label: "More",
      href: "",
      image_url: "/themes/basket/menu.webp",
      children: [
        {
          label: "Ghosts",
          href: "",
          children: [{ label: "Ghost", href: "/shop/ghost" }],
        },
      ],
    });
    expect(collectThemeHrefs(theme)).toContain("/shop/ghost");
    expect(collectThemeHrefs(theme)).not.toContain("");
    expect(codes(validateThemeLinks(theme))).toEqual(["product"]);
    // A mega-menu tile is an image the theme renders, so it must exist too.
    expect(collectThemeImageUrls(theme)).toContain("/themes/basket/menu.webp");
  });

  it("links: a page link must reach a seeded page or a storefront route", () => {
    const theme = clone();
    theme.preset.menus.header.push(
      { label: "Lookbook", href: "/lookbook" } as never,
      { label: "Shop", href: "/shop" } as never,
      { label: "Cart", href: "/cart" } as never,
    );
    expect(validateThemeLinks(theme).map((f) => f.message)).toEqual([
      "/lookbook links to a page the theme does not seed.",
    ]);
  });

  it("links: the default footer an empty legal row falls back to is read, and policy pages are the merchant's", () => {
    const theme = clone();
    theme.preset.menus.footerLegal = [];
    theme.preset.menus.header = [];
    theme.preset.menus.footerGroups = [];
    // The storefront renders DEFAULT_MENUS here: its policy links are exempt,
    // but its other links must still resolve against the seeded pages.
    const found = validateThemeLinks(theme);
    expect(found.every((f) => !/privacy|terms|refund/.test(f.message))).toBe(
      true,
    );
  });

  it("the storefront code routes match app/(storefront)/(pages)", () => {
    const dirs = readdirSync(join(process.cwd(), "app/(storefront)/(pages)"), {
      withFileTypes: true,
    })
      .filter((d) => d.isDirectory() && !d.name.startsWith("["))
      .map((d) => d.name)
      .sort();
    expect([...STOREFRONT_CODE_ROUTES].sort()).toEqual(dirs);
  });

  it("design: bad palette value, unloaded font and illegible body text", () => {
    const theme = clone();
    theme.preset.design.palette.surface = "red";
    theme.preset.design.fonts.body = "Comic Sans";
    theme.preset.design.palette.ink = "#eeeeee";
    theme.preset.design.palette.cream = "#ffffff";
    const found = validateThemeDesign(theme);
    expect(codes(found)).toEqual(
      expect.arrayContaining(["palette", "fonts", "contrast"]),
    );
    expect(found.find((f) => f.code === "contrast")!.message).toMatch(
      /Body text on the page background/,
    );
  });

  it("design: button labels need 3:1 on the accent", () => {
    const theme = clone();
    theme.preset.design.palette.accent = "#ffffff";
    theme.preset.design.palette.onAccent = "#fafafa";
    expect(
      validateThemeDesign(theme).some((f) => /Button labels/.test(f.message)),
    ).toBe(true);
  });

  it("design: an unregistered layout variant is refused", () => {
    const theme = clone();
    theme.preset.design.layout = { header: "floating" as never };
    expect(codes(validateThemeDesign(theme))).toContain("layout_variant");
  });

  it("brand: placeholder tagline", () => {
    const theme = clone();
    theme.preset.brand.tagline = "Coming soon to you";
    expect(codes(validateThemeDesign(theme))).toContain("tagline_placeholder");
  });

  describe("images", () => {
    it("accepts a production-sized WebP", () => {
      expect(
        validateThemeImage(
          "x",
          { format: "webp", width: 1200, height: 900, bytes: 120_000 },
          { preview: true },
        ),
      ).toEqual([]);
    });

    it("refuses format, width, size and preview aspect problems", () => {
      const issues = validateThemeImage(
        "x",
        { format: "png", width: 400, height: 400, bytes: 600 * 1024 },
        { preview: true },
      );
      expect(issues.join(" ")).toMatch(/WebP or AVIF/);
      expect(issues.join(" ")).toMatch(/800px wide/);
      expect(issues.join(" ")).toMatch(/500 KiB/);
      expect(issues.join(" ")).toMatch(/4:3/);
    });
  });
});
