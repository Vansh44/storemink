// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pickupActions = vi.hoisted(() => ({
  findPickupByCode: vi.fn(),
  getCollectionCredit: vi.fn(),
  getPickupQueue: vi.fn(),
  markCollected: vi.fn(),
  markReadyForPickup: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const customerVerification = vi.hoisted(() =>
  vi.fn<
    (props: {
      onVerified: () => void;
      onOverride: () => void;
      onCancel: () => void;
    }) => ReactNode
  >(() => null),
);
const tenderPanel = vi.hoisted(() => vi.fn(() => null));

vi.mock("@/app/actions/pos-pickup-actions", () => pickupActions);
vi.mock("@/app/actions/pos-return-actions", () => ({
  findOrderForReturn: vi.fn().mockResolvedValue({ results: [] }),
}));
vi.mock("@/lib/pos/use-poll", () => ({ usePoll: vi.fn() }));
vi.mock("@/lib/pos/live", () => ({ fetchPickupQueue: vi.fn() }));
vi.mock("@/lib/pos/pickup-badge", () => ({
  claimPickupBadge: vi.fn(() => vi.fn()),
  publishPickupCount: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("./collection-detail", () => ({ CollectionDetail: vi.fn(() => null) }));
vi.mock("./sell/tender-panel", () => ({ TenderPanel: tenderPanel }));
vi.mock("./customer-phone-verification", () => ({
  CustomerPhoneVerification: customerVerification,
}));

const { CounterClient } = await import("./counter-client");

const ORDER = {
  id: "pickup-1",
  orderRef: "ORD100110576",
  customerName: "V G",
  itemCount: 1,
  total: 45,
  amountDue: 45,
  paidSoFar: 0,
  placedAt: "2026-08-23T06:00:00.000Z",
  expiresAt: "2099-08-27T06:00:00.000Z",
  status: "awaiting",
};

beforeEach(() => {
  vi.clearAllMocks();
  pickupActions.markReadyForPickup.mockResolvedValue({ success: true });
  pickupActions.getPickupQueue.mockResolvedValue({ orders: [ORDER] });
  pickupActions.getCollectionCredit.mockResolvedValue(0);
});

describe("pickup queue — marking an order ready", () => {
  it("moves the confirmed row into Ready to collect without a reload", async () => {
    render(
      <CounterClient
        mode="pickups"
        initial={[ORDER]}
        error={null}
        canRefund={false}
        canFulfilPickup
      />,
    );

    const toPrepare = screen.getByRole("heading", { name: /to prepare/i });
    const ready = screen.getByRole("heading", { name: /ready to collect/i });
    expect(within(toPrepare).getByText("1")).toBeVisible();
    expect(within(ready).getByText("0")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /mark ready/i }));

    await waitFor(() => {
      expect(pickupActions.markReadyForPickup).toHaveBeenCalledWith("pickup-1");
      expect(within(toPrepare).getByText("0")).toBeVisible();
      expect(within(ready).getByText("1")).toBeVisible();
    });

    const readySection = ready.closest("section");
    const toPrepareSection = toPrepare.closest("section");
    expect(readySection).not.toBeNull();
    expect(toPrepareSection).not.toBeNull();
    expect(within(readySection!).getByText("ORD100110576")).toBeVisible();
    expect(within(toPrepareSection!).queryByText("ORD100110576")).toBeNull();
    expect(screen.queryByRole("button", { name: /mark ready/i })).toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Marked ready.");
    // The confirmed action already supplies the only changed field. No manual
    // action refresh is needed; the ordinary poll can reconcile later changes.
    expect(pickupActions.getPickupQueue).not.toHaveBeenCalled();
  });
});

describe("customer verification", () => {
  it("opens customer OTP before a ready prepaid parcel can be handed over", () => {
    render(
      <CounterClient
        mode="pickups"
        initial={[{ ...ORDER, status: "ready", amountDue: 0 }]}
        error={null}
        canRefund={true}
        canFulfilPickup={true}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /hand over/i }));
    expect(customerVerification).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: ORDER.id, purpose: "pickup" }),
      undefined,
    );
    expect(pickupActions.markCollected).not.toHaveBeenCalled();
  });

  it("offers Razorpay after OTP when a connected pickup still has money due", async () => {
    customerVerification.mockImplementationOnce(
      (props: { onVerified: () => void }) => (
        <button type="button" onClick={props.onVerified}>
          Verify now
        </button>
      ),
    );
    render(
      <CounterClient
        mode="pickups"
        initial={[{ ...ORDER, status: "ready" }]}
        error={null}
        canRefund
        canFulfilPickup
        gateway={{
          keyId: "rzp_test_1",
          storeName: "Echoes",
          locationName: "Shop",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /take payment/i }));
    fireEvent.click(screen.getByRole("button", { name: /verify now/i }));

    await waitFor(() =>
      expect(tenderPanel).toHaveBeenCalledWith(
        expect.objectContaining({ onTakeOnline: expect.any(Function) }),
        undefined,
      ),
    );
  });

  // ★★ `takePayment` IS the tender pad's `onComplete`. Returning `{}` while a
  // verification dialog opened behind the scenes reads to the panel as SUCCESS
  // — it cleared its spinner, showed no error, and left an enabled "Complete
  // sale" under the dialog; the retry then ran outside the panel, so its own
  // failure had nowhere to be displayed. It is awaited now.
  describe("★ the tender pad is never told a deferred hand-over succeeded", () => {
    /**
     * Queue one dialog rendering. `mockImplementationOnce` per opening, never a
     * persistent `mockImplementation`: `vi.clearAllMocks()` clears CALLS, not
     * IMPLEMENTATIONS, so a persistent one leaks into every later test in the
     * file (the documented `test:shuffle` hazard).
     */
    const queueDialog = () =>
      customerVerification.mockImplementationOnce(
        (props: { onVerified: () => void; onCancel: () => void }) => (
          <div>
            <button type="button" onClick={props.onVerified}>
              Verify now
            </button>
            <button type="button" onClick={props.onCancel}>
              Cancel check
            </button>
          </div>
        ),
      );

    /** Drive the panel the way it drives itself: call its `onComplete`. */
    const complete = () => {
      const calls = tenderPanel.mock.calls as unknown as Array<
        [{ onComplete: (t: unknown[]) => Promise<{ error?: string }> }]
      >;
      return calls[calls.length - 1][0].onComplete([
        { method: "cash", amount: 45 },
      ]);
    };

    /** Verify past the hand-over gate so the tender pad is on screen. */
    const openPad = async () => {
      queueDialog();
      render(
        <CounterClient
          mode="pickups"
          initial={[{ ...ORDER, status: "ready" }]}
          error={null}
          canRefund
          canFulfilPickup
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /take payment/i }));
      fireEvent.click(screen.getByRole("button", { name: /verify now/i }));
      await waitFor(() => expect(tenderPanel).toHaveBeenCalled());
      pickupActions.markCollected.mockReset();
    };

    it("★ stays pending across the dialog, then resolves with the retry's result", async () => {
      await openPad();
      queueDialog();
      pickupActions.markCollected
        .mockResolvedValueOnce({
          error: "Verify the customer's mobile number before handover.",
          verificationRequired: true,
        })
        .mockResolvedValueOnce({ success: true });

      let settled = false;
      const pending = complete().then((r) => {
        settled = true;
        return r;
      });

      // The dialog is up and onComplete has NOT resolved — that is what keeps
      // the panel's spinner on and its Complete button disabled.
      const verify = await screen.findByRole("button", { name: /verify now/i });
      expect(settled).toBe(false);

      fireEvent.click(verify);
      await expect(pending).resolves.toEqual({});
      expect(pickupActions.markCollected).toHaveBeenCalledTimes(2);
    });

    it("★ surfaces the retry's OWN error instead of swallowing it", async () => {
      await openPad();
      queueDialog();
      pickupActions.markCollected
        .mockResolvedValueOnce({
          error: "Verify the customer's mobile number before handover.",
          verificationRequired: true,
        })
        .mockResolvedValueOnce({ error: "Someone else collected this." });

      const pending = complete();
      fireEvent.click(
        await screen.findByRole("button", { name: /verify now/i }),
      );
      await expect(pending).resolves.toEqual({
        error: "Someone else collected this.",
      });
    });

    it("★ reports a cancelled dialog as an error, not as a completed sale", async () => {
      await openPad();
      queueDialog();
      pickupActions.markCollected.mockResolvedValueOnce({
        error: "Verify the customer's mobile number before handover.",
        verificationRequired: true,
      });

      const pending = complete();
      fireEvent.click(
        await screen.findByRole("button", { name: /cancel check/i }),
      );
      const res = await pending;
      expect(res.error).toMatch(/cancelled/i);
      // Nothing was retried, so nothing was taken.
      expect(pickupActions.markCollected).toHaveBeenCalledTimes(1);
    });

    it("★ an unreachable-OTP order takes the acknowledgement to the server", async () => {
      await openPad();
      customerVerification.mockImplementationOnce(
        (props: { onOverride: () => void }) => (
          <button type="button" onClick={props.onOverride}>
            Hand over without a code
          </button>
        ),
      );
      pickupActions.markCollected
        .mockResolvedValueOnce({
          error: "This order has no mobile number that can be texted.",
          verificationUnavailable: true,
          canOverrideVerification: true,
        })
        .mockResolvedValueOnce({ success: true });

      const pending = complete();
      fireEvent.click(
        await screen.findByRole("button", { name: /without a code/i }),
      );
      await expect(pending).resolves.toEqual({});
      expect(pickupActions.markCollected).toHaveBeenLastCalledWith(
        ORDER.id,
        [{ method: "cash", amount: 45 }],
        expect.objectContaining({ acknowledgeUnverifiedCustomer: true }),
      );
    });
  });
});
