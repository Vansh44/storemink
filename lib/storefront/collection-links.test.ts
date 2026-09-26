import { describe, expect, it } from "vitest";
import {
  collectionPath,
  legacyCategoryRedirect,
  populatedCollections,
} from "./collection-links";

const categories = [{ slug: "juices" }, { slug: "gift-boxes" }];

describe("collectionPath", () => {
  it("is /collections/<slug>, encoded", () => {
    expect(collectionPath("juices")).toBe("/collections/juices");
    expect(collectionPath("a b")).toBe("/collections/a%20b");
  });
});

describe("legacyCategoryRedirect", () => {
  it("sends a known category to its page", () => {
    expect(legacyCategoryRedirect({ category: "juices" }, categories)).toBe(
      "/collections/juices",
    );
  });

  it("carries the search, sort and filters across", () => {
    expect(
      legacyCategoryRedirect(
        { category: "gift-boxes", q: "mango", sort: "price-asc", stock: "in" },
        categories,
      ),
    ).toBe("/collections/gift-boxes?q=mango&sort=price-asc&stock=in");
  });

  it("does not redirect an unknown slug, the Other view or no category", () => {
    expect(legacyCategoryRedirect({ category: "gone" }, categories)).toBeNull();
    expect(
      legacyCategoryRedirect({ category: "uncategorized" }, categories),
    ).toBeNull();
    expect(legacyCategoryRedirect({ q: "tea" }, categories)).toBeNull();
  });

  it("uses the first of a repeated key", () => {
    expect(
      legacyCategoryRedirect(
        { category: ["juices", "gift-boxes"] },
        categories,
      ),
    ).toBe("/collections/juices");
  });
});

describe("populatedCollections", () => {
  const cats = [
    { id: "a", slug: "juices", image_url: null },
    { id: "b", slug: "snacks", image_url: null },
    { id: "c", slug: "empty", image_url: null },
  ];

  it("lists only collections with a product, dated by the newest one", () => {
    const out = populatedCollections(cats, [
      { category_id: "a", content_updated_at: "2026-02-01T00:00:00Z" },
      { category_id: "a", content_updated_at: "2026-03-01T00:00:00Z" },
      { category_id: "b", content_updated_at: null },
      { category_id: null, content_updated_at: "2026-04-01T00:00:00Z" },
    ]);
    expect(out.map((o) => o.category.slug)).toEqual(["juices", "snacks"]);
    expect(out[0].lastModified?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    // No real date means no date, never an invented one.
    expect(out[1].lastModified).toBeUndefined();
  });
});
