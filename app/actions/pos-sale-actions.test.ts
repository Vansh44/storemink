/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlText } from "./_test-helpers";

// Approval tokens are HMAC-signed, so the tests need a key to sign with.
process.env.POS_SESSION_SECRET = "unit-test-pos-secret-please-change";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/pos/operator", () => ({ resolvePosOperator: vi.fn() }));
vi.mock("@/lib/notifications/record", () => ({
  emitEvent: vi.fn(),
  recordEvent: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/inventory/alerts", () => ({ reportStockChanges: vi.fn() }));
vi.mock("@/lib/credit/store-credit", () => ({
  getCreditBalance: vi.fn(),
  getCreditBalances: vi.fn(),
  spendCredit: vi.fn(),
}));
vi.mock("@/lib/email/pos-receipt", async (orig) => ({
  // Keep the REAL rule — the point of these tests is that placePosSale asks it
  // correctly — and stub only the send.
  ...(await orig<Record<string, unknown>>()),
  sendPosReceipt: vi.fn(),
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: true })),
  clientIp: vi.fn(() => "1.2.3.4"),
}));
vi.mock("@/lib/settings/resolve", () => ({ getStoreSettings: vi.fn() }));
vi.mock("@/lib/pos/audit", () => ({ posAudit: vi.fn() }));
vi.mock("@/lib/payments/pos-gateway", () => ({
  counterGatewayKeyId: vi.fn(async () => null),
  startCounterPayment: vi.fn(),
  verifyCounterPayment: vi.fn(),
  verifyGatewayTenders: vi.fn(),
}));
// The drawer lookup is exercised in pos-shift-actions.test.ts; stubbing it here
// keeps it out of this file's seeded query sequence.
vi.mock("./pos-shift-actions", () => ({
  currentShiftIdFor: vi.fn(async () => null),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
// Offers are mocked at their own seam. Left real, `resolveOffersForCart` and
// `loadExhaustedOfferIds` read the offer tables and would consume entries from
// the shared db mock queue, shifting every later read. ★ The defaults are
// "offers unavailable" / "nothing exhausted", which is byte-for-byte today's
// behaviour, so every existing pricing and tender assertion is unchanged.
vi.mock("@/lib/offers/cart", () => ({
  resolveOffersForCart: vi.fn(async () => null),
  reserveOfferUses: vi.fn(async () => ({ ok: true, reserved: [] })),
  releaseOfferUses: vi.fn(async () => {}),
  recordOfferRedemptions: vi.fn(async () => {}),
  loadOffersForRegister: vi.fn(async () => ({
    offers: [],
    policy: {
      onSalePrice: "best",
      maxTotalDiscountPercent: 50,
      autoApply: false,
    },
  })),
  loadExhaustedOfferIds: vi.fn(async () => []),
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
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { withService } from "@/lib/db/client";
import { resolvePosOperator } from "@/lib/pos/operator";
import { getStoreSettings } from "@/lib/settings/resolve";
import { emitEvent } from "@/lib/notifications/record";
import { reportStockChanges } from "@/lib/inventory/alerts";
import {
  getCreditBalance,
  getCreditBalances,
  spendCredit,
} from "@/lib/credit/store-credit";
import { sendPosReceipt } from "@/lib/email/pos-receipt";
import {
  getCatalogSnapshot,
  placePosSale as placePosSaleAction,
  searchPosCustomers,
  createPosCustomer,
  createPosCheckoutCustomer,
  resolvePosCustomerByPhone,
  listPosSales,
} from "./pos-sale-actions";
import { saleFingerprint, signApprovalToken } from "@/lib/pos/approval";
import { orders, orderPayments } from "@/drizzle/schema";
import { verifyGatewayTenders } from "@/lib/payments/pos-gateway";
import { posAudit } from "@/lib/pos/audit";

const CASHIER = {
  role: "cashier" as const,
  storeId: "store-1",
  locationId: "loc-1",
  staffId: "st1",
  name: "Priya",
  source: "operator" as const,
  deviceAuthorized: true,
};

/** The store's superadmin ringing the till — the ONLY actor who may discount. */
const OWNER = {
  ...CASHIER,
  role: "superadmin" as const,
  staffId: null,
  name: "Vansh",
  source: "owner" as const,
};

/** A dashboard admin the owner delegated POS access to. Runs the till, but may
 *  not give money away — that is the point of the owner/superadmin split. */
const DELEGATED_ADMIN = { ...OWNER, role: "owner" as const, name: "Asha" };

const SETTINGS = {
  "pos.allowPriceOverride": true,
  // The default, stated explicitly: discounts are the owner's to give.
  "pos.ownerOnlyDiscounts": true,
  "pos.requireManagerForDiscount": true,
  "pos.maxDiscountPercent": 10,
} as any;

/** A merchant who has deliberately handed discounting to their staff, which is
 *  what re-arms the cap + manager-PIN machinery. */
const STAFF_MAY_DISCOUNT = {
  ...SETTINGS,
  "pos.ownerOnlyDiscounts": false,
} as any;

// A ₹100 product, 18% GST, exclusive pricing, supplier in state 07.
const PRODUCT = {
  id: "p1",
  name: "Cold Brew",
  selling_price: 100,
  tax_class_id: "tc1",
  hsn_code: "2202",
};
const BILLING = {
  store_id: "store-1",
  tax_enabled: true,
  prices_include_tax: false,
  default_tax_class_id: "tc1",
  gst_enabled: true,
};
const TAX_CLASS = { id: "tc1", name: "GST 18%", rate: 18, sort_order: 0 };

/**
 * placePosSale's reads, in order:
 * ★ THE ORDER IS SET BY THE READ WAVE'S INTERLEAVING (roadmap Step 20), not by
 * the order the values are USED in. The three batches start in Promise.all
 * array order and each runs synchronously up to its first await, so the first
 * select of each lands before any batch's second one:
 *
 *   round 0:  counter(customer, only when one is attached) · catalogue(products)
 *             · tax(billing) · till(location)
 *   round 1:  catalogue(variants, only when the cart has any) · tax(classes)
 *             · till(shift)
 *
 * `makeDbMock` consumes its queue when `db.select()` is CALLED, so this is
 * deterministic — but it does depend on the awaits above. ⚠ Adding an await to
 * any batch shifts every entry after it; if this becomes a nuisance the fix is
 * table-keyed responses in `makeDbMock`, not more comments here.
 * db.execute() calls (receipt seq, reserve_stock_at) come from executeQueue.
 */
function seedHappyPath(over: { productRows?: any[]; shiftRows?: any[] } = {}) {
  dbHolder.current = makeDbMock({
    selectQueue: [
      [{ id: "cust-1", email: null }], // customer ownership
      over.productRows ?? [PRODUCT], // products
      [BILLING], // billing (variants skipped: no variantIds)
      // ★ The receipt prefix rides on the location row now — it was a second
      // round trip on the sell path for a column already in flight.
      [{ state_code: "07", receipt_prefix: "DEL" }], // location
      [TAX_CLASS], // tax classes
      over.shiftRows ?? [], // open shift (none unless a test seeds one)
    ],
    executeQueue: [
      [{ seq: 42 }], // next_pos_receipt_no
      [{ reserved: true }], // reserve_stock_at
    ],
    returning: [{ id: "o1", order_ref: "ORD100110006" }],
  });
}

const line = { productId: "p1", variantId: null, quantity: 1 };
const cash = [{ method: "cash" as const, amount: 118, tendered: 200 }];

/** Checkout attaches a customer before every ordinary sale. Boundary tests
 *  that deliberately omit one call the real action directly. */
const placePosSale = (
  lines: Parameters<typeof placePosSaleAction>[0],
  tenders: Parameters<typeof placePosSaleAction>[1],
  opts: Parameters<typeof placePosSaleAction>[2] = {},
) =>
  placePosSaleAction(lines, tenders, {
    customerId: "cust-1",
    ...opts,
  });

/**
 * A genuine manager approval for a given cart, as verifyManagerPin would mint
 * it. Tests use the REAL token rather than a stubbed flag, so "an approval
 * doesn't unlock this" means the same thing here as at the till.
 */
function approvalFor(
  sale: { lines: any[]; orderDiscount?: number },
  op: { storeId: string; locationId: string; staffId: string | null } = CASHIER,
): string {
  return signApprovalToken({
    storeId: op.storeId,
    locationId: op.locationId,
    operatorId: op.staffId,
    approverId: "mgr-1",
    fingerprint: saleFingerprint(sale),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
  vi.mocked(getStoreSettings).mockResolvedValue(SETTINGS);
  // ⚠ clearAllMocks clears CALLS, not IMPLEMENTATIONS.
  vi.mocked(getCreditBalance).mockResolvedValue(0);
  vi.mocked(getCreditBalances).mockResolvedValue(new Map());
  vi.mocked(spendCredit).mockResolvedValue(true);
  // null = every gateway tender checks out. The RULE itself is tested in
  // lib/payments/pos-gateway.test.ts; these assert the WIRING.
  vi.mocked(verifyGatewayTenders).mockResolvedValue(null);
  seedHappyPath();
});

describe("placePosSale — gates", () => {
  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await placePosSale([line], cash)).error).toMatch(/signed out/i);
  });

  it("rejects an empty cart and a cart with no payment", async () => {
    expect((await placePosSale([], cash)).error).toMatch(/empty/i);
    expect((await placePosSale([line], [])).error).toMatch(/take a payment/i);
  });

  // ★ Still refused: no ledger stands behind a gift card, so accepting one
  // would mark a sale paid in full — and let the goods leave the shelf —
  // against money that never existed. This is a server action and the
  // register's JS is not its only caller.
  it("★ refuses a gift card — declared but unbuilt", async () => {
    const res = await placePosSale([line], [
      { method: "gift_card", amount: 100 },
    ] as never);
    expect(res.error).toMatch(/invalid payment method/i);
  });

  // ★★ Store credit IS settleable now (§29), but a balance belongs to
  // somebody: without an attached customer there is no account to draw on, and
  // the cashier needs to know the sale is short rather than find out at the
  // drawer.
  it("★ refuses store credit with no customer attached", async () => {
    const res = await placePosSaleAction([line], [
      { method: "store_credit", amount: 118 },
    ] as never);
    expect(res.error).toMatch(/customer.*mobile/i);
  });

  it("rejects invalid quantities and unknown tender methods", async () => {
    expect(
      (await placePosSale([{ ...line, quantity: 0 }], cash)).error,
    ).toMatch(/quantity/i);
    expect(
      (await placePosSale([{ ...line, quantity: 1.5 }], cash)).error,
    ).toMatch(/quantity/i);
    expect(
      (await placePosSale([line], [{ method: "crypto", amount: 5 } as any]))
        .error,
    ).toMatch(/payment method/i);
  });

  it("refuses a product that isn't in this store", async () => {
    seedHappyPath({ productRows: [] });
    expect((await placePosSale([line], cash)).error).toMatch(
      /no longer available/i,
    );
  });
});

describe("placePosSale — pricing is server-authoritative", () => {
  it("prices from the DB and computes GST, ignoring client-side money", async () => {
    const r = await placePosSale([line], cash);
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);

    const order = dbHolder.current.calls.values[0];
    // ₹100 + 18% = ₹118, priced entirely from the DB row.
    expect(order.subtotal).toBe(100);
    expect(order.tax).toBe(18);
    expect(order.total).toBe(118);
    expect(order.salesChannel).toBe("pos");
    expect(order.status).toBe("completed");
    expect(order.paymentStatus).toBe("paid");
    expect(order.customerId).toBe("cust-1");
    expect(order.shippingAddress).toBeNull();
    // Sale context for the receipt + reporting.
    expect(order.locationId).toBe("loc-1");
    expect(order.cashierId).toBe("st1");
    expect(order.cashierName).toBe("Priya");
    expect(r.receiptNo).toBe("DEL-000042");
  });

  it("splits GST into CGST+SGST for an intra-state sale", async () => {
    await placePosSale([line], cash);
    const items = dbHolder.current.calls.values[1];
    expect(items[0]).toMatchObject({
      taxAmount: 18,
      taxCgst: 9,
      taxSgst: 9,
      taxIgst: 0,
      hsnCode: "2202",
    });
  });

  it("returns change for an over-tender and records it", async () => {
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 200, tendered: 200 }],
    );
    expect(r.changeDue).toBe(82); // 200 - 118
    const payments = dbHolder.current.calls.values[2];
    expect(payments[0]).toMatchObject({
      method: "cash",
      amount: 200,
      changeDue: 82,
    });
  });

  it("refuses when the tenders don't cover the total", async () => {
    const r = await placePosSale([line], [{ method: "cash", amount: 50 }]);
    expect(r.error).toMatch(/doesn't cover/i);
    // Nothing was written.
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses a non-cash overpayment", async () => {
    // ★ The message changed when the overpayment rule landed: this used to be
    // caught by "only a cash payment can produce change", which is true and
    // tells a cashier nothing about the figure they mistyped. The refusal is
    // what matters, so that is what is asserted.
    const r = await placePosSale([line], [{ method: "card", amount: 500 }]);
    expect(r.error).toMatch(/can't be more than/i);
  });

  it("★★ refuses a card overpayment PROPPED UP by a token cash tender", async () => {
    // The hole this rule closes: a ₹1 cash tender satisfied the old
    // change-needs-cash check, so an arbitrary card amount was accepted and the
    // difference left the drawer as change.
    const r = await placePosSale(
      [line],
      [
        { method: "cash", amount: 1, tendered: 1 },
        { method: "card", amount: 100_000 },
      ],
    );
    expect(r.error).toMatch(/can't be more than/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("records split tenders as separate rows", async () => {
    const r = await placePosSale(
      [line],
      [
        { method: "cash", amount: 18, tendered: 18 },
        { method: "card", amount: 100, reference: "APPROVED-77" },
      ],
    );
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].paymentMethod).toBe("split");
    const payments = dbHolder.current.calls.values[2];
    expect(payments).toHaveLength(2);
    expect(payments[1]).toMatchObject({
      method: "card",
      amount: 100,
      reference: "APPROVED-77",
    });
  });
});

