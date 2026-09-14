// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

// CartProvider pulls the storefront coupon validator (a "use server" module);
// mock it so we drive the apply-coupon path without a network/Supabase round-trip.
vi.mock("@/app/actions/coupon-actions", () => ({
  validateCoupon: vi.fn(),
  getAvailableStorefrontCoupons: vi.fn().mockResolvedValue([]),
}));

// CouponField surfaces apply/remove feedback through sonner toasts.
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import CartProvider, { useCart } from "./CartProvider";
import CouponField from "./CouponField";
import {
  validateCoupon,
  getAvailableStorefrontCoupons,
} from "@/app/actions/coupon-actions";
import { toast } from "sonner";

// Seeds the cart with one item so subtotal > 0 (required for a coupon to be
// "valid"). Mirrors the Harness pattern from CartProvider.test.tsx — the
// CouponField itself has no add-to-cart UI.
function CartSeeder({ price }: { price: number }) {
  const cart = useCart();
  return (
    <button
      onClick={() =>
        cart.addItem({
          productId: "p1",
          slug: "soap",
          name: "Soap",
          variantId: null,
          variantName: null,
          price,
          basePrice: price,
          image: null,
        })
      }
    >
      seed
    </button>
  );
}

function renderField({ seedPrice }: { seedPrice?: number } = {}) {
  return render(
    <CartProvider>
      {seedPrice != null && <CartSeeder price={seedPrice} />}
      <CouponField />
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

describe("CouponField", () => {
  beforeEach(() => {
    // ⚠ `clearAllMocks` clears CALLS, not IMPLEMENTATIONS. The two tests at the
    // bottom of this file set `getAvailableStorefrontCoupons` to return a coupon,
    // and that return value used to survive into every test that ran after them —
    // so those tests rendered an "Available Coupons" list with its own Apply
    // button, and `getByRole("button", { name: "Apply" })` found TWO.
    //
    // ★ IT PASSED ONLY BECAUSE OF DECLARATION ORDER. The two offenders are last,
    // so nothing followed them. `vitest --sequence.shuffle` fails four tests here
    // — which is how a suite that is green on your machine goes red on a CI runner
    // that happens to schedule differently, with a message ("found multiple
    // elements") that says nothing about the real cause.
    //
    // Restored explicitly rather than with `resetAllMocks()`, which would also
    // wipe the `mockResolvedValue([])` set at the `vi.mock` factory above and
    // leave the component awaiting `undefined`.
    vi.clearAllMocks();
    vi.mocked(getAvailableStorefrontCoupons).mockResolvedValue([]);
    localStorage.clear();
  });

  it("renders the input + Apply button; Apply is disabled until something is typed", async () => {
    const user = userEvent.setup();
    renderField();

    const input = screen.getByPlaceholderText("Coupon code");
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(input).toBeInTheDocument();
    expect(apply).toBeDisabled();

    await user.type(input, "X");
    expect(apply).toBeEnabled();
  });

  it("uppercases typed input", async () => {
    const user = userEvent.setup();
    renderField();

    const input = screen.getByPlaceholderText(
      "Coupon code",
    ) as HTMLInputElement;
    await user.type(input, "save10");
    expect(input).toHaveValue("SAVE10");
  });

  it("applies a valid code: toasts success, clears input, shows the applied view", async () => {
    const user = userEvent.setup();
    vi.mocked(validateCoupon).mockResolvedValue({ coupon: PCT_COUPON } as any);
    renderField({ seedPrice: 200 });

    await user.click(screen.getByText("seed")); // subtotal 200
    await user.type(screen.getByPlaceholderText("Coupon code"), "save10");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(toast.success).toHaveBeenCalledWith("Coupon applied");
    expect(toast.error).not.toHaveBeenCalled();
    // Switched to the applied view: code shown, input gone.
    expect(screen.getByText("SAVE10")).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Coupon code"),
    ).not.toBeInTheDocument();
    // 10% of 200 = 20.
    expect(screen.getByText("You save ₹20")).toBeInTheDocument();
  });

  it("rejects an invalid code: toasts the error and stays on the input view", async () => {
    const user = userEvent.setup();
    vi.mocked(validateCoupon).mockResolvedValue({ error: "Expired." } as any);
    renderField();

    await user.type(screen.getByPlaceholderText("Coupon code"), "nope");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(toast.error).toHaveBeenCalledWith("Expired.");
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("Coupon code")).toBeInTheDocument();
  });

  it("pressing Enter in the input applies the coupon", async () => {
    const user = userEvent.setup();
    vi.mocked(validateCoupon).mockResolvedValue({ coupon: PCT_COUPON } as any);
    renderField({ seedPrice: 200 });

    await user.click(screen.getByText("seed"));
    const input = screen.getByPlaceholderText("Coupon code");
    await user.type(input, "save10{Enter}");

    expect(validateCoupon).toHaveBeenCalledWith("SAVE10", 200);
    expect(toast.success).toHaveBeenCalledWith("Coupon applied");
    expect(screen.getByText("SAVE10")).toBeInTheDocument();
  });

  it("the ✕ remove button returns to the input view", async () => {
    const user = userEvent.setup();
    vi.mocked(validateCoupon).mockResolvedValue({ coupon: PCT_COUPON } as any);
    renderField({ seedPrice: 200 });

    await user.click(screen.getByText("seed"));
    await user.type(screen.getByPlaceholderText("Coupon code"), "save10");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByText("You save ₹20")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove coupon" }));
    expect(screen.getByPlaceholderText("Coupon code")).toBeInTheDocument();
    expect(screen.queryByText("SAVE10")).not.toBeInTheDocument();
  });

  it("shows the min-order note when an applied coupon's minimum isn't met", async () => {
    const user = userEvent.setup();
    vi.mocked(validateCoupon).mockResolvedValue({
      coupon: { ...PCT_COUPON, minOrderAmount: 500 },
    } as any);
    // No cart items -> subtotal 0 -> below the 500 minimum -> couponValid false.
    renderField();

    await user.type(screen.getByPlaceholderText("Coupon code"), "save10");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(
      screen.getByText("Add ₹500 min order to use this"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/You save/)).not.toBeInTheDocument();
  });

  it("fetches and renders available coupons on mount", async () => {
    vi.mocked(getAvailableStorefrontCoupons).mockResolvedValue([
      {
        code: "WELCOME",
        description: "Welcome bonus",
        id: "c1",
        discount_type: "percentage",
        discount_value: 10,
        min_order_amount: 0,
      },
    ] as any);
    renderField();

    // The effect fetches and sets state, so wait for the DOM to update.
    const heading = await screen.findByText("Available Coupons");
    expect(heading).toBeInTheDocument();

    expect(screen.getByText("WELCOME")).toBeInTheDocument();
    expect(screen.getByText("Welcome bonus")).toBeInTheDocument();
  });

  it("applies an available coupon when clicking its Apply button", async () => {
    const user = userEvent.setup();
    vi.mocked(getAvailableStorefrontCoupons).mockResolvedValue([
      {
        code: "WELCOME",
        description: "Welcome bonus",
        id: "c1",
        discount_type: "percentage",
        discount_value: 10,
        min_order_amount: 0,
      },
    ] as any);
    vi.mocked(validateCoupon).mockResolvedValue({
      coupon: { ...PCT_COUPON, code: "WELCOME" },
    } as any);

    renderField({ seedPrice: 200 });

    await user.click(screen.getByText("seed")); // subtotal 200

    // Find the Apply button in the list item
    const applyBtns = await screen.findAllByRole("button", { name: "Apply" });
    const listApplyBtn = applyBtns[1]; // second apply button

    await user.click(listApplyBtn);

    expect(validateCoupon).toHaveBeenCalledWith("WELCOME", 200);
    expect(toast.success).toHaveBeenCalledWith("Coupon applied");
    expect(screen.getByText("WELCOME")).toBeInTheDocument();
  });
});
