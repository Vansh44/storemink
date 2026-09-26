"use client";

import { useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SlidersHorizontal, X } from "lucide-react";
import { matchesProductQuery } from "@/lib/storefront/product-search";
import { collectionPath } from "@/lib/storefront/collection-links";
import {
  activeFilterCount,
  applyShopQuery,
  DEFAULT_SHOP_QUERY,
  priceSpan,
  SHOP_PAGE_SIZE,
  SHOP_SORT_LABELS,
  SHOP_SORTS,
  withShopQuery,
  type ShopFacts,
  type ShopQuery,
  type ShopSort,
} from "@/lib/storefront/shop-filters";
import { effectivePricing, formatPrice } from "@/lib/pricing";
import { productIsSoldOut } from "@/lib/inventory/status";
import { ShopCard } from "@/app/(storefront)/components/shop-card";
import { useBrand } from "@/app/(storefront)/components/brand-provider";
import { ShopFilterPanel } from "./shop-filter-panel";

export interface ShopProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category_id: string | null;
  base_price: number;
  selling_price: number;
  image_url: string | null;
  images?: string[] | null;
  featured: boolean;
  sort_order: number;
  card_color: string | null;
  category?: string | null;
  created_at?: string | null;
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
  description?: string | null;
  image_url?: string | null;
}

