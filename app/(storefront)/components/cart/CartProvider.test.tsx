// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, act } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

// CartProvider pulls the storefront coupon validator (a "use server" module);
// mock it so we drive the apply-coupon path without a network/Supabase round-trip.
vi.mock("@/app/actions/coupon-actions", () => ({ validateCoupon: vi.fn() }));

import CartProvider, { useCart, lineKey } from "./CartProvider";
import { validateCoupon } from "@/app/actions/coupon-actions";

// A tiny consumer that surfaces the cart context as test-readable DOM + buttons,
// so we can exercise the provider through real React state transitions.
function Harness() {
  const cart = useCart();
  const [reconcileOut, setReconcileOut] = useState("");
  return (
    <div>
      <span data-testid="hydrated">{String(cart.hydrated)}</span>
      <span data-testid="totalItems">{cart.totalItems}</span>
      <span data-testid="subtotal">{cart.subtotal}</span>
      <span data-testid="discount">{cart.couponDiscount}</span>
      <span data-testid="total">{cart.total}</span>
      <span data-testid="valid">{String(cart.couponValid)}</span>
      <span data-testid="open">{String(cart.isCartOpen)}</span>
      <span data-testid="coupon">{cart.appliedCoupon?.code ?? ""}</span>
      <span data-testid="reconcile">{reconcileOut}</span>
      <span data-testid="lines">
        {cart.items
          .map((i) => `${lineKey(i.productId, i.variantId)}x${i.quantity}`)
          .join("|")}
      </span>
      <button
        onClick={() =>
          cart.addItem(
            {
              productId: "p1",
              slug: "soap",
              name: "Soap",
              variantId: null,
              variantName: null,
              price: 100,
              basePrice: 120,
              image: null,
            },
            2,
          )
        }
      >
        addP1
      </button>
      <button
        onClick={() =>
          cart.addItem({
            productId: "p2",
            slug: "lotion",
            name: "Lotion",
            variantId: "v1",
            variantName: "Large",
            price: 50,
            basePrice: 50,
            image: null,
          })
        }
      >
        addP2
      </button>
      <button onClick={() => cart.setQuantity(lineKey("p1", null), 5)}>
        setP1to5
      </button>
      <button onClick={() => cart.setQuantity(lineKey("p1", null), 0)}>
        setP1to0
      </button>
      <button onClick={() => cart.removeItem(lineKey("p1", null))}>
        removeP1
      </button>
      {/* A tracked, non-backorderable line with only 3 in stock. Added with a
          quantity of 5 to prove the provider clamps to the snapshot cap. */}
      <button
        onClick={() =>
          cart.addItem(
            {
              productId: "p3",
              slug: "tea",
              name: "Tea",
              variantId: null,
              variantName: null,
              price: 10,
              basePrice: 10,
              image: null,
              trackInventory: true,
              stock: 3,
              allowBackorder: false,
            },
            5,
          )
        }
      >
        addLimited5
      </button>
      <button onClick={() => cart.setQuantity(lineKey("p3", null), 10)}>
        setLimitedTo10
      </button>
      <button
        onClick={() =>
          setReconcileOut(
            JSON.stringify(
              cart.reconcileStock([
                {
                  productId: "p1",
                  variantId: null,
                  exists: true,
                  trackInventory: true,
                  stock: 1,
                  allowBackorder: false,
                },
              ]),
            ),
          )
        }
      >
        reconcileP1To1
      </button>
      <button
        onClick={() =>
          setReconcileOut(
            JSON.stringify(
              cart.reconcileStock([
                {
                  productId: "p1",
                  variantId: null,
                  exists: true,
                  trackInventory: true,
                  stock: 0,
                  allowBackorder: false,
                },
              ]),
            ),
          )
        }
      >
        reconcileP1SoldOut
      </button>
      <button
        onClick={() =>
          setReconcileOut(
            JSON.stringify(
              cart.reconcileStock([
                {
                  productId: "p1",
                  variantId: null,
                  exists: false,
                  trackInventory: false,
                  stock: 0,
                  allowBackorder: false,
                },
              ]),
            ),
          )
        }
      >
        reconcileP1Gone
      </button>
      <button onClick={() => cart.clear()}>clear</button>
      <button onClick={() => cart.openCart()}>open</button>
      <button onClick={() => cart.closeCart()}>close</button>
      <button onClick={() => cart.applyCoupon("SAVE10")}>apply</button>
      <button onClick={() => cart.removeCoupon()}>removeCoupon</button>
    </div>
  );
}

function renderCart() {
  return render(
    <CartProvider>
      <Harness />
    </CartProvider>,
  );
}

const PCT_COUPON = {
  code: "SAVE10",
  discountType: "percentage" as const,
  discountValue: 10,
  minOrderAmount: 0,
  description: null,
};

