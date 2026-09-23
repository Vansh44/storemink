import { describe, it, expect } from "vitest";
import { existsSync, statSync } from "fs";
import { join } from "path";
import sharp from "sharp";
import { THEME_DEFINITIONS, getThemeDefinition } from "./index";
import {
  THEME_META,
  DEFAULT_THEME_ID,
  canPreviewTheme,
  isThemeSelectable,
  newestThemesFirst,
  readThemeSelection,
  themeCategoriesFor,
} from "./meta";
import { designToCssVars } from "./types";
import type { ThemeDefinition } from "./types";
import { validateSections, validatePageSlug } from "@/lib/sections/registry";

// Every palette slot a theme MUST fill (accent/accentDeep are optional — the
// --brand-primary chain drives them). Mirrors ThemePalette in types.ts.
const REQUIRED_PALETTE_KEYS = [
  "cream",
  "creamDeep",
  "surface",
  "ink",
  "inkSoft",
  "inkFaint",
  "taupe",
  "sand",
  "butter",
  "border",
  "tile",
  "accentWarm",
  "onAccent",
  "onInk",
  "shadowRgb",
  "success",
  "successSoft",
  "error",
  "errorSoft",
  "star",
  "highlight",
] as const;

// A CSS colour value we're willing to inject into a style attribute: a hex,
// or a "r, g, b" triple (shadowRgb). Fonts must reference a loaded --font-*.
const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const RGB_TRIPLE_RE = /^\d{1,3},\s*\d{1,3},\s*\d{1,3}$/;
const THEME_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const PLACEHOLDER_COPY_RE = /\b(?:coming soon|lorem ipsum|theme \d+)\b/i;
const MAX_ASSET_BYTES = 500 * 1024;
const MAX_PREVIEW_BYTES = 250 * 1024;
const MIN_ASSET_WIDTH = 800;
const MIN_PREVIEW_HEIGHT = 600;
const PREVIEW_ASPECT_RATIO = 4 / 3;
const ASPECT_RATIO_TOLERANCE = 0.01;

function collectThemeImageUrls(theme: ThemeDefinition): Set<string> {
  const urls = new Set<string>([
    theme.catalog.previewImage,
    ...theme.catalog.screenshots.map((screenshot) => screenshot.src),
  ]);

  for (const product of theme.preset.sampleData?.products ?? []) {
    urls.add(product.image_url);
    for (const url of product.images ?? []) urls.add(url);
    for (const variant of product.variants ?? []) {
      for (const url of variant.images ?? []) urls.add(url);
    }
  }
  for (const category of theme.preset.sampleData?.categories ?? []) {
    if (category.image_url) urls.add(category.image_url);
  }

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "image_url" && typeof nested === "string" && nested) {
        urls.add(nested);
      } else {
        visit(nested);
      }
    }
  };
  for (const page of theme.preset.pages) {
    for (const section of page.sections) visit(section.config);
  }

  return urls;
}

// ---------------------------------------------------------------------------
// CI guards for theme packages: every theme must seed cleanly (strict publish
// validation), stay inside the v1 constraints (no id-based sources, no blog
// sections), and reference only bundled images that actually exist.
// ---------------------------------------------------------------------------

