import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { getStoreBrand } from "@/lib/store/brand";
import { parseShopQuery } from "@/lib/storefront/shop-filters";
import { legacyCategoryRedirect } from "@/lib/storefront/collection-links";
import { getActiveCategories } from "@/lib/storefront/queries";
import ShopClient from "./shop-client";
import { loadShopView } from "./shop-view";
import "./shop.css";

type ShopSearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

// Per-store metadata — the layout templates the title as "%s | {brand}", so
// this returns just "Shop" and a brand-aware description (never WholeSip).
//
// Sort and filter parameters are views of this one page, so every variant
// canonicalises to /shop. A category has its own page now
// (/collections/<slug>), which this redirects to. Internal search-result
// pages (?q=) are additionally noindex'd — Google discourages indexing
// site-search results.
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<ShopSearchParams>;
}): Promise<Metadata> {
  const [brand, params] = await Promise.all([getStoreBrand(), searchParams]);
  const description = `Browse the full ${brand.name} range.`;
  return {
    title: "Shop",
    description,
    alternates: { canonical: "/shop" },
    robots: first(params.q) ? { index: false, follow: true } : undefined,
    openGraph: {
      title: `Shop | ${brand.name}`,
      description,
      url: "/shop",
      type: "website",
    },
  };
}

export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<ShopSearchParams>;
}) {
  const params = await searchParams;
  const storeId = await requireStorefrontStoreId();

  // ★ ONE ADDRESS PER CATEGORY. `/shop?category=<slug>` was how a category was
  // linked before it had a page of its own, and it still appears in menus,
  // homepage tiles and theme packages already installed in stores — so it
  // redirects rather than 404s, carrying the search and any sort or filter
  // across. An unknown slug is not redirected: it shows the whole shop, as it
  // always has.
  // Checked before the full view loads: a redirect should not pay for it.
  const target = legacyCategoryRedirect(
    params,
    await getActiveCategories(storeId),
  );
  if (target) permanentRedirect(target);
  const view = await loadShopView(storeId);
  const categorySlug = first(params.category);

  return (
    <ShopClient
      products={view.products}
      categories={view.categories}
      uncategorized={categorySlug === "uncategorized"}
      initialQuery={first(params.q)}
      initialShop={parseShopQuery(params)}
      grocery={view.layout.card === "grocery"}
      shopFilters={view.layout.shopFilters}
      storeLowStockThreshold={view.lowStockThreshold}
      offerBadges={view.offerBadges}
    />
  );
}
