/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";

// placeOrder authenticates via getServerUser (the identity seam) and does every
// product read + order write through the Cloud SQL data layer (withService,
// RLS-bypassing), resolves the store from the host, re-validates the coupon, and
// rate-limits per user.
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreId: vi.fn(async () => STORE),
  getCurrentStore: vi.fn(async () => ({ id: STORE, name: "Test Store" })),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(),
  // Only getCartTaxRates reads these two; placeOrder never calls either,
  // so stubbing them changes nothing for the tests above.
  clientIp: vi.fn(() => "203.0.113.1"),
}));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
// Store credit is a separate concern from what these tests assert (pricing,
// stock, coupons). Mocked so it neither adds a query to their fixture queues
// nor changes any amount — a 0 balance is exactly today's behaviour. Its own
// integration is covered in the "store credit" block at the bottom.
vi.mock("@/lib/credit/store-credit", () => ({
  getCreditBalance: vi.fn(async () => 0),
  spendCredit: vi.fn(async () => true),
  reinstateCreditForOrder: vi.fn(async () => 0),
  // ★ Cashback. Absent until the offer caps were fixed, which is itself the
  // tell: nothing exercised the `credit_back` path, so an unmocked
  // `issueCredit` was never reached and its offer's caps were never claimed.
  issueCredit: vi.fn(async () => ({ ok: true })),
}));
vi.mock("./coupon-actions", () => ({ validateCoupon: vi.fn() }));
// The fan-out is fire-and-forget, so stubbing it changes nothing about the
// order write — but it is the only way to assert WHO gets told WHAT, which is
// the whole point of the "unpaid gateway order" tests below.
vi.mock("@/lib/notifications/record", () => ({
  emitEvent: vi.fn(),
  recordEvent: vi.fn(),
}));
// Online payments: the gateway loader (credential decrypt) and the Razorpay
// HTTP calls are mocked at the module boundary; the pure helpers
// (capturedPayment) keep their real implementations — they're unit-tested in
// lib/payments/payments.test.ts.
// ⚠ `getLiveStoreGateway` is mocked as a WHOLE, not composed from a mocked
// `getStoreGateway`. A partial mock cannot work here: the real function calls
// `getStoreGateway` module-internally, so the spy never intercepts it and the
// real provider read eats this file's seeded plan row.
//
// The three conditions it folds together (connected · enabled · plan) are
// covered directly in lib/payments/provider.test.ts.
vi.mock("@/lib/payments/provider", () => ({
  getStoreGateway: vi.fn(),
  getLiveStoreGateway: vi.fn(),
  getPlatformRazorpayCreds: vi.fn(),
}));
vi.mock("@/lib/payments/razorpay", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    rzpCreateOrder: vi.fn(),
    rzpFetchOrderPayments: vi.fn(),
    verifyCheckoutSignature: vi.fn(),
  };
});

// The Cloud SQL data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_id: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
// Fulfilment routing is mocked at its own seam (its ranking is tested in
// lib/fulfilment/strategies.test.ts). Left real it would consume entries from
// the shared db mock queue and shift every later read.
vi.mock("@/lib/fulfilment/resolve", () => ({
  resolveFulfilmentLocation: vi.fn(async () => null),
}));
vi.mock("@/lib/shipping/quote", () => ({
  quoteShippingForOrder: vi.fn(),
}));
// Offers are mocked at their own seam for the same reason as fulfilment
// routing: left real, `resolveOffersForCart` reads the offer tables and would
// consume entries from the shared db mock queue, shifting every later read.
//
// ★ THE DEFAULT IS `null`, WHICH MEANS "OFFERS UNAVAILABLE" — byte-for-byte
// today's behaviour, so every pricing, stock and coupon test below asserts the
// legacy path unchanged. The offer path has its own block at the bottom.
vi.mock("@/lib/offers/cart", () => ({
  resolveOffersForCart: vi.fn(async () => null),
  reserveOfferUses: vi.fn(async () => ({ ok: true, reserved: [] })),
  releaseOfferUses: vi.fn(async () => {}),
  recordOfferRedemptions: vi.fn(async () => {}),
  // ★ NOT MOCKED — a pure function that decides WHICH offers claim their caps.
  // Stubbing it would let the reserve/record wiring regress invisibly, which is
  // exactly how gift and cashback offers came to bypass every cap.
  bonusOffersToReserve: (
    result: { gift?: unknown; credit?: unknown } | null,
    giftValuePaise = 0,
  ) => {
    const out: unknown[] = [];
    const r = result as any;
    if (r?.gift) {
      out.push({
        offerId: r.gift.offerId,
        offerName: r.gift.offerName,
        code: r.gift.code ?? null,
        rewardType: "free_item",
        level: "gift",
        amount: Math.max(0, Math.trunc(giftValuePaise)) / 100,
      });
    }
    if (r?.credit && r.credit.amount > 0) {
      out.push({
        offerId: r.credit.offerId,
        offerName: r.credit.offerName,
        code: r.credit.code ?? null,
        rewardType: "credit_back",
        level: "credit",
        amount: r.credit.amount,
      });
    }
    return out;
  },
}));

import {
  placeOrder,
  getCartStock,
  getCartTaxRates,
  confirmOnlinePayment,
  reconcileMyOrderPayment,
  type CheckoutFormData,
} from "./checkout-actions";
import {
  getCreditBalance,
  spendCredit,
  reinstateCreditForOrder,
} from "@/lib/credit/store-credit";
import {
  recordOfferRedemptions,
  releaseOfferUses,
  reserveOfferUses,
  resolveOffersForCart,
} from "@/lib/offers/cart";
import { getServerUser } from "@/lib/auth/server-user";
import { rateLimit } from "@/lib/rate-limit";
import { validateCoupon } from "./coupon-actions";
import { getLiveStoreGateway, getStoreGateway } from "@/lib/payments/provider";
import {
  rzpCreateOrder,
  rzpFetchOrderPayments,
  verifyCheckoutSignature,
} from "@/lib/payments/razorpay";
import { makeDbMock, sqlText, sqlParamValues } from "./_test-helpers";
import { orders, orderItems, productVariants } from "@/drizzle/schema";
import { emitEvent } from "@/lib/notifications/record";
import type { CartItem } from "@/app/(storefront)/components/cart/CartProvider";
import { quoteShippingForOrder } from "@/lib/shipping/quote";

const STORE = "a0000000-0000-4000-8000-000000000001";

const validForm: CheckoutFormData = {
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  phone: "9876543210",
  addressLine1: "1 Analytical Engine Rd",
  city: "London",
  state: "England",
  postalCode: "SW1",
  country: "UK",
};

// One line, client-claimed price is deliberately absurd — the server must
// ignore it and re-price from the DB (100), so subtotal = 100 * 2 = 200.
function oneItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    productId: "p1",
    slug: "prod",
    name: "Prod",
    variantId: null,
    variantName: null,
    price: 999999,
    basePrice: 999999,
    image: null,
    quantity: 2,
    ...overrides,
  };
}

// A DB product row as placeOrder's aliased select returns it (snake_case).
const productRow = (o: Record<string, any> = {}) => ({
  id: "p1",
  name: "Prod",
  selling_price: 100,
  store_id: STORE,
  tax_class_id: null,
  ...o,
});

// Find the db.execute() call that ran a given RPC by name.
const findRpc = (name: string) =>
  dbHolder.current.calls.execute.find((e: any) => sqlText(e).includes(name));

// ★★ ONE FILE-LEVEL RESET FOR THE OFFERS SEAM, and it is not belt-and-braces.
// `vi.clearAllMocks()` — which every block below calls — clears CALLS but NOT
// IMPLEMENTATIONS, so a `mockResolvedValue` set inside one test leaks into
// every test that runs after it. The offers block sets `resolveOffersForCart`
// to return a real result; under `test:shuffle` that block can run BEFORE the
// store-credit block, whose own `beforeEach` is `clearAllMocks()` alone — and
// 21 store-credit assertions then failed because a discount they never asked
// for was being applied. Caught by the shuffled run, invisible in declaration
// order. A top-level hook runs before every describe's own, so restoring the
// file default here means a block added later cannot reintroduce this.
beforeEach(() => {
  vi.mocked(resolveOffersForCart).mockResolvedValue(null);
  vi.mocked(reserveOfferUses).mockResolvedValue({ ok: true, reserved: [] });
  vi.mocked(releaseOfferUses).mockResolvedValue(undefined);
  vi.mocked(recordOfferRedemptions).mockResolvedValue(undefined);
});

