/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  // Pulled in transitively via @/lib/site, which wraps reads in
  // unstable_cache at module load.
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/seo/store-indexing", () => ({
  notifyStoreContentPublished: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getManagerIdentity: vi.fn(),
  getActingStoreId: vi.fn(async () => "a0000000-0000-4000-8000-000000000001"),
}));
// The ownership predicate resolves a URL through the real `gcsPathFromUrl`,
// so the bucket has to be deterministic here rather than read from a local
// .env that CI does not have.
vi.mock("@/lib/storage/gcs", () => ({
  GCS_PUBLIC_HOST: "storage.googleapis.com",
  gcsDeletePaths: vi.fn(async () => []),
  gcsPathFromUrl: (url: string) => {
    const m = /storage\.googleapis\.com\/[^/]+\/(.+)$/.exec(url || "");
    return m ? m[1] : null;
  },
}));
vi.mock("@/lib/storage/cleanup", () => ({
  deleteStorageUrls: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("fs/promises", () => {
  const readFile = vi.fn().mockResolvedValue("");
  return { readFile, default: { readFile } };
});
// The AI path: per-store brand soul + plan-capped quota + Gemini.
vi.mock("@/lib/ai/brand-voice", () => ({
  getBrandSoulForStore: vi.fn(async () => "brand soul"),
}));
vi.mock("@/lib/ai/quota", () => ({
  consumeAiQuota: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/ai/gemini", () => ({
  callGemini: vi.fn(async () => ({ text: "A lovely description." })),
  brandSystemText: vi.fn((b: string) => b),
}));
vi.mock("@/lib/analytics/store-entitlement", () => ({
  storeHasAnalyticsFeature: vi.fn(async () => true),
}));
vi.mock("@/lib/plans/entitlements", () => ({
  assertCanCreateProduct: vi.fn(async () => undefined),
  PlanEntitlementError: class PlanEntitlementError extends Error {},
}));

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  // Promise.resolve() assimilates the thenable query steps into real
  // promises, so the action's .catch() calls work like production.
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  createProduct,
  updateProduct,
  deleteProduct,
  toggleProductPublish,
  generateProductDescription,
  bulkToggleProductPublish,
  bulkSetProductFeatured,
  bulkDeleteProducts,
} from "./product-actions";
import { getManagerIdentity } from "@/app/dashboard/lib/access";
import { deleteStorageUrls } from "@/lib/storage/cleanup";
import { getBrandSoulForStore } from "@/lib/ai/brand-voice";
import { consumeAiQuota } from "@/lib/ai/quota";
import { callGemini } from "@/lib/ai/gemini";
import { after } from "next/server";

const validForm = {
  name: "Almonds",
  slug: "",
  description: "Crunchy snack",
  category_id: "cat-1",
  base_price: 500,
  selling_price: 400,
  image_url: "https://x.com/object/public/media/img.png",
  images: [],
  status: "draft" as const,
  featured: false,
  sort_order: 0,
  card_color: "#fff",
  seo_title: "Almonds — WholeSip",
  seo_description: "Real, raw almonds.",
  variants: [],
};

const smallVariant = {
  name: "Small",
  base_price: 100,
  selling_price: 80,
  special_price: null,
  stock: 10,
  sku: "SM",
  images: [],
};

// product-actions.ts is the catalog's biggest action file. Tests cover
// validation, variant replacement, storage cleanup, publish toggling, and the
// Gemini-backed AI description endpoint. All writes run through withUser
// (RLS-enforced).
describe("product-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({
      returning: [{ id: "p1", slug: "almonds" }],
    });
    vi.mocked(getManagerIdentity).mockResolvedValue({
      uid: "user-1",
      email: "admin@example.com",
    });
  });

  describe("bulk operations", () => {
    it("bulkToggleProductPublish rejects when not authorised", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const r = await bulkToggleProductPublish(["p1"], true);
      expect(r.error).toMatch(/not authenticated/i);
    });

    it("bulkToggleProductPublish rejects an empty selection", async () => {
      const r = await bulkToggleProductPublish([], true);
      expect(r.error).toMatch(/nothing selected/i);
    });

    it("bulkToggleProductPublish publishes the selected ids", async () => {
      const r = await bulkToggleProductPublish(["p1", "p2"], true);
      expect(r.success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toMatchObject({
        status: "published",
      });
      expect(dbHolder.current.calls.set[0].publishedAt).toBeTruthy();
      expect(dbHolder.current.calls.where).toHaveLength(1);
      // Bulk publish used to be the only product publishing path that never
      // launched the store or scheduled search-engine discovery.
      expect(after).toHaveBeenCalled();
    });

    it("bulkToggleProductPublish unpublishes (clears published_at)", async () => {
      await bulkToggleProductPublish(["p1"], false);
      expect(dbHolder.current.calls.set[0]).toMatchObject({
        status: "draft",
        publishedAt: null,
      });
    });

    it("bulkSetProductFeatured sets the featured flag", async () => {
      const r = await bulkSetProductFeatured(["p1"], true);
      expect(r.success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toMatchObject({ featured: true });
    });

    it("bulkDeleteProducts deletes the ids and cleans up storage", async () => {
      const r = await bulkDeleteProducts(["p1", "p2"]);
      expect(r.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(deleteStorageUrls).toHaveBeenCalled();
    });

    it("bulkDeleteProducts surfaces a DB error", async () => {
      dbHolder.current.db.delete = vi.fn(() => {
        throw new Error("boom");
      });
      const r = await bulkDeleteProducts(["p1"]);
      expect(r.error).toBe("boom");
    });
  });

  describe("createProduct", () => {
    // Auth gate — products.manage permission required.
    it("rejects when caller lacks products.manage", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await createProduct(validForm);
      expect(result.error).toMatch(/not authenticated/i);
    });

    // Required-field validation — verifies each required field individually so
    // a regression to the validator surfaces clearly.
    it("requires name", async () => {
      const result = await createProduct({ ...validForm, name: " " });
      expect(result.error).toMatch(/name is required/i);
    });

    it("requires a category", async () => {
      const result = await createProduct({ ...validForm, category_id: null });
      expect(result.error).toMatch(/category is required/i);
    });

    it("requires a description", async () => {
      const result = await createProduct({ ...validForm, description: " " });
      expect(result.error).toMatch(/description is required/i);
    });

    it("requires both SEO fields", async () => {
      expect(
        (await createProduct({ ...validForm, seo_title: " " })).error,
      ).toMatch(/SEO/);
      expect(
        (await createProduct({ ...validForm, seo_description: " " })).error,
      ).toMatch(/SEO/);
    });

    // Publishing now stamps published_at; drafts leave it null.
    it("sets published_at when status is published", async () => {
      await createProduct({ ...validForm, status: "published" });
      expect(dbHolder.current.calls.values[0].publishedAt).not.toBeNull();
    });

    it("leaves published_at null when status is draft", async () => {
      await createProduct({ ...validForm, status: "draft" });
      expect(dbHolder.current.calls.values[0].publishedAt).toBeNull();
    });

    it("preserves an explicit zero unit cost", async () => {
      await createProduct({ ...validForm, cost_price: 0 });
      expect(dbHolder.current.calls.values[0].costPrice).toBe(0);
    });

    // Pricing normalisation: when selling > base, selling is clamped to base.
    it("clamps selling_price so it never exceeds base_price", async () => {
      await createProduct({
        ...validForm,
        base_price: 100,
        selling_price: 200,
      });
      expect(dbHolder.current.calls.values[0].sellingPrice).toBe(100);
    });

    // Variant reconcile path — verifies that after the product row succeeds,
    // the reconcile fetches existing variant ids, then inserts the new rows.
    // Selects: #1 resolveSlug, #2 existing variant ids.
    it("reconciles variants after product is created", async () => {
      await createProduct({ ...validForm, variants: [smallVariant] });
      expect(dbHolder.current.calls.select).toHaveLength(2);
      // values[0] = the product row, values[1] = the variant insert batch.
      expect(dbHolder.current.calls.values[1]).toHaveLength(1);
      expect(dbHolder.current.calls.values[1][0]).toMatchObject({
        name: "Small",
        productId: "p1",
        storeId: "a0000000-0000-4000-8000-000000000001",
      });
    });

    // Variants without a name are filtered out — they're rows the user added
    // but never filled in.
    it("filters out variants with empty names", async () => {
      await createProduct({
        ...validForm,
        variants: [
          { ...smallVariant, name: "", stock: 1, sku: "" },
          { ...smallVariant, name: "Medium", stock: 1, sku: "" },
        ],
      });
      const inserted = dbHolder.current.calls.values[1];
      expect(inserted).toHaveLength(1);
      expect(inserted[0].name).toBe("Medium");
    });

    // sanitizeVariants persists special_price when set, and clamps against
    // base_price so a typo of "1000" on a ₹100 item still saves as ₹100.
    it("persists special_price and clamps it to base_price", async () => {
      await createProduct({
        ...validForm,
        variants: [
          { ...smallVariant, name: "500ml", special_price: 1000, stock: 1 },
        ],
      });
      expect(dbHolder.current.calls.values[1][0].specialPrice).toBe(100);
    });

    // special_price null / 0 means "no sale" — must persist as NULL, not 0,
    // so the storefront's `hasSpecialPrice` check stays accurate.
    it("stores null when special_price is 0 or null", async () => {
      await createProduct({
        ...validForm,
        variants: [
          { ...smallVariant, name: "A", special_price: 0, stock: 1 },
          { ...smallVariant, name: "B", special_price: null, stock: 1 },
        ],
      });
      const inserted = dbHolder.current.calls.values[1];
      expect(inserted[0].specialPrice).toBeNull();
      expect(inserted[1].specialPrice).toBeNull();
    });

    // Reconcile preserves variant id through sanitizeVariants.
    it("preserves variant id for existing variants in reconcile", async () => {
      // Simulate editing a product that has existing variants.
      dbHolder.current = makeDbMock({
        returning: [{ id: "p1", slug: "almonds" }],
        selectQueue: [[], [{ id: "v-existing" }]],
      });
      await createProduct({
        ...validForm,
        variants: [
          { ...smallVariant, id: "v-existing", name: "Existing", stock: 5 },
        ],
      });
      // Should have issued an update (not insert) for the existing variant,
      // and the update must NOT include 'stock' (stock is never overwritten)
      // or 'id'.
      const updateArg = dbHolder.current.calls.set[0];
      expect(updateArg).not.toHaveProperty("stock");
      expect(updateArg).not.toHaveProperty("id");
      expect(updateArg.name).toBe("Existing");
    });
  });

  describe("option axes", () => {
    const options = [
      { name: "Size", values: ["S", "M"] },
      { name: "Colour", values: ["Black"], swatches: { Black: "#111111" } },
    ];

    it("stores the options and composes every variant's name from its values", async () => {
      await createProduct({
        ...validForm,
        options,
        variants: [
          // The browser's name is ignored: the server derives it.
          { ...smallVariant, name: "whatever", option_values: ["s", "black"] },
          { ...smallVariant, name: "M", option_values: ["M", "Black"] },
        ],
      });
      expect(dbHolder.current.calls.values[0].options).toEqual(options);
      const inserted = dbHolder.current.calls.values[1];
      expect(inserted.map((v: { name: string }) => v.name)).toEqual([
        "S / Black",
        "M / Black",
      ]);
      expect(inserted[0].optionValues).toEqual(["S", "Black"]);
    });

    it("refuses an incomplete or duplicate combination before writing anything", async () => {
      const incomplete = await createProduct({
        ...validForm,
        options,
        variants: [{ ...smallVariant, option_values: ["S"] }],
      });
      expect(incomplete.error).toMatch(/needs a value for every option/);
      const duplicate = await updateProduct("p1", {
        ...validForm,
        options,
        variants: [
          { ...smallVariant, option_values: ["S", "Black"] },
          { ...smallVariant, option_values: ["s", "BLACK"] },
        ],
      });
      expect(duplicate.error).toBe('Two variants are both "S / Black".');
      expect(dbHolder.current.calls.values).toHaveLength(0);
      expect(dbHolder.current.calls.set).toHaveLength(0);
    });

    it("refuses options with no variants generated", async () => {
      const out = await createProduct({ ...validForm, options, variants: [] });
      expect(out.error).toMatch(/Generate the variants/);
    });

    it("keeps plain named variants untouched when there are no options", async () => {
      await createProduct({ ...validForm, variants: [smallVariant] });
      expect(dbHolder.current.calls.values[0].options).toEqual([]);
      expect(dbHolder.current.calls.values[1][0]).toMatchObject({
        name: "Small",
        optionValues: [],
      });
    });
  });

  describe("updateProduct", () => {
    // Auth gate.
    it("rejects unauthorised callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await updateProduct("p1", validForm);
      expect(result.error).toMatch(/not authenticated/i);
    });

    // published_at is preserved on re-save of a published product (so the
    // original publish timestamp doesn't get reset to "now" on every edit).
    // Selects: #1 resolveSlug, #2 the current row's published_at, then the
    // image-URL prefetches.
    it("preserves existing published_at on update", async () => {
      const original = "2025-01-01T00:00:00.000Z";
      dbHolder.current = makeDbMock({
        selectQueue: [[], [{ published_at: original }]],
      });
      await updateProduct("p1", { ...validForm, status: "published" });
      expect(dbHolder.current.calls.set[0].publishedAt).toBe(original);
    });

    it("refuses a product outside the acting store before any write", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[], []] });
      const result = await updateProduct("foreign-product", validForm);
      expect(result.error).toMatch(/product not found/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("backfills an explicit zero cost without converting it to unknown", async () => {
      dbHolder.current = makeDbMock({
        returning: [{ id: "p1" }],
        selectQueue: [[], [{ published_at: null }], [], [], [], [], []],
      });
      const result = await updateProduct("p1", {
        ...validForm,
        cost_price: 0,
      });
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.set[0].costPrice).toBe(0);
      expect(dbHolder.current.calls.set).toContainEqual({ unitCost: 0 });
    });
  });

  describe("deleteProduct", () => {
    // Auth gate.
    it("rejects unauthorised callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await deleteProduct("p1");
      expect(result.error).toMatch(/not authenticated/i);
    });

    // Storage cleanup is fire-and-forget — verifies it's called with the
    // image URLs gathered before the delete.
    // Selects: #1 the product's images, #2 its variants' images.
    it("purges referenced image files after deleting the row", async () => {
      const url = "https://x.com/object/public/media/p.png";
      dbHolder.current = makeDbMock({
        selectQueue: [[{ image_url: url, images: [] }], []],
      });
      const result = await deleteProduct("p1");
      expect(result.success).toBe(true);
      expect(deleteStorageUrls).toHaveBeenCalled();
      const arg = (deleteStorageUrls as any).mock.calls[0][0];
      expect(arg).toContain(url);
    });
  });

  describe("toggleProductPublish", () => {
    // Auth gate.
    it("rejects unauthorised callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await toggleProductPublish("p1", true);
      expect(result.error).toMatch(/not authenticated/i);
    });

    // Publishing flips status + sets published_at.
    it("publishes (status=published, sets published_at)", async () => {
      dbHolder.current = makeDbMock({ returning: [{ slug: "almonds" }] });
      const result = await toggleProductPublish("p1", true);
      expect(result.success).toBe(true);
      const updateArg = dbHolder.current.calls.set[0];
      expect(updateArg.status).toBe("published");
      expect(updateArg.publishedAt).not.toBeNull();
    });

    // Unpublishing clears published_at — keeps the published_at semantically
    // "last time we went live".
    it("unpublishes (status=draft, clears published_at)", async () => {
      dbHolder.current = makeDbMock({ returning: [{ slug: "almonds" }] });
      await toggleProductPublish("p1", false);
      const updateArg = dbHolder.current.calls.set[0];
      expect(updateArg.status).toBe("draft");
      expect(updateArg.publishedAt).toBeNull();
    });

    // No matching row (RLS or already deleted) → a friendly error.
    it("errors when the product is not found", async () => {
      dbHolder.current = makeDbMock({ returning: [] });
      const result = await toggleProductPublish("p1", true);
      expect(result.error).toMatch(/not found/i);
    });
  });

  // The AI description endpoint — input guards, the plan-capped quota gate,
  // and the per-store brand soul feeding the prompt.
  describe("generateProductDescription", () => {
    // Auth gate.
    it("rejects unauthorised callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await generateProductDescription({ name: "x" });
      expect(result.error).toMatch(/not authenticated/i);
    });

    // The model needs a name to anchor the copy — bail before any work.
    it("rejects when product name is missing", async () => {
      const result = await generateProductDescription({ name: "  " });
      expect(result.error).toMatch(/product name/i);
      expect(consumeAiQuota).not.toHaveBeenCalled(); // never burns a credit
    });

    // The quota gate runs BEFORE Gemini — a blocked store spends nothing.
    it("blocks the generation when the monthly AI quota is spent", async () => {
      vi.mocked(consumeAiQuota).mockResolvedValueOnce({
        allowed: false,
        error: "You've used all 10 AI generations…",
      });
      const result = await generateProductDescription({ name: "Almonds" });
      expect(result.error).toMatch(/AI generations/i);
      expect(callGemini).not.toHaveBeenCalled();
    });

    // Happy path: speaks in the STORE's brand soul (per-store, never null —
    // stores without a saved guide get the generic default).
    it("generates using the store's own brand soul", async () => {
      const result = await generateProductDescription({ name: "Almonds" });
      expect(result.description).toBe("A lovely description.");
      expect(getBrandSoulForStore).toHaveBeenCalledWith(
        "a0000000-0000-4000-8000-000000000001",
      );
    });
  });
});

