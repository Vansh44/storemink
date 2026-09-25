import "server-only";

import {
  getActiveCategories,
  getPublishedProducts,
} from "@/lib/storefront/queries";
import { getStorefrontLayout } from "@/lib/store/storefront-layout";
import { getStoreSetting } from "@/lib/settings/resolve";
import { loadOffersForStorefront } from "@/lib/offers/cart";
import { offerBadgeFor, offerTagFor } from "@/lib/offers/badge";
import { effectivePricing } from "@/lib/pricing";
import type { ResolvedStorefrontAppearance } from "@/lib/chrome/types";
import type { ShopCategory, ShopProduct } from "./shop-client";

// ---------------------------------------------------------------------------
// Everything the shop grid needs, read once — shared by /shop and
// /collections/<slug>, which are the same grid scoped two ways. One loader so
// a collection page can never price, badge or filter a product differently
// from the shop page that lists it.
// ---------------------------------------------------------------------------

export interface ShopView {
  products: ShopProduct[];
  categories: ShopCategory[];
  layout: ResolvedStorefrontAppearance;
  lowStockThreshold: number;
  offerBadges: Record<string, { label: string }>;
}

export async function loadShopView(storeId: string): Promise<ShopView> {
  const [
    products,
    categories,
    layout,
    lowStockThreshold,
    showBadges,
    offerBundle,
  ] = await Promise.all([
    getPublishedProducts(storeId),
    getActiveCategories(storeId),
    getStorefrontLayout(),
    getStoreSetting("inventory.lowStockThreshold"),
    getStoreSetting("offers.showBadges"),
    // Joins the same concurrent batch rather than adding a serial read, and
    // fails open to no offers on its own — a shop that cannot show a badge
    // still sells.
    loadOffersForStorefront(storeId, null, []),
  ]);

  const shopProducts = products as unknown as ShopProduct[];
  const shopCategories = categories as unknown as ShopCategory[];

  // Resolved HERE, per product, through the engine itself — so a badge is
  // literally what the cart would give and cannot overstate a saving. See
  // lib/offers/badge.ts for the three ordinary cases a naive "the offer says
  // 20%" badge gets wrong.
  const offerBadges: Record<string, { label: string }> = {};
  if (showBadges !== false) {
    for (const p of shopProducts) {
      const priced = effectivePricing(p);
      const line = {
        productId: p.id,
        categoryId: p.category_id ?? null,
        unitPrice: priced.selling,
        // ★★ THE PRICE IT IS ON SALE FROM, NOT THE MRP. `priced.base` is the
        // struck-through list price: passing it made every product with an
        // MRP read as on sale, and under the default `best` mode the offer was
        // measured against that MRP and scored nothing. `regularSelling` is
        // the variant's own pre-special price, which is what `placeOrder`
        // passes.
        regularUnitPrice: priced.regularSelling,
      };
      const badge = offerBadgeFor(line, offerBundle.offers, offerBundle.policy);
      if (badge) {
        offerBadges[p.id] = { label: badge.label };
        continue;
      }
      // ★★ NO PRICE BADGE IS NOT NO OFFER. `offerBadgeFor` prices ONE unit, so
      // buy-X-get-Y, bundles and quantity breaks all correctly score zero
      // there — none of them is a claim about buying one. The tag states the
      // offer's TERMS instead, which is honest at any quantity, and still
      // proves the offer would apply (see `offerTagFor`).
      const tag = offerTagFor(line, offerBundle.offers, offerBundle.policy);
      if (tag) offerBadges[p.id] = { label: tag.label };
    }
  }

  return {
    products: shopProducts,
    categories: shopCategories,
    layout,
    lowStockThreshold: lowStockThreshold as number,
    offerBadges,
  };
}