// ★ The default: giving money away belongs to the owner.
describe("placePosSale — only the owner may discount", () => {
  it("refuses a cashier's order discount OUTRIGHT, not for approval", async () => {
    const r = await placePosSale([line], [{ method: "cash", amount: 1 }], {
      orderDiscount: 50,
    });
    expect(r.error).toMatch(/only the owner/i);
    // Not `needsApproval` — that would put a PIN prompt on screen and let a
    // manager wave it through.
    expect(r.needsApproval).toBeUndefined();
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses a MANAGER's discount too", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue({
      ...CASHIER,
      role: "manager",
    } as any);
    const r = await placePosSale([line], [{ method: "cash", amount: 1 }], {
      orderDiscount: 50,
    });
    expect(r.error).toMatch(/only the owner/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ cannot be unlocked with a manager's PIN", async () => {
    // The manager is one of the people being kept out, so their own PIN must
    // not be the key. This is the whole point of refusing rather than queuing.
    // Note the approval here is REAL and correctly signed — it still doesn't
    // open this door.
    const r = await placePosSale([line], [{ method: "cash", amount: 1 }], {
      orderDiscount: 50,
      approvalToken: approvalFor({ lines: [line], orderDiscount: 50 }),
    });
    expect(r.error).toMatch(/only the owner/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ blocks a per-line markdown as well", async () => {
    // Otherwise "Less ₹50" on the line does exactly what "Discount ₹50" is
    // forbidden from doing, and the rule is a rule in name only.
    const r = await placePosSale(
      [{ ...line, quantity: 2, lineDiscount: 50 }],
      [{ method: "cash", amount: 1 }],
    );
    expect(r.error).toMatch(/only the owner/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ refuses a DELEGATED dashboard admin too", async () => {
    // POS access is delegable; discounting is not. Otherwise "owner only" would
    // quietly mean "anyone the owner ever gave a dashboard login with POS on".
    vi.mocked(resolvePosOperator).mockResolvedValue(DELEGATED_ADMIN as any);
    const r = await placePosSale([line], [{ method: "cash", amount: 1 }], {
      orderDiscount: 50,
    });
    expect(r.error).toMatch(/only the owner/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("lets the owner discount", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(OWNER as any);
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      { orderDiscount: 50 },
    );
    expect(r.success).toBe(true);
    const order = dbHolder.current.calls.values[0];
    expect(order.discount).toBe(50);
    // ₹100 − ₹50 discount = ₹50 taxable, +18% = ₹59.
    expect(order.total).toBe(59);
  });

  it("a sale with no discount is unaffected", async () => {
    expect((await placePosSale([line], cash)).success).toBe(true);
  });
});

// ★ A price override is a discount by another name, so it answers to the same
// rule. Leaving it open would have made the block above decorative — a manager
// would just reprice the line instead.
describe("placePosSale — only the owner may override a price", () => {
  const cheap = { ...line, priceOverride: 50 };

  it("refuses a cashier", async () => {
    const r = await placePosSale(
      [cheap],
      [{ method: "cash", amount: 59, tendered: 59 }],
    );
    expect(r.error).toMatch(/only the owner can change a price/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses a manager, and a manager's PIN doesn't help", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue({
      ...CASHIER,
      role: "manager",
    } as any);
    const r = await placePosSale(
      [cheap],
      [{ method: "cash", amount: 59, tendered: 59 }],
      { approvalToken: approvalFor({ lines: [cheap] }) },
    );
    expect(r.error).toMatch(/only the owner can change a price/i);
    expect(r.needsApproval).toBeUndefined();
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses a delegated dashboard admin", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(DELEGATED_ADMIN as any);
    const r = await placePosSale(
      [cheap],
      [{ method: "cash", amount: 59, tendered: 59 }],
    );
    expect(r.error).toMatch(/only the owner can change a price/i);
  });

  it("lets the owner reprice a line", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(OWNER as any);
    const r = await placePosSale(
      [cheap],
      [{ method: "cash", amount: 59, tendered: 59 }],
    );
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].subtotal).toBe(50);
    expect(dbHolder.current.calls.values[1][0].price).toBe(50);
  });

  // The merchant's own on/off switch still comes first — it is a store policy,
  // not a permission, so it stops the owner too.
  it("respects pos.allowPriceOverride being off, even for the owner", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(OWNER as any);
    vi.mocked(getStoreSettings).mockResolvedValue({
      ...SETTINGS,
      "pos.allowPriceOverride": false,
    } as any);
    const r = await placePosSale(
      [cheap],
      [{ method: "cash", amount: 59, tendered: 59 }],
    );
    expect(r.error).toMatch(/turned off/i);
  });

  it("falls back to the manager-PIN flow when staff may discount", async () => {
    vi.mocked(getStoreSettings).mockResolvedValue(STAFF_MAY_DISCOUNT);
    const asCashier = await placePosSale(
      [cheap],
      [{ method: "cash", amount: 59, tendered: 59 }],
    );
    expect(asCashier.needsApproval).toBe(true);

    vi.mocked(resolvePosOperator).mockResolvedValue({
      ...CASHIER,
      role: "manager",
    } as any);
    seedHappyPath();
    const asManager = await placePosSale(
      [cheap],
      [{ method: "cash", amount: 59, tendered: 59 }],
    );
    expect(asManager.success).toBe(true);
  });
});

