/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ★ A Theme Studio preview store must resolve ONLY for a request the preview
// gate admits; for anyone else it is as unknown as an unclaimed subdomain.

const H = vi.hoisted(() => ({
  rows: [] as any[],
  allowed: false,
  asked: [] as [string, string][],
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(
    async () => new Headers({ host: "studio-preview-abc.storemink.com" }),
  ),
}));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("next/cache", () => ({
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/db/client", () => ({
  withAnon: vi.fn(async (fn: (db: any) => Promise<any>) =>
    fn({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => H.rows }) }),
      }),
    }),
  ),
}));
vi.mock("@/lib/theme-studio/preview-access", () => ({
  studioPreviewAllowed: vi.fn(async (storeId: string, versionId: string) => {
    H.asked.push([storeId, versionId]);
    return H.allowed;
  }),
}));

import { getCurrentStoreOrNull } from "./resolve";

const V = "22222222-2222-4222-8222-222222222222";
const P = "11111111-1111-4111-8111-111111111111";

function store(settings: Record<string, unknown>) {
  return {
    id: "s1",
    slug: "studio-preview-abc",
    name: "Preview",
    status: "active",
    plan: "free",
    plan_expires_at: null,
    comp_plan: null,
    comp_expires_at: null,
    custom_domain: null,
    settings,
  };
}

beforeEach(() => {
  H.rows = [];
  H.allowed = false;
  H.asked = [];
});

describe("Theme Studio preview gate in the store resolver", () => {
  it("hides a preview store from a request without a grant", async () => {
    H.rows = [
      store({ demo: true, studioPreview: { projectId: P, versionId: V } }),
    ];
    expect(await getCurrentStoreOrNull()).toBeNull();
    expect(H.asked).toEqual([["s1", V]]);
  });

  it("resolves it for a request the gate admits", async () => {
    H.rows = [
      store({ demo: true, studioPreview: { projectId: P, versionId: V } }),
    ];
    H.allowed = true;
    expect(await getCurrentStoreOrNull()).toMatchObject({ id: "s1" });
  });

  it("never consults the gate for an ordinary store", async () => {
    H.rows = [store({ demo: true })];
    expect(await getCurrentStoreOrNull()).toMatchObject({ id: "s1" });
    expect(H.asked).toEqual([]);
  });
});
