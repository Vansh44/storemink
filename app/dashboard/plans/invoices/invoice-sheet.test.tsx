// @vitest-environment jsdom
// The printed subscription invoice.
//
// This is the document a merchant hands to an accountant, so the tests are about
// what it CLAIMS: a tax invoice must name a GSTIN and split the tax correctly, and
// a no-tax invoice must say plainly that no GST was charged rather than showing a
// zero that looks like an omission — or worse, a claim.

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { InvoiceSheet } from "./invoice-sheet";
import type { InvoiceDocument } from "@/lib/billing/invoice-types";

function doc(over: Partial<InvoiceDocument> = {}): InvoiceDocument {
  return {
    id: "inv-1",
    invoiceRef: "SM/2026-27/00001",
    kind: "subscription",
    status: "paid",
    issuedAt: "2026-09-01T00:00:00.000Z",
    paidAt: "2026-09-01T00:00:00.000Z",
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: "2026-10-01T00:00:00.000Z",
    subtotalPaise: 500_000,
    discountPaise: 0,
    taxPaise: 0,
    totalPaise: 500_000,
    taxRateBps: 0,
    supplierGstin: null,
    customerGstin: null,
    placeOfSupply: null,
    items: [
      {
        kind: "base_plan",
        description: "Pro plan · 1 month",
        quantity: 1,
        unitAmountPaise: 500_000,
        amountPaise: 500_000,
      },
    ],
    supplier: {
      legalName: "StoreMink Technologies",
      address: { city: "New Delhi", postalCode: "110001" },
    },
    customer: {
      legalName: "Acme Retail",
      address: { city: "Bengaluru" },
      billingEmail: "acme@example.test",
    },
    ...over,
  };
}

/** Tax ON, supplier in Delhi (07). */
const TAXED = {
  taxPaise: 90_000,
  totalPaise: 590_000,
  taxRateBps: 1800,
  supplierGstin: "07AABCS1429B1ZX",
  customerGstin: "29AAACM1234C1ZP",
};

describe("InvoiceSheet — no tax (today's state)", () => {
  it("★★ is titled 'Invoice', NOT 'Tax Invoice'", () => {
    // Calling it a tax invoice while charging no tax and naming no GSTIN is a
    // claim the document cannot support.
    render(<InvoiceSheet doc={doc()} />);
    expect(screen.getByText("Invoice")).toBeInTheDocument();
    expect(screen.queryByText("Tax Invoice")).not.toBeInTheDocument();
  });

  it("★★ shows NO GST line at all — not a zero", () => {
    render(<InvoiceSheet doc={doc()} />);
    expect(screen.queryByText(/CGST|SGST|IGST/)).not.toBeInTheDocument();
  });

  it("★ says WHY there is no GST, so the gap is not read as an omission", () => {
    render(<InvoiceSheet doc={doc()} />);
    expect(screen.getByText(/No GST has been charged/i)).toBeInTheDocument();
  });

  it("★ omits the place of supply, which decides nothing here", () => {
    render(<InvoiceSheet doc={doc({ placeOfSupply: "29" })} />);
    expect(screen.queryByText(/Place of supply/i)).not.toBeInTheDocument();
  });

  it("still totals correctly", () => {
    render(<InvoiceSheet doc={doc()} />);
    expect(screen.getAllByText("₹5,000.00").length).toBeGreaterThan(0);
  });
});

describe("InvoiceSheet — tax ON", () => {
  it("★★ INTER-state supply shows IGST only", () => {
    // Supplier 07 (Delhi), merchant 29 (Karnataka) — different states.
    render(<InvoiceSheet doc={doc({ ...TAXED, placeOfSupply: "29" })} />);
    expect(screen.getByText("IGST 18%")).toBeInTheDocument();
    expect(screen.queryByText(/CGST/)).not.toBeInTheDocument();
  });

  it("★★ INTRA-state supply splits into CGST + SGST at half the rate each", () => {
    render(<InvoiceSheet doc={doc({ ...TAXED, placeOfSupply: "07" })} />);
    expect(screen.getByText("CGST 9%")).toBeInTheDocument();
    expect(screen.getByText("SGST 9%")).toBeInTheDocument();
    expect(screen.queryByText(/IGST/)).not.toBeInTheDocument();
  });

  it("★★ the halves ADD UP to the tax charged", () => {
    // Split from the tax AMOUNT, never recomputed from the rate — so it can
    // never disagree with the total's rounding.
    render(<InvoiceSheet doc={doc({ ...TAXED, placeOfSupply: "07" })} />);
    // ₹900 total tax → ₹450 + ₹450.
    expect(screen.getAllByText("₹450.00")).toHaveLength(2);
  });

  it("is titled 'Tax Invoice' and names both GSTINs", () => {
    render(<InvoiceSheet doc={doc({ ...TAXED, placeOfSupply: "29" })} />);
    expect(screen.getByText("Tax Invoice")).toBeInTheDocument();
    expect(screen.getByText(/07AABCS1429B1ZX/)).toBeInTheDocument();
    expect(screen.getByText(/29AAACM1234C1ZP/)).toBeInTheDocument();
  });

  it("★ names the place of supply, which is what decides the split", () => {
    render(<InvoiceSheet doc={doc({ ...TAXED, placeOfSupply: "29" })} />);
    expect(screen.getByText(/Karnataka/)).toBeInTheDocument();
  });

  it("★★ a tax AMOUNT with no supplier GSTIN is NOT rendered as a tax invoice", () => {
    // Data that should not exist — but if it does, the document must not claim a
    // registration it cannot name.
    render(
      <InvoiceSheet
        doc={doc({ taxPaise: 90_000, totalPaise: 590_000, taxRateBps: 1800 })}
      />,
    );
    expect(screen.queryByText("Tax Invoice")).not.toBeInTheDocument();
    expect(screen.queryByText(/CGST|SGST|IGST/)).not.toBeInTheDocument();
  });
});

describe("InvoiceSheet — the rest", () => {
  it("★ shows a discount NEGATIVE, so the ladder adds up", () => {
    render(
      <InvoiceSheet
        doc={doc({ discountPaise: 50_000, totalPaise: 450_000 })}
      />,
    );
    expect(screen.getByText("−₹500.00")).toBeInTheDocument();
  });

  it("omits the discount line entirely when there is none", () => {
    render(<InvoiceSheet doc={doc()} />);
    expect(screen.queryByText(/Discount/)).not.toBeInTheDocument();
  });

  it("★ translates our status vocabulary into the merchant's", () => {
    render(<InvoiceSheet doc={doc({ status: "uncollectible" })} />);
    expect(screen.getByText("Unpaid — plan ended")).toBeInTheDocument();
    expect(screen.queryByText("uncollectible")).not.toBeInTheDocument();
  });

  it("renders every line item", () => {
    render(<InvoiceSheet doc={doc()} />);
    expect(screen.getByText("Pro plan · 1 month")).toBeInTheDocument();
  });

  it("★ survives a customer with no legal name — a store may never have set one", () => {
    render(
      <InvoiceSheet
        doc={doc({
          customer: { legalName: null, address: {}, billingEmail: null },
        })}
      />,
    );
    expect(screen.getByText("Billed to")).toBeInTheDocument();
  });
});