// The pre-existing cap machinery, which now applies only to a merchant who has
// deliberately handed discounting to their staff.
describe("placePosSale — the cap, when staff may discount", () => {
  beforeEach(() => {
    vi.mocked(getStoreSettings).mockResolvedValue(STAFF_MAY_DISCOUNT);
  });

  it("blocks a cashier discounting past the cap", async () => {
    const r = await placePosSale([line], [{ method: "cash", amount: 1 }], {
      orderDiscount: 50, // 50% of a ₹100 sale, cap is 10%
    });
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  // ★ A DELIBERATE 0 MUST SURVIVE. The cap was read as `Number(...) || 10`, so
  // a merchant who set it to 0 — "a cashier needs approval for ANY discount",
  // and `min: 0` in the registry says that is a legal setting — silently got
  // the 10% default instead, handing cashiers exactly the authority they had
  // withheld. 5% of a ₹100 sale passed under the swallowed default and must
  // now stop.
  it("treats a 0% cap as approval-for-any-discount, not the 10% default", async () => {
    vi.mocked(getStoreSettings).mockResolvedValue({
      ...STAFF_MAY_DISCOUNT,
      "pos.maxDiscountPercent": 0,
    } as any);
    const r = await placePosSale([line], [{ method: "cash", amount: 200 }], {
      orderDiscount: 5,
    });
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  // The other half of the same rule: 0 must not become "refuse everything"
  // either — a sale with no discount at all is untouched by the cap.
  it("still rings a sale with no discount under a 0% cap", async () => {
    vi.mocked(getStoreSettings).mockResolvedValue({
      ...STAFF_MAY_DISCOUNT,
      "pos.maxDiscountPercent": 0,
    } as any);
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 118, tendered: 118 }],
    );
    expect(r.success).toBe(true);
  });

  it("allows a cashier under the cap with no approval", async () => {
    // ₹100 − ₹10 = ₹90 taxable, +18% = ₹106.20. Tender ₹110.
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 110, tendered: 110 }],
      { orderDiscount: 10 }, // exactly the 10% cap
    );
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].discount).toBe(10);
  });

  it("allows it once a manager PIN has approved", async () => {
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      {
        orderDiscount: 50,
        approvalToken: approvalFor({ lines: [line], orderDiscount: 50 }),
      },
    );
    expect(r.error).toBeUndefined();
    const order = dbHolder.current.calls.values[0];
    expect(order.discount).toBe(50);
    expect(order.total).toBe(59);
  });

  // ── The approval must be a GRANT, not a claim ────────────────────────────
  // These are the regression tests for the bypass this replaced: the action
  // took `managerApproved: true` straight from the client, so a cashier with
  // devtools could ring any discount without a manager ever being present.

  it("★ refuses a claimed approval with no token at all", async () => {
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      { orderDiscount: 50, approvalToken: "true" },
    );
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ refuses a token signed with the wrong key", async () => {
    const saved = process.env.POS_SESSION_SECRET;
    process.env.POS_SESSION_SECRET = "an-attacker's-key";
    const forged = approvalFor({ lines: [line], orderDiscount: 50 });
    process.env.POS_SESSION_SECRET = saved;

    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      { orderDiscount: 50, approvalToken: forged },
    );
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ refuses an approval given for a SMALLER discount", async () => {
    // The manager looked at ₹10 off and said yes. Replaying that on ₹50 off is
    // the bypass the fingerprint exists to stop.
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      {
        orderDiscount: 50,
        approvalToken: approvalFor({ lines: [line], orderDiscount: 10 }),
      },
    );
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ refuses an approval given for a different cart", async () => {
    // Approved: ₹100 off one unit. Submitted: ₹100 off FIVE — still over the
    // cap, but not the sale anybody agreed to.
    const r = await placePosSale(
      [{ ...line, quantity: 5 }],
      [{ method: "cash", amount: 472, tendered: 472 }],
      {
        orderDiscount: 100,
        approvalToken: approvalFor({ lines: [line], orderDiscount: 100 }),
      },
    );
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("★ refuses an approval minted at another till", async () => {
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      {
        orderDiscount: 50,
        approvalToken: approvalFor(
          { lines: [line], orderDiscount: 50 },
          { ...CASHIER, locationId: "loc-2" },
        ),
      },
    );
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("survives the cart being re-ordered between approval and sale", async () => {
    // The fingerprint sorts its lines: an approval a manager really did give
    // must not evaporate because the UI rebuilt the cart in another order.
    const other = { productId: "p0", variantId: null, quantity: 1 };
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ id: "cust-1", email: null }],
        [PRODUCT, { ...PRODUCT, id: "p0", selling_price: 0 }],
        [BILLING],
        [{ state_code: "07", receipt_prefix: "DEL" }],
        [TAX_CLASS],
        [],
      ],
      executeQueue: [[{ seq: 42 }], [{ reserved: true }], [{ reserved: true }]],
      returning: [{ id: "o1", order_ref: "ORD100110006" }],
    });

    const r = await placePosSale(
      [line, other],
      [{ method: "cash", amount: 59, tendered: 59 }],
      {
        orderDiscount: 50,
        approvalToken: approvalFor({
          lines: [other, line],
          orderDiscount: 50,
        }),
      },
    );
    expect(r.needsApproval).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it("lets a manager discount freely", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue({
      ...CASHIER,
      role: "manager",
    } as any);
    const r = await placePosSale(
      [line],
      [{ method: "cash", amount: 59, tendered: 59 }],
      { orderDiscount: 50 },
    );
    expect(r.needsApproval).toBeUndefined();
    expect(r.success).toBe(true);
  });
});

describe("placePosSale — stock", () => {
  it("reserves at the register's location", async () => {
    await placePosSale([line], cash);
    const reserveCall = dbHolder.current.calls.execute.find((c: any) =>
      sqlText(c).includes("reserve_stock_at"),
    );
    expect(reserveCall).toBeTruthy();
    expect(sqlText(reserveCall)).toContain("p_location");
  });

  // REGRESSION (POS merge). A register sale wrote an orders row and nothing
  // else: no activity_events entry, no "new order" alert for the team, and no
  // low-stock warning even when it emptied the shelf. The one sales channel
  // physically in front of the merchant was the one they couldn't see.
  it("records the sale as an order.placed event", async () => {
    await placePosSale([line], cash);

    const call = vi
      .mocked(emitEvent)
      .mock.calls.find(([input]) => input?.type === "order.placed");
    expect(call, "a POS sale must emit order.placed").toBeTruthy();
    expect(call![0]).toMatchObject({
      storeId: "store-1",
      payload: { channel: "In-store" },
    });
  });

  it("reports the stock it took, so a shelf it empties still warns", async () => {
    await placePosSale([line], cash);

    expect(reportStockChanges).toHaveBeenCalledWith(
      "store-1",
      // Signed NEGATIVE — stockAlertFor compares before/after, so a sale that
      // crosses the threshold has to look like a decrease.
      expect.arrayContaining([expect.objectContaining({ delta: -1 })]),
    );
  });

  // Overselling must fail the whole sale, not silently sell air.
  it("rolls the order back when stock is short", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ id: "cust-1", email: null }],
        [PRODUCT],
        [BILLING],
        [{ state_code: "07", receipt_prefix: "DEL" }],
        [TAX_CLASS],
        [],
      ],
      executeQueue: [[{ seq: 43 }], [{ reserved: false }]],
      returning: [{ id: "o1", order_ref: "ORD1" }],
    });

    const r = await placePosSale([line], cash);
    expect(r.error).toMatch(/not enough stock/i);
    // The order row that was created first is deleted again.
    expect(dbHolder.current.calls.delete).toHaveLength(1);
  });
});

