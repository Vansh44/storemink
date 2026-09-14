// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */

// The offer editor was ONE scroll of ten fieldsets — reward, trigger,
// delivery, channels, limits, dates, item scope, locations, groups, extra
// conditions — with no way to see its shape or skip a part. It is four named,
// collapsible sections now, so these pin the two properties that regrouping
// can break: nothing became unreachable, and a section the merchant has
// actually configured is not folded away from them.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";

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
  createOffer: vi.fn(),
  updateOffer: vi.fn(),
}));

import { OfferForm } from "./offer-form";

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
  showOnStorefront: false,
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

function view(props: Record<string, unknown> = {}) {
  return render(
    <OfferForm
      offer={null}
      locations={[]}
      groups={[]}
      products={[{ id: "almond", name: "almond shake" }]}
      categories={[{ id: "bev", name: "Beverages" }]}
      initialLocationIds={[]}
      initialGroupIds={[]}
      initialProductIds={[]}
      initialVariantIds={[]}
      initialCategoryIds={[]}
      allowsGroups
      autoApplyOn
      {...(props as any)}
    />,
  );
}

beforeEach(() => vi.clearAllMocks());

/**
 * Render, then get past the type picker a NEW offer now opens on.
 *
 * ★ THE PICKER IS THE FIRST SCREEN, Shopify's shape: the type decides which
 * cards the form even has, so asking for it inside the form would change the
 * form's own shape under the merchant while they read it.
 */
async function newOffer(title: string, props: Record<string, unknown> = {}) {
  const user = userEvent.setup();
  const rendered = view(props);
  await user.click(
    screen.getByRole("button", { name: new RegExp(title, "i") }),
  );
  return { ...rendered, user };
}

beforeEach(() => vi.clearAllMocks());

describe("OfferForm — the type picker", () => {
  it("asks what kind of discount this is before showing a form", () => {
    view();
    expect(
      screen.getByText(/What kind of discount is this/i),
    ).toBeInTheDocument();
    // No form yet: nothing to summarise, and a default nobody picked would be
    // described as though they had.
    expect(screen.queryByText("Summary")).toBeNull();
    expect(screen.queryByText("Method")).toBeNull();
  });

  it("groups the types by what the discount acts on", () => {
    view();
    for (const group of [
      "Off the whole order",
      "Off chosen products",
      "Something extra, not a discount",
    ]) {
      expect(screen.getByText(group)).toBeInTheDocument();
    }
  });

  it("opens the form on the type that was chosen", async () => {
    await newOffer("Buy X, get Y");
    expect(screen.getByText("Method")).toBeInTheDocument();
    expect(screen.getByText("Max sets per order")).toBeInTheDocument();
  });

  // ★ EDITING SKIPS IT. An existing offer's type is set and its fields are
  // full; a screen with one obvious answer is a click for nothing, and
  // changing an existing offer's type is not what anyone opens the editor for.
  it("is skipped when editing", () => {
    view({ offer: OFFER });
    expect(screen.queryByText(/What kind of discount is this/i)).toBeNull();
    expect(screen.getByText("Method")).toBeInTheDocument();
  });
});

