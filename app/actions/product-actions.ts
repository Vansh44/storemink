"use server";

import { and, eq, inArray, isNull, like, ne, sql } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { after } from "next/server";
import { readFile } from "fs/promises";
import path from "path";
import { withService, withUser, type UserIdentity } from "@/lib/db/client";
import {
  isUniqueViolation,
  pgErrorCode,
  dbErrorMessage,
} from "@/lib/db/errors";
import {
  orderItems,
  orders,
  productVariants,
  products,
} from "@/drizzle/schema";
import {
  getManagerIdentity,
  getActingStoreId,
} from "@/app/dashboard/lib/access";
import { emitEvent } from "@/lib/notifications/record";
import { deleteStorageUrls } from "@/lib/storage/cleanup";
import {
  FOREIGN_IMAGE_ERROR,
  firstForeignStoreImageUrl,
} from "@/lib/storage/ownership";
import { notifyStoreContentPublished } from "@/lib/seo/store-indexing";
import { TAGS } from "@/lib/storefront/tags";
import { callGemini, brandSystemText } from "@/lib/ai/gemini";
import { getBrandSoulForStore } from "@/lib/ai/brand-voice";
import { consumeAiQuota } from "@/lib/ai/quota";
import { storeHasAnalyticsFeature } from "@/lib/analytics/store-entitlement";
import {
  assertCanCreateProduct,
  PlanEntitlementError,
} from "@/lib/plans/entitlements";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VariantFormData {
  /** DB id — present for existing variants, absent for newly-added rows. */
  id?: string;
  name: string;
  base_price: number;
  selling_price: number;
  cost_price?: number | null;
  // Optional sale price for this variant. When set (> 0) it overrides
  // selling_price for the variant AND triggers a "best value" tag badge on
  // the storefront chip. 0 / null means no special price.
  special_price: number | null;
  stock: number;
  sku: string;
  /** Scannable SUPPLIER barcode for this variant (500ml and 1L carry different
   *  codes on the packaging). Distinct from `sku`, which is our system-generated
   *  Luhn code and immutable. Free text: real barcodes are EAN/UPC/other. */
  barcode?: string | null;
  requires_shipping?: boolean | null;
  weight_grams?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  images: string[]; // this variant's own gallery (empty = uses product gallery)
}

export interface ProductFormData {
  name: string;
  slug: string;
  description: string;
  category_id: string | null;
  base_price: number;
  selling_price: number;
  cost_price?: number | null;
  image_url: string;
  images: string[];
  status: "draft" | "published";
  featured: boolean;
  sort_order: number;
  card_color: string;
  seo_title: string;
  seo_description: string;
  variants: VariantFormData[];
  track_inventory?: boolean;
  allow_backorder?: boolean;
  low_stock_threshold?: number | null;
  sku?: string;
  /** Scannable SUPPLIER barcode for a simple (variant-less) product. Products
   *  WITH variants carry the barcode per variant instead. */
  barcode?: string | null;
  // Optional per-product tax class (public.tax_classes). Products without one
  // fall back to the store default at checkout. Empty string / null = none.
  tax_class_id?: string | null;
  hsn_code?: string | null;
  returnable?: boolean;
  return_window_days?: number | null;
  requires_shipping?: boolean;
  weight_grams?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
}

export interface ActionResult {
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Allowed when the caller's role grants `manage` on the Products section.
async function getAdminIdentity(): Promise<UserIdentity | null> {
  return getManagerIdentity("products");
}

async function resolveSlug(
  admin: UserIdentity,
  base: string,
  storeId: string,
  excludeId?: string,
) {
  const conds = [
    eq(products.storeId, storeId),
    like(products.slug, `${base}%`),
  ];
  if (excludeId) conds.push(ne(products.id, excludeId));

  const rows = await withUser(admin, (db) =>
    db
      .select({ slug: products.slug })
      .from(products)
      .where(and(...conds)),
  );

  const taken = new Set(rows.map((p) => p.slug));
  let counter = 2;
  let slug = base;
  while (taken.has(slug)) {
    slug = `${base}-${counter}`;
    counter++;
  }

  const bump = (collided: string) => {
    taken.add(collided);
    while (taken.has(slug)) {
      slug = `${base}-${counter}`;
      counter++;
    }
    return slug;
  };

  return { slug, bump };
}

const MAX_SLUG_ATTEMPTS = 6;

// Normalize a base/selling pair: non-negative numbers, selling defaults to
// base when unset, and selling is clamped so it never exceeds base.
function normalizePrices(base: number, selling: number) {
  const b = Number.isFinite(base) && base > 0 ? base : 0;
  let s = Number.isFinite(selling) && selling > 0 ? selling : b;
  if (b > 0 && s > b) s = b;
  return { basePrice: b, sellingPrice: s };
}

function positiveOrNull(value: unknown, max = 1_000_000): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(max, n);
}

function costOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(99_999_999, Math.round(n * 100) / 100);
}

// Keep only valid variant rows (a name is required) and normalise numbers.
// Preserves `id` so the reconcile can match existing DB rows.
function sanitizeVariants(variants: VariantFormData[], costsEnabled: boolean) {
  return (variants ?? [])
    .filter((v) => v.name && v.name.trim())
    .map((v, i) => {
      const images = (v.images ?? []).map((u) => u.trim()).filter(Boolean);
      const prices = normalizePrices(v.base_price, v.selling_price);
      // special_price is optional: keep it ONLY when explicitly set (> 0) and
      // clamp against base_price so a typo can't show free. Null otherwise
      // — the storefront uses NULL to mean "no special price, no tag badge".
      let special: number | null = null;
      if (
        v.special_price != null &&
        Number.isFinite(v.special_price) &&
        v.special_price > 0
      ) {
        special =
          prices.basePrice > 0
            ? Math.min(v.special_price, prices.basePrice)
            : v.special_price;
      }
      return {
        id: v.id || undefined, // pass through existing variant id for reconcile
        name: v.name.trim(),
        ...prices,
        ...(costsEnabled ? { costPrice: costOrNull(v.cost_price) } : {}),
        specialPrice: special,
        stock: Number.isFinite(v.stock) ? Math.trunc(v.stock) : 0,
        // SKU is system-generated & locked — set by the DB trigger on insert
        // and immutable thereafter, so the form never writes it. The BARCODE is
        // the opposite: it's the merchant's own supplier code, freely editable.
        barcode:
          typeof v.barcode === "string" ? v.barcode.trim() || null : null,
        requiresShipping:
          typeof v.requires_shipping === "boolean" ? v.requires_shipping : null,
        weightGrams: positiveOrNull(v.weight_grams, 1_000_000),
        lengthCm: positiveOrNull(v.length_cm, 10_000),
        widthCm: positiveOrNull(v.width_cm, 10_000),
        heightCm: positiveOrNull(v.height_cm, 10_000),
        images,
        imageUrl: images[0] ?? null, // keep the legacy single image in sync
        sortOrder: i,
      };
    });
}

// Reconcile strategy: UPDATE existing variants by id, INSERT new ones (no id),
// DELETE removed ones. Stock is NEVER overwritten by the product form — stock
// flows only through inventory RPCs. Variant ids are stable so order_items
// references and the stock_movements ledger are preserved. Runs under the
// admin's identity (RLS applies); returns an error message or null.
async function replaceVariants(
  admin: UserIdentity,
  productId: string,
  variants: VariantFormData[],
  storeId: string,
  costsEnabled: boolean,
): Promise<string | null> {
  const rows = sanitizeVariants(variants, costsEnabled);

  // 1. Fetch existing variant ids for this product.
  let existingIds: Set<string>;
  try {
    const existing = await withUser(admin, (db) =>
      db
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(eq(productVariants.productId, productId)),
    );
    existingIds = new Set(existing.map((v) => v.id));
  } catch (err) {
    return dbErrorMessage(err, "Failed to read existing variants.");
  }

  const formIds = new Set(rows.filter((r) => r.id).map((r) => r.id!));

  // 2. UPDATE existing variants (matched by id). Never overwrite stock —
  //    the `stock` field in the form is informational; real stock changes go
  //    through the inventory RPCs.
  for (const row of rows) {
    if (!row.id || !existingIds.has(row.id)) continue;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _id, stock: _stock, ...updates } = row;
    try {
      await withUser(admin, (db) =>
        db
          .update(productVariants)
          .set(updates)
          .where(
            and(
              eq(productVariants.id, row.id!),
              eq(productVariants.productId, productId),
            ),
          ),
      );
    } catch (err) {
      return dbErrorMessage(err, "Failed to update a variant.");
    }
  }

  // 3. INSERT new variants (no id in form data).
  const newRows = rows.filter((r) => !r.id);
  if (newRows.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const inserts = newRows.map(({ id: _id, ...r }) => ({
      ...r,
      productId,
      storeId,
    }));
    try {
      await withUser(admin, (db) =>
        db
          .insert(productVariants)
          // sku / variant_no are NOT NULL but owned by the BEFORE-INSERT
          // trigger — never sent by the app, so the type is asserted.
          .values(inserts as (typeof productVariants.$inferInsert)[]),
      );
    } catch (err) {
      return dbErrorMessage(err, "Failed to add a variant.");
    }
  }

  // 4. DELETE variants removed from the editor. The ON DELETE RESTRICT
  //    constraint on order_items.variant_id will block deletion of a variant
  //    that has existing orders — surface a friendly message.
  const toDelete = [...existingIds].filter((id) => !formIds.has(id));
  if (toDelete.length > 0) {
    try {
      await withUser(admin, (db) =>
        db.delete(productVariants).where(inArray(productVariants.id, toDelete)),
      );
    } catch (err) {
      // RESTRICT FK violation — variant has order references.
      if (
        pgErrorCode(err) === "23503" ||
        dbErrorMessage(err, "").toLowerCase().includes("violates foreign key")
      ) {
        return "Cannot delete one or more variants because they have existing orders. Disable them instead.";
      }
      return dbErrorMessage(err, "Failed to delete a variant.");
    }
  }

  return null;
}

