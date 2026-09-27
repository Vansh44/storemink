import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { LEGAL_DOCS } from "@/lib/legal/documents";
import { matchesDisallow } from "@/lib/seo/disallow";
import {
  HELP_URL,
  PLATFORM_URL,
  POS_URL,
  THEMES_URL,
  storeOrigin,
} from "@/lib/site";
import {
  SEARCH_INDEXABLE,
  isHelpHost,
  isPosHost,
  isPlatformHost,
  isThemesHost,
} from "@/lib/store/host";
import { isStoreSearchIndexable } from "@/lib/store/launch";
import {
  getActiveCategories,
  getPublishedProducts,
  getPublishedBlogCards,
  getPublishedPageSlugs,
} from "@/lib/storefront/queries";
import { getPublishedHelpArticleParams } from "@/lib/help/queries";
import {
  collectionPath,
  populatedCollections,
} from "@/lib/storefront/collection-links";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";

// NOTE: no `export const revalidate` here — it would be dead config. This route
// awaits headers() (the sitemap is per-host, necessarily), which forces it fully
// dynamic; live responses carry `cache-control: public, max-age=0,
// must-revalidate` regardless of any revalidate value. Freshness is already
// bounded by the tagged unstable_cache reads underneath (300s, plus
// revalidateTag on every publish), so a publish reaches the sitemap within
// ~5 minutes without one.

type ChangeFreq = MetadataRoute.Sitemap[number]["changeFrequency"];

// Only the routes that exist for EVERY store live in code (the interactive
// route groups that were never migrated to store_pages). Everything else —
// our-story, faqs, contact, gift-packs, … — is now per-store data in
// store_pages and comes from getPublishedPageSlugs below, so this sitemap is
// correct for any tenant, not just WholeSip. (Storefront routes live in the
// parenthesised (storefront)/(pages) groups, which add no URL segment, e.g.
// /shop not /pages/shop.) Auth-gated / utility routes — cart, profile, order
// tracking, blog authoring, my-submissions — are intentionally omitted.
const STATIC_PATHS: { path: string; priority: number; freq: ChangeFreq }[] = [
  { path: "/", priority: 1, freq: "daily" },
  { path: "/shop", priority: 0.9, freq: "daily" },
  { path: "/blogs", priority: 0.7, freq: "weekly" },
];

