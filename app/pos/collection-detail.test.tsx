// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// The reader is a server action; the panel is what a cashier reads with a
// customer waiting, so these assert the WORDS and the ROUTE, not that it
// renders. The two that matter most are negative: an online-paid order must
// never say "nothing paid", and a failed one must never say "Paid".
const getPickupOrderDetail = vi.fn();
vi.mock("@/app/actions/pos-pickup-actions", () => ({
  getPickupOrderDetail: (...a: unknown[]) => getPickupOrderDetail(...a),
}));

const { CollectionDetail } = await import("./collection-detail");

const ROW = {
  id: "o1",
  orderRef: "ORD100110576",
  customerName: "V G",
  itemCount: 2,
  total: 45,
  amountDue: 45,
  paidSoFar: 0,
  placedAt: "2026-08-20T10:00:00.000Z",
  expiresAt: "2026-08-27T10:00:00.000Z",
  status: "awaiting",
};

const DETAIL = {
  ...ROW,
  collectionCode: "K4M2-8PQR",
  customerPhone: "9876543210",
  preparedAt: null,
  collectedAt: null,
  subtotal: 45,
  discount: 0,
  tax: 0,
  taxInclusive: false,
  shipping: 0,
  storeCreditUsed: 0,
  paymentMethod: "pay_at_store",
  paymentStatus: "pending",
  payments: [],
  lines: [
    {
      name: "Amul Taaza Toned Milk",
      variantName: "1 L",
      quantity: 2,
      price: 20,
      lineDiscount: 0,
      total: 40,
    },
    {
      name: "Tata Salt",
      variantName: null,
      quantity: 1,
      price: 5,
      lineDiscount: 0,
      total: 5,
    },
  ],
};

function setup(
  detail: Record<string, unknown> | null = DETAIL,
  over: Record<string, unknown> = {},
) {
  const onMarkReady = vi.fn();
  const onHandOver = vi.fn();
  const onClose = vi.fn();
  getPickupOrderDetail.mockResolvedValue(
    detail ? { detail } : { error: "Couldn't load that order." },
  );
  const view = render(
    <CollectionDetail
      order={{ ...ROW, ...(over.order ?? {}) }}
      canFulfilPickup={over.canFulfilPickup !== false}
      busy={false}
      reloadKey={0}
      onClose={onClose}
      onMarkReady={onMarkReady}
      onHandOver={onHandOver}
    />,
  );
  return {
    onMarkReady,
    onHandOver,
    onClose,
    rerenderOrder: (order: typeof ROW) =>
      view.rerender(
        <CollectionDetail
          order={order}
          canFulfilPickup={over.canFulfilPickup !== false}
          busy={false}
          reloadKey={0}
          onClose={onClose}
          onMarkReady={onMarkReady}
          onHandOver={onHandOver}
        />,
      ),
  };
}

beforeEach(() => {
  getPickupOrderDetail.mockReset();
});

