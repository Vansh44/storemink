import { unstable_cache } from "next/cache";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { withAnon } from "@/lib/db/client";
import {
  blogCategories,
  blogTags,
  blogs,
  categories,
  productVariants,
  products,
  storeBillingSettings,
  storeMenus,
  storePages,
  taxClasses,
} from "@/drizzle/schema";
import { TAGS } from "@/lib/storefront/tags";
import type { PageSectionItem } from "@/lib/sections/registry";
import { normalizeMenus, type StoreMenus } from "@/lib/menus";
import {
  rowToBillingSettings,
  rowToTaxClass,
  type BillingSettings,
  type TaxClass,
} from "@/lib/billing/types";

// ---------------------------------------------------------------------------
// Cached PUBLIC storefront reads.
//
// These wrap the anonymous DB scope (withAnon — RLS enforced with no identity,
// so only the public published/active policy branches match) in
// `unstable_cache` so the storefront's hot (pages) (home, shop, blog index,
// product detail) no longer hit Postgres on every request — the previous model
// re-ran every query per visit because the (pages) were `force-dynamic`.
//
// Freshness: each entry carries a coarse tag and a `revalidate` fallback. The
// dashboard write actions call `revalidateTag(...)` (see app/actions/*) so edits
// show up near-instantly; the time-based `revalidate` is just a safety net.
//
// Reads tolerate a missing table / transient error by returning empty (matching
// the storefront's existing `?? []` behavior) so a cold deploy never crashes.
//
// Multi-tenant: every function takes a required `storeId` and filters on it.
// `unstable_cache` folds the function arguments into the cache key, so each
// store gets its own cache entry automatically — one store can never serve
// another's cached rows. Callers resolve the id via getCurrentStore() (host).
// ---------------------------------------------------------------------------

// 5 minutes. Edits propagate immediately via revalidateTag; this only bounds
// how stale things can get if a tag invalidation is ever missed.
const REVALIDATE = 300;

export interface ProductCardRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category_id: string | null;
  base_price: number;
  selling_price: number;
  image_url: string | null;
  /** Rest of the gallery. Selected for the card's hover image — compose it
   *  through lib/products/gallery.ts, never by indexing this directly (the
   *  column defaults to [""] and theme seeds repeat the primary). */
  images: string[] | null;
  status: string;
  featured: boolean;
  sort_order: number;
  card_color: string | null;
  track_inventory: boolean;
  stock: number;
  low_stock_threshold: number | null;
  allow_backorder: boolean;
  /** FALSE = final sale. Said BEFORE the sale, not discovered after it. */
  returnable: boolean;
  /**
   * Last change to something a VISITOR sees — not stock. The sitemap's lastmod
   * source; see supabase/seo_01_product_content_timestamp.sql.
   */
  content_updated_at: string;
  /** When the product was created — the shop's "Newest" sort. */
  created_at: string;
  /** Resolved category name (flattened from the joined categories row). */
  category: string | null;
  variants: {
    base_price: number;
    selling_price: number;
    special_price: number | null;
    sort_order: number;
    track_inventory: boolean;
    stock: number;
    low_stock_threshold: number | null;
    allow_backorder: boolean;
  }[];
}

export interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  /** Shown by a collection page's banner (theme `collectionBanner`). */
  description: string | null;
  image_url: string | null;
  sort_order: number;
}

export interface BlogCardRow {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  cover_image_url: string | null;
  author: string | null;
  published_at: string | null;
  reading_time: number | null;
  tags: string[];
  categories: string[] | null;
  featured: boolean;
}