type Props = {
  products: ShopProduct[];
  categories: ShopCategory[];
  /** The category this page is for (/collections/<slug>); absent on /shop. */
  collection?: ShopCategory;
  /** /shop?category=uncategorized — products with no category. */
  uncategorized?: boolean;
  // Optional ?q=<text> deep-link from the header search — filters the grid
  // by name/description match.
  initialQuery?: string;
  /** Sort, filters and revealed pages, read from the URL by the page. */
  initialShop?: ShopQuery;
  // Grocery theme: swap the WholeSip-branded hero/ticker for a clean header.
  grocery?: boolean;
  /** Theme `layout.shopFilters`: the toolbar, filters and "Load more". */
  shopFilters?: boolean;
  /** Theme `layout.collectionBanner`: a collection's image + description. */
  collectionBanner?: boolean;
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

/** What sorting and filtering read — the card's own price and stock rule. */
function factsOf(p: ShopProduct): ShopFacts {
  return {
    price: effectivePricing(p).selling,
    soldOut: productIsSoldOut(p.variants, p),
    name: p.name,
    createdAt: p.created_at ?? null,
  };
}

const plural = (n: number) => `${n} ${n === 1 ? "product" : "products"}`;

export default function ShopClient({
  products,
  categories,
  collection,
  uncategorized = false,
  initialQuery,
  initialShop = DEFAULT_SHOP_QUERY,
  grocery = false,
  shopFilters = false,
  collectionBanner = false,
  storeLowStockThreshold = 0,
  offerBadges,
}: Props) {
  const [query, setQuery] = useState<string>(initialQuery ?? "");
  const [shop, setShop] = useState<ShopQuery>(
    shopFilters ? initialShop : DEFAULT_SHOP_QUERY,
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  const brand = useBrand();

  const basePath = collection ? collectionPath(collection.slug) : "/shop";

  // The header search pushes a new ?q= onto the SAME route, so this component
  // is reused rather than remounted — adopt the new deep link during render
  // (React's "adjusting state when a prop changes" pattern). A new search
  // starts again from the first page.
  const [lastInitialQuery, setLastInitialQuery] = useState(initialQuery);
  if (lastInitialQuery !== initialQuery) {
    setLastInitialQuery(initialQuery);
    setQuery(initialQuery ?? "");
    if (shop.pages !== 1) setShop({ ...shop, pages: 1 });
  }

  /**
   * ★ The URL is updated in place, not navigated. A sort or a filter is a
   * view of data this page already holds, so asking the server to render it
   * again would be a round trip for nothing — and the URL still ends up
   * shareable and restorable on reload.
   */
  const updateShop = (next: ShopQuery) => {
    setShop(next);
    const params = withShopQuery(
      new URLSearchParams(window.location.search),
      next,
    );
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );
  };

  // Scope first (collection, "Other", search), then the shopper's filters.
  const scoped = useMemo(() => {
    let list = products;
    if (collection) list = list.filter((p) => p.category_id === collection.id);
    else if (uncategorized) list = list.filter((p) => !p.category_id);
    // The header's predictive search matches with the same function, so a
    // suggestion is always a product this grid shows for the same query.
    if (query.trim()) list = list.filter((p) => matchesProductQuery(p, query));
    return list;
  }, [products, collection, uncategorized, query]);

  const filtered = useMemo(
    () => (shopFilters ? applyShopQuery(scoped, shop, factsOf) : scoped),
    [scoped, shop, shopFilters],
  );
  const shown = shopFilters
    ? filtered.slice(0, shop.pages * SHOP_PAGE_SIZE)
    : filtered;
  const span = useMemo(
    () => priceSpan(scoped.map((p) => factsOf(p).price)),
    [scoped],
  );
  const filterCount = activeFilterCount(shop);

  const clearQuery = () => {
    setQuery("");
    const qs = withShopQuery(new URLSearchParams(), shop).toString();
    router.replace(`${basePath}${qs ? `?${qs}` : ""}`);
  };
  const clearFilters = () =>
    updateShop({ ...shop, inStock: false, min: null, max: null, pages: 1 });

  const hasUncategorized = products.some((p) => !p.category_id);
  const trimmed = query.trim();
  const title = trimmed
    ? `Results for “${trimmed}”`
    : (collection?.name ?? (uncategorized ? "Other" : "Shop everything"));
  const banner =
    collectionBanner && collection && !trimmed
      ? {
          description: collection.description?.trim() || null,
          image: collection.image_url || null,
        }
      : null;

  const chip = (href: string, label: string, active: boolean, key: string) => (
    <Link
      key={key}
      href={href}
      className={`shop-chip${active ? " active" : ""}`}
      aria-current={active ? "page" : undefined}
      scroll={false}
    >
      {label}
    </Link>
  );

  return (
    <main className="shop-main shop-listing">
      <div className="shop-panel">
        <div className="shop-panel-body">
          {banner ? (
            <section
              className={`shop-collection-banner${banner.image ? " has-image" : ""}`}
            >
              <div className="shop-collection-text">
                <h1 className="shop-collection-title">{title}</h1>
                {banner.description && (
                  <p className="shop-collection-desc">{banner.description}</p>
                )}
              </div>
              {banner.image && (
                <div className="shop-collection-media">
                  <Image
                    src={banner.image}
                    alt=""
                    fill
                    priority
                    sizes="(max-width: 767px) 100vw, 50vw"
                    className="shop-collection-img"
                  />
                </div>
              )}
            </section>
          ) : grocery ? (
            /* Grocery gets a clean, brand-neutral header; the classic theme
               keeps the WholeSip lowercase-headline hero. */
            <section className="shop-hero shop-hero-grocery">
              <h1 className="shop-title-grocery">{title}</h1>
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
                <h1 className="shop-title">{title}</h1>
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
              {/* Each category is its own page, so a chip is a link: it can be
                  shared, opened in a new tab, and Back returns to it. */}
              <nav className="shop-filters" aria-label="Categories">
                {chip("/shop", "All", !collection && !uncategorized, "all")}
                {categories.map((c) =>
                  chip(
                    collectionPath(c.slug),
                    c.name,
                    collection?.id === c.id,
                    c.id,
                  ),
                )}
                {hasUncategorized &&
                  chip(
                    "/shop?category=uncategorized",
                    "Other",
                    uncategorized,
                    "uncategorized",
                  )}
              </nav>

              {/* Active search chip (from the header search / ?q= deep link) */}
              {trimmed && (
                <p className="shop-count">
                  Results for &ldquo;{trimmed}&rdquo;{" "}
                  <button
                    type="button"
                    className="shop-chip"
                    onClick={clearQuery}
                  >
                    Clear search
                  </button>
                </p>
              )}

              {shopFilters && scoped.length > 0 && (
                <div className="shop-toolbar">
                  <div className="shop-toolbar-start">
                    <button
                      ref={filterButtonRef}
                      type="button"
                      className="shop-filter-btn"
                      aria-haspopup="dialog"
                      aria-expanded={filtersOpen}
                      onClick={() => setFiltersOpen(true)}
                    >
                      <SlidersHorizontal size={16} aria-hidden />
                      Filter
                      {filterCount > 0 && (
                        <span className="shop-filter-count">
                          {filterCount}
                          <span className="shop-sr-only"> active</span>
                        </span>
                      )}
                    </button>
                    {shop.inStock && (
                      <button
                        type="button"
                        className="shop-active-filter"
                        onClick={() =>
                          updateShop({ ...shop, inStock: false, pages: 1 })
                        }
                      >
                        In stock
                        <X size={14} aria-hidden />
                        <span className="shop-sr-only"> — remove filter</span>
                      </button>
                    )}
                    {(shop.min !== null || shop.max !== null) && (
                      <button
                        type="button"
                        className="shop-active-filter"
                        onClick={() =>
                          updateShop({
                            ...shop,
                            min: null,
                            max: null,
                            pages: 1,
                          })
                        }
                      >
                        {shop.min !== null && shop.max !== null
                          ? `${formatPrice(shop.min)} – ${formatPrice(shop.max)}`
                          : shop.min !== null
                            ? `From ${formatPrice(shop.min)}`
                            : `Up to ${formatPrice(shop.max!)}`}
                        <X size={14} aria-hidden />
                        <span className="shop-sr-only"> — remove filter</span>
                      </button>
                    )}
                    {filterCount > 1 && (
                      <button
                        type="button"
                        className="shop-clear-filters"
                        onClick={clearFilters}
                      >
                        Clear all
                      </button>
                    )}
                  </div>
                  <div className="shop-toolbar-end">
                    <span className="shop-toolbar-count" aria-live="polite">
                      {plural(filtered.length)}
                    </span>
                    <label className="shop-sort">
                      <span className="shop-sort-label">Sort by</span>
                      <select
                        aria-label="Sort by"
                        value={shop.sort}
                        onChange={(e) =>
                          updateShop({
                            ...shop,
                            sort: e.target.value as ShopSort,
                            pages: 1,
                          })
                        }
                      >
                        {SHOP_SORTS.map((s) => (
                          <option key={s} value={s}>
                            {SHOP_SORT_LABELS[s]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
              )}

              {/* Product grid */}
              {filtered.length === 0 ? (
                <div className="shop-empty">
                  <p>
                    {scoped.length > 0 && filterCount > 0
                      ? "No products match these filters."
                      : trimmed
                        ? "No products match your search."
                        : "No products in this category yet."}
                  </p>
                  {scoped.length > 0 && filterCount > 0 && (
                    <button
                      type="button"
                      className="shop-chip"
                      onClick={clearFilters}
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              ) : (
                <>
                  {!shopFilters && (
                    <p className="shop-count">
                      Showing {filtered.length} of {plural(products.length)}
                    </p>
                  )}
                  <div className="shop-grid">
                    {shown.map((p) => (
                      <ShopCard
                        key={p.id}
                        product={p}
                        storeLowStockThreshold={storeLowStockThreshold}
                        headingLevel={2}
                        offerBadge={offerBadges?.[p.id]}
                      />
                    ))}
                  </div>
                  {shopFilters && (
                    <div className="shop-more">
                      <p className="shop-more-count" aria-live="polite">
                        Showing {shown.length} of {plural(filtered.length)}
                      </p>
                      {shown.length < filtered.length && (
                        <>
                          <div className="shop-more-bar" aria-hidden>
                            <span
                              style={{
                                width: `${(shown.length / filtered.length) * 100}%`,
                              }}
                            />
                          </div>
                          <button
                            type="button"
                            className="shop-more-btn"
                            onClick={() =>
                              updateShop({ ...shop, pages: shop.pages + 1 })
                            }
                          >
                            Load more
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {shopFilters && filtersOpen && (
        <ShopFilterPanel
          value={shop}
          span={span}
          inStockCount={scoped.filter((p) => !factsOf(p).soldOut).length}
          countFor={(draft) => applyShopQuery(scoped, draft, factsOf).length}
          onApply={(next) => updateShop({ ...next, pages: 1 })}
          onClose={() => {
            setFiltersOpen(false);
            filterButtonRef.current?.focus();
          }}
        />
      )}
    </main>
  );
}
