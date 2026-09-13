import { describe, expect, it, vi } from "vitest";
import type { MinkActorContext } from "./types";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  scopeRows: [] as Array<Record<string, unknown>>,
  settings: {} as Record<string, unknown>,
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (work: (db: unknown) => unknown) =>
    work({
      select(fields: Record<string, unknown>) {
        const value = Object.hasOwn(fields, "id")
          ? mocks.rows
          : Object.hasOwn(fields, "offerId")
            ? mocks.scopeRows
            : [{ settings: mocks.settings }];
        const terminal = {
          limit: vi.fn(async (limit: number) => value.slice(0, limit)),
        };
        const joined = (): Record<string, unknown> => ({
          ...terminal,
          where: vi.fn(() => terminal),
          leftJoin: vi.fn(() => joined()),
        });
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              ...terminal,
              orderBy: vi.fn(() => terminal),
            })),
            leftJoin: vi.fn(() => joined()),
          })),
        };
      },
    }),
  ),
}));
vi.mock("@/lib/settings/registry", () => ({
  resolveStoreSettings: vi.fn((settings: Record<string, unknown>) => settings),
}));

import { readMinkCurrentOffers } from "./offers-read";

const ACTOR = {
  storeId: "store-1",
  adminId: "admin-1",
  email: "owner@example.com",
  roleSlug: "staff",
  permissions: { promotions: ["view"] },
  isSuperadmin: false,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request-1",
} satisfies MinkActorContext;

function offer(overrides: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    name: "Offer",
    status: "active",
    delivery: "automatic",
    code: null,
    priority: 0,
    triggerType: "always",
    triggerConfig: {},
    rewardType: "percent_off",
    rewardConfig: { percent: 10 },
    channels: [],
    validFrom: null,
    validUntil: null,
    maxRedemptions: null,
    redemptionCount: 0,
    budgetPaise: null,
    spentPaise: 0,
    ...overrides,
  };
}

describe("Mink current-offers read", () => {
  it("explains operational blockers instead of calling every active row running", async () => {
    mocks.settings = { "offers.autoApply": false };
    mocks.scopeRows = [];
    mocks.rows = [
      offer({ name: "Automatic", delivery: "automatic" }),
      offer({ name: "Code", delivery: "code", code: "SAVE10" }),
      offer({
        name: "Later",
        delivery: "code",
        validFrom: "2026-10-01T00:00:00.000Z",
      }),
      offer({
        name: "Expired",
        delivery: "code",
        validUntil: "2026-09-01T00:00:00.000Z",
      }),
      offer({
        name: "Used",
        delivery: "code",
        maxRedemptions: 2,
        redemptionCount: 2,
      }),
      offer({
        name: "Budget",
        delivery: "code",
        budgetPaise: 5000,
        spentPaise: 5000,
      }),
      offer({ name: "Disabled", status: "disabled" }),
    ];

    const result = await readMinkCurrentOffers(ACTOR, {
      limit: 20,
      now: new Date("2026-09-13T10:30:00.000Z"),
    });

    expect(result.runningCount).toBe(1);
    expect(result.offers.map((row) => [row.name, row.availability])).toEqual([
      ["Automatic", "automatic_offers_disabled"],
      ["Code", "running"],
      ["Later", "scheduled"],
      ["Expired", "ended"],
      ["Used", "redemption_limit_reached"],
      ["Budget", "budget_exhausted"],
      ["Disabled", "disabled"],
    ]);
    expect(result.offers[1]).toMatchObject({
      code: "SAVE10",
      reward: "10% off the order",
      trigger: "on any order",
      channels: ["storefront", "pos"],
    });
  });

  it("bounds rows and marks truncation", async () => {
    mocks.settings = { "offers.autoApply": true };
    mocks.scopeRows = [];
    mocks.rows = [offer({ name: "One" }), offer({ name: "Two" })];

    const result = await readMinkCurrentOffers(ACTOR, {
      limit: 1,
      now: new Date("2026-09-13T10:30:00.000Z"),
    });

    expect(result.offers).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it("keeps reward scope separate from an order-level trigger", async () => {
    mocks.settings = { "offers.autoApply": true };
    const scoped = offer({
      id: "offer-launch",
      name: "Launch",
      rewardType: "buy_x_get_y",
      rewardConfig: { buyQuantity: 1, getQuantity: 1 },
    });
    mocks.rows = [scoped];
    mocks.scopeRows = [
      {
        offerId: "offer-launch",
        productId: "product-almond",
        productName: "Almond shake",
        variantId: null,
        variantName: null,
        variantSku: null,
        categoryId: null,
        categoryName: null,
      },
      {
        offerId: "offer-launch",
        productId: null,
        productName: null,
        variantId: null,
        variantName: null,
        variantSku: null,
        categoryId: "category-beverages",
        categoryName: "Beverages",
      },
    ];

    const result = await readMinkCurrentOffers(ACTOR, {
      limit: 20,
      now: new Date("2026-09-13T10:30:00.000Z"),
    });

    expect(result.offers[0]).toMatchObject({
      reward: "Buy 1, get 1 free (2 selected)",
      trigger: "on any order",
      appliesTo: {
        allProducts: false,
        products: ["Almond shake"],
        variants: [],
        categories: ["Beverages"],
        summary: "Almond shake; all products in Beverages",
        truncated: false,
      },
    });
  });
});
