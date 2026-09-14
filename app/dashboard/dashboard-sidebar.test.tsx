// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DashboardSidebar, resolveActiveSection } from "./dashboard-sidebar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/dashboard/locations/fulfilment",
  useSearchParams: () => new URLSearchParams(),
}));

// ---------------------------------------------------------------------------
// The sub-nav panel is chosen by this function, so getting it wrong swaps the
// left panel out from under someone mid-journey. That is what happened: every
// section nested via `parent:` (twelve of them) landed on Home.
// ---------------------------------------------------------------------------

// Shaped like the folded nav: nested sections become CHILDREN of their parent
// and are absent from the top level, even though they live at top-level paths.
const NAV = [
  { href: "/dashboard", label: "Home" },
  {
    href: "/dashboard/users",
    label: "Customers",
    children: [
      { href: "/dashboard/users", label: "All customers" },
      { href: "/dashboard/users/user_groups", label: "Groups" },
    ],
  },
  {
    href: "/dashboard/settings",
    label: "Settings",
    children: [
      { href: "/dashboard/settings/account", label: "Account" },
      { href: "/dashboard/settings/domain", label: "Domain" },
      // Top-level PATH, nested POSITION — the case that broke.
      { href: "/dashboard/admins", label: "Staff" },
      { href: "/dashboard/billing", label: "Billing" },
    ],
  },
  {
    href: "/dashboard/locations",
    label: "Locations",
    children: [
      { href: "/dashboard/locations", label: "All locations" },
      {
        href: "/dashboard/locations/fulfilment",
        label: "Online fulfilment & pickup",
      },
    ],
  },
  { href: "/dashboard/orders", label: "Orders" },
];

describe("resolveActiveSection", () => {
  it("★ keeps the Settings panel open on a nested section at a top-level path", () => {
    // The reported bug: Settings → Staff opened the page but reverted the panel
    // to Home's. `/dashboard/admins` shares no prefix with `/dashboard/settings`,
    // so only walking the children can relate them.
    expect(resolveActiveSection(NAV, "/dashboard/admins")?.label).toBe(
      "Settings",
    );
    expect(resolveActiveSection(NAV, "/dashboard/billing")?.label).toBe(
      "Settings",
    );
  });

  it("still resolves a nested section's own sub-paths to the parent", () => {
    expect(resolveActiveSection(NAV, "/dashboard/admins/new")?.label).toBe(
      "Settings",
    );
  });

  it("keeps fulfilment inside the Locations sub-navigation", () => {
    expect(resolveActiveSection(NAV, "/dashboard/locations")?.label).toBe(
      "Locations",
    );
    expect(
      resolveActiveSection(NAV, "/dashboard/locations/fulfilment")?.label,
    ).toBe("Locations");
  });

  it("★ prefers a DIRECT match over a parent that lists the same child", () => {
    // Customers is both a top-level section and lists /dashboard/users as a
    // child. If child-matching ran first, a parent could steal its own panel.
    expect(resolveActiveSection(NAV, "/dashboard/users")?.label).toBe(
      "Customers",
    );
    expect(
      resolveActiveSection(NAV, "/dashboard/users/user_groups")?.label,
    ).toBe("Customers");
  });

  it("resolves ordinary top-level sections unchanged", () => {
    expect(resolveActiveSection(NAV, "/dashboard/orders")?.label).toBe(
      "Orders",
    );
    expect(resolveActiveSection(NAV, "/dashboard/settings")?.label).toBe(
      "Settings",
    );
    expect(resolveActiveSection(NAV, "/dashboard")?.label).toBe("Home");
  });

  it("does not let Home's exact href swallow every other path", () => {
    // `matches` exempts "/dashboard" from prefix matching for this reason: it is
    // a prefix of literally every dashboard route.
    expect(resolveActiveSection(NAV, "/dashboard/orders")?.label).not.toBe(
      "Home",
    );
  });

  it("falls back to Home for an unknown path rather than nothing", () => {
    // A route with no nav entry (a detail page, a deep link) should leave the
    // sidebar in a sane state, not blank it.
    expect(resolveActiveSection(NAV, "/dashboard/nowhere")?.label).toBe("Home");
  });

  it("survives a nav with no Home entry, and an empty nav", () => {
    // A restricted role may not see Home at all; the sidebar must still render.
    const noHome = NAV.filter((i) => i.href !== "/dashboard");
    expect(resolveActiveSection(noHome, "/dashboard/nowhere")?.label).toBe(
      "Customers",
    );
    expect(resolveActiveSection([], "/dashboard")).toBeUndefined();
  });
});

describe("DashboardSidebar child labels", () => {
  it("wraps long destination names instead of hiding them behind an ellipsis", () => {
    render(
      <DashboardSidebar
        groups={[
          {
            group: "Sell in person",
            items: [
              {
                href: "/dashboard/locations",
                label: "Locations",
                icon: "location",
                children: [
                  {
                    href: "/dashboard/locations",
                    label: "All locations",
                    icon: "location",
                  },
                  {
                    href: "/dashboard/locations/fulfilment",
                    label: "Online fulfilment & pickup",
                    icon: "shipping",
                  },
                ],
              },
            ],
          },
        ]}
      />,
    );

    const link = screen.getByRole("link", {
      name: "Online fulfilment & pickup",
    });
    const label = within(link).getByText("Online fulfilment & pickup");
    expect(link).toHaveClass("items-start");
    expect(label).toHaveClass("whitespace-normal", "break-words");
    expect(label).not.toHaveClass("truncate");
  });
});