/**
 * Fill only missing historical order-line costs after a merchant supplies a
 * product cost. Existing snapshots are immutable, so later edits affect only
 * future sales. Variant cost overrides the parent; null inherits it.
 */
async function backfillMissingOrderCosts(
  storeId: string,
  productId: string,
  productCost: number | null,
  variants: VariantFormData[],
) {
  // This write uses the service role because order_items are immutable to the
  // dashboard user. Re-prove tenancy through the parent order on every UPDATE;
  // a product UUID alone is not an authorization boundary.
  const belongsToStore = sql`exists (
    select 1 from ${orders}
     where ${orders.id} = ${orderItems.orderId}
       and ${orders.storeId} = ${storeId}
  )`;
  if (productCost !== null) {
    await withService((db) =>
      db
        .update(orderItems)
        .set({ unitCost: productCost })
        .where(
          and(
            eq(orderItems.productId, productId),
            belongsToStore,
            isNull(orderItems.variantId),
            isNull(orderItems.unitCost),
          ),
        ),
    );
  }

  for (const variant of variants) {
    if (!variant.id) continue;
    const effectiveCost = costOrNull(variant.cost_price) ?? productCost;
    if (effectiveCost === null) continue;
    await withService((db) =>
      db
        .update(orderItems)
        .set({ unitCost: effectiveCost })
        .where(
          and(
            eq(orderItems.productId, productId),
            belongsToStore,
            eq(orderItems.variantId, variant.id!),
            isNull(orderItems.unitCost),
          ),
        ),
    );
  }
}

function revalidateProduct(slug?: string) {
  revalidatePath("/dashboard/products");
  revalidatePath("/shop");
  if (slug) revalidatePath(`/shop/${slug}`);
  // Bust the shared cached product reads used by home + shop + detail.
  revalidateTag(TAGS.products, "max");
}

