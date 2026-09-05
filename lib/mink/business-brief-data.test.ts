import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  sales: vi.fn(),
  inventory: vi.fn(),
  service: vi.fn(),
  filters: [] as unknown[],
  rows: [] as unknown[][],
}));
vi.mock("@/app/dashboard/analytics/data", async (original) => ({
  ...(await original<object>()),
  getSalesAnalytics: mocks.sales,
}));
vi.mock("./catalog-health-read", () => ({
  readMinkCatalogHealthByLocation: mocks.inventory,
}));
vi.mock("@/lib/db/client", () => ({ withService: mocks.service }));
import { collectBusinessBriefSnapshot } from "./business-brief-data";
import type { BusinessBriefInput } from "./business-brief-types";

const input: BusinessBriefInput = {
  period: "daily",
  defaultLowStockThreshold: 5,
  timeZone: "Asia/Kolkata",
  currency: "INR",
  locationIds: ["shop", "delhi"],
  restrictedLocationScope: false,
  includeUnassigned: true,
  locationLabel: "Shop and Delhi plus unassigned",
  requesterEmail: "admin@example.com",
  requestedAt: "2026-09-05T04:00:00Z",
};
const identity = { uid: "verified-admin", email: "admin@example.com" };
const scope = {
  locationIds: input.locationIds,
  locationLabel: input.locationLabel,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.filters = [];
  mocks.rows = [[{ created: 15, failed: 3 }], [{ current: 9, previous: 6 }]];
  mocks.sales.mockResolvedValue({
    totalSales: { value: 800 },
    orders: { value: 8 },
  });
  mocks.inventory.mockResolvedValue({
    locations: [
      { id: "shop", name: "Shop", trackedItems: 8, lowStock: 1, outOfStock: 2 },
      {
        id: "delhi",
        name: "Delhi",
        trackedItems: 8,
        lowStock: 0,
        outOfStock: 6,
      },
    ],
  });
  mocks.service.mockImplementation(async (callback) => {
    const query = {
      from: () => query,
      innerJoin: () => query,
      where: (filter: unknown) => {
        mocks.filters.push(filter);
        return Promise.resolve(mocks.rows.shift());
      },
    };
    return callback({ select: () => query });
  });
});

describe("business brief data boundaries", () => {
  it("uses fixed calendar windows, trusted identity and bounded scoped aggregates", async () => {
    const result = await collectBusinessBriefSnapshot(
      "echos-store",
      identity,
      input,
      scope,
    );
    expect(mocks.sales).toHaveBeenCalledTimes(2);
    expect(mocks.sales.mock.calls[0][0]).toBe("echos-store");
    expect(mocks.sales.mock.calls[0][1]).toEqual({
      locationIds: ["shop", "delhi"],
      selectedId: null,
      includeUnassigned: true,
    });
    expect(mocks.sales.mock.calls[0][2].current.to.toISOString()).toBe(
      "2026-09-04T18:30:00.000Z",
    );
    expect(mocks.inventory).toHaveBeenCalledWith({
      storeId: "echos-store",
      identity,
      locationIds: ["shop", "delhi"],
      defaultThreshold: 5,
    });
    expect(result).toMatchObject({
      returns: 9,
      previousReturns: 6,
      failedPaymentOrders: 3,
      createdOrders: 15,
    });
    expect(result.locations).toHaveLength(2);
    expect(mocks.filters).toHaveLength(2);
    for (const filter of mocks.filters) {
      const compiled = new PgDialect().sqlToQuery(filter as SQL);
      expect(compiled.params).toContain("echos-store");
      expect(compiled.params).toContain("shop");
      expect(compiled.params).toContain("delhi");
      expect(compiled.sql).toContain('"orders"."location_id"');
    }
  });
  it("keeps a Delhi-only request out of Shop and unassigned orders", async () => {
    mocks.inventory.mockResolvedValue({
      locations: [
        {
          id: "delhi",
          name: "Delhi",
          trackedItems: 8,
          lowStock: 0,
          outOfStock: 6,
        },
      ],
    });
    await collectBusinessBriefSnapshot(
      "echos-store",
      identity,
      { ...input, includeUnassigned: false, locationIds: ["delhi"] },
      { locationIds: ["delhi"], locationLabel: "Delhi" },
    );
    for (const filter of mocks.filters) {
      const compiled = new PgDialect().sqlToQuery(filter as SQL);
      expect(compiled.params).not.toContain("shop");
      expect(compiled.sql).not.toContain("is null");
    }
  });
  it("fails instead of completing when a captured location disappears", async () => {
    mocks.inventory.mockResolvedValue({ locations: [] });
    await expect(
      collectBusinessBriefSnapshot("echos-store", identity, input, scope),
    ).rejects.toThrow("brief_location_scope_changed");
  });
  it.each(["sales", "inventory", "activity"])(
    "propagates %s outages rather than healthy zeroes",
    async (source) => {
      if (source === "sales")
        mocks.sales.mockRejectedValue(new Error("source offline"));
      if (source === "inventory")
        mocks.inventory.mockRejectedValue(new Error("source offline"));
      if (source === "activity")
        mocks.service.mockRejectedValue(new Error("source offline"));
      await expect(
        collectBusinessBriefSnapshot("echos-store", identity, input, scope),
      ).rejects.toThrow("source offline");
    },
  );
  it("rejects a missing aggregate row", async () => {
    mocks.rows = [[], []];
    await expect(
      collectBusinessBriefSnapshot("echos-store", identity, input, scope),
    ).rejects.toThrow("brief_activity_unavailable");
  });
});
