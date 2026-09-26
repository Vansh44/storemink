import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { withUser } from "@/lib/db/client";
import {
  categories,
  productVariants,
  products,
  taxClasses,
} from "@/drizzle/schema";
import { dbErrorMessage, isUniqueViolation } from "@/lib/db/errors";
import { slugify } from "@/lib/slug";
import { firstForeignStoreImageUrl } from "@/lib/storage/ownership";
import {
  composeVariantName,
  normalizeOptions,
  optionValuesForName,
} from "@/lib/products/options";
import type { ProductDraft, VariantDraft } from "../parse";
import type { RowIssue } from "../types";
import {
  getProductCreateCapacity,
  PlanEntitlementError,
} from "@/lib/plans/entitlements";
import {
  failure,
  issue,
  present,
  type ImportContext,
  type RowResult,
} from "./types";

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

/**
 * Categories and tax classes named by the file, resolved to ids once per run.
 *
 * ★ A MISSING CATEGORY IS CREATED; A MISSING TAX CLASS IS NOT. They look alike
 * and are not: a category is a piece of navigation the merchant can rename in
 * ten seconds, whereas a tax class carries a RATE. Inventing "GST 12%" means
 * guessing 12 — and a product silently taxed at the wrong rate is a filing
 * problem discovered by an auditor, not by looking at the shop. So an unknown
 * tax class leaves the field alone and says so.
 */
class ReferenceCache {
  private categoryByKey = new Map<string, string>();
  private taxByName = new Map<string, string>();
  private loaded = false;
  /** Categories this run invented, so the summary can name them. */
  readonly created: string[] = [];

  constructor(private ctx: ImportContext) {}

  private async load() {
    if (this.loaded) return;
    this.loaded = true;

    const [cats, taxes] = await Promise.all([
      withUser(this.ctx.admin, (db) =>
        db
          .select({
            id: categories.id,
            slug: categories.slug,
            name: categories.name,
          })
          .from(categories)
          .where(eq(categories.storeId, this.ctx.storeId)),
      ),
      withUser(this.ctx.admin, (db) =>
        db
          .select({ id: taxClasses.id, name: taxClasses.name })
          .from(taxClasses)
          .where(eq(taxClasses.storeId, this.ctx.storeId)),
      ),
    ]);

    for (const c of cats) {
      // Both spellings, because a merchant's Category column holds whichever
      // they happen to think of it as.
      this.categoryByKey.set(c.slug.toLowerCase(), c.id);
      this.categoryByKey.set(c.name.trim().toLowerCase(), c.id);
    }
    for (const t of taxes)
      this.taxByName.set(t.name.trim().toLowerCase(), t.id);
  }

  async category(
    raw: string,
  ): Promise<{ id: string | null; created?: string; error?: string }> {
    await this.load();
    const name = raw.trim();
    if (!name) return { id: null };

    const bySlug = this.categoryByKey.get(slugify(name));
    const byName = this.categoryByKey.get(name.toLowerCase());
    const found = byName ?? bySlug;
    if (found) return { id: found };

    const slug = slugify(name);
    if (!slug)
      return { id: null, error: `"${name}" can't be used as a category name.` };

    try {
      const [row] = await withUser(this.ctx.admin, (db) =>
        db
          .insert(categories)
          .values({
            storeId: this.ctx.storeId,
            name,
            slug,
            status: "active",
            sortOrder: 0,
          })
          .returning({ id: categories.id }),
      );
      this.categoryByKey.set(slug, row.id);
      this.categoryByKey.set(name.toLowerCase(), row.id);
      this.created.push(name);
      return { id: row.id, created: name };
    } catch (error) {
      // Lost a race with another row in the same file — re-read and use theirs.
      if (isUniqueViolation(error)) {
        const rows = await withUser(this.ctx.admin, (db) =>
          db
            .select({ id: categories.id })
            .from(categories)
            .where(
              and(
                eq(categories.storeId, this.ctx.storeId),
                eq(categories.slug, slug),
              ),
            )
            .limit(1),
        );
        if (rows[0]) {
          this.categoryByKey.set(slug, rows[0].id);
          return { id: rows[0].id };
        }
      }
      return {
        id: null,
        error: dbErrorMessage(error, `Couldn't create the category "${name}".`),
      };
    }
  }

  async taxClass(
    raw: string,
  ): Promise<{ id: string | null; unknown?: boolean }> {
    await this.load();
    const name = raw.trim();
    if (!name) return { id: null };
    const found = this.taxByName.get(name.toLowerCase());
    if (found) return { id: found };
    return { id: null, unknown: true };
  }
}

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

