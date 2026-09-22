import { describe, expect, it } from "vitest";
import {
  isOtherStoreObjectPath,
  isStoreOwnedObjectPath,
  storeStoragePrefix,
  storeUploadPath,
} from "./paths";

describe("store-owned storage paths", () => {
  it("namespaces merchant uploads below the immutable store id", () => {
    expect(storeUploadPath("store-123", "product-images", "photo.webp")).toBe(
      "stores/store-123/uploads/product-images/photo.webp",
    );
    expect(storeStoragePrefix("store-123")).toBe("stores/store-123/");
  });

  it("keeps platform uploads outside every merchant prefix", () => {
    expect(storeUploadPath(null, "help-articles", "guide.webp")).toBe(
      "platform/uploads/help-articles/guide.webp",
    );
  });

  it("normalizes unsafe and empty folder segments", () => {
    expect(storeUploadPath("s1", "/blog covers//", "cover.webp")).toBe(
      "stores/s1/uploads/blogcovers/cover.webp",
    );
  });
});

// ★★ THE TWO PREDICATES ARE NOT COMPLEMENTS, AND THE GAP BETWEEN THEM IS THE
//    LEGACY NAMESPACE. `/api/upload` wrote bare paths with no store prefix
//    until 2026-08-23, so such an object is neither provably ours (a write
//    must refuse it) nor provably anyone else's (a delete may still sweep it).
describe("store object ownership", () => {
  const STORE = "store-1";
  const OTHER = "store-2";

  it("recognises this store's own object", () => {
    expect(isStoreOwnedObjectPath("stores/store-1/uploads/a.webp", STORE)).toBe(
      true,
    );
    expect(isOtherStoreObjectPath("stores/store-1/uploads/a.webp", STORE)).toBe(
      false,
    );
  });

  it("recognises another store's object", () => {
    const path = `stores/${OTHER}/uploads/victim.webp`;
    expect(isStoreOwnedObjectPath(path, STORE)).toBe(false);
    expect(isOtherStoreObjectPath(path, STORE)).toBe(true);
  });

  it("treats an unattributable legacy path as neither", () => {
    expect(isStoreOwnedObjectPath("blog-covers/old.webp", STORE)).toBe(false);
    expect(isOtherStoreObjectPath("blog-covers/old.webp", STORE)).toBe(false);
  });

  it("treats a platform object as neither", () => {
    const path = "platform/uploads/help-articles/guide.webp";
    expect(isStoreOwnedObjectPath(path, STORE)).toBe(false);
    expect(isOtherStoreObjectPath(path, STORE)).toBe(false);
  });

  // A store id that merely starts the same way must not pass as ours: the
  // trailing slash in the prefix is what stops `store-1` matching `store-10`.
  it("refuses a store id that is only a prefix of another", () => {
    const path = "stores/store-10/uploads/a.webp";
    expect(isStoreOwnedObjectPath(path, STORE)).toBe(false);
    expect(isOtherStoreObjectPath(path, STORE)).toBe(true);
  });

  it("answers false for empty inputs rather than matching everything", () => {
    expect(isStoreOwnedObjectPath("", STORE)).toBe(false);
    expect(isStoreOwnedObjectPath("stores/store-1/a.webp", "")).toBe(false);
    expect(isOtherStoreObjectPath("", STORE)).toBe(false);
  });
});
