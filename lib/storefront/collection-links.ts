// ---------------------------------------------------------------------------
// A category's address, and the redirect from the query form it replaced.
// Pure, so the shop page, the search route, the homepage tiles and the tests
// cannot disagree about either.
// ---------------------------------------------------------------------------

/** /collections/<slug> — a category's own page. */
export function collectionPath(slug: string): string {
  return `/collections/${encodeURIComponent(slug)}`;
}

type Params = Record<string, string | string[] | undefined>;

/**
 * Where `/shop?category=<slug>` should go, or null to render /shop.
 *
 * ★ Only a slug that names an ACTIVE category redirects. An unknown or hidden
 * slug shows the whole shop, as it always did, rather than bouncing to a
 * collection page that would 404. `uncategorized` is the "Other" view of /shop,
 * not a category. Every other parameter — the search, a sort, a filter — is
 * carried across, so an old link keeps meaning what it meant.
 */
export function legacyCategoryRedirect(
  params: Params,
  categories: readonly { slug: string }[],
): string | null {
  const raw = params.category;
  const slug = Array.isArray(raw) ? raw[0] : raw;
  if (!slug || slug === "uncategorized") return null;
  const category = categories.find((c) => c.slug === slug);
  if (!category) return null;

  const rest = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const v = Array.isArray(value) ? value[0] : value;
    if (key !== "category" && v !== undefined) rest.set(key, v);
  }
  const query = rest.toString();
  return `${collectionPath(category.slug)}${query ? `?${query}` : ""}`;
}

/**
 * The collections worth listing in a sitemap: only those with a product on
 * them (an empty collection is thin content, the /shop rule), each dated by
 * its newest product's content change. Never a fabricated date — a collection
 * whose products carry none gets none.
 */
export function populatedCollections<
  C extends { id: string; slug: string; image_url: string | null },
>(
  categories: readonly C[],
  products: readonly {
    category_id: string | null;
    content_updated_at: string | null;
  }[],
): { category: C; lastModified: Date | undefined }[] {
  const newest = new Map<string, number>();
  const populated = new Set<string>();
  for (const p of products) {
    if (!p.category_id) continue;
    populated.add(p.category_id);
    const t = p.content_updated_at ? Date.parse(p.content_updated_at) : NaN;
    if (Number.isFinite(t) && t > (newest.get(p.category_id) ?? 0)) {
      newest.set(p.category_id, t);
    }
  }
  return categories
    .filter((c) => c.slug && populated.has(c.id))
    .map((c) => {
      const t = newest.get(c.id);
      return { category: c, lastModified: t ? new Date(t) : undefined };
    });
}