describe("placeOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Happy COD path: products, billing (tax off), taxClasses; one reserve_stock.
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });
    vi.mocked(getServerUser).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
    vi.mocked(validateCoupon).mockResolvedValue({} as any);
    vi.mocked(quoteShippingForOrder).mockResolvedValue({
      options: [],
      error: "No courier available",
    });
  });

  it("★ a COD order IS announced at checkout — nothing is waiting on a gateway", async () => {
    // The other half of the rule. COD, pay-at-store and a credit-covered order
    // are complete the moment they are written, so deferring their confirmation
    // would mean it never arrived at all.
    await placeOrder(validForm, [oneItem()]);
    const placed = vi
      .mocked(emitEvent)
      .mock.calls.filter((c: any[]) => c[0]?.type === "order.placed");
    expect(placed).toHaveLength(1);
  });

  it("rejects an anonymous caller", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    const result = await placeOrder(validForm, [oneItem()]);
    expect("error" in result && result.error).toMatch(/logged in/i);
  });

  it("★ refuses to take an order on a demo store, before any work", async () => {
    // A theme's showcase store is publicly reachable and reset on demand, so it
    // must never write an order somebody believes is real. Refused before the
    // rate limit and before any DB read, so a refusal leaves nothing behind.
    const { getCurrentStore } = await import("@/lib/store/resolve");
    vi.mocked(getCurrentStore).mockResolvedValueOnce({
      id: STORE,
      name: "Vitrine Demo",
      settings: { demo: true },
    } as any);
    const result = await placeOrder(validForm, [oneItem()]);
    expect("error" in result && result.error).toMatch(/demo store/i);
    // Nothing was priced, reserved or written.
    expect(vi.mocked(rateLimit)).not.toHaveBeenCalled();
  });

  it("still takes orders on a normal store (the guard is not over-broad)", async () => {
    const { getCurrentStore } = await import("@/lib/store/resolve");
    vi.mocked(getCurrentStore).mockResolvedValueOnce({
      id: STORE,
      name: "Real Store",
      settings: {},
    } as any);
    const result = await placeOrder(validForm, [oneItem()]);
    expect("error" in result && /demo store/i.test(String(result.error))).toBe(
      false,
    );
  });

  it("rejects an empty cart", async () => {
    const result = await placeOrder(validForm, []);
    expect("error" in result && result.error).toMatch(/empty/i);
  });

  it("rejects a cart with too many line items", async () => {
    const items = Array.from({ length: 101 }, (_, i) =>
      oneItem({ productId: `p${i}` }),
    );
    const result = await placeOrder(validForm, items);
    expect("error" in result && result.error).toMatch(/too many/i);
  });

  it("rejects a non-positive / non-integer quantity", async () => {
    const bad = await placeOrder(validForm, [oneItem({ quantity: 0 })]);
    expect("error" in bad && bad.error).toMatch(/invalid quantity/i);
    const frac = await placeOrder(validForm, [oneItem({ quantity: 1.5 })]);
    expect("error" in frac && frac.error).toMatch(/invalid quantity/i);
  });

  it("rejects when a required address field is missing", async () => {
    const result = await placeOrder({ ...validForm, city: "   " }, [oneItem()]);
    expect("error" in result && result.error).toMatch(/city is required/i);
  });

  it("rejects a phone number Shiprocket cannot deliver to", async () => {
    const result = await placeOrder(
      { ...validForm, phone: "+91 88888 88888" },
      [oneItem()],
    );
    expect("error" in result && result.error).toMatch(/valid 10-digit/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("rejects when rate-limited", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false } as any);
    const result = await placeOrder(validForm, [oneItem()]);
    expect("error" in result && result.error).toMatch(/too many/i);
  });

  it("rejects when the product is not found in the host store", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const result = await placeOrder(validForm, [oneItem()]);
    expect("error" in result && result.error).toMatch(/not found/i);
  });

  it("re-prices from the DB (ignores the client-supplied price)", async () => {
    const result = await placeOrder(validForm, [oneItem()]);
    expect("success" in result && result.success).toBe(true);

    // Order total came from the DB price (100 * 2), not the client's 999999.
    const inserted = dbHolder.current.calls.values[0];
    expect(inserted.subtotal).toBe(200);
    expect(inserted.total).toBe(200);
    expect(inserted.storeId).toBe(STORE);
    expect(inserted.customerId).toBe("user-1");
    // Marked so cancellation restocks it exactly once (order-actions claim).
    expect(inserted.stockStatus).toBe("reserved");
  });

  // ---------------------------------------------------------------------
  // ★ A VARIANT ON SALE MUST BE CHARGED ITS SALE PRICE.
  //
  // The storefront resolves a variant's price through
  // lib/pricing.variantEffectiveSelling (special_price wins over
  // selling_price) and the till applies the identical rule — but placeOrder
  // used to read `selling_price` straight off the row and never even SELECT
  // `special_price`. A variant at 450/500 therefore displayed ₹450, charged
  // ₹450 in store, and billed ₹500 online. Both directions are pinned below:
  // dropping the column, or bypassing the helper, fails one of them.
  // ---------------------------------------------------------------------

  // A variant row as placeOrder's aliased select returns it.
  const variantRow = (o: Record<string, any> = {}) => ({
    id: "v1",
    name: "pack of 4",
    selling_price: 500,
    special_price: null,
    cost_price: null,
    track_inventory: false,
    allow_backorder: false,
    sku: "SKU1V01",
    requires_shipping: false,
    weight_grams: null,
    length_cm: null,
    width_cm: null,
    height_cm: null,
    ...o,
  });

  // products → billing → taxClasses → variants (readTaxConfig is two selects).
  const variantSelectQueue = (v: Record<string, any>) => [
    [productRow()],
    [],
    [],
    [variantRow(v)],
  ];

  const variantLine = () =>
    oneItem({ variantId: "v1", variantName: "pack of 4" });

  it("★ charges a variant's special_price, not its selling_price", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: variantSelectQueue({
        selling_price: 500,
        special_price: 450,
      }),
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    const res = await placeOrder(validForm, [variantLine()]);
    expect("success" in res && res.success).toBe(true);

    // 450 × 2 — the price the PDP showed. At 500 the shopper is overcharged
    // ₹100 on this order and ₹50 a unit.
    const order = dbHolder.current.calls.values[0];
    expect(order.subtotal).toBe(900);
    expect(order.total).toBe(900);

    // The per-line snapshot is what the invoice and the emailed receipt read,
    // so it has to carry the sale price too — not just the order total.
    const items = dbHolder.current.calls.values[1];
    expect(items[0].price).toBe(450);
    expect(items[0].total).toBe(900);

    // ★ AND THE COLUMN IS ACTUALLY READ. The db mock returns canned rows, so
    // it happily serves `special_price` whether or not the select asked for
    // it — meaning the assertions above alone stay green if someone drops the
    // column, and the bug returns in production only. Assert the projection
    // itself, by column identity.
    const projections = dbHolder.current.calls.select as Record<string, any>[];
    expect(
      projections.some(
        (p) => p?.special_price === productVariants.specialPrice,
      ),
    ).toBe(true);
  });

  it("★ charges selling_price when the variant has no special_price", async () => {
    // The other direction: the fix must not make every variant cheaper. A null
    // special_price is "not on sale", and so are 0 and a negative — all of them
    // fall back to selling_price rather than charging nothing.
    for (const special of [null, 0, -10]) {
      dbHolder.current = makeDbMock({
        selectQueue: variantSelectQueue({
          selling_price: 500,
          special_price: special,
        }),
        executeQueue: [[{ reserved: true }]],
        returning: [{ id: "order-1", order_ref: "ORD1" }],
      });

      const res = await placeOrder(validForm, [variantLine()]);
      expect("success" in res && res.success).toBe(true);

      const order = dbHolder.current.calls.values[0];
      expect(order.subtotal).toBe(1000);
      expect(order.total).toBe(1000);
      expect(dbHolder.current.calls.values[1][0].price).toBe(500);
    }
  });

  it("re-quotes a physical order and snapshots the selected shipping promise", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          productRow({
            requires_shipping: true,
            weight_grams: 300,
            length_cm: 12,
            width_cm: 8,
            height_cm: 4,
          }),
        ],
        [],
        [],
      ],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });
    vi.mocked(quoteShippingForOrder).mockResolvedValue({
      options: [
        {
          id: "shiprocket:7",
          label: "Fast Courier",
          description: "Delivery in 2–3 days",
          amount: 50,
          carrierCost: 45,
          courierId: "7",
          courierName: "Fast Courier",
          estimatedDeliveryMinDays: 2,
          estimatedDeliveryMaxDays: 3,
          estimatedDeliveryAt: "2026-08-17T12:00:00.000Z",
          freeShippingApplied: false,
        },
      ],
    });

    const result = await placeOrder(
      { ...validForm, postalCode: "201301", country: "India" },
      [oneItem()],
      null,
      "cod",
      null,
      null,
      "shiprocket:7",
      50,
    );

    expect("success" in result && result.success).toBe(true);
    const inserted = dbHolder.current.calls.values[0];
    expect(inserted.shipping).toBe(50);
    expect(inserted.total).toBe(250);
    expect(inserted.shippingOption).toMatchObject({
      id: "shiprocket:7",
      courierId: "7",
      amount: 50,
      carrierCost: 45,
      provider: "shiprocket",
    });
  });

  it("does not silently charge a changed live delivery price", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow({ requires_shipping: true })], [], []],
    });
    vi.mocked(quoteShippingForOrder).mockResolvedValue({
      options: [
        {
          id: "shiprocket:7",
          label: "Fast Courier",
          description: "Delivery in 2–3 days",
          amount: 60,
          carrierCost: 55,
          courierId: "7",
          courierName: "Fast Courier",
          estimatedDeliveryMinDays: 2,
          estimatedDeliveryMaxDays: 3,
          estimatedDeliveryAt: "2026-08-17T12:00:00.000Z",
          freeShippingApplied: false,
        },
      ],
    });

    const result = await placeOrder(
      { ...validForm, postalCode: "201301", country: "India" },
      [oneItem()],
      null,
      "cod",
      null,
      null,
      "shiprocket:7",
      50,
    );

    expect("error" in result && result.error).toMatch(/price changed/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("applies a validated coupon, rounds the discount, and increments usage", async () => {
    vi.mocked(validateCoupon).mockResolvedValue({
      coupon: {
        code: "SAVE10",
        discountType: "percentage",
        discountValue: 10,
        minOrderAmount: 0,
      },
    } as any);
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      // increment_coupon_usage, then reserve_stock.
      executeQueue: [[{ reserved: true }], [{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    const result = await placeOrder(validForm, [oneItem()], "SAVE10");
    expect("success" in result && result.success).toBe(true);

    const inserted = dbHolder.current.calls.values[0];
    // 10% of 200 = 20 (rounded), total 180.
    expect(inserted.discount).toBe(20);
    expect(inserted.total).toBe(180);
    expect(inserted.appliedCouponCode).toBe("SAVE10");

    // Usage reserved atomically via the RPC (single conditional UPDATE).
    const inc = findRpc("increment_coupon_usage");
    expect(inc).toBeTruthy();
    expect(sqlParamValues(inc)).toEqual(["SAVE10", STORE]);
  });

  it("refuses checkout when the coupon usage cap was hit concurrently", async () => {
    vi.mocked(validateCoupon).mockResolvedValue({
      coupon: {
        code: "SAVE10",
        discountType: "percentage",
        discountValue: 10,
        minOrderAmount: 0,
      },
    } as any);
    // The atomic reserve returns false → the last use was taken by another order.
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: false }]],
    });

    const result = await placeOrder(validForm, [oneItem()], "SAVE10");
    expect("error" in result && result.error).toMatch(/usage limit/i);
    expect(dbHolder.current.calls.insert).not.toContain(orders);
  });

  it("releases the reserved coupon use when the order items fail to save", async () => {
    vi.mocked(validateCoupon).mockResolvedValue({
      coupon: {
        code: "SAVE10",
        discountType: "percentage",
        discountValue: 10,
        minOrderAmount: 0,
      },
    } as any);
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }], [{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
      failInsertFor: [orderItems],
    });

    const result = await placeOrder(validForm, [oneItem()], "SAVE10");
    expect("error" in result && result.error).toMatch(/try again/i);
    // Orphan order deleted, and the reserved use handed back atomically.
    expect(dbHolder.current.calls.delete).toContain(orders);
    const dec = findRpc("decrement_coupon_usage");
    expect(dec).toBeTruthy();
    expect(sqlParamValues(dec)).toEqual(["SAVE10", STORE]);
  });

  it("bails out with the coupon error and does not create an order", async () => {
    vi.mocked(validateCoupon).mockResolvedValue({ error: "expired" } as any);
    const result = await placeOrder(validForm, [oneItem()], "OLD");
    expect("error" in result && result.error).toMatch(/coupon error/i);
    expect(dbHolder.current.calls.insert).not.toContain(orders);
  });

  it("rolls back the order when order_items insertion fails", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
      failInsertFor: [orderItems],
    });

    const result = await placeOrder(validForm, [oneItem()]);
    expect("error" in result && result.error).toMatch(/try again/i);
    expect(dbHolder.current.calls.delete).toContain(orders);
  });

  it("fails checkout if stock cannot be reserved, reports the exact shortfall, and rolls back prior reservations", async () => {
    // Two items: the first reserves, the second fails; the post-failure re-read
    // reports 1 unit left, so the shopper is told the precise remaining quantity.
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          productRow(),
          productRow({ id: "p2", name: "Product 2", selling_price: 150 }),
        ],
        [],
        [],
        [{ stock: 1 }], // availableStock() re-read
      ],
      executeQueue: [[{ reserved: true }], [{ reserved: false }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    const result = await placeOrder(validForm, [
      oneItem({ productId: "p1" }),
      oneItem({ productId: "p2", name: "Product 2" }),
    ]);

    expect("error" in result && result.error).toMatch(
      /not enough stock for Product 2/i,
    );
    expect("error" in result && result.error).toMatch(/only 1 left/i);
    // release_stock was called for the first item that succeeded.
    const rel = findRpc("release_stock");
    expect(rel).toBeTruthy();
    const relParams = sqlParamValues(rel);
    expect(relParams).toContain("p1");
    expect(relParams).toContain("checkout_failed");
  });

  it("reports 'just sold out' when the live re-read shows zero left", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], [], [{ stock: 0 }]],
      executeQueue: [[{ reserved: false }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    const result = await placeOrder(validForm, [oneItem({ productId: "p1" })]);
    expect("error" in result && result.error).toMatch(/just sold out/i);
    expect(dbHolder.current.calls.delete).toContain(orders);
  });

  it("creates the order before reserving stock, then reserves each line", async () => {
    // The ported flow inserts the order (805) before the reserve loop (877), so
    // the stock_movements.order_id FK is always satisfied. Assert both happened.
    const result = await placeOrder(validForm, [oneItem()]);
    expect("success" in result && result.success).toBe(true);
    expect(dbHolder.current.calls.insert).toContain(orders);
    const res = findRpc("reserve_stock");
    expect(res).toBeTruthy();
    const params = sqlParamValues(res);
    expect(params).toContain("p1");
    expect(params).toContain(2); // p_qty
  });
});

