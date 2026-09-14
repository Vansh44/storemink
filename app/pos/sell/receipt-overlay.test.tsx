// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getPosReceipt = vi.hoisted(() => vi.fn());
vi.mock("@/app/actions/pos-sale-actions", () => ({ getPosReceipt }));
vi.mock("@/components/pos/thermal-receipt", () => ({
  ThermalReceipt: () => null,
}));

import { ReceiptOverlay } from "./receipt-overlay";

beforeEach(() => {
  vi.clearAllMocks();
  getPosReceipt.mockResolvedValue({
    receipt: {
      storeName: "Echoes",
      legalName: null,
      locationName: "Shop",
      address: null,
      gstin: null,
      phone: null,
      receiptNo: "ORD100110584",
      orderRef: "ORD100110584",
      soldAt: "2026-08-29T10:00:00Z",
      cashierName: "Priya",
      lines: [
        {
          name: "Multigrain Bread",
          variantName: null,
          hsnCode: null,
          quantity: 2,
          unitPrice: 52,
          lineDiscount: 0,
          total: 104,
        },
      ],
      subtotal: 104,
      discount: 0,
      tax: 4.95,
      taxInclusive: true,
      gstEnabled: true,
      gst: [],
      intraState: true,
      total: 104,
      tenders: [
        {
          method: "razorpay",
          amount: 104,
          tendered: null,
          changeDue: null,
          reference: "pay_1",
        },
      ],
      changeDue: 0,
      customerGstin: null,
      footerNote: null,
    },
    detail: {
      kind: "pickup",
      status: "completed",
      paymentStatus: "paid",
      customerName: "V G",
      customerPhone: "9814468834",
      customerEmail: "vg@example.com",
      completedAt: "2026-08-29T10:00:00Z",
    },
  });
});

describe("ReceiptOverlay reprint detail", () => {
  it("shows customer, collected-pickup, line, totals, and tender details", async () => {
    render(
      <ReceiptOverlay orderId="pickup-1" mode="reprint" onClose={vi.fn()} />,
    );

    expect(await screen.findByText("Collected in store")).toBeVisible();
    expect(screen.getByText("V G")).toBeVisible();
    expect(screen.getByText(/9814468834/)).toBeVisible();
    expect(screen.getByText("Multigrain Bread")).toBeVisible();
    expect(screen.getByText("Online")).toBeVisible();
    expect(screen.getAllByText("₹104.00").length).toBeGreaterThanOrEqual(2);
  });
});
