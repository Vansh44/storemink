"use server";

import { and, desc, eq, inArray, like, ne, sql } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import { after } from "next/server";
import { notifyStoreContentPublished } from "@/lib/seo/store-indexing";
import { TAGS } from "@/lib/storefront/tags";
import { emitEvent } from "@/lib/notifications/record";
import { sanitizeBlogContent } from "@/lib/sanitize";
import { withService, withUser, type UserIdentity } from "@/lib/db/client";
import { isUniqueViolation, dbErrorMessage } from "@/lib/db/errors";
import { blogs, users } from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import {
  getManagerIdentity,
  getActingStoreId,
} from "@/app/dashboard/lib/access";
import { getCurrentStoreId } from "@/lib/store/resolve";
import {
  deleteStorageUrls,
  extractMediaUrlsFromHtml,
} from "@/lib/storage/cleanup";
import { gcsPathFromUrl } from "@/lib/storage/gcs";
import { isForeignStoreImageUrl } from "@/lib/storage/ownership";
import { getStoreSettings } from "@/lib/settings/resolve";
import { fetchBlogTaxonomy } from "@/lib/blog-taxonomy";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BlogFormData {
  title: string;
  slug: string;
  excerpt: string;
  content: string;
  cover_image_url: string;
  author: string;
  categories: string[];
  tags: string[];
  status: "draft" | "published" | "pending_review";
  featured: boolean;
  seo_title: string;
  seo_description: string;
  reading_time: number;
}