describe("getCatalogSnapshot", () => {
  // Two reads per page: the page of product ids, then their sellable SKUs.
  const page = (ids: string[], rows: any[]) => [
    ids.map((id) => ({ id, status: "published" })),
    rows,
  ];
  const row = (over: any = {}) => ({
    product_id: "p1",
    variant_id: null,
    name: "Cold Brew",
    variant_name: null,
    p_sku: "SKU1",
    v_sku: null,
    p_barcode: "890123",
    v_barcode: null,
    p_price: 100,
    v_price: null,
    v_special: null,
    p_image: "https://img/x.webp",
    v_image: null,
    p_track: true,
    v_track: null,
    p_backorder: false,
    v_backorder: null,
    p_stock: 999,
    v_stock: null,
    loc_stock: 4,
    ...over,
  });

  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    const r = await getCatalogSnapshot();
    expect(r.error).toMatch(/signed in/i);
    expect(r.items).toEqual([]);
  });

  it("refuses a role that can't sell", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue({
      ...CASHIER,
      role: "nobody",
    } as any);
    expect((await getCatalogSnapshot()).error).toMatch(/not allowed/i);
  });

  // The whole point of the cache: it must carry stock for THIS register's
  // location, not the cross-location aggregate in products.stock.
  it("reports stock at the operator's location, not the aggregate", async () => {
    dbHolder.current = makeDbMock({ selectQueue: page(["p1"], [row()]) });
    const r = await getCatalogSnapshot();
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      productId: "p1",
      barcode: "890123",
      price: 100,
      image: "https://img/x.webp",
      stock: 4,
    });
    expect(r.watermark).toBeTruthy();
  });

  it("prefers a variant's special price and falls back to the product image", () => {
    dbHolder.current = makeDbMock({
      selectQueue: page(
        ["p1"],
        [
          row({
            variant_id: "v1",
            variant_name: "Large",
            v_price: 150,
            v_special: 120,
            v_image: null,
            v_track: true,
            loc_stock: 2,
          }),
        ],
      ),
    });
    return getCatalogSnapshot().then((r) => {
      expect(r.items[0]).toMatchObject({
        variantId: "v1",
        price: 120,
        image: "https://img/x.webp",
        stock: 2,
      });
    });
  });

  it("ends paging with a null cursor on a short page", async () => {
    dbHolder.current = makeDbMock({ selectQueue: page(["p1"], [row()]) });
    expect((await getCatalogSnapshot()).nextCursor).toBeNull();
  });

  it("returns an empty page (not an error) once the catalog is drained", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const r = await getCatalogSnapshot("p-last");
    expect(r).toMatchObject({ items: [], nextCursor: null });
    expect(r.error).toBeUndefined();
  });

  // Keyset paging, not OFFSET — pages stay stable while the catalog is edited.
  it("pages forward from the cursor", async () => {
    dbHolder.current = makeDbMock({ selectQueue: page(["p2"], [row()]) });
    await getCatalogSnapshot("p1");
    expect(sqlText(dbHolder.current.calls.where[0])).toMatch(/>/);
  });

  // An empty catalog and an unreachable database look identical to the
  // register otherwise — and one of them must not silently blank the grid.
  it("surfaces a DB failure instead of reporting an empty catalog", async () => {
    vi.mocked(withService).mockRejectedValueOnce(new Error("connection reset"));
    const r = await getCatalogSnapshot();
    expect(r.error).toBeTruthy();
    expect(r.items).toEqual([]);
  });

  it("pages withdrawn products through the same delta cursor", async () => {
    const withdrawn = Array.from({ length: 300 }, (_, index) => ({
      id: `p-${String(index).padStart(3, "0")}`,
      status: "draft",
    }));
    dbHolder.current = makeDbMock({ selectQueue: [withdrawn] });

    const r = await getCatalogSnapshot(null, "2026-08-22T09:00:00.000Z");
    expect(r.items).toEqual([]);
    expect(r.removedProductIds).toHaveLength(300);
    expect(r.nextCursor).toBe("p-299");
    // No second, capped removals query: the changed-row page is the removal
    // page, and a cursor can drain the next 300.
    expect(dbHolder.current.calls.select).toHaveLength(1);
  });
});

describe("placePosSale — customer attach", () => {
  // With a customerId the ownership lookup runs FIRST, ahead of the pricing
  // reads, so the queue gains a leading row.
  const seedWithCustomer = (owner: any[]) =>
    (dbHolder.current = makeDbMock({
      selectQueue: [
        owner, // 0 users (ownership check)
        [PRODUCT],
        [BILLING],
        [{ state_code: "07", receipt_prefix: "DEL" }],
        [TAX_CLASS],
        [],
      ],
      executeQueue: [[{ seq: 42 }], [{ reserved: true }]],
      returning: [{ id: "o1", order_ref: "ORD100110006" }],
    }));

  it("attaches a customer who belongs to this store", async () => {
    seedWithCustomer([{ id: "cust-1" }]);
    const r = await placePosSale([line], cash, { customerId: "cust-1" });
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].customerId).toBe("cust-1");
  });

  // THE tenant-isolation guarantee. Without the ownership check the sale would
  // be filed against another store's customer, who holds RLS SELECT on their
  // own orders and would then see a foreign order in their history.
  it("refuses a customer id belonging to another store", async () => {
    seedWithCustomer([]); // no row matches (id AND store_id)
    const r = await placePosSale([line], cash, { customerId: "other-store" });
    expect(r.error).toMatch(/isn't in this store/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses a blank customer id instead of recording a walk-in", async () => {
    const r = await placePosSaleAction([line], cash, { customerId: "   " });
    expect(r.error).toMatch(/customer.*mobile/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });
});

describe("placePosSale — GSTIN", () => {
  it("normalises a valid GSTIN to upper case", async () => {
    const r = await placePosSale([line], cash, {
      customerGstin: " 22aaaaa0000a1z5 ",
    });
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].customerGstin).toBe(
      "22AAAAA0000A1Z5",
    );
  });

  // It prints on the customer's invoice, so a malformed one is rejected at the
  // boundary rather than immortalised on a document.
  it("rejects a malformed GSTIN before writing anything", async () => {
    const r = await placePosSale([line], cash, {
      customerGstin: "NOT-A-GSTIN",
    });
    expect(r.error).toMatch(/gstin/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("treats a blank GSTIN as absent", async () => {
    const r = await placePosSale([line], cash, { customerGstin: "  " });
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].customerGstin).toBeNull();
  });
});

describe("placePosSale — line discounts", () => {
  const twoOf = { productId: "p1", variantId: null, quantity: 2 };

  // The arithmetic is what's under test here, so these run as the owner — the
  // only actor allowed to mark a line down by default. Who MAY is covered in
  // "only the owner may discount" above.
  beforeEach(() => {
    vi.mocked(resolvePosOperator).mockResolvedValue(OWNER as any);
  });

  it("reduces the line amount and the order total", async () => {
    // 2 x ₹100 = ₹200, less ₹30 = ₹170, +18% = ₹200.60 -> 201
    const r = await placePosSale(
      [{ ...twoOf, lineDiscount: 30 }],
      [{ method: "cash", amount: 201, tendered: 201 }],
    );
    expect(r.success).toBe(true);
    const order = dbHolder.current.calls.values[0];
    expect(order.subtotal).toBe(200);
    expect(order.discount).toBe(30);
    const items = dbHolder.current.calls.values[1];
    expect(items[0].lineDiscount).toBe(30);
    expect(items[0].total).toBe(170);
  });

  // A markdown larger than the line would otherwise make the line negative and
  // quietly discount the rest of the sale.
  it("caps a line discount at the line's own value", async () => {
    const r = await placePosSale(
      [{ ...twoOf, lineDiscount: 9999 }],
      [{ method: "cash", amount: 1, tendered: 1 }],
    );
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].discount).toBe(200);
    expect(dbHolder.current.calls.values[1][0].total).toBe(0);
  });

  // The cap is on TOTAL generosity — line and order discounts together — so a
  // cashier can't stay under it by splitting the giveaway across both. Only
  // reachable once a merchant has let staff discount at all.
  it("counts line discounts toward the manager-approval cap", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
    vi.mocked(getStoreSettings).mockResolvedValue(STAFF_MAY_DISCOUNT);
    const r = await placePosSale(
      [{ ...twoOf, lineDiscount: 50 }], // 25% of ₹200; cap is 10%
      [{ method: "cash", amount: 1 }],
    );
    expect(r.needsApproval).toBe(true);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  // Rejected before it becomes a discount at all — so it must not trip the
  // owner-only gate either. Run as a CASHIER precisely to prove that.
  it("ignores a negative or non-numeric line discount", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
    const r = await placePosSale(
      [{ ...twoOf, lineDiscount: -50 }],
      [{ method: "cash", amount: 236, tendered: 236 }],
    );
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].discount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Emailing a receipt to a walk-in (roadmap Step 4).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Store credit as a till tender (§29). The ledger existed and online checkout
// spent it; the counter refused it, so a shop could refund a customer to credit
// across the counter and then not accept it at the same counter.
// ---------------------------------------------------------------------------
describe("placePosSale — store credit", () => {
  /** The ownership read comes first, then the happy-path queue. */
  function seedWithCustomer() {
    dbHolder.current = makeDbMock({
      // Read-wave order with a customer attached (see seedHappyPath):
      // round 0 customer · products · billing · location,
      // round 1 tax classes · shift.
      selectQueue: [
        [{ id: "cust-1", email: null }],
        [PRODUCT],
        [BILLING],
        [{ state_code: "07", receipt_prefix: "DEL" }],
        [TAX_CLASS],
        [], // no open shift
      ],
      executeQueue: [[{ seq: 42 }], [{ reserved: true }]],
      returning: [{ id: "o1", order_ref: "ORD100110006" }],
    });
  }

  const creditOnly = [{ method: "store_credit" as const, amount: 118 }];

  it("settles a sale entirely from the balance", async () => {
    seedWithCustomer();
    vi.mocked(getCreditBalance).mockResolvedValue(500);
    const r = await placePosSale([line], creditOnly, { customerId: "cust-1" });
    expect(r.success).toBe(true);
    expect(spendCredit).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store-1",
        customerId: "cust-1",
        amount: 118,
        // The order id is generated before the insert, so it is asserted
        // against the one the sale reports rather than a literal — the point is
        // that the ledger row references THIS order.
        orderId: r.orderId,
      }),
    );
  });

  // ★ CREDIT IS A PAYMENT, NOT A DISCOUNT. Netting it off `total` would
  // understate the sale, compute GST on the wrong base, and make a later credit
  // note reverse the wrong amount.
  it("keeps the FULL total and records what the balance settled", async () => {
    seedWithCustomer();
    vi.mocked(getCreditBalance).mockResolvedValue(500);
    await placePosSale([line], creditOnly, { customerId: "cust-1" });
    const order = dbHolder.current.calls.values[0];
    expect(order.total).toBe(118);
    expect(order.storeCreditUsed).toBe(118);
  });

  // ★★ ZERO, NEVER NULL — this test used to assert `toBeNull()` and that is
  // exactly what kept the outage in place. `orders.store_credit_used` is
  // `NOT NULL DEFAULT 0`; an explicit NULL does not fall back to the DEFAULT, it
  // violates the constraint. So every till on the platform failed on insert with
  // "Couldn't record the sale", on sales that never touched store credit. The
  // mock db enforces no constraints, so the green test proved only that the
  // wrong value was being sent consistently.
  it("records zero store credit on an ordinary cash sale", async () => {
    const r = await placePosSale([line], cash);
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].storeCreditUsed).toBe(0);
    expect(spendCredit).not.toHaveBeenCalled();
  });

  it("splits with another tender", async () => {
    seedWithCustomer();
    vi.mocked(getCreditBalance).mockResolvedValue(50);
    const r = await placePosSale(
      [line],
      [
        { method: "store_credit", amount: 50 },
        { method: "cash", amount: 68 },
      ],
      { customerId: "cust-1" },
    );
    expect(r.success).toBe(true);
    expect(vi.mocked(spendCredit).mock.calls[0][0].amount).toBe(50);
  });

  // The pre-check exists so the cashier gets the real balance in the message,
  // rather than a bare refusal after the customer has been told a total.
  it("refuses when the balance doesn't cover it, and says the balance", async () => {
    seedWithCustomer();
    vi.mocked(getCreditBalance).mockResolvedValue(40);
    const r = await placePosSale([line], creditOnly, { customerId: "cust-1" });
    expect(r.error).toMatch(/40/);
    expect(spendCredit).not.toHaveBeenCalled();
    expect(dbHolder.current.calls.values).toHaveLength(0);
  });

  // ★★ THE RACE. The pre-check passed and the balance moved underneath us —
  // the customer spent it at another till. try_spend_customer_credit is a
  // single conditional UPDATE, so it refuses rather than overdrawing, and the
  // sale must UNWIND rather than complete unpaid.
  it("rolls the sale back when the balance moved underneath it", async () => {
    seedWithCustomer();
    vi.mocked(getCreditBalance).mockResolvedValue(500);
    vi.mocked(spendCredit).mockResolvedValue(false);

    const r = await placePosSale([line], creditOnly, { customerId: "cust-1" });
    expect(r.success).toBeUndefined();
    expect(r.error).toMatch(/just used elsewhere/i);
    // The order row is deleted and the stock released — a sale that took no
    // money must not leave goods off the shelf.
    expect(dbHolder.current.calls.delete.length).toBeGreaterThan(0);
  });

  it("never touches the balance for a sale that fails earlier", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    await placePosSale([line], creditOnly, { customerId: "cust-1" });
    expect(spendCredit).not.toHaveBeenCalled();
  });
});

