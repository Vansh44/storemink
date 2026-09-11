import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TenderPanel } from "./tender-panel";
import type { PosCustomer, PosTender } from "@/app/actions/pos-sale-actions";

function setup(over: Partial<Parameters<typeof TenderPanel>[0]> = {}) {
  const onComplete = vi.fn<
    (
      tenders: PosTender[],
      approvalToken?: string,
    ) => Promise<{ error?: string; needsApproval?: boolean }>
  >(async () => ({}));
  render(
    <TenderPanel
      total={500}
      onCancel={() => {}}
      onComplete={onComplete}
      storeCredit={0}
      onTakeOnline={async () => ({ reference: "pay_demo" })}
      {...over}
    />,
  );
  return { onComplete };
}

const button = (name: RegExp) => screen.getByRole("button", { name });

describe("checkout customer details", () => {
  it("does not resolve while typing and submits one exact 10-digit mobile", async () => {
    const onCustomer = vi.fn();
    const onResolveCustomer = vi.fn(async () => ({
      created: true,
      customer: {
        id: "pos_1",
        name: "9876543210",
        phone: "9876543210",
        email: null,
        storeCredit: 0,
      },
    }));
    setup({
      customer: null,
      onCustomer,
      onResolveCustomer,
      receiptEmail: "",
      onReceiptEmail: vi.fn(),
    });

    expect(screen.getByRole("heading", { name: "Checkout" })).toBeVisible();
    const mobile = screen.getByLabelText(/customer mobile number/i);
    fireEvent.change(mobile, { target: { value: "9876543210123" } });
    expect(mobile).toHaveValue("9876543210");
    expect(onResolveCustomer).not.toHaveBeenCalled();
    fireEvent.click(button(/^ok$/i));

    await waitFor(() =>
      expect(onResolveCustomer).toHaveBeenCalledWith("9876543210", "+91"),
    );
    expect(onResolveCustomer).toHaveBeenCalledTimes(1);
    expect(onCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ id: "pos_1" }),
    );
    expect(screen.getByText("Choose a payment method")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /continue to payment/i }),
    ).toBeNull();
  });

  it("accepts only ten digits and never shows payment before resolution", () => {
    const onResolveCustomer = vi.fn();
    setup({
      customer: null,
      onCustomer: vi.fn(),
      onResolveCustomer,
      receiptEmail: "",
      onReceiptEmail: vi.fn(),
    });

    const mobile = screen.getByLabelText(/customer mobile number/i);
    fireEvent.change(mobile, { target: { value: "98a76-54" } });
    expect(mobile).toHaveValue("987654");
    expect(button(/^ok$/i)).toBeDisabled();
    expect(onResolveCustomer).not.toHaveBeenCalled();
    expect(screen.queryByText("Choose a payment method")).toBeNull();
  });

  it("shows an already resolved customer's contact on payment", () => {
    const customer: PosCustomer = {
      id: "c1",
      name: "Asha Rao",
      phone: "9876543210",
      email: "asha@example.com",
      storeCredit: 0,
    };
    setup({
      customer,
      onCustomer: vi.fn(),
      onResolveCustomer: vi.fn(),
    });

    expect(screen.getByText("Asha Rao")).toBeVisible();
    // ★ A LEGACY ROW STILL READS WITH ITS COUNTRY CODE. The fixture's phone is
    // the bare national number the register used to write; the screen composes
    // and groups it, so the counter never shows two different shapes for what
    // is the same kind of number.
    expect(
      screen.getByText(/\+91 98765 43210.*asha@example\.com/),
    ).toBeVisible();
    expect(screen.getByText("Choose a payment method")).toBeVisible();
  });

  it("keeps optional receipt and GST fields out of the common path", () => {
    setup({
      customer: {
        id: "c1",
        name: "Asha",
        phone: "9876543210",
        email: null,
        storeCredit: 0,
      },
      onCustomer: vi.fn(),
      onResolveCustomer: vi.fn(),
      receiptEmail: "",
      onReceiptEmail: vi.fn(),
      gstEnabled: true,
      gstin: "",
      onGstin: vi.fn(),
    });

    expect(screen.queryByPlaceholderText("name@example.com")).toBeNull();
    fireEvent.click(button(/add receipt email or gstin/i));
    expect(screen.getByPlaceholderText("name@example.com")).toBeVisible();
    expect(screen.getByPlaceholderText("22AAAAA0000A1Z5")).toBeVisible();
  });
});

