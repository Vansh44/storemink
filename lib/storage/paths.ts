/** Build a tenant-owned GCS path for uploads that are not media-library rows. */
export function storeUploadPath(
  storeId: string | null,
  folder: string,
  fileName: string,
): string {
  const cleanFolder = folder
    .replace(/[^a-z0-9/_-]/gi, "")
    .split("/")
    .filter(Boolean)
    .join("/");
  const root = storeId ? `stores/${storeId}/uploads` : "platform/uploads";
  return cleanFolder
    ? `${root}/${cleanFolder}/${fileName}`
    : `${root}/${fileName}`;
}

/** Every GCS object created for a store lives below this prefix going forward. */
export function storeStoragePrefix(storeId: string): string {
  return `stores/${storeId}/`;
}

/** The namespace every store-prefixed object shares. */
const STORE_OBJECT_ROOT = "stores/";

/**
 * Whether an in-bucket object path belongs to this store.
 *
 * ★★ THE BUCKET IS SHARED BY EVERY STORE, SO "IT IS ONE OF OUR GCS URLS" IS
 *    NOT OWNERSHIP. `deleteStorageUrls` resolves any in-bucket URL to a path
 *    and deletes it with no tenant predicate, so a row holding another store's
 *    URL turns an ordinary orphan sweep into cross-tenant data loss: change
 *    the blog cover, and the other merchant's object is gone while their own
 *    row still points at it.
 *
 * ⚠ IT IS DELIBERATELY NOT AN ANSWER FOR EVERY OBJECT WE HOST. `/api/upload`
 *   wrote bare `blog-covers/<file>` paths with no store prefix until
 *   2026-08-23 (commit 018648c), so a legacy object of THIS store returns
 *   false here and cannot be attributed to anyone. Callers must therefore
 *   treat this as "provably ours", not as "not ours" - refuse a NEW value it
 *   rejects, never a value already stored.
 */
export function isStoreOwnedObjectPath(path: string, storeId: string): boolean {
  if (!storeId || !path) return false;
  return path.startsWith(storeStoragePrefix(storeId));
}

/**
 * Whether an in-bucket path provably belongs to a DIFFERENT store.
 *
 * ★★ THIS IS NOT `!isStoreOwnedObjectPath`, AND THE DIFFERENCE IS THE WHOLE
 *    POINT. An unattributable legacy path (`blog-covers/x.webp`, written
 *    before 2026-08-23) is not ours in the provable sense, but it is not
 *    another store's either - it is outside the `stores/` namespace entirely.
 *    Treating "not provably ours" as "someone else's" would make the orphan
 *    sweeps stop cleaning every object uploaded before that date, silently
 *    leaking them forever; treating "not provably theirs" as safe to delete is
 *    what let one merchant destroy another's file. So deletion asks THIS
 *    question and a write asks `isStoreOwnedObjectPath`.
 */
export function isOtherStoreObjectPath(path: string, storeId: string): boolean {
  if (!path || !path.startsWith(STORE_OBJECT_ROOT)) return false;
  return !isStoreOwnedObjectPath(path, storeId);
}

/**
 * Published Theme Studio images (Phase 6): one immutable object per slot of a
 * published theme release, shared by the demo store and by every merchant
 * store the theme seeded.
 *
 * ★★ NO STORE OWNS THESE, SO NO STORE'S CLEAN-UP MAY DELETE THEM. Seeding
 * copies the URL into a merchant's product and page rows, and every orphan
 * sweep would otherwise read "a URL in our bucket this store no longer uses"
 * and delete the one object a published theme — and every other store on it —
 * still renders.
 */
export const THEME_RELEASE_OBJECT_ROOT = "theme-releases/";

export function isThemeReleaseObjectPath(path: string): boolean {
  return (
    Boolean(path) &&
    path.startsWith(THEME_RELEASE_OBJECT_ROOT) &&
    !path.split("/").includes("..")
  );
}