// getCartStock re-reads live stock for the cart, store-scoped, so the checkout
// page can reconcile a stale localStorage cart before the shopper commits.
describe("getCartStock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ id: "p1", track_inventory: true, stock: 3, allow_backorder: false }],
      ],
    });
  });

  it("returns [] for an empty cart without touching the DB", async () => {
    expect(await getCartStock([])).toEqual([]);
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("returns a fresh snapshot for a product line", async () => {
    const info = await getCartStock([{ productId: "p1", variantId: null }]);
    expect(info).toEqual([
      {
        productId: "p1",
        variantId: null,
        exists: true,
        trackInventory: true,
        stock: 3,
        allowBackorder: false,
      },
    ]);
  });

  it("marks a vanished product as exists:false", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const info = await getCartStock([{ productId: "gone", variantId: null }]);
    expect(info[0].exists).toBe(false);
  });

  it("resolves a variant line from the variant row (not the product)", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ id: "p1", track_inventory: true, stock: 3, allow_backorder: false }],
        [{ id: "v1", track_inventory: true, stock: 2, allow_backorder: false }],
      ],
    });
    const info = await getCartStock([{ productId: "p1", variantId: "v1" }]);
    expect(info[0]).toMatchObject({ variantId: "v1", exists: true, stock: 2 });
  });

  it("marks a variant line exists:false when the variant is gone", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ id: "p1", track_inventory: true, stock: 3, allow_backorder: false }],
        [],
      ],
    });
    const info = await getCartStock([{ productId: "p1", variantId: "vGone" }]);
    expect(info[0].exists).toBe(false);
  });
});

