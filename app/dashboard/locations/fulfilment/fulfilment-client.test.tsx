// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FulfilmentClient } from "./fulfilment-client";
import { saveFulfilmentRules } from "@/app/actions/location-actions";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/app/actions/location-actions", () => ({
  saveFulfilmentRules: vi.fn(async () => ({ success: true })),
}));

const locations = [
  { id: "delhi", name: "Delhi", active: true, fulfilsOnline: true },
  { id: "shop", name: "Shop", active: true, fulfilsOnline: true },
  {
    id: "warehouse",
    name: "Warehouse",
    active: false,
    fulfilsOnline: false,
  },
];

describe("FulfilmentClient", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps routing and checkout in one aligned workspace", () => {
    render(
      <FulfilmentClient
        locations={locations}
        rules={{
          strategy: "priority",
          priority: ["delhi", "shop"],
          skipInactive: true,
        }}
        plan="pro"
        canManage
      >
        <div data-testid="checkout-settings">Checkout settings</div>
      </FulfilmentClient>,
    );

    const workspace = screen.getByTestId("fulfilment-workspace");
    expect(within(workspace).getByText("Website order routing")).toBeVisible();
    expect(within(workspace).getByText("Routing method")).toBeVisible();
    expect(within(workspace).getByText("Location priority")).toBeVisible();
    expect(within(workspace).getByTestId("checkout-settings")).toBeVisible();
    expect(screen.getByText("Warehouse")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Enable in location" }),
    ).toHaveAttribute("href", "/dashboard/locations/warehouse");
  });

  it("reorders locations and saves the visible priority", async () => {
    render(
      <FulfilmentClient
        locations={locations}
        rules={{
          strategy: "priority",
          priority: ["delhi", "shop"],
          skipInactive: true,
        }}
        plan="pro"
        canManage
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Move Delhi down" }));
    fireEvent.click(screen.getByRole("button", { name: "Save routing" }));

    await waitFor(() =>
      expect(saveFulfilmentRules).toHaveBeenCalledWith({
        strategy: "priority",
        priority: ["shop", "delhi"],
        skipInactive: true,
      }),
    );
  });

  it("shows routing read-only when the viewer cannot manage locations", () => {
    render(
      <FulfilmentClient
        locations={locations}
        rules={{
          strategy: "priority",
          priority: ["delhi", "shop"],
          skipInactive: true,
        }}
        plan="pro"
        canManage={false}
      />,
    );

    expect(screen.queryByRole("button", { name: /Move Delhi/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save routing" })).toBeNull();
  });
});