// Image sitemaps need an absolute image URL. Uploaded media is already an
// absolute URL (GCS, or legacy Supabase Storage); theme-bundled imagery is a
// site-relative /public path, so resolve that against the store origin.
// Anything else is skipped.
function imageEntry(
  siteUrl: string,
  url: string | null | undefined,
): { images?: string[] } {
  if (!url) return {};
  if (/^https?:\/\//.test(url)) return { images: [url] };
  if (url.startsWith("/")) return { images: [`${siteUrl}${url}`] };
  return {};
}

// The platform apex (storemink.com) has no store catalog — its sitemap is its
// own public marketing pages. Kept separate from the per-store sitemap so the
// WholeSip fallback never leaks its products into storemink.com/sitemap.xml.
const PLATFORM_PATHS: { path: string; priority: number; freq: ChangeFreq }[] = [
  { path: "/", priority: 1, freq: "weekly" },
  { path: "/signup", priority: 0.8, freq: "monthly" },
  { path: "/legal", priority: 0.3, freq: "yearly" },
  // Derived from the legal registry rather than hardcoded, so publishing a new
  // required document can't leave its page unlisted. These are real, public,
  // indexable pages — an apex advertising only two URLs has almost nothing for
  // Google to establish the site with.
  ...LEGAL_DOCS.map((d) => ({
    path: `/legal/${d.slug}`,
    priority: 0.3,
    freq: "yearly" as const,
  })),
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Only production (storemink.com) is crawlable; staging / previews / dev emit
  // an empty sitemap (see robots.ts + SEARCH_INDEXABLE in lib/store/host.ts).
  if (!SEARCH_INDEXABLE) return [];

  // NOTE: there is deliberately no `const now = new Date()` here any more. Every
  // lastmod below is derived from real content timestamps or omitted entirely.
  // A request-time value is indistinguishable from "this page changed on every
  // crawl", and Google responds by discarding lastmod for the WHOLE site —
  // including the article and blog dates that are accurate.

  // Help centre (help.storemink.com): its own sitemap of the docs. It has no
  // store, so branch before the store/platform resolution below.
  const host =
    (await headers()).get("x-forwarded-host") || (await headers()).get("host");
  if (isHelpHost(host)) {
    // This read deliberately throws on a database failure. Serving Google a
    // successful one-URL sitemap during an outage would falsely announce that
    // every published guide disappeared. A 5xx keeps the previous sitemap in
    // Google's memory and lets the crawler / Cloud Scheduler retry instead.
    const articles = await getPublishedHelpArticleParams();

    // Derive populated categories from the same joined article rows. This
    // makes one successful query the complete authority for the Help sitemap:
    // every reachable published article and its category are included, while
    // empty categories (thin pages) are omitted.
    const categorySlugs = [...new Set(articles.map((a) => a.categorySlug))];

    // lastmod: the newest article the hub/category actually links to. `now` was
    // the request timestamp — it changed on every crawl, which is exactly the
    // pattern that makes Google discard lastmod site-wide, including the
    // per-article values below that ARE accurate.
    const newest = (slugs?: Set<string>): Date | undefined => {
      const times = articles
        .filter((a) => (slugs ? slugs.has(a.categorySlug) : true))
        .map((a) => (a.updatedAt ? new Date(a.updatedAt).getTime() : 0))
        .filter((t) => t > 0);
      return times.length ? new Date(Math.max(...times)) : undefined;
    };

    const entries: MetadataRoute.Sitemap = [
      {
        url: `${HELP_URL}/help`,
        ...(newest() ? { lastModified: newest() } : {}),
        changeFrequency: "weekly",
        priority: 1,
      },
      ...categorySlugs.map((categorySlug) => {
        const mod = newest(new Set([categorySlug]));
        return {
          url: `${HELP_URL}/help/${categorySlug}`,
          ...(mod ? { lastModified: mod } : {}),
          changeFrequency: "weekly" as const,
          priority: 0.7,
        };
      }),
      ...articles.map((a) => ({
        url: `${HELP_URL}/help/${a.categorySlug}/${a.slug}`,
        ...(a.updatedAt ? { lastModified: new Date(a.updatedAt) } : {}),
        changeFrequency: "monthly" as const,
        priority: 0.8,
      })),
    ];
    return entries;
  }

  if (isThemesHost(host)) {
    return [
      {
        url: THEMES_URL,
        changeFrequency: "weekly",
        priority: 1,
      },
    ];
  }

  if (isPosHost(host)) {
    return [
      {
        url: POS_URL,
        changeFrequency: "monthly",
        priority: 1,
      },
    ];
  }

  // Per-host: resolve the store on the requesting domain.
  const store = await getCurrentStoreOrNull();

  // A store-SHAPED host with no store behind it (unclaimed subdomain, suspended
  // store, unseeded demo) must NOT answer with the platform's sitemap — that
  // served storemink.com's URLs from every parked subdomain, so the same two
  // URLs were advertised by an unbounded number of hosts. It has nothing of its
  // own to offer; say nothing. (app/robots.ts disallows the same hosts.)
  if (!store && !isPlatformHost(host)) return [];

  // Not yet launched (still pure theme seed) or a demo showcase → nothing of
  // its own to offer. Mirrors the same branch in app/robots.ts; see
  // lib/store/launch.ts for why submitting these harms every other store on
  // the domain.
  if (store && !isStoreSearchIndexable(store)) {
    return [];
  }

  if (!store) {
    // No lastModified: these are hand-authored marketing/legal pages with no
    // content timestamp to read. `now` was worse than nothing — an unchanged
    // page claiming to have changed on every crawl is precisely what makes
    // Google stop trusting lastmod across the whole site.
    return PLATFORM_PATHS.map((p) => ({
      url: `${PLATFORM_URL}${p.path === "/" ? "" : p.path}`,
      changeFrequency: p.freq,
      priority: p.priority,
    }));
  }

  // Custom domain only once VERIFIED — see storeOrigin(). Submitting <loc>s on
  // an unverified domain pointed Google at a host that doesn't resolve.
  const siteUrl = storeOrigin(store);
  const storeId = store.id;

  // Dynamic product + blog detail pages, plus merchant-built custom pages, for
  // THIS store. A failed DB read must never break the sitemap, so each falls
  // back to empty.
  const [products, blogs, customPages, activeCategories] = await Promise.all([
    getPublishedProducts(storeId).catch(() => []),
    getPublishedBlogCards(storeId).catch(() => []),
    getPublishedPageSlugs(storeId).catch(() => []),
    getActiveCategories(storeId).catch(() => []),
  ]);

  const blogRows = blogs as {
    slug: string;
    published_at: string | null;
    cover_image_url: string | null;
  }[];

  // A hub page's honest lastmod is the newest thing it lists.
  const newestOf = (
    values: (string | null | undefined)[],
  ): Date | undefined => {
    const times = values
      .map((v) => (v ? new Date(v).getTime() : 0))
      .filter((t) => t > 0);
    return times.length ? new Date(Math.max(...times)) : undefined;
  };

  const newestBlog = newestOf(blogRows.map((b) => b.published_at));
  const newestProduct = newestOf(
    (products as { content_updated_at: string | null }[]).map(
      (p) => p.content_updated_at,
    ),
  );

  // Hub pages are listed only when they have something on them: an empty /shop
  // or /blogs is thin content, and submitting it asks Google to spend crawl
  // budget learning nothing. Both lists are already fetched, so this is free.
  // /enquiries was dropped outright — a contact form is not a landing page.
  const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.filter((p) => {
    if (p.path === "/shop") return products.length > 0;
    if (p.path === "/blogs") return blogRows.length > 0;
    return true;
  }).map((p) => {
    // Each hub dates itself by the newest item it lists. `/` is omitted: the
    // homepage is builder sections whose publish time isn't in any read above,
    // and an invented date is worse than none — see the platform branch.
    const mod =
      p.path === "/blogs"
        ? newestBlog
        : p.path === "/shop"
          ? newestProduct
          : undefined;
    return {
      url: `${siteUrl}${p.path === "/" ? "" : p.path}`,
      ...(mod ? { lastModified: mod } : {}),
      changeFrequency: p.freq,
      priority: p.priority,
    };
  });

  const productEntries: MetadataRoute.Sitemap = (
    products as {
      slug: string;
      image_url: string | null;
      content_updated_at: string | null;
    }[]
  )
    .filter((p) => p.slug)
    .map((p) => ({
      url: `${siteUrl}/shop/${p.slug}`,
      // content_updated_at, NOT updated_at: the latter is bumped by
      // _recompute_stock_aggregate on every sale, so it would claim a content
      // change per purchase. See supabase/seo_01_product_content_timestamp.sql.
      ...(p.content_updated_at
        ? { lastModified: new Date(p.content_updated_at) }
        : {}),
      changeFrequency: "weekly",
      priority: 0.8,
      ...imageEntry(siteUrl, p.image_url),
    }));

  // Each category's own page, listed only when it has a product on it — an
  // empty collection is thin content, the /shop rule above.
  const collectionEntries: MetadataRoute.Sitemap = populatedCollections(
    activeCategories,
    products as {
      category_id: string | null;
      content_updated_at: string | null;
    }[],
  )
    .filter(({ category }) => !matchesDisallow(collectionPath(category.slug)))
    .map(({ category, lastModified }) => ({
      url: `${siteUrl}${collectionPath(category.slug)}`,
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: "weekly" as const,
      priority: 0.7,
      ...imageEntry(siteUrl, category.image_url),
    }));

  const blogEntries: MetadataRoute.Sitemap = blogRows
    .filter((b) => b.slug)
    .map((b) => ({
      url: `${siteUrl}/blogs/${b.slug}`,
      ...(b.published_at ? { lastModified: new Date(b.published_at) } : {}),
      changeFrequency: "monthly",
      priority: 0.6,
      ...imageEntry(siteUrl, b.cover_image_url),
    }));

  // Never submit a page robots.txt blocks. A merchant can slug a page anything,
  // including a path on the disallow list, and advertising a URL we then refuse
  // to let crawlers fetch is worse than not listing it at all.
  const pageEntries: MetadataRoute.Sitemap = customPages
    .filter((p) => p.slug && !matchesDisallow(`/${p.slug}`))
    .map((p) => ({
      url: `${siteUrl}/${p.slug}`,
      // published_at, NOT updated_at: a BEFORE-UPDATE trigger plus savePageDraft
      // writing `sections` on every autosave debounce means updated_at advances
      // while a merchant edits an UNPUBLISHED draft — the public HTML unchanged
      // the whole time. published_at moves only when the page goes live.
      ...(p.published_at ? { lastModified: new Date(p.published_at) } : {}),
      changeFrequency: "monthly",
      priority: 0.6,
    }));

  return [
    ...staticEntries,
    ...collectionEntries,
    ...productEntries,
    ...blogEntries,
    ...pageEntries,
  ];
}
