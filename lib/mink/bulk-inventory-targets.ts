import "server-only";

import { and, eq, or, sql } from "drizzle-orm";
import { inventoryLevels } from "@/drizzle/schema";
import type { Db } from "@/lib/db/client";
import type { MinkActorContext } from "./types";

export const MAX_MINK_BULK_INVENTORY_LINES = 20;

export interface MinkBulkInventoryLookupInput {
  sku: string;
  locationName: string;
}

export interface MinkBulkInventoryTarget {
  levelId: string | null;
  productId: string;
  variantId: string | null;
  locationId: string;
  productName: string;
  variantName: string | null;
  sku: string;
  locationName: string;
  onHand: number;
  reserved: number;
  version: string | null;
}

export interface MinkBulkInventoryLineError {
  line: number;
  sku: string;
  location: string;
  code:
    | "duplicate_line"
    | "location_unavailable"
    | "sku_not_found"
    | "sku_ambiguous"
    | "variant_required"
    | "tracking_disabled";
  message: string;
}

export type MinkBulkInventoryTargetResult =
  | {
      line: number;
      input: MinkBulkInventoryLookupInput;
      target: MinkBulkInventoryTarget;
      error: null;
    }
  | {
      line: number;
      input: MinkBulkInventoryLookupInput;
      target: null;
      error: MinkBulkInventoryLineError;
    };

type LocationCandidate = {
  id: string;
  name: string;
  match_count: number;
};

type ProductCandidate = {
  product_id: string;
  product_name: string;
  sku: string;
  product_tracked: boolean;
  has_variants: boolean;
  match_count: number;
};

type VariantCandidate = {
  product_id: string;
  product_name: string;
  product_tracked: boolean;
  variant_id: string;
  variant_name: string;
  sku: string;
  variant_tracked: boolean;
  match_count: number;
};

/**
 * Resolve a bounded batch in four fixed queries, rather than issuing product,
 * location and level reads per line. Every result remains scoped to the
 * trusted actor store and assigned active locations.
 */
export async function resolveMinkBulkInventoryTargets(
  db: Db,
  actor: MinkActorContext,
  inputs: MinkBulkInventoryLookupInput[],
): Promise<MinkBulkInventoryTargetResult[]> {
  if (inputs.length < 1 || inputs.length > MAX_MINK_BULK_INVENTORY_LINES) {
    throw new Error(
      `Bulk inventory requires 1-${MAX_MINK_BULK_INVENTORY_LINES} lines.`,
    );
  }

  const skuValues = [...new Set(inputs.map((input) => input.sku))];
  const locationValues = [
    ...new Set(inputs.map((input) => input.locationName)),
  ];
  const duplicateKeys = new Set<string>();
  const seenKeys = new Set<string>();
  for (const input of inputs) {
    const key = pairKey(input.sku, input.locationName);
    if (seenKeys.has(key)) duplicateKeys.add(key);
    seenKeys.add(key);
  }

  const locationRows =
    actor.locationIds?.length === 0
      ? []
      : await readLocationCandidates(
          db,
          actor,
          locationValues,
          actor.locationIds,
        );
  const productRows = await readProductCandidates(db, actor, skuValues);
  const variantRows = await readVariantCandidates(db, actor, skuValues);

  const locationByName = new Map(
    locationRows.map((row) => [row.name, row] as const),
  );
  const productBySku = new Map(
    productRows.map((row) => [row.sku, row] as const),
  );
  const variantBySku = new Map(
    variantRows.map((row) => [row.sku, row] as const),
  );

  const preliminary = inputs.map((input, index) => {
    const line = index + 1;
    if (duplicateKeys.has(pairKey(input.sku, input.locationName))) {
      return failed(
        line,
        input,
        "duplicate_line",
        "The same SKU and location appears more than once. Combine it into one adjustment.",
      );
    }
    const location = locationByName.get(input.locationName);
    if (!location || Number(location.match_count) !== 1) {
      return failed(
        line,
        input,
        "location_unavailable",
        "The location is not one exact active location accessible to this admin.",
      );
    }
    const product = productBySku.get(input.sku);
    const variant = variantBySku.get(input.sku);
    if (!product && !variant) {
      return failed(
        line,
        input,
        "sku_not_found",
        "The exact SKU was not found in this store.",
      );
    }
    if (
      (product && Number(product.match_count) !== 1) ||
      (variant && Number(variant.match_count) !== 1) ||
      (product && variant)
    ) {
      return failed(
        line,
        input,
        "sku_ambiguous",
        "The SKU is ambiguous. Fix duplicate product or variant SKUs before using a bulk action.",
      );
    }
    if (product?.has_variants) {
      return failed(
        line,
        input,
        "variant_required",
        "This product has variants. Use one exact variant SKU instead.",
      );
    }
    if (
      (product && !product.product_tracked) ||
      (variant && (!variant.product_tracked || !variant.variant_tracked))
    ) {
      return failed(
        line,
        input,
        "tracking_disabled",
        "Inventory tracking is disabled for this SKU.",
      );
    }
    return {
      line,
      input,
      location,
      product,
      variant,
    };
  });

  const ready = preliminary.filter(
    (
      item,
    ): item is Exclude<
      (typeof preliminary)[number],
      MinkBulkInventoryTargetResult
    > => !("error" in item),
  );
  const levelRows = ready.length
    ? await db
        .select({
          id: inventoryLevels.id,
          productId: inventoryLevels.productId,
          variantId: inventoryLevels.variantId,
          locationId: inventoryLevels.locationId,
          onHand: inventoryLevels.onHand,
          reserved: inventoryLevels.reserved,
          version: inventoryLevels.updatedAt,
        })
        .from(inventoryLevels)
        .where(
          and(
            eq(inventoryLevels.storeId, actor.storeId),
            or(
              ...ready.map((item) => {
                const productId =
                  item.variant?.product_id ?? item.product!.product_id;
                const variantId = item.variant?.variant_id ?? null;
                return and(
                  eq(inventoryLevels.locationId, item.location.id),
                  eq(inventoryLevels.productId, productId),
                  variantId
                    ? eq(inventoryLevels.variantId, variantId)
                    : sql`${inventoryLevels.variantId} is null`,
                );
              }),
            ),
          ),
        )
    : [];
  const levelByKey = new Map(
    levelRows.map((row) => [
      targetKey(row.productId, row.variantId, row.locationId),
      row,
    ]),
  );

  return preliminary.map((item) => {
    if ("error" in item) return item;
    const productId = item.variant?.product_id ?? item.product!.product_id;
    const variantId = item.variant?.variant_id ?? null;
    const level = levelByKey.get(
      targetKey(productId, variantId, item.location.id),
    );
    return {
      line: item.line,
      input: item.input,
      error: null,
      target: {
        levelId: level?.id ?? null,
        productId,
        variantId,
        locationId: item.location.id,
        productName: item.variant?.product_name ?? item.product!.product_name,
        variantName: item.variant?.variant_name ?? null,
        sku: item.variant?.sku ?? item.product!.sku,
        locationName: item.location.name,
        onHand: level?.onHand ?? 0,
        reserved: level?.reserved ?? 0,
        version: level?.version ?? null,
      },
    };
  });
}

