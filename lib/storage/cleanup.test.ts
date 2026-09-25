import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the GCS side so we can assert routing without the SDK. gcsPathFromUrl
// mirrors the real parser; gcsDeletePaths is a spy.
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/storage/gcs", () => ({
  GCS_PUBLIC_HOST: "storage.googleapis.com",
  gcsPathFromUrl: (url: string) => {
    const m = /storage\.googleapis\.com\/[^/]+\/(.+)$/.exec(url || "");
    return m ? m[1] : null;
  },
  // ★ `vi.fn(impl)`, NOT `vi.fn().mockResolvedValue([])`. Under the config's
  //   `mockReset: true` the second form is WIPED between tests (the reset
  //   restores the implementation a mock was CREATED with, and that one was
  //   created with none), so every test after the first would see `undefined`
  //   where it expects a promise. The first form survives.
  gcsDeletePaths: vi.fn(async () => [] as string[]),
}));

import { extractMediaUrlsFromHtml, deleteStorageUrls } from "./cleanup";
import { gcsDeletePaths } from "@/lib/storage/gcs";

// cleanup.ts — keeps Google Cloud Storage in sync with the DB. The pure helper
// is easy to test; deleteStorageUrls() is best-effort, so we verify it dedupes,
// ignores non-GCS URLs, and never throws.
describe("extractMediaUrlsFromHtml", () => {
  it("returns [] for null / undefined / empty", () => {
    expect(extractMediaUrlsFromHtml(null)).toEqual([]);
    expect(extractMediaUrlsFromHtml(undefined)).toEqual([]);
    expect(extractMediaUrlsFromHtml("")).toEqual([]);
  });

  // GCS public URLs are the managed media backend.
  it("extracts unique Google Cloud Storage public URLs", () => {
    const html = `
      <img src="https://storage.googleapis.com/storemink-media/blog/a.webp" />
      <img src="https://storage.googleapis.com/storemink-media/blog/nested/b.webp" />
      <img src="https://storage.googleapis.com/storemink-media/blog/a.webp" />
    `;
    expect(extractMediaUrlsFromHtml(html).sort()).toEqual([
      "https://storage.googleapis.com/storemink-media/blog/a.webp",
      "https://storage.googleapis.com/storemink-media/blog/nested/b.webp",
    ]);
  });

  // Non-GCS URLs (external CDNs, legacy Supabase) are ignored — we only manage
  // our own GCS bucket now.
  it("ignores non-GCS URLs (external + legacy Supabase)", () => {
    const html = `
      <img src="https://cdn.other.com/img.png" />
      <img src="https://x.example.com/storage/v1/object/public/media/s.png" />
    `;
    expect(extractMediaUrlsFromHtml(html)).toEqual([]);
  });
});

describe("deleteStorageUrls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does nothing when given empty / nullish urls", async () => {
    await expect(deleteStorageUrls([null, undefined, ""])).resolves.toEqual({
      attempted: 0,
      failed: 0,
      unmanaged: 0,
      foreign: 0,
      shared: 0,
    });
    expect(gcsDeletePaths).not.toHaveBeenCalled();
  });

  // Non-GCS URLs (external + legacy Supabase) are filtered out.
  it("ignores non-GCS URLs", async () => {
    await expect(
      deleteStorageUrls([
        "https://cdn.other.com/x.png",
        "https://x.example.com/storage/v1/object/public/media/s.png",
      ]),
    ).resolves.toEqual({
      attempted: 0,
      failed: 0,
      unmanaged: 2,
      foreign: 0,
      shared: 0,
    });
    expect(gcsDeletePaths).not.toHaveBeenCalled();
  });

  // Duplicate URLs are deduped so gcsDeletePaths gets each path once.
  it("dedupes GCS paths before deleting", async () => {
    const url = "https://storage.googleapis.com/bkt/dup.webp";
    await expect(deleteStorageUrls([url, url, url])).resolves.toEqual({
      attempted: 1,
      failed: 0,
      unmanaged: 0,
      foreign: 0,
      shared: 0,
    });
    expect(gcsDeletePaths).toHaveBeenCalledWith(["dup.webp"]);
  });

  // A thrown error inside gcsDeletePaths must NOT propagate — the surrounding
  // DB write must still succeed (cleanup is best-effort).
  it("never throws when gcsDeletePaths rejects", async () => {
    vi.mocked(gcsDeletePaths).mockRejectedValueOnce(new Error("network"));
    await expect(
      deleteStorageUrls(["https://storage.googleapis.com/bkt/x.webp"]),
    ).resolves.toEqual({
      attempted: 1,
      failed: 1,
      unmanaged: 0,
      foreign: 0,
      shared: 0,
    });
  });
});

