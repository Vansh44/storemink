import "server-only";

import { and, asc, eq } from "drizzle-orm";
import {
  categories,
  products,
  storeLocations,
  stores,
  userGroups,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { resolveStoreSettings } from "@/lib/settings/registry";

/** Bounded read matching the offer form's product picker. */
const PRODUCT_SCOPE_LIMIT = 200;

/**
 * The acting store's automatic-offer switch for the offer list and forms.
 * Fails to true so an unreadable setting never claims a working offer is off.
 */
export async function loadOffersAutoApply(storeId: string): Promise<boolean> {
  try {
    return await withService(async (db) => {
      const rows = await db
        .select({ settings: stores.settings, plan: stores.plan })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      const values = resolveStoreSettings(
        rows[0]?.settings as Record<string, unknown>,
        rows[0]?.plan,
      );
      return values["offers.autoApply"] === true;
    });
  } catch {
    return true;
  }
}

/** Shared by the new/edit pages so the form's pickers cannot drift. */
export async function loadOfferScopes(storeId: string) {
  const [locations, groups, productRows, categoryRows] = await Promise.all([
    withService((db) =>
      db
        .select({ id: storeLocations.id, name: storeLocations.name })
        .from(storeLocations)
        .where(eq(storeLocations.storeId, storeId))
        .orderBy(asc(storeLocations.name)),
    ).catch(() => [] as { id: string; name: string }[]),
    withService((db) =>
      db
        .select({ id: userGroups.id, name: userGroups.name })
        .from(userGroups)
        .where(eq(userGroups.storeId, storeId))
        .orderBy(asc(userGroups.name)),
    ).catch(() => [] as { id: string; name: string }[]),
    // Published products only: a draft product cannot be bought.
    withService((db) =>
      db
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(
          and(eq(products.storeId, storeId), eq(products.status, "published")),
        )
        .orderBy(asc(products.name))
        .limit(PRODUCT_SCOPE_LIMIT),
    ).catch(() => [] as { id: string; name: string }[]),
    withService((db) =>
      db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(eq(categories.storeId, storeId))
        .orderBy(asc(categories.name)),
    ).catch(() => [] as { id: string; name: string }[]),
  ]);
  return {
    locations,
    groups,
    products: productRows,
    categories: categoryRows,
  };
}