async function readLocationCandidates(
  db: Db,
  actor: MinkActorContext,
  names: string[],
  locationIds: string[] | null,
) {
  const result = await db.execute(sql`
    select candidate.id, candidate.name, candidate.match_count
    from unnest(${names}::text[]) requested(name)
    cross join lateral (
      select id, name, count(*) over ()::integer as match_count
      from (
        select id, name
        from public.store_locations
        where store_id = ${actor.storeId}::uuid
          and active = true
          and name = requested.name
          and ${locationIds === null ? sql`true` : sql`id = any(${sql.param(locationIds)}::uuid[])`}
        order by id
        limit 2
      ) bounded_matches
      order by id
      limit 1
    ) candidate
  `);
  return result.rows as unknown as LocationCandidate[];
}

async function readProductCandidates(
  db: Db,
  actor: MinkActorContext,
  skus: string[],
) {
  const result = await db.execute(sql`
    select candidate.*
    from unnest(${skus}::text[]) requested(sku)
    cross join lateral (
      select
        product_id, product_name, sku, product_tracked, has_variants,
        count(*) over ()::integer as match_count
      from (
        select
          p.id as product_id,
          p.name as product_name,
          p.sku,
          p.track_inventory as product_tracked,
          exists (
            select 1 from public.product_variants pv
            where pv.store_id = ${actor.storeId}::uuid and pv.product_id = p.id
          ) as has_variants
        from public.products p
        where p.store_id = ${actor.storeId}::uuid
          and p.sku = requested.sku
        order by p.id
        limit 2
      ) bounded_matches
      order by product_id
      limit 1
    ) candidate
  `);
  return result.rows as unknown as ProductCandidate[];
}

async function readVariantCandidates(
  db: Db,
  actor: MinkActorContext,
  skus: string[],
) {
  const result = await db.execute(sql`
    select candidate.*
    from unnest(${skus}::text[]) requested(sku)
    cross join lateral (
      select
        product_id, product_name, product_tracked, variant_id, variant_name,
        sku, variant_tracked, count(*) over ()::integer as match_count
      from (
        select
          p.id as product_id,
          p.name as product_name,
          p.track_inventory as product_tracked,
          pv.id as variant_id,
          pv.name as variant_name,
          pv.sku,
          pv.track_inventory as variant_tracked
        from public.product_variants pv
        inner join public.products p
          on p.id = pv.product_id and p.store_id = pv.store_id
        where pv.store_id = ${actor.storeId}::uuid
          and pv.sku = requested.sku
        order by p.id, pv.id
        limit 2
      ) bounded_matches
      order by product_id, variant_id
      limit 1
    ) candidate
  `);
  return result.rows as unknown as VariantCandidate[];
}

function failed(
  line: number,
  input: MinkBulkInventoryLookupInput,
  code: MinkBulkInventoryLineError["code"],
  message: string,
): MinkBulkInventoryTargetResult {
  return {
    line,
    input,
    target: null,
    error: {
      line,
      sku: input.sku,
      location: input.locationName,
      code,
      message,
    },
  };
}

function pairKey(sku: string, location: string) {
  return JSON.stringify([sku, location]);
}

function targetKey(
  productId: string,
  variantId: string | null,
  locationId: string,
) {
  return JSON.stringify([productId, variantId, locationId]);
}