describe("payment method selection", () => {
  it("shows a short, plain-language list and keeps split secondary", () => {
    setup();
    expect(button(/^cash/i)).toBeVisible();
    expect(button(/^card terminal/i)).toBeVisible();
    expect(button(/^upi \/ qr/i)).toBeVisible();
    expect(button(/^razorpay/i)).toBeVisible();
    expect(screen.getByText(/after your terminal approves/i)).toBeVisible();
    expect(button(/^split payment/i)).toBeVisible();
    expect(screen.queryByText(/record a payment already taken/i)).toBeNull();
  });

  it("omits Razorpay when no gateway is connected", () => {
    setup({ onTakeOnline: undefined });
    expect(screen.queryByRole("button", { name: /^razorpay/i })).toBeNull();
    expect(screen.queryByText(/connect a payment gateway/i)).toBeNull();
  });
});

describe("one-method payments", () => {
  it("asks for an explicit terminal confirmation without an amount field", async () => {
    const { onComplete } = setup();
    fireEvent.click(button(/^card terminal/i));

    expect(screen.queryByPlaceholderText(/up to/i)).toBeNull();
    expect(screen.getByText(/confirm the terminal approved/i)).toBeVisible();
    fireEvent.click(button(/^complete sale$/i));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0][0]).toEqual([
      { method: "card", amount: 500 },
    ]);
  });

  it("collects cash received and previews change before completing", async () => {
    const { onComplete } = setup();
    fireEvent.click(button(/^cash/i));
    const amount = screen.getByLabelText(/cash received/i);
    expect(amount).toHaveValue("500");
    fireEvent.change(amount, { target: { value: "600" } });
    expect(screen.getByText("Give ₹100 change")).toBeVisible();
    fireEvent.click(button(/^complete sale$/i));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0][0]).toEqual([
      { method: "cash", amount: 600, tendered: 600 },
    ]);
  });

  it("charges and verifies a Razorpay payment before completing", async () => {
    const onTakeOnline = vi.fn(async () => ({ reference: "pay_verified" }));
    const { onComplete } = setup({ onTakeOnline });
    fireEvent.click(button(/^razorpay/i));
    expect(screen.queryByPlaceholderText(/up to/i)).toBeNull();
    fireEvent.click(button(/^charge ₹500$/i));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onTakeOnline).toHaveBeenCalledWith(500);
    expect(onComplete.mock.calls[0][0]).toEqual([
      { method: "razorpay", amount: 500, reference: "pay_verified" },
    ]);
  });

  it("keeps a recorded tender while manager approval is collected", async () => {
    const onComplete = vi
      .fn()
      .mockResolvedValueOnce({
        needsApproval: true,
        error: "Manager approval needed.",
      })
      .mockResolvedValueOnce({});
    const onVerifyManager = vi.fn(async () => ({
      approved: true,
      token: "manager-token",
    }));
    setup({ onComplete, onVerifyManager });

    fireEvent.click(button(/^card terminal/i));
    fireEvent.click(button(/^complete sale$/i));
    const pin = await screen.findByPlaceholderText(/manager's 8-digit pin/i);
    fireEvent.change(pin, { target: { value: "12345678" } });
    fireEvent.click(button(/^approve$/i));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(2));
    expect(onComplete.mock.calls[1]).toEqual([
      [{ method: "card", amount: 500 }],
      "manager-token",
    ]);
  });

  it("keeps a captured gateway tender when completion must be retried", async () => {
    const onComplete = vi
      .fn()
      .mockResolvedValueOnce({ error: "Couldn't complete the sale." })
      .mockResolvedValueOnce({});
    const onTakeOnline = vi.fn(async () => ({ reference: "pay_captured" }));
    setup({ onComplete, onTakeOnline });

    fireEvent.click(button(/^razorpay/i));
    fireEvent.click(button(/^charge ₹500$/i));

    expect(
      await screen.findByText(/couldn't complete the sale/i),
    ).toBeVisible();
    expect(screen.getByText("Razorpay")).toBeVisible();
    fireEvent.click(button(/^complete sale$/i));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(2));
    expect(onComplete.mock.calls[1][0]).toEqual([
      { method: "razorpay", amount: 500, reference: "pay_captured" },
    ]);
    expect(onTakeOnline).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: /remove razorpay payment/i }),
    ).toBeNull();
    expect(screen.getByText("Verified")).toBeVisible();
  });
});

