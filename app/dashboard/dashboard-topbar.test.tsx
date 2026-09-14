// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

// Keep these tests about search; the real children have their own data and
// authentication concerns that are unrelated to navigating the command list.
vi.mock("./components/notification-bell", () => ({
  NotificationBell: () => <button type="button">Notifications</button>,
}));

vi.mock("./topbar-profile", () => ({
  formatRole: (role: string) => role,
  TopbarProfile: () => <div>Profile</div>,
}));

vi.mock("./location-tag", () => ({
  LocationTag: () => null,
}));

import { DashboardTopbar, type DashboardSearchGroup } from "./dashboard-topbar";

const SEARCH_GROUPS: DashboardSearchGroup[] = [
  {
    group: "Workspace",
    items: [
      { label: "Orders", href: "/dashboard/orders" },
      {
        label: "Products",
        href: "/dashboard/products",
        children: [{ label: "Inventory", href: "/dashboard/inventory" }],
      },
      {
        label: "Customers",
        href: "/dashboard/users",
        children: [{ label: "All customers", href: "/dashboard/users" }],
      },
    ],
  },
  {
    group: "Settings",
    items: [{ label: "Settings", href: "/dashboard/settings" }],
  },
];

function renderTopbar(searchGroups = SEARCH_GROUPS) {
  render(
    <DashboardTopbar
      email="owner@example.com"
      role="owner"
      storeName="Echos"
      searchGroups={searchGroups}
    />,
  );
}

function desktopResults() {
  const list = document.getElementById("dashboard-search-results");
  expect(list).not.toBeNull();
  return within(list as HTMLElement);
}

describe("DashboardTopbar search", () => {
  beforeEach(() => {
    push.mockReset();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
  });

  it("filters dashboard destinations and navigates to the selected result", () => {
    renderTopbar();
    const input = screen.getByRole("combobox", { name: "Search dashboard" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "inv" } });

    const inventory = desktopResults().getByRole("option", {
      name: /Inventory/,
    });
    expect(
      desktopResults().queryByRole("option", { name: /Orders/ }),
    ).toBeNull();

    fireEvent.click(inventory);
    expect(push).toHaveBeenCalledWith("/dashboard/inventory");
  });

  it("opens and focuses search with Command/Ctrl+K", async () => {
    renderTopbar();
    const input = screen.getByRole("combobox", { name: "Search dashboard" });

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(
      desktopResults().getByRole("option", { name: /Orders/ }),
    ).toBeVisible();
  });

  it("submits the active result from the keyboard", () => {
    renderTopbar();
    const input = screen.getByRole("combobox", { name: "Search dashboard" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "prod" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(push).toHaveBeenCalledWith("/dashboard/products");
  });

  it("only searches the permission-filtered groups supplied by the layout", () => {
    renderTopbar([
      {
        group: "Workspace",
        items: [{ label: "Orders", href: "/dashboard/orders" }],
      },
    ]);
    const input = screen.getByRole("combobox", { name: "Search dashboard" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "customers" } });

    expect(desktopResults().queryByRole("option")).toBeNull();
    expect(
      desktopResults().getByText(/No dashboard pages match/),
    ).toBeVisible();
  });

  it("retains duplicate child labels as aliases without duplicate results", () => {
    renderTopbar();
    const input = screen.getByRole("combobox", { name: "Search dashboard" });

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "all customers" } });

    const results = desktopResults().getAllByRole("option");
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveAccessibleName(/Customers/);
  });

  it("opens the touch search dialog and navigates from it", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });
    renderTopbar();

    fireEvent.click(
      screen.getByRole("button", { name: "Open dashboard search" }),
    );

    const dialog = screen.getByRole("dialog", { name: "Search dashboard" });
    const input = within(dialog).getByRole("combobox", {
      name: "Search dashboard pages",
    });
    await waitFor(() => expect(input).toHaveFocus());

    fireEvent.change(input, { target: { value: "settings" } });
    fireEvent.click(within(dialog).getByRole("option", { name: /Settings/ }));

    expect(push).toHaveBeenCalledWith("/dashboard/settings");
  });
});
