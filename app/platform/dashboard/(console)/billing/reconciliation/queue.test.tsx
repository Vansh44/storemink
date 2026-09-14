// @vitest-environment jsdom
// The operator reconciliation queue.
//
// These are money discrepancies, so what the screen SAYS matters: the direction
// and size of a mismatch, whose money it is, and — most of all — that closing an
// item records a judgement rather than moving anything.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReconciliationQueue } from "./queue";
import type { ReconciliationItem } from "@/lib/billing/invoice-types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/actions/platform", () => ({
  closeReconciliationItem: vi.fn(),
}));

function item(over: Partial<ReconciliationItem> = {}): ReconciliationItem {
  return {
    id: "item-1",
    storeId: "store-1",
    storeName: "Acme Retail",
    storeSlug: "acme",
    kind: "amount_mismatch",
    status: "open",
    invoiceId: "inv-1",
    attemptId: "att-1",
    providerPaymentId: "pay_abc123",
    providerOrderId: "order_abc",
    expectedPaise: 500_000,
    observedPaise: 400_000,
    detail: {},
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
    createdAt: "2026-09-10T00:00:00.000Z",
    ...over,
  };
}

describe("the queue", () => {
  it("names the discrepancy, the store, and both amounts", () => {
    render(<ReconciliationQueue items={[item()]} status="open" />);
    expect(screen.getByText("Amount mismatch")).toBeInTheDocument();
    expect(screen.getByText("Acme Retail")).toBeInTheDocument();
    expect(screen.getByText("₹5,000")).toBeInTheDocument();
    expect(screen.getByText("₹4,000")).toBeInTheDocument();
  });

  it("★★ says which DIRECTION the difference goes", () => {
    // "₹1,000" alone does not tell an operator whether the merchant was
    // overcharged or underpaid, which is the first thing they need.
    render(<ReconciliationQueue items={[item()]} status="open" />);
    expect(screen.getByText(/₹1,000 short/)).toBeInTheDocument();
  });

  it("★ reads the other way round too", () => {
    render(
      <ReconciliationQueue
        items={[item({ expectedPaise: 400_000, observedPaise: 500_000 })]}
        status="open"
      />,
    );
    expect(screen.getByText(/₹1,000 over/)).toBeInTheDocument();
  });

  it("★★ says so when an item maps to NO store — that is the problem itself", () => {
    // A blank here reads as a rendering bug; it is actually an orphan payment
    // nobody can attribute, which is exactly why a human is needed.
    render(
      <ReconciliationQueue
        items={[
          item({ storeId: null, storeName: null, kind: "orphan_payment" }),
        ]}
        status="open"
      />,
    );
    expect(screen.getByText(/needs attributing/i)).toBeInTheDocument();
  });

  it("shows the gateway payment id, which is what an operator searches on", () => {
    render(<ReconciliationQueue items={[item()]} status="open" />);
    expect(screen.getByText("pay_abc123")).toBeInTheDocument();
  });

  it("★ an already-closed item shows the outcome, who and why — and no button", () => {
    render(
      <ReconciliationQueue
        items={[
          item({
            status: "resolved",
            resolvedBy: "op@storemink.com",
            resolvedAt: "2026-09-11T00:00:00.000Z",
            resolutionNote: "Refunded the difference",
          }),
        ]}
        status="resolved"
      />,
    );
    expect(screen.getByText(/Refunded the difference/)).toBeInTheDocument();
    expect(screen.getByText(/op@storemink.com/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Close this/ })).toBeNull();
  });

  it("★ an empty OPEN queue explains what would land here", () => {
    render(<ReconciliationQueue items={[]} status="open" />);
    expect(screen.getByText("Nothing to review")).toBeInTheDocument();
    expect(screen.getByText(/hourly sweep/i)).toBeInTheDocument();
  });

  it("★★ tells the operator, AT THE POINT OF ACTION, that this moves no money", () => {
    // The whole design rests on closing an item being a judgement rather than a
    // fix. An operator who believes "Resolved" refunded the difference leaves a
    // merchant overcharged and the queue looking clean. This sentence is the
    // only thing standing between those two readings, so it is pinned.
    render(<ReconciliationQueue items={[item()]} status="open" />);
    fireEvent.click(screen.getByRole("button", { name: "Close this" }));
    expect(screen.getByText(/does/)).toHaveTextContent(
      /does\s*not\s*move money/,
    );
  });

  it("★ will not close an item without a note — the note IS the audit trail", () => {
    render(<ReconciliationQueue items={[item()]} status="open" />);
    fireEvent.click(screen.getByRole("button", { name: "Close this" }));
    const submit = screen.getByRole("button", { name: /Close item/ });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Refunded the ₹1,000 difference" },
    });
    expect(submit).toBeEnabled();
  });

  it("★ whitespace is not a note", () => {
    render(<ReconciliationQueue items={[item()]} status="open" />);
    fireEvent.click(screen.getByRole("button", { name: "Close this" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: /Close item/ })).toBeDisabled();
  });

  it("renders a mismatch-less kind without inventing amounts", () => {
    render(
      <ReconciliationQueue
        items={[
          item({
            kind: "missing_webhook",
            expectedPaise: null,
            observedPaise: null,
          }),
        ]}
        status="open"
      />,
    );
    expect(screen.getByText("Missing webhook")).toBeInTheDocument();
    expect(screen.queryByText(/Asked for/)).toBeNull();
  });
});