// ★★ THE SWEEP IS WHERE CROSS-TENANT DATA LOSS ACTUALLY HAPPENS: it resolves
//    any in-bucket URL to a path with no tenant predicate, so a row holding
//    another store's URL destroys that merchant's object on the next clean-up.
describe("deleteStorageUrls tenant scope", () => {
  const STORE = "a0000000-0000-4000-8000-000000000001";
  const OTHER = "b0000000-0000-4000-8000-0000000000ff";
  const url = (p: string) => `https://storage.googleapis.com/bkt/${p}`;

  beforeEach(() => {
    vi.mocked(gcsDeletePaths).mockClear();
  });

  it("refuses an object owned by another store and reports it", async () => {
    const result = await deleteStorageUrls(
      [url(`stores/${OTHER}/uploads/victim.webp`)],
      { ownedByStoreId: STORE },
    );
    expect(gcsDeletePaths).not.toHaveBeenCalled();
    expect(result).toMatchObject({ attempted: 0, foreign: 1 });
  });

  it("still deletes this store's own object", async () => {
    await deleteStorageUrls([url(`stores/${STORE}/uploads/mine.webp`)], {
      ownedByStoreId: STORE,
    });
    expect(gcsDeletePaths).toHaveBeenCalledWith([
      `stores/${STORE}/uploads/mine.webp`,
    ]);
  });

  // ★ "PROVABLY THEIRS", NOT "NOT PROVABLY OURS". Objects uploaded before
  //   2026-08-23 have no store prefix and belong to no store's namespace;
  //   skipping those would silently leak every legacy orphan instead.
  it("still deletes an unattributable legacy object", async () => {
    await deleteStorageUrls([url("blog-covers/old.webp")], {
      ownedByStoreId: STORE,
    });
    expect(gcsDeletePaths).toHaveBeenCalledWith(["blog-covers/old.webp"]);
  });

  // The platform store purge and the Help console delete outside one store's
  // prefix on purpose, so an omitted option must not narrow anything.
  it("applies no scope when none is given", async () => {
    await deleteStorageUrls([url(`stores/${OTHER}/uploads/victim.webp`)]);
    expect(gcsDeletePaths).toHaveBeenCalledWith([
      `stores/${OTHER}/uploads/victim.webp`,
    ]);
  });

  it("separates a foreign object from an unmanaged one", async () => {
    const result = await deleteStorageUrls(
      [
        url(`stores/${OTHER}/a.webp`),
        "https://xyz.supabase.co/storage/v1/object/public/media/b.webp",
        url(`stores/${STORE}/c.webp`),
      ],
      { ownedByStoreId: STORE },
    );
    expect(result).toMatchObject({ attempted: 1, foreign: 1, unmanaged: 1 });
  });
});

// ★★ A published theme's images are shared by every store it seeded, so no
//    clean-up — scoped or not — may delete one as its own orphan.
describe("deleteStorageUrls and published theme images", () => {
  const url = (p: string) => `https://storage.googleapis.com/bkt/${p}`;
  const shared = "theme-releases/linen/1.0.0/hero-0123456789abcdef.webp";

  beforeEach(() => {
    vi.mocked(gcsDeletePaths).mockClear();
  });

  it("never deletes one, even with no tenant scope", async () => {
    const result = await deleteStorageUrls([url(shared)]);
    expect(gcsDeletePaths).not.toHaveBeenCalled();
    expect(result).toMatchObject({ attempted: 0, shared: 1 });
  });

  it("still deletes the store's own objects beside it", async () => {
    const store = "a0000000-0000-4000-8000-000000000001";
    const result = await deleteStorageUrls(
      [url(shared), url(`stores/${store}/uploads/mine.webp`)],
      { ownedByStoreId: store },
    );
    expect(gcsDeletePaths).toHaveBeenCalledWith([
      `stores/${store}/uploads/mine.webp`,
    ]);
    expect(result).toMatchObject({ attempted: 1, shared: 1 });
  });
});