// A store with tax ENABLED: the product carries a tax class (GST 18%), read
// authoritatively from the DB. placeOrder snapshots the tax onto the order +
// each line and adjusts the total per the inclusive/exclusive mode.
describe("placeOrder — tax", () => {
  function taxSelectQueue(pricesIncludeTax: boolean) {
    return [
      [productRow({ tax_class_id: "tc1" })],
      [
        {
          tax_enabled: true,
          prices_include_tax: pricesIncludeTax,
          default_tax_class_id: null,
        },
      ],
      [{ id: "tc1", name: "GST 18%", rate: 18, sort_order: 0 }],
    ];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
    vi.mocked(validateCoupon).mockResolvedValue({} as any);
  });

  it("adds tax on top of the total when prices are exclusive", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: taxSelectQueue(false),
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    const res = await placeOrder(validForm, [oneItem()]);
    expect("success" in res && res.success).toBe(true);

    const order = dbHolder.current.calls.values[0];
    expect(order.subtotal).toBe(200);
    expect(order.tax).toBe(36); // 200 * 18%
    expect(order.taxInclusive).toBe(false);
    expect(order.total).toBe(236); // subtotal + tax

    const items = dbHolder.current.calls.values[1];
    expect(items[0].taxRate).toBe(18);
    expect(items[0].taxAmount).toBe(36);
    expect(items[0].taxClassName).toBe("GST 18%");
  });

  it("carves tax out without changing the total when prices are inclusive", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: taxSelectQueue(true),
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    const res = await placeOrder(validForm, [oneItem()]);
    expect("success" in res && res.success).toBe(true);

    const order = dbHolder.current.calls.values[0];
    expect(order.subtotal).toBe(200);
    expect(order.tax).toBe(30.51); // round2(200 * 18 / 118)
    expect(order.taxInclusive).toBe(true);
    expect(order.total).toBe(200); // unchanged — tax already inside the price

    const items = dbHolder.current.calls.values[1];
    expect(items[0].taxAmount).toBe(30.51);
  });
});

// ---------------------------------------------------------------------------
// Online payments (BYO Razorpay)
// ---------------------------------------------------------------------------

const GATEWAY = {
  creds: { keyId: "rzp_test_abc123", keySecret: "shh" },
  enabled: true,
};

describe("placeOrder — razorpay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // getLiveStoreGateway is mocked, so it consumes no select — the queue is
    // the COD flow's reads alone.
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD100110006" }],
    });
    vi.mocked(getServerUser).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
    vi.mocked(validateCoupon).mockResolvedValue({} as any);
    // ⚠ `clearAllMocks` clears CALLS, not IMPLEMENTATIONS, so the store-credit
    // block's balance used to leak in here: the order total stayed ₹200 (credit
    // is a payment, not a discount — §29) while the CHARGE dropped to ₹150, and
    // this suite's whole point is that the gateway is asked for the
    // server-computed amount. Reset explicitly so the razorpay tests describe a
    // customer with no credit.
    vi.mocked(getCreditBalance).mockResolvedValue(0);
    vi.mocked(getLiveStoreGateway).mockResolvedValue(GATEWAY.creds as any);
    vi.mocked(rzpCreateOrder).mockResolvedValue({
      ok: true,
      data: {
        id: "rzp_order_1",
        amount: 20000,
        currency: "INR",
        receipt: "ORD100110006",
        status: "created",
      },
    } as any);
  });

  it("★★ does NOT announce an unpaid gateway order — to anyone", async () => {
    // The bug this exists for: a shopper reached the Razorpay modal, paid
    // nothing, and both they and the merchant were emailed "New order ORD…
    // ₹39.00 · Paid online". If they close the modal the reaper cancels and
    // restocks that order 45 minutes later, so the confirmation described
    // something that no longer existed. The order row is still written — it has
    // to be, the gateway needs something to attach the payment to — but nothing
    // is ANNOUNCED until markOrderPaid claims the pending → paid transition.
    const res = await placeOrder(validForm, [oneItem()], null, "razorpay");
    expect("error" in res && res.error).toBeFalsy();

    const placed = vi
      .mocked(emitEvent)
      .mock.calls.filter((c: any[]) => c[0]?.type === "order.placed");
    expect(placed).toHaveLength(0);
  });

  it("rejects an unknown payment method", async () => {
    const res = await placeOrder(validForm, [oneItem()], null, "upi" as any);
    expect("error" in res && res.error).toMatch(/invalid payment method/i);
  });

  it("creates the Razorpay order for the SERVER-computed total and returns checkout params", async () => {
    const res = await placeOrder(validForm, [oneItem()], null, "razorpay");
    expect("success" in res && res.success).toBe(true);
    if (!("success" in res)) throw new Error("unreachable");

    // Amount derives from the DB price (100 × 2 = ₹200 = 20000 paise).
    expect(rzpCreateOrder).toHaveBeenCalledWith(GATEWAY.creds, {
      amountPaise: 20000,
      receipt: "ORD100110006",
      notes: { order_id: "order-1", store_id: STORE },
    });

    const inserted = dbHolder.current.calls.values[0];
    expect(inserted.paymentMethod).toBe("razorpay");
    expect(inserted.paymentStatus).toBe("pending");
    // The Razorpay order id is pinned to our order via an update.
    expect(dbHolder.current.calls.set).toContainEqual({
      razorpayOrderId: "rzp_order_1",
    });

    expect(res.payment).toEqual({
      rzpOrderId: "rzp_order_1",
      keyId: "rzp_test_abc123",
      amountPaise: 20000,
    });
  });

  it("refuses online payment when no gateway is connected/enabled", async () => {
    // null folds together all three refusals: not connected, paused, or a
    // lapsed plan — see lib/payments/provider.test.ts for each on its own.
    vi.mocked(getLiveStoreGateway).mockResolvedValue(null);
    const res = await placeOrder(validForm, [oneItem()], null, "razorpay");
    expect("error" in res && res.error).toMatch(/cash on delivery/i);
    expect(dbHolder.current.calls.insert).not.toContain(orders);
  });

  it("rolls back stock, order and coupon when the Razorpay order can't be created", async () => {
    vi.mocked(validateCoupon).mockResolvedValue({
      coupon: {
        code: "SAVE10",
        discountType: "percentage",
        discountValue: 10,
        minOrderAmount: 0,
      },
    } as any);
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }], [{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD100110006" }],
    });
    vi.mocked(rzpCreateOrder).mockResolvedValue({
      ok: false,
      error: "gateway down",
    } as any);

    const res = await placeOrder(validForm, [oneItem()], "SAVE10", "razorpay");
    expect("error" in res && res.error).toMatch(/try again/i);

    const rel = findRpc("release_stock");
    expect(rel).toBeTruthy();
    expect(sqlParamValues(rel)).toContain("order-1"); // p_order
    expect(dbHolder.current.calls.delete).toContain(orders);
    const dec = findRpc("decrement_coupon_usage");
    expect(dec).toBeTruthy();
    expect(sqlParamValues(dec)).toEqual(["SAVE10", STORE]);
  });

  it("rolls back when the rzp order id can't be pinned to our order", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD100110006" }],
      failUpdateFor: [orders], // the razorpay-order-id pin update fails
    });

    const res = await placeOrder(validForm, [oneItem()], null, "razorpay");
    expect("error" in res && res.error).toMatch(/try again/i);
    expect(dbHolder.current.calls.delete).toContain(orders);
  });
});

