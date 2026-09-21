import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { withUser } from "@/lib/db/client";
import { categories } from "@/drizzle/schema";
import { dbErrorMessage, isUniqueViolation } from "@/lib/db/errors";
import { slugify } from "@/lib/slug";
import { firstForeignStoreImageUrl } from "@/lib/storage/ownership";
import type { ParsedRecord } from "../types";
import {
  failure,
  issue,
  present,
  type ImportContext,
  type RowResult,
} from "./types";

interface CategoryPatch extends Record<string, unknown> {
  name: string;
  description: string | null;
  imageUrl: string | null;
  sortOrder: number;
  status: string;
}

const FIELD_MAP: Record<string, (v: unknown) => unknown> = {
  name: (v) => String(v).trim(),
  description: (v) => String(v).trim() || null,
  imageUrl: (v) => String(v).trim() || null,
  sortOrder: (v) => Number(v),
  status: (v) => String(v),
};

/**
 * Import categories, matched on handle (slug).
 *
 * The handle is slugified rather than taken literally: `Fresh Dairy` in the
 * Handle column is what a merchant types when they haven't understood the
 * column, and creating a category whose URL is `Fresh Dairy` would produce a
 * broken storefront link with no error anywhere.
 */
export async function importCategories(
  ctx: ImportContext,
  records: readonly ParsedRecord[],
): Promise<RowResult[]> {
  const results: RowResult[] = [];
  if (records.length === 0) return results;

  // One lookup for the whole chunk rather than one per row. The slugs come
  // from the file, so the IN list is bounded by the chunk size.
  const wanted = new Map<string, ParsedRecord>();
  for (const record of records) {
    const handle = slugify(String(record.values.handle ?? ""));
    if (handle) wanted.set(handle, record);
  }

  let existing = new Map<string, { id: string; name: string }>();
  try {
    const rows = await withUser(ctx.admin, (db) =>
      db
        .select({
          id: categories.id,
          slug: categories.slug,
          name: categories.name,
        })
        .from(categories)
        .where(
          and(
            eq(categories.storeId, ctx.storeId),
            inArray(categories.slug, [...wanted.keys()]),
          ),
        ),
    );
    existing = new Map(rows.map((r) => [r.slug, { id: r.id, name: r.name }]));
  } catch (error) {
    // Losing the lookup means we cannot tell create from update, and guessing
    // would duplicate the merchant's categories. Fail the chunk, not the file.
    const message = dbErrorMessage(error, "Couldn't read existing categories.");
    return records.map((r) => failure([r.line], message, "lookup_failed"));
  }

  for (const record of records) {
    const rawHandle = String(record.values.handle ?? "").trim();
    const handle = slugify(rawHandle);

    if (!handle) {
      results.push({
        lines: [record.line],
        outcome: "failed",
        issues: [
          issue(
            record.line,
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

    const patch = present<CategoryPatch>(record.values, FIELD_MAP);
    const found = existing.get(handle);
    const issues = [...record.issues.filter((i) => i.severity === "warning")];

    if (rawHandle !== handle) {
      issues.push(
        issue(
          record.line,
          "Handle",
          "handle_slugified",
          `Handle "${rawHandle}" was tidied to "${handle}" so it works in a URL.`,
          "warning",
          rawHandle,
        ),
      );
    }

    // ★★ A CSV IS A SUPPORTED WAY TO WRITE AN ARBITRARY URL. `coerceUrl`
    //    checks only the scheme, so an Image URL column can name another
    //    store's object in the shared bucket — and deleting or re-importing
    //    that category then sweeps THEIR file. Row-atomic, like every other
    //    refusal here: one bad row fails, the rest of the file imports.
    if (firstForeignStoreImageUrl(ctx.storeId, [patch.imageUrl])) {
      results.push({
        lines: [record.line],
        outcome: "failed",
        issues: [
          ...issues,
          issue(
            record.line,
            "Image URL",
            "image_not_owned",
            "That image belongs to another store. Use an image from this store's Media Library.",
            "error",
            patch.imageUrl ?? undefined,
          ),
        ],
      });
      continue;
    }

    try {
      if (found) {
        if (!ctx.options.update) {
          results.push({ lines: [record.line], outcome: "skipped", issues });
          continue;
        }
        await withUser(ctx.admin, (db) =>
          db
            .update(categories)
            .set(patch)
            .where(
              and(
                eq(categories.id, found.id),
                eq(categories.storeId, ctx.storeId),
              ),
            ),
        );
        results.push({ lines: [record.line], outcome: "updated", issues });
        continue;
      }

      if (!ctx.options.create) {
        results.push({ lines: [record.line], outcome: "skipped", issues });
        continue;
      }

      // A name is only required to CREATE — an update keyed on handle needn't
      // repeat it, which is what makes a "just fix the sort order" file work.
      const name = patch.name ?? rawHandle;
      if (!name.trim()) {
        results.push({
          lines: [record.line],
          outcome: "failed",
          issues: [
            ...issues,
            issue(
              record.line,
              "Name",
              "required_on_create",
              "This category is new, so it needs a Name.",
            ),
          ],
        });
        continue;
      }

      await withUser(ctx.admin, (db) =>
        db.insert(categories).values({
          storeId: ctx.storeId,
          slug: handle,
          name: name.trim(),
          description: patch.description ?? null,
          imageUrl: patch.imageUrl ?? null,
          sortOrder: patch.sortOrder ?? 0,
          status: patch.status ?? "active",
        }),
      );
      results.push({ lines: [record.line], outcome: "created", issues });
    } catch (error) {
      // A unique violation here means the row appeared between our lookup and
      // our insert — another import, another tab, or a duplicate line. Saying
      // so beats "duplicate key value violates constraint categories_store_slug_key".
      const message = isUniqueViolation(error)
        ? `A category with the handle "${handle}" already exists. It may have been created by another row in this file.`
        : dbErrorMessage(error, "Couldn't save this category.");
      results.push({
        lines: [record.line],
        outcome: "failed",
        issues: [...issues, issue(record.line, null, "write_failed", message)],
      });
    }
  }

  return results;
}