describe("placePosSale — receipt email", () => {
  it("sends one to a walk-in who asked for it", async () => {
    const r = await placePosSale([line], cash, {
      receiptEmail: "asha@example.com",
    });
    expect(r.success).toBe(true);
    expect(sendPosReceipt).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(sendPosReceipt).mock.calls[0][0];
    expect(sent.to).toBe("asha@example.com");
    expect(sent.storeId).toBe("store-1");
    // The SAME figures the thermal receipt prints, so paper and inbox agree.
    expect(sent.summary.total).toBe(118);
    expect(sent.summary.items?.[0]?.name).toBeTruthy();
  });

  it("sends nothing when nobody asked", async () => {
    await placePosSale([line], cash);
    expect(sendPosReceipt).not.toHaveBeenCalled();
  });

  // ★ A typo in an OPTIONAL field must never fail a sale that has already taken
  // money and moved stock (invariant 6).
  it("drops an unusable address instead of refusing the sale", async () => {
    const r = await placePosSale([line], cash, {
      receiptEmail: "not-an-email",
    });
    expect(r.success).toBe(true);
    expect(sendPosReceipt).not.toHaveBeenCalled();
  });

  it("normalises the address it sends to", async () => {
    await placePosSale([line], cash, {
      receiptEmail: "  ASHA@Example.COM  ",
    });
    expect(vi.mocked(sendPosReceipt).mock.calls[0][0].to).toBe(
      "asha@example.com",
    );
  });

  // The ownership check reads the customer FIRST, so its row goes at the head
  // of the happy-path queue. ⚠ Getting this wrong makes the sale fail, and a
  // failed sale sends no receipt — so a "does not send" assertion would pass
  // for entirely the wrong reason. Both cases assert success as well.
  function seedWithCustomer(email: string | null) {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [{ id: "cust-1", email }], // 0 customer ownership + address
        [PRODUCT], // 1 products
        [BILLING], // 2 billing
        [TAX_CLASS], // 3 tax classes
        [{ state_code: "07" }], // 4 location state
        [{ prefix: "DEL" }], // 5 receipt prefix
      ],
      executeQueue: [[{ seq: 42 }], [{ reserved: true }]],
      returning: [{ id: "o1", order_ref: "ORD100110006" }],
    });
  }

  // ★ ONE RECEIPT, NEVER TWO. An attached customer with an address already gets
  // the order.placed fan-out's confirmation.
  it("does NOT send when the attached customer will get the fan-out's copy", async () => {
    seedWithCustomer("cust@example.com");
    const r = await placePosSale([line], cash, {
      customerId: "cust-1",
      receiptEmail: "asha@example.com",
    });
    expect(r.success).toBe(true); // or the assertion below is vacuous
    expect(sendPosReceipt).not.toHaveBeenCalled();
  });

  it("DOES send for an attached customer with no address on file", async () => {
    seedWithCustomer(null);
    const r = await placePosSale([line], cash, {
      customerId: "cust-1",
      receiptEmail: "asha@example.com",
    });
    expect(r.success).toBe(true);
    expect(sendPosReceipt).toHaveBeenCalledTimes(1);
  });
});

describe("createPosCustomer", () => {
  beforeEach(() => {
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
  });

  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect(
      (await createPosCustomer({ name: "A", phone: "9876543210" })).error,
    ).toMatch(/signed in/i);
  });

  // ★ `sell`, not a manager grant: recording who bought something is part of
  // ringing up a sale, and gating it above the counter means it never happens.
  it("is open to a cashier", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "pos_abc" }] });
    const r = await createPosCustomer({ name: "Asha", phone: "9876543210" });
    expect(r.error).toBeUndefined();
    expect(r.customer?.id).toBe("pos_abc");
  });

  it("validates before it writes", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "pos_abc" }] });
    const r = await createPosCustomer({ name: "Asha", phone: "12345" });
    expect(r.error).toMatch(/mobile/i);
    expect(dbHolder.current.calls.values).toHaveLength(0);
  });

  // ★ The id shape IS the claim mechanism and IS what keeps the row unreadable
  // by every session (customer RLS matches auth.uid() against users.id).
  it("writes a pos_ id, scoped to the operator's store", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "pos_abc" }] });
    await createPosCustomer({ name: "Asha Rao", phone: "+91 98765 43210" });
    const row = dbHolder.current.calls.values[0];
    expect(row.id).toMatch(/^pos_/);
    expect(row.storeId).toBe(CASHIER.storeId);
    // Canonical E.164, so a later signup lands on the same string.
    expect(row.phone).toBe("+919876543210");
    expect(row.firstName).toBe("Asha");
    expect(row.lastName).toBe("Rao");
  });

  it("never lets the caller choose the store", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "pos_abc" }] });
    await createPosCustomer({
      name: "Asha",
      phone: "9876543210",
      // @ts-expect-error — not in the input type; the point is it is ignored.
      storeId: "00000000-0000-4000-8000-000000000009",
    });
    expect(dbHolder.current.calls.values[0].storeId).toBe(CASHIER.storeId);
  });

  // ★ A cashier who mistyped a search and typed the number by hand meant
  // "this person" — answering "already exists" leaves them re-searching with a
  // queue behind them. It leaks nothing: the search would have found this row.
  it("does not insert a duplicate for a number stored in the +91 shape", async () => {
    // ⚠ The unique key is on the phone STRING, so inserting "9876543210"
    // would NOT conflict with an existing "+919876543210" and the conflict
    // path would never run. Every shape has to be checked before the insert.
    const onFile = {
      id: "firebase-uid",
      phone: "+919876543210",
      email: "asha@example.com",
      first_name: "Asha",
      last_name: "Rao",
    };
    dbHolder.current = makeDbMock({
      returning: [],
      selectQueue: [[onFile], [onFile]],
    });
    const r = await createPosCustomer({ name: "Asha", phone: "9876543210" });
    expect(dbHolder.current.calls.insert).toHaveLength(0);
    expect(r.customer).toMatchObject({ id: "firebase-uid", name: "Asha Rao" });
  });

  it("attaches the existing customer when the phone is already on file", async () => {
    const onFile = {
      id: "existing-uid",
      phone: "9876543210",
      email: "a@x.com",
      first_name: "Asha",
      last_name: "Rao",
    };
    dbHolder.current = makeDbMock({
      returning: [],
      // Two reads now: the pre-check that looks for EVERY shape the number may
      // be stored in — without which inserting the national form would not
      // conflict with an E.164 row and would create a duplicate — and then the
      // read that hands the existing customer back.
      selectQueue: [[onFile], [onFile]],
    });
    const r = await createPosCustomer({ name: "Asha", phone: "9876543210" });
    expect(r.error).toBeUndefined();
    expect(r.customer).toEqual({
      id: "existing-uid",
      name: "Asha Rao",
      phone: "9876543210",
      email: "a@x.com",
      // An EXISTING customer may already hold credit, so the balance is read
      // and comes back with them. (The mock's queue is exhausted here, which
      // reads as no balance.)
      storeCredit: 0,
    });
  });

  it("reports an error when the conflict lookup finds nothing", async () => {
    dbHolder.current = makeDbMock({ returning: [], selectQueue: [[]] });
    expect(
      (await createPosCustomer({ name: "A", phone: "9876543210" })).error,
    ).toBeTruthy();
  });
});

