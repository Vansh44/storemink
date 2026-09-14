// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */

// ★★ THE SWITCH THAT MADE EVERY AUTOMATIC OFFER INERT, from the merchant's side.
//
// `offers.autoApply` gates every `delivery: "automatic"` offer inside
// `disqualify` (`auto_apply_off`), before the pricing engine ever sees it. With
// it off a merchant's buy-1-get-1 charged full price online and at the till —
// and this table reported it as plainly "Active", which is the one word they
// check when the storefront disagrees with the dashboard.
//
// These pin the three states in BOTH directions, because the failure mode of
// the fix is its own lie: a "Not applying" badge on an offer that works is
// worse than the silence it replaced.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...p }: any) => (
    <a href={typeof href === "string" ? href : "#"} {...p}>
      {children}
    </a>
  ),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/app/actions/offer-actions", () => ({
  deleteOffer: vi.fn(),
  setOfferStatus: vi.fn(),
}));

import { OffersView } from "./offers-view";

const OFFER: any = {
  id: "off-1",
  name: "launch",
  description: null,
  status: "active",
  delivery: "automatic",
  code: null,
  priority: 0,
  triggerType: "always",
  minSubtotal: null,
  rewardType: "buy_x_get_y",
  percent: null,
  amount: null,
  unitPrice: null,
  buyQuantity: 1,
  getQuantity: 1,
  getPercent: 100,
  maxSets: 1,
  tierMode: "percent",
  tiers: [],
  breaks: [],
  giftProductId: null,
  giftVariantId: null,
  giftQuantity: null,
  bundleQuantity: null,
  bundlePrice: null,
  creditAmount: null,
  conditions: [],
  channels: [],
  validFrom: null,
  validUntil: null,
  maxRedemptions: null,
  maxPerCustomer: null,
  budget: null,
  redemptionCount: 0,
  spent: 0,
  createdAt: "2026-09-01T00:00:00.000Z",
};

function view(props: Partial<Record<string, unknown>> = {}) {
  return render(
    <OffersView
      autoApplyOn={false}
      emailableOfferIds={[]}
      offers={[OFFER]}
      limit={null}
      activeCount={1}
      locationCount={1}
      canManage
      {...(props as any)}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("OffersView — automatic offers that cannot fire", () => {
  it("does not call an active automatic offer Active when the store switch is off", () => {
    view();
    expect(screen.getByText("Not applying")).toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
  });

  it("explains it once, and links to the switch that fixes it", () => {
    view();
    expect(
      screen.getByText(/One active offer is not applying to anything/i),
    ).toBeInTheDocument();
    // ★ THE WAY OUT IS THE WHOLE POINT OF THE BANNER. The switch is on another
    // page, so a merchant who does not know it exists has to be taken there.
    expect(
      screen.getByRole("link", { name: /Apply offers automatically/i }),
    ).toHaveAttribute("href", "/dashboard/offers/settings");
  });

  it("says nothing at all once the switch is on", () => {
    view({ autoApplyOn: true });
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByText("Not applying")).not.toBeInTheDocument();
    expect(screen.queryByText(/not applying to anything/i)).toBeNull();
  });

  it("leaves CODE offers alone — the switch has never applied to them", () => {
    view({ offers: [{ ...OFFER, delivery: "code", code: "LAUNCH10" }] });
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByText("Not applying")).not.toBeInTheDocument();
    expect(screen.queryByText(/not applying to anything/i)).toBeNull();
  });

  it("leaves a PAUSED offer reading Paused, which needs no explaining", () => {
    view({ offers: [{ ...OFFER, status: "disabled" }], activeCount: 0 });
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.queryByText("Not applying")).not.toBeInTheDocument();
    expect(screen.queryByText(/not applying to anything/i)).toBeNull();
  });

  // ★★ THE LIST USED TO SAY "0% off" FOR THIS OFFER. `rewardLabel` was a
  // three-branch stub that fell through to the percentage for every reward
  // type added after Phase B, so the row described a working buy-1-get-1 as
  // giving nothing. Pinned here as well as in `describe.test.ts` because the
  // regression that matters is the LIST losing the shared describer again.
  it("describes a buy-1-get-1 properly instead of “0% off”", () => {
    view({ autoApplyOn: true });
    expect(screen.getByText("Buy 1, get 1 free")).toBeInTheDocument();
    expect(screen.queryByText(/0% off/)).toBeNull();
  });

  it("counts them, so a merchant knows how much is affected", () => {
    view({
      offers: [OFFER, { ...OFFER, id: "off-2", name: "second" }],
      activeCount: 2,
    });
    expect(
      screen.getByText(/2 active offers are not applying to anything/i),
    ).toBeInTheDocument();
  });
});
