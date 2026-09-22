"use server";

import { and, eq, like, ne } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { TAGS } from "@/lib/storefront/tags";
import {
  getManagerIdentity,
  getActingStoreId,
} from "@/app/dashboard/lib/access";
import { deleteStorageUrls } from "@/lib/storage/cleanup";
import {
  FOREIGN_IMAGE_ERROR,
  firstForeignStoreImageUrl,
} from "@/lib/storage/ownership";
import { withUser, type UserIdentity } from "@/lib/db/client";
import { isUniqueViolation, dbErrorMessage } from "@/lib/db/errors";
import { categories } from "@/drizzle/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CategoryFormData {
  name: string;
  slug: string;
  description: string;
  image_url: string;
  sort_order: number;
  status: "active" | "hidden";
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

// Returns the caller's id only if their role grants `manage` on Categories.
// RLS enforces a baseline at the DB layer too; this is the app-layer gate.
async function getAdminIdentity(): Promise<UserIdentity | null> {
  return getManagerIdentity("categories");
}

async function resolveSlug(
  admin: UserIdentity,
  base: string,
  storeId: string,
  excludeId?: string,
) {
  const conds = [
    eq(categories.storeId, storeId),
    like(categories.slug, `${base}%`),
  ];
  if (excludeId) conds.push(ne(categories.id, excludeId));

  const rows = await withUser(admin, (db) =>
    db
      .select({ slug: categories.slug })
      .from(categories)
      .where(and(...conds)),
  );

  const taken = new Set(rows.map((c) => c.slug));
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

function revalidateCatalog() {
  revalidatePath("/dashboard/categories");
  revalidatePath("/dashboard/products");
  revalidatePath("/shop");
  // Category changes affect the shop + homepage category lists.
  revalidateTag(TAGS.categories, "max");
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createCategory(
  formData: CategoryFormData,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  if (!formData.name.trim()) return { error: "Name is required." };
  if (firstForeignStoreImageUrl(storeId, [formData.image_url]))
    return { error: FOREIGN_IMAGE_ERROR };

  const base = formData.slug ? slugify(formData.slug) : slugify(formData.name);
  const { slug: firstSlug, bump } = await resolveSlug(admin, base, storeId);
  let slug = firstSlug;

  const row = (s: string) => ({
    name: formData.name.trim(),
    slug: s,
    description: formData.description.trim() || null,
    imageUrl: formData.image_url || null,
    sortOrder: formData.sort_order ?? 0,
    status: formData.status,
    storeId,
  });

  // Each attempt runs in its OWN transaction: a unique violation aborts the
  // transaction it happens in, so retrying with a bumped slug needs a fresh
  // one. RLS (is_store_admin) gates the insert against the caller's store.
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    try {
      const [inserted] = await withUser(admin, (db) =>
        db.insert(categories).values(row(slug)).returning(),
      );
      revalidateCatalog();
      return { success: true, data: inserted as Record<string, unknown> };
    } catch (err) {
      if (!isUniqueViolation(err)) {
        console.error("createCategory error:", err);
        return { error: dbErrorMessage(err, "Failed to create category.") };
      }
      slug = bump(slug);
    }
  }

  return { error: "Could not generate a unique slug. Please try again." };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateCategory(
  id: string,
  formData: CategoryFormData,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const storeId = await getActingStoreId();

  if (!formData.name.trim()) return { error: "Name is required." };

  const base = formData.slug ? slugify(formData.slug) : slugify(formData.name);
  const { slug: firstSlug, bump } = await resolveSlug(admin, base, storeId, id);
  let slug = firstSlug;

  const row = (s: string) => ({
    name: formData.name.trim(),
    slug: s,
    description: formData.description.trim() || null,
    imageUrl: formData.image_url || null,
    sortOrder: formData.sort_order ?? 0,
    status: formData.status,
  });

  // The image referenced before this save, so a replaced/removed one can be
  // purged from storage afterwards.
  const prev = await withUser(admin, (db) =>
    db
      .select({ imageUrl: categories.imageUrl })
      .from(categories)
      .where(eq(categories.id, id))
      .limit(1),
  );
  const oldImage = prev[0]?.imageUrl ?? null;

  // Only what this save ADDS: an image already on the row may predate
  // store-prefixed uploads and cannot be proven ours.
  if (
    firstForeignStoreImageUrl(
      storeId,
      [formData.image_url],
      new Set(oldImage ? [oldImage] : []),
    )
  ) {
    return { error: FOREIGN_IMAGE_ERROR };
  }

  // Own transaction per attempt (see createCategory). No store filter needed:
  // RLS (is_store_admin) confines the update to the caller's own store, and
  // updated_at is maintained by the DB trigger.
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    try {
      await withUser(admin, (db) =>
        db.update(categories).set(row(slug)).where(eq(categories.id, id)),
      );
      const newImage = formData.image_url || null;
      if (oldImage && oldImage !== newImage)
        await deleteStorageUrls([oldImage], { ownedByStoreId: storeId });
      revalidateCatalog();
      return { success: true };
    } catch (err) {
      if (!isUniqueViolation(err)) {
        console.error("updateCategory error:", err);
        return { error: dbErrorMessage(err, "Failed to update category.") };
      }
      slug = bump(slug);
    }
  }

  return { error: "Could not generate a unique slug. Please try again." };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------
// Products referencing this category have category_id set to NULL by the FK
// (ON DELETE SET NULL), so they become "uncategorized" rather than being lost.

export async function deleteCategory(id: string): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };

  const prev = await withUser(admin, (db) =>
    db
      .select({ imageUrl: categories.imageUrl })
      .from(categories)
      .where(eq(categories.id, id))
      .limit(1),
  );

  try {
    // RLS (is_store_admin) confines the delete to the caller's own store.
    await withUser(admin, (db) =>
      db.delete(categories).where(eq(categories.id, id)),
    );
  } catch (err) {
    console.error("deleteCategory error:", err);
    return { error: dbErrorMessage(err, "Failed to delete category.") };
  }

  if (prev[0]?.imageUrl)
    await deleteStorageUrls([prev[0].imageUrl], {
      ownedByStoreId: await getActingStoreId(),
    });

  revalidateCatalog();
  return { success: true };
}
