import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MinkActorContext } from "./types";

const rows = vi.hoisted(() => ({ current: [] as Record<string, unknown>[] }));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (operation: (db: unknown) => unknown) =>
    operation({ execute: vi.fn(async () => ({ rows: rows.current })) }),
  ),
}));
vi.mock("@/lib/storage/gcs", () => ({
  GCS_BUCKET_NAME: "storemink-media",
  gcsPathFromUrl: (url: string) => {
    const prefix = "https://storage.googleapis.com/storemink-media/";
    return url.startsWith(prefix) ? url.slice(prefix.length) : null;
  },
}));

import { resolveMinkMediaReferenceImages } from "./media-reference-images";

const ACTOR = {
  storeId: "store-1",
  adminId: "admin-1",
  isSuperadmin: false,
  permissions: {
    media: ["view"],
    products: ["view"],
    categories: ["view"],
  },
} as unknown as MinkActorContext;

const PRODUCT =
  "https://storage.googleapis.com/storemink-media/stores/store-1/uploads/product-images/milk.webp";
const CATEGORY =
  "https://storage.googleapis.com/storemink-media/stores/store-1/uploads/category-images/dairy.png";

describe("Mink image-generation references", () => {
  beforeEach(() => {
    rows.current = [];
  });

  it("preserves the model-selected order and converts owned images to GCS parts", async () => {
    rows.current = [
      { url: PRODUCT, source: "product", content_type: null },
      { url: CATEGORY, source: "category", content_type: null },
    ];

    await expect(
      resolveMinkMediaReferenceImages(ACTOR, [CATEGORY, PRODUCT]),
    ).resolves.toEqual([
      {
        url: CATEGORY,
        fileUri:
          "gs://storemink-media/stores/store-1/uploads/category-images/dairy.png",
        mimeType: "image/png",
        source: "category",
      },
      {
        url: PRODUCT,
        fileUri:
          "gs://storemink-media/stores/store-1/uploads/product-images/milk.webp",
        mimeType: "image/webp",
        source: "product",
      },
    ]);
  });

  it("refuses URLs that no accessible current-store collection returned", async () => {
    await expect(
      resolveMinkMediaReferenceImages(ACTOR, [PRODUCT]),
    ).rejects.toThrow(/exact, accessible URL/);
  });

  it("refuses a database URL outside the configured media bucket", async () => {
    const external = "https://cdn.example.com/product.jpg";
    rows.current = [
      { url: external, source: "product", content_type: "image/jpeg" },
    ];
    await expect(
      resolveMinkMediaReferenceImages(ACTOR, [external]),
    ).rejects.toThrow(/supported StoreMink/);
  });
});
