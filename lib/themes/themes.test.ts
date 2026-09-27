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
import {
  THEME_IMAGE_RULES,
  collectThemeImageUrls,
  validateThemeCatalogMeta,
  validateThemeDefinition,
  validateThemeImage,
} from "./validation";

const MAX_ASSET_BYTES = THEME_IMAGE_RULES.maxBytes;

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
      expect(
        validateThemeCatalogMeta(theme, { bundledAssets: true }),
        theme.id,
      ).toEqual([]);
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
      // Every package rule lives in lib/themes/validation.ts so the Theme
      // Studio acceptance gates run the SAME checks over generated packages.
      it("passes every package-level validation rule", () => {
        expect(validateThemeDefinition(theme, { bundledAssets: true })).toEqual(
          [],
        );
      });

      it("every referenced image exists under public/", () => {
        for (const url of collectThemeImageUrls(theme)) {
          expect(url.startsWith(`/themes/${theme.id}/`), url).toBe(true);
          expect(
            existsSync(join(process.cwd(), "public", url)),
            `missing asset: public${url}`,
          ).toBe(true);
        }
      });

      it("ships optimized, catalog-ready image assets", async () => {
        for (const url of collectThemeImageUrls(theme)) {
          const assetPath = join(process.cwd(), "public", url);
          const metadata = await sharp(assetPath).metadata();
          const size = statSync(assetPath).size;
          expect(size, `${url}: bytes`).toBeLessThanOrEqual(MAX_ASSET_BYTES);
          expect(
            validateThemeImage(
              url,
              {
                format: metadata.format,
                width: metadata.width,
                height: metadata.height,
                bytes: size,
              },
              { preview: url === theme.catalog.previewImage },
            ),
          ).toEqual([]);
        }
      });

      it("flattens into the full --sm-* token override set", () => {
        const vars = designToCssVars(
          theme.preset.design,
          theme.preset.brand.primaryColor,
        );
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
        expect(vars["--brand-primary"]).toBe(
          theme.preset.design.palette.accent ?? theme.preset.brand.primaryColor,
        );
      });
    });
  }
});
