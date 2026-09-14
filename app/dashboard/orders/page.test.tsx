// @vitest-environment jsdom
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/order-actions", () => ({
  getOrders: vi.fn(),
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStore: vi.fn(async () => ({
    id: "store-1",
    plan: "pro",
    plan_expires_at: null,
    settings: { "pos.enabled": true },
  })),
}));
vi.mock("@/lib/pos/locations", () => ({
  getPosState: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/orders",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { getOrders } from "@/app/actions/order-actions";
import { getPosState } from "@/lib/pos/locations";
import OrdersPage from "./page";
import { OrdersManagementView } from "./orders-management-view";

const EMPTY_RESULT = {
  orders: [],
  total: 0,
  counts: {
    all: 0,
    pending: 0,
    processing: 0,
    shipped: 0,
    delivered: 0,
    completed: 0,
    cancelled: 0,
  },
  channelCounts: { all: 0, website: 0, pos: 0 },
};

function viewProps(element: ReactElement) {
  const view = Children.toArray(
    (element.props as { children: ReactNode }).children,
  ).find(
    (child) => isValidElement(child) && child.type === OrdersManagementView,
  );
  if (!isValidElement(view)) throw new Error("OrdersManagementView not found");
  return view.props as {
    channel: string;
    supportsPos: boolean;
  };
}

describe("dashboard Orders page POS entitlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOrders).mockResolvedValue(EMPTY_RESULT);
  });

  it("keeps a disabled/lower-plan store on the original Website order book", async () => {
    vi.mocked(getPosState).mockReturnValue({
      plan: "basic",
      posAvailable: false,
      posEnabled: false,
      locationsIncluded: 0,
    });

    const page = await OrdersPage({
      searchParams: Promise.resolve({ channel: "pos" }),
    });

    expect(getOrders).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "website" }),
    );
    expect(viewProps(page).channel).toBe("website");
    expect(viewProps(page).supportsPos).toBe(false);
  });

  it("opens the combined workspace by default when POS is enabled", async () => {
    vi.mocked(getPosState).mockReturnValue({
      plan: "pro",
      posAvailable: true,
      posEnabled: true,
      locationsIncluded: 2,
    });

    const page = await OrdersPage({ searchParams: Promise.resolve({}) });

    expect(getOrders).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "all" }),
    );
    expect(viewProps(page).channel).toBe("all");
    expect(viewProps(page).supportsPos).toBe(true);
  });

  it("renders the original Orders UI without channel tabs when POS is off", () => {
    render(
      <OrdersManagementView
        orders={[]}
        total={0}
        counts={EMPTY_RESULT.counts}
        channelCounts={EMPTY_RESULT.channelCounts}
        page={1}
        pageSize={25}
        query=""
        status=""
        paymentStatus=""
        paymentMethod=""
        dateRange=""
        channel="website"
        supportsPos={false}
      />,
    );

    expect(screen.getByRole("heading", { name: "Orders" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /POS orders/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /All orders/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search orders…")).toBeVisible();
  });
});