describe("resolvePosCustomerByPhone", () => {
  beforeEach(() => {
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
  });

  it("refuses a number of the wrong length for the chosen country", async () => {
    dbHolder.current = makeDbMock();
    expect((await resolvePosCustomerByPhone("12345")).error).toMatch(
      /10-digit number for \+91/i,
    );
    // A country with a different length rule gets its own message; the old
    // one named India for every failure.
    expect(
      (await resolvePosCustomerByPhone("9876543210", "+65")).error,
    ).toMatch(/8-digit number for \+65/i);
    expect(dbHolder.current.calls.select).toHaveLength(0);
  });

  it("looks up a placeholder number instead of refusing it", async () => {
    // ★★ OWNER'S DECISION (2026-09-11). The rejection was the COURIER's rule
    // (Shiprocket cannot book 8888888888) borrowed for customer identity,
    // where it does not belong — recording a walk-in is not booking a parcel.
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const r = await resolvePosCustomerByPhone("8888888888");
    expect(r.error).toBeUndefined();
    expect(r.notFound).toBe(true);
  });

  it("reports a new number instead of inventing a nameless customer", async () => {
    // ★ THE BUG THIS FIXES. It used to INSERT on a miss, which is how a shop
    // filled up with "Customer / no email" rows: the lookup could not see an
    // account stored in the other phone shape, so it invented a duplicate.
    // A miss is now reported so the cashier can put a name to the number.
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const result = await resolvePosCustomerByPhone("+91 98765 43210");
    expect(result).toEqual({ notFound: true });
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("finds a customer the website stored in the +91 shape", async () => {
    // ★★ THE REPORTED DEFECT, PINNED. Identity Platform hands signup an E.164
    // number and it was written through untouched, while the till searched for
    // the national form — so a shopper with an account was invisible at the
    // counter and got a second row. Both shapes are matched now.
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "firebase-uid",
            phone: "+919877542162",
            email: "rohan@example.com",
            first_name: "Rohan",
            last_name: "Sharma",
            store_credit: 0,
          },
        ],
      ],
    });
    const result = await resolvePosCustomerByPhone("9877542162");
    expect(result.customer).toMatchObject({
      id: "firebase-uid",
      name: "Rohan Sharma",
      email: "rohan@example.com",
    });
    expect(result.notFound).toBeUndefined();
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("returns the existing customer's name, email, and credit after a conflict", async () => {
    dbHolder.current = makeDbMock({
      returning: [],
      selectQueue: [
        [
          {
            id: "cust-1",
            phone: "9876543210",
            email: "asha@example.com",
            first_name: "Asha",
            last_name: "Rao",
            store_credit: 240,
          },
        ],
      ],
    });
    const result = await resolvePosCustomerByPhone("9876543210");
    expect(result).toEqual({
      customer: {
        id: "cust-1",
        name: "Asha Rao",
        phone: "9876543210",
        email: "asha@example.com",
        storeCredit: 240,
      },
      // Both ride along with the lookup so the till can re-price for this
      // customer without a second round trip — their own offer caps, and
      // whether a first-order offer applies. Without the second, the screen
      // would quote a total the sale then undercuts.
      exhaustedOfferIds: [],
      // True because this mock queues no prior orders for them — the reader
      // asks "any order at all?" and gets none.
      isFirstOrder: true,
    });
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("costs a bounded number of reads", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "cust-1",
            phone: "9876543210",
            email: null,
            first_name: "",
            last_name: null,
            store_credit: null,
          },
        ],
      ],
    });
    await resolvePosCustomerByPhone("9876543210");
    // ★ BOUNDED, not exact. The point is that resolving a customer costs a
    // fixed handful of reads — one lookup plus the two facts that ride along
    // (offer caps and first-order state) — rather than a number that grows
    // with the customer or the cart. The reads run concurrently, so the exact
    // figure is mock plumbing; pinning the CEILING catches an N+1 regression.
    expect(dbHolder.current.calls.select.length).toBeLessThanOrEqual(4);
  });
});

describe("createPosCheckoutCustomer", () => {
  beforeEach(() => {
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
  });

  it("stores the name and email the cashier collected", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "pos_new" }] });
    const result = await createPosCheckoutCustomer({
      mobile: "+91 98765 43210",
      firstName: "  Rohan ",
      lastName: " Sharma ",
      email: " Rohan@Example.COM ",
    });
    expect(result).toMatchObject({
      created: true,
      customer: {
        id: "pos_new",
        name: "Rohan Sharma",
        phone: "+919876543210",
        email: "rohan@example.com",
      },
    });
    // ★ THE CANONICAL E.164 VALUE IS WHAT GETS WRITTEN, so the column stops
    // holding the same number in two shapes.
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      id: expect.stringMatching(/^pos_/),
      storeId: CASHIER.storeId,
      phone: "+919876543210",
      firstName: "Rohan",
      lastName: "Sharma",
      email: "rohan@example.com",
    });
  });

  it("refuses a nameless customer, so no anonymous row is ever written", async () => {
    // ★★ THE OWNER'S DECISION (2026-09-11): there is no Skip, and this is
    // enforced here rather than only by disabling the button, because a
    // server action is reachable without the UI.
    dbHolder.current = makeDbMock({ returning: [{ id: "pos_walkin" }] });
    const result = await createPosCheckoutCustomer({ mobile: "9876543210" });
    expect(result.error).toMatch(/first name/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("accepts a customer who gives only a first name", async () => {
    // The last name and email stay optional — `users.last_name` is nullable,
    // and refusing a sale over it would trade one blocked counter for another.
    dbHolder.current = makeDbMock({ returning: [{ id: "pos_one_name" }] });
    const result = await createPosCheckoutCustomer({
      mobile: "9876543210",
      firstName: "Rohan",
    });
    expect(result.customer).toMatchObject({ name: "Rohan", email: null });
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      firstName: "Rohan",
      lastName: null,
      email: null,
    });
  });

  it("refuses a malformed email before writing anything", async () => {
    dbHolder.current = makeDbMock();
    const result = await createPosCheckoutCustomer({
      mobile: "9876543210",
      firstName: "Rohan",
      email: "rohan@",
    });
    expect(result.error).toMatch(/email/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("refuses the wrong length, but records a placeholder number", async () => {
    dbHolder.current = makeDbMock();
    expect(
      (await createPosCheckoutCustomer({ mobile: "12345", firstName: "A" }))
        .error,
    ).toMatch(/10-digit number for \+91/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);

    dbHolder.current = makeDbMock({ returning: [{ id: "pos_ph" }] });
    const ok = await createPosCheckoutCustomer({
      mobile: "8888888888",
      firstName: "Walk in",
    });
    expect(ok.customer?.phone).toBe("+918888888888");
  });

  it("stores a number from another country under its own code", async () => {
    dbHolder.current = makeDbMock({ returning: [{ id: "pos_sg" }] });
    const r = await createPosCheckoutCustomer({
      mobile: "81234567",
      dial: "+65",
      firstName: "Wei",
    });
    expect(r.customer?.phone).toBe("+6581234567");
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      phone: "+6581234567",
    });
  });

  it("returns the unique-key winner when two tills record the same new phone", async () => {
    dbHolder.current = makeDbMock({
      returning: [],
      selectQueue: [
        [
          {
            id: "pos_winner",
            phone: "9876543210",
            email: null,
            first_name: "",
            last_name: null,
            store_credit: null,
          },
        ],
      ],
    });
    const result = await createPosCheckoutCustomer({
      mobile: "9876543210",
      firstName: "Rohan",
    });
    expect(result.customer).toMatchObject({ id: "pos_winner" });
    expect(result.created).toBeUndefined();
  });

  it("refuses when signed out or without the sell capability", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect(
      (await createPosCheckoutCustomer({ mobile: "9876543210" })).error,
    ).toMatch(/signed in/i);
  });
});

describe("searchPosCustomers", () => {
  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await searchPosCustomers("ravi")).error).toMatch(/signed in/i);
  });

  // A one-character search would stream a large slice of the customer list to
  // a shared till for no benefit.
  it("returns nothing below the 2-character floor without querying", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[{ id: "c1" }]] });
    const r = await searchPosCustomers("r");
    expect(r.customers).toEqual([]);
    expect(dbHolder.current.calls.where).toHaveLength(0);
  });

  // sqlText renders operators without column names, so this asserts the
  // SHAPE: an equality (the store scope) AND-ed ahead of the name/phone/email
  // OR group. Drop the store scope and the leading `=` disappears.
  it("scopes the search to the operator's store", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    await searchPosCustomers("ravi");
    expect(sqlText(dbHolder.current.calls.where[0])).toMatch(
      /^\( = {2}and \( ilike( {2}or {2}ilike)+ \)\)$/,
    );
  });

  it("builds a display name and falls back to the phone", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "c1",
            phone: "9876543210",
            email: "r@x.com",
            first_name: "Ravi",
            last_name: "Kumar",
          },
          {
            id: "c2",
            phone: "9000000000",
            email: null,
            first_name: "",
            last_name: null,
          },
        ],
      ],
    });
    const r = await searchPosCustomers("ravi");
    expect(r.customers[0]).toMatchObject({ name: "Ravi Kumar", id: "c1" });
    expect(r.customers[1].name).toBe("9000000000");
  });
});

