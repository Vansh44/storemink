// ---------------------------------------------------------------------------
// Storefront product search — the ONE matching rule, shared by the shop grid's
// ?q= filter and the header's predictive dropdown.
//
// ★ ONE RULE, BECAUSE THE DROPDOWN MAKES A PROMISE. Its last row is "See all
// results for …", which opens /shop?q=. If the dropdown matched more loosely
// than the grid, a shopper would see a product in the suggestions and then not
// find it on the results page it links to; more strictly, and the grid would
// show products the suggestions called absent. Both call matchesProductQuery.
//
// ★ A PHRASE, NOT WORDS: the query is matched as one lowercase substring of the
// name, description or category, which is what the grid has always done. The
// ranking below only ORDERS those matches — name hits first — it never admits
// a product the grid would reject.
//
// Pure: no server imports, so the client grid and the route handler share it.
// ---------------------------------------------------------------------------

export interface SearchableProduct {
  name: string;
  description?: string | null;
  category?: string | null;
}

export interface SearchableCategory {
  name: string;
  slug: string;
}

/** One suggested product, as GET /api/storefront/search returns it. */
export interface PredictiveProduct {
  name: string;
  href: string;
  imageUrl: string | null;
  price: number;
  compareAt: number | null;
  category: string | null;
}

export interface PredictiveResponse {
  query: string;
  products: PredictiveProduct[];
  categories: { name: string; href: string }[];
  /** Every product the grid would show for this query, not just the six. */
  total: number;
}

/** Shortest query that asks the server anything; one letter matches most of
 * a catalogue and tells the shopper nothing. */
export const PREDICTIVE_MIN_CHARS = 2;
export const PREDICTIVE_MAX_QUERY = 80;
export const PREDICTIVE_PRODUCT_LIMIT = 6;
export const PREDICTIVE_CATEGORY_LIMIT = 3;

export function normalizeProductQuery(raw: string): string {
  return raw.trim().slice(0, PREDICTIVE_MAX_QUERY).toLowerCase();
}

/** The shop grid's rule: the whole phrase inside the name, description or
 * category. An empty query matches everything, as an empty search box does. */
export function matchesProductQuery(
  product: SearchableProduct,
  rawQuery: string,
): boolean {
  const q = normalizeProductQuery(rawQuery);
  if (!q) return true;
  return (
    product.name.toLowerCase().includes(q) ||
    (product.description ?? "").toLowerCase().includes(q) ||
    (product.category ?? "").toLowerCase().includes(q)
  );
}

/** Higher is better: a name that starts with the query, then a word in the
 * name that does, then the name anywhere, then the category, then the
 * description. -1 for no match. */
export function productMatchRank(
  product: SearchableProduct,
  rawQuery: string,
): number {
  const q = normalizeProductQuery(rawQuery);
  if (!q) return 0;
  const name = product.name.toLowerCase();
  if (name.startsWith(q)) return 5;
  if (name.split(/[\s\-/(]+/).some((word) => word.startsWith(q))) return 4;
  if (name.includes(q)) return 3;
  if ((product.category ?? "").toLowerCase().includes(q)) return 2;
  if ((product.description ?? "").toLowerCase().includes(q)) return 1;
  return -1;
}

/** The matching products, best first; ties keep catalogue order. */
export function rankProducts<T extends SearchableProduct>(
  products: readonly T[],
  rawQuery: string,
  limit: number = PREDICTIVE_PRODUCT_LIMIT,
): { items: T[]; total: number } {
  const ranked = products
    .map((product, index) => ({
      product,
      index,
      rank: productMatchRank(product, rawQuery),
    }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => b.rank - a.rank || a.index - b.index);
  return {
    items: ranked.slice(0, limit).map((entry) => entry.product),
    total: ranked.length,
  };
}

/** Categories whose NAME contains the query, prefix matches first. */
export function rankCategories<T extends SearchableCategory>(
  categories: readonly T[],
  rawQuery: string,
  limit: number = PREDICTIVE_CATEGORY_LIMIT,
): T[] {
  const q = normalizeProductQuery(rawQuery);
  if (!q) return [];
  return categories
    .map((category, index) => {
      const name = category.name.toLowerCase();
      const rank = name.startsWith(q) ? 2 : name.includes(q) ? 1 : -1;
      return { category, index, rank };
    })
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => b.rank - a.rank || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.category);
}
