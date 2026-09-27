import {
  GCS_PUBLIC_HOST,
  gcsPathFromUrl,
  gcsDeletePaths,
} from "@/lib/storage/gcs";
import {
  isOtherStoreObjectPath,
  isThemeReleaseObjectPath,
} from "@/lib/storage/paths";
import { logError } from "@/lib/observability/logger";

// Server-only helpers to keep object storage in sync with the database.
// Uploads add files to Google Cloud Storage; removing a URL from a row only
// drops the reference, so without this the file would be orphaned in the bucket.
//
// GCS-only: media lives in GCS (storage.googleapis.com/<bucket>/…). Legacy
// Supabase-hosted URLs (from before the Phase-3 migration) are left untouched —
// they keep serving until the Supabase project is decommissioned.

// Escaped host for use inside a RegExp (dots are regex metachars).
const GCS_HOST_RE = GCS_PUBLIC_HOST.replace(/\./g, "\\.");

// Pull every managed (GCS) media URL out of an HTML string — e.g. images the
// rich-text editor embedded in a blog body. Returns unique URLs.
export function extractMediaUrlsFromHtml(
  html: string | null | undefined,
): string[] {
  if (!html) return [];
  const re = new RegExp(
    // storage.googleapis.com/<bucket>/<path>
    `https?://${GCS_HOST_RE}/[^/"'\\s)]+/[^"'\\s)]+`,
    "g",
  );
  return Array.from(new Set(html.match(re) ?? []));
}

// Best-effort deletion of GCS objects by their public URL. Never throws — a
// storage hiccup must not fail the surrounding DB write. Non-GCS URLs (e.g.
// legacy Supabase) cannot be deleted here and are counted for callers that need
// to surface an incomplete purge.
/**
 * @param options.ownedByStoreId Refuse to delete an object that provably
 *   belongs to ANOTHER store, and count it as `foreign` instead.
 *
 * ★★ THE SWEEP IS THE SHARP EDGE, because it resolves any in-bucket URL to a
 *    path with no tenant predicate: a row holding another store's URL turns an
 *    ordinary orphan clean-up into cross-tenant data loss. Writes are guarded
 *    too, but a guard on the write cannot reach a URL that is ALREADY in the
 *    database - and the write guards deliberately exempt a value that has not
 *    changed, so a row poisoned before they existed would still be swept.
 *
 * ★ IT ASKS "IS THIS PROVABLY THEIRS", NOT "IS THIS PROVABLY OURS". Objects
 *   uploaded before 2026-08-23 have no store prefix at all and belong to no
 *   store's namespace, so they stay deletable; refusing everything we cannot
 *   prove is ours would silently leak every legacy object instead.
 *
 * ⚠ OPT-IN. The platform store purge and the Help console legitimately delete
 *   outside one store's prefix, so an omitted option means "no tenant scope"
 *   and every existing caller is unchanged.
 */
export async function deleteStorageUrls(
  urls: (string | null | undefined)[],
  options?: { ownedByStoreId?: string },
): Promise<{
  attempted: number;
  failed: number;
  unmanaged: number;
  foreign: number;
  /** Published theme images, which belong to no store and are never swept. */
  shared: number;
}> {
  const gcsPaths = new Set<string>();
  const unmanagedUrls = new Set<string>();
  const storeId = options?.ownedByStoreId;
  let foreign = 0;
  let shared = 0;

  for (const url of urls) {
    if (!url) continue;
    const gcsPath = gcsPathFromUrl(url);
    if (!gcsPath) {
      unmanagedUrls.add(url);
      continue;
    }
    // Unconditional, unlike the tenant scope below: a published theme image is
    // referenced by every store the theme seeded, so no caller — not even the
    // platform store purge — may treat it as its own orphan.
    if (isThemeReleaseObjectPath(gcsPath)) {
      shared += 1;
      continue;
    }
    if (storeId && isOtherStoreObjectPath(gcsPath, storeId)) {
      foreign += 1;
      continue;
    }
    gcsPaths.add(gcsPath);
  }

  if (foreign > 0) {
    // Never the object's path or URL: this is another tenant's data, and the
    // count is what an operator needs to notice a poisoned row.
    logError(
      "deleteStorageUrls: refused an object owned by another store",
      new Error("cross_store_object_skipped"),
      { storeId, foreign },
    );
  }

  if (gcsPaths.size > 0) {
    try {
      const failed = await gcsDeletePaths([...gcsPaths]);
      return {
        attempted: gcsPaths.size,
        failed: failed.length,
        unmanaged: unmanagedUrls.size,
        foreign,
        shared,
      };
    } catch (err) {
      logError("deleteStorageUrls: GCS delete failed", err);
      return {
        attempted: gcsPaths.size,
        failed: gcsPaths.size,
        unmanaged: unmanagedUrls.size,
        foreign,
        shared,
      };
    }
  }
  return {
    attempted: 0,
    failed: 0,
    unmanaged: unmanagedUrls.size,
    foreign,
    shared,
  };
}
