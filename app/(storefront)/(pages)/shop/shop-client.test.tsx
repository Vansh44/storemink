// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    scroll: _scroll,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    scroll?: boolean;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/image", () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src, alt }: { src: string; alt: string }) => (
    <img src={src} alt={alt} />
  ),
}));
vi.mock("@/app/(storefront)/components/brand-provider", () => ({
  useBrand: () => ({ name: "Test Store", tagline: "", blurb: "" }),
}));
vi.mock("@/app/(storefront)/components/shop-card", () => ({
  ShopCard: ({ product }: { product: { name: string } }) => (
    <article data-testid="card">{product.name}</article>
  ),
}));

import ShopClient, { type ShopCategory, type ShopProduct } from "./shop-client";
import { DEFAULT_SHOP_QUERY } from "@/lib/storefront/shop-filters";

function product(
  id: string,
  name: string,
  price: number,
  over: Partial<ShopProduct> = {},
): ShopProduct {
  return {
    id,
    name,
    slug: id,
    description: null,
    category_id: "c1",
    base_price: price,
    selling_price: price,
    image_url: null,
    featured: false,
    sort_order: 0,
    card_color: null,
    created_at: "2026-01-01T00:00:00Z",
    track_inventory: false,
    stock: 0,
    low_stock_threshold: null,
    allow_backorder: false,
    variants: [],
    ...over,
  };
}

const categories: ShopCategory[] = [
  {
    id: "c1",
    name: "Juices",
    slug: "juices",
    sort_order: 0,
    description: "Cold-pressed every morning.",
    image_url: "/juices.webp",
  },
  { id: "c2", name: "Snacks", slug: "snacks", sort_order: 1 },
];

const products = [
  product("mango", "Mango", 300),
  product("apple", "Apple", 100, {
    track_inventory: true,
    stock: 0,
  }),
  product("chips", "Chips", 200, {
    category_id: "c2",
    created_at: "2026-05-01T00:00:00Z",
  }),
];

const names = () => screen.queryAllByTestId("card").map((c) => c.textContent);

let replaceState: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  window.history.pushState({}, "", "/shop");
  replaceState = vi.spyOn(window.history, "replaceState");
});
afterEach(() => {
  replaceState.mockRestore();
});

const lastUrl = () =>
  String(replaceState.mock.calls[replaceState.mock.calls.length - 1]?.[2]);

describe("ShopClient without the shop-filters option", () => {
  it("renders every product with no toolbar, as before", () => {
    render(<ShopClient products={products} categories={categories} />);
    expect(names()).toEqual(["Mango", "Apple", "Chips"]);
    expect(screen.queryByRole("combobox", { name: /sort/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /filter/i })).toBeNull();
    expect(screen.getByText("Showing 3 of 3 products")).toBeTruthy();
  });

  it("ignores sort and filter parameters it cannot show", () => {
    render(
      <ShopClient
        products={products}
        categories={categories}
        initialShop={{
          ...DEFAULT_SHOP_QUERY,
          sort: "price-asc",
          inStock: true,
        }}
      />,
    );
    expect(names()).toEqual(["Mango", "Apple", "Chips"]);
  });

  it("links each category chip to its own page", () => {
    render(<ShopClient products={products} categories={categories} />);
    const nav = screen.getByRole("navigation", { name: "Categories" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/shop",
      "/collections/juices",
      "/collections/snacks",
    ]);
    expect(within(nav).getByRole("link", { name: "All" })).toHaveProperty(
      "ariaCurrent",
      "page",
    );
  });
});

describe("ShopClient with the shop-filters option", () => {
  const renderShop = (extra: Partial<Parameters<typeof ShopClient>[0]> = {}) =>
    render(
      <ShopClient
        products={products}
        categories={categories}
        shopFilters
        {...extra}
      />,
    );

  it("sorts in place and writes the sort into the URL", () => {
    renderShop();
    fireEvent.change(screen.getByRole("combobox", { name: /sort by/i }), {
      target: { value: "price-asc" },
    });
    expect(names()).toEqual(["Apple", "Chips", "Mango"]);
    expect(lastUrl()).toBe("/shop?sort=price-asc");
  });

  it("opens with the view the URL describes", () => {
    renderShop({
      initialShop: { ...DEFAULT_SHOP_QUERY, sort: "newest", inStock: true },
    });
    expect(names()).toEqual(["Chips", "Mango"]);
    expect(screen.getByRole("button", { name: /in stock/i })).toBeTruthy();
  });

  it("applies the filter panel only on Show, quoting the count first", () => {
    renderShop();
    fireEvent.click(screen.getByRole("button", { name: /^filter/i }));
    const dialog = screen.getByRole("dialog", { name: "Filter" });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    // The grid behind the panel has not changed yet.
    expect(names()).toEqual(["Mango", "Apple", "Chips"]);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Show 2 products" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(names()).toEqual(["Mango", "Chips"]);
    expect(lastUrl()).toBe("/shop?stock=in");
  });

  it("discards the draft when the panel is dismissed", () => {
    renderShop();
    fireEvent.click(screen.getByRole("button", { name: /^filter/i }));
    const dialog = screen.getByRole("dialog", { name: "Filter" });
    fireEvent.change(within(dialog).getByLabelText("Minimum price in rupees"), {
      target: { value: "250" },
    });
    expect(
      within(dialog).getByRole("button", { name: "Show 1 product" }),
    ).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(names()).toEqual(["Mango", "Apple", "Chips"]);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("removes one filter from its chip and says when none match", () => {
    renderShop({
      initialShop: { ...DEFAULT_SHOP_QUERY, min: 900 },
    });
    expect(names()).toEqual([]);
    expect(screen.getByText("No products match these filters.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /from ₹900/i }));
    expect(names()).toEqual(["Mango", "Apple", "Chips"]);
  });

  it("shows 24 at a time and reveals the next page on Load more", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      product(`p${i}`, `Product ${i}`, 100 + i),
    );
    render(<ShopClient products={many} categories={categories} shopFilters />);
    expect(names()).toHaveLength(24);
    expect(screen.getByText("Showing 24 of 30 products")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(names()).toHaveLength(30);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(lastUrl()).toBe("/shop?page=2");
  });

  it("restores every revealed page from the URL", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      product(`p${i}`, `Product ${i}`, 100 + i),
    );
    render(
      <ShopClient
        products={many}
        categories={categories}
        shopFilters
        initialShop={{ ...DEFAULT_SHOP_QUERY, pages: 2 }}
      />,
    );
    expect(names()).toHaveLength(30);
  });
});

describe("ShopClient on a collection page", () => {
  it("shows only that category, titled by it, with no banner by default", () => {
    render(
      <ShopClient
        products={products}
        categories={categories}
        collection={categories[0]}
      />,
    );
    expect(names()).toEqual(["Mango", "Apple"]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Juices",
    );
    expect(screen.queryByText("Cold-pressed every morning.")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Juices" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("opens with the category's image and description when the theme asks", () => {
    render(
      <ShopClient
        products={products}
        categories={categories}
        collection={categories[0]}
        collectionBanner
      />,
    );
    expect(screen.getByText("Cold-pressed every morning.")).toBeTruthy();
    expect(document.querySelector("img")?.getAttribute("src")).toBe(
      "/juices.webp",
    );
  });

  it("clears a search back to the collection, not the whole shop", () => {
    render(
      <ShopClient
        products={products}
        categories={categories}
        collection={categories[0]}
        initialQuery="mango"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(replace).toHaveBeenCalledWith("/collections/juices");
  });
});