// Nudge search engines to (re)crawl a product page after it goes live. No-op
// for drafts — a draft URL isn't publicly indexable. Best-effort and off the
// response path; the helper derives the canonical origin from the store id.
async function notifyProductsPublished(
  slugs: (string | null | undefined)[],
  published: boolean,
) {
  const live = [...new Set(slugs.filter((slug): slug is string => !!slug))];
  if (!published || live.length === 0) return;
  // Swallow everything: this runs after the product is already saved, and a
  // search-engine ping must never turn a successful save into an error the
  // merchant sees and retries.
  try {
    const storeId = await getActingStoreId();
    after(() =>
      notifyStoreContentPublished({
        storeId,
        paths: [...live.map((slug) => `/shop/${slug}`), "/shop", "/"],
      }),
    );
  } catch (err) {
    console.error("notifyProductsPublished failed:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Storage cleanup — keep media storage in sync when images are removed.
// Uploads add files to storage; removing an image only drops its URL from the
// DB, so the file would otherwise be orphaned. On save we delete the files
// that are no longer referenced; on delete we remove them all.
// (deleteStorageUrls lives in lib/storage/cleanup, shared by actions.)
// ---------------------------------------------------------------------------

// All image URLs currently referenced by a product (primary + gallery + every
// variant's primary + gallery). Resilient: returns [] on any error.
/**
 * Every image URL one product save would store: the product's own, its
 * gallery, and each variant's.
 *
 * ★ THE VARIANTS ARE NOT OPTIONAL. `fetchProductImageUrls` already sweeps
 *   `product_variants.image_url`, so a foreign URL hidden on a variant reaches
 *   the delete exactly like one on the parent. A variant has no `image_url`
 *   field of its own — the column is written as `images[0]` — so its gallery
 *   is the whole of its contribution.
 */
function productFormImageUrls(formData: ProductFormData): string[] {
  const urls = [formData.image_url, ...(formData.images ?? [])];
  for (const variant of formData.variants ?? []) {
    urls.push(...(variant.images ?? []));
  }
  return urls.filter(Boolean);
}

async function fetchProductImageUrls(
  admin: UserIdentity,
  productId: string,
): Promise<string[]> {
  const urls: string[] = [];
  try {
    const [p] = await withUser(admin, (db) =>
      db
        .select({ image_url: products.imageUrl, images: products.images })
        .from(products)
        .where(eq(products.id, productId))
        .limit(1),
    );
    if (p?.image_url) urls.push(p.image_url);
    if (Array.isArray(p?.images)) urls.push(...p.images);

    const vs = await withUser(admin, (db) =>
      db
        .select({
          image_url: productVariants.imageUrl,
          images: productVariants.images,
        })
        .from(productVariants)
        .where(eq(productVariants.productId, productId)),
    );
    for (const v of vs) {
      if (v.image_url) urls.push(v.image_url);
      if (Array.isArray(v.images)) urls.push(...v.images);
    }
  } catch (err) {
    console.error("fetchProductImageUrls error:", err);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Per-product return window override.
 *
 * NULL means "use the store's `returns.windowDays`" — deliberately not a copy
 * of the store value, so a merchant changing their store-wide window later
 * still reaches products saved before the change. 0 is MEANINGFUL (same-day
 * only), so it must survive rather than being coerced to null.
 */
function normalizeReturnWindow(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(365, Math.max(0, Math.trunc(n)));
}

export async function createProduct(
  formData: ProductFormData,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const userId = admin.uid;
  const storeId = await getActingStoreId();
  const costsEnabled = await storeHasAnalyticsFeature(storeId, "grossMargin");

  if (!formData.name.trim()) return { error: "Name is required." };
  if (!formData.category_id) return { error: "Category is required." };
  if (!formData.description.trim())
    return { error: "Description is required." };
  if (!formData.seo_title.trim() || !formData.seo_description.trim())
    return { error: "SEO title and description are required." };

  const foreignImage = firstForeignStoreImageUrl(
    storeId,
    productFormImageUrls(formData),
  );
  if (foreignImage) return { error: FOREIGN_IMAGE_ERROR };

  const base = formData.slug ? slugify(formData.slug) : slugify(formData.name);
  const { slug: firstSlug, bump } = await resolveSlug(admin, base, storeId);
  let slug = firstSlug;

  const row = (s: string) => ({
    name: formData.name.trim(),
    slug: s,
    description: formData.description.trim() || null,
    categoryId: formData.category_id || null,
    ...normalizePrices(formData.base_price, formData.selling_price),
    ...(costsEnabled ? { costPrice: costOrNull(formData.cost_price) } : {}),
    imageUrl: formData.image_url || null,
    images: formData.images ?? [],
    status: formData.status,
    featured: formData.featured,
    sortOrder: formData.sort_order ?? 0,
    cardColor: formData.card_color?.trim() || null,
    seoTitle: formData.seo_title.trim() || null,
    seoDescription: formData.seo_description.trim() || null,
    publishedAt:
      formData.status === "published" ? new Date().toISOString() : null,
    createdBy: userId,
    updatedBy: userId,
    storeId,
    trackInventory: formData.track_inventory ?? false,
    allowBackorder: formData.allow_backorder ?? false,
    lowStockThreshold: formData.low_stock_threshold ?? null,
    taxClassId: formData.tax_class_id || null,
    hsnCode:
      typeof formData.hsn_code === "string"
        ? formData.hsn_code.trim().slice(0, 20) || null
        : null,
    returnable: formData.returnable !== false,
    returnWindowDays: normalizeReturnWindow(formData.return_window_days),
    requiresShipping: formData.requires_shipping !== false,
    weightGrams: positiveOrNull(formData.weight_grams, 1_000_000),
    lengthCm: positiveOrNull(formData.length_cm, 10_000),
    widthCm: positiveOrNull(formData.width_cm, 10_000),
    heightCm: positiveOrNull(formData.height_cm, 10_000),
    // The merchant's own scannable supplier code (NOT the system sku below).
    barcode:
      typeof formData.barcode === "string"
        ? formData.barcode.trim() || null
        : null,
    // sku / sku_no are set by the DB trigger (system-generated & locked).
  });

  // Own transaction per attempt (a unique violation aborts the transaction it
  // happens in). RLS (is_store_admin) gates the insert.
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    let inserted: Record<string, unknown>;
    try {
      const [row0] = await withUser(admin, async (db) => {
        await assertCanCreateProduct(db, storeId);
        return (
          db
            .insert(products)
            // sku / sku_no are NOT NULL but owned by the BEFORE-INSERT trigger
            // (identifiers_04_triggers.sql) — the app must never send them, so
            // the insert type is asserted past those two columns.
            .values(row(slug) as typeof products.$inferInsert)
            .returning()
        );
      });
      inserted = row0 as Record<string, unknown>;
    } catch (err) {
      if (err instanceof PlanEntitlementError) {
        return { error: err.message };
      }
      if (!isUniqueViolation(err)) {
        console.error("createProduct error:", err);
        return { error: dbErrorMessage(err, "Failed to create product.") };
      }
      slug = bump(slug);
      continue;
    }

    const variantError = await replaceVariants(
      admin,
      inserted.id as string,
      formData.variants,
      storeId,
      costsEnabled,
    );
    if (variantError) {
      console.error("createProduct variants error:", variantError);
      return { error: `Product saved but variants failed: ${variantError}` };
    }
    revalidateProduct(slug);
    await notifyProductsPublished([slug], formData.status === "published");
    emitEvent({
      type: "product.created",
      storeId,
      actor: { type: "admin", id: admin.uid, label: admin.email },
      subject: {
        type: "product",
        id: inserted.id as string,
        label: formData.name,
      },
      payload: { status: formData.status },
    });
    return { success: true, data: inserted };
  }

  return { error: "Could not generate a unique slug. Please try again." };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateProduct(
  id: string,
  formData: ProductFormData,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const userId = admin.uid;
  const storeId = await getActingStoreId();
  const costsEnabled = await storeHasAnalyticsFeature(storeId, "grossMargin");

  if (!formData.name.trim()) return { error: "Name is required." };
  if (!formData.category_id) return { error: "Category is required." };
  if (!formData.description.trim())
    return { error: "Description is required." };
  if (!formData.seo_title.trim() || !formData.seo_description.trim())
    return { error: "SEO title and description are required." };

  const base = formData.slug ? slugify(formData.slug) : slugify(formData.name);
  const { slug: firstSlug, bump } = await resolveSlug(admin, base, storeId, id);
  let slug = firstSlug;

  const currentRows = await withUser(admin, (db) =>
    db
      .select({ published_at: products.publishedAt })
      .from(products)
      .where(and(eq(products.id, id), eq(products.storeId, storeId)))
      .limit(1),
  );
  const current = currentRows[0];
  if (!current) return { error: "Product not found." };

  const publishedAt =
    formData.status === "published"
      ? (current?.published_at ?? new Date().toISOString())
      : null;

  const row = (s: string) => ({
    name: formData.name.trim(),
    slug: s,
    description: formData.description.trim() || null,
    categoryId: formData.category_id || null,
    ...normalizePrices(formData.base_price, formData.selling_price),
    ...(costsEnabled ? { costPrice: costOrNull(formData.cost_price) } : {}),
    imageUrl: formData.image_url || null,
    images: formData.images ?? [],
    status: formData.status,
    featured: formData.featured,
    sortOrder: formData.sort_order ?? 0,
    cardColor: formData.card_color?.trim() || null,
    seoTitle: formData.seo_title.trim() || null,
    seoDescription: formData.seo_description.trim() || null,
    publishedAt,
    updatedBy: userId,
    trackInventory: formData.track_inventory ?? false,
    allowBackorder: formData.allow_backorder ?? false,
    lowStockThreshold: formData.low_stock_threshold ?? null,
    taxClassId: formData.tax_class_id || null,
    hsnCode:
      typeof formData.hsn_code === "string"
        ? formData.hsn_code.trim().slice(0, 20) || null
        : null,
    returnable: formData.returnable !== false,
    returnWindowDays: normalizeReturnWindow(formData.return_window_days),
    requiresShipping: formData.requires_shipping !== false,
    weightGrams: positiveOrNull(formData.weight_grams, 1_000_000),
    lengthCm: positiveOrNull(formData.length_cm, 10_000),
    widthCm: positiveOrNull(formData.width_cm, 10_000),
    heightCm: positiveOrNull(formData.height_cm, 10_000),
    barcode:
      typeof formData.barcode === "string"
        ? formData.barcode.trim() || null
        : null,
    // sku is system-generated & locked (DB trigger) — never overwritten here.
  });

  // Images referenced before this save — compared against what survives so any
  // removed file can be purged from storage.
  const oldImageUrls = await fetchProductImageUrls(admin, id);

  // Only what this save ADDS: an image already on the row may predate
  // store-prefixed uploads and cannot be proven ours.
  const foreignImage = firstForeignStoreImageUrl(
    storeId,
    productFormImageUrls(formData),
    new Set(oldImageUrls),
  );
  if (foreignImage) return { error: FOREIGN_IMAGE_ERROR };

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    try {
      // Own transaction per attempt; RLS confines the update to the caller's
      // own store.
      const updated = await withUser(admin, (db) =>
        db
          .update(products)
          .set(row(slug))
          .where(and(eq(products.id, id), eq(products.storeId, storeId)))
          .returning({ id: products.id }),
      );
      if (updated.length === 0) return { error: "Product not found." };
    } catch (err) {
      if (!isUniqueViolation(err)) {
        console.error("updateProduct error:", err);
        return { error: dbErrorMessage(err, "Failed to update product.") };
      }
      slug = bump(slug);
      continue;
    }

    const variantError = await replaceVariants(
      admin,
      id,
      formData.variants,
      storeId,
      costsEnabled,
    );
    if (variantError) {
      console.error("updateProduct variants error:", variantError);
      return {
        error: `Product saved but variants failed: ${variantError}`,
      };
    }
    if (costsEnabled) {
      await backfillMissingOrderCosts(
        storeId,
        id,
        costOrNull(formData.cost_price),
        formData.variants,
      );
    }
    // Purge files that are no longer referenced after the save.
    const kept = new Set(await fetchProductImageUrls(admin, id));
    await deleteStorageUrls(
      oldImageUrls.filter((u) => !kept.has(u)),
      {
        ownedByStoreId: storeId,
      },
    );

    revalidateProduct(slug);
    await notifyProductsPublished([slug], formData.status === "published");
    emitEvent({
      type: "product.updated",
      storeId,
      actor: { type: "admin", id: admin.uid, label: admin.email },
      subject: { type: "product", id, label: formData.name },
      payload: { status: formData.status },
    });
    return { success: true };
  }

  return { error: "Could not generate a unique slug. Please try again." };
}

// ---------------------------------------------------------------------------
// Delete (variants cascade via FK)
// ---------------------------------------------------------------------------

export async function deleteProduct(id: string): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };

  // Collect the product's images before deleting (variants cascade in the DB).
  const imageUrls = await fetchProductImageUrls(admin, id);

  let deletedName: string | null = null;
  try {
    const removed = await withUser(admin, (db) =>
      db
        .delete(products)
        .where(eq(products.id, id))
        // Returned for the activity log: after the row is gone there is no
        // way to say WHICH product was deleted.
        .returning({ name: products.name }),
    );
    deletedName = removed[0]?.name ?? null;
  } catch (err) {
    console.error("deleteProduct error:", err);
    return { error: dbErrorMessage(err, "Failed to delete product.") };
  }

  // Files won't cascade — remove them from storage too.
  await deleteStorageUrls(imageUrls, {
    ownedByStoreId: await getActingStoreId(),
  });

  emitEvent({
    type: "product.deleted",
    storeId: await getActingStoreId(),
    actor: { type: "admin", id: admin.uid, label: admin.email },
    subject: { type: "product", id, label: deletedName },
  });

  revalidateProduct();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Toggle publish
// ---------------------------------------------------------------------------

export async function toggleProductPublish(
  id: string,
  publish: boolean,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const userId = admin.uid;

  let updated: { slug: string } | undefined;
  try {
    [updated] = await withUser(admin, (db) =>
      db
        .update(products)
        .set({
          status: publish ? "published" : "draft",
          publishedAt: publish ? new Date().toISOString() : null,
          updatedBy: userId,
        })
        .where(eq(products.id, id))
        .returning({ slug: products.slug }),
    );
  } catch (err) {
    console.error("toggleProductPublish error:", err);
    return { error: dbErrorMessage(err, "Failed to update product.") };
  }
  if (!updated) return { error: "Product not found." };

  revalidateProduct(updated.slug);
  await notifyProductsPublished([updated.slug], publish);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Bulk operations (dashboard multi-select)
// ---------------------------------------------------------------------------

/** Publish or unpublish many products at once. */
export async function bulkToggleProductPublish(
  ids: string[],
  publish: boolean,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const userId = admin.uid;
  if (ids.length === 0) return { error: "Nothing selected." };

  let touched: { slug: string }[] = [];
  try {
    touched = await withUser(admin, (db) =>
      db
        .update(products)
        .set({
          status: publish ? "published" : "draft",
          publishedAt: publish ? new Date().toISOString() : null,
          updatedBy: userId,
        })
        .where(inArray(products.id, ids))
        .returning({ slug: products.slug }),
    );
  } catch (err) {
    console.error("bulkToggleProductPublish error:", err);
    return { error: dbErrorMessage(err, "Failed to update products.") };
  }
  revalidateProduct();
  if (publish) {
    await notifyProductsPublished(
      touched.map((product) => product.slug),
      true,
    );
  }
  return { success: true };
}

/** Feature or unfeature many products at once. */
export async function bulkSetProductFeatured(
  ids: string[],
  featured: boolean,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const userId = admin.uid;
  if (ids.length === 0) return { error: "Nothing selected." };

  try {
    await withUser(admin, (db) =>
      db
        .update(products)
        .set({ featured, updatedBy: userId })
        .where(inArray(products.id, ids)),
    );
  } catch (err) {
    console.error("bulkSetProductFeatured error:", err);
    return { error: dbErrorMessage(err, "Failed to update products.") };
  }
  revalidateProduct();
  return { success: true };
}

/** Permanently delete many products, cleaning up their storage assets. */
export async function bulkDeleteProducts(ids: string[]): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  if (ids.length === 0) return { error: "Nothing selected." };

  // Gather images for every product first (variants cascade in the DB; files
  // do not).
  const urls: string[] = [];
  for (const id of ids) {
    urls.push(...(await fetchProductImageUrls(admin, id)));
  }

  try {
    await withUser(admin, (db) =>
      db.delete(products).where(inArray(products.id, ids)),
    );
  } catch (err) {
    console.error("bulkDeleteProducts error:", err);
    return { error: dbErrorMessage(err, "Failed to delete products.") };
  }
  await deleteStorageUrls(urls, { ownedByStoreId: await getActingStoreId() });
  revalidateProduct();
  return { success: true };
}

// ---------------------------------------------------------------------------
// AI description generation (Gemini)
//
// Pipeline:  the store's brand soul  +  brand/tasks/product-desc.md (task
//            rules)  +  the form fields the admin entered  →  Gemini  →  one
//            paragraph.
//
// The brand soul (getBrandSoulForStore — per-store store_brand_profiles, with a
// generic fallback) is the system instruction: WHO is speaking. product-desc.md
// is the single source of truth for the task rules (WHAT to write). The API key
// is server-only and never reaches the browser.
// ---------------------------------------------------------------------------

export interface DescriptionInput {
  name: string;
  categoryName?: string | null;
  base_price?: number;
  selling_price?: number;
  variants?: string[];
  // Whatever the admin has already typed in the description box — used as
  // rough notes for the AI to polish, not as a hard constraint.
  notes?: string;
}

export interface DescriptionResult {
  description?: string;
  error?: string;
}

// Used if product-desc.md can't be read, so the button never hard-fails.
const FALLBACK_TASK = `Write ONE product description of roughly 40–60 words in the brand's voice, using only the product details provided. Output only the description text — no preamble, no options, no notes, no quotation marks, no markdown. Lead with the belief or the real ingredients, never a number. If a detail isn't provided, leave it out — never invent a fact.`;

// The task layer lives in brand/tasks/ (deployed app content). The /product-desc
// slash command points to the SAME file, so both surfaces stay in sync.
async function loadTaskRules(): Promise<string> {
  try {
    const raw = await readFile(
      path.join(process.cwd(), "brand", "tasks", "product-desc.md"),
      "utf8",
    );
    const clean = raw.trim();
    return clean || FALLBACK_TASK;
  } catch {
    return FALLBACK_TASK;
  }
}

// Turn the form fields into a flat, fact-only list for the prompt. Only fields
// that are actually present are included — the brand rules forbid inventing
// anything, so we never send blanks the model might try to fill.
function buildProductFacts(input: {
  name: string;
  categoryName?: string | null;
  base_price?: number;
  selling_price?: number;
  variants?: string[];
  description?: string;
  notes?: string;
}): string[] {
  const facts: string[] = [`Product name: ${input.name.trim()}`];
  if (input.categoryName) facts.push(`Category: ${input.categoryName}`);
  if (input.base_price && input.base_price > 0)
    facts.push(`Base price (MRP): ₹${input.base_price}`);
  if (input.selling_price && input.selling_price > 0)
    facts.push(`Selling price: ₹${input.selling_price}`);
  if (input.variants && input.variants.length > 0)
    facts.push(`Variants: ${input.variants.join(", ")}`);
  if (input.description && input.description.trim())
    facts.push(`Product description: ${input.description.trim()}`);
  if (input.notes && input.notes.trim())
    facts.push(`Notes typed in the description field: ${input.notes.trim()}`);
  return facts;
}

export async function generateProductDescription(
  input: DescriptionInput,
): Promise<DescriptionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };

  if (!input.name?.trim()) {
    return { error: "Add a product name first." };
  }

  // Meter the generation against the store's plan cap BEFORE calling Gemini.
  const storeId = await getActingStoreId();
  const quota = await consumeAiQuota(storeId);
  if (!quota.allowed) return { error: quota.error };

  // The store's brand soul (per-store, generic fallback when unset) +
  // product-desc.md (task rules) + form fields → Gemini.
  const brand = await getBrandSoulForStore(storeId);

  const taskRules = await loadTaskRules();
  const facts = buildProductFacts(input);

  const userText = `${taskRules}

---
PRODUCT DETAILS — the only source of facts. Never invent anything beyond these:

${facts.join("\n")}`;

  const { text, error } = await callGemini(brandSystemText(brand), userText, {
    temperature: 0.7,
    maxOutputTokens: 1024,
  });
  if (error) return { error };

  return { description: text };
}

// ---------------------------------------------------------------------------
// AI SEO generation (Gemini)
//
// Same pipeline as the description, but the task layer is seo-meta.md and the
// model returns validated JSON ({ seo_title, seo_description }) so we reliably
// get both fields at once. The product description, when present, is passed in
// as the richest source material.
// ---------------------------------------------------------------------------

export interface SeoInput {
  name: string;
  categoryName?: string | null;
  base_price?: number;
  selling_price?: number;
  variants?: string[];
  // The current product description — best raw material for SEO copy.
  description?: string;
}

export interface SeoResult {
  seo_title?: string;
  seo_description?: string;
  error?: string;
}

const FALLBACK_SEO_TASK = `Return ONLY a JSON object with two string keys, "seo_title" and "seo_description". seo_title: ~50–60 characters (never over 60), lead with the product name, plain and searchable, no hype or caps. seo_description: ~140–160 characters (never over 160), one or two calm sentences in the brand's voice saying what it is and why it's real, no hard sell, no urgency, no medical claims. Use only the product details provided — never invent a fact or number. Output the raw JSON only: no markdown, no code fences, no extra text.`;

async function loadSeoTaskRules(): Promise<string> {
  try {
    const raw = await readFile(
      path.join(process.cwd(), "brand", "tasks", "seo-meta.md"),
      "utf8",
    );
    return raw.trim() || FALLBACK_SEO_TASK;
  } catch {
    return FALLBACK_SEO_TASK;
  }
}

// JSON shape we force Gemini to return (uppercase Type enum, per the REST API).
const SEO_SCHEMA = {
  type: "OBJECT",
  properties: {
    seo_title: { type: "STRING" },
    seo_description: { type: "STRING" },
  },
  required: ["seo_title", "seo_description"],
  propertyOrdering: ["seo_title", "seo_description"],
};

export async function generateProductSeo(input: SeoInput): Promise<SeoResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };

  if (!input.name?.trim()) {
    return { error: "Add a product name first." };
  }
  if (!input.description?.trim()) {
    return { error: "Fill in the product description before generating SEO." };
  }

  const storeId = await getActingStoreId();
  const quota = await consumeAiQuota(storeId);
  if (!quota.allowed) return { error: quota.error };

  const brand = await getBrandSoulForStore(storeId);

  const taskRules = await loadSeoTaskRules();
  const facts = buildProductFacts(input);

  const userText = `${taskRules}

---
PRODUCT DETAILS — the only source of facts. Never invent anything beyond these:

${facts.join("\n")}`;

  const { text, error } = await callGemini(brandSystemText(brand), userText, {
    temperature: 0.5,
    maxOutputTokens: 512,
    responseMimeType: "application/json",
    responseSchema: SEO_SCHEMA,
  });
  if (error) return { error };

  let parsed: { seo_title?: string; seo_description?: string } | null = null;
  try {
    parsed = JSON.parse(text!);
  } catch {
    console.error("SEO JSON parse failed:", text);
    return { error: "The AI returned an unexpected format. Try again." };
  }

  const seo_title = parsed?.seo_title?.trim();
  const seo_description = parsed?.seo_description?.trim();
  if (!seo_title || !seo_description) {
    return { error: "The AI response was incomplete. Try again." };
  }

  return { seo_title, seo_description };
}