describe("OfferForm — the card layout", () => {
  // ★★ CARDS, ALL OPEN, replacing four collapsible sections. Folding made the
  // form shorter without making it legible: what the offer WAS lived across
  // four headers a merchant opened one at a time. Flat is affordable because
  // the Summary is pinned beside it.
  it("shows every question at once, named, without a click", async () => {
    await newOffer("A coupon");
    for (const card of [
      "Method",
      "Value",
      "Minimum requirements",
      "Maximum uses",
      "Combinations",
      "Active dates",
      "Summary",
    ]) {
      expect(screen.getByText(card)).toBeInTheDocument();
    }
    // Previously behind a click.
    expect(screen.getByText("Total budget (₹)")).toBeInTheDocument();
  });

  // ★★ SAVE AND BACK IN ONE PINNED BAR. Save used to sit at the bottom of the
  // left column, and with two columns the form has no single end — so on a long
  // offer the button was somewhere a merchant had to go looking for. "Always
  // visible" is exactly the property a later refactor breaks silently, so it is
  // asserted structurally rather than by looking for the words.
  it("keeps Back, Cancel and Save together in the sticky header", () => {
    const { container } = view({ offer: OFFER });
    const header = container.querySelector("header.dash-offer-header")!;
    expect(header).not.toBeNull();
    expect(header.textContent).toContain("Offers");
    expect(header.textContent).toContain("Cancel");
    expect(header.textContent).toContain("Save offer");
    // Not left behind at the foot of the form as well.
    expect(container.querySelectorAll("button")).toBeTruthy();
    const saves = Array.from(container.querySelectorAll("button")).filter((b) =>
      /Save offer/i.test(b.textContent ?? ""),
    );
    expect(saves).toHaveLength(1);
  });

  // ★ NOTHING TO SAVE YET. A live Create button on the picker would create the
  // default nobody chose.
  it("offers no save action while a type is still being chosen", () => {
    const { container } = view();
    const header = container.querySelector("header.dash-offer-header")!;
    expect(header.textContent).toContain("Offers");
    expect(header.textContent).not.toContain("Create offer");
  });

  it("keeps the whole offer readable in the summary while a field is edited", () => {
    view({ offer: { ...OFFER, name: "launch" } });
    const summary = screen.getByText("Summary").closest("section")!;
    expect(summary.textContent).toContain("launch");
    expect(summary.textContent).toMatch(/Buy 1, get 1 free/);
    // Status lives with the summary, as the go-live decision rather than a
    // field lost at the bottom of a column.
    expect(summary.textContent).toMatch(/Status/i);
  });

  it("names an untitled offer rather than showing an empty summary", async () => {
    await newOffer("A coupon");
    const summary = screen.getByText("Summary").closest("section")!;
    expect(summary.textContent).toContain("Untitled offer");
  });

  // ★ THE STRUCTURE, not just the presence of the words. A card accidentally
  // nested inside another, or the summary emitted outside the grid, renders
  // every assertion above green and looks broken — which is exactly the class
  // of mistake a layout rewrite makes.
  it("puts the cards and the summary side by side, not one inside the other", () => {
    const { container } = view({ offer: OFFER });
    const grid = container.querySelector(".grid.items-start")!;
    expect(grid).not.toBeNull();
    expect(grid.children).toHaveLength(2);

    const [column, aside] = Array.from(grid.children);
    expect(aside.tagName).toBe("ASIDE");
    expect(aside.textContent).toContain("Summary");
    // Cards are siblings in the column, never nested.
    const cards = column.querySelectorAll("section.dash-card");
    expect(cards.length).toBeGreaterThanOrEqual(5);
    for (const card of cards) {
      expect(card.querySelector("section.dash-card")).toBeNull();
    }
  });

  it("carries each card's current value in its subtitle", () => {
    view({ offer: OFFER });
    expect(screen.getByText("on any order")).toBeInTheDocument();
    expect(
      screen.getByText("No limits — runs until you pause it"),
    ).toBeInTheDocument();
  });
});