export const getPublishedProducts = unstable_cache(
  async (storeId: string): Promise<ProductCardRow[]> => {
    try {
      return await withAnon(async (db) => {
        // Columns the shop + homepage product cards actually render (aliased to
        // the snake_case shape the components expect). Deliberately NOT every
        // column — we only need pricing-relevant fields. The category name is
        // flattened via the join so cards read `product.category` directly.
        const rows = await db
          .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            description: products.description,
            category_id: products.categoryId,
            base_price: products.basePrice,
            selling_price: products.sellingPrice,
            image_url: products.imageUrl,
            images: products.images,
            status: products.status,
            featured: products.featured,
            sort_order: products.sortOrder,
            card_color: products.cardColor,
            track_inventory: products.trackInventory,
            returnable: products.returnable,
            stock: products.onlineStock,
            low_stock_threshold: products.lowStockThreshold,
            allow_backorder: products.allowBackorder,
            // Sitemap lastmod. Selected here rather than in a separate query so
            // it rides the existing unstable_cache read and costs nothing.
            content_updated_at: products.contentUpdatedAt,
            created_at: products.createdAt,
            category: categories.name,
          })
          .from(products)
          .leftJoin(categories, eq(products.categoryId, categories.id))
          .where(
            and(
              eq(products.storeId, storeId),
              eq(products.status, "published"),
            ),
          )
          .orderBy(asc(products.sortOrder), desc(products.createdAt));

        if (rows.length === 0) return [];

        // Pricing-relevant variant fields for all listed products in one query,
        // grouped in JS (replaces the PostgREST embedded `variants:(...)`).
        const variantRows = await db
          .select({
            product_id: productVariants.productId,
            base_price: productVariants.basePrice,
            selling_price: productVariants.sellingPrice,
            special_price: productVariants.specialPrice,
            sort_order: productVariants.sortOrder,
            track_inventory: productVariants.trackInventory,
            stock: productVariants.onlineStock,
            low_stock_threshold: productVariants.lowStockThreshold,
            allow_backorder: productVariants.allowBackorder,
          })
          .from(productVariants)
          .where(
            inArray(
              productVariants.productId,
              rows.map((r) => r.id),
            ),
          );

        const byProduct = new Map<string, ProductCardRow["variants"]>();
        for (const { product_id, ...variant } of variantRows) {
          const list = byProduct.get(product_id) ?? [];
          list.push(variant);
          byProduct.set(product_id, list);
        }
        return rows.map((r) => ({
          ...r,
          variants: byProduct.get(r.id) ?? [],
        }));
      });
    } catch (err) {
      console.error(
        "getPublishedProducts:",
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  },
  // v2: rows gained created_at; a new key keeps an older cached entry (which
  // lacks it) from being served after a deploy.
  ["storefront-published-products-v2"],
  { tags: [TAGS.products], revalidate: REVALIDATE },
);