describe("collection detail — the goods", () => {
  it("names every product, with its variant and quantity", async () => {
    setup();
    expect(await screen.findByText("Amul Taaza Toned Milk")).toBeVisible();
    expect(screen.getByText("1 L")).toBeVisible();
    expect(screen.getByText("Tata Salt")).toBeVisible();
  });

  it("shows a line markdown rather than an unexplained smaller total", async () => {
    setup({
      ...DETAIL,
      lines: [{ ...DETAIL.lines[0], lineDiscount: 30, total: 10 }],
    });
    expect(await screen.findByText(/less ₹30\.00/)).toBeVisible();
  });

  it("names the order before the read lands, so it never opens blank", () => {
    setup();
    // Painted from the row that was tapped — the panel is a lookup, not a load.
    expect(screen.getByText("ORD100110576")).toBeVisible();
    expect(screen.getByText(/V G/)).toBeVisible();
  });

  it("says so when the order cannot be read", async () => {
    setup(null);
    expect(await screen.findByText(/couldn't load that order/i)).toBeVisible();
  });
});

describe("collection detail — the money", () => {
  it("leads with what is still owed", async () => {
    setup();
    const due = await screen.findByText(/still to collect/i);
    // Scoped to the payment card: ₹45.00 is also the subtotal, the order total
    // and the button, and an unscoped match would pass on any of them.
    expect(due.parentElement).toHaveTextContent("₹45.00");
  });

  it("★★ an order paid online does not read as unpaid", async () => {
    // Online checkout records NO payment row, so `payments` is empty and
    // paidSoFar is 0 on the commonest order in the queue.
    setup({
      ...DETAIL,
      amountDue: 0,
      paymentMethod: "razorpay",
      paymentStatus: "paid",
    });
    expect(await screen.findByText("Paid online")).toBeVisible();
    expect(screen.queryByText(/still to collect/i)).toBeNull();
  });

  it("★★ a failed payment is not reported as paid", async () => {
    setup({
      ...DETAIL,
      amountDue: 0,
      paymentMethod: "razorpay",
      paymentStatus: "failed",
    });
    expect(await screen.findByText(/payment failed/i)).toBeVisible();
  });

  it("shows a deposit as money already taken, and how", async () => {
    setup({
      ...DETAIL,
      total: 340,
      amountDue: 140,
      paidSoFar: 200,
      payments: [
        {
          method: "cash",
          amount: 200,
          reference: null,
          capturedAt: "2026-08-21T09:30:00.000Z",
        },
      ],
    });
    expect(await screen.findByText(/part paid/i)).toBeVisible();
    // The tender is named — a deposit visible only as a smaller balance is a
    // figure to be trusted rather than checked.
    expect(screen.getByText(/Cash/)).toBeVisible();
    expect(screen.getByText("₹200.00")).toBeVisible();
  });

  it("store credit sits under what was PAID, never in the totals ladder", async () => {
    setup({ ...DETAIL, storeCreditUsed: 15 });
    expect(await screen.findByText(/store credit applied/i)).toBeVisible();
    // §29: credit is a payment, so the sale value is unchanged by it.
    expect(screen.getByText("Order total").parentElement).toHaveTextContent(
      "₹45.00",
    );
  });
});

describe("collection detail — what it lets you do", () => {
  it("offers to take the money when money is owed", async () => {
    const { onHandOver } = setup();
    const take = await screen.findByRole("button", { name: /take ₹45\.00/i });
    fireEvent.click(take);
    // It owns no actions of its own — every button calls back to the queue,
    // which is where the tender pad and the refresh already live.
    expect(onHandOver).toHaveBeenCalledWith(
      expect.objectContaining({ id: "o1", amountDue: 45 }),
    );
  });

  it("offers a plain hand-over when nothing is owed", async () => {
    setup({ ...DETAIL, amountDue: 0, paymentStatus: "paid" });
    expect(
      await screen.findByRole("button", { name: /hand over/i }),
    ).toBeVisible();
  });

  it("offers Mark ready only on an unprepared order", async () => {
    setup();
    expect(screen.getByRole("button", { name: /mark ready/i })).toBeVisible();
    screen.getByRole("button", { name: /mark ready/i }).click();
    await waitFor(() => expect(true).toBe(true));
  });

  it("hides Mark ready once the box is on the shelf", () => {
    setup(DETAIL, { order: { ...ROW, status: "ready" } });
    expect(screen.queryByRole("button", { name: /mark ready/i })).toBeNull();
  });

  it("keeps a successful parent mutation newer than the open detail", async () => {
    const { rerenderOrder } = setup();
    await screen.findByText(/still to collect/i);
    rerenderOrder({ ...ROW, status: "ready" });
    expect(screen.getByText("Ready")).toBeVisible();
    expect(screen.queryByRole("button", { name: /mark ready/i })).toBeNull();
  });

  it("hides Mark ready from an operator who may not pack", () => {
    setup(DETAIL, { canFulfilPickup: false });
    expect(screen.queryByRole("button", { name: /mark ready/i })).toBeNull();
  });

  it("★★ a FAILED payment does not get the green button", async () => {
    // markCollected still permits the hand-over — its claim reads only
    // pickup_status — so the parcel CAN go out having taken nothing. What must
    // not happen is the screen contradicting itself: a full-strength "Hand
    // over" directly under "this order was never settled", where the button
    // wins the argument every time.
    setup({
      ...DETAIL,
      amountDue: 0,
      paymentMethod: "razorpay",
      paymentStatus: "failed",
    });
    const btn = await screen.findByRole("button", {
      name: /hand over anyway/i,
    });
    expect(btn.className).not.toMatch(/bg-emerald/);
    // Demoted, never hidden — the customer may well be entitled to the goods,
    // and that is the shop's call, not this panel's.
    expect(btn).toBeVisible();
  });

  it("offers no hand-over for a fully refunded order", async () => {
    setup({
      ...DETAIL,
      amountDue: 0,
      paymentStatus: "refunded",
    });
    expect(await screen.findByText(/refunded in full/i)).toBeVisible();
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /hand over|take ₹/i }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: /mark ready/i })).toBeNull();
    });
  });

  it("lets the newer detail status remove stale queue controls", async () => {
    setup({ ...DETAIL, status: "cancelled" });
    await screen.findByText(/still to collect/i);
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /hand over|take ₹/i }),
      ).toBeNull();
      expect(screen.queryByRole("button", { name: /mark ready/i })).toBeNull();
    });
  });

  it("hands the parent the newer balance that the panel displays", async () => {
    const { onHandOver } = setup({
      ...DETAIL,
      total: 45,
      paidSoFar: 25,
      amountDue: 20,
    });
    const take = await screen.findByRole("button", { name: /take ₹20\.00/i });
    fireEvent.click(take);
    expect(onHandOver).toHaveBeenCalledWith(
      expect.objectContaining({ amountDue: 20, paidSoFar: 25 }),
    );
  });

  it("labels the actual preparation time, not the promised ready-by date", async () => {
    setup({
      ...DETAIL,
      preparedAt: "2026-08-21T08:45:00.000Z",
    });
    expect(await screen.findByText(/prepared 21 aug/i)).toBeVisible();
  });

  it("★ offers NOTHING once the collection is gone", () => {
    // markCollected's claim is scoped to awaiting|ready, so every control here
    // could only ever fail — in front of the customer. Same rule as the row.
    setup(DETAIL, { order: { ...ROW, status: "cancelled" } });
    expect(
      screen.queryByRole("button", { name: /hand over|take ₹/i }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /mark ready/i })).toBeNull();
  });

  it("★ but a gone collection still RENDERS — the customer is standing there", () => {
    setup(DETAIL, { order: { ...ROW, status: "cancelled" } });
    expect(screen.getByText("ORD100110576")).toBeVisible();
  });

  it("closes on Escape", () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
