import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { OfferNudge } from "./offer-nudge";
import type { NearMissOffer } from "@/lib/offers/apply";

// ★★ THE LINE READ "Add 1 more and one is free." Two clauses joined by "and"
// make the reward a separate statement of fact rather than the thing the action
// buys, so the sentence parsed as two half-thoughts and a merchant reading it
// said it made no sense. It is a purpose clause now — "Add 1 more to get one
// free" — which is the same information in the shape people say it.

const miss = (over: Partial<NearMissOffer> = {}): NearMissOffer =>
  ({
    offerId: "o1",
    offerName: "launch",
    kind: "units",
    gap: 1,
    rewardType: "buy_x_get_y",
    getQuantity: 1,
    ...over,
  }) as NearMissOffer;

const text = () => screen.getByRole("paragraph").textContent ?? "";

describe("OfferNudge", () => {
  it("reads as one sentence for a buy-one-get-one", () => {
    render(<OfferNudge nearMiss={[miss({ productName: "Almond shake" })]} />);
    expect(text()).toContain("Add 1 more Almond shake to get one free");
    expect(text()).not.toContain("and one is free");
  });

  it("keeps a safe generic fallback when several eligible products form the set", () => {
    render(<OfferNudge nearMiss={[miss()]} />);
    expect(text()).toContain("Add 1 more to get one free");
  });

  it("says what a partial discount is worth", () => {
    render(<OfferNudge nearMiss={[miss({ percent: 50 })]} />);
    expect(text()).toContain("Add 1 more to get one at 50% off");
  });

  it("keeps a quantity ladder's own wording, which is not a set", () => {
    render(
      <OfferNudge
        nearMiss={[miss({ rewardType: "volume_break", gap: 4, percent: 15 })]}
      />,
    );
    // "add 4 more and one is free" would be flatly wrong for a case price.
    expect(text()).toContain("on each");
    expect(text()).not.toContain("free");
  });

  it("keeps the spend wording for a threshold", () => {
    render(
      <OfferNudge
        nearMiss={[
          miss({ kind: "spend", gap: 200, rewardType: "free_shipping" }),
        ]}
      />,
    );
    expect(text()).toContain("Add ₹200 more to get free delivery");
  });

  it("shows nothing when there is no near miss", () => {
    const { container } = render(<OfferNudge nearMiss={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  // ★ The sparkle is decoration; a screen reader announcing it before the
  // sentence adds nothing and interrupts a live region that already fires on
  // every cart edit.
  it("hides the decoration from assistive technology", () => {
    const { container } = render(<OfferNudge nearMiss={[miss()]} />);
    expect(container.querySelector(".sm-offer-nudge-spark")).toHaveAttribute(
      "aria-hidden",
    );
  });
});