describe("placePosSale — the read wave (Step 20)", () => {
  // ★★ THIS PINS THE ONLY THING STEP 20 ACTUALLY BUYS. Every other test here
  // passes just as happily when the reads run one after another — the values
  // are identical either way — so without this, converting the Promise.all back
  // into sequential awaits is an invisible regression that quietly puts ~320ms
  // back onto every sale.
  it("★ overlaps the reads instead of running them one at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.mocked(withService).mockImplementation(async (fn: any) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        return await fn(dbHolder.current.db);
      } finally {
        inFlight--;
      }
    });
    const r = await placePosSale([line], cash);
    expect(r.success).toBe(true);
    // Four read batches are in flight together: counter, catalogue, tax, till.
    // Serialised, this is 1.
    expect(peak).toBeGreaterThanOrEqual(4);
  });

  // ⚠ The pool is DB_POOL_MAX (10) per container. Going wider than this trades
  // a real ceiling — three simultaneous tills — for no further wall-clock win,
  // since the wave is already only as slow as its longest batch.
  it("⚠ does not open more connections than the pool can spare", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.mocked(withService).mockImplementation(async (fn: any) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        return await fn(dbHolder.current.db);
      } finally {
        inFlight--;
      }
    });
    await placePosSale([line], cash);
    expect(peak).toBeLessThanOrEqual(4);
  });
});

describe("placePosSale — shift attribution", () => {
  // The drawer is read INSIDE the config batch now (Step 20), so these seed the
  // row rather than mocking `currentShiftIdFor` — the sale path no longer calls
  // it, and a mock of an uncalled function proves nothing.
  it("stamps the sale onto the open drawer", async () => {
    seedHappyPath({ shiftRows: [{ id: "shift-1" }] });
    const r = await placePosSale([line], cash);
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].shiftId).toBe("shift-1");
    const paymentRows = dbHolder.current.calls.values.find(
      (value: any) => Array.isArray(value) && value[0]?.method === "cash",
    );
    expect(paymentRows[0].shiftId).toBe("shift-1");
  });

  // Reconciliation surfaces an unattributed sale; a missing drawer must never
  // refuse a paying customer.
  it("still sells when no shift is open", async () => {
    const r = await placePosSale([line], cash);
    expect(r.success).toBe(true);
    expect(dbHolder.current.calls.values[0].shiftId).toBeNull();
  });

  it("refuses when the store requires an open shift and there is none", async () => {
    vi.mocked(getStoreSettings).mockResolvedValue({
      ...SETTINGS,
      "pos.requireOpenShift": true,
    } as any);
    const r = await placePosSale([line], cash);
    expect(r.error).toMatch(/open a shift/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("sells under that setting once a shift is open", async () => {
    seedHappyPath({ shiftRows: [{ id: "shift-1" }] });
    vi.mocked(getStoreSettings).mockResolvedValue({
      ...SETTINGS,
      "pos.requireOpenShift": true,
    } as any);
    expect((await placePosSale([line], cash)).success).toBe(true);
  });

  // ★★ A DB BLIP MUST NOT READ AS "NO DRAWER OPEN". The old `currentShiftIdFor`
  // swallowed its own errors and returned null, so under `pos.requireOpenShift`
  // an unreadable config refused the sale with "Open a shift before selling." —
  // sending a cashier to open a drawer that was already open. The config batch
  // owns the failure now, so it surfaces as the outage it is.
  it("reports an outage rather than claiming no shift is open", async () => {
    vi.mocked(getStoreSettings).mockResolvedValue({
      ...SETTINGS,
      "pos.requireOpenShift": true,
    } as any);
    dbHolder.current = makeDbMock({
      // Round 0 is catalogue(products) · tax(billing) · till(location). It is
      // the TILL read that must fail — that is the batch carrying the shift, so
      // it is the one whose failure could be mistaken for "no drawer open".
      selectQueue: [
        [{ id: "cust-1", email: null }],
        [PRODUCT],
        [BILLING],
        new Error("connection reset"),
      ],
    });
    const r = await placePosSale([line], cash);
    expect(r.success).toBeUndefined();
    expect(typeof r.error).toBe("string");
    expect(r.error).not.toMatch(/open a shift/i);
    // The real cause reaches the operator. ⚠ `dbErrorMessage` propagates the
    // raw driver message when there is one and only falls back to the supplied
    // sentence otherwise — pre-existing behaviour every read here already had.
    expect(r.error).toBe("connection reset");
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });
});

describe("listPosSales", () => {
  it("refuses when signed out", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(null);
    expect((await listPosSales()).error).toMatch(/signed in/i);
  });

  // The commonest reason to look a sale up is a customer at the counter asking
  // for their bill again. Making that a manager's job stops the queue.
  it("a cashier may look up sales", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    expect((await listPosSales()).error).toBeUndefined();
  });

  // sqlText renders operators without column names, so this asserts the SHAPE:
  // store =, location =, and `is not null` (the receipt-no filter) AND-ed.
  it("★ scopes to this shop's register sales and completed pickups", async () => {
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    await listPosSales();
    const where = sqlText(dbHolder.current.calls.where[0]);
    expect(where).toMatch(/=/);
    expect(where).toMatch(/is not null/);
  });

  // ★ The count is a separate grouped query, not a correlated subquery in the
  // select: interpolating columns into sql`` drops their table qualification,
  // so `where "order_id" = "id"` resolved both names inside order_items and
  // silently returned 0 for every sale.
  it("counts the items on each sale", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "o1",
            receipt_no: "POS-000007",
            order_ref: "ORD10011027",
            total: "240.50",
            created_at: "2026-07-30T10:00:00Z",
            cashier_name: "Priya",
            shipping_address: { firstName: "Ravi", lastName: "Kumar" },
            payment_method: "cash",
            status: "cancelled",
          },
        ],
        // Second query: the grouped item counts.
        [{ order_id: "o1", n: 3 }],
      ],
    });
    const { sales } = await listPosSales();
    expect(sales[0]).toMatchObject({
      receiptNo: "POS-000007",
      total: 240.5,
      customerName: "Ravi Kumar",
      itemCount: 3,
      cancelled: true,
      refund: "none",
    });
  });

  // ★★ The badge used to read `orders.status === "refunded"`, which only ever
  // became true because the till WROTE it — and once counter refunds moved
  // onto the shared money core that write went away, so a fully refunded sale
  // rendered as untouched. payment_status is the DERIVED answer
  // (syncOrderRefundState), and it can move back when a refund fails.
  it("★ reports a refunded sale from payment_status, not orders.status", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "o1",
            receipt_no: "POS-000007",
            order_ref: "ORD10011027",
            total: "240.50",
            created_at: "2026-07-30T10:00:00Z",
            cashier_name: "Priya",
            shipping_address: null,
            payment_method: "cash",
            // What a fully returned till sale actually looks like now.
            status: "completed",
            payment_status: "refunded",
          },
        ],
        [{ order_id: "o1", n: 3 }],
      ],
    });
    const { sales } = await listPosSales();
    expect(sales[0]).toMatchObject({ cancelled: false, refund: "full" });
  });

  it("★ tells a PARTIAL refund apart — goods are still returnable on it", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "o1",
            receipt_no: "POS-000007",
            order_ref: "ORD10011027",
            total: "240.50",
            created_at: "2026-07-30T10:00:00Z",
            cashier_name: "Priya",
            shipping_address: null,
            payment_method: "cash",
            status: "completed",
            payment_status: "partially_refunded",
          },
        ],
        [{ order_id: "o1", n: 3 }],
      ],
    });
    const { sales } = await listPosSales();
    expect(sales[0]).toMatchObject({ cancelled: false, refund: "partial" });
  });

  it("leaves a walk-in's name null rather than inventing one", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "o2",
            receipt_no: "POS-000008",
            order_ref: "ORD10011028",
            total: "99",
            created_at: "2026-07-30T10:00:00Z",
            cashier_name: null,
            shipping_address: null,
            payment_method: "cash",
            status: "completed",
          },
        ],
        [{ order_id: "o2", n: 1 }],
      ],
    });
    const { sales } = await listPosSales();
    expect(sales[0].customerName).toBeNull();
    expect(sales[0]).toMatchObject({ cancelled: false, refund: "none" });
  });

  it("shows a customer attached through POS lookup/create", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "o3",
            receipt_no: "POS-000009",
            order_ref: "ORD10011029",
            total: "118",
            created_at: "2026-07-30T10:00:00Z",
            cashier_name: "Priya",
            shipping_address: null,
            customer_first_name: "Asha",
            customer_last_name: "Rao",
            payment_method: "cash",
            status: "completed",
          },
        ],
        [{ order_id: "o3", n: 1 }],
      ],
    });

    const { sales } = await listPosSales();
    expect(sales[0].customerName).toBe("Asha Rao");
  });

  it("records an in-store pickup in Sales at its collection time", async () => {
    dbHolder.current = makeDbMock({
      selectQueue: [
        [
          {
            id: "pickup-1",
            receipt_no: null,
            order_ref: "ORD10011030",
            total: 450,
            created_at: "2026-08-20T10:00:00Z",
            completed_at: "2026-08-29T10:00:00Z",
            cashier_name: null,
            shipping_address: { firstName: "Asha" },
            payment_method: "razorpay",
            status: "completed",
            fulfilment_type: "pickup",
            pickup_status: "collected",
          },
        ],
        [{ order_id: "pickup-1", n: 2 }],
      ],
    });

    const { sales } = await listPosSales();
    expect(sales[0]).toMatchObject({
      receiptNo: "ORD10011030",
      createdAt: "2026-08-29T10:00:00Z",
      kind: "pickup",
      itemCount: 2,
    });
  });
});