export interface ActionResult {
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Aliased select preserving the snake_case row shape the editor/list expect.
const BLOG_COLUMNS = {
  id: blogs.id,
  title: blogs.title,
  slug: blogs.slug,
  excerpt: blogs.excerpt,
  content: blogs.content,
  cover_image_url: blogs.coverImageUrl,
  author: blogs.author,
  status: blogs.status,
  tags: blogs.tags,
  categories: blogs.categories,
  featured: blogs.featured,
  seo_title: blogs.seoTitle,
  seo_description: blogs.seoDescription,
  reading_time: blogs.readingTime,
  created_by: blogs.createdBy,
  updated_by: blogs.updatedBy,
  published_at: blogs.publishedAt,
  created_at: blogs.createdAt,
  updated_at: blogs.updatedAt,
  submitted_by: blogs.submittedBy,
  is_customer_submission: blogs.isCustomerSubmission,
  store_id: blogs.storeId,
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function calculateReadingTime(html: string): number {
  // Strip HTML tags and count words
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const wordCount = text.split(" ").filter(Boolean).length;
  return Math.max(1, Math.ceil(wordCount / 200));
}

// Returns the caller's id only if their role grants `manage` on Blogs.
// RLS already enforces a baseline at the DB layer; this is the app-layer gate.
/**
 * Refuse a cover image that is one of OUR bucket's objects but belongs to a
 * different store.
 *
 * ★★ THE DANGEROUS SET IS EXACTLY "IN OUR BUCKET, OUTSIDE THIS STORE". Storing
 *    such a URL is not merely a hotlink: the orphan sweep below
 *    (`deleteStorageUrls` on the refs this save drops) resolves any in-bucket
 *    URL to a path with NO tenant predicate, so the next cover change
 *    permanently deletes the other merchant's object while their own row still
 *    points at it. Blocking the write is what makes that unreachable.
 *
 * ★ A URL OUTSIDE OUR BUCKET IS ALLOWED THROUGH, deliberately. `gcsPathFromUrl`
 *   returns null for it, so the sweep already treats it as unmanaged and never
 *   deletes it - and refusing it here would break every blog still carrying a
 *   legacy Supabase-hosted cover, which CODEBASE records as serving until the
 *   media backfill.
 *
 * ★★ AND ONLY A CHANGED VALUE IS JUDGED. `/api/upload` wrote bare
 *    `blog-covers/<file>` paths with no store prefix until 2026-08-23, so a
 *    legacy cover of THIS store cannot be proven ours - holding an existing
 *    blog to the new rule would make its title uneditable over an image nobody
 *    is touching. New values have only ever come from store-prefixed paths.
 */
function foreignCoverImageError(
  storeId: string,
  next: string | null | undefined,
  current?: string | null,
): string | null {
  const url = (next ?? "").trim();
  if (!url || url === (current ?? "").trim()) return null;
  return isForeignStoreImageUrl(storeId, url)
    ? "That cover image is not one of this store's own images. Upload it, or pick it from this store's Media Library."
    : null;
}

/**
 * Refuse a body image this store cannot be shown to own.
 *
 * ★★ THE ARTICLE BODY IS THE SAME HOLE AS THE COVER. `extractMediaUrlsFromHtml`
 *    feeds every `<img>` in the stored HTML to the identical orphan sweep, so
 *    an embedded in-bucket URL belonging to another store is deleted the next
 *    time the author removes it from the post - and the rich-text editor
 *    inserts images through the very same picker the cover uses.
 *
 * ★ IT JUDGES WHAT WILL BE STORED, not what was posted: `sanitizeBlogContent`
 *   runs first, so an `<img>` the sanitiser strips is never a reason to refuse
 *   a save, and one it keeps is exactly what the sweep will later see.
 *
 * ★ ONLY AN IMAGE THIS SAVE ADDS. The cover rule's reason, per image: a legacy
 *   body written before store-prefixed uploads cannot be proven ours, and
 *   re-judging it would make an old post uneditable over pictures nobody is
 *   touching. `deleteStorageUrls`'s own tenant scope is what covers a row that
 *   was poisoned before this check existed.
 */
function foreignBodyImageError(
  storeId: string,
  nextContent: string | null | undefined,
  currentContent?: string | null,
): string | null {
  if (!nextContent) return null;
  const kept = new Set(extractMediaUrlsFromHtml(currentContent));
  const added = extractMediaUrlsFromHtml(
    sanitizeBlogContent(nextContent),
  ).filter((url) => !kept.has(url));
  return added.some((url) => isForeignStoreImageUrl(storeId, url))
    ? "An image in this post is not one of this store's own images. Remove it, or re-upload it from the editor."
    : null;
}

/** Both image rules for one blog write, in the order the editor shows them. */
function foreignBlogImageError(
  storeId: string,
  next: { cover?: string | null; content?: string | null },
  current?: { cover?: string | null; content?: string | null },
): string | null {
  return (
    foreignCoverImageError(storeId, next.cover, current?.cover) ??
    foreignBodyImageError(storeId, next.content, current?.content)
  );
}

async function getAdminIdentity(): Promise<UserIdentity | null> {
  return getManagerIdentity("blogs");
}

/**
 * Full blog row by id (including the heavy `content` HTML) for the editor.
 * The dashboard list omits `content` to keep its payload small, so the editor
 * fetches the complete post here when opening an existing one — never opening
 * with a half-loaded object (which could blank-save the body). Returns null if
 * the post is missing or the caller can't manage blogs.
 */
export async function getBlogForEditor(
  id: string,
): Promise<Record<string, unknown> | null> {
  const admin = await getAdminIdentity();
  if (!admin) return null;
  const storeId = await getActingStoreId();
  try {
    const rows = await withService((db) =>
      db
        .select(BLOG_COLUMNS)
        .from(blogs)
        .where(and(eq(blogs.id, id), eq(blogs.storeId, storeId)))
        .limit(1),
    );
    return (rows[0] as Record<string, unknown> | undefined) ?? null;
  } catch (err) {
    console.error("getBlogForEditor error:", err);
    return null;
  }
}

/**
 * Validate a customer submission's categories/tags against the STORE'S OWN
 * taxonomy (blog_categories / blog_tags — managed in /dashboard/blogs/settings).
 * Client input is untrusted, so unknown names are dropped server-side. When the
 * store has defined options, at least one valid pick is required; a store with
 * no options defined doesn't block submissions on the missing pickers.
 */
async function validateCustomerTaxonomy(
  storeId: string,
  formData: Pick<CustomerBlogFormData, "categories" | "tags">,
): Promise<
  | { error: string }
  | { error?: undefined; categories: string[]; tags: string[] }
> {
  const available = await fetchBlogTaxonomy(storeId);
  const validCategories = new Set(available.categories.map((c) => c.name));
  const validTags = new Set(available.tags.map((t) => t.name));

  const categories = (formData.categories ?? []).filter((c) =>
    validCategories.has(c),
  );
  const tags = (formData.tags ?? []).filter((t) => validTags.has(t));

  if (validCategories.size > 0 && categories.length === 0) {
    return { error: "Please select at least one category." };
  }
  if (validTags.size > 0 && tags.length === 0) {
    return { error: "Please select at least one tag." };
  }
  return { categories, tags };
}

/**
 * Picks the first slug starting from `base` that isn't already taken, based on
 * a pre-check query. Returns a cursor so the caller can keep bumping the suffix
 * if a concurrent insert wins the race (the pre-check is best-effort; the DB
 * UNIQUE constraint is the source of truth). Runs under the caller's identity,
 * so RLS shapes what it can see — same as the old cookie-client pre-check.
 */
async function resolveSlug(
  admin: UserIdentity,
  base: string,
  storeId: string,
  excludeId?: string,
) {
  const conds = [eq(blogs.storeId, storeId), like(blogs.slug, `${base}%`)];
  if (excludeId) conds.push(ne(blogs.id, excludeId));

  const rows = await withUser(admin, (db) =>
    db
      .select({ slug: blogs.slug })
      .from(blogs)
      .where(and(...conds)),
  );

  const taken = new Set(rows.map((b) => b.slug));
  let counter = 2;
  let slug = base;
  while (taken.has(slug)) {
    slug = `${base}-${counter}`;
    counter++;
  }

  // bump() advances to the next free candidate after a unique-violation retry.
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

function revalidateBlogs() {
  revalidatePath("/dashboard/blogs");
  revalidatePath("/blogs");
  revalidateTag(TAGS.blogs, "max");
}

/**
 * Nudge search engines to (re)crawl newly published post(s).
 *
 * Mirrors notifyProductsPublished in product-actions.ts. It exists because only
 * ONE of the many paths that can publish a blog — the list-row toggle
 * (publishBlog) — ever pinged. Writing a post in the editor, approving a
 * customer submission, or bulk-publishing all went out silently, so the most
 * common way to publish was also the one search engines were never told about.
 *
 * Best-effort and off the response path. The background helper resolves the
 * canonical origin from the durable store id, so custom domains and platform
 * operator actions cannot announce the wrong host.
 */
async function notifyBlogPublished(
  slugs: (string | null | undefined)[],
  published: boolean,
) {
  if (!published) return;
  const live = slugs.filter((s): s is string => !!s);
  if (!live.length) return;
  // Swallow everything. This runs AFTER the post is already published and
  // committed, so anything thrown here — a store lookup that fails, a missing
  // request scope — would turn a successful publish into an error the merchant
  // sees, and they would (reasonably) try again. Telling a search engine is
  // strictly less important than the write that already succeeded.
  try {
    // Blog publication also happens from the shopper-facing customer workflow,
    // where there is no dashboard acting-store context. Host resolution gives
    // us the durable store id; the background helper resolves its origin.
    const storeId = await getCurrentStoreId();
    after(() =>
      notifyStoreContentPublished({
        storeId,
        paths: [...live.map((s) => `/blogs/${s}`), "/blogs", "/"],
      }),
    );
  } catch (err) {
    console.error("notifyBlogPublished failed:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Create Blog
// ---------------------------------------------------------------------------

export async function createBlog(
  formData: BlogFormData,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();

  if (!admin) {
    return { error: "Not authenticated" };
  }
  const userId = admin.uid;

  const readingTime = formData.content
    ? calculateReadingTime(formData.content)
    : 0;
  const storeId = await getActingStoreId();

  const imageError = foreignBlogImageError(storeId, {
    cover: formData.cover_image_url,
    content: formData.content,
  });
  if (imageError) return { error: imageError };

  const base = formData.slug || slugify(formData.title);
  const { slug: firstSlug, bump } = await resolveSlug(admin, base, storeId);
  let slug = firstSlug;

  const row = (s: string) => ({
    title: formData.title,
    slug: s,
    excerpt: formData.excerpt || null,
    content: formData.content ? sanitizeBlogContent(formData.content) : null,
    coverImageUrl: formData.cover_image_url || null,
    author: formData.author || null,
    categories: formData.categories.length > 0 ? formData.categories : [],
    tags: formData.tags.length > 0 ? formData.tags : [],
    status: formData.status,
    featured: formData.featured,
    seoTitle: formData.seo_title || null,
    seoDescription: formData.seo_description || null,
    readingTime,
    publishedAt:
      formData.status === "published" ? new Date().toISOString() : null,
    createdBy: userId,
    updatedBy: userId,
    storeId,
  });

  // Each attempt runs in its OWN transaction (a unique violation aborts the
  // transaction it happens in). RLS (is_store_admin) gates the insert.
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    try {
      const [inserted] = await withUser(admin, (db) =>
        db.insert(blogs).values(row(slug)).returning(),
      );
      revalidateBlogs();
      await notifyBlogPublished([slug], formData.status === "published");
      return { success: true, data: inserted as Record<string, unknown> };
    } catch (err) {
      if (!isUniqueViolation(err)) {
        console.error("createBlog error:", err);
        return { error: dbErrorMessage(err, "Failed to create blog.") };
      }
      // Lost the slug race to a concurrent insert — pick the next free slug.
      slug = bump(slug);
    }
  }

  return { error: "Could not generate a unique slug. Please try again." };
}

// ---------------------------------------------------------------------------
// Update Blog
// ---------------------------------------------------------------------------

export async function updateBlog(
  id: string,
  formData: BlogFormData,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();

  if (!admin) {
    return { error: "Not authenticated" };
  }
  const userId = admin.uid;

  const readingTime = formData.content
    ? calculateReadingTime(formData.content)
    : 0;
  const storeId = await getActingStoreId();

  // Check slug uniqueness (exclude current blog)
  const base = formData.slug || slugify(formData.title);
  const { slug: firstSlug, bump } = await resolveSlug(admin, base, storeId, id);
  let slug = firstSlug;

  // Get current blog to check if it was previously unpublished, and whether
  // this is a customer submission awaiting review (so we can notify the author
  // when an admin approves it by publishing from the editor).
  const currentRows = await withUser(admin, (db) =>
    db
      .select({
        status: blogs.status,
        published_at: blogs.publishedAt,
        submitted_by: blogs.submittedBy,
        is_customer_submission: blogs.isCustomerSubmission,
        cover_image_url: blogs.coverImageUrl,
        content: blogs.content,
      })
      .from(blogs)
      .where(eq(blogs.id, id))
      .limit(1),
  );
  const currentBlog = currentRows[0];

  const imageError = foreignBlogImageError(
    storeId,
    { cover: formData.cover_image_url, content: formData.content },
    { cover: currentBlog?.cover_image_url, content: currentBlog?.content },
  );
  if (imageError) return { error: imageError };

  const publishedAt =
    formData.status === "published"
      ? (currentBlog?.published_at ?? new Date().toISOString())
      : null;

  const row = (s: string) => ({
    title: formData.title,
    slug: s,
    excerpt: formData.excerpt || null,
    content: formData.content ? sanitizeBlogContent(formData.content) : null,
    coverImageUrl: formData.cover_image_url || null,
    author: formData.author || null,
    categories: formData.categories.length > 0 ? formData.categories : [],
    tags: formData.tags.length > 0 ? formData.tags : [],
    status: formData.status,
    featured: formData.featured,
    seoTitle: formData.seo_title || null,
    seoDescription: formData.seo_description || null,
    readingTime,
    publishedAt,
    updatedBy: userId,
  });

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    try {
      // Own transaction per attempt; RLS confines the update to the caller's
      // own store.
      await withUser(admin, (db) =>
        db.update(blogs).set(row(slug)).where(eq(blogs.id, id)),
      );
    } catch (err) {
      if (!isUniqueViolation(err)) {
        console.error("updateBlog error:", err);
        return { error: dbErrorMessage(err, "Failed to update blog.") };
      }
      slug = bump(slug);
      continue;
    }

    // Approving a customer submission by publishing it from the editor:
    // tell the author, mirroring approveCustomerBlog. The notification system
    // owns the mail now (merchant-editable copy, one global design), so this
    // is an emit rather than a bespoke send.
    const isApproval =
      currentBlog?.status === "pending_review" &&
      formData.status === "published" &&
      currentBlog?.submitted_by;
    if (isApproval) {
      emitEvent({
        type: "blog.approved",
        storeId,
        actor: { type: "admin", id: userId },
        subject: { type: "blog", id, label: formData.title },
        customerId: currentBlog!.submitted_by,
        payload: { title: formData.title, url: `/blogs/${slug}` },
      });
    }

    // Purge images no longer referenced (old cover + old body images that
    // aren't in the saved cover/body anymore).
    const oldRefs = [
      ...(currentBlog?.cover_image_url ? [currentBlog.cover_image_url] : []),
      ...extractMediaUrlsFromHtml(currentBlog?.content),
    ];
    const newRefs = new Set([
      ...(formData.cover_image_url ? [formData.cover_image_url] : []),
      ...extractMediaUrlsFromHtml(formData.content),
    ]);
    await deleteStorageUrls(
      oldRefs.filter((u) => !newRefs.has(u)),
      {
        ownedByStoreId: storeId,
      },
    );

    revalidateBlogs();
    revalidatePath(`/blogs/${slug}`);
    // Also covers the rename case: the slug here is the CURRENT one, so a post
    // republished under a new slug gets the new URL announced.
    await notifyBlogPublished([slug], formData.status === "published");
    return { success: true };
  }

  return { error: "Could not generate a unique slug. Please try again." };
}

// ---------------------------------------------------------------------------
// Delete Blog
// ---------------------------------------------------------------------------

export async function deleteBlog(id: string): Promise<ActionResult> {
  const admin = await getAdminIdentity();

  if (!admin) {
    return { error: "Not authenticated" };
  }

  const prevRows = await withUser(admin, (db) =>
    db
      .select({
        cover_image_url: blogs.coverImageUrl,
        content: blogs.content,
      })
      .from(blogs)
      .where(eq(blogs.id, id))
      .limit(1),
  );
  const prev = prevRows[0];

  try {
    // RLS confines the delete to the caller's own store.
    await withUser(admin, (db) => db.delete(blogs).where(eq(blogs.id, id)));
  } catch (err) {
    console.error("deleteBlog error:", err);
    return { error: dbErrorMessage(err, "Failed to delete blog.") };
  }

  await deleteStorageUrls(
    [prev?.cover_image_url ?? null, ...extractMediaUrlsFromHtml(prev?.content)],
    { ownedByStoreId: await getActingStoreId() },
  );

  revalidateBlogs();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Session-upload cleanup — the customer blog editor calls this to delete a
// cover image it just uploaded and then replaced/removed BEFORE the blog is
// saved (a saved cover is pruned server-side on the next save). Scoped to
// authenticated users + the blog-covers/ folder, and GCS URLs only, so it can
// never be abused to delete product images or other media. Best-effort.
// ---------------------------------------------------------------------------

export async function deleteUploadedImage(url: string): Promise<void> {
  const user = await getServerUser();
  if (!user || typeof url !== "string" || !url) return;

  const path = gcsPathFromUrl(url);
  if (!path || !path.startsWith("blog-covers/")) return;

  await deleteStorageUrls([url]);
}

// ---------------------------------------------------------------------------
// Publish Blog
// ---------------------------------------------------------------------------

export async function publishBlog(id: string): Promise<ActionResult> {
  const admin = await getAdminIdentity();

  if (!admin) {
    return { error: "Not authenticated" };
  }
  const userId = admin.uid;

  let published: { slug: string } | undefined;
  try {
    [published] = await withUser(admin, (db) =>
      db
        .update(blogs)
        .set({
          status: "published",
          publishedAt: new Date().toISOString(),
          updatedBy: userId,
        })
        .where(eq(blogs.id, id))
        .returning({ slug: blogs.slug }),
    );
  } catch (err) {
    console.error("publishBlog error:", err);
    return { error: dbErrorMessage(err, "Failed to publish blog.") };
  }
  if (!published) return { error: "Blog not found." };

  revalidateBlogs();
  await notifyBlogPublished([published.slug], true);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Unpublish Blog
// ---------------------------------------------------------------------------

export async function unpublishBlog(id: string): Promise<ActionResult> {
  const admin = await getAdminIdentity();

  if (!admin) {
    return { error: "Not authenticated" };
  }
  const userId = admin.uid;

  try {
    await withUser(admin, (db) =>
      db
        .update(blogs)
        .set({
          status: "draft",
          publishedAt: null,
          updatedBy: userId,
        })
        .where(eq(blogs.id, id)),
    );
  } catch (err) {
    console.error("unpublishBlog error:", err);
    return { error: dbErrorMessage(err, "Failed to unpublish blog.") };
  }

  revalidateBlogs();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Bulk operations (dashboard multi-select)
// ---------------------------------------------------------------------------

/** Publish or unpublish many blogs at once. */
export async function bulkSetBlogStatus(
  ids: string[],
  status: "published" | "draft",
): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  const userId = admin.uid;
  if (ids.length === 0) return { error: "Nothing selected." };

  let touched: { slug: string | null }[] = [];
  try {
    touched = await withUser(admin, (db) =>
      db
        .update(blogs)
        .set({
          status,
          // COALESCE, not a fresh timestamp: re-running a bulk publish over
          // already-published posts used to stamp them all with "now", which
          // rewrites their sitemap lastmod (and their displayed date) even
          // though nothing about the content changed. A post keeps the date it
          // first went live; only a genuinely new publish gets today's.
          publishedAt:
            status === "published"
              ? sql`COALESCE(${blogs.publishedAt}, now())`
              : null,
          updatedBy: userId,
        })
        .where(inArray(blogs.id, ids))
        .returning({ slug: blogs.slug }),
    );
  } catch (err) {
    console.error("bulkSetBlogStatus error:", err);
    return { error: dbErrorMessage(err, "Failed to update blogs.") };
  }

  revalidateBlogs();
  await notifyBlogPublished(
    touched.map((t) => t.slug),
    status === "published",
  );
  return { success: true };
}

/** Feature or unfeature many blogs at once. */
export async function bulkSetBlogFeatured(
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
        .update(blogs)
        .set({ featured, updatedBy: userId })
        .where(inArray(blogs.id, ids)),
    );
  } catch (err) {
    console.error("bulkSetBlogFeatured error:", err);
    return { error: dbErrorMessage(err, "Failed to update blogs.") };
  }

  revalidateBlogs();
  return { success: true };
}

/** Permanently delete many blogs, cleaning up their storage assets. */
export async function bulkDeleteBlogs(ids: string[]): Promise<ActionResult> {
  const admin = await getAdminIdentity();
  if (!admin) return { error: "Not authenticated" };
  if (ids.length === 0) return { error: "Nothing selected." };

  // Collect every referenced asset before the rows go (storage won't cascade).
  const rows = await withUser(admin, (db) =>
    db
      .select({
        cover_image_url: blogs.coverImageUrl,
        content: blogs.content,
      })
      .from(blogs)
      .where(inArray(blogs.id, ids)),
  );

  try {
    await withUser(admin, (db) =>
      db.delete(blogs).where(inArray(blogs.id, ids)),
    );
  } catch (err) {
    console.error("bulkDeleteBlogs error:", err);
    return { error: dbErrorMessage(err, "Failed to delete blogs.") };
  }

  const urls: (string | null)[] = [];
  for (const r of rows) {
    urls.push(r.cover_image_url);
    urls.push(...extractMediaUrlsFromHtml(r.content));
  }
  await deleteStorageUrls(urls, { ownedByStoreId: await getActingStoreId() });

  revalidateBlogs();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Auto-save Draft (lightweight update — no slug re-check)
// ---------------------------------------------------------------------------

export async function autosaveBlog(
  id: string,
  fields: Partial<BlogFormData>,
): Promise<ActionResult> {
  const admin = await getAdminIdentity();

  if (!admin) {
    return { error: "Not authenticated" };
  }
  const userId = admin.uid;

  const updateData: Record<string, unknown> = { updatedBy: userId };

  // The extra read is paid only when this autosave actually carries an image
  // field, and it is what lets a legacy pre-2026-08-23 cover or body keep
  // saving while a newly added foreign one is refused.
  if (fields.cover_image_url !== undefined || fields.content !== undefined) {
    const storeId = await getActingStoreId();
    const currentRows = await withUser(admin, (db) =>
      db
        .select({
          cover_image_url: blogs.coverImageUrl,
          content: blogs.content,
        })
        .from(blogs)
        .where(and(eq(blogs.id, id), eq(blogs.storeId, storeId)))
        .limit(1),
    );
    const imageError = foreignBlogImageError(
      storeId,
      { cover: fields.cover_image_url, content: fields.content },
      {
        cover: currentRows[0]?.cover_image_url,
        content: currentRows[0]?.content,
      },
    );
    if (imageError) return { error: imageError };
  }

  if (fields.title !== undefined) updateData.title = fields.title;
  if (fields.content !== undefined) {
    updateData.content = sanitizeBlogContent(fields.content);
    updateData.readingTime = calculateReadingTime(fields.content);
  }
  if (fields.excerpt !== undefined) updateData.excerpt = fields.excerpt;
  if (fields.cover_image_url !== undefined)
    updateData.coverImageUrl = fields.cover_image_url;
  if (fields.author !== undefined) updateData.author = fields.author;
  if (fields.categories !== undefined)
    updateData.categories = fields.categories;
  if (fields.tags !== undefined) updateData.tags = fields.tags;
  if (fields.seo_title !== undefined) updateData.seoTitle = fields.seo_title;
  if (fields.seo_description !== undefined)
    updateData.seoDescription = fields.seo_description;

  try {
    await withUser(admin, (db) =>
      db.update(blogs).set(updateData).where(eq(blogs.id, id)),
    );
  } catch (err) {
    console.error("autosaveBlog error:", err);
    return { error: dbErrorMessage(err, "Failed to save draft.") };
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// Customer Blog Submission Types
// ---------------------------------------------------------------------------

export interface CustomerBlogFormData {
  title: string;
  excerpt: string;
  content: string;
  cover_image_url: string;
  categories: string[];
  tags: string[];
}

// Own-row customer profile read (users is own-row only under RLS).
async function getCustomerProfile(
  user: UserIdentity,
): Promise<{ first_name: string; last_name: string | null } | null> {
  const rows = await withUser(user, (db) =>
    db
      .select({ first_name: users.firstName, last_name: users.lastName })
      .from(users)
      .where(eq(users.id, user.uid))
      .limit(1),
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Submit Customer Blog (creates with 'pending_review' status)
// ---------------------------------------------------------------------------

export async function submitCustomerBlog(
  formData: CustomerBlogFormData,
): Promise<ActionResult> {
  const user = await getServerUser();

  if (!user) {
    return { error: "Not authenticated. Please sign in to submit a blog." };
  }

  // Store feature settings gate this whole flow: submissions can be switched
  // off entirely, and the approval queue can be bypassed (direct publish).
  const settings = await getStoreSettings();
  if (!settings["blogs.customerSubmissions"]) {
    return { error: "Blog submissions are currently disabled on this store." };
  }
  const requireApproval = settings["blogs.requireApproval"];

  // Verify user is a customer
  const customer = await getCustomerProfile({
    uid: user.id,
    email: user.email,
  });
  if (!customer) {
    return {
      error: "Customer profile not found. Please complete your profile first.",
    };
  }

  if (!formData.title.trim()) {
    return { error: "Title is required." };
  }

  if (!formData.content.trim()) {
    return { error: "Blog content is required." };
  }

  const storeId = await getCurrentStoreId();
  const taxonomy = await validateCustomerTaxonomy(storeId, formData);
  if (taxonomy.error !== undefined) return { error: taxonomy.error };

  // A shopper is the least trusted writer here, and their submission reaches
  // the same orphan sweep as an admin's post.
  const imageError = foreignBlogImageError(storeId, {
    cover: formData.cover_image_url,
    content: formData.content,
  });
  if (imageError) return { error: imageError };

  const readingTime = calculateReadingTime(formData.content);
  const authorName = `${customer.first_name}${customer.last_name ? " " + customer.last_name : ""}`;

  const base = slugify(formData.title);
  const { slug: firstSlug, bump } = await resolveSlug(
    { uid: user.id, email: user.email },
    base,
    storeId,
  );
  let slug = firstSlug;

  const row = (s: string) => ({
    title: formData.title.trim(),
    slug: s,
    excerpt: formData.excerpt.trim() || null,
    content: sanitizeBlogContent(formData.content),
    coverImageUrl: formData.cover_image_url || null,
    author: authorName,
    categories: taxonomy.categories,
    tags: taxonomy.tags,
    status: "pending_review",
    featured: false,
    readingTime,
    submittedBy: user.id,
    isCustomerSubmission: true,
    createdBy: user.id,
    updatedBy: user.id,
    storeId,
  });

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    let inserted: Record<string, unknown>;
    try {
      // RLS only lets a customer insert their own pending_review rows.
      const [row0] = await withUser({ uid: user.id, email: user.email }, (db) =>
        db.insert(blogs).values(row(slug)).returning(),
      );
      inserted = row0 as Record<string, unknown>;
    } catch (err) {
      if (!isUniqueViolation(err)) {
        console.error("submitCustomerBlog error:", err);
        return { error: dbErrorMessage(err, "Failed to submit blog.") };
      }
      slug = bump(slug);
      continue;
    }

    // Direct publish (store setting): RLS only lets a customer insert
    // pending_review rows, so after the trusted setting check above the
    // promotion runs with the service scope. A promotion failure leaves the
    // post safely in the review queue.
    if (!requireApproval && inserted?.id) {
      try {
        await withService((db) =>
          db
            .update(blogs)
            .set({
              status: "published",
              publishedAt: new Date().toISOString(),
            })
            .where(
              and(
                eq(blogs.id, inserted.id as string),
                eq(blogs.status, "pending_review"),
              ),
            ),
        );
        revalidatePath("/blogs");
        revalidateTag(TAGS.blogs, "max");
        // It is live to the public now, exactly like an admin publish.
        await notifyBlogPublished([slug], true);
      } catch (promoteError) {
        console.error("submitCustomerBlog promote error:", promoteError);
      }
    }

    // Notify the store: a submission that needs approval is work waiting in a
    // queue; a direct publish is just news. Either way the shopper's post is
    // now the store's responsibility.
    emitEvent({
      type: requireApproval ? "blog.submitted" : "blog.published",
      storeId,
      actor: { type: "customer", id: user.id, label: authorName || null },
      subject: {
        type: "blog",
        id: (inserted?.id as string) ?? null,
        label: formData.title,
      },
      payload: { slug },
    });

    revalidatePath("/dashboard/blogs");
    return { success: true, data: inserted };
  }

  return { error: "Could not generate a unique slug. Please try again." };
}

// ---------------------------------------------------------------------------
// Save Customer Blog Draft (create or update a private draft)
// A draft only needs a title — everything else can be filled in later. Drafts
// are never publicly visible and never enter the review queue until the author
// submits them. Pass `id` to keep updating the same draft.
// ---------------------------------------------------------------------------

export async function saveCustomerBlogDraft(
  formData: CustomerBlogFormData,
  id?: string,
): Promise<ActionResult> {
  const user = await getServerUser();

  if (!user) {
    return { error: "Not authenticated. Please sign in to save a draft." };
  }

  const settings = await getStoreSettings();
  if (!settings["blogs.customerSubmissions"]) {
    return { error: "Blog submissions are currently disabled on this store." };
  }

  const customer = await getCustomerProfile({
    uid: user.id,
    email: user.email,
  });
  if (!customer) {
    return {
      error: "Customer profile not found. Please complete your profile first.",
    };
  }

  if (!formData.title.trim()) {
    return { error: "Add a title before saving your draft." };
  }

  const readingTime = calculateReadingTime(formData.content || "");

  // Update an existing draft — scoped to the author's own draft rows so a
  // submitted/published post can't be silently pulled back here.
  if (id) {
    try {
      await withUser({ uid: user.id, email: user.email }, (db) =>
        db
          .update(blogs)
          .set({
            title: formData.title.trim(),
            excerpt: formData.excerpt.trim() || null,
            content: sanitizeBlogContent(formData.content || ""),
            coverImageUrl: formData.cover_image_url || null,
            categories: formData.categories ?? [],
            tags: formData.tags ?? [],
            readingTime,
            updatedBy: user.id,
            status: "draft",
          })
          .where(
            and(
              eq(blogs.id, id),
              eq(blogs.submittedBy, user.id),
              eq(blogs.status, "draft"),
            ),
          ),
      );
    } catch (err) {
      console.error("saveCustomerBlogDraft update error:", err);
      return { error: dbErrorMessage(err, "Failed to save draft.") };
    }
    revalidatePath("/dashboard/blogs");
    return { success: true, data: { id } };
  }

  // Create a new draft.
  const storeId = await getCurrentStoreId();
  const authorName = `${customer.first_name}${customer.last_name ? " " + customer.last_name : ""}`;
  const base = slugify(formData.title);
  const { slug: firstSlug, bump } = await resolveSlug(
    { uid: user.id, email: user.email },
    base,
    storeId,
  );
  let slug = firstSlug;

  const row = (s: string) => ({
    title: formData.title.trim(),
    slug: s,
    excerpt: formData.excerpt.trim() || null,
    content: sanitizeBlogContent(formData.content || ""),
    coverImageUrl: formData.cover_image_url || null,
    author: authorName,
    categories: formData.categories ?? [],
    tags: formData.tags ?? [],
    status: "draft",
    featured: false,
    readingTime,
    submittedBy: user.id,
    isCustomerSubmission: true,
    createdBy: user.id,
    updatedBy: user.id,
    storeId,
  });

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    try {
      const [inserted] = await withUser(
        { uid: user.id, email: user.email },
        (db) => db.insert(blogs).values(row(slug)).returning({ id: blogs.id }),
      );
      revalidatePath("/dashboard/blogs");
      return { success: true, data: inserted as Record<string, unknown> };
    } catch (err) {
      if (!isUniqueViolation(err)) {
        console.error("saveCustomerBlogDraft insert error:", err);
        return { error: dbErrorMessage(err, "Failed to save draft.") };
      }
      slug = bump(slug);
    }
  }

  return { error: "Could not generate a unique slug. Please try again." };
}

// ---------------------------------------------------------------------------
// Update Customer Blog — saves edits and submits for review. Works on the
// author's own draft (promotes it to pending_review) or an already-pending row.
// ---------------------------------------------------------------------------

export async function updateCustomerBlog(
  id: string,
  formData: CustomerBlogFormData,
): Promise<ActionResult> {
  const user = await getServerUser();

  if (!user) {
    return { error: "Not authenticated." };
  }

  const settings = await getStoreSettings();
  if (!settings["blogs.customerSubmissions"]) {
    return { error: "Blog submissions are currently disabled on this store." };
  }
  const requireApproval = settings["blogs.requireApproval"];

  if (!formData.title.trim()) {
    return { error: "Title is required." };
  }

  if (!formData.content.trim()) {
    return { error: "Blog content is required." };
  }

  const storeId = await getCurrentStoreId();
  const taxonomy = await validateCustomerTaxonomy(storeId, formData);
  if (taxonomy.error !== undefined) return { error: taxonomy.error };

  const readingTime = calculateReadingTime(formData.content);

  // The author's current cover + body images, so replaced/removed ones can be
  // purged after saving.
  const prevRows = await withUser({ uid: user.id, email: user.email }, (db) =>
    db
      .select({
        cover_image_url: blogs.coverImageUrl,
        content: blogs.content,
      })
      .from(blogs)
      .where(and(eq(blogs.id, id), eq(blogs.submittedBy, user.id)))
      .limit(1),
  );
  const prev = prevRows[0];

  const imageError = foreignBlogImageError(
    storeId,
    { cover: formData.cover_image_url, content: formData.content },
    { cover: prev?.cover_image_url, content: prev?.content },
  );
  if (imageError) return { error: imageError };

  try {
    await withUser({ uid: user.id, email: user.email }, (db) =>
      db
        .update(blogs)
        .set({
          title: formData.title.trim(),
          excerpt: formData.excerpt.trim() || null,
          content: sanitizeBlogContent(formData.content),
          coverImageUrl: formData.cover_image_url || null,
          categories: taxonomy.categories,
          tags: taxonomy.tags,
          readingTime,
          updatedBy: user.id,
          // Drafts are promoted to the review queue; already-pending rows stay put.
          status: "pending_review",
        })
        .where(
          and(
            eq(blogs.id, id),
            eq(blogs.submittedBy, user.id),
            inArray(blogs.status, ["draft", "pending_review"]),
          ),
        ),
    );
  } catch (err) {
    console.error("updateCustomerBlog error:", err);
    return { error: dbErrorMessage(err, "Failed to update blog.") };
  }

  // Direct publish (store setting): same service-scope promotion as
  // submitCustomerBlog — RLS caps a customer's own writes at pending_review.
  if (!requireApproval) {
    let promoted: { slug: string } | undefined;
    try {
      [promoted] = await withService((db) =>
        db
          .update(blogs)
          .set({
            status: "published",
            publishedAt: new Date().toISOString(),
          })
          .where(
            and(
              eq(blogs.id, id),
              eq(blogs.submittedBy, user.id),
              eq(blogs.status, "pending_review"),
            ),
          )
          .returning({ slug: blogs.slug }),
      );
      revalidatePath("/blogs");
      revalidateTag(TAGS.blogs, "max");
      if (promoted?.slug) {
        await notifyBlogPublished([promoted.slug], true);
      }
    } catch (promoteError) {
      console.error("updateCustomerBlog promote error:", promoteError);
    }
  }

  const oldRefs = [
    ...(prev?.cover_image_url ? [prev.cover_image_url] : []),
    ...extractMediaUrlsFromHtml(prev?.content),
  ];
  const newRefs = new Set([
    ...(formData.cover_image_url ? [formData.cover_image_url] : []),
    ...extractMediaUrlsFromHtml(formData.content),
  ]);
  await deleteStorageUrls(
    oldRefs.filter((u) => !newRefs.has(u)),
    {
      ownedByStoreId: storeId,
    },
  );

  revalidatePath("/dashboard/blogs");
  return { success: true };
}

// ---------------------------------------------------------------------------
// Get My Submissions (customer's own blog submissions)
// ---------------------------------------------------------------------------

export async function getMySubmissions(): Promise<ActionResult> {
  const user = await getServerUser();

  if (!user) {
    return { error: "Not authenticated." };
  }

  try {
    const submissions = await withUser(
      { uid: user.id, email: user.email },
      (db) =>
        db
          .select({
            id: blogs.id,
            title: blogs.title,
            slug: blogs.slug,
            excerpt: blogs.excerpt,
            content: blogs.content,
            cover_image_url: blogs.coverImageUrl,
            author: blogs.author,
            status: blogs.status,
            categories: blogs.categories,
            tags: blogs.tags,
            reading_time: blogs.readingTime,
            created_at: blogs.createdAt,
            updated_at: blogs.updatedAt,
            submitted_by: blogs.submittedBy,
            is_customer_submission: blogs.isCustomerSubmission,
          })
          .from(blogs)
          .where(
            and(
              eq(blogs.submittedBy, user.id),
              eq(blogs.isCustomerSubmission, true),
            ),
          )
          .orderBy(desc(blogs.createdAt)),
    );
    return { success: true, data: { submissions } };
  } catch (err) {
    console.error("getMySubmissions error:", err);
    return { error: dbErrorMessage(err, "Failed to load submissions.") };
  }
}

// ---------------------------------------------------------------------------
// Delete Customer Blog (author withdraws their own draft / pending submission)
// ---------------------------------------------------------------------------

export async function deleteCustomerBlog(id: string): Promise<ActionResult> {
  const user = await getServerUser();

  if (!user) {
    return { error: "Not authenticated." };
  }

  let removedRows: {
    id: string;
    cover_image_url: string | null;
    content: string | null;
  }[];
  try {
    removedRows = await withUser({ uid: user.id, email: user.email }, (db) =>
      db
        .delete(blogs)
        .where(
          and(
            eq(blogs.id, id),
            eq(blogs.submittedBy, user.id),
            inArray(blogs.status, ["draft", "pending_review"]),
          ),
        )
        .returning({
          id: blogs.id,
          cover_image_url: blogs.coverImageUrl,
          content: blogs.content,
        }),
    );
  } catch (err) {
    console.error("deleteCustomerBlog error:", err);
    return { error: dbErrorMessage(err, "Failed to delete blog.") };
  }
  // No row removed → either it isn't theirs, already published, or the delete
  // policy hasn't been applied yet. Surface it rather than failing silently.
  if (removedRows.length === 0) {
    return {
      error: "Couldn't delete this blog. Please refresh and try again.",
    };
  }

  const removed = removedRows[0];
  await deleteStorageUrls(
    [
      removed.cover_image_url ?? null,
      ...extractMediaUrlsFromHtml(removed.content),
    ],
    { ownedByStoreId: await getCurrentStoreId() },
  );

  revalidatePath("/dashboard/blogs");
  return { success: true };
}

// ---------------------------------------------------------------------------
// Move a pending submission back to draft (author withdraws from review)
// ---------------------------------------------------------------------------

export async function revertCustomerBlogToDraft(
  id: string,
): Promise<ActionResult> {
  const user = await getServerUser();

  if (!user) {
    return { error: "Not authenticated." };
  }

  let reverted: { id: string }[];
  try {
    reverted = await withUser({ uid: user.id, email: user.email }, (db) =>
      db
        .update(blogs)
        .set({ status: "draft", updatedBy: user.id })
        .where(
          and(
            eq(blogs.id, id),
            eq(blogs.submittedBy, user.id),
            eq(blogs.status, "pending_review"),
          ),
        )
        .returning({ id: blogs.id }),
    );
  } catch (err) {
    console.error("revertCustomerBlogToDraft error:", err);
    return { error: dbErrorMessage(err, "Failed to move blog to draft.") };
  }
  if (reverted.length === 0) {
    return {
      error: "Couldn't move this blog to draft. Please refresh and try again.",
    };
  }

  revalidatePath("/dashboard/blogs");
  return { success: true };
}

// ---------------------------------------------------------------------------
// Approve Customer Blog (admin only — sets status to 'published')
// ---------------------------------------------------------------------------

export async function approveCustomerBlog(id: string): Promise<ActionResult> {
  const admin = await getAdminIdentity();

  if (!admin) {
    return { error: "Not authenticated" };
  }
  const userId = admin.uid;

  let approved:
    | { title: string; slug: string; submitted_by: string | null }
    | undefined;
  try {
    [approved] = await withUser(admin, (db) =>
      db
        .update(blogs)
        .set({
          status: "published",
          publishedAt: new Date().toISOString(),
          updatedBy: userId,
        })
        .where(and(eq(blogs.id, id), eq(blogs.status, "pending_review")))
        .returning({
          title: blogs.title,
          slug: blogs.slug,
          submitted_by: blogs.submittedBy,
        }),
    );
  } catch (err) {
    console.error("approveCustomerBlog error:", err);
    return { error: dbErrorMessage(err, "Failed to approve blog.") };
  }
  if (!approved) {
    return { error: "This blog is no longer pending review." };
  }

  // Tell the author their blog is live. Deferred and swallowed by emitEvent,
  // so a mail failure can never undo the approval.
  if (approved.submitted_by) {
    emitEvent({
      type: "blog.approved",
      storeId: await getActingStoreId(),
      actor: { type: "admin", id: userId },
      subject: { type: "blog", id, label: approved.title },
      customerId: approved.submitted_by,
      payload: { title: approved.title, url: `/blogs/${approved.slug}` },
    });
  }

  revalidateBlogs();
  await notifyBlogPublished([approved.slug], true);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Reject Customer Blog (admin only — deletes the blog)
// ---------------------------------------------------------------------------

export async function rejectCustomerBlog(id: string): Promise<ActionResult> {
  const admin = await getAdminIdentity();

  if (!admin) {
    return { error: "Not authenticated" };
  }

  // Capture the author + title before deleting so we can email them after.
  const targetRows = await withUser(admin, (db) =>
    db
      .select({ title: blogs.title, submitted_by: blogs.submittedBy })
      .from(blogs)
      .where(and(eq(blogs.id, id), eq(blogs.status, "pending_review")))
      .limit(1),
  );
  const target = targetRows[0];

  try {
    await withUser(admin, (db) =>
      db
        .delete(blogs)
        .where(and(eq(blogs.id, id), eq(blogs.status, "pending_review"))),
    );
  } catch (err) {
    console.error("rejectCustomerBlog error:", err);
    return { error: dbErrorMessage(err, "Failed to reject blog.") };
  }

  // Tell the author their submission wasn't approved.
  if (target?.submitted_by) {
    emitEvent({
      type: "blog.rejected",
      storeId: await getActingStoreId(),
      actor: { type: "admin", id: admin.uid },
      subject: { type: "blog", id, label: target.title },
      customerId: target.submitted_by,
      payload: { title: target.title },
    });
  }

  revalidatePath("/dashboard/blogs");
  return { success: true };
}
