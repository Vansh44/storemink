// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

const { push, refresh } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...p }: any) => <a {...p}>{children}</a>,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/actions/coupon-actions", () => ({
  createCoupon: vi.fn(),
  updateCoupon: vi.fn(),
}));

import { CouponForm } from "./coupon-form";
import { toast } from "sonner";
import { createCoupon, updateCoupon } from "@/app/actions/coupon-actions";

const EXISTING: any = {
  id: "cpn-1",
  code: "WELCOME",
  description: "Welcome offer",
  discount_type: "fixed",
  discount_value: 50,
  min_order_amount: 100,
  max_uses: 5,
  valid_from: null,
  valid_until: null,
  status: "active",
  restricted_group_ids: [],
};

describe("CouponForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the New coupon heading in create mode", () => {
    render(<CouponForm coupon={null} groups={[]} />);
    expect(
      screen.getByRole("heading", { name: "New coupon" }),
    ).toBeInTheDocument();
  });

  it("blocks an empty code with a toast and does not call the action", async () => {
    const user = userEvent.setup();
    render(<CouponForm coupon={null} groups={[]} />);

    await user.click(screen.getByRole("button", { name: "Create coupon" }));

    expect(toast.error).toHaveBeenCalledWith("Coupon code is required");
    expect(createCoupon).not.toHaveBeenCalled();
  });

  it("uppercases the code as the user types", async () => {
    const user = userEvent.setup();
    render(<CouponForm coupon={null} groups={[]} />);

    const code = screen.getByPlaceholderText("e.g. SUMMER25");
    await user.type(code, "summer25");
    expect(code).toHaveValue("SUMMER25");
  });

  it("creates a coupon with form defaults and navigates on success", async () => {
    const user = userEvent.setup();
    vi.mocked(createCoupon).mockResolvedValue({} as any);
    render(<CouponForm coupon={null} groups={[]} />);

    await user.type(screen.getByPlaceholderText("e.g. SUMMER25"), "summer25");
    await user.click(screen.getByRole("button", { name: "Create coupon" }));

    await waitFor(() =>
      expect(createCoupon).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "SUMMER25",
          discount_type: "percentage",
          discount_value: 10,
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Coupon created");
    expect(push).toHaveBeenCalledWith("/dashboard/marketing/coupons");
    expect(refresh).toHaveBeenCalled();
  });

  it("surfaces the action error from createCoupon", async () => {
    const user = userEvent.setup();
    vi.mocked(createCoupon).mockResolvedValue({ error: "bad" } as any);
    render(<CouponForm coupon={null} groups={[]} />);

    await user.type(screen.getByPlaceholderText("e.g. SUMMER25"), "bad");
    await user.click(screen.getByRole("button", { name: "Create coupon" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("bad"));
    expect(push).not.toHaveBeenCalled();
  });

  it("switches the amount label when discount type changes to fixed", async () => {
    const user = userEvent.setup();
    render(<CouponForm coupon={null} groups={[]} />);

    expect(screen.getByText("Percent off *")).toBeInTheDocument();

    await user.selectOptions(
      screen.getByDisplayValue("Percentage (%)"),
      "fixed",
    );

    expect(screen.getByText("Amount off (₹) *")).toBeInTheDocument();
  });

  it("renders Edit coupon prefilled and updates on save", async () => {
    const user = userEvent.setup();
    vi.mocked(updateCoupon).mockResolvedValue({} as any);
    render(<CouponForm coupon={EXISTING} groups={[]} />);

    expect(
      screen.getByRole("heading", { name: "Edit coupon" }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. SUMMER25")).toHaveValue("WELCOME");

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(updateCoupon).toHaveBeenCalledWith(
        "cpn-1",
        expect.objectContaining({
          code: "WELCOME",
          discount_type: "fixed",
          discount_value: 50,
        }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Coupon updated");
  });

  it("restricts to a selected group and updates the helper text", async () => {
    const user = userEvent.setup();
    vi.mocked(createCoupon).mockResolvedValue({} as any);
    render(
      <CouponForm
        coupon={null}
        groups={[{ id: "g1", name: "VIP", color: "blue" }]}
      />,
    );

    expect(
      screen.getByText("Empty = everyone can use this coupon."),
    ).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("e.g. SUMMER25"), "vip10");
    await user.click(screen.getByRole("button", { name: "VIP" }));

    expect(
      screen.getByText(
        "Only signed-in customers in the selected group(s) can apply this code.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create coupon" }));

    await waitFor(() =>
      expect(createCoupon).toHaveBeenCalledWith(
        expect.objectContaining({ restricted_group_ids: ["g1"] }),
      ),
    );
  });
});