export const getActiveCategories = unstable_cache(
  async (storeId: string): Promise<CategoryRow[]> => {
    try {
      return await withAnon((db) =>
        db
          .select({
            id: categories.id,
            name: categories.name,
            slug: categories.slug,
            description: categories.description,
            image_url: categories.imageUrl,
            sort_order: categories.sortOrder,
          })
          .from(categories)
          .where(
            and(
              eq(categories.storeId, storeId),
              eq(categories.status, "active"),
            ),
          )
          .orderBy(asc(categories.sortOrder), asc(categories.name)),
      );
    } catch (err) {
      console.error(
        "getActiveCategories:",
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  },
  // v2: rows gained description (see storefront-published-products-v2).
  ["storefront-active-categories-v2"],
  { tags: [TAGS.categories], revalidate: REVALIDATE },
);

export const getPublishedBlogCards = unstable_cache(
  async (storeId: string): Promise<BlogCardRow[]> => {
    try {
      // Crucially excludes `content` (full article HTML), which the
      // listing/cards never render but `select('*')` used to ship per post.
      const rows = await withAnon((db) =>
        db
          .select({
            id: blogs.id,
            title: blogs.title,
            slug: blogs.slug,
            excerpt: blogs.excerpt,
            cover_image_url: blogs.coverImageUrl,
            author: blogs.author,
            published_at: blogs.publishedAt,
            reading_time: blogs.readingTime,
            tags: blogs.tags,
            categories: blogs.categories,
            featured: blogs.featured,
          })
          .from(blogs)
          .where(and(eq(blogs.storeId, storeId), eq(blogs.status, "published")))
          .orderBy(desc(blogs.publishedAt)),
      );
      // tags is nullable at the DB level; cards expect an array.
      return rows.map((r) => ({ ...r, tags: r.tags ?? [] }));
    } catch (err) {
      console.error(
        "getPublishedBlogCards:",
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  },
  ["storefront-published-blog-cards"],
  { tags: [TAGS.blogs], revalidate: REVALIDATE },
);

// Category/tag OPTIONS offered by the customer write editor (names only — the
// storefront never needs row ids). Managed per store in /dashboard/blogs/settings.
export const getBlogTaxonomyNames = unstable_cache(
  async (
    storeId: string,
  ): Promise<{ categories: string[]; tags: string[] }> => {
    try {
      return await withAnon(async (db) => {
        const cats = await db
          .select({ name: blogCategories.name })
          .from(blogCategories)
          .where(eq(blogCategories.storeId, storeId))
          .orderBy(asc(blogCategories.name));
        const tags = await db
          .select({ name: blogTags.name })
          .from(blogTags)
          .where(eq(blogTags.storeId, storeId))
          .orderBy(asc(blogTags.name));
        return {
          categories: cats.map((r) => r.name),
          tags: tags.map((r) => r.name),
        };
      });
    } catch (err) {
      console.error(
        "getBlogTaxonomyNames:",
        err instanceof Error ? err.message : err,
      );
      return { categories: [], tags: [] };
    }
  },
  ["storefront-blog-taxonomy"],
  { tags: [TAGS.blogTaxonomy], revalidate: REVALIDATE },
);

// A published store_pages row for the storefront. Selects NAMED columns only
// (the anon role can't read the draft `sections` column — see store_pages.sql)
// and returns the live `published_sections`. `null` (incl. cached nulls, so a
// 404 storm on junk URLs stays cheap) means "no such published page".
export interface PublishedPage {
  id: string;
  slug: string;
  title: string;
  seo_title: string;
  seo_description: string;
  seo_noindex: boolean;
  published_sections: PageSectionItem[];
}

export const getPublishedPage = unstable_cache(
  async (storeId: string, slug: string): Promise<PublishedPage | null> => {
    try {
      const rows = await withAnon((db) =>
        db
          .select({
            id: storePages.id,
            slug: storePages.slug,
            title: storePages.title,
            seo_title: storePages.seoTitle,
            seo_description: storePages.seoDescription,
            seo_noindex: storePages.seoNoindex,
            published_sections: storePages.publishedSections,
          })
          .from(storePages)
          .where(
            and(
              eq(storePages.storeId, storeId),
              eq(storePages.slug, slug),
              eq(storePages.status, "published"),
            ),
          )
          .limit(1),
      );
      return (rows[0] as unknown as PublishedPage | undefined) ?? null;
    } catch {
      return null;
    }
  },
  ["storefront-store-page"],
  { tags: [TAGS.pages], revalidate: REVALIDATE },
);

// Per-store navigation (header + footer). Returns normalized menus, falling
// back to DEFAULT_MENUS for any store without a row (or empty fields). Consumed
// by the storefront layout → MenuProvider → Header/Footer.
export const getStoreMenus = unstable_cache(
  async (storeId: string): Promise<StoreMenus> => {
    try {
      const rows = await withAnon((db) =>
        db
          .select({
            header: storeMenus.header,
            footer_groups: storeMenus.footerGroups,
            footer_legal: storeMenus.footerLegal,
          })
          .from(storeMenus)
          .where(eq(storeMenus.storeId, storeId))
          .limit(1),
      );
      return normalizeMenus(rows[0] ?? null);
    } catch {
      return normalizeMenus(null);
    }
  },
  ["storefront-store-menus"],
  { tags: [TAGS.menus], revalidate: REVALIDATE },
);

// Per-store tax classes (named rate buckets), sorted for display. Read by the
// storefront/checkout to resolve a product's tax rate and by the invoice
// renderer. Empty when the store has none / the table is missing.
export const getStoreTaxClasses = unstable_cache(
  async (storeId: string): Promise<TaxClass[]> => {
    try {
      const rows = await withAnon((db) =>
        db
          .select({
            id: taxClasses.id,
            name: taxClasses.name,
            rate: taxClasses.rate,
            sort_order: taxClasses.sortOrder,
          })
          .from(taxClasses)
          .where(eq(taxClasses.storeId, storeId))
          .orderBy(asc(taxClasses.sortOrder), asc(taxClasses.name)),
      );
      return rows.map((r) => rowToTaxClass(r as Record<string, unknown>));
    } catch {
      return [];
    }
  },
  ["storefront-tax-classes"],
  { tags: [TAGS.billing], revalidate: REVALIDATE },
);

// Per-store billing + invoice settings. Falls back to DEFAULT_BILLING_SETTINGS
// for a store with no row (tax off, generic invoice), so callers never null-check.
export const getStoreBillingSettings = unstable_cache(
  async (storeId: string): Promise<BillingSettings> => {
    try {
      const rows = await withAnon((db) =>
        db
          .select({
            store_id: storeBillingSettings.storeId,
            tax_enabled: storeBillingSettings.taxEnabled,
            prices_include_tax: storeBillingSettings.pricesIncludeTax,
            default_tax_class_id: storeBillingSettings.defaultTaxClassId,
            business_name: storeBillingSettings.businessName,
            business_address: storeBillingSettings.businessAddress,
            tax_id: storeBillingSettings.taxId,
            contact_email: storeBillingSettings.contactEmail,
            contact_phone: storeBillingSettings.contactPhone,
            logo_url: storeBillingSettings.logoUrl,
            invoice_prefix: storeBillingSettings.invoicePrefix,
            accent_color: storeBillingSettings.accentColor,
            footer_note: storeBillingSettings.footerNote,
            terms: storeBillingSettings.terms,
            template: storeBillingSettings.template,
          })
          .from(storeBillingSettings)
          .where(eq(storeBillingSettings.storeId, storeId))
          .limit(1),
      );
      return rowToBillingSettings(
        (rows[0] as Record<string, unknown> | undefined) ?? null,
      );
    } catch {
      return rowToBillingSettings(null);
    }
  },
  ["storefront-billing-settings"],
  { tags: [TAGS.billing], revalidate: REVALIDATE },
);

// Published page slugs for the current store — used by the sitemap.
export const getPublishedPageSlugs = unstable_cache(
  async (
    storeId: string,
  ): Promise<
    { slug: string; updated_at: string; published_at: string | null }[]
  > => {
    try {
      const rows = await withAnon((db) =>
        db
          .select({
            slug: storePages.slug,
            updated_at: storePages.updatedAt,
            // The sitemap's lastmod source. `updated_at` is NOT usable for it:
            // a BEFORE-UPDATE trigger bumps it and savePageDraft writes
            // `sections` on every autosave debounce, so editing an UNPUBLISHED
            // draft advances it dozens of times while the public HTML is
            // unchanged. published_at moves only when the page actually goes
            // live. Already anon-granted (supabase/store_pages.sql).
            published_at: storePages.publishedAt,
            seo_noindex: storePages.seoNoindex,
          })
          .from(storePages)
          .where(
            and(
              eq(storePages.storeId, storeId),
              eq(storePages.status, "published"),
            ),
          ),
      );
      // The homepage sentinel (slug '') is served by `/`, not as a custom page.
      // Pages the merchant flagged noindex must not appear in the sitemap either —
      // a sitemap that advertises URLs it also asks crawlers to skip is a bad
      // signal.
      return rows.filter((r) => !!r.slug && !r.seo_noindex);
    } catch {
      return [];
    }
  },
  ["storefront-store-page-slugs"],
  { tags: [TAGS.pages], revalidate: REVALIDATE },
);
