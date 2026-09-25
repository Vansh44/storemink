"use server";

import { and, asc, eq } from "drizzle-orm";
import { withAnon } from "@/lib/db/client";
import { categories, productVariants, products } from "@/drizzle/schema";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { normalizeOptions, type ProductOption } from "@/lib/products/options";

// ---------------------------------------------------------------------------
// The one product a card's "+ Add" needs when it has variants: its option
// axes and every variant's price and stock, loaded when the shopper taps the
// button rather than shipped with every card in the grid.
//
// ★ Everything returned is what the public product page already shows — a
//   published product of the HOST's store, read under the anonymous role —
//   so this grants nothing the storefront does not. The store is never an
//   argument: it comes from the request host, and a product id from another
//   store simply finds nothing.
// ★ Prices here only PREVIEW. The cart re-prices every line on the server at
//   checkout (placeOrder), so a stale number costs a wrong label, never a
//   wrong charge.
// ---------------------------------------------------------------------------

export interface QuickAddVariant {
  id: string;
  name: string;
  base_price: number;
  selling_price: number;
  special_price: number | null;
  images: string[] | null;
  track_inventory: boolean;
  stock: number;
  low_stock_threshold: number | null;
  allow_backorder: boolean;
  option_values: string[];
}

export interface QuickAddProduct {
  id: string;
  slug: string;
  name: string;
  image_url: string | null;
  category: string | null;
  options: ProductOption[];
  variants: QuickAddVariant[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getQuickAddProduct(
  productId: string,
): Promise<QuickAddProduct | null> {
  if (typeof productId !== "string" || !UUID.test(productId)) return null;
  const store = await getCurrentStoreOrNull();
  if (!store) return null;

  try {
    return await withAnon(async (db) => {
      const rows = await db
        .select({
          id: products.id,
          slug: products.slug,
          name: products.name,
          image_url: products.imageUrl,
          options: products.options,
          category: categories.name,
        })
        .from(products)
        .leftJoin(categories, eq(products.categoryId, categories.id))
        .where(
          and(
            eq(products.storeId, store.id),
            eq(products.id, productId),
            eq(products.status, "published"),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;

      const variants = await db
        .select({
          id: productVariants.id,
          name: productVariants.name,
          base_price: productVariants.basePrice,
          selling_price: productVariants.sellingPrice,
          special_price: productVariants.specialPrice,
          images: productVariants.images,
          track_inventory: productVariants.trackInventory,
          stock: productVariants.onlineStock,
          low_stock_threshold: productVariants.lowStockThreshold,
          allow_backorder: productVariants.allowBackorder,
          option_values: productVariants.optionValues,
        })
        .from(productVariants)
        .where(eq(productVariants.productId, row.id))
        .orderBy(asc(productVariants.sortOrder));

      const normalized = normalizeOptions(row.options);
      return {
        ...row,
        options: "options" in normalized ? normalized.options : [],
        variants,
      };
    });
  } catch (err) {
    console.error(
      "getQuickAddProduct:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
