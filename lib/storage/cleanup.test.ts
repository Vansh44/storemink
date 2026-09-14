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
    ).resolves.toEqual({ attempted: 0, failed: 0, unmanaged: 2 });
    expect(gcsDeletePaths).not.toHaveBeenCalled();
  });

  // Duplicate URLs are deduped so gcsDeletePaths gets each path once.
  it("dedupes GCS paths before deleting", async () => {
    const url = "https://storage.googleapis.com/bkt/dup.webp";
    await expect(deleteStorageUrls([url, url, url])).resolves.toEqual({
      attempted: 1,
      failed: 0,
      unmanaged: 0,
    });
    expect(gcsDeletePaths).toHaveBeenCalledWith(["dup.webp"]);
  });

  // A thrown error inside gcsDeletePaths must NOT propagate — the surrounding
  // DB write must still succeed (cleanup is best-effort).
  it("never throws when gcsDeletePaths rejects", async () => {
    vi.mocked(gcsDeletePaths).mockRejectedValueOnce(new Error("network"));
    await expect(
      deleteStorageUrls(["https://storage.googleapis.com/bkt/x.webp"]),
    ).resolves.toEqual({ attempted: 1, failed: 1, unmanaged: 0 });
  });
});
