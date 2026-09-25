"use client";

import { useMemo, useState } from "react";
import { matchesProductQuery } from "@/lib/storefront/product-search";
import { useRouter } from "next/navigation";
import { ShopCard } from "@/app/(storefront)/components/shop-card";
import { useBrand } from "@/app/(storefront)/components/brand-provider";

export interface ShopProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category_id: string | null;
  base_price: number;
  selling_price: number;
  image_url: string | null;
  featured: boolean;
  sort_order: number;
  card_color: string | null;
  category?: string | null;
  track_inventory: boolean;
  stock: number;
  low_stock_threshold: number | null;
  allow_backorder: boolean;
  variants: {
    base_price: number;
    selling_price: number;
    special_price?: number | null;
    sort_order?: number;
    track_inventory: boolean;
    stock: number;
    low_stock_threshold: number | null;
    allow_backorder: boolean;
  }[];
}

export interface ShopCategory {
  id: string;
  name: string;
  slug: string;
  sort_order: number;
}

type Props = {
  products: ShopProduct[];
  categories: ShopCategory[];
  // Optional ?category=<slug> deep-link (e.g. from the homepage category
  // tiles) — preselects that category's tab instead of "All".
  initialCategorySlug?: string;
  // Optional ?q=<text> deep-link from the header search — filters the grid
  // by name/description match.
  initialQuery?: string;
  // Grocery theme: swap the WholeSip-branded hero/ticker for a clean header.
  grocery?: boolean;
  // Store-wide default low-stock threshold (inventory.lowStockThreshold),
  // resolved by the page; drives each card's "Only X left" badge.
  storeLowStockThreshold?: number;
  /**
   * Per-product offer badge labels, keyed by product id, resolved on the
   * SERVER by `offerBadgeFor`.
   *
   * ★ A MAP OF ANSWERS, NOT THE OFFERS THEMSELVES. Shipping the offer list and
   * pricing each card in the browser would be a second implementation of the
   * engine on the one surface where being wrong is most visible — and it would
   * disagree with the server the moment `onSalePrice` or a special price
   * enters. The page resolves each product once and sends the label.
   */
  offerBadges?: Record<string, { label: string }>;
};

export default function ShopClient({
  products,
  categories,
  initialCategorySlug,
  initialQuery,
  grocery = false,
  storeLowStockThreshold = 0,
  offerBadges,
}: Props) {
  // Map the deep-link slug to its category id; fall back to "all" when absent
  // or unknown.
  const initialActive =
    categories.find((c) => c.slug === initialCategorySlug)?.id ?? "all";
  const [active, setActive] = useState<string>(initialActive);
  const [query, setQuery] = useState<string>(initialQuery ?? "");
  const router = useRouter();
  const brand = useBrand();

  // The header search pushes a new ?q= onto the SAME route, so this component
  // is reused rather than remounted — adopt the new deep link during render
  // (React's "adjusting state when a prop changes" pattern).
  const [lastInitialQuery, setLastInitialQuery] = useState(initialQuery);
  if (lastInitialQuery !== initialQuery) {
    setLastInitialQuery(initialQuery);
    setQuery(initialQuery ?? "");
  }

  const filtered = useMemo(() => {
    let list = products;
    if (active === "uncategorized") list = list.filter((p) => !p.category_id);
    else if (active !== "all")
      list = list.filter((p) => p.category_id === active);
    // The header's predictive search matches with the same function, so a
    // suggestion is always a product this grid shows for the same query.
    if (query.trim()) list = list.filter((p) => matchesProductQuery(p, query));
    return list;
  }, [products, active, query]);

  const clearQuery = () => {
    setQuery("");
    router.replace("/shop");
  };

  const hasUncategorized = products.some((p) => !p.category_id);

  return (
    <main className="shop-main shop-listing">
      <div className="shop-panel">
        <div className="shop-panel-body">
          {/* Hero: grocery gets a clean, brand-neutral header; the classic
              theme keeps the WholeSip lowercase-headline hero. */}
          {grocery ? (
            <section className="shop-hero shop-hero-grocery">
              <h1 className="shop-title-grocery">
                {query.trim()
                  ? `Results for “${query.trim()}”`
                  : "Shop everything"}
              </h1>
              <p className="shop-sub-grocery">
                {brand.tagline ||
                  brand.blurb ||
                  "Fresh picks, daily staples and pantry favourites."}
              </p>
            </section>
          ) : (
            <section className="shop-hero">
              <span className="shop-kicker">{brand.name}</span>
              <div className="shop-hero-row">
                <h1 className="shop-title">
                  {query.trim()
                    ? `Results for “${query.trim()}”`
                    : "Shop everything"}
                </h1>
                {(brand.tagline || brand.blurb) && (
                  <div className="shop-note">
                    {brand.tagline || brand.blurb}
                  </div>
                )}
              </div>
            </section>
          )}

          {products.length === 0 ? (
            <div className="shop-empty">
              <div className="shop-empty-emoji">🛒</div>
              <h2>No products yet</h2>
              <p>Check back soon — we&rsquo;re stocking the shelves.</p>
            </div>
          ) : (
            <>
              {/* Category filters */}
              <div className="shop-filters">
                <button
                  className={`shop-chip${active === "all" ? " active" : ""}`}
                  onClick={() => setActive("all")}
                >
                  All
                </button>
                {categories.map((c) => (
                  <button
                    key={c.id}
                    className={`shop-chip${active === c.id ? " active" : ""}`}
                    onClick={() => setActive(c.id)}
                  >
                    {c.name}
                  </button>
                ))}
                {hasUncategorized && (
                  <button
                    className={`shop-chip${active === "uncategorized" ? " active" : ""}`}
                    onClick={() => setActive("uncategorized")}
                  >
                    Other
                  </button>
                )}
              </div>

              {/* Active search chip (from the header search / ?q= deep link) */}
              {query.trim() && (
                <p className="shop-count">
                  Results for &ldquo;{query.trim()}&rdquo;{" "}
                  <button
                    type="button"
                    className="shop-chip"
                    onClick={clearQuery}
                  >
                    Clear search
                  </button>
                </p>
              )}

              {/* Product grid */}
              {filtered.length === 0 ? (
                <div className="shop-empty">
                  <p>
                    {query.trim()
                      ? "No products match your search."
                      : "No products in this category yet."}
                  </p>
                </div>
              ) : (
                <>
                  <p className="shop-count">
                    Showing {filtered.length} of {products.length}{" "}
                    {products.length === 1 ? "product" : "products"}
                  </p>
                  <div className="shop-grid">
                    {filtered.map((p) => (
                      <ShopCard
                        key={p.id}
                        product={p}
                        storeLowStockThreshold={storeLowStockThreshold}
                        headingLevel={2}
                        offerBadge={offerBadges?.[p.id]}
                      />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
