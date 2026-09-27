import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  value: { id: "store-1" } as { id: string } | null,
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreOrNull: vi.fn(async () => store.value),
}));
const products = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("@/lib/storefront/queries", () => ({
  getPublishedProducts: vi.fn(async () => products.rows),
  getActiveCategories: vi.fn(async () => [
    {
      id: "c1",
      name: "Shirts",
      slug: "shirts",
      image_url: null,
      sort_order: 0,
    },
  ]),
}));

import { getPublishedProducts } from "@/lib/storefront/queries";
import { GET } from "./route";

const product = (over: Record<string, unknown>) => ({
  id: "p",
  name: "Linen shirt",
  slug: "linen-shirt",
  description: "Soft",
  category: "Shirts",
  base_price: 1500,
  selling_price: 1200,
  image_url: "",
  images: ["", "/img/shirt.webp"],
  variants: [],
  ...over,
});

const get = (q: string) =>
  GET(
    new Request(
      `https://shop.example/api/storefront/search?q=${encodeURIComponent(q)}`,
    ),
  );

describe("GET /api/storefront/search", () => {
  beforeEach(() => {
    store.value = { id: "store-1" };
    products.rows = [
      product({}),
      product({
        name: "Denim jacket",
        slug: "denim",
        category: "Jackets",
        description: "x",
        selling_price: 1500,
      }),
    ];
  });

  it("returns ranked suggestions for the host's store", async () => {
    const response = await get("shirt");
    const body = await response.json();
    expect(getPublishedProducts).toHaveBeenCalledWith("store-1");
    expect(body).toEqual({
      query: "shirt",
      total: 1,
      products: [
        {
          name: "Linen shirt",
          href: "/shop/linen-shirt",
          imageUrl: "/img/shirt.webp", // the gallery's first real photo
          price: 1200,
          compareAt: 1500,
          category: "Shirts",
        },
      ],
      categories: [{ name: "Shirts", href: "/collections/shirts" }],
    });
    expect(response.headers.get("cache-control")).toMatch(/^private/);
  });

  it("omits the struck price when nothing is on sale", async () => {
    const body = await (await get("denim")).json();
    expect(body.products[0].compareAt).toBeNull();
  });

  it("asks nothing for a one-letter query", async () => {
    const body = await (await get("s")).json();
    expect(body.products).toEqual([]);
    expect(getPublishedProducts).not.toHaveBeenCalled();
  });

  it("answers with nothing on a host that is no store", async () => {
    store.value = null;
    const body = await (await get("shirt")).json();
    expect(body.total).toBe(0);
    expect(getPublishedProducts).not.toHaveBeenCalled();
  });
});
