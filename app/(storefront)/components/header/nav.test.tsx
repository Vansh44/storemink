// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import { DesktopNav } from "./desktop-nav";
import { DrawerNav } from "./drawer-nav";
import type { NavLink } from "@/lib/chrome/nav";

const links: NavLink[] = [
  {
    label: "Shop",
    href: "/shop",
    image_url: "/themes/vitrine/hero.webp",
    children: [
      {
        label: "Men",
        href: "/shop?category=men",
        children: [{ label: "Shirts", href: "/shop?category=shirts" }],
      },
      { label: "Sale", href: "/shop?category=sale" },
    ],
  },
  {
    label: "Help",
    href: "",
    children: [{ label: "Returns", href: "/returns" }],
  },
  { label: "About", href: "/about" },
];

beforeEach(() => {
  pathname = "/";
});

describe("DesktopNav", () => {
  it("renders a plain item as the same plain link", () => {
    render(<DesktopNav links={[{ label: "About", href: "/about" }]} />);
    expect(screen.getByRole("link", { name: "About" })).toHaveAttribute(
      "href",
      "/about",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("makes an item with children a closed disclosure button", () => {
    render(<DesktopNav links={links} />);
    const shop = screen.getByRole("button", { name: "Shop" });
    expect(shop).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Shirts" })).toBeNull();
  });

  it("opens a mega panel with columns, the image and View all", () => {
    render(<DesktopNav links={links} />);
    fireEvent.click(screen.getByRole("button", { name: "Shop" }));
    expect(screen.getByRole("button", { name: "Shop" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("link", { name: "Shirts" })).toHaveAttribute(
      "href",
      "/shop?category=shirts",
    );
    expect(screen.getByRole("link", { name: "Men" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sale" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View all Shop" })).toHaveAttribute(
      "href",
      "/shop",
    );
    // The feature tile is a named link, not an unlabelled image link.
    const tile = screen
      .getAllByRole("link", { name: "Shop" })
      .find((a) => a.querySelector("img"));
    expect(tile?.querySelector("img")).toHaveAttribute(
      "src",
      "/themes/vitrine/hero.webp",
    );
  });

  it("opens one menu at a time, and a short list with no View all for a heading", () => {
    render(<DesktopNav links={links} />);
    fireEvent.click(screen.getByRole("button", { name: "Shop" }));
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByRole("button", { name: "Shop" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("link", { name: "Returns" })).toBeInTheDocument();
    expect(screen.queryByText(/View all Help/)).toBeNull();
  });

  it("closes on Escape and returns focus to its button", () => {
    render(<DesktopNav links={links} />);
    const shop = screen.getByRole("button", { name: "Shop" });
    fireEvent.click(shop);
    fireEvent.keyDown(screen.getByRole("link", { name: "Shirts" }), {
      key: "Escape",
    });
    expect(shop).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(shop);
  });

  it("opens on mouse hover but not on a touch pointer", () => {
    render(<DesktopNav links={links} />);
    const item = screen.getByRole("button", { name: "Shop" }).parentElement!;
    fireEvent.pointerEnter(item, { pointerType: "touch" });
    expect(screen.getByRole("button", { name: "Shop" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    fireEvent.pointerEnter(item, { pointerType: "mouse" });
    expect(screen.getByRole("button", { name: "Shop" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("closes after the mouse leaves, not instantly", () => {
    vi.useFakeTimers();
    try {
      render(<DesktopNav links={links} />);
      const item = screen.getByRole("button", { name: "Shop" }).parentElement!;
      fireEvent.pointerEnter(item, { pointerType: "mouse" });
      fireEvent.pointerLeave(item, { pointerType: "mouse" });
      const shop = screen.getByRole("button", { name: "Shop" });
      expect(shop).toHaveAttribute("aria-expanded", "true");
      act(() => vi.advanceTimersByTime(200));
      expect(shop).toHaveAttribute("aria-expanded", "false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes when a press lands outside the menu", () => {
    render(
      <>
        <DesktopNav links={links} />
        <p>page</p>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Shop" }));
    fireEvent.pointerDown(screen.getByText("page"));
    expect(screen.getByRole("button", { name: "Shop" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("closes when the page changes", () => {
    const { rerender } = render(<DesktopNav links={links} />);
    fireEvent.click(screen.getByRole("button", { name: "Shop" }));
    pathname = "/shop";
    rerender(<DesktopNav links={links} />);
    expect(screen.getByRole("button", { name: "Shop" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});

describe("DrawerNav", () => {
  it("drills down level by level and back", () => {
    const onNavigate = vi.fn();
    render(<DrawerNav links={links} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Shop" }));
    // On the second level, Back has focus and About is gone.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Back" }),
    );
    expect(screen.queryByRole("link", { name: "About" })).toBeNull();
    expect(screen.getByRole("link", { name: "View all Shop" })).toHaveAttribute(
      "href",
      "/shop",
    );

    fireEvent.click(screen.getByRole("button", { name: "Men" }));
    fireEvent.click(screen.getByRole("link", { name: "Shirts" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("link", { name: "About" })).toBeInTheDocument();
    // Focus returns to the row that was opened.
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Shop" }),
    );
  });

  it("offers no View all for a heading without a link", () => {
    render(<DrawerNav links={links} onNavigate={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    // By text, not role: an anchor with an empty href has no link role, so a
    // role query would pass even if the dead link were rendered.
    expect(screen.queryByText(/View all/)).toBeNull();
    expect(screen.getByRole("link", { name: "Returns" })).toBeInTheDocument();
  });

  it("renders a flat menu as plain links", () => {
    render(
      <DrawerNav
        links={[{ label: "About", href: "/about" }]}
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByRole("link", { name: "About" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