describe("split payments", () => {
  it("uses a method → amount → next method loop", () => {
    setup();
    fireEvent.click(button(/^split payment/i));
    expect(
      screen.getByRole("heading", { name: "Split payment" }),
    ).toBeVisible();
    expect(screen.getByText(/choose how to collect ₹500/i)).toBeVisible();
    expect(screen.queryByPlaceholderText(/up to/i)).toBeNull();

    fireEvent.click(button(/^cash/i));
    const amount = screen.getByLabelText(/cash received/i);
    expect(amount).toHaveValue("");
    expect(button(/^enter amount$/i)).toBeDisabled();
    fireEvent.change(amount, { target: { value: "300" } });
    fireEvent.click(button(/^add ₹300$/i));

    expect(screen.getByText("₹200")).toBeVisible();
    expect(screen.getByText(/choose how to collect ₹200/i)).toBeVisible();
    expect(screen.getAllByText("Cash")).toHaveLength(2);
  });

  it("finishes only after the cashier reviews all payment legs", async () => {
    const { onComplete } = setup();
    fireEvent.click(button(/^split payment/i));
    fireEvent.click(button(/^cash/i));
    fireEvent.change(screen.getByLabelText(/cash received/i), {
      target: { value: "300" },
    });
    fireEvent.click(button(/^add ₹300$/i));

    fireEvent.click(button(/^upi \/ qr/i));
    fireEvent.change(screen.getByLabelText(/^amount$/i), {
      target: { value: "200" },
    });
    fireEvent.click(button(/^add ₹200$/i));

    expect(screen.getByText("Payment complete")).toBeVisible();
    expect(screen.getAllByText("UPI / QR").length).toBeGreaterThan(0);
    expect(onComplete).not.toHaveBeenCalled();
    fireEvent.click(button(/^complete sale$/i));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0][0]).toEqual([
      { method: "cash", amount: 300, tendered: 300 },
      { method: "upi", amount: 200 },
    ]);
  });

  it("turns a short store-credit balance into a clear split", () => {
    setup({ storeCredit: 120 });
    fireEvent.click(button(/^store credit/i));
    expect(screen.getByText(/₹380 will still be due/i)).toBeVisible();
    fireEvent.click(button(/^add ₹120$/i));
    expect(
      screen.getByRole("heading", { name: "Split payment" }),
    ).toBeVisible();
    expect(screen.getByText(/choose how to collect ₹380/i)).toBeVisible();
  });
});

