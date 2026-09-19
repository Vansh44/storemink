import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { MinkActorContext } from "./types";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((run: (db: unknown) => unknown) =>
    run({ execute: mocks.execute }),
  ),
}));

import {
  readMinkStorefrontMedia,
  readOwnedStorefrontImageUrls,
} from "./storefront-media-read";

const ACTOR: MinkActorContext = {
  storeId: "store-1",
  adminId: "admin-1",
  email: "owner@example.com",
  roleSlug: "designer",
  permissions: { media: ["view"] },
  isSuperadmin: false,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request-1",
  runId: "run-1",
  draftingEnabled: false,
};

function row(n: number) {
  return {
    id: `id-${n}`,
    url: `https://storage.googleapis.com/b/stores/store-1/media/${n}.webp`,
    filename: `photo-${n}.jpg`,
    content_type: "image/webp",
    size_bytes: 2048,
    created_at: "2026-09-12 10:00:00+00",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockResolvedValue({ rows: [row(1), row(2)] });
});

describe("Phase 9D media library read", () => {
  it("returns the exact URLs a proposal must echo, scoped to the trusted store", async () => {
    const result = await readMinkStorefrontMedia(ACTOR);
    expect(result.media).toHaveLength(2);
    expect(result.media[0]).toMatchObject({
      mediaId: "id-1",
      url: row(1).url,
      filename: "photo-1.jpg",
      sizeBytes: 2048,
    });
    expect(result.scope).toBe("current_store");
    expect(result.contentTrust).toBe("untrusted_storefront_data");
    expect(result.usage).toContain(
      "catalogue image returned by search_products",
    );

    const compiled = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]);
    expect(compiled.params).toContain("store-1");
    expect(compiled.sql).not.toContain("store-1");
  });

  it("requires the media permission, not the builder one", async () => {
    await expect(
      readMinkStorefrontMedia({
        ...ACTOR,
        permissions: { builder: ["view", "manage"] },
      }),
    ).rejects.toThrow("Media view permission");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("bounds the list and reports that it was truncated", async () => {
    mocks.execute.mockResolvedValue({
      rows: Array.from({ length: 41 }, (_, i) => row(i)),
    });
    const result = await readMinkStorefrontMedia(ACTOR);
    expect(result.media).toHaveLength(40);
    expect(result.truncated).toBe(true);
  });

  it("clamps a model-supplied limit rather than trusting it", async () => {
    await readMinkStorefrontMedia(ACTOR, { limit: 5000 });
    const compiled = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]);
    // 40 + 1, the one extra row that answers "is there more?".
    expect(compiled.params).toContain(41);
    await readMinkStorefrontMedia(ACTOR, { limit: "nonsense" });
    const second = new PgDialect().sqlToQuery(mocks.execute.mock.calls[1][0]);
    expect(second.params).toContain(41);
  });

  it("can find an older named image with a bounded filename search", async () => {
    const result = await readMinkStorefrontMedia(ACTOR, {
      query: "Summer_50% hero",
      limit: 10,
    });
    const compiled = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]);
    expect(compiled.params).toContain("%Summer\\_50\\% hero%");
    expect(compiled.params).toContain(11);
    expect(compiled.sql).toContain("filename ilike");
    expect(result.query).toBe("Summer_50% hero");
  });

  it("bounds a filename, which is untrusted merchant text", async () => {
    mocks.execute.mockResolvedValue({
      rows: [{ ...row(1), filename: "f".repeat(500) }],
    });
    const result = await readMinkStorefrontMedia(ACTOR);
    expect(result.media[0].filename).toHaveLength(160);
  });
});

describe("Phase 9D ownership membership", () => {
  it("asks about the candidates rather than listing the whole library", async () => {
    mocks.execute.mockResolvedValue({ rows: [{ url: row(1).url }] });
    const owned = await readOwnedStorefrontImageUrls("store-1", [
      row(1).url,
      row(2).url,
      row(1).url,
    ]);
    expect([...owned]).toEqual([row(1).url]);
    const compiled = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]);
    // Deduplicated, and bound as one array parameter, never interpolated.
    expect(compiled.params).toContainEqual([row(1).url, row(2).url]);
    expect(compiled.sql).toContain('from "products"');
    expect(compiled.sql).toContain("unnest");
    expect(compiled.sql).not.toContain(row(1).url);
  });

  it("makes no query at all when nothing needs checking", async () => {
    expect([...(await readOwnedStorefrontImageUrls("store-1", []))]).toEqual(
      [],
    );
    expect([
      ...(await readOwnedStorefrontImageUrls("store-1", ["   "])),
    ]).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