describe("CartProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("hydrates empty and exposes zeroed totals", () => {
    renderCart();
    expect(screen.getByTestId("hydrated")).toHaveTextContent("true");
    expect(screen.getByTestId("totalItems")).toHaveTextContent("0");
    expect(screen.getByTestId("subtotal")).toHaveTextContent("0");
    expect(screen.getByTestId("total")).toHaveTextContent("0");
  });

  it("adds items, merges duplicate lines by product+variant, and totals", async () => {
    const user = userEvent.setup();
    renderCart();

    await user.click(screen.getByText("addP1")); // qty 2 @ 100
    await user.click(screen.getByText("addP2")); // qty 1 @ 50
    await user.click(screen.getByText("addP1")); // +2 -> merges to qty 4

    expect(screen.getByTestId("lines")).toHaveTextContent("p1:x4|p2:v1x1");
    expect(screen.getByTestId("totalItems")).toHaveTextContent("5");
    expect(screen.getByTestId("subtotal")).toHaveTextContent("450"); // 4*100 + 1*50
  });

  it("clamps addItem to the line's stock snapshot (tracked, no backorder)", async () => {
    const user = userEvent.setup();
    renderCart();

    // Only 3 in stock, but we try to add 5 → capped at 3.
    await user.click(screen.getByText("addLimited5"));
    expect(screen.getByTestId("lines")).toHaveTextContent("p3:x3");

    // A second add of 5 must not pile past the cap either.
    await user.click(screen.getByText("addLimited5"));
    expect(screen.getByTestId("lines")).toHaveTextContent("p3:x3");
    expect(screen.getByTestId("totalItems")).toHaveTextContent("3");
  });

  it("clamps setQuantity to the line's stock snapshot", async () => {
    const user = userEvent.setup();
    renderCart();

    await user.click(screen.getByText("addLimited5")); // qty 3, stock 3
    await user.click(screen.getByText("setLimitedTo10")); // ask for 10
    expect(screen.getByTestId("lines")).toHaveTextContent("p3:x3");
  });

  it("reconcileStock reduces an over-stock line and reports it", async () => {
    const user = userEvent.setup();
    renderCart();

    await user.click(screen.getByText("addP1")); // qty 2, untracked snapshot
    await user.click(screen.getByText("reconcileP1To1")); // live stock now 1
    expect(screen.getByTestId("lines")).toHaveTextContent("p1:x1");
    const out = JSON.parse(screen.getByTestId("reconcile").textContent!);
    expect(out.reduced).toEqual([{ name: "Soap", from: 2, to: 1 }]);
    expect(out.removed).toEqual([]);
  });

  it("reconcileStock drops a sold-out line and reports it removed", async () => {
    const user = userEvent.setup();
    renderCart();

    await user.click(screen.getByText("addP1"));
    await user.click(screen.getByText("reconcileP1SoldOut")); // live stock 0
    expect(screen.getByTestId("lines")).toHaveTextContent("");
    const out = JSON.parse(screen.getByTestId("reconcile").textContent!);
    expect(out.removed).toEqual(["Soap"]);
  });

  it("reconcileStock drops a line whose product no longer exists", async () => {
    const user = userEvent.setup();
    renderCart();

    await user.click(screen.getByText("addP1"));
    await user.click(screen.getByText("reconcileP1Gone")); // exists: false
    expect(screen.getByTestId("lines")).toHaveTextContent("");
    const out = JSON.parse(screen.getByTestId("reconcile").textContent!);
    expect(out.removed).toEqual(["Soap"]);
  });

  it("setQuantity updates a line and removes it when set below 1", async () => {
    const user = userEvent.setup();
    renderCart();

    await user.click(screen.getByText("addP1"));
    await user.click(screen.getByText("setP1to5"));
    expect(screen.getByTestId("lines")).toHaveTextContent("p1:x5");

    await user.click(screen.getByText("setP1to0"));
    expect(screen.getByTestId("lines")).toHaveTextContent("");
    expect(screen.getByTestId("totalItems")).toHaveTextContent("0");
  });

  it("removeItem drops a line; clear empties cart and coupon", async () => {
    const user = userEvent.setup();
    vi.mocked(validateCoupon).mockResolvedValue({ coupon: PCT_COUPON } as any);
    renderCart();

    await user.click(screen.getByText("addP1"));
    await user.click(screen.getByText("apply"));
    expect(screen.getByTestId("coupon")).toHaveTextContent("SAVE10");

    await user.click(screen.getByText("removeP1"));
    expect(screen.getByTestId("lines")).toHaveTextContent("");

    await user.click(screen.getByText("addP1"));
    await user.click(screen.getByText("clear"));
    expect(screen.getByTestId("lines")).toHaveTextContent("");
    expect(screen.getByTestId("coupon")).toHaveTextContent("");
  });

  it("openCart / closeCart toggle the drawer flag", async () => {
    const user = userEvent.setup();
    renderCart();
    expect(screen.getByTestId("open")).toHaveTextContent("false");
    await user.click(screen.getByText("open"));
    expect(screen.getByTestId("open")).toHaveTextContent("true");
    await user.click(screen.getByText("close"));
    expect(screen.getByTestId("open")).toHaveTextContent("false");
  });

  it("applies a percentage coupon and computes a clamped, rounded discount", async () => {
    const user = userEvent.setup();
    vi.mocked(validateCoupon).mockResolvedValue({ coupon: PCT_COUPON } as any);
    renderCart();

    await user.click(screen.getByText("addP1")); // subtotal 200 (2*100)
    await user.click(screen.getByText("apply"));

    expect(validateCoupon).toHaveBeenCalledWith("SAVE10", 200);
    expect(screen.getByTestId("valid")).toHaveTextContent("true");
    expect(screen.getByTestId("discount")).toHaveTextContent("20"); // 10% of 200
    expect(screen.getByTestId("total")).toHaveTextContent("180");
  });

  it("returns the validator error and applies nothing on a bad code", async () => {
    const user = userEvent.setup();
    vi.mocked(validateCoupon).mockResolvedValue({ error: "Expired." } as any);
    renderCart();

    await user.click(screen.getByText("addP1"));
    await user.click(screen.getByText("apply"));

    expect(screen.getByTestId("coupon")).toHaveTextContent("");
    expect(screen.getByTestId("discount")).toHaveTextContent("0");
  });

  it("invalidates a coupon (0 off) when the cart drops below its minimum", async () => {
    const user = userEvent.setup();
    vi.mocked(validateCoupon).mockResolvedValue({
      coupon: { ...PCT_COUPON, minOrderAmount: 300 },
    } as any);
    renderCart();

    await user.click(screen.getByText("addP1")); // subtotal 200
    await user.click(screen.getByText("apply")); // min 300 not met
    expect(screen.getByTestId("valid")).toHaveTextContent("false");
    expect(screen.getByTestId("discount")).toHaveTextContent("0");

    await user.click(screen.getByText("addP1")); // subtotal 400 -> meets min
    expect(screen.getByTestId("valid")).toHaveTextContent("true");
    expect(screen.getByTestId("discount")).toHaveTextContent("40");
  });

  it("caps a fixed discount at the subtotal so the total never goes negative", async () => {
    const user = userEvent.setup();
    vi.mocked(validateCoupon).mockResolvedValue({
      coupon: {
        code: "BIG",
        discountType: "fixed",
        discountValue: 9999,
        minOrderAmount: 0,
        description: null,
      },
    } as any);
    renderCart();

    await user.click(screen.getByText("addP1")); // subtotal 200
    await user.click(screen.getByText("apply"));
    expect(screen.getByTestId("discount")).toHaveTextContent("200");
    expect(screen.getByTestId("total")).toHaveTextContent("0");
  });

  it("removeCoupon clears the applied coupon", async () => {
    const user = userEvent.setup();
    vi.mocked(validateCoupon).mockResolvedValue({ coupon: PCT_COUPON } as any);
    renderCart();
    await user.click(screen.getByText("addP1"));
    await user.click(screen.getByText("apply"));
    expect(screen.getByTestId("coupon")).toHaveTextContent("SAVE10");
    await user.click(screen.getByText("removeCoupon"));
    expect(screen.getByTestId("coupon")).toHaveTextContent("");
  });

  it("persists the cart to localStorage and rehydrates it on remount", async () => {
    const user = userEvent.setup();
    const { unmount } = renderCart();
    await user.click(screen.getByText("addP1"));
    expect(JSON.parse(localStorage.getItem("wholesip-cart-v1")!)).toHaveLength(
      1,
    );

    unmount();
    renderCart();
    expect(screen.getByTestId("lines")).toHaveTextContent("p1:x2");
    expect(screen.getByTestId("subtotal")).toHaveTextContent("200");
  });

  it("ignores malformed persisted storage without throwing", () => {
    localStorage.setItem("wholesip-cart-v1", "{not json");
    expect(() => renderCart()).not.toThrow();
    expect(screen.getByTestId("totalItems")).toHaveTextContent("0");
  });

  it("useCart throws when used outside the provider", () => {
    function Bare() {
      useCart();
      return null;
    }
    // Silence the expected React error boundary log.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow(/useCart must be used within/);
    spy.mockRestore();
  });
});

// Keep `act` referenced for environments that require it explicitly.
void act;