// ── Gateway tenders (roadmap Step 12) ───────────────────────────────────────
// `razorpay` sat in TENDER_METHODS from the start with NO gateway call behind
// it anywhere, so it was accepted, recorded, and counted in shift
// reconciliation as money the gateway never received. These pin the boundary
// that closed it.

describe("placePosSale — gateway tenders", () => {
  const online = [
    { method: "razorpay" as const, amount: 118, reference: "pay_ok" },
  ];

  it("★★ completes only once the gateway verification passes", async () => {
    seedHappyPath();
    const r = await placePosSale([line], online);
    expect(r.error).toBeUndefined();
    // The tenders go through EXACTLY as posted — the verifier compares each
    // claimed amount against Razorpay's own record of the payment.
    expect(verifyGatewayTenders).toHaveBeenCalledWith("store-1", online);
  });

  it("★★ a refusal blocks the sale, and writes NOTHING", async () => {
    // Refused BEFORE the order insert and the stock reserve, so nothing has to
    // unwind. Covers every reason the verifier can refuse: an uncaptured
    // payment, an amount that doesn't match, a reference already used, or a
    // gateway it couldn't read.
    vi.mocked(verifyGatewayTenders).mockResolvedValue(
      "The amount paid doesn't match what's being recorded.",
    );
    seedHappyPath();
    const r = await placePosSale([line], online);
    expect(r.error).toMatch(/doesn't match/i);
    expect(dbHolder.current.calls.insert).toHaveLength(0);
    expect(dbHolder.current.calls.execute).toHaveLength(0);
  });

  it("★ a cash-only sale never asks the gateway", async () => {
    seedHappyPath();
    const r = await placePosSale([line], cash);
    expect(r.error).toBeUndefined();
    expect(verifyGatewayTenders).not.toHaveBeenCalled();
  });

  it("★ a split sends BOTH legs to the verifier, not just the gateway one", async () => {
    // It filters internally; handing it only the razorpay tenders here would
    // mean the two counters pass different shapes to the same function.
    seedHappyPath();
    const split = [
      { method: "cash" as const, amount: 18, tendered: 18 },
      { method: "razorpay" as const, amount: 100, reference: "pay_ok" },
    ];
    await placePosSale([line], split);
    expect(verifyGatewayTenders).toHaveBeenCalledWith("store-1", split);
  });
});

describe("placePosSale — the gateway replay CONSTRAINT firing", () => {
  // The app-level check is read-then-write, so two tills can both pass it.
  // `order_payments_gateway_ref_key` (pos_15) is what stops the second one —
  // and it surfaces as a unique violation on the payments insert, AFTER the
  // order and the stock reserve. Swallowing that (which every other failure
  // there deliberately does) would leave a sale marked `paid` with no payment
  // rows at all: invisible to shift reconciliation, and claiming money that
  // settled a different order.
  const uniqueViolation = Object.assign(new Error("duplicate key"), {
    code: "23505",
  });

  function seedInsertClash() {
    const mock = makeDbMock({
      selectQueue: [
        // Read wave (see seedHappyPath), then the gateway replay check, which
        // runs AFTER it — a refused payment must cost nothing.
        [{ id: "cust-1", email: null }],
        [PRODUCT],
        [BILLING],
        [{ state_code: "07", receipt_prefix: "DEL" }],
        [TAX_CLASS],
        [], // no open shift
        [], // replay check finds nothing — the race is still open
      ],
      executeQueue: [[{ seq: 42 }], [{ reserved: true }]],
      returning: [{ id: "o1", order_ref: "ORD100110006" }],
    });
    const realInsert = mock.db.insert;
    mock.db.insert = (table: any) => {
      const step = realInsert(table);
      if (table === orderPayments) {
        return { values: () => Promise.reject(uniqueViolation) } as any;
      }
      return step;
    };
    dbHolder.current = mock;
  }

  it("★★ unwinds the sale rather than completing it unpaid", async () => {
    seedInsertClash();
    const res = await placePosSale(
      [line],
      [{ method: "razorpay" as const, amount: 118, reference: "pay_taken" }],
    );
    expect(res.error).toMatch(/already been used/i);
    // Stock released and the order deleted — not a paid sale with no payments.
    expect(sqlText(dbHolder.current.calls.execute.at(-1))).toContain(
      "release_stock_at(",
    );
    expect(dbHolder.current.calls.delete).toContain(orders);
  });

  it("★ a CASH sale still survives a failed payments insert", async () => {
    // The original rule, unchanged: the sale is rung and the stock is gone, so
    // losing only the tender breakdown must not void a completed transaction.
    seedInsertClash();
    const res = await placePosSale([line], cash);
    expect(res.error).toBeUndefined();
    expect(dbHolder.current.calls.delete).not.toContain(orders);
  });
});

// ── The money audit (roadmap Step 14) ───────────────────────────────────────
// Discount AMOUNTS were always on the order. What was missing is who did it
// and — the point of the step — who APPROVED it, which `placePosSale` verified
// and then threw away as `!!verifyApprovalToken(...)`.

describe("placePosSale — the money audit", () => {
  const auditFor = (event: string) =>
    vi
      .mocked(posAudit)
      .mock.calls.map((c) => c[0])
      .find((a: any) => a.event === event) as any;

  it("★ an ordinary sale audits nothing", async () => {
    // No discount, no override — nobody exercised discretion, so there is
    // nothing to attribute. A row per sale would drown the feed.
    vi.mocked(resolvePosOperator).mockResolvedValue(OWNER as any);
    seedHappyPath();
    await placePosSale([line], cash);
    expect(posAudit).not.toHaveBeenCalled();
  });

  it("★★ records a discount with its amount and the order", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(OWNER as any);
    seedHappyPath();
    await placePosSale(
      [line],
      [{ method: "cash", amount: 108, tendered: 200 }],
      {
        orderDiscount: 10,
      },
    );
    const entry = auditFor("sale_discount");
    expect(entry).toMatchObject({
      storeId: "store-1",
      amount: 10,
      orderId: expect.any(String),
      actor: "Vansh",
    });
  });

  it("★★ records WHO APPROVED an over-cap discount", async () => {
    // The whole reason this step exists. A cashier discounting above the cap
    // needs a manager's PIN; that manager's id was previously discarded.
    vi.mocked(getStoreSettings).mockResolvedValue(STAFF_MAY_DISCOUNT);
    const sale = { lines: [line], orderDiscount: 50 };
    seedHappyPath();
    await placePosSale(
      [line],
      [{ method: "cash", amount: 68, tendered: 100 }],
      {
        orderDiscount: 50,
        approvalToken: approvalFor(sale),
      },
    );
    expect(auditFor("sale_discount")).toMatchObject({ approver: "mgr-1" });
  });

  it("★ an unapproved discount records no approver, rather than a blank one", async () => {
    vi.mocked(resolvePosOperator).mockResolvedValue(OWNER as any);
    seedHappyPath();
    await placePosSale(
      [line],
      [{ method: "cash", amount: 108, tendered: 200 }],
      {
        orderDiscount: 10,
      },
    );
    expect(auditFor("sale_discount").approver).toBeNull();
  });

  it("★★ records a price override as the DELTA given away", async () => {
    // ₹100 catalogue → ₹60 charged on one unit = ₹40 given away. The new price
    // alone would be meaningless without yesterday's, and that price moves.
    vi.mocked(resolvePosOperator).mockResolvedValue(OWNER as any);
    seedHappyPath();
    await placePosSale(
      [{ ...line, priceOverride: 60 }],
      [{ method: "cash", amount: 71, tendered: 100 }],
    );
    expect(auditFor("price_override")).toMatchObject({ amount: 40 });
  });

  it("★ a discount and an override on one sale are TWO rows", async () => {
    // Two different decisions, possibly by two different people.
    vi.mocked(resolvePosOperator).mockResolvedValue(OWNER as any);
    seedHappyPath();
    await placePosSale(
      [{ ...line, priceOverride: 60 }],
      [{ method: "cash", amount: 61, tendered: 100 }],
      { orderDiscount: 10 },
    );
    expect(auditFor("sale_discount")).toBeTruthy();
    expect(auditFor("price_override")).toBeTruthy();
  });

  it("★★ a REFUSED sale audits nothing", async () => {
    // Audited after the sale is recorded, so a sale that never happened logs
    // no give-away. This action returns early in a dozen places.
    vi.mocked(resolvePosOperator).mockResolvedValue(CASHIER as any);
    seedHappyPath();
    const res = await placePosSale([line], cash, { orderDiscount: 10 });
    expect(res.error).toBeTruthy();
    expect(posAudit).not.toHaveBeenCalled();
  });
});