describe("confirmOnlinePayment", () => {
  const pendingOrder = {
    id: "order-1",
    payment_method: "razorpay",
    payment_status: "pending",
    razorpay_order_id: "rzp_order_1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({ selectQueue: [[pendingOrder]] });
    vi.mocked(getServerUser).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
    vi.mocked(getStoreGateway).mockResolvedValue(GATEWAY as any);
    vi.mocked(verifyCheckoutSignature).mockReturnValue(true);
  });

  it("verifies the HMAC with the store secret and marks the order paid", async () => {
    const res = await confirmOnlinePayment("order-1", "pay_1", "sig");
    expect(res).toEqual({ success: true, paid: true });

    expect(verifyCheckoutSignature).toHaveBeenCalledWith(
      "shh",
      "rzp_order_1",
      "pay_1",
      "sig",
    );
    // The pending → paid transition is claimed via a conditional update.
    expect(dbHolder.current.calls.set).toContainEqual({
      paymentStatus: "paid",
      razorpayPaymentId: "pay_1",
    });
  });

  it("rejects a bad signature and leaves the order untouched", async () => {
    vi.mocked(verifyCheckoutSignature).mockReturnValue(false);
    const res = await confirmOnlinePayment("order-1", "pay_1", "bad");
    expect("error" in res && res.error).toMatch(/verification failed/i);
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("is a no-op success when the order is already paid", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [[{ ...pendingOrder, payment_status: "paid" }]],
    });
    const res = await confirmOnlinePayment("order-1", "pay_1", "sig");
    expect(res).toEqual({ success: true, paid: true });
    expect(verifyCheckoutSignature).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });

  it("rejects an anonymous caller", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    const res = await confirmOnlinePayment("order-1", "pay_1", "sig");
    expect("error" in res && res.error).toMatch(/logged in/i);
  });

  it("rejects when the order isn't the caller's / isn't razorpay", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const res = await confirmOnlinePayment("order-1", "pay_1", "sig");
    expect("error" in res && res.error).toMatch(/not found/i);
  });
});

describe("reconcileMyOrderPayment", () => {
  const pendingOrder = {
    id: "order-1",
    payment_method: "razorpay",
    payment_status: "pending",
    razorpay_order_id: "rzp_order_1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({ selectQueue: [[pendingOrder]] });
    vi.mocked(getServerUser).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
    vi.mocked(getStoreGateway).mockResolvedValue(GATEWAY as any);
  });

  it("marks the order paid when Razorpay reports a captured payment", async () => {
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: true,
      data: [
        { id: "pay_f", order_id: "rzp_order_1", amount: 1, status: "failed" },
        {
          id: "pay_ok",
          order_id: "rzp_order_1",
          amount: 20000,
          status: "captured",
        },
      ],
    } as any);

    const res = await reconcileMyOrderPayment("order-1");
    expect(res).toEqual({ success: true, paid: true });
    expect(dbHolder.current.calls.set).toContainEqual({
      paymentStatus: "paid",
      razorpayPaymentId: "pay_ok",
    });
  });

  it("reports unpaid (without cancelling) when nothing was captured", async () => {
    vi.mocked(rzpFetchOrderPayments).mockResolvedValue({
      ok: true,
      data: [],
    } as any);

    const res = await reconcileMyOrderPayment("order-1");
    expect(res).toEqual({ success: true, paid: false });
    expect(dbHolder.current.calls.update).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Store credit at checkout (roadmap Step 4 / returns-exchanges-plan Step 7)
// ---------------------------------------------------------------------------

describe("placeOrder — store credit", () => {
  /** The happy COD fixture, with a balance to spend. */
  function seedWithCredit(balance: number) {
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });
    vi.mocked(getServerUser).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
    vi.mocked(validateCoupon).mockResolvedValue({} as any);
    vi.mocked(getCreditBalance).mockResolvedValue(balance);
    vi.mocked(spendCredit).mockResolvedValue(true);
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spends credit against the order and records how much", async () => {
    seedWithCredit(50);
    const res = await placeOrder(validForm, [oneItem()]);
    expect("error" in res && res.error).toBeFalsy();

    expect(spendCredit).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "user-1", orderId: "order-1" }),
    );
    // ★ Recorded on the order, NOT netted off the total — credit is a payment,
    // not a discount, and the invoice/GST must still reflect the goods value.
    const stamped = dbHolder.current.calls.set.find(
      (v: any) => v && "storeCreditUsed" in v,
    );
    expect(stamped.storeCreditUsed).toBe(50);
  });

  it("★ leaves orders.total alone — it is the goods value, not the amount due", async () => {
    // Netting credit off would understate the sale on the invoice and compute
    // GST on the wrong base. So the SAME basket must write the SAME total
    // whether or not credit was applied.
    const totalFor = async (balance: number) => {
      seedWithCredit(balance);
      await placeOrder(validForm, [oneItem()]);
      return dbHolder.current.calls.values.find(
        (v: any) => v && !Array.isArray(v) && "subtotal" in v,
      ).total;
    };
    const withoutCredit = await totalFor(0);
    const withCredit = await totalFor(50);
    expect(withCredit).toBe(withoutCredit);
  });

  it("does nothing when the customer has no balance", async () => {
    seedWithCredit(0);
    await placeOrder(validForm, [oneItem()]);
    expect(spendCredit).not.toHaveBeenCalled();
  });

  it("★ never refuses the sale when the balance moved underneath it", async () => {
    // Invariant 6: never refuse a sale over an optional feature. A race on the
    // balance means they pay the full amount, not that checkout fails.
    seedWithCredit(50);
    vi.mocked(spendCredit).mockResolvedValue(false);
    const res = await placeOrder(validForm, [oneItem()]);
    expect("error" in res && res.error).toBeFalsy();
    const stamped = dbHolder.current.calls.set.find(
      (v: any) => v && "storeCreditUsed" in v,
    );
    expect(stamped).toBeUndefined();
  });

  it("★ marks a fully-covered order PAID, with nothing to collect", async () => {
    // Otherwise a COD courier is told to collect ₹0 and the gateway would be
    // asked for an amount it refuses.
    seedWithCredit(500);
    await placeOrder(validForm, [oneItem()]);
    const paid = dbHolder.current.calls.set.find(
      (v: any) => v && v.paymentMethod === "store_credit",
    );
    expect(paid).toMatchObject({
      paymentMethod: "store_credit",
      paymentStatus: "paid",
    });
  });

  it("does not mark a partly-covered order paid", async () => {
    seedWithCredit(50);
    await placeOrder(validForm, [oneItem()]);
    const paid = dbHolder.current.calls.set.find(
      (v: any) => v && v.paymentMethod === "store_credit",
    );
    expect(paid).toBeUndefined();
  });

  it("doesn't look up a balance for a signed-out shopper", async () => {
    seedWithCredit(50);
    vi.mocked(getServerUser).mockResolvedValue(null as any);
    await placeOrder(validForm, [oneItem()]);
    expect(spendCredit).not.toHaveBeenCalled();
    expect(reinstateCreditForOrder).not.toHaveBeenCalled();
  });

  it("★★ a failed stamp GIVES THE CREDIT BACK rather than leaving the order lying", async () => {
    // `store_credit_used` is not bookkeeping — `refundableAmount` subtracts it
    // to work out how much MONEY the order actually took. Spending the balance
    // while the column stays 0 makes the order read as fully paid in money, so
    // a later cash or manual refund hands back credit the store never received.
    // There is no gateway backstop on those methods.
    seedWithCredit(50);
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
      failUpdateFor: [orders],
    });

    const res = await placeOrder(validForm, [oneItem()]);

    // The sale still completes — never refuse a sale over an optional feature.
    expect("error" in res && res.error).toBeFalsy();
    // And the balance goes straight back, so ledger and order agree.
    expect(reinstateCreditForOrder).toHaveBeenCalledWith(STORE, "order-1");
  });
});

