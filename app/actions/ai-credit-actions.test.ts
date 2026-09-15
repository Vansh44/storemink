/* eslint-disable @typescript-eslint/no-explicit-any */
// AI credit purchases — the invoicing half.
//
// ⚠ This file had NO tests at all before 2026-08-13, despite being a money path.
// These cover the part added then: a credit purchase produces a real invoice.
// The rest of the flow (plan gating, the add_ai_credits RPC, reconcile-on-read)
// is still uncovered and worth a suite of its own.
//
// ★★ THE PROPERTY THAT MATTERS: the document is issued by `settlePurchase`,
// which is the ONE place a purchase becomes paid — reached BOTH from
// `confirmCreditPurchase` and from the reconcile-on-read sweep. Moving the call
// up into `confirmCreditPurchase` would look identical here and would silently
// leave every reconciled purchase without an invoice.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (fn: any) => fn(dbHolder.current.db)),
}));

const access = vi.hoisted(() => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => access);

const provider = vi.hoisted(() => ({ getPlatformRazorpayCreds: vi.fn() }));
vi.mock("@/lib/payments/provider", () => provider);

const rzp = vi.hoisted(() => ({
  capturedPayment: vi.fn(),
  rzpCreateOrder: vi.fn(),
  rzpFetchOrderPayments: vi.fn(),
  verifyCapturedCheckoutPayment: vi.fn(),
  verifyCheckoutSignature: vi.fn(),
}));
vi.mock("@/lib/payments/razorpay", () => rzp);

const invoice = vi.hoisted(() => ({
  draftCreditInvoice: vi.fn(),
  issueCreditInvoice: vi.fn(),
}));
vi.mock("@/lib/billing/credit-invoice", () => invoice);

vi.mock("@/lib/notifications/record", () => ({ emitEvent: vi.fn() }));
vi.mock("@/lib/ai/quota", () => ({ getAiUsage: vi.fn() }));
vi.mock("@/lib/ai/credit-pricing", () => ({
  getMinkCreditPackLive: vi.fn(async (id: string) =>
    id === "small"
      ? { id: "small", name: "Small", credits: 25, priceInr: 59 }
      : null,
  ),
  getMinkCreditPacksLive: vi.fn(async () => []),
}));

import {
  confirmCreditPurchase,
  startCreditPurchase,
} from "./ai-credit-actions";

const STORE = "a0000000-0000-4000-8000-000000000001";

function pendingPurchase(over: Record<string, unknown> = {}) {
  return {
    id: "pur-1",
    store_id: STORE,
    credits: 25,
    pack_id: "small",
    amount_inr: 59,
    status: "pending",
    rzp_order_id: "order_1",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  access.getManagerUserId.mockResolvedValue("admin-1");
  access.getActingStoreId.mockResolvedValue(STORE);
  provider.getPlatformRazorpayCreds.mockReturnValue({
    keyId: "rzp_1",
    keySecret: "secret",
  });
  rzp.verifyCheckoutSignature.mockReturnValue(true);
  rzp.verifyCapturedCheckoutPayment.mockResolvedValue({
    ok: true,
    gatewayRead: true,
  });
  rzp.rzpCreateOrder.mockResolvedValue({ ok: true, data: { id: "order_1" } });
  invoice.draftCreditInvoice.mockResolvedValue("inv-1");
  invoice.issueCreditInvoice.mockResolvedValue(undefined);
  dbHolder.current = makeDbMock({ selectQueue: [[pendingPurchase()]] });
});

describe("startCreditPurchase", () => {
  function seedStart() {
    dbHolder.current = makeDbMock({
      // The plan gate reads the store first.
      selectQueue: [[{ plan: "pro", plan_expires_at: null }]],
      returning: [{ id: "pur-1" }],
    });
  }

  it("★ raises a DRAFT invoice for the purchase", async () => {
    seedStart();
    await startCreditPurchase("small");
    expect(invoice.draftCreditInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: STORE, purchaseId: "pur-1" }),
    );
  });

  it("★★ raises it AFTER the gateway order — a purchase that died there leaves no document", async () => {
    seedStart();
    rzp.rzpCreateOrder.mockResolvedValue({ ok: false, error: "nope" });
    const res = await startCreditPurchase("small");
    expect("error" in res).toBe(true);
    expect(invoice.draftCreditInvoice).not.toHaveBeenCalled();
  });

  it("★ lets a Free store buy a one-time credit top-up", async () => {
    dbHolder.current = makeDbMock({
      returning: [{ id: "pur-free" }],
    });
    const res = await startCreditPurchase("small");
    expect("success" in res).toBe(true);
    expect(invoice.draftCreditInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: STORE, purchaseId: "pur-free" }),
    );
  });

  it("refuses an unknown pack", async () => {
    const res = await startCreditPurchase("not-a-pack");
    expect("error" in res).toBe(true);
  });
});

describe("confirmCreditPurchase", () => {
  it("★★ ISSUES the invoice once the payment verifies", async () => {
    const res = await confirmCreditPurchase("pur-1", "pay_1", "sig");
    expect("success" in res).toBe(true);
    expect(invoice.issueCreditInvoice).toHaveBeenCalledWith("pur-1");
  });

  it("★★ issues NOTHING when the signature fails", async () => {
    rzp.verifyCheckoutSignature.mockReturnValue(false);
    const res = await confirmCreditPurchase("pur-1", "pay_1", "sig");
    expect("error" in res).toBe(true);
    expect(invoice.issueCreditInvoice).not.toHaveBeenCalled();
  });

  it("grants no credits when Razorpay reports a mismatched payment", async () => {
    rzp.verifyCapturedCheckoutPayment.mockResolvedValue({
      ok: false,
      error: "The captured amount does not match the invoice.",
    });
    const res = await confirmCreditPurchase("pur-1", "pay_1", "sig");
    expect("error" in res).toBe(true);
    expect(invoice.issueCreditInvoice).not.toHaveBeenCalled();
  });

  it("★ retries the receipt for an ALREADY-paid purchase", async () => {
    // Idempotent: re-confirming cannot grant credits twice, but it does repair
    // a receipt whose best-effort write failed after the purchase committed.
    dbHolder.current = makeDbMock({
      selectQueue: [[pendingPurchase({ status: "paid" })]],
    });
    const res = await confirmCreditPurchase("pur-1", "pay_1", "sig");
    expect("success" in res).toBe(true);
    expect(invoice.issueCreditInvoice).toHaveBeenCalledWith("pur-1");
  });

  it("★ refuses a purchase belonging to another store", async () => {
    // The query is scoped by store, so a foreign id simply finds nothing.
    dbHolder.current = makeDbMock({ selectQueue: [[]] });
    const res = await confirmCreditPurchase("pur-x", "pay_1", "sig");
    expect("error" in res).toBe(true);
    expect(invoice.issueCreditInvoice).not.toHaveBeenCalled();
  });

  it("refuses a malformed payload", async () => {
    const res = await confirmCreditPurchase("pur-1", "", "sig");
    expect("error" in res).toBe(true);
  });

  it("★ refuses without permission", async () => {
    access.getManagerUserId.mockResolvedValue(null);
    const res = await confirmCreditPurchase("pur-1", "pay_1", "sig");
    expect("error" in res).toBe(true);
    expect(invoice.issueCreditInvoice).not.toHaveBeenCalled();
  });
});
