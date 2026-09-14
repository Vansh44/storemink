// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { DEFAULT_BILLING_SETTINGS } from "@/lib/billing/types";
import { InvoiceDocument, type InvoiceOrderData } from "./invoice-document";

// The customer's OWN address — where a delivery would go, and where a
// collection order's goods emphatically did not.
const CUSTOMER_ADDRESS = {
  firstName: "Priya",
  lastName: "Sharma",
  addressLine1: "12 Nehru Road",
  city: "Faridkot",
  state: "Punjab",
  postalCode: "151203",
  country: "India",
  phone: "+918888888888",
  email: "priya@example.com",
};

// A SHOP address — different keys entirely (lib/locations/address.ts).
const SHOP_ADDRESS = {
  line1: "hostel D, Thapar University",
  city: "Patiala",
  state: "Punjab",
  postalCode: "147004",
};

const ORDER: InvoiceOrderData = {
  order_ref: "ORD100110436",
  order_no: 10436,
  created_at: "2026-08-05T09:42:00.000Z",
  status: "pending",
  payment_method: "pay_at_store",
  payment_status: "pending",
  subtotal: 45,
  tax: 2.14,
  tax_inclusive: true,
  shipping: 0,
  discount: 0,
  total: 45,
  currency: "INR",
  applied_coupon_code: null,
  notes: null,
  shipping_address: CUSTOMER_ADDRESS,
  billing_address: null,
  fulfilment_type: "delivery",
  pickup_location_name: null,
  pickup_location_address: null,
};

const ITEMS = [
  {
    name: "Tomatoes (500 g)",
    variant_name: null,
    price: 45,
    quantity: 1,
    total: 45,
    tax_rate: 5,
    tax_amount: 2.14,
    tax_class_name: "GST 5%",
  },
];

function renderInvoice(order: Partial<InvoiceOrderData>, billing = {}) {
  return render(
    <InvoiceDocument
      order={{ ...ORDER, ...order }}
      items={ITEMS}
      billing={{ ...DEFAULT_BILLING_SETTINGS, ...billing }}
    />,
  );
}

/**
 * Queries scoped to ONE party block. The customer's address legitimately
 * appears under Bill To on a collection invoice — it is a billing address —
 * so an unscoped "is this street on the page?" proves nothing. What matters is
 * which block it is in.
 */
function party(label: string) {
  const heading = screen.getByText(label);
  const block = heading.parentElement;
  if (!block) throw new Error(`No block around "${label}"`);
  return within(block);
}

describe("InvoiceDocument — delivery", () => {
  it("ships to the customer's address, as it always has", () => {
    renderInvoice({});
    expect(screen.queryByText("Collect From")).not.toBeInTheDocument();
    expect(party("Ship To").getByText("12 Nehru Road")).toBeInTheDocument();
  });

  // Absent reads as delivery — every order predates the column.
  it("treats a missing fulfilment_type as delivery", () => {
    renderInvoice({ fulfilment_type: undefined });
    expect(screen.getByText("Ship To")).toBeInTheDocument();
  });
});

describe("InvoiceDocument — collection", () => {
  const PICKUP = {
    fulfilment_type: "pickup",
    pickup_location_name: "Shop",
    pickup_location_address: SHOP_ADDRESS,
  };

  // ★ THE BUG: nothing is shipped to a collection order, but the invoice
  // printed the customer's home address under "Ship To" — an address the goods
  // never went to, on the document that is the record of the sale.
  it("names the SHOP, not a delivery address", () => {
    renderInvoice(PICKUP);

    expect(screen.queryByText("Ship To")).not.toBeInTheDocument();
    const collect = party("Collect From");
    expect(
      collect.getByText("hostel D, Thapar University"),
    ).toBeInTheDocument();
    expect(collect.getByText("Patiala, Punjab, 147004")).toBeInTheDocument();
    // The customer's own street must not be in this block — that is the bug.
    expect(collect.queryByText("12 Nehru Road")).not.toBeInTheDocument();
  });

  it("still says who bought it when the Bill To block is switched off", () => {
    renderInvoice(PICKUP, {
      template: {
        ...DEFAULT_BILLING_SETTINGS.template,
        showBillingAddress: false,
      },
    });

    // Without this the invoice would name no customer at all: the only place
    // they appeared was the Ship To block a pickup doesn't render.
    expect(screen.getByText("Bill To")).toBeInTheDocument();
    expect(screen.getByText("Priya Sharma")).toBeInTheDocument();
  });

  // A shop with no address on file shows its NAME and nothing else — never the
  // customer's street borrowed to fill the space.
  it("does not fall back to the customer's street when the shop has no address", () => {
    renderInvoice({ ...PICKUP, pickup_location_address: null });
    const collect = party("Collect From");
    expect(collect.getByText("Shop")).toBeInTheDocument();
    expect(collect.queryByText("12 Nehru Road")).not.toBeInTheDocument();
  });

  it("falls back to a name rather than a blank party block", () => {
    renderInvoice({ ...PICKUP, pickup_location_name: null });
    expect(screen.getByText("Our shop")).toBeInTheDocument();
  });
});

describe("InvoiceDocument — POS sale", () => {
  it("names the register location and never invents a shipping destination", () => {
    renderInvoice({
      sales_channel: "pos",
      shipping_address: null,
      billing_address: null,
      sale_location_name: "Patiala Store",
      sale_location_address: SHOP_ADDRESS,
      customer_first_name: "Asha",
      customer_last_name: "Rao",
      customer_phone: "+919876543210",
    });

    expect(screen.queryByText("Ship To")).not.toBeInTheDocument();
    const soldAt = party("Sold At");
    expect(soldAt.getByText("Patiala Store")).toBeInTheDocument();
    expect(soldAt.getByText("hostel D, Thapar University")).toBeInTheDocument();
    expect(party("Bill To").getByText("Asha Rao")).toBeInTheDocument();
  });

  it("renders an honest walk-in instead of an empty customer", () => {
    renderInvoice({
      sales_channel: "pos",
      shipping_address: null,
      billing_address: null,
      sale_location_name: "Main Store",
    });

    expect(party("Bill To").getByText("Walk-in customer")).toBeInTheDocument();
  });
});
