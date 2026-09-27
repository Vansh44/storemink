// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const addItem = vi.fn();
vi.mock("./cart/CartProvider", () => ({
  useCart: () => ({ addItem, items: [] }),
  lineKey: (p: string, v: string | null) => `${p}:${v ?? ""}`,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <span data-testid="img">{alt}</span>,
}));
const getQuickAddProduct = vi.fn();
vi.mock("@/app/actions/quick-add-actions", () => ({
  getQuickAddProduct: (...args: unknown[]) => getQuickAddProduct(...args),
}));

import { QuickAddButton } from "./quick-add-button";

const variant = (
  id: string,
  values: string[],
  stock = 5,
): Record<string, unknown> => ({
  id,
  name: values.join(" / "),
  base_price: 1200,
  selling_price: 999,
  special_price: null,
  images: [],
  track_inventory: true,
  stock,
  low_stock_threshold: null,
  allow_backorder: false,
  option_values: values,
});

const loaded = {
  id: "p1",
  slug: "linen-shirt",
  name: "Linen shirt",
  image_url: "/shirt.webp",
  category: "Shirts",
  options: [
    { name: "Size", values: ["S", "M"] },
    { name: "Colour", values: ["White", "Navy"] },
  ],
  variants: [
    // The first variant is sold out: the chooser must open on one that sells.
    variant("sw", ["S", "White"], 0),
    variant("sn", ["S", "Navy"]),
    variant("mw", ["M", "White"]),
    variant("mn", ["M", "Navy"]),
  ],
};

const card = {
  id: "p1",
  name: "Linen shirt",
  slug: "linen-shirt",
  image_url: "/shirt.webp",
  base_price: 1200,
  selling_price: 999,
  track_inventory: true,
  stock: 0,
  low_stock_threshold: null,
  allow_backorder: false,
  variants: [
    {
      base_price: 1200,
      selling_price: 999,
      track_inventory: true,
      stock: 5,
      low_stock_threshold: null,
      allow_backorder: false,
    },
  ],
};

function renderInLink() {
  const navigate = vi.fn();
  render(
    <div className="storefront-root">
      {/* Stands in for the card's <Link>: any click that reaches it navigates. */}
      <a href="#card" onClick={(e) => (e.preventDefault(), navigate())}>
        <QuickAddButton product={card} />
      </a>
    </div>,
  );
  return navigate;
}

describe("QuickAddButton with variants", () => {
  beforeEach(() => getQuickAddProduct.mockResolvedValue(loaded));

  it("opens the chooser instead of following the card link", async () => {
    const navigate = renderInLink();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose options for Linen shirt" }),
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(getQuickAddProduct).toHaveBeenCalledWith("p1");
  });

  it("opens on an available variant and adds the one chosen", async () => {
    const navigate = renderInLink();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose options for Linen shirt" }),
    );
    // S / White is sold out, so the chooser opens on S / Navy.
    expect(
      await screen.findByRole("button", { name: "Colour Navy" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Size M" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: "p1",
        variantId: "mn",
        variantName: "M / Navy",
        price: 999,
      }),
    );
    // Taps inside the portalled dialog never reach the card's link.
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders inside the storefront root, where the theme tokens live", async () => {
    renderInLink();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose options for Linen shirt" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.closest(".storefront-root")).not.toBeNull();
    expect(dialog.closest("a")).toBeNull();
  });

  it("closes on Escape and returns focus to the button", async () => {
    renderInLink();
    const button = screen.getByRole("button", {
      name: "Choose options for Linen shirt",
    });
    fireEvent.click(button);
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("says so when the product cannot be loaded", async () => {
    getQuickAddProduct.mockResolvedValue(null);
    renderInLink();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose options for Linen shirt" }),
    );
    expect(await screen.findByText(/could not be loaded/i)).toBeInTheDocument();
  });
});