// ---------------------------------------------------------------------------
// Offers (docs/offers-plan.md §8, §11). The seam is mocked above and defaults
// to `null` — "offers unavailable" — so these tests opt IN to the offer path.
// ---------------------------------------------------------------------------

describe("placeOrder — offers", () => {
  const offerResult = (over: Partial<any> = {}) => ({
    subtotal: 200,
    lines: [{ id: "0", offerDiscount: 30 }],
    discount: 30,
    applied: [
      {
        offerId: "offer-1",
        offerName: "Launch offer",
        code: null,
        rewardType: "percent_off",
        level: "order",
        amount: 30,
      },
    ],
    allocations: [
      {
        lineId: "0",
        offerId: "offer-1",
        offerName: "Launch offer",
        amount: 30,
      },
    ],
    nearMiss: [],
    scenario: { chosen: "order_only", scores: [] },
    skipped: [],
    cappedByCeiling: false,
    ...over,
  });

  // ★ EVERY DEFAULT RESTORED EXPLICITLY. `vi.clearAllMocks()` clears CALLS,
  // not IMPLEMENTATIONS, so a `mockResolvedValue` set inside one test leaks
  // into every test after it — the exact defect `test:shuffle` exists to
  // catch (CODEBASE.md convention #8).
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({ id: "user-1" } as any);
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
    vi.mocked(validateCoupon).mockResolvedValue({} as any);
    vi.mocked(quoteShippingForOrder).mockResolvedValue({
      options: [],
      error: "No courier available",
    });
    vi.mocked(resolveOffersForCart).mockResolvedValue(null);
    vi.mocked(reserveOfferUses).mockResolvedValue({ ok: true, reserved: [] });
    vi.mocked(releaseOfferUses).mockResolvedValue(undefined);
    vi.mocked(recordOfferRedemptions).mockResolvedValue(undefined);
  });

  it("applies an automatic offer and snapshots it on the line", async () => {
    vi.mocked(resolveOffersForCart).mockResolvedValue(offerResult() as any);
    vi.mocked(reserveOfferUses).mockResolvedValue({
      ok: true,
      reserved: [{ offerId: "offer-1", amountPaise: 3000 }],
    });
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    const result = await placeOrder(validForm, [oneItem()]);
    expect("success" in result && result.success).toBe(true);

    const order = dbHolder.current.calls.values[0];
    expect(order.discount).toBe(30);
    expect(order.total).toBe(170);

    // ★ THE LINE CARRIES ITS OWN SHARE. Without this, a partial return
    // re-allocates the discount proportionally and refunds the wrong amount.
    const items = dbHolder.current.calls.values[1];
    const line = Array.isArray(items) ? items[0] : items;
    expect(line.offerDiscount).toBe(30);
  });

  it("★★ a free gift becomes a real ₹0 line with a REAL zero offer discount", async () => {
    // ★★ THE BUG THIS PINS, which shipped unpinned until `selectByTable`
    // existed. The gift is appended to `validItems`, and `offerDiscounts` is
    // `validItems.map(() => 0)`. Size that array BEFORE the append and the
    // gift's entry is UNDEFINED — and it goes straight into
    // `order_items.offer_discount`, a NOT NULL column, where an explicit
    // undefined does NOT fall back to the column default. Every order carrying
    // a gift would fail on INSERT showing only "Failed to save order items".
    // That is the `storeCreditUsed: null` failure (CODEBASE.md §22) exactly.
    //
    // ★ `selectByTable` IS WHAT MAKES THIS TESTABLE AT ALL. The gift's product
    // read sits behind a conditional after the offers resolve, among reads
    // whose count varies with the cart, so no position in `selectQueue`
    // reaches it — all eight were tried. Keyed by table, the two reads of
    // `products` are simply "the cart, then the gift".
    vi.mocked(resolveOffersForCart).mockResolvedValue(
      offerResult({
        lines: [{ id: "0", offerDiscount: 0 }],
        discount: 0,
        applied: [],
        allocations: [],
        gift: {
          offerId: "offer-gift",
          offerName: "Free tumbler",
          code: null,
          productId: "gift-product",
          variantId: null,
          quantity: 1,
        },
      }) as any,
    );
    dbHolder.current = makeDbMock({
      selectByTable: {
        products: [
          [productRow()],
          // The gift, read store-scoped after the offers resolve. Snake-case
          // keys, matching that query's own projection aliases.
          [
            {
              id: "gift-product",
              name: "Steel tumbler",
              tax_class_id: null,
              category_id: null,
              sku: "SKU-GIFT",
              hsn_code: null,
              // False to match `productRow()`, which leaves it unset — every
              // test in this block uses a cart that needs no courier, so the
              // shipping quote is stubbed to fail. This test is about the
              // line's offer discount, not logistics.
              requires_shipping: false,
              weight_grams: 100,
              length_cm: 5,
              width_cm: 5,
              height_cm: 10,
            },
          ],
        ],
      },
      // Two lines now reserve stock: the paid one and the gift. A gift is
      // stock leaving the shelf, so it goes through the same RPC.
      executeQueue: [[{ reserved: true }], [{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    const result = await placeOrder(validForm, [oneItem()]);
    expect("success" in result && result.success).toBe(true);

    const rows = dbHolder.current.calls.values[1] as any[];
    const gift = rows.find((r) => r.productId === "gift-product");
    expect(gift).toBeDefined();
    expect(gift.price).toBe(0);
    expect(gift.total).toBe(0);
    // ★ A REAL ZERO. `toBe(0)` passes for neither undefined nor null, which is
    // the entire reason this is asserted rather than the price.
    expect(gift.offerDiscount).toBe(0);
  });

  // ★★ A GIFT AND A CASHBACK OFFER MUST CLAIM THEIR CAPS TOO.
  //
  // `applied` is built from the per-line merchandise allocation, so a
  // `free_item` or `credit_back` reward — which allocates nothing to a line —
  // was never in it, and both counters only ever reserved `applied`. Every cap
  // was decorative: "free tumbler, limited to 100" gave away unlimited
  // tumblers, and "₹100 cashback, budget ₹5,000" issued unbounded store credit,
  // which is a liability rather than a discount. No `offer_redemptions` row was
  // written either, so `max_per_customer` could not bind even in principle.
  describe("★★ the bonus axes claim their caps", () => {
    const GIFT = {
      offerId: "offer-gift",
      offerName: "Free tumbler",
      code: null,
      productId: "gift-product",
      variantId: null,
      quantity: 1,
    };

    function seedGiftCart(giftSellingPrice = 250) {
      dbHolder.current = makeDbMock({
        selectByTable: {
          products: [
            [productRow()],
            [
              {
                id: "gift-product",
                name: "Steel tumbler",
                selling_price: giftSellingPrice,
                tax_class_id: null,
                category_id: null,
                sku: "SKU-GIFT",
                hsn_code: null,
                requires_shipping: false,
                weight_grams: 100,
                length_cm: 5,
                width_cm: 5,
                height_cm: 10,
              },
            ],
          ],
        },
        executeQueue: [[{ reserved: true }], [{ reserved: true }]],
        returning: [{ id: "order-1", order_ref: "ORD1" }],
      });
    }

    /** Every offer id handed to `reserveOfferUses`, across all its calls. */
    const reservedIds = () =>
      vi
        .mocked(reserveOfferUses)
        .mock.calls.flatMap(([, applied]) =>
          applied.map((a: any) => a.offerId),
        );

    it("★ reserves the gift, priced at what the shopper would have paid", async () => {
      vi.mocked(resolveOffersForCart).mockResolvedValue(
        offerResult({
          lines: [{ id: "0", offerDiscount: 0 }],
          discount: 0,
          applied: [],
          allocations: [],
          gift: GIFT,
        }) as any,
      );
      seedGiftCart(250);
      expect("success" in (await placeOrder(validForm, [oneItem()]))).toBe(
        true,
      );

      expect(reservedIds()).toContain("offer-gift");
      // ★ The budget is charged the gift's RETAIL value — the same rule the
      // shipping waiver's `offerWaivedAmount` follows: what the shopper would
      // otherwise have paid. Reserving it at 0 would leave a budgeted gift
      // offer running unbounded.
      const giftClaim = vi
        .mocked(reserveOfferUses)
        .mock.calls.flatMap(([, applied]) => applied)
        .find((a: any) => a.offerId === "offer-gift") as any;
      expect(giftClaim.amount).toBe(250);
      expect(giftClaim.level).toBe("gift");
    });

    it("★ reserves cashback at exactly the credit it will issue", async () => {
      vi.mocked(resolveOffersForCart).mockResolvedValue(
        offerResult({
          lines: [{ id: "0", offerDiscount: 0 }],
          discount: 0,
          applied: [],
          allocations: [],
          credit: {
            offerId: "offer-cash",
            offerName: "₹100 back",
            code: null,
            amount: 100,
          },
        }) as any,
      );
      dbHolder.current = makeDbMock({
        selectQueue: [[productRow()], [], []],
        executeQueue: [[{ reserved: true }]],
        returning: [{ id: "order-1", order_ref: "ORD1" }],
      });
      await placeOrder(validForm, [oneItem()]);

      const claim = vi
        .mocked(reserveOfferUses)
        .mock.calls.flatMap(([, applied]) => applied)
        .find((a: any) => a.offerId === "offer-cash") as any;
      // Cashback's cost to the merchant IS the credit issued, so a budget cap
      // on it binds exactly.
      expect(claim.amount).toBe(100);
    });

    it("★★ records what it reserved, so max_per_customer can bind", async () => {
      // `max_per_customer` is counted from `offer_redemptions`. A reward that
      // moved `redemption_count` without writing a row left that cap unable to
      // bind at all, however the merchant configured it.
      vi.mocked(resolveOffersForCart).mockResolvedValue(
        offerResult({
          lines: [{ id: "0", offerDiscount: 0 }],
          discount: 0,
          applied: [],
          allocations: [],
          gift: GIFT,
        }) as any,
      );
      seedGiftCart();
      await placeOrder(validForm, [oneItem()]);

      const recorded = vi.mocked(recordOfferRedemptions).mock.calls[0]?.[0];
      expect(recorded?.redeemed.map((r: any) => r.offerId)).toContain(
        "offer-gift",
      );
    });

    it("★★ a gift cap DROPS the gift; it never refuses the sale", async () => {
      // These caps are MEANT to be reached — "a tumbler with the first 100
      // orders" hits its limit on order 101 by design. Failing the sale there
      // would stop the shop selling anything at all until somebody noticed,
      // which is far worse than the bug the reservation exists to fix. It is
      // the rule the gift block already follows for a vanished product.
      vi.mocked(resolveOffersForCart).mockResolvedValue(
        offerResult({
          lines: [{ id: "0", offerDiscount: 0 }],
          discount: 0,
          applied: [],
          allocations: [],
          gift: GIFT,
        }) as any,
      );
      vi.mocked(reserveOfferUses).mockResolvedValue({
        ok: false,
        error: "“Free tumbler” has just reached its limit.",
        reserved: [],
      } as any);
      seedGiftCart();

      const result = await placeOrder(validForm, [oneItem()]);
      expect("success" in result && result.success).toBe(true);

      // And the tumbler is not handed over: the ₹0 line is gone from the order.
      const rows = dbHolder.current.calls.values[1] as any[];
      expect(rows.some((r) => r.productId === "gift-product")).toBe(false);
      // The remaining line keeps its own offer discount — removing the gift
      // must not shift `offerDiscounts` out of step with its lines.
      expect(rows.every((r) => typeof r.offerDiscount === "number")).toBe(true);
    });
  });

  it("★ never runs both discount systems for one order", async () => {
    vi.mocked(resolveOffersForCart).mockResolvedValue(offerResult() as any);
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    await placeOrder(validForm, [oneItem()], "SAVE10");
    // A coupon IS an offer now, so the legacy path must stay untouched —
    // running both would double the discount AND the usage counter.
    expect(validateCoupon).not.toHaveBeenCalled();
    expect(findRpc("increment_coupon_usage")).toBeFalsy();
  });

  it("★ falls back to the coupon path when the engine applies nothing", async () => {
    // Three live cases need this: the deploy window before the migration, a
    // Mink-created coupon row that is not an offer, and a coupon the migration
    // left behind. Refusing the code outright breaks all three.
    vi.mocked(resolveOffersForCart).mockResolvedValue(
      offerResult({
        applied: [],
        allocations: [],
        discount: 0,
        lines: [{ id: "0", offerDiscount: 0 }],
      }) as any,
    );
    vi.mocked(validateCoupon).mockResolvedValue({
      coupon: {
        code: "SAVE10",
        discountType: "percentage",
        discountValue: 10,
        minOrderAmount: 0,
      },
    } as any);
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }], [{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    const result = await placeOrder(validForm, [oneItem()], "SAVE10");
    expect("success" in result && result.success).toBe(true);
    expect(validateCoupon).toHaveBeenCalled();
    expect(dbHolder.current.calls.values[0].discount).toBe(20);
  });

  it("refuses the order when an offer cap was reached mid-checkout", async () => {
    vi.mocked(resolveOffersForCart).mockResolvedValue(offerResult() as any);
    vi.mocked(reserveOfferUses).mockResolvedValue({
      ok: false,
      error: "“Launch offer” has just reached its limit.",
      reserved: [],
    });
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    const result = await placeOrder(validForm, [oneItem()]);
    expect("error" in result && result.error).toMatch(/reached its limit/i);
    // ★ Refused BEFORE the order exists, so nothing needs unwinding.
    expect(dbHolder.current.calls.values[0]).toBeUndefined();
  });

  it("★ releases reserved offer uses when the order items fail to save", async () => {
    vi.mocked(resolveOffersForCart).mockResolvedValue(offerResult() as any);
    vi.mocked(reserveOfferUses).mockResolvedValue({
      ok: true,
      reserved: [{ offerId: "offer-1", amountPaise: 3000 }],
    });
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
      failInsertFor: [orderItems],
    });

    const result = await placeOrder(validForm, [oneItem()]);
    expect("error" in result && result.error).toBeTruthy();
    expect(releaseOfferUses).toHaveBeenCalledWith(STORE, [
      { offerId: "offer-1", amountPaise: 3000 },
    ]);
  });

  it("records the redemption and the per-line offer after the sale commits", async () => {
    vi.mocked(resolveOffersForCart).mockResolvedValue(offerResult() as any);
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    await placeOrder(validForm, [oneItem()]);
    expect(recordOfferRedemptions).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: STORE, orderId: "order-1" }),
    );
    // The line id the engine used must resolve to a real order_items row id,
    // or the per-line record is silently dropped.
    const call = vi.mocked(recordOfferRedemptions).mock.calls.at(-1)?.[0];
    expect(call?.orderItemIdByLine.get("0")).toBeTruthy();
  });

  it("does not write an offer record when no offer applied", async () => {
    vi.mocked(resolveOffersForCart).mockResolvedValue(
      offerResult({
        applied: [],
        allocations: [],
        discount: 0,
        lines: [{ id: "0", offerDiscount: 0 }],
      }) as any,
    );
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    await placeOrder(validForm, [oneItem()]);
    expect(recordOfferRedemptions).not.toHaveBeenCalled();
    expect(reserveOfferUses).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // ★ THE ENGINE MUST BE TOLD WHAT A LINE IS ON SALE FROM, or
  // `offers.onSalePrice` cannot work online. Its contract is that
  // `unitPrice` is what will be charged and `regularUnitPrice` is the
  // non-sale price, with "absent or equal" meaning not on sale — so sending
  // only one of them does not fail loudly, it silently makes every sale line
  // look full-price and a `skip` setting stop skipping. Pinned in both
  // directions.
  // -------------------------------------------------------------------------

  const lineSentToEngine = () =>
    vi.mocked(resolveOffersForCart).mock.calls.at(-1)?.[0]?.lines?.[0] as any;

  it("★ sends the sale price and the price it is on sale from", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [productRow()],
        [],
        [],
        [
          {
            id: "v1",
            name: "pack of 4",
            selling_price: 500,
            special_price: 450,
            cost_price: null,
            track_inventory: false,
            allow_backorder: false,
            sku: "SKU1V01",
            requires_shipping: false,
            weight_grams: null,
            length_cm: null,
            width_cm: null,
            height_cm: null,
          },
        ],
      ],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    await placeOrder(validForm, [
      oneItem({ variantId: "v1", variantName: "pack of 4" }),
    ]);

    // Charged 450, on sale from 500 — the same pair placePosSale passes, so a
    // basket prices identically in both channels.
    expect(lineSentToEngine()).toMatchObject({
      unitPrice: 450,
      regularUnitPrice: 500,
    });
  });

  it("★ reports a full-price line as not on sale", async () => {
    // The engine treats equal prices as "no sale", so a simple product must
    // send its own selling price as both rather than omitting one or reaching
    // for base_price — MRP is a struck-through list price, and passing it
    // would let `best` mode discount from a much higher base.
    // Its own db mock: this describe's beforeEach deliberately does not set
    // one, so borrowing the previous test's exhausted queue makes placeOrder
    // fail before it ever reaches the engine.
    dbHolder.current = makeDbMock({
      selectQueue: [[productRow()], [], []],
      executeQueue: [[{ reserved: true }]],
      returning: [{ id: "order-1", order_ref: "ORD1" }],
    });

    await placeOrder(validForm, [oneItem()]);

    const line = lineSentToEngine();
    expect(line).toMatchObject({ unitPrice: 100, regularUnitPrice: 100 });
    expect(line.regularUnitPrice).not.toBeGreaterThan(line.unitPrice);
  });
});

