import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage/gcs", () => ({
  gcsPathFromUrl: (url: string) => {
    const m = /^https:\/\/storage\.googleapis\.com\/bkt\/(.+)$/.exec(url || "");
    return m ? m[1] : null;
  },
}));

import { firstForeignStoreImageUrl, isForeignStoreImageUrl } from "./ownership";

const STORE = "store-1";
const OTHER = "store-2";
const own = `https://storage.googleapis.com/bkt/stores/${STORE}/a.webp`;
const foreign = `https://storage.googleapis.com/bkt/stores/${OTHER}/a.webp`;
const legacy = "https://storage.googleapis.com/bkt/blog-covers/old.webp";
const external = "https://xyz.supabase.co/storage/v1/object/public/m/a.webp";

describe("isForeignStoreImageUrl", () => {
  it("accepts this store's own object", () => {
    expect(isForeignStoreImageUrl(STORE, own)).toBe(false);
  });

  it("refuses another store's object in the same bucket", () => {
    expect(isForeignStoreImageUrl(STORE, foreign)).toBe(true);
  });

  // Unattributable: uploaded before store-prefixed paths existed. A WRITE must
  // refuse it (we cannot show it is ours) even though a DELETE may sweep it.
  it("refuses an unattributable legacy object", () => {
    expect(isForeignStoreImageUrl(STORE, legacy)).toBe(true);
  });

  // ★ Outside our bucket is NOT this rule's business: `deleteStorageUrls`
  //   cannot resolve it to a path, and refusing it would break the legacy
  //   Supabase-hosted media that still serves.
  it("allows a URL outside our bucket", () => {
    expect(isForeignStoreImageUrl(STORE, external)).toBe(false);
  });

  it("treats blank input and a missing store as not foreign", () => {
    expect(isForeignStoreImageUrl(STORE, "")).toBe(false);
    expect(isForeignStoreImageUrl(STORE, "   ")).toBe(false);
    expect(isForeignStoreImageUrl("", foreign)).toBe(false);
  });
});

describe("firstForeignStoreImageUrl", () => {
  it("returns the first offender, not merely a boolean", () => {
    expect(firstForeignStoreImageUrl(STORE, [own, foreign, legacy])).toBe(
      foreign,
    );
  });

  it("returns null when every url is acceptable", () => {
    expect(
      firstForeignStoreImageUrl(STORE, [own, external, null, undefined, ""]),
    ).toBeNull();
  });

  // The "already stored" exemption: only what a save ADDS is judged, or an
  // existing row would become uneditable over an image nobody is touching.
  it("skips values already on the row", () => {
    expect(
      firstForeignStoreImageUrl(STORE, [legacy], new Set([legacy])),
    ).toBeNull();
    expect(
      firstForeignStoreImageUrl(STORE, [legacy, foreign], new Set([legacy])),
    ).toBe(foreign);
  });

  it("matches the skip set after trimming", () => {
    expect(
      firstForeignStoreImageUrl(STORE, [`  ${legacy}  `], new Set([legacy])),
    ).toBeNull();
  });
});
