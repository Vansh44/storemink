import { describe, expect, it } from "vitest";
import { getThemeDefinition } from "@/lib/themes";
import { themeDefinitionToPackageV2, type ThemePackageV2 } from "./contracts";
import { diffThemePackages } from "./diff";

function clone(pkg: ThemePackageV2): ThemePackageV2 {
  return structuredClone(pkg);
}

const basket = themeDefinitionToPackageV2(getThemeDefinition("basket"));

describe("diffThemePackages", () => {
  it("reports a package compared with itself as identical", () => {
    const diff = diffThemePackages(basket, clone(basket));
    expect(diff.identical).toBe(true);
    expect(diff.tokens).toEqual([]);
    expect(diff.pages).toEqual([]);
  });

  it("names each moved design token with its before and after value", () => {
    const next = clone(basket);
    const palette = next.definition.preset.design!.palette as unknown as Record<
      string,
      string
    >;
    const key = Object.keys(palette)[0];
    palette[key] = "#123456";
    next.definition.preset.design!.fonts.display = "var(--font-fraunces)";
    const diff = diffThemePackages(basket, next);
    expect(diff.identical).toBe(false);
    expect(diff.tokens).toEqual(
      expect.arrayContaining([
        {
          group: "palette",
          key,
          before: (
            basket.definition.preset.design!.palette as unknown as Record<
              string,
              string
            >
          )[key],
          after: "#123456",
        },
        expect.objectContaining({ group: "fonts", key: "display" }),
      ]),
    );
  });

  it("reports added, removed and changed pages by slug, ignoring section ids", () => {
    const next = clone(basket);
    const pages = next.definition.preset.pages;
    const home = pages.find((p) => p.slug === "")!;
    // Regenerated ids are not a change.
    home.sections = home.sections.map((s) => ({ ...s, id: `x-${s.id}` }));
    const removed = pages.find((p) => p.slug !== "")!;
    next.definition.preset.pages = pages.filter((p) => p !== removed);
    next.definition.preset.pages.push({
      slug: "journal",
      title: "Journal",
      sections: [],
    } as never);
    const diff = diffThemePackages(basket, next);
    expect(diff.pages.find((p) => p.slug === "")).toBeUndefined();
    expect(diff.pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "journal", change: "added" }),
        expect.objectContaining({ slug: removed.slug, change: "removed" }),
      ]),
    );
  });

  it("reports a reordered page as changed with both section sequences", () => {
    const next = clone(basket);
    const home = next.definition.preset.pages.find((p) => p.slug === "")!;
    home.sections = [...home.sections].reverse();
    const diff = diffThemePackages(basket, next);
    const change = diff.pages.find((p) => p.slug === "");
    expect(change?.change).toBe("changed");
    expect(change?.after).toEqual([...(change?.before ?? [])].reverse());
  });

  it("reports catalogue, navigation and gap changes", () => {
    const next = clone(basket);
    const products = next.definition.preset.sampleData!.products;
    const dropped = products.shift()!;
    products[0] = { ...products[0], selling_price: 1 };
    next.definition.preset.menus.header = [];
    next.capabilityGaps = [
      {
        code: "unsupported_interaction",
        requestedCapability: "Parallax hero",
        blocking: false,
      } as never,
    ];
    const diff = diffThemePackages(basket, next);
    expect(diff.products.removed).toContain(dropped.name);
    expect(diff.products.changed).toContain(products[0].name);
    expect(diff.navigationChanged).toBe(true);
    expect(diff.gaps.added).toEqual(["unsupported_interaction: Parallax hero"]);
  });
});
