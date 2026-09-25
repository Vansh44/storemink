/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

// Mock the Drizzle data layer: each with* runner invokes the callback with the
// current mock db. Promise.resolve() assimilates the thenable query steps so
// applyTheme's try/catch sees real rejections.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("./runtime-registry", () => ({
  resolveThemeDefinition: vi.fn(async (id: unknown, version?: unknown) => {
    const { getThemeDefinition } = await import("./index");
    return getThemeDefinition(id, version);
  }),
}));

import {
  categories,
  productVariants,
  products,
  storeMenus,
  storePages,
  stores,
} from "@/drizzle/schema";
import { applyTheme, applyThemeDefinition } from "./apply";
import { getThemeDefinition } from "./index";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A bespoke mock of the fragment of the Drizzle API applyTheme uses. It records
// insert/update/delete calls per table (keyed by the imported table object's
// identity) and lets a test inject a per-table failure. `.returning()` yields a
// table-appropriate row so the category→product id wiring resolves.
function makeApplyDb(opts: {
  storeSettings?: Record<string, unknown>;
  failTables?: Set<string>;
}) {
  const storeSettings = opts.storeSettings ?? {};
  const failTables = opts.failTables ?? new Set<string>();

  const calls = {
    insert: {} as Record<string, any[]>,
    update: {} as Record<string, any[]>,
    delete: {} as Record<string, number>,
    onConflict: {} as Record<string, any[]>,
  };

  const nameOf = (t: any) =>
    t === stores
      ? "stores"
      : t === categories
        ? "categories"
        : t === products
          ? "products"
          : t === productVariants
            ? "product_variants"
            : t === storeMenus
              ? "store_menus"
              : t === storePages
                ? "store_pages"
                : "unknown";

  const returningFor = (name: string) =>
    name === "categories"
      ? [{ id: "cat-1", slug: "pantry" }]
      : name === "products"
        ? [{ id: "prod-1" }]
        : [];

  const fails = (name: string) => failTables.has(name);
  const settle = (name: string, result: any) =>
    fails(name)
      ? Promise.reject(new Error(`${name} down`))
      : Promise.resolve(result);

  const insertStep = (name: string): any => ({
    onConflictDoUpdate: vi.fn((c: any) => {
      (calls.onConflict[name] ??= []).push(c);
      return insertStep(name);
    }),
    onConflictDoNothing: vi.fn(() => insertStep(name)),
    returning: vi.fn(() => settle(name, returningFor(name))),
    then: (resolve: any, reject: any) =>
      settle(name, returningFor(name)).then(resolve, reject),
  });

  const whereStep = (name: string, result: any): any => ({
    where: vi.fn(() => ({
      then: (resolve: any, reject: any) =>
        settle(name, result).then(resolve, reject),
    })),
  });

  const db = {
    select: vi.fn(() => {
      const s: any = {
        from: vi.fn(() => s),
        where: vi.fn(() => s),
        limit: vi.fn(() => s),
        then: (resolve: any, reject: any) =>
          Promise.resolve([{ settings: storeSettings }]).then(resolve, reject),
      };
      return s;
    }),
    insert: vi.fn((t: any) => {
      const name = nameOf(t);
      return {
        values: vi.fn((v: any) => {
          (calls.insert[name] ??= []).push(v);
          return insertStep(name);
        }),
      };
    }),
    update: vi.fn((t: any) => {
      const name = nameOf(t);
      return {
        set: vi.fn((v: any) => {
          (calls.update[name] ??= []).push(v);
          return whereStep(name, { rowCount: 1 });
        }),
      };
    }),
    delete: vi.fn((t: any) => {
      const name = nameOf(t);
      calls.delete[name] = (calls.delete[name] ?? 0) + 1;
      return whereStep(name, { rowCount: 1 });
    }),
  };

  return { db, calls };
}

