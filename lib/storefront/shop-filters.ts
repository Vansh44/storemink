// ---------------------------------------------------------------------------
// Shop page sort, filters and "load more" — the pure half, shared by the
// server (which reads the URL and renders the first paint) and the client
// (which applies a change without a round trip).
//
// ★ THE URL IS THE STATE. A sorted, filtered view is a link a shopper can
// share or come back to, so every choice lives in the query string:
// `sort`, `stock=in`, `min`, `max` and `page`. Defaults are OMITTED, so an
// untouched page has a clean address and `/shop` stays `/shop`.
//
// ★ A BAD PARAMETER IS IGNORED, NEVER AN ERROR. These arrive from links typed
// by hand, pasted into chats and cached by crawlers; a shopper who follows
// `?sort=cheapest` should see the shop, not a 404.
//
// ★ "LOAD MORE" SHOWS PAGES OF WHAT IS ALREADY LOADED. The storefront reads a
// store's whole published catalogue once (cached), so this bounds how many
// cards — and images — the page draws, not how much is fetched. `page=2`
// means "the first two pages", so a shared or reloaded link shows everything
// the shopper had revealed rather than only the last page of it.
// ---------------------------------------------------------------------------

export const SHOP_SORTS = [
  "featured",
  "price-asc",
  "price-desc",
  "newest",
  "name",
] as const;
export type ShopSort = (typeof SHOP_SORTS)[number];

export const SHOP_SORT_LABELS: Record<ShopSort, string> = {
  featured: "Featured",
  "price-asc": "Price, low to high",
  "price-desc": "Price, high to low",
  newest: "Newest",
  name: "Name, A–Z",
};

/** Cards per "page". 24 fills whole rows at 2, 3 and 4 columns. */
export const SHOP_PAGE_SIZE = 24;
/** A crafted `page=` must not ask the grid to draw a whole catalogue twice. */
const MAX_PAGES = 200;
/** Rupees; an absurd bound is dropped rather than honoured. */
const MAX_PRICE = 10_000_000;

export interface ShopQuery {
  sort: ShopSort;
  /** Hide products that cannot be bought right now. */
  inStock: boolean;
  /** Whole rupees, inclusive. Null = no bound. */
  min: number | null;
  max: number | null;
  /** How many pages are revealed (1 = the first SHOP_PAGE_SIZE cards). */
  pages: number;
}

export const DEFAULT_SHOP_QUERY: ShopQuery = {
  sort: "featured",
  inStock: false,
  min: null,
  max: null,
  pages: 1,
};

type ParamSource =
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

function read(source: ParamSource, key: string): string | undefined {
  if (source instanceof URLSearchParams) return source.get(key) ?? undefined;
  const value = source[key];
  return Array.isArray(value) ? value[0] : value;
}

function readPrice(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > MAX_PRICE) return null;
  return Math.floor(value);
}

export function parseShopQuery(source: ParamSource): ShopQuery {
  const sortRaw = read(source, "sort");
  const sort = (SHOP_SORTS as readonly string[]).includes(sortRaw ?? "")
    ? (sortRaw as ShopSort)
    : "featured";

  let min = readPrice(read(source, "min"));
  let max = readPrice(read(source, "max"));
  // A range typed backwards means what it obviously means.
  if (min !== null && max !== null && min > max) [min, max] = [max, min];

  const pageRaw = Number(read(source, "page"));
  const pages =
    Number.isInteger(pageRaw) && pageRaw >= 1
      ? Math.min(pageRaw, MAX_PAGES)
      : 1;

  return {
    sort,
    inStock: read(source, "stock") === "in",
    min,
    max,
    pages,
  };
}

/** The query-string entries for a view, defaults omitted. */
export function shopQueryEntries(query: ShopQuery): [string, string][] {
  const out: [string, string][] = [];
  if (query.sort !== "featured") out.push(["sort", query.sort]);
  if (query.inStock) out.push(["stock", "in"]);
  if (query.min !== null) out.push(["min", String(query.min)]);
  if (query.max !== null) out.push(["max", String(query.max)]);
  if (query.pages > 1) out.push(["page", String(query.pages)]);
  return out;
}

/**
 * Write a view onto an existing query string, keeping anything else in it
 * (`q` from the header search) and dropping stale shop keys.
 */
export function withShopQuery(
  base: URLSearchParams,
  query: ShopQuery,
): URLSearchParams {
  const next = new URLSearchParams(base);
  for (const key of ["sort", "stock", "min", "max", "page"]) next.delete(key);
  for (const [key, value] of shopQueryEntries(query)) next.set(key, value);
  return next;
}

/** Filters in force, for the button badge and "Clear all". Sort is not one. */
export function activeFilterCount(query: ShopQuery): number {
  return (
    (query.inStock ? 1 : 0) + (query.min !== null || query.max !== null ? 1 : 0)
  );
}

/** What the sort and filters need to know about one product. */
export interface ShopFacts {
  /** The price a shopper pays, as the card shows it. */
  price: number;
  soldOut: boolean;
  name: string;
  createdAt: string | null;
}

/**
 * Filter then sort. Ties keep the input order, which is the store's own
 * "featured" order, so re-sorting never shuffles products the shopper was
 * already looking at.
 */
export function applyShopQuery<T>(
  items: readonly T[],
  query: ShopQuery,
  facts: (item: T) => ShopFacts,
): T[] {
  const rows = items
    .map((item, index) => ({ item, index, facts: facts(item) }))
    .filter(({ facts: f }) => {
      if (query.inStock && f.soldOut) return false;
      if (query.min !== null && f.price < query.min) return false;
      if (query.max !== null && f.price > query.max) return false;
      return true;
    });

  const byIndex = (a: { index: number }, b: { index: number }) =>
    a.index - b.index;
  const time = (value: string | null) => {
    const t = value ? Date.parse(value) : NaN;
    return Number.isFinite(t) ? t : 0;
  };

  switch (query.sort) {
    case "price-asc":
      rows.sort((a, b) => a.facts.price - b.facts.price || byIndex(a, b));
      break;
    case "price-desc":
      rows.sort((a, b) => b.facts.price - a.facts.price || byIndex(a, b));
      break;
    case "newest":
      rows.sort(
        (a, b) =>
          time(b.facts.createdAt) - time(a.facts.createdAt) || byIndex(a, b),
      );
      break;
    case "name":
      rows.sort(
        (a, b) =>
          a.facts.name.localeCompare(b.facts.name, undefined, {
            sensitivity: "base",
            numeric: true,
          }) || byIndex(a, b),
      );
      break;
    case "featured":
      break;
  }
  return rows.map((row) => row.item);
}

/** The price span of a list, whole rupees, for the filter's placeholders. */
export function priceSpan(
  prices: readonly number[],
): { min: number; max: number } | null {
  const valid = prices.filter((p) => Number.isFinite(p) && p >= 0);
  if (valid.length === 0) return null;
  return {
    min: Math.floor(Math.min(...valid)),
    max: Math.ceil(Math.max(...valid)),
  };
}