describe("a number the till has not met before", () => {
  const known: PosCustomer = {
    id: "firebase-uid",
    name: "Rohan Sharma",
    phone: "+919877542162",
    email: "rohan@example.com",
    storeCredit: 0,
  };

  it("shows the existing customer by name instead of creating one", async () => {
    // ★★ THE REPORTED DEFECT, from the till's side: a shopper with an account
    // was showing up as an anonymous new "Customer".
    const onCustomer = vi.fn();
    const onCreateCustomer = vi.fn();
    setup({
      customer: null,
      onCustomer,
      onResolveCustomer: vi.fn(async () => ({ customer: known })),
      onCreateCustomer,
    });
    fireEvent.change(screen.getByLabelText(/customer mobile number/i), {
      target: { value: "9877542162" },
    });
    fireEvent.click(button(/^ok$/i));

    await waitFor(() => expect(onCustomer).toHaveBeenCalledWith(known));
    // Nothing is invented for somebody who already exists.
    expect(onCreateCustomer).not.toHaveBeenCalled();
    // No detail fields either: there is nothing to collect.
    expect(
      screen.queryByLabelText(/customer first name/i),
    ).not.toBeInTheDocument();
  });

  it("renders the resolved customer by name, not as a number", () => {
    // `customer` is controlled by the register, so this asserts the render for
    // the value the resolve above hands back. Before the fix that row was a
    // nameless duplicate and this read "9877542162".
    setup({
      customer: known,
      onCustomer: vi.fn(),
      onResolveCustomer: vi.fn(),
      onCreateCustomer: vi.fn(),
    });
    expect(screen.getByText("Rohan Sharma")).toBeVisible();
    expect(screen.getByText(/rohan@example\.com/)).toBeVisible();
  });

  it("offers name and email fields, and stores what was collected", async () => {
    const onCustomer = vi.fn();
    const onCreateCustomer = vi.fn(async () => ({
      created: true,
      customer: {
        id: "pos_new",
        name: "Rohan Sharma",
        phone: "9877542162",
        email: "rohan@example.com",
        storeCredit: 0,
      },
    }));
    setup({
      customer: null,
      onCustomer,
      onResolveCustomer: vi.fn(async () => ({ notFound: true })),
      onCreateCustomer,
    });
    fireEvent.change(screen.getByLabelText(/customer mobile number/i), {
      target: { value: "9877542162" },
    });
    fireEvent.click(button(/^ok$/i));

    // The fields appear rather than a nameless row being recorded silently.
    const first = await screen.findByLabelText(/customer first name/i);
    fireEvent.change(first, { target: { value: "Rohan" } });
    fireEvent.change(screen.getByLabelText(/customer last name/i), {
      target: { value: "Sharma" },
    });
    fireEvent.change(screen.getByLabelText(/customer email/i), {
      target: { value: "rohan@example.com" },
    });
    fireEvent.click(button(/save and continue/i));

    await waitFor(() =>
      expect(onCreateCustomer).toHaveBeenCalledWith({
        mobile: "9877542162",
        dial: "+91",
        firstName: "Rohan",
        lastName: "Sharma",
        email: "rohan@example.com",
      }),
    );
    expect(onCustomer).toHaveBeenCalled();
  });

  // ★★ THE DEAD END. "Change number" used to be gated on an ATTACHED customer,
  // so the details step — the one screen a mistyped digit lands on — had no
  // exit at all: no header control, no panel back arrow (that renders only on
  // the amount screen), and a required first name with no skip. The only ways
  // out were saving a record under the wrong number or cancelling the whole
  // checkout.
  describe("★★ correcting a mistyped number", () => {
    const reachDetails = async (over = {}) => {
      const onCustomer = vi.fn();
      const onCreateCustomer = vi.fn();
      setup({
        customer: null,
        onCustomer,
        onResolveCustomer: vi.fn(async () => ({ notFound: true })),
        onCreateCustomer,
        ...over,
      });
      fireEvent.change(screen.getByLabelText(/customer mobile number/i), {
        target: { value: "9876543210" },
      });
      fireEvent.click(button(/^ok$/i));
      await screen.findByLabelText(/customer first name/i);
      return { onCustomer, onCreateCustomer };
    };

    it("★ hands the number back for editing instead of blanking it", async () => {
      await reachDetails();
      fireEvent.click(button(/change number/i));

      const mobile = await screen.findByLabelText(/customer mobile number/i);
      // ★ RESTORED, not cleared. Retyping ten digits to fix one of them is the
      // friction this exists to remove — and it differs on purpose from the
      // attached-customer case below, which means "a different person".
      expect(mobile).toHaveValue("9876543210");
      expect(
        screen.queryByLabelText(/customer first name/i),
      ).not.toBeInTheDocument();
    });

    it("★ never carries the typed name onto the next number", async () => {
      const { onCreateCustomer } = await reachDetails();
      fireEvent.change(screen.getByLabelText(/customer first name/i), {
        target: { value: "Rohan" },
      });
      fireEvent.change(screen.getByLabelText(/customer last name/i), {
        target: { value: "Sharma" },
      });
      fireEvent.change(screen.getByLabelText(/customer email/i), {
        target: { value: "rohan@example.com" },
      });
      fireEvent.click(button(/change number/i));

      const mobile = await screen.findByLabelText(/customer mobile number/i);
      fireEvent.change(mobile, { target: { value: "9877542162" } });
      fireEvent.click(button(/^ok$/i));

      // ⚠ A cashier correcting a digit would not think to re-check a name they
      // never retyped, so it must not still be there.
      expect(await screen.findByLabelText(/customer first name/i)).toHaveValue(
        "",
      );
      expect(screen.getByLabelText(/customer last name/i)).toHaveValue("");
      expect(screen.getByLabelText(/customer email/i)).toHaveValue("");
      expect(onCreateCustomer).not.toHaveBeenCalled();
    });

    // ★ THE OTHER DIRECTION. An ATTACHED customer opens on Payment, whose own
    // "Change" drops them and returns to an EMPTY box — that means "a different
    // person", not "I mistyped", so the two must not be made to agree.
    const attached: PosCustomer = {
      id: "pos_1",
      name: "Rohan Sharma",
      phone: "+919876543210",
      email: null,
      storeCredit: 0,
    };

    it("★ an attached customer still blanks the box — a different person", async () => {
      // ⚠ A STATEFUL HARNESS, because the panel does not own `customer`: it
      // calls `onCustomer(null)` and waits for the prop to come back. A bare
      // vi.fn() leaves the customer attached and the form never renders, so
      // this would assert nothing about the real wiring.
      function Harness() {
        const [customer, setCustomer] = useState<PosCustomer | null>(attached);
        return (
          <TenderPanel
            total={500}
            onCancel={() => {}}
            onComplete={async () => ({})}
            storeCredit={0}
            customer={customer}
            onCustomer={setCustomer}
            onResolveCustomer={async () => ({ notFound: true })}
            onCreateCustomer={async () => ({})}
          />
        );
      }
      render(<Harness />);

      fireEvent.click(button(/change number/i));
      expect(
        await screen.findByLabelText(/customer mobile number/i),
      ).toHaveValue("");
    });

    it("★ is locked out during an exchange, like the rest of the identity", async () => {
      setup({
        customer: attached,
        customerLocked: true,
        onCustomer: vi.fn(),
        onResolveCustomer: vi.fn(async () => ({ notFound: true })),
      });
      expect(
        screen.queryByRole("button", { name: /change number/i }),
      ).not.toBeInTheDocument();
    });
  });

  it("offers no way past the name, and disables Save until one is typed", async () => {
    // ★★ THE OWNER'S DECISION (2026-09-11): no Skip. This deliberately
    // overrides roadmap invariant 6 for the register — the consequence is that
    // a new number cannot be charged until it has a name, which is intended.
    const onCreateCustomer = vi.fn();
    setup({
      customer: null,
      onCustomer: vi.fn(),
      onResolveCustomer: vi.fn(async () => ({ notFound: true })),
      onCreateCustomer,
    });
    fireEvent.change(screen.getByLabelText(/customer mobile number/i), {
      target: { value: "9877542162" },
    });
    fireEvent.click(button(/^ok$/i));

    const save = await screen.findByRole("button", {
      name: /save and continue/i,
    });
    expect(screen.queryByRole("button", { name: /^skip$/i })).toBeNull();
    expect(save).toBeDisabled();
    // Whitespace is not a name.
    fireEvent.change(screen.getByLabelText(/customer first name/i), {
      target: { value: "   " },
    });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/customer first name/i), {
      target: { value: "Rohan" },
    });
    expect(save).toBeEnabled();
    expect(onCreateCustomer).not.toHaveBeenCalled();
  });

  it("reports a save failure without attaching anybody", async () => {
    const onCustomer = vi.fn();
    setup({
      customer: null,
      onCustomer,
      onResolveCustomer: vi.fn(async () => ({ notFound: true })),
      onCreateCustomer: vi.fn(async () => ({
        error: "That email doesn't look right.",
      })),
    });
    fireEvent.change(screen.getByLabelText(/customer mobile number/i), {
      target: { value: "9877542162" },
    });
    fireEvent.click(button(/^ok$/i));
    fireEvent.change(await screen.findByLabelText(/customer first name/i), {
      target: { value: "Rohan" },
    });
    fireEvent.change(screen.getByLabelText(/customer email/i), {
      target: { value: "rohan@" },
    });
    fireEvent.click(button(/save and continue/i));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/email/i),
    );
    expect(onCustomer).not.toHaveBeenCalled();
  });
});

