import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { getStoreBrand } from "@/lib/store/brand";
import { getActiveCategories } from "@/lib/storefront/queries";
import { parseShopQuery } from "@/lib/storefront/shop-filters";
import { getStoreUrl } from "@/lib/site";
import { getOgImageUrl } from "@/lib/og-image";
import { breadcrumbSchema } from "@/lib/seo/schema";
import { JsonLd } from "@/app/(storefront)/components/json-ld";
import ShopClient from "../../shop/shop-client";
import { loadShopView } from "../../shop/shop-view";
import "../../shop/shop.css";

// ---------------------------------------------------------------------------
// /collections/<slug> — one category's page.
//
// ★ A CATEGORY IS A PAGE, NOT A FILTER. It was `/shop?category=<slug>`, which
// canonicalised to /shop, so a category could never rank for its own name and
// could not carry its own title, description or image. Shopify's path, so a
// merchant or a reference theme that says "collection" means the same thing
// here. `/shop?category=<slug>` redirects to it, so no existing link breaks.
//
// ★ ONLY THE `collections/[slug]` ROUTE EXISTS. There is deliberately no
// `collections/page.tsx`: without one, /collections still resolves to the
// merchant-page route, so a store that already has a page slugged
// "collections" keeps it. The slug is reserved for NEW pages.
// ---------------------------------------------------------------------------

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

async function findCategory(slug: string) {
  const storeId = await requireStorefrontStoreId();
  const categories = await getActiveCategories(storeId);
  return { storeId, category: categories.find((c) => c.slug === slug) };
}

/** A description short enough for a search result, on a word boundary. */
function summary(text: string, limit = 155): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 60)).trimEnd()}…`;
}

export async function generateMetadata({
  params,
  searchParams,
}: PageProps): Promise<Metadata> {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const [{ category }, brand] = await Promise.all([
    findCategory(slug),
    getStoreBrand(),
  ]);
  if (!category) return { title: "Page not found" };

  const description = category.description?.trim()
    ? summary(category.description)
    : `Shop ${category.name} at ${brand.name}.`;
  const path = `/collections/${category.slug}`;
  const ogImageUrl = getOgImageUrl(category.image_url);

  return {
    title: category.name,
    description,
    // Sort, filters and paging are views of this page, never pages of their
    // own; search results are not indexed at all.
    alternates: { canonical: path },
    robots: first(query.q) ? { index: false, follow: true } : undefined,
    openGraph: {
      title: `${category.name} | ${brand.name}`,
      description,
      url: path,
      type: "website",
      images: ogImageUrl
        ? [{ url: ogImageUrl, width: 1200, height: 630, alt: category.name }]
        : undefined,
    },
  };
}

export default async function CollectionPage({
  params,
  searchParams,
}: PageProps) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const { storeId, category } = await findCategory(slug);
  if (!category) notFound();

  const [view, siteUrl] = await Promise.all([
    loadShopView(storeId),
    getStoreUrl(),
  ]);
  const breadcrumbLd = breadcrumbSchema(siteUrl, [
    { name: "Home", path: "/" },
    { name: "Shop", path: "/shop" },
    { name: category.name, path: `/collections/${category.slug}` },
  ]);

  return (
    <>
      <JsonLd data={[breadcrumbLd]} />
      {/* Keyed so moving between collections starts a fresh view: the URL of
          the new collection carries no sort or filter of its own. */}
      <ShopClient
        key={category.id}
        products={view.products}
        categories={view.categories}
        collection={category}
        initialQuery={first(query.q)}
        initialShop={parseShopQuery(query)}
        grocery={view.layout.card === "grocery"}
        shopFilters={view.layout.shopFilters}
        collectionBanner={view.layout.collectionBanner}
        storeLowStockThreshold={view.lowStockThreshold}
        offerBadges={view.offerBadges}
      />
    </>
  );
}
