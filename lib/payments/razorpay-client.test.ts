// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRazorpayModal } from "./razorpay-client";

describe("openRazorpayModal", () => {
  let checkoutOptions: Record<string, unknown> | undefined;
  const open = vi.fn();

  beforeEach(() => {
    checkoutOptions = undefined;
    open.mockClear();
    window.Razorpay = class {
      constructor(options: Record<string, unknown>) {
        checkoutOptions = options;
      }

      open = open;
    } as unknown as typeof window.Razorpay;
  });

  afterEach(() => {
    delete window.Razorpay;
  });

  it("opens an ordinary order as a one-time payment", async () => {
    await openRazorpayModal({
      keyId: "rzp_test_1",
      rzpOrderId: "order_once",
      amountPaise: 59_00,
      name: "StoreMink",
      onSuccess: vi.fn(),
      onDismiss: vi.fn(),
    });

    expect(checkoutOptions).toMatchObject({ order_id: "order_once" });
    expect(checkoutOptions).not.toHaveProperty("customer_id");
    expect(checkoutOptions).not.toHaveProperty("recurring");
    expect(open).toHaveBeenCalledOnce();
  });

  it("explicitly enables recurring Checkout for a customer-bound order", async () => {
    await openRazorpayModal({
      keyId: "rzp_test_1",
      rzpOrderId: "order_mandate",
      amountPaise: 1_500_00,
      customerId: "cust_1",
      name: "StoreMink",
      onSuccess: vi.fn(),
      onDismiss: vi.fn(),
    });

    expect(checkoutOptions).toMatchObject({
      order_id: "order_mandate",
      customer_id: "cust_1",
      recurring: true,
    });
    expect(open).toHaveBeenCalledOnce();
  });
});
