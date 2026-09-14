import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  viewer: vi.fn(),
  withUser: vi.fn(),
  brandVoice: vi.fn(),
}));

vi.mock("@/app/dashboard/lib/access", () => ({
  getViewerContext: holder.viewer,
}));
vi.mock("@/lib/db/client", () => ({
  withUser: holder.withUser,
}));
vi.mock("./access", () => ({
  // ★ `vi.fn(impl)`, NOT `vi.fn().mockResolvedValue(...)`: the config's
  //   `mockReset: true` wipes the second form, and an undefined invite makes
  //   `draftingEnabled` undefined rather than true — which fails as a
  //   whole-object mismatch several fields away from the real cause.
  requireMinkStoreInvite: vi.fn(async () => ({
    enabled: true,
    draftingEnabled: true,
  })),
}));
vi.mock("@/lib/ai/brand-voice", () => ({
  getBrandSoulForStore: holder.brandVoice,
}));

import { getMinkActorContext } from "./actor-context";

beforeEach(() => {
  vi.clearAllMocks();
  holder.viewer.mockResolvedValue({
    userId: "admin-1",
    userEmail: "owner@example.com",
    storeId: "store-1",
    profile: { role: "member" },
    permissions: { dashboard: ["view"], products: ["view"] },
    isSuperadmin: false,
    isPlatformAdmin: false,
  });
  holder.withUser.mockResolvedValue({
    store: {
      plan: "pro",
      settings: {
        business: { timeZone: "Asia/Kolkata" },
        features: { "inventory.lowStockThreshold": 7 },
      },
    },
    locationIds: ["location-1"],
  });
  holder.brandVoice.mockResolvedValue("Warm, concise, and honest.");
});

describe("getMinkActorContext", () => {
  it("derives tenant, identity, permissions, and plan on the server", async () => {
    const actor = await getMinkActorContext("request-1");

    expect(holder.withUser).toHaveBeenCalledWith(
      { uid: "admin-1", email: "owner@example.com" },
      expect.any(Function),
    );
    expect(actor).toEqual({
      storeId: "store-1",
      adminId: "admin-1",
      email: "owner@example.com",
      roleSlug: "member",
      permissions: { dashboard: ["view"], products: ["view"] },
      isSuperadmin: false,
      effectivePlan: "pro",
      locationIds: ["location-1"],
      analyticsTimeZone: "Asia/Kolkata",
      currency: "INR",
      defaultLowStockThreshold: 7,
      currentPath: null,
      selectedResource: null,
      draftingEnabled: true,
      brandVoice: "Warm, concise, and honest.",
      requestId: "request-1",
    });
  });

  it("rejects an unauthenticated request before reading a store", async () => {
    holder.viewer.mockResolvedValue(null);

    await expect(getMinkActorContext("request-1")).rejects.toMatchObject({
      code: "not_signed_in",
      status: 401,
    });
    expect(holder.withUser).not.toHaveBeenCalled();
  });

  it("treats a permission database outage as unavailable, not denied", async () => {
    holder.viewer.mockResolvedValue({
      userId: "admin-1",
      storeId: "store-1",
      dbError: true,
    });

    await expect(getMinkActorContext("request-1")).rejects.toMatchObject({
      code: "permissions_unavailable",
      status: 503,
    });
    expect(holder.withUser).not.toHaveBeenCalled();
  });

  it("requires dashboard.view before constructing a model actor", async () => {
    holder.viewer.mockResolvedValue({
      userId: "admin-1",
      userEmail: "staff@example.com",
      storeId: "store-1",
      profile: { role: "catalog" },
      permissions: { products: ["view"] },
      isSuperadmin: false,
      isPlatformAdmin: false,
    });

    await expect(getMinkActorContext("request-1")).rejects.toMatchObject({
      code: "mink_access_denied",
      status: 403,
    });
    expect(holder.withUser).not.toHaveBeenCalled();
  });
});
