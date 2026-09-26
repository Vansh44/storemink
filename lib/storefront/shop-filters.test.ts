import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  applyShopQuery,
  DEFAULT_SHOP_QUERY,
  parseShopQuery,
  priceSpan,
  shopQueryEntries,
  withShopQuery,
  type ShopFacts,
} from "./shop-filters";

type Row = { id: string } & ShopFacts;

const rows: Row[] = [
  {
    id: "a",
    name: "Mango",
    price: 300,
    soldOut: false,
    createdAt: "2026-01-01",
  },
  {
    id: "b",
    name: "apple",
    price: 100,
    soldOut: true,
    createdAt: "2026-03-01",
  },
  {
    id: "c",
    name: "Banana",
    price: 200,
    soldOut: false,
    createdAt: "2026-02-01",
  },
  { id: "d", name: "Cherry", price: 200, soldOut: false, createdAt: null },
];
const ids = (list: Row[]) => list.map((r) => r.id);
const apply = (params: Record<string, string>) =>
  ids(applyShopQuery(rows, parseShopQuery(params), (r) => r));

describe("parseShopQuery", () => {
  it("returns the defaults for an empty or junk query", () => {
    expect(parseShopQuery({})).toEqual(DEFAULT_SHOP_QUERY);
    expect(
      parseShopQuery({ sort: "cheapest", stock: "yes", min: "abc", page: "0" }),
    ).toEqual(DEFAULT_SHOP_QUERY);
  });

  it("reads every key, from a record or URLSearchParams", () => {
    const expected = {
      sort: "price-desc",
      inStock: true,
      min: 50,
      max: 500,
      pages: 3,
    };
    expect(
      parseShopQuery({
        sort: "price-desc",
        stock: "in",
        min: "50",
        max: "500",
        page: "3",
      }),
    ).toEqual(expected);
    expect(
      parseShopQuery(
        new URLSearchParams("sort=price-desc&stock=in&min=50&max=500&page=3"),
      ),
    ).toEqual(expected);
  });

  it("swaps a backwards range and drops a negative or absurd bound", () => {
    expect(parseShopQuery({ min: "500", max: "50" })).toMatchObject({
      min: 50,
      max: 500,
    });
    expect(parseShopQuery({ min: "-5", max: "99999999999" })).toMatchObject({
      min: null,
      max: null,
    });
  });

  it("caps the page count so a crafted link cannot draw everything twice", () => {
    expect(parseShopQuery({ page: "100000" }).pages).toBe(200);
    expect(parseShopQuery({ page: "2.5" }).pages).toBe(1);
  });

  it("takes the first value of a repeated key", () => {
    expect(parseShopQuery({ sort: ["newest", "name"] }).sort).toBe("newest");
  });
});

describe("shopQueryEntries / withShopQuery", () => {
  it("omits every default, so an untouched shop has a clean address", () => {
    expect(shopQueryEntries(DEFAULT_SHOP_QUERY)).toEqual([]);
  });

  it("round-trips a view through the query string", () => {
    const view = {
      sort: "newest" as const,
      inStock: true,
      min: 10,
      max: 90,
      pages: 2,
    };
    const params = withShopQuery(new URLSearchParams(), view);
    expect(parseShopQuery(params)).toEqual(view);
  });

  it("keeps the search term and drops stale shop keys", () => {
    const next = withShopQuery(new URLSearchParams("q=tea&sort=name&page=4"), {
      ...DEFAULT_SHOP_QUERY,
      inStock: true,
    });
    expect(next.toString()).toBe("q=tea&stock=in");
  });
});

describe("applyShopQuery", () => {
  it("keeps the store's own order for Featured", () => {
    expect(apply({})).toEqual(["a", "b", "c", "d"]);
  });

  it("sorts by price, breaking ties by the featured order", () => {
    expect(apply({ sort: "price-asc" })).toEqual(["b", "c", "d", "a"]);
    expect(apply({ sort: "price-desc" })).toEqual(["a", "c", "d", "b"]);
  });

  it("puts the newest first and an undated product last", () => {
    expect(apply({ sort: "newest" })).toEqual(["b", "c", "a", "d"]);
  });

  it("sorts names without caring about case", () => {
    expect(apply({ sort: "name" })).toEqual(["b", "c", "d", "a"]);
  });

  it("hides sold-out products when asked", () => {
    expect(apply({ stock: "in" })).toEqual(["a", "c", "d"]);
  });

  it("filters an inclusive price range", () => {
    expect(apply({ min: "200", max: "200" })).toEqual(["c", "d"]);
    expect(apply({ min: "250" })).toEqual(["a"]);
    expect(apply({ max: "150" })).toEqual(["b"]);
  });

  it("does not mutate its input", () => {
    const copy = [...rows];
    applyShopQuery(rows, parseShopQuery({ sort: "price-asc" }), (r) => r);
    expect(rows).toEqual(copy);
  });
});

describe("activeFilterCount", () => {
  it("counts availability and price, never sort", () => {
    expect(activeFilterCount(DEFAULT_SHOP_QUERY)).toBe(0);
    expect(
      activeFilterCount({ ...DEFAULT_SHOP_QUERY, sort: "name", inStock: true }),
    ).toBe(1);
    expect(
      activeFilterCount({ ...DEFAULT_SHOP_QUERY, inStock: true, max: 10 }),
    ).toBe(2);
  });
});

describe("priceSpan", () => {
  it("spans whole rupees and ignores invalid prices", () => {
    expect(priceSpan([120.5, 99.2, NaN, -1])).toEqual({ min: 99, max: 121 });
    expect(priceSpan([])).toBeNull();
  });
});