// ★★ THE SHARED BUCKET MAKES AN IN-BUCKET URL NOT OWNERSHIP, and the sweep
//    resolves any in-bucket URL to a path with no tenant predicate — so a row
//    pointing at another store's object destroys THEIR file when the product
//    is re-saved or deleted.
describe("product image ownership", () => {
  const STORE_ID = "a0000000-0000-4000-8000-000000000001";
  const own = `https://storage.googleapis.com/bkt/stores/${STORE_ID}/uploads/mine.webp`;
  const foreign =
    "https://storage.googleapis.com/bkt/stores/b0000000-0000-4000-8000-0000000000ff/uploads/victim.webp";
  const legacy = "https://storage.googleapis.com/bkt/product-images/old.webp";

  beforeEach(() => {
    vi.mocked(getManagerIdentity).mockResolvedValue({
      uid: "user-1",
      email: "admin@example.com",
    });
  });

  it("createProduct refuses another store's primary image", async () => {
    const result = await createProduct({ ...validForm, image_url: foreign });
    expect(result.error).toMatch(/not one of this store's own images/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("createProduct refuses a foreign image hidden in the gallery", async () => {
    const result = await createProduct({
      ...validForm,
      image_url: own,
      images: [own, foreign],
    });
    expect(result.error).toMatch(/not one of this store's own images/i);
  });

  // A variant's gallery is swept exactly like the parent's, so it gets the
  // same rule — and a variant has no `image_url` of its own.
  it("createProduct refuses a foreign image on a variant", async () => {
    const result = await createProduct({
      ...validForm,
      image_url: own,
      variants: [{ ...smallVariant, images: [foreign] }],
    });
    expect(result.error).toMatch(/not one of this store's own images/i);
  });

  it("createProduct accepts this store's own images", async () => {
    const result = await createProduct({
      ...validForm,
      image_url: own,
      images: [own],
    });
    expect(result.error).toBeUndefined();
  });

  it("updateProduct refuses a newly added foreign image", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [],
        [{ published_at: null }],
        [{ image_url: own, images: [] }],
        [],
      ],
    });
    const result = await updateProduct("p1", {
      ...validForm,
      image_url: foreign,
    });
    expect(result.error).toMatch(/not one of this store's own images/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  // An image already on the row may predate store-prefixed uploads, so
  // re-judging it would make the product uneditable over a picture nobody is
  // touching.
  it("updateProduct keeps an unchanged legacy image saveable", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [],
        [{ published_at: null }],
        [{ image_url: legacy, images: [] }],
        [],
      ],
    });
    const result = await updateProduct("p1", {
      ...validForm,
      name: "Renamed",
      image_url: legacy,
    });
    expect(result.error).toBeUndefined();
  });

  it("scopes the delete sweep to this store", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ image_url: own, images: [] }], []],
    });
    await deleteProduct("p1");
    expect(deleteStorageUrls).toHaveBeenCalledWith(expect.any(Array), {
      ownedByStoreId: STORE_ID,
    });
  });
});