const PRODUCT_FIELDS: Record<string, (v: unknown) => unknown> = {
  name: (v) => String(v).trim(),
  description: (v) => String(v).trim() || null,
  status: (v) => String(v),
  featured: (v) => Boolean(v),
  basePrice: (v) => Number(v),
  sellingPrice: (v) => Number(v),
  imageUrl: (v) => String(v).trim() || null,
  images: (v) => (Array.isArray(v) ? v : []),
  seoTitle: (v) => String(v).trim() || null,
  seoDescription: (v) => String(v).trim() || null,
  cardColor: (v) => String(v).trim() || null,
  sortOrder: (v) => Number(v),
  trackInventory: (v) => Boolean(v),
  lowStockThreshold: (v) => Number(v),
  allowBackorder: (v) => Boolean(v),
  barcode: (v) => String(v).trim() || null,
  hsnCode: (v) => String(v).trim() || null,
  returnable: (v) => Boolean(v),
  returnWindowDays: (v) => Number(v),
};

const VARIANT_FIELDS: Record<string, (v: unknown) => unknown> = {
  variantBasePrice: (v) => Number(v),
  variantSellingPrice: (v) => Number(v),
  variantSpecialPrice: (v) => Number(v),
  variantBarcode: (v) => String(v).trim() || null,
  variantImageUrl: (v) => String(v).trim() || null,
};

/**
 * Base and selling price must agree, and the file may supply either or neither.
 *
 * Mirrors `normalizePrices` in product-actions: selling falls back to base and
 * is clamped so a typo can never price a product ABOVE its own list price —
 * which the storefront renders as a nonsense "discount".
 */