describe("applyTheme", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeApplyDb({
      storeSettings: { brand: { name: "My Shop" } },
    });
  });

  it("merges settings without clobbering the merchant's brand name", async () => {
    await applyTheme("store-1", "basket", { publish: true });
    const update = dbHolder.current.calls.update.stores[0];
    expect(update.settings.template).toBe("basket");
    expect(update.settings.theme).toMatchObject({
      presetId: "basket",
      presetVersion: "1.0.0",
      engineId: "storefront-grocery",
      engineVersion: 1,
    });
    expect(update.settings.theme.appliedAt).toEqual(expect.any(String));
    expect(update.settings.brand.name).toBe("My Shop"); // preserved
    expect(update.settings.brand.primaryColor).toBe("#ef5a2a"); // themed
  });

  it("publishes pages with regenerated UUID section ids", async () => {
    const r = await applyTheme("store-1", "basket", { publish: true });
    expect(r.success, r.errors.join(" | ")).toBe(true);

    const pageUpserts = dbHolder.current.calls.insert.store_pages;
    // Basket seeds 4 pages incl. the homepage sentinel.
    expect(pageUpserts.map((p: any) => p.slug).sort()).toEqual([
      "",
      "delivery-returns",
      "faqs",
      "our-story",
    ]);
    for (const p of pageUpserts) {
      expect(p.status).toBe("published");
      expect(p.publishedSections).toEqual(p.sections);
      for (const s of p.sections) expect(s.id).toMatch(UUID_RE);
    }
  });

  it("seeds products with variants scoped to the store", async () => {
    await applyTheme("store-1", "basket", { publish: true });
    const productUpserts = dbHolder.current.calls.insert.products;
    expect(productUpserts.length).toBe(13); // basket sample products
    expect(productUpserts[0].storeId).toBe("store-1");

    const variantInserts = dbHolder.current.calls.insert.product_variants;
    expect(variantInserts.length).toBeGreaterThan(0);
    // Each insert receives the variants ARRAY; check the first variant of the
    // first insert.
    expect(variantInserts[0][0]).toMatchObject({
      storeId: "store-1",
      productId: "prod-1",
    });
  });

  // The sample catalogue names itself in its own copy ("Tomatoes (500 g)
  // (Sample)", "replace it with your own"). Published, every store on this
  // theme would serve the same handful of identical product pages under a
  // different subdomain — a near-duplicate cluster competing with the
  // merchant's real products. Drafts still show up in the dashboard, fully
  // written, one click from live.
  it("seeds SAMPLE products as drafts by default", async () => {
    await applyTheme("store-1", "basket", { publish: true });
    const productUpserts = dbHolder.current.calls.insert.products;
    expect(productUpserts.length).toBeGreaterThan(0);
    for (const p of productUpserts) {
      expect(p.status).toBe("draft");
      expect(p.publishedAt).toBeNull();
    }
  });

  // A demo store IS the showcase — its whole job is to look like a finished
  // shop, so there the samples must be live.
  it("publishes sample products when publishSampleProducts is set", async () => {
    await applyTheme("store-1", "basket", {
      publish: true,
      publishSampleProducts: true,
    });
    const productUpserts = dbHolder.current.calls.insert.products;
    expect(productUpserts.length).toBeGreaterThan(0);
    for (const p of productUpserts) expect(p.status).toBe("published");
    expect(productUpserts[0].publishedAt).toBeTruthy();
  });

  // A re-apply hits the conflict branch. It used to write "published"
  // unconditionally there, so re-seeding a merchant store put its draft
  // sample products live.
  it("keeps the same publish rule when a re-apply updates existing products", async () => {
    await applyTheme("store-1", "basket", { publish: true });
    const drafts = dbHolder.current.calls.onConflict.products.map(
      (c: any) => c.set,
    );
    expect(drafts.length).toBeGreaterThan(0);
    for (const set of drafts) {
      expect(set.status).toBe("draft");
      expect(set.publishedAt).toBeNull();
    }
    dbHolder.current = makeApplyDb({
      storeSettings: { brand: { name: "My Shop" } },
    });
    await applyTheme("store-1", "basket", {
      publish: true,
      publishSampleProducts: true,
    });
    for (const c of dbHolder.current.calls.onConflict.products) {
      expect(c.set.status).toBe("published");
    }
  });

  it("seeds from a definition the caller already holds", async () => {
    const theme = getThemeDefinition("basket");
    await applyThemeDefinition("store-1", theme, { publish: true });
    const settings = dbHolder.current.calls.update.stores[0].settings;
    expect(settings.theme.presetId).toBe(theme.id);
    expect(dbHolder.current.calls.insert.store_pages.length).toBe(
      theme.preset.pages.length,
    );
  });

  // Option axes seed exactly as the product editor saves them: the options on
  // the product row, positional values and a composed name on each variant.
  it("seeds a product's option axes and each variant's combination", async () => {
    const base = getThemeDefinition("basket");
    const product = base.preset.sampleData!.products[0];
    const theme = structuredClone(base);
    theme.preset.sampleData!.products = [
      {
        ...product,
        options: [
          { name: "Size", values: ["S", "M"] },
          { name: "Colour", values: ["Black"], swatches: { Black: "#111111" } },
        ],
        variants: [
          {
            name: "x",
            option_values: ["m", "black"],
            base_price: 10,
            selling_price: 9,
            stock: 2,
          },
          {
            name: "y",
            option_values: ["S", "Black"],
            base_price: 10,
            selling_price: 9,
            stock: 2,
          },
        ],
      },
    ];
    const result = await applyThemeDefinition("store-1", theme, {
      publish: true,
    });
    expect(result.errors).toEqual([]);
    expect(dbHolder.current.calls.insert.products[0].options).toEqual([
      { name: "Size", values: ["S", "M"] },
      { name: "Colour", values: ["Black"], swatches: { Black: "#111111" } },
    ]);
    const [variants] = dbHolder.current.calls.insert.product_variants;
    expect(variants.map((v: any) => [v.name, v.optionValues])).toEqual([
      ["M / Black", ["M", "Black"]],
      ["S / Black", ["S", "Black"]],
    ]);
  });

  it("seeds inconsistent options as a flat list and says so", async () => {
    const base = getThemeDefinition("basket");
    const product = base.preset.sampleData!.products[0];
    const theme = structuredClone(base);
    theme.preset.sampleData!.products = [
      {
        ...product,
        options: [{ name: "Size", values: ["S", "M"] }],
        variants: [
          {
            name: "Small",
            option_values: ["S"],
            base_price: 10,
            selling_price: 9,
            stock: 2,
          },
          {
            name: "Also small",
            option_values: ["S"],
            base_price: 10,
            selling_price: 9,
            stock: 2,
          },
        ],
      },
    ];
    const result = await applyThemeDefinition("store-1", theme, {
      publish: true,
    });
    expect(result.errors.join(" ")).toMatch(/options .*Two variants/);
    expect(dbHolder.current.calls.insert.products[0].options).toEqual([]);
    const [variants] = dbHolder.current.calls.insert.product_variants;
    expect(variants.map((v: any) => [v.name, v.optionValues])).toEqual([
      ["Small", []],
      ["Also small", []],
    ]);
  });

  it("refuses reset on a non-demo store", async () => {
    const r = await applyTheme("store-1", "basket", {
      publish: true,
      reset: true,
    });
    expect(r.success).toBe(false);
    expect(r.errors[0]).toMatch(/not a demo store/i);
    // Nothing was deleted.
    expect(dbHolder.current.calls.delete.products).toBeUndefined();
  });

  it("resets a demo store before applying", async () => {
    dbHolder.current = makeApplyDb({
      storeSettings: { demo: true, brand: { name: "Basket Demo" } },
    });
    const r = await applyTheme("store-1", "basket", {
      publish: true,
      reset: true,
    });
    expect(r.success, r.errors.join(" | ")).toBe(true);
    for (const table of [
      "products",
      "categories",
      "store_pages",
      "store_menus",
    ]) {
      expect(dbHolder.current.calls.delete[table], table).toBeGreaterThan(0);
    }
  });

  it("accumulates errors without aborting (best-effort)", async () => {
    dbHolder.current = makeApplyDb({
      storeSettings: { brand: { name: "My Shop" } },
      failTables: new Set(["store_menus"]),
    });
    const r = await applyTheme("store-1", "basket", { publish: true });
    expect(r.success).toBe(false);
    expect(r.errors.some((e) => e.includes("menus down"))).toBe(true);
    // Pages were still seeded despite the menus failure.
    expect(dbHolder.current.calls.insert.store_pages?.length).toBeGreaterThan(
      0,
    );
  });
});
