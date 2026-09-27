import { describe, expect, it, vi } from "vitest";
import { getThemeDefinition } from "@/lib/themes";
import { themeDefinitionToPackageV2 } from "./contracts";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

const { previewPagesFor, rewriteThemeAssets, PREVIEW_MISSING_PATH } =
  await import("./preview");

describe("previewPagesFor", () => {
  it("resolves the six review surfaces against the package", () => {
    const pkg = themeDefinitionToPackageV2(getThemeDefinition("basket"));
    const pages = previewPagesFor(pkg);
    expect(pages.map((p) => p.surface)).toEqual([
      "home",
      "shop",
      "product",
      "cart",
      "content",
      "not_found",
    ]);
    const product = pkg.definition.preset.sampleData!.products[0];
    expect(pages[2].path).toBe(`/shop/${product.slug}`);
    expect(pages.at(-1)!.path).toBe(PREVIEW_MISSING_PATH);
  });

  it("omits a surface the package cannot show rather than linking a 404", () => {
    // A deep copy: the package shares the bundled definition's objects.
    const pkg = structuredClone(
      themeDefinitionToPackageV2(getThemeDefinition("basket")),
    );
    pkg.definition.preset.sampleData = undefined;
    pkg.definition.preset.pages = pkg.definition.preset.pages.filter(
      (p) => p.slug === "",
    );
    expect(previewPagesFor(pkg).map((p) => p.surface)).toEqual([
      "home",
      "shop",
      "cart",
      "not_found",
    ]);
  });
});

describe("rewriteThemeAssets", () => {
  it("replaces every theme-asset reference and blanks an unknown slot", () => {
    const def = structuredClone(getThemeDefinition("basket"));
    const home = def.preset.pages.find((p) => p.slug === "")!;
    (home.sections[0].config as unknown as Record<string, unknown>).image_url =
      "theme-asset://hero";
    def.preset.sampleData!.products[0].image_url = "theme-asset://product";
    def.preset.sampleData!.products[1].image_url = "theme-asset://missing";
    const out = rewriteThemeAssets(
      def,
      new Map([
        ["hero", "/api/theme-studio/placeholders/a"],
        ["product", "/api/theme-studio/placeholders/b"],
      ]),
    );
    expect(JSON.stringify(out)).not.toContain("theme-asset://");
    const outHome = out.preset.pages.find((p) => p.slug === "")!;
    expect(
      (outHome.sections[0].config as unknown as Record<string, unknown>)
        .image_url,
    ).toBe("/api/theme-studio/placeholders/a");
    expect(out.preset.sampleData!.products[0].image_url).toBe(
      "/api/theme-studio/placeholders/b",
    );
    expect(out.preset.sampleData!.products[1].image_url).toBe("");
    // The input is not mutated.
    expect(def.preset.sampleData!.products[0].image_url).toBe(
      "theme-asset://product",
    );
  });
});