function reconcilePrices(
  base: number | undefined,
  selling: number | undefined,
  current?: { basePrice: number; sellingPrice: number },
): { basePrice?: number; sellingPrice?: number } {
  if (base === undefined && selling === undefined) return {};
  const b = base ?? current?.basePrice ?? 0;
  let s = selling ?? current?.sellingPrice ?? b;
  if (s <= 0) s = b;
  if (b > 0 && s > b) s = b;
  const out: { basePrice?: number; sellingPrice?: number } = {};
  if (base !== undefined) out.basePrice = b;
  if (
    selling !== undefined ||
    (base !== undefined && s !== current?.sellingPrice)
  )
    out.sellingPrice = s;
  return out;
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

interface ExistingVariant {
  id: string;
  name: string;
  basePrice: number;
  sellingPrice: number;
}

/**
 * Reconcile a product's variants against the file.
 *
 * ★ VARIANTS ABSENT FROM THE FILE ARE LEFT ALONE, NEVER DELETED. The product
 * editor deletes them because the editor shows the complete set and the
 * merchant is looking at it; a CSV is routinely partial — a price-update file
 * lists one size — and deleting the rest would destroy stock, order history
 * links and system SKUs that can never be reissued. Removing a variant stays a
 * deliberate act in the editor, which also tells you when orders reference it.
 *
 * Matched by NAME because the variant's own SKU is system-generated and
 * read-only, so the file has no id to match on.
 */
async function applyVariants(
  ctx: ImportContext,
  productId: string,
  drafts: readonly VariantDraft[],
  isNewProduct: boolean,
): Promise<{ issues: ReturnType<typeof issue>[] }> {
  const issues: ReturnType<typeof issue>[] = [];
  if (drafts.length === 0) return { issues };

  const [existing, optionRows] = await Promise.all([
    withUser(ctx.admin, (db) =>
      db
        .select({
          id: productVariants.id,
          name: productVariants.name,
          basePrice: productVariants.basePrice,
          sellingPrice: productVariants.sellingPrice,
        })
        .from(productVariants)
        .where(eq(productVariants.productId, productId)),
    ),
    withUser(ctx.admin, (db) =>
      db
        .select({ options: products.options })
        .from(products)
        .where(eq(products.id, productId))
        .limit(1),
    ),
  ]);
  // A product with option axes (Size, Colour) needs every NEW variant to be
  // one of its combinations, or the product page can no longer offer its
  // pickers and the editor refuses the next save. The file only has a name,
  // so the name must read as one value per option ("M / Black").
  const normalizedOptions = normalizeOptions(optionRows[0]?.options);
  const options =
    "options" in normalizedOptions ? normalizedOptions.options : [];
  const byName = new Map<string, ExistingVariant>(
    existing.map((v) => [v.name.trim().toLowerCase(), v]),
  );

  let sortOrder = existing.length;

  for (const draft of drafts) {
    const key = draft.name.toLowerCase();
    const found = byName.get(key);
    const patch = present<Record<string, unknown>>(
      draft.values,
      VARIANT_FIELDS,
    );

    const prices = reconcilePrices(
      patch.variantBasePrice as number | undefined,
      patch.variantSellingPrice as number | undefined,
      found,
    );

    // A special price only means anything above zero; 0 and blank both mean
    // "no sale price", which the storefront reads as "no badge".
    const rawSpecial = patch.variantSpecialPrice as number | undefined;
    const specialPrice =
      rawSpecial === undefined
        ? undefined
        : rawSpecial > 0
          ? Math.min(
              rawSpecial,
              prices.basePrice ?? found?.basePrice ?? rawSpecial,
            )
          : null;

    // A variant image reaches the same sweep as the parent's, so it gets the
    // same rule. The variant is skipped and named rather than saved without
    // the image the merchant asked for — the `variant_failed` precedent below.
    if (
      firstForeignStoreImageUrl(ctx.storeId, [
        patch.variantImageUrl as string | null | undefined,
      ])
    ) {
      issues.push(
        issue(
          draft.line,
          "Variant Image URL",
          "image_not_owned",
          `Couldn't save the variant "${draft.name}": that image belongs to another store.`,
          "error",
          draft.name,
        ),
      );
      continue;
    }

    const row: Record<string, unknown> = { ...prices };
    if (specialPrice !== undefined) row.specialPrice = specialPrice;
    if (patch.variantBarcode !== undefined) row.barcode = patch.variantBarcode;
    if (patch.variantImageUrl !== undefined) {
      row.imageUrl = patch.variantImageUrl;
      row.images = patch.variantImageUrl ? [patch.variantImageUrl] : [];
    }

    try {
      if (found) {
        if (Object.keys(row).length > 0) {
          await withUser(ctx.admin, (db) =>
            db
              .update(productVariants)
              .set(row)
              .where(
                and(
                  eq(productVariants.id, found.id),
                  eq(productVariants.productId, productId),
                ),
              ),
          );
        }
        continue;
      }

      // Stock reaches a NEW variant through the insert, where the seed trigger
      // (pos_01_inventory_levels.sql) carries it onto the default location's
      // shelf. On an existing one it must go through the stock ledger instead —
      // see the note in applyProduct.
      let name = draft.name;
      let optionValues: string[] = [];
      if (options.length > 0) {
        const values = optionValuesForName(options, draft.name);
        if (!values) {
          issues.push(
            issue(
              draft.line,
              "Variant Name",
              "variant_failed",
              `Couldn't add the variant "${draft.name}": this product has the options ${options
                .map((o) => o.name)
                .join(
                  " and ",
                )}, so name it with one value of each, like "${composeVariantName(
                options.map((o) => o.values[0]),
              )}".`,
              "error",
              draft.name,
            ),
          );
          continue;
        }
        optionValues = values;
        name = composeVariantName(values);
      }
      const stock = draft.values.variantStock;
      await withUser(ctx.admin, (db) =>
        db.insert(productVariants).values({
          storeId: ctx.storeId,
          productId,
          name,
          optionValues,
          basePrice: prices.basePrice ?? 0,
          sellingPrice: prices.sellingPrice ?? prices.basePrice ?? 0,
          specialPrice: specialPrice ?? null,
          barcode: (patch.variantBarcode as string | null) ?? null,
          imageUrl: (patch.variantImageUrl as string | null) ?? null,
          images: patch.variantImageUrl
            ? [patch.variantImageUrl as string]
            : [],
          stock: typeof stock === "number" ? stock : 0,
          sortOrder: sortOrder++,
        } as typeof productVariants.$inferInsert),
      );
    } catch (error) {
      issues.push(
        issue(
          draft.line,
          "Variant Name",
          "variant_failed",
          `Couldn't save the variant "${draft.name}": ${dbErrorMessage(error, "unknown error")}`,
          "error",
          draft.name,
        ),
      );
    }
  }

  if (!isNewProduct) {
    const named = new Set(drafts.map((d) => d.name.toLowerCase()));
    const untouched = existing.filter(
      (v) => !named.has(v.name.trim().toLowerCase()),
    );
    if (untouched.length > 0) {
      issues.push(
        issue(
          drafts[0]?.line ?? 0,
          "Variant Name",
          "variants_kept",
          `${untouched.length} existing variant${untouched.length === 1 ? "" : "s"} (${untouched
            .map((v) => v.name)
            .slice(0, 3)
            .join(
              ", ",
            )}${untouched.length > 3 ? "…" : ""}) weren't in this file and were left as they are. Remove variants from the product editor.`,
          "warning",
        ),
      );
    }
  }

  return { issues };
}

// ---------------------------------------------------------------------------
// The importer
// ---------------------------------------------------------------------------

interface PendingProductCreate {
  draft: ProductDraft;
  handle: string;
  issues: RowIssue[];
  values: typeof products.$inferInsert;
}

export async function importProducts(
  ctx: ImportContext,
  drafts: readonly ProductDraft[],
): Promise<RowResult[]> {
  const results: RowResult[] = [];
  if (drafts.length === 0) return results;

  const refs = new ReferenceCache(ctx);
  const pendingCreates: PendingProductCreate[] = [];

  const slugs = drafts.map((d) => slugify(d.handle)).filter(Boolean);
  let existing = new Map<
    string,
    {
      id: string;
      basePrice: number;
      sellingPrice: number;
      publishedAt: string | null;
    }
  >();
  try {
    const rows = await withUser(ctx.admin, (db) =>
      db
        .select({
          id: products.id,
          slug: products.slug,
          basePrice: products.basePrice,
          sellingPrice: products.sellingPrice,
          publishedAt: products.publishedAt,
        })
        .from(products)
        .where(
          and(eq(products.storeId, ctx.storeId), inArray(products.slug, slugs)),
        ),
    );
    existing = new Map(rows.map((r) => [r.slug, r]));
  } catch (error) {
    const message = dbErrorMessage(error, "Couldn't read existing products.");
    return drafts.map((d) => failure(d.lines, message, "lookup_failed"));
  }

  for (const draft of drafts) {
    const rawHandle = draft.handle.trim();
    const handle = slugify(rawHandle);
    const issues: RowIssue[] = [];

    if (!handle) {
      results.push({
        lines: draft.lines,
        outcome: "failed",
        issues: [
          issue(
            draft.line,
            "Handle",
            "bad_handle",
            `"${rawHandle}" doesn't produce a usable URL handle.`,
            "error",
            rawHandle,
          ),
        ],
      });
      continue;
    }
    if (rawHandle !== handle) {
      issues.push(
        issue(
          draft.line,
          "Handle",
          "handle_slugified",
          `Handle "${rawHandle}" was tidied to "${handle}" so it works in a URL.`,
          "warning",
          rawHandle,
        ),
      );
    }

    const found = existing.get(handle);
    if (found && !ctx.options.update) {
      results.push({ lines: draft.lines, outcome: "skipped", issues });
      continue;
    }
    if (!found && !ctx.options.create) {
      results.push({ lines: draft.lines, outcome: "skipped", issues });
      continue;
    }

    const patch = present<Record<string, unknown>>(
      draft.values,
      PRODUCT_FIELDS,
    );

    // ★★ A CSV IS A SUPPORTED WAY TO WRITE AN ARBITRARY URL. `coerceUrl`
    //    checks only the scheme, so an Image URL column can name another
    //    store's object in the shared bucket — and deleting or re-saving that
    //    product then sweeps THEIR file. Row-atomic, like every other refusal
    //    here: one bad row fails and the rest of the file still imports.
    const foreignImage = firstForeignStoreImageUrl(ctx.storeId, [
      patch.imageUrl as string | null | undefined,
      ...((patch.images as string[] | undefined) ?? []),
    ]);
    if (foreignImage) {
      results.push({
        lines: draft.lines,
        outcome: "failed",
        issues: [
          ...issues,
          issue(
            draft.line,
            "Image URL",
            "image_not_owned",
            "That image belongs to another store. Use an image from this store's Media Library.",
            "error",
            foreignImage,
          ),
        ],
      });
      continue;
    }

    // --- references ------------------------------------------------------
    let categoryId: string | null | undefined;
    if (typeof draft.values.category === "string") {
      const resolved = await refs.category(draft.values.category);
      if (resolved.error) {
        issues.push(
          issue(
            draft.line,
            "Category",
            "category_failed",
            resolved.error,
            "warning",
            draft.values.category,
          ),
        );
      } else {
        categoryId = resolved.id;
        if (resolved.created) {
          issues.push(
            issue(
              draft.line,
              "Category",
              "category_created",
              `Created the category "${resolved.created}" — it didn't exist yet.`,
              "warning",
              resolved.created,
            ),
          );
        }
      }
    }

    let taxClassId: string | null | undefined;
    if (typeof draft.values.taxClass === "string") {
      const resolved = await refs.taxClass(draft.values.taxClass);
      if (resolved.unknown) {
        issues.push(
          issue(
            draft.line,
            "Tax Class",
            "tax_class_unknown",
            `No tax class called "${draft.values.taxClass}" exists, so the tax setting was left as it is. Create it in Settings → Taxes & invoices first — guessing a rate isn't something an import should do.`,
            "warning",
            draft.values.taxClass,
          ),
        );
      } else {
        taxClassId = resolved.id;
      }
    }

    const prices = reconcilePrices(
      patch.basePrice as number | undefined,
      patch.sellingPrice as number | undefined,
      found,
    );

    try {
      let productId: string;
      let outcome: "created" | "updated";

      if (found) {
        const row: Record<string, unknown> = {
          ...patch,
          ...prices,
          updatedBy: ctx.admin.uid,
        };
        // ★ NEVER on an update. `products.stock` is a trigger-maintained
        // aggregate of inventory_levels (pos_01), so a direct write is reverted
        // by the next stock movement and breaks the aggregate invariant in the
        // meantime. Stock changes go through the Inventory import, which uses
        // the adjust RPC and leaves a ledger row.
        delete row.stock;
        if (categoryId !== undefined) row.categoryId = categoryId;
        if (taxClassId !== undefined) row.taxClassId = taxClassId;
        if (patch.status === "published" && !found.publishedAt)
          row.publishedAt = new Date().toISOString();
        if (patch.status === "draft") row.publishedAt = null;

        await withUser(ctx.admin, (db) =>
          db
            .update(products)
            .set(row)
            .where(
              and(eq(products.id, found.id), eq(products.storeId, ctx.storeId)),
            ),
        );
        productId = found.id;
        outcome = "updated";
      } else {
        const name = (patch.name as string | undefined)?.trim();
        if (!name) {
          results.push({
            lines: draft.lines,
            outcome: "failed",
            issues: [
              ...issues,
              issue(
                draft.line,
                "Title",
                "required_on_create",
                "This product is new, so it needs a Title.",
              ),
            ],
          });
          continue;
        }

        const status = (patch.status as string | undefined) ?? "draft";
        const initialStock = draft.values.stock;
        pendingCreates.push({
          draft,
          handle,
          issues,
          values: {
            storeId: ctx.storeId,
            slug: handle,
            name,
            description: (patch.description as string | null) ?? null,
            categoryId: categoryId ?? null,
            taxClassId: taxClassId ?? null,
            basePrice: prices.basePrice ?? 0,
            sellingPrice: prices.sellingPrice ?? prices.basePrice ?? 0,
            imageUrl: (patch.imageUrl as string | null) ?? null,
            images: (patch.images as string[] | undefined) ?? [],
            status,
            featured: (patch.featured as boolean | undefined) ?? false,
            sortOrder: (patch.sortOrder as number | undefined) ?? 0,
            cardColor: (patch.cardColor as string | null) ?? null,
            // SEO falls back to the product's own name rather than being
            // required: the editor demands both because someone is sitting
            // there filling a form, but a 2,000-row migration from another
            // platform has no such columns and failing all of it would be
            // absurd. A title is a better default than an empty <title>.
            seoTitle: (patch.seoTitle as string | null) ?? name,
            seoDescription:
              (patch.seoDescription as string | null) ??
              (patch.description as string | null) ??
              null,
            publishedAt:
              status === "published" ? new Date().toISOString() : null,
            trackInventory:
              (patch.trackInventory as boolean | undefined) ?? false,
            allowBackorder:
              (patch.allowBackorder as boolean | undefined) ?? false,
            lowStockThreshold:
              (patch.lowStockThreshold as number | undefined) ?? null,
            barcode: (patch.barcode as string | null) ?? null,
            hsnCode: (patch.hsnCode as string | null) ?? null,
            returnable: (patch.returnable as boolean | undefined) ?? true,
            returnWindowDays:
              (patch.returnWindowDays as number | undefined) ?? null,
            // Safe on an INSERT only: the seed trigger copies it onto the
            // default location's shelf, so the aggregate holds from birth.
            stock: typeof initialStock === "number" ? initialStock : 0,
            createdBy: ctx.admin.uid,
            updatedBy: ctx.admin.uid,
            // sku / sku_no are owned by the BEFORE-INSERT trigger.
          } as typeof products.$inferInsert,
        });
        continue;
      }

      if (found && draft.values.stock !== undefined) {
        issues.push(
          issue(
            draft.line,
            "Stock",
            "stock_ignored",
            "Stock isn't changed by a product import — it has to go through the stock ledger. Use an Inventory import to set counts.",
            "warning",
          ),
        );
      }

      const variantResult = await applyVariants(
        ctx,
        productId,
        draft.variants,
        !found,
      );
      issues.push(...variantResult.issues);

      // The product itself saved, so the row counts as created/updated even if
      // a variant failed — reporting it as `failed` would tell the merchant to
      // re-import a product that is already correct. The variant's own error
      // is in `issues` and shows up in the log.
      results.push({ lines: draft.lines, outcome, issues });
    } catch (error) {
      const message =
        error instanceof PlanEntitlementError
          ? error.message
          : isUniqueViolation(error)
            ? `A product with the handle "${handle}" already exists.`
            : dbErrorMessage(error, "Couldn't save this product.");
      results.push({
        lines: draft.lines,
        outcome: "failed",
        issues: [
          ...issues,
          issue(
            draft.line,
            null,
            error instanceof PlanEntitlementError
              ? "plan_limit"
              : "write_failed",
            message,
          ),
        ],
      });
    }
  }

  if (pendingCreates.length > 0) {
    try {
      const batch = await withUser(ctx.admin, async (db) => {
        // One lock + one effective-plan read + one COUNT for the whole worker
        // slice. The lock stays held while all allowed base rows are inserted,
        // so concurrent editor/import requests cannot claim the same slots.
        const capacity = await getProductCreateCapacity(
          db,
          ctx.storeId,
          pendingCreates.length,
        );
        const ids: (string | null)[] = Array(pendingCreates.length).fill(null);
        const attempted: boolean[] = Array(pendingCreates.length).fill(false);
        let insertedCount = 0;
        for (let index = 0; index < pendingCreates.length; index++) {
          if (insertedCount >= capacity.allowed) break;
          const pending = pendingCreates[index];
          attempted[index] = true;
          const [inserted] = await db
            .insert(products)
            .values(pending.values)
            // A duplicate handle elsewhere in the same file is a row error,
            // not a reason to abort every valid insert in the batch.
            .onConflictDoNothing()
            .returning({ id: products.id });
          ids[index] = inserted?.id ?? null;
          if (inserted?.id) insertedCount++;
        }
        return { capacity, ids, attempted };
      });

      for (let index = 0; index < pendingCreates.length; index++) {
        const pending = pendingCreates[index];
        if (!batch.attempted[index]) {
          results.push({
            lines: pending.draft.lines,
            outcome: "failed",
            issues: [
              ...pending.issues,
              issue(
                pending.draft.line,
                null,
                "plan_limit",
                batch.capacity.error,
              ),
            ],
          });
          continue;
        }

        const productId = batch.ids[index];
        if (!productId) {
          results.push({
            lines: pending.draft.lines,
            outcome: "failed",
            issues: [
              ...pending.issues,
              issue(
                pending.draft.line,
                "Handle",
                "write_failed",
                `A product with the handle "${pending.handle}" already exists.`,
              ),
            ],
          });
          continue;
        }

        const variantResult = await applyVariants(
          ctx,
          productId,
          pending.draft.variants,
          true,
        );
        results.push({
          lines: pending.draft.lines,
          outcome: "created",
          issues: [...pending.issues, ...variantResult.issues],
        });
      }
    } catch (error) {
      const message =
        error instanceof PlanEntitlementError
          ? error.message
          : dbErrorMessage(error, "Couldn't save these products.");
      for (const pending of pendingCreates) {
        results.push({
          lines: pending.draft.lines,
          outcome: "failed",
          issues: [
            ...pending.issues,
            issue(
              pending.draft.line,
              null,
              error instanceof PlanEntitlementError
                ? "plan_limit"
                : "write_failed",
              message,
            ),
          ],
        });
      }
    }
  }

  return results;
}

/** Slugs touched by a run, so the caller can revalidate the right pages. */
export function touchedSlugs(drafts: readonly ProductDraft[]): string[] {
  return [...new Set(drafts.map((d) => slugify(d.handle)).filter(Boolean))];
}
