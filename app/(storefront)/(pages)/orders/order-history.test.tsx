// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { MyOrderRow } from "@/app/actions/customer-order-actions";
import { OrderHistory } from "./order-history";

function order(id: string, overrides: Partial<MyOrderRow> = {}): MyOrderRow {
  return {
    id,
    order_ref: `ORD-${id}`,
    created_at: "2026-08-14T00:00:00.000Z",
    status: "completed",
    payment_status: "paid",
    payment_method: "cash",
    total: 500,
    currency: "INR",
    item_count: 1,
    first_item: `Item ${id}`,
    thumbnails: [],
    fulfilment_type: "delivery",
    pickup_status: null,
    sales_channel: "online",
    ...overrides,
  };
}

describe("OrderHistory", () => {
  it("keeps a delivery-only store on the simpler untabbed list", () => {
    render(
      <OrderHistory
        orders={[order("WEB")]}
        showInStoreTab={false}
        supportsPos={false}
        supportsPickup={false}
      />,
    );

    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByText("ORD-WEB")).toBeInTheDocument();
  });

  it("switches from online delivery to POS and pickup history", async () => {
    const user = userEvent.setup();
    render(
      <OrderHistory
        orders={[
          order("WEB"),
          order("POS", { sales_channel: "pos" }),
          order("PICKUP", { fulfilment_type: "pickup" }),
        ]}
        showInStoreTab
        supportsPos
        supportsPickup
      />,
    );

    expect(screen.getByText("ORD-WEB")).toBeInTheDocument();
    expect(screen.queryByText("ORD-POS")).not.toBeInTheDocument();
    expect(screen.queryByText("ORD-PICKUP")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "In store" }));

    expect(screen.queryByText("ORD-WEB")).not.toBeInTheDocument();
    expect(screen.getByText("ORD-POS")).toBeInTheDocument();
    expect(screen.getByText("ORD-PICKUP")).toBeInTheDocument();
  });

  it("explains how a pickup-capable empty store can create in-store history", async () => {
    const user = userEvent.setup();
    render(
      <OrderHistory
        orders={[]}
        showInStoreTab
        supportsPos={false}
        supportsPickup
      />,
    );

    await user.click(screen.getByRole("tab", { name: "In store" }));
    expect(screen.getByText("No in-store purchases yet")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Shop for pickup" }),
    ).toHaveAttribute("href", "/shop");
  });
});
