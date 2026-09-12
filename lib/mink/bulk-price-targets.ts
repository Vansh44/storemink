import "server-only";

import { sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import {
  MAX_MINK_BULK_PRICE_LINES,
  normalizeMinkPriceSet,
} from "./bulk-price-policy";
import type { MinkActorContext } from "./types";

export interface MinkBulkPriceLookupInput {
  sku: string;
}

export interface MinkBulkPriceTarget {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  sku: string;
  slug: string;
  publicationStatus: string;
  productVersion: string;
  supportsSpecialPrice: boolean;
  basePrice: string;
  sellingPrice: string;
  specialPrice: string | null;
  effectivePrice: string;
}

export interface MinkBulkPriceLineError {
  line: number;
  sku: string;
  code:
    | "duplicate_line"
    | "sku_not_found"
    | "sku_ambiguous"
    | "variant_required"
    | "price_invalid";
  message: string;
}

export type MinkBulkPriceTargetResult =
  | {
      line: number;
      input: MinkBulkPriceLookupInput;
      target: MinkBulkPriceTarget;
      error: null;
    }
  | {
      line: number;
      input: MinkBulkPriceLookupInput;
      target: null;
      error: MinkBulkPriceLineError;
    };

type ProductCandidate = {
  product_id: string;
  product_name: string;
  sku: string;
  slug: string;
  publication_status: string;
  product_version: string;
  base_price: string | number;
  selling_price: string | number;
  has_variants: boolean;
  match_count: number;
};

type VariantCandidate = {
  product_id: string;
  product_name: string;
  variant_id: string;
  variant_name: string;
  sku: string;
  slug: string;
  publication_status: string;
  product_version: string;
  base_price: string | number;
  selling_price: string | number;
  special_price: string | number | null;
  match_count: number;
};

/** Resolve a bounded set of exact sellable SKUs in two tenant-scoped queries. */
export async function resolveMinkBulkPriceTargets(
  db: Db,
  actor: MinkActorContext,
  inputs: MinkBulkPriceLookupInput[],
): Promise<MinkBulkPriceTargetResult[]> {
  if (inputs.length < 1 || inputs.length > MAX_MINK_BULK_PRICE_LINES) {
    throw new Error(
      `Bulk pricing requires 1-${MAX_MINK_BULK_PRICE_LINES} lines.`,
    );
  }
  const skus = [...new Set(inputs.map((input) => input.sku))];
  const duplicateSkus = new Set<string>();
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.sku)) duplicateSkus.add(input.sku);
    seen.add(input.sku);
  }
  const [productResult, variantResult] = await Promise.all([
    db.execute(sql`
      select p.id as product_id, p.name as product_name, p.sku, p.slug,
             p.status as publication_status, p.updated_at as product_version,
             p.base_price, p.selling_price,
             exists (
               select 1 from public.product_variants pv
               where pv.store_id = ${actor.storeId}::uuid
                 and pv.product_id = p.id
             ) as has_variants,
             count(*) over (partition by p.sku) as match_count
      from public.products p
      where p.store_id = ${actor.storeId}::uuid
        and p.sku = any(${sql.param(skus)}::text[])
    `),
    db.execute(sql`
      select p.id as product_id, p.name as product_name,
             pv.id as variant_id, pv.name as variant_name, pv.sku,
             p.slug, p.status as publication_status,
             p.updated_at as product_version,
             pv.base_price, pv.selling_price, pv.special_price,
             count(*) over (partition by pv.sku) as match_count
      from public.product_variants pv
      join public.products p
        on p.id = pv.product_id and p.store_id = pv.store_id
      where pv.store_id = ${actor.storeId}::uuid
        and pv.sku = any(${sql.param(skus)}::text[])
    `),
  ]);
  const products = productResult.rows as unknown as ProductCandidate[];
  const variants = variantResult.rows as unknown as VariantCandidate[];
  const productBySku = new Map(products.map((row) => [row.sku, row] as const));
  const variantBySku = new Map(variants.map((row) => [row.sku, row] as const));

  return inputs.map((input, index) => {
    const line = index + 1;
    if (duplicateSkus.has(input.sku)) {
      return failed(
        line,
        input,
        "duplicate_line",
        "The same SKU appears more than once. Keep one final price for it.",
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
        "The SKU is ambiguous. Fix duplicate product or variant SKUs before repricing.",
      );
    }
    if (product?.has_variants) {
      return failed(
        line,
        input,
        "variant_required",
        "This product has variants. Use each exact sellable variant SKU instead.",
      );
    }
    try {
      const source = variant ?? product!;
      const prices = normalizeMinkPriceSet(
        source.base_price,
        source.selling_price,
        variant?.special_price ?? null,
        `Current price for ${input.sku}`,
      );
      const target: MinkBulkPriceTarget = {
        productId: source.product_id,
        variantId: variant?.variant_id ?? null,
        productName: source.product_name,
        variantName: variant?.variant_name ?? null,
        sku: source.sku,
        slug: source.slug,
        publicationStatus: source.publication_status,
        productVersion: new Date(source.product_version).toISOString(),
        supportsSpecialPrice: Boolean(variant),
        ...prices,
      };
      return { line, input, target, error: null };
    } catch {
      return failed(
        line,
        input,
        "price_invalid",
        "This SKU has an invalid current price. Correct it in the product editor before bulk repricing.",
      );
    }
  });
}

function failed(
  line: number,
  input: MinkBulkPriceLookupInput,
  code: MinkBulkPriceLineError["code"],
  message: string,
): MinkBulkPriceTargetResult {
  return {
    line,
    input,
    target: null,
    error: { line, sku: input.sku, code, message },
  };
}