describe("country codes at the counter", () => {
  it("defaults to India and stores the number under the chosen code", async () => {
    const onResolveCustomer = vi.fn(async () => ({ notFound: true }));
    const onCreateCustomer = vi.fn(async () => ({
      created: true,
      customer: {
        id: "pos_sg",
        name: "Wei",
        phone: "+6581234567",
        email: null,
        storeCredit: 0,
      },
    }));
    setup({
      customer: null,
      onCustomer: vi.fn(),
      onResolveCustomer,
      onCreateCustomer,
    });

    const code = screen.getByLabelText(/country code/i);
    expect(code).toHaveValue("+91");
    fireEvent.change(code, { target: { value: "+65" } });

    const mobile = screen.getByLabelText(/customer mobile number/i);
    // ★ Singapore's local numbers are 8 digits, so the field stops there
    // rather than at India's 10 — the length rule travels with the country.
    fireEvent.change(mobile, { target: { value: "812345678901" } });
    expect(mobile).toHaveValue("81234567");
    fireEvent.click(button(/^ok$/i));

    await waitFor(() =>
      expect(onResolveCustomer).toHaveBeenCalledWith("81234567", "+65"),
    );
    fireEvent.change(await screen.findByLabelText(/customer first name/i), {
      target: { value: "Wei" },
    });
    fireEvent.click(button(/save and continue/i));
    await waitFor(() =>
      expect(onCreateCustomer).toHaveBeenCalledWith(
        expect.objectContaining({ mobile: "81234567", dial: "+65" }),
      ),
    );
  });

  it("clears a number typed for the previous country", () => {
    setup({
      customer: null,
      onCustomer: vi.fn(),
      onResolveCustomer: vi.fn(),
      onCreateCustomer: vi.fn(),
    });
    const mobile = screen.getByLabelText(/customer mobile number/i);
    fireEvent.change(mobile, { target: { value: "9876543210" } });
    // ⚠ Lengths differ per country, so keeping the digits would leave an
    // 8-digit country holding a 10-digit number and an OK button that
    // refuses without saying why.
    fireEvent.change(screen.getByLabelText(/country code/i), {
      target: { value: "+65" },
    });
    expect(mobile).toHaveValue("");
    expect(button(/^ok$/i)).toBeDisabled();
  });

  it("celebrates a customer the shop did not have this morning", async () => {
    setup({
      customer: null,
      onCustomer: vi.fn(),
      onResolveCustomer: vi.fn(async () => ({ notFound: true })),
      onCreateCustomer: vi.fn(),
    });
    fireEvent.change(screen.getByLabelText(/customer mobile number/i), {
      target: { value: "9812279923" },
    });
    fireEvent.click(button(/^ok$/i));

    // A new number is a customer gained, not a lookup that failed.
    expect(await screen.findByText(/^new customer$/i)).toBeVisible();
    expect(screen.getByText(/first visit from/i)).toBeVisible();
    // ⚠ NOT TRUNCATED. On a till screen this read "add their name so you can
    // gree…" — the sentence explaining why the fields are there was the part
    // being cut off, and the number itself has to be readable aloud.
    expect(screen.getByText("+91 98122 79923")).toBeVisible();
  });
});
