import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/store/resolve", () => ({
  requireStorefrontStoreId: async () => "store",
}));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrand: async () => ({
    name: "Crave",
    tagline: "Food",
    primaryColor: "#E8A427",
  }),
}));
vi.mock("@/lib/storefront/queries", () => ({
  getPublishedPage: vi.fn(),
  getActiveCategories: async () => [
    { slug: "food", name: "Food", image_url: null },
  ],
}));
vi.mock("@/lib/pages/preview", () => ({
  getDraftPageForPreview: async () => ({ title: "Draft" }),
}));
vi.mock("@/lib/sections/resolve-data", () => ({}));
vi.mock("@/lib/settings/resolve", () => ({}));
vi.mock("./components/sections/page-section-renderer", () => ({}));
vi.mock("./components/sections/draft-canvas", () => ({}));
vi.mock("./components/sections/preview-bridge", () => ({}));
vi.mock("./components/sections/builder-overlay", () => ({}));
vi.mock("./(pages)/shop/shop-client", () => ({}));
vi.mock("./(pages)/shop/shop-view", () => ({}));
import { getPublishedPage } from "@/lib/storefront/queries";
import { generateMetadata as home } from "./page";
import { generateMetadata as content } from "./(pages)/[pageSlug]/page";
import { generateMetadata as shop } from "./(pages)/shop/page";
import { generateMetadata as collection } from "./(pages)/collections/[slug]/page";

beforeEach(() => {
  vi.mocked(getPublishedPage).mockResolvedValue({
    slug: "our-story",
    title: "Our story",
    seo_noindex: false,
  } as Awaited<ReturnType<typeof getPublishedPage>>);
});
it("preserves layout robots on home, shop, content and collection pages", async () => {
  const metadata = await Promise.all([
    home({ searchParams: Promise.resolve({}) }),
    shop({ searchParams: Promise.resolve({}) }),
    content({
      params: Promise.resolve({ pageSlug: "our-story" }),
      searchParams: Promise.resolve({}),
    }),
    collection({
      params: Promise.resolve({ slug: "food" }),
      searchParams: Promise.resolve({}),
    }),
  ]);
  for (const child of metadata) {
    // Next shallowly merges child metadata: an own undefined robots value
    // would erase the preview/demo/unlaunched layout's noindex policy.
    expect(Object.hasOwn(child, "robots")).toBe(false);
    expect({ robots: { index: false }, ...child }.robots).toEqual({
      index: false,
    });
    expect({ ...child }.robots).toBeUndefined(); // live stores remain indexable
  }
});
it("keeps explicit draft, search and merchant noindex overrides", async () => {
  expect(
    (await home({ searchParams: Promise.resolve({ preview: "1" }) })).robots,
  ).toMatchObject({ index: false });
  expect(
    (await shop({ searchParams: Promise.resolve({ q: "milk" }) })).robots,
  ).toMatchObject({ index: false });
  expect(
    (
      await collection({
        params: Promise.resolve({ slug: "food" }),
        searchParams: Promise.resolve({ q: "milk" }),
      })
    ).robots,
  ).toMatchObject({ index: false });
  vi.mocked(getPublishedPage).mockResolvedValue({
    slug: "our-story",
    seo_noindex: true,
  } as Awaited<ReturnType<typeof getPublishedPage>>);
  expect(
    (
      await content({
        params: Promise.resolve({ pageSlug: "our-story" }),
        searchParams: Promise.resolve({}),
      })
    ).robots,
  ).toMatchObject({ index: false });
});