// ---------------------------------------------------------------------------
// getCartTaxRates — the cart summary's tax BASIS
//
// ★ THIS PATH HAD THE SAME BUG, AND IT MADE THE CART SUMMARY DISAGREE WITH
// ITSELF. `CartItem.price` is captured on the PDP through
// variantEffectiveSelling, so the subtotal on screen used the sale price —
// while the tax shown beside it was computed from this action's `price`, which
// read `selling_price`. A variant at 450/500 therefore showed a ₹900 subtotal
// with tax charged on ₹1,000. Display only (placeOrder re-prices
// authoritatively), but it is the number the shopper is shown before paying.
// ---------------------------------------------------------------------------
describe("getCartTaxRates", () => {
  // billing → taxClasses → products → variants.
  const queue = (special: number | null) => [
    [
      {
        tax_enabled: true,
        prices_include_tax: false,
        default_tax_class_id: null,
      },
    ],
    [{ id: "tc1", name: "GST 18%", rate: 18, sort_order: 0 }],
    [{ id: "p1", selling_price: 100, cost_price: null, tax_class_id: "tc1" }],
    [{ id: "v1", selling_price: 500, special_price: special }],
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true } as any);
  });

  // ★★ A STORE WITH TAX OFF STILL GETS ITS OFFER FACTS.
  //
  // This returned `empty` — no lines at all — the moment tax was disabled. But
  // `categoryId` and `regularUnitPrice` ride along here for the OFFER engine,
  // not for tax, so a category-scoped offer saw `categoryId: null` on every
  // line and was skipped as `no_eligible_lines`: the checkout summary showed no
  // discount while `placeOrder`, which reads the same column unconditionally in
  // its own query, DID apply it. Reported live on a store running a
  // buy-1-get-1 on a category, quoted at full price at checkout.
  const noTaxQueue = () => [
    [
      {
        tax_enabled: false,
        prices_include_tax: false,
        default_tax_class_id: null,
      },
    ],
    [{ id: "tc1", name: "GST 18%", rate: 18, sort_order: 0 }],
    [
      {
        id: "p1",
        selling_price: 100,
        cost_price: null,
        tax_class_id: "tc1",
        category_id: "cat-seating",
      },
    ],
    [{ id: "v1", selling_price: 48900, special_price: 44900 }],
  ];

  it("★★ still reports category and sale price when tax is disabled", async () => {
    dbHolder.current = makeDbMock({ selectQueue: noTaxQueue() });

    const res = await getCartTaxRates([{ productId: "p1", variantId: "v1" }]);

    // Tax display is untouched — the store really does charge none.
    expect(res.enabled).toBe(false);
    expect(res.inclusive).toBe(false);
    // ...but the offer engine's inputs are present, which is the whole point.
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toMatchObject({
      productId: "p1",
      variantId: "v1",
      categoryId: "cat-seating",
      price: 44900,
      regularUnitPrice: 48900,
      // Every line is taxed at zero; resolving a class would be discarded work.
      rate: 0,
    });
  });

  it("★ taxes a variant on its special_price", async () => {
    dbHolder.current = makeDbMock({ selectQueue: queue(450) });

    const res = await getCartTaxRates([{ productId: "p1", variantId: "v1" }]);

    expect(res.enabled).toBe(true);
    // 450, matching what the PDP put in the cart — not the 500 the cart used
    // to tax against.
    expect(res.lines[0]).toMatchObject({ price: 450, rate: 18 });
  });

  it("★ taxes a variant on selling_price when it is not on sale", async () => {
    dbHolder.current = makeDbMock({ selectQueue: queue(null) });

    const res = await getCartTaxRates([{ productId: "p1", variantId: "v1" }]);

    expect(res.lines[0]).toMatchObject({ price: 500, rate: 18 });
  });

  // ★★ THE CART MUST BE TOLD WHAT A LINE IS ON SALE FROM.
  //
  // The offer engine reads `regularUnitPrice` absent-or-equal as "not on sale".
  // The cart passed nothing, so every line looked full-price while `placeOrder`
  // passed the variant's `selling_price` — and the two then disagreed. Under
  // `offers.onSalePrice = "skip"` the cart showed a discount the charge
  // declined and the total ROSE at the last step; under `best` it overstated
  // the saving. `CartItem.price` is the sale price captured at add time and
  // nothing in the cart records what it was reduced from, so like `categoryId`
  // this can only come from the server.
  it("★★ reports the price a line is ON SALE FROM, not just what it costs", async () => {
    dbHolder.current = makeDbMock({ selectQueue: queue(450) });

    const res = await getCartTaxRates([{ productId: "p1", variantId: "v1" }]);

    expect(res.lines[0]).toMatchObject({
      price: 450,
      // The non-sale price the engine measures `onSalePrice` against.
      regularUnitPrice: 500,
    });
  });

  it("★ an un-discounted line reports the two as EQUAL, which reads as no sale", async () => {
    dbHolder.current = makeDbMock({ selectQueue: queue(null) });

    const res = await getCartTaxRates([{ productId: "p1", variantId: "v1" }]);

    // `priceLines` treats `regularUnitPrice <= unitPrice` as not-on-sale, so
    // equality is how an ordinary line must arrive. A higher value here would
    // wrongly mark every line on sale and make `skip` decline the whole cart.
    expect(res.lines[0]).toMatchObject({
      price: 500,
      regularUnitPrice: 500,
    });
  });

  it("falls back to the product price for a variant-less line", async () => {
    // Guards the branch either fix could have broken: a line with no variant
    // must still price off the product row.
    dbHolder.current = makeDbMock({ selectQueue: queue(450) });

    const res = await getCartTaxRates([{ productId: "p1", variantId: null }]);

    expect(res.lines[0]).toMatchObject({ price: 100, rate: 18 });
  });
});