describe("OfferForm — fields", () => {
  /** The Max-sets input, once the reward type actually renders it. */
  const maxSetsField = () =>
    screen
      .getByText("Max sets per order")
      .parentElement!.querySelector("input")!;

  /** The hint sentence, whose text is split across several JSX expressions. */
  const hintText = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("span"))
      .map((el) => el.textContent ?? "")
      .find((t) => t.includes("A set is")) ?? "";

  // ★★ IT DEFAULTED TO ONE SET, in a field whose placeholder reads "No limit".
  // So "Buy 1, get 1 free" on a basket of four gave ONE free item, not two —
  // the offer stopped meaning what its own name says, with nothing on screen
  // to explain it. Blank is the honest default; the budget is the guard rail.
  it("starts a NEW buy-X-get-Y offer with no set limit", async () => {
    await newOffer("Buy X, get Y");
    expect(maxSetsField()).toHaveValue("");
    expect(maxSetsField()).toHaveAttribute("placeholder", "No limit");
  });

  it("tells the merchant what a basket costs, not just the mechanism", () => {
    const { container } = view({ offer: { ...OFFER, maxSets: null } });
    // "A set is 1 + 1 = 2 items" is how it is stored; "a basket of 4 means
    // they pay for 2" is the thing a merchant came to check.
    const hint = hintText(container);
    expect(hint).toMatch(/a basket of 4 means the customer pays for 2/i);
    expect(hint).toMatch(/2 come free/i);
    expect(hint).toMatch(/It repeats for as long as the basket allows/i);
    expect(hint).toMatch(/total budget/i);
  });

  it("says plainly what a set limit costs, when one is set", () => {
    const { container } = view({ offer: { ...OFFER, maxSets: 1 } });
    const hint = hintText(container);
    expect(hint).toMatch(/Your limit of 1 set caps that/i);
    expect(hint).toMatch(/only 1 can ever be free/i);
  });

  it("keeps an existing limit rather than clearing it on edit", () => {
    view({ offer: { ...OFFER, maxSets: 3 } });
    expect(maxSetsField()).toHaveValue("3");
  });

  // ★★ "COUPON" IS ONE ENTRY, not two. A percentage off the order and a rupee
  // amount off the order are the same thing to a merchant, and splitting them
  // made them read as two unrelated features while every other entry described
  // a mechanic.
  describe("the coupon family", () => {
    // ★ BY LABEL, not by position. The Method card comes first now, so the
    // first combobox on the page is Delivery — a positional lookup would pass
    // today and quietly test the wrong control after the next reorder.
    const discountSelect = () =>
      screen.getByText("Discount").parentElement!.querySelector("select")!;

    it("offers one Coupon card in the picker rather than two order rewards", () => {
      view();
      expect(
        screen.getByRole("button", { name: /A coupon/i }),
      ).toBeInTheDocument();
      // ★ TITLES, not accessible names — the coupon card's own blurb says
      // "a percentage or a fixed amount off", so a name match would find the
      // very card this asserts the absence of. The order group holds exactly
      // the coupon and the ladder.
      const orderGroup = screen
        .getByText("Off the whole order")
        .parentElement!.querySelectorAll("button");
      expect(orderGroup).toHaveLength(2);
      expect(screen.queryByText("A fixed amount off")).toBeNull();
    });

    it("keeps the stored reward types — the schema is not regrouped", async () => {
      const { user } = await newOffer("A coupon");
      expect(screen.getByText("Coupon type")).toBeInTheDocument();
      expect(screen.getByText("Percentage")).toBeInTheDocument();
      await user.selectOptions(
        screen.getByText("Coupon type").parentElement!.querySelector("select")!,
        "amount_off",
      );
      expect(screen.getByText("Amount (₹)")).toBeInTheDocument();
    });

    it("resolves an existing amount-off offer back to the Coupon family", () => {
      view({ offer: { ...OFFER, rewardType: "amount_off", amount: 200 } });
      expect(discountSelect()).toHaveValue("coupon");
      expect(screen.getByText("Amount (₹)")).toBeInTheDocument();
    });
  });

  // ★★ THE CHECKBOX EXISTS ONLY WHERE THE CART CAN PRICE THE CODE. A
  // buy-X-get-Y on a code can only be priced by the engine, so publishing it
  // would advertise a code the cart then refuses — §23's rule.
  describe("show on storefront", () => {
    const box = () =>
      screen.queryByRole("checkbox", {
        name: /Show this coupon on my storefront/i,
      });

    it("is offered for a coupon on a code", () => {
      view({
        offer: {
          ...OFFER,
          rewardType: "percent_off",
          percent: 10,
          delivery: "code",
          code: "SAVE10",
        },
      });
      expect(box()).toBeInTheDocument();
      expect(box()).not.toBeChecked();
    });

    it("is absent for an automatic offer — there is no code to publish", () => {
      view({ offer: { ...OFFER, rewardType: "percent_off", percent: 10 } });
      expect(box()).toBeNull();
    });

    it("is absent for a reward the cart cannot preview", () => {
      view({ offer: { ...OFFER, delivery: "code", code: "B1G1" } });
      expect(box()).toBeNull();
    });

    it("reflects what was saved", () => {
      view({
        offer: {
          ...OFFER,
          rewardType: "percent_off",
          percent: 10,
          delivery: "code",
          code: "SAVE10",
          showOnStorefront: true,
        },
      });
      expect(box()).toBeChecked();
    });
  });

  it("warns on the delivery control when automatic offers are switched off", () => {
    view({ offer: OFFER, autoApplyOn: false });
    expect(
      screen.getByText(/automatic offers switched off/i),
    ).toBeInTheDocument();
  });

  it("says nothing when they are switched on", () => {
    view({ offer: OFFER, autoApplyOn: true });
    expect(screen.queryByText(/automatic offers switched off/i)).toBeNull();
  });
});
