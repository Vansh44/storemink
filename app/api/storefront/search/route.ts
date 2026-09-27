import { effectivePricing } from "@/lib/pricing";
import { collectionPath } from "@/lib/storefront/collection-links";
import { productGallery } from "@/lib/products/gallery";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import {
  getActiveCategories,
  getPublishedProducts,
} from "@/lib/storefront/queries";
import {
  normalizeProductQuery,
  PREDICTIVE_MIN_CHARS,
  type PredictiveResponse,
  rankCategories,
  rankProducts,
} from "@/lib/storefront/product-search";

// ---------------------------------------------------------------------------
// GET /api/storefront/search?q= — the header's predictive search.
//
// ★ A ROUTE HANDLER, NOT A SERVER ACTION. Next dispatches Server Actions one
// at a time per client, so a keystroke's lookup would queue in front of the
// shopper's next Add to cart — the POS live-poll lesson (§22). A GET is also
// abortable, which is what lets a newer keystroke cancel an older one.
//
// ★ THE STORE COMES FROM THE HOST, never a parameter, and an unknown host
// answers with nothing — the same rule the storefront pages follow. `/api`
// bypasses proxy.ts, so this route resolves the store itself.
//
// ★ IT READS THE SAME CACHED CATALOGUE THE SHOP GRID RENDERS
// (getPublishedProducts), and matches it with the grid's own rule, so a
// suggestion is always something /shop?q= will show. A keystroke therefore
// costs a cache hit, not a query.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY = (query: string): PredictiveResponse => ({
  query,
  products: [],
  categories: [],
  total: 0,
});

function json(body: PredictiveResponse, maxAge: number): Response {
  return Response.json(body, {
    headers: {
      // Private: the answer depends on the Host, and nothing in front of Cloud
      // Run is told to vary on it. Short, because the catalogue revalidates.
      "Cache-Control": `private, max-age=${maxAge}`,
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = normalizeProductQuery(url.searchParams.get("q") ?? "");
  if (query.length < PREDICTIVE_MIN_CHARS) return json(EMPTY(query), 60);

  const store = await getCurrentStoreOrNull();
  if (!store) return json(EMPTY(query), 60);

  const [products, categories] = await Promise.all([
    getPublishedProducts(store.id),
    getActiveCategories(store.id),
  ]);

  const ranked = rankProducts(products, query);
  const body: PredictiveResponse = {
    query,
    total: ranked.total,
    products: ranked.items.map((product) => {
      const pricing = effectivePricing(product);
      return {
        name: product.name,
        href: `/shop/${product.slug}`,
        imageUrl: productGallery(product.image_url, product.images)[0] ?? null,
        price: pricing.selling,
        compareAt: pricing.base > pricing.selling ? pricing.base : null,
        category: product.category ?? null,
      };
    }),
    categories: rankCategories(categories, query).map((category) => ({
      name: category.name,
      href: collectionPath(category.slug),
    })),
  };
  return json(body, 30);
}
