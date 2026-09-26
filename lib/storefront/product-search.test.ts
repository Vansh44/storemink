import { describe, expect, it } from "vitest";
import {
  matchesProductQuery,
  productMatchRank,
  rankCategories,
  rankProducts,
} from "./product-search";

const products = [
  {
    name: "Linen shirt",
    description: "Breathable summer weave",
    category: "Shirts",
  },
  {
    name: "Denim jacket",
    description: "Pairs with a linen shirt",
    category: "Jackets",
  },
  { name: "Canvas tote", description: null, category: "Bags" },
  {
    name: "Silk scarf",
    description: "Hand-rolled edges",
    category: "Accessories",
  },
  { name: "Shirt dress", description: "Cotton poplin", category: "Dresses" },
];

describe("matchesProductQuery", () => {
  it("is the shop grid's rule: one phrase in name, description or category", () => {
    expect(matchesProductQuery(products[0], "LINEN")).toBe(true);
    expect(matchesProductQuery(products[1], "linen shirt")).toBe(true); // description
    expect(matchesProductQuery(products[2], "bag")).toBe(true); // category
    expect(matchesProductQuery(products[2], "linen")).toBe(false);
    // A phrase, not words: both words present but not together does not match.
    expect(matchesProductQuery(products[3], "silk edges")).toBe(false);
  });

  it("matches everything for an empty or blank query", () => {
    expect(matchesProductQuery(products[2], "   ")).toBe(true);
  });
});

describe("rankProducts", () => {
  it("orders name hits before category and description hits", () => {
    const { items, total } = rankProducts(products, "shirt");
    expect(items.map((p) => p.name)).toEqual([
      "Shirt dress", // name starts with the query
      "Linen shirt", // a word in the name starts with it
      "Denim jacket", // only the description mentions it
    ]);
    expect(total).toBe(3);
  });

  it("keeps catalogue order between equal ranks and honours the limit", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      name: `Tea ${i}`,
      description: null,
      category: null,
    }));
    const { items, total } = rankProducts(many, "tea", 6);
    expect(items.map((p) => p.name)).toEqual([
      "Tea 0",
      "Tea 1",
      "Tea 2",
      "Tea 3",
      "Tea 4",
      "Tea 5",
    ]);
    expect(total).toBe(9);
  });

  it("never admits a product the grid would reject", () => {
    for (const q of ["shirt", "lin", "edges", "bag", "zzz", "poplin"]) {
      const ranked = rankProducts(products, q, 99).items;
      expect(ranked).toEqual(
        products
          .filter((p) => matchesProductQuery(p, q))
          .sort(
            (a, b) =>
              productMatchRank(b, q) - productMatchRank(a, q) ||
              products.indexOf(a) - products.indexOf(b),
          ),
      );
    }
  });
});

describe("rankCategories", () => {
  it("matches names, prefix first, and nothing for an empty query", () => {
    const categories = [
      { name: "Home accents", slug: "home" },
      { name: "Accessories", slug: "accessories" },
      { name: "Shoes", slug: "shoes" },
    ];
    expect(rankCategories(categories, "acc").map((c) => c.slug)).toEqual([
      "accessories",
      "home",
    ]);
    expect(rankCategories(categories, "")).toEqual([]);
  });
});