describe("theme registry", () => {
  it("registers the catalog's current immutable release", () => {
    expect(
      new Set(
        THEME_DEFINITIONS.map(
          (theme) => `${theme.id}@${theme.release.version}`,
        ),
      ).size,
    ).toBe(THEME_DEFINITIONS.length);
    for (const meta of THEME_META) {
      expect(
        THEME_DEFINITIONS.some(
          (theme) =>
            theme.id === meta.id &&
            theme.release.version === meta.release.version,
        ),
        `${meta.id}@${meta.release.version}`,
      ).toBe(true);
    }
    expect(getThemeDefinition("nope").id).toBe(DEFAULT_THEME_ID);
    expect(getThemeDefinition(undefined).id).toBe(DEFAULT_THEME_ID);
    expect(getThemeDefinition("basket", "1.0.0").release.version).toBe("1.0.0");
    expect(getThemeDefinition("basket", "0.0.0").release.version).toBe(
      THEME_META.find((theme) => theme.id === "basket")?.release.version,
    );
  });

  it("ships unique, catalog-safe metadata", () => {
    expect(new Set(THEME_META.map((theme) => theme.id)).size).toBe(
      THEME_META.length,
    );
    expect(
      new Set(THEME_META.map((theme) => theme.name.trim().toLowerCase())).size,
    ).toBe(THEME_META.length);
    for (const theme of THEME_META) {
      expect(theme.id, "theme id").toMatch(THEME_ID_RE);
      expect(theme.name.trim().length, `${theme.id}: name`).toBeGreaterThan(0);
      expect(
        theme.description.trim().length,
        `${theme.id}: description`,
      ).toBeGreaterThanOrEqual(40);
      expect(theme.name, `${theme.id}: placeholder name`).not.toMatch(
        PLACEHOLDER_COPY_RE,
      );
      expect(
        theme.description,
        `${theme.id}: placeholder description`,
      ).not.toMatch(PLACEHOLDER_COPY_RE);
      expect(theme.engine.id).toMatch(THEME_ID_RE);
      expect(theme.engine.version).toBeGreaterThan(0);
      expect(theme.release.version).toMatch(SEMVER_RE);
      expect(theme.release.notes.length).toBeGreaterThan(0);
      expect(theme.catalog.industries.length).toBeGreaterThan(0);
      expect(theme.catalog.catalogSizes.length).toBeGreaterThan(0);
      expect(theme.catalog.features.length).toBeGreaterThan(0);
      expect(theme.catalog.keywords.length).toBeGreaterThan(0);
      expect(new Set(theme.catalog.industries).size).toBe(
        theme.catalog.industries.length,
      );
      expect(new Set(theme.catalog.catalogSizes).size).toBe(
        theme.catalog.catalogSizes.length,
      );
      expect(new Set(theme.catalog.features).size).toBe(
        theme.catalog.features.length,
      );
      expect(theme.catalog.previewImage).toBe(
        `/themes/${theme.id}/preview.webp`,
      );
      expect(theme.catalog.screenshots.length).toBeGreaterThan(0);
      for (const screenshot of theme.catalog.screenshots) {
        expect(screenshot.src.startsWith(`/themes/${theme.id}/`)).toBe(true);
        expect(screenshot.alt.trim().length).toBeGreaterThanOrEqual(15);
      }
      if (theme.catalog.visibility === "public") {
        expect(theme.release.status).toBe("published");
        expect(theme.release.releasedAt, `${theme.id}: release date`).toMatch(
          /^\d{4}-\d{2}-\d{2}$/,
        );
        expect(theme.demo.status).toBe("healthy");
      }
      if (theme.release.status === "blocked") {
        expect(theme.catalog.visibility).not.toBe("public");
      }
    }
    const categories = themeCategoriesFor(THEME_META);
    expect(categories[0]).toEqual({ id: "all", label: "All" });
    expect(new Set(categories.map((filter) => filter.id)).size).toBe(
      categories.length,
    );
    const newestFirst = newestThemesFirst(THEME_META.filter(isThemeSelectable));
    const releaseDates = newestFirst.map(
      (theme) => theme.release.releasedAt ?? "",
    );
    expect(releaseDates).toEqual(
      [...releaseDates].sort((a, b) => b.localeCompare(a)),
    );
    const basketMeta = THEME_META.find((theme) => theme.id === "basket")!;
    expect(isThemeSelectable(basketMeta)).toBe(true);
    expect(canPreviewTheme(basketMeta)).toBe(false);
    const studioMeta = THEME_META.find((theme) => theme.id === "studio")!;
    expect(studioMeta.release.status).toBe("published");
    expect(studioMeta.catalog.visibility).toBe("public");
    expect(isThemeSelectable(studioMeta)).toBe(true);
    expect(canPreviewTheme(studioMeta)).toBe(true);
    const ritualMeta = THEME_META.find((theme) => theme.id === "ritual")!;
    expect(ritualMeta.release.status).toBe("published");
    expect(ritualMeta.catalog.visibility).toBe("public");
    expect(isThemeSelectable(ritualMeta)).toBe(true);
    expect(canPreviewTheme(ritualMeta)).toBe(true);
    const vitrineMeta = THEME_META.find((theme) => theme.id === "vitrine")!;
    expect(vitrineMeta.release.status).toBe("published");
    expect(vitrineMeta.release.releasedAt).toBe("2026-08-23");
    expect(vitrineMeta.catalog.visibility).toBe("public");
    expect(isThemeSelectable(vitrineMeta)).toBe(true);
    expect(canPreviewTheme(vitrineMeta)).toBe(true);
  });

  it("reads pinned installations and legacy template ids", () => {
    expect(
      readThemeSelection({
        template: "ignored-legacy-value",
        theme: { presetId: "basket", presetVersion: "1.0.0" },
      }),
    ).toEqual({ id: "basket", version: "1.0.0" });
    expect(readThemeSelection({ template: "basket" })).toEqual({
      id: "basket",
    });
    expect(
      readThemeSelection({
        theme: { presetId: "runtime-theme", presetVersion: "1.2.3" },
      }),
    ).toEqual({ id: "runtime-theme", version: "1.2.3" });
    expect(
      readThemeSelection({ theme: { presetId: "Unknown Theme" } }),
    ).toBeNull();
    expect(readThemeSelection(null)).toBeNull();
  });

  for (const theme of THEME_DEFINITIONS) {
    describe(`theme: ${theme.id}`, () => {
      it("includes the homepage sentinel and valid page slugs", () => {
        expect(theme.preset.pages.filter((p) => p.slug === "")).toHaveLength(1);
        expect(new Set(theme.preset.pages.map((p) => p.slug)).size).toBe(
          theme.preset.pages.length,
        );
        for (const p of theme.preset.pages) {
          expect(p.title.trim().length, `${p.slug}: title`).toBeGreaterThan(0);
          expect(
            p.seo_description?.trim().length,
            `${p.slug || "(home)"}: seo_description`,
          ).toBeGreaterThanOrEqual(20);
          expect(new Set(p.sections.map((s) => s.id)).size).toBe(
            p.sections.length,
          );
          if (p.slug === "") continue;
          expect(validatePageSlug(p.slug), p.slug).toEqual({ slug: p.slug });
        }
      });

      it("authors a substantial, varied homepage", () => {
        const homepage = theme.preset.pages.find((p) => p.slug === "")!;
        const enabled = homepage.sections.filter((section) => section.enabled);
        expect(enabled.length).toBeGreaterThanOrEqual(5);
        expect(
          new Set(enabled.map((section) => section.type)).size,
        ).toBeGreaterThanOrEqual(4);
      });

      it("every page passes STRICT publish validation", () => {
        for (const p of theme.preset.pages) {
          const r = validateSections(p.sections, { mode: "publish" });
          expect(
            "sections" in r,
            `${theme.id}/${p.slug || "(home)"}: ${"error" in r ? r.error : ""}`,
          ).toBe(true);
        }
      });

      it("uses only non-id sources and no blog sections (v1 constraint)", () => {
        for (const p of theme.preset.pages) {
          for (const s of p.sections) {
            expect(s.type, `${p.slug}/${s.id}`).not.toBe("latest_blogs");
            const c = s.config as unknown as Record<string, unknown>;
            if (s.type === "featured_products") {
              expect(c.source).toBe("featured");
              expect(c.product_ids).toEqual([]);
            }
            if (s.type === "shop_by_category") {
              expect(c.source).toBe("all");
            }
          }
        }
      });

      it("sample product/category slugs are unique and cross-linked", () => {
        const sample = theme.preset.sampleData;
        expect(
          sample,
          "sample data is required for a credible demo",
        ).toBeDefined();
        if (!sample) return;
        expect(sample.categories.length).toBeGreaterThanOrEqual(4);
        expect(sample.products.length).toBeGreaterThanOrEqual(8);
        const catSlugs = sample.categories.map((c) => c.slug);
        expect(new Set(catSlugs).size).toBe(catSlugs.length);
        const productSlugs = sample.products.map((p) => p.slug);
        expect(new Set(productSlugs).size).toBe(productSlugs.length);
        for (const p of sample.products) {
          expect(catSlugs, `${p.slug} → ${p.category_slug}`).toContain(
            p.category_slug,
          );
          expect(p.name.trim().length, `${p.slug}: name`).toBeGreaterThan(0);
          expect(
            p.description.trim().length,
            `${p.slug}: description`,
          ).toBeGreaterThanOrEqual(20);
          expect(p.base_price, `${p.slug}: base_price`).toBeGreaterThan(0);
          expect(p.selling_price, `${p.slug}: selling_price`).toBeGreaterThan(
            0,
          );
          expect(
            p.selling_price,
            `${p.slug}: selling price cannot exceed base price`,
          ).toBeLessThanOrEqual(p.base_price);
        }
        // Featured sections need featured products to look alive.
        expect(sample.products.some((p) => p.featured)).toBe(true);
      });

      it("category and product links resolve to seeded slugs", () => {
        // A nav item that NAMES a category but links to bare /shop lands on the
        // "All" tab and silently ignores the word the shopper clicked — the
        // shop page reads ?category=<slug>. Same for a tile captioned with a
        // product: /shop/<slug> must be a product this theme actually seeds.
        const sample = theme.preset.sampleData;
        const categorySlugs = new Set(
          (sample?.categories ?? []).map((c) => c.slug),
        );
        const productSlugs = new Set(
          (sample?.products ?? []).map((p) => p.slug),
        );

        const hrefs: string[] = [];
        const { header, footerGroups, footerLegal } = theme.preset.menus;
        for (const l of header) hrefs.push(l.href);
        for (const g of footerGroups)
          for (const l of g.links) hrefs.push(l.href);
        for (const l of footerLegal) hrefs.push(l.href);
        const visit = (value: unknown): void => {
          if (Array.isArray(value)) {
            for (const item of value) visit(item);
            return;
          }
          if (!value || typeof value !== "object") return;
          for (const [key, nested] of Object.entries(value)) {
            if (
              (key === "href" || key === "cta_href") &&
              typeof nested === "string" &&
              nested
            ) {
              hrefs.push(nested);
            } else {
              visit(nested);
            }
          }
        };
        for (const page of theme.preset.pages) {
          for (const section of page.sections) visit(section.config);
        }

        for (const href of hrefs) {
          const category = href.match(/^\/shop\?category=([^&]+)$/);
          if (category) {
            expect(
              categorySlugs.has(category[1]),
              `${href} -> no seeded category "${category[1]}"`,
            ).toBe(true);
            continue;
          }
          const product = href.match(/^\/shop\/([^/?#]+)$/);
          if (product) {
            expect(
              productSlugs.has(product[1]),
              `${href} -> no seeded product "${product[1]}"`,
            ).toBe(true);
          }
        }
      });

      it("every referenced image exists under public/", () => {
        const urls = collectThemeImageUrls(theme);
        for (const url of urls) {
          expect(url.startsWith(`/themes/${theme.id}/`), url).toBe(true);
          expect(
            existsSync(join(process.cwd(), "public", url)),
            `missing asset: public${url}`,
          ).toBe(true);
        }
      });

      it("ships optimized, catalog-ready image assets", async () => {
        const urls = collectThemeImageUrls(theme);

        for (const url of urls) {
          const assetPath = join(process.cwd(), "public", url);
          const metadata = await sharp(assetPath).metadata();
          const size = statSync(assetPath).size;
          expect(["webp", "avif"], url).toContain(metadata.format);
          expect(metadata.width, `${url}: width`).toBeGreaterThanOrEqual(
            MIN_ASSET_WIDTH,
          );
          expect(size, `${url}: bytes`).toBeLessThanOrEqual(MAX_ASSET_BYTES);

          if (url === theme.catalog.previewImage) {
            expect(metadata.height, `${url}: height`).toBeGreaterThanOrEqual(
              MIN_PREVIEW_HEIGHT,
            );
            expect(size, `${url}: preview bytes`).toBeLessThanOrEqual(
              MAX_PREVIEW_BYTES,
            );
            expect(
              Math.abs(
                (metadata.width ?? 0) / (metadata.height ?? 1) -
                  PREVIEW_ASPECT_RATIO,
              ),
              `${url}: preview aspect ratio tolerance`,
            ).toBeLessThanOrEqual(ASPECT_RATIO_TOLERANCE);
          }
        }
      });

      it("demo slug follows the demo- convention", () => {
        expect(theme.demo.slug).toBe(`demo-${theme.id}`);
      });

      it("ships a complete, injectable design (palette + fonts + shape)", () => {
        expect(
          theme.preset.brand.tagline?.trim().length,
          "brand.tagline",
        ).toBeGreaterThanOrEqual(10);
        expect(
          theme.preset.brand.tagline,
          "brand.tagline placeholder",
        ).not.toMatch(PLACEHOLDER_COPY_RE);
        expect(
          theme.preset.brand.blurb?.trim().length,
          "brand.blurb",
        ).toBeGreaterThanOrEqual(40);
        expect(theme.preset.brand.blurb, "brand.blurb placeholder").not.toMatch(
          PLACEHOLDER_COPY_RE,
        );
        const { palette, fonts, shape } = theme.preset.design;
        for (const key of REQUIRED_PALETTE_KEYS) {
          const v = palette[key];
          expect(typeof v === "string" && v.length > 0, `palette.${key}`).toBe(
            true,
          );
          if (key === "shadowRgb") {
            expect(RGB_TRIPLE_RE.test(v as string), `shadowRgb="${v}"`).toBe(
              true,
            );
          } else {
            expect(COLOR_RE.test(v as string), `${key}="${v}"`).toBe(true);
          }
        }
        // Fonts must point at a next/font variable loaded in app/layout.tsx.
        expect(fonts.body).toMatch(/^var\(--font-[a-z-]+\)$/);
        expect(fonts.display).toMatch(/^var\(--font-[a-z-]+\)$/);
        // Shape values are non-empty CSS lengths.
        for (const k of ["card", "control", "sm", "pill"] as const) {
          expect(shape[k], `shape.${k}`).toMatch(/^\d/);
        }
        // Layout colours are injected inline — strict hex only.
        const layout = theme.preset.design.layout;
        if (layout?.headerBackground) {
          expect(COLOR_RE.test(layout.headerBackground)).toBe(true);
        }
        if (layout?.headerForeground) {
          expect(COLOR_RE.test(layout.headerForeground)).toBe(true);
        }
        if (layout?.header) {
          expect(["classic", "market", "centered", "minimal"]).toContain(
            layout.header,
          );
        }
        if (layout?.card) {
          expect([
            "classic",
            "quick_add",
            "overlay",
            "framed",
            "grocery",
          ]).toContain(layout.card);
        }
        if (layout?.productDetail) {
          expect(["classic", "grocery", "editorial"]).toContain(
            layout.productDetail,
          );
        }
        if (layout?.cart) {
          expect(["classic", "grocery", "compact"]).toContain(layout.cart);
        }
        if (layout?.footer) {
          expect(["rich", "minimal", "editorial"]).toContain(layout.footer);
        }
      });

      it("flattens into the full --sm-* token override set", () => {
        const vars = designToCssVars(
          theme.preset.design,
          theme.preset.brand.primaryColor,
        );
        // Core tokens the storefront cascade depends on.
        for (const token of [
          "--sm-cream",
          "--sm-ink",
          "--sm-surface",
          "--sm-on-accent",
          "--sm-shadow-rgb",
          "--font-outfit",
          "--font-stick-no-bills",
          "--sm-radius-card",
        ]) {
          expect(vars[token], token).toBeTruthy();
        }
        // --brand-primary defaults to the store colour when no fixed accent.
        expect(vars["--brand-primary"]).toBe(
          theme.preset.design.palette.accent ?? theme.preset.brand.primaryColor,
        );
      });
    });
  }
});
