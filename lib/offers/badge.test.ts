import { describe, it, expect } from "vitest";
import { offerBadgeFor, offerTagFor, type BadgeProduct } from "./badge";
import type { Offer } from "./types";

const policy = {
  onSalePrice: "best" as const,
  maxTotalDiscountPercent: 50,
  autoApply: true,
};
const NOW = new Date("2026-09-02T10:00:00.000Z");

function offer(over: Partial<Offer> = {}): Offer {
  return {
    id: "o1",
    name: "Shake sale",
    status: "active",
    delivery: "automatic",
    code: null,
    priority: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    validFrom: null,
    validUntil: null,
    channels: [],
    locationIds: [],
    groupIds: [],
    trigger: { type: "always" },
    reward: { type: "percent_off_items", percent: 20 },
    productIds: [],
    variantIds: [],
    categoryIds: [],
    ...over,
  };
}

const product = (over: Partial<BadgeProduct> = {}): BadgeProduct => ({
  productId: "p1",
  variantId: null,
  categoryId: "c1",
  unitPrice: 1000,
  ...over,
});

describe("offerBadgeFor", () => {
  it("shows a percentage for a percentage reward", () => {
    const b = offerBadgeFor(product(), [offer()], policy, NOW);
    expect(b).toMatchObject({ label: "20% off", saving: 200 });
  });

  it("shows money saved for a fixed price, which varies per product", () => {
    const fixed = offer({ reward: { type: "fixed_price", unitPrice: 499 } });
    expect(
      offerBadgeFor(product({ unitPrice: 800 }), [fixed], policy, NOW),
    ).toMatchObject({ label: "Save ₹301" });
    expect(
      offerBadgeFor(product({ unitPrice: 1200 }), [fixed], policy, NOW),
    ).toMatchObject({ label: "Save ₹701" });
  });

  it("shows nothing when the offer does not cover the product", () => {
    const scoped = offer({ categoryIds: ["other"] });
    expect(offerBadgeFor(product(), [scoped], policy, NOW)).toBeNull();
  });

  it("★ shows nothing for an ORDER-level offer — it is not a fact about this product", () => {
    const orderOffer = offer({ reward: { type: "percent_off", percent: 20 } });
    expect(offerBadgeFor(product(), [orderOffer], policy, NOW)).toBeNull();
  });

  it("★ shows nothing when `skip` declines an on-sale product", () => {
    const onSale = product({ unitPrice: 800, regularUnitPrice: 1000 });
    expect(
      offerBadgeFor(onSale, [offer()], { ...policy, onSalePrice: "skip" }, NOW),
    ).toBeNull();
  });

  it("★ shows nothing when `best` means the offer adds nothing", () => {
    // 10% off ₹1,000 = ₹900, which is worse than the ₹800 special price.
    const onSale = product({ unitPrice: 800, regularUnitPrice: 1000 });
    const weak = offer({ reward: { type: "percent_off_items", percent: 10 } });
    expect(offerBadgeFor(onSale, [weak], policy, NOW)).toBeNull();
  });

  it("shows only the difference when `best` beats the special price", () => {
    // 30% off ₹1,000 = ₹700, beating the ₹800 special by ₹100.
    const onSale = product({ unitPrice: 800, regularUnitPrice: 1000 });
    const deep = offer({ reward: { type: "percent_off_items", percent: 30 } });
    expect(offerBadgeFor(onSale, [deep], policy, NOW)?.saving).toBe(100);
  });

  it("shows nothing for a fixed price above the product's price", () => {
    const fixed = offer({ reward: { type: "fixed_price", unitPrice: 999 } });
    expect(
      offerBadgeFor(product({ unitPrice: 500 }), [fixed], policy, NOW),
    ).toBeNull();
  });

  it("picks the better of two competing offers, like the cart would", () => {
    const b = offerBadgeFor(
      product(),
      [
        offer({
          id: "small",
          reward: { type: "percent_off_items", percent: 10 },
        }),
        offer({
          id: "big",
          reward: { type: "percent_off_items", percent: 40 },
        }),
      ],
      policy,
      NOW,
    );
    expect(b?.offerId).toBe("big");
    expect(b?.saving).toBe(400);
  });

  it("★ is NOT capped by the per-order ceiling — one item is not an order", () => {
    // 80% off with a 50% order ceiling: the item genuinely saves 80%.
    const deep = offer({ reward: { type: "percent_off_items", percent: 80 } });
    expect(offerBadgeFor(product(), [deep], policy, NOW)?.saving).toBe(800);
  });

  it("respects the offer's own window and status", () => {
    const expired = offer({ validUntil: "2026-01-01T00:00:00.000Z" });
    expect(offerBadgeFor(product(), [expired], policy, NOW)).toBeNull();
    const off = offer({ status: "disabled" });
    expect(offerBadgeFor(product(), [off], policy, NOW)).toBeNull();
  });

  it("shows nothing on an empty offer list or a free product", () => {
    expect(offerBadgeFor(product(), [], policy, NOW)).toBeNull();
    expect(
      offerBadgeFor(product({ unitPrice: 0 }), [offer()], policy, NOW),
    ).toBeNull();
  });
});

// ★★ THE CALL SITE, GUARDED — because the failure is invisible.
//
// The shop grid passed `priced.base` (the struck-through MRP) as
// `regularUnitPrice`. The engine reads that field as "what this line is
// discounted FROM", so every product with an MRP set looked on sale, and under
// the default `best` mode the offer was measured against the MRP and scored
// nothing. No error, no wrong price — just no badge, across most of a
// catalogue, present only on products that happened to have no MRP.
//
// Nothing about the rendered page says which field it read, so this is guarded
// the way `send-coverage.test.ts` and `export-scope.test.ts` guard theirs: by
// asserting the call site, not by hoping the next reader remembers.
describe("★ the shop grid asks for the right price", () => {
  it("passes the ON-SALE-FROM price, never the MRP", async () => {
    const { readFile } = await import("node:fs/promises");
    // The shop and every collection page load through one shared view, so
    // that is where the badge is priced.
    const src = await readFile(
      "app/(storefront)/(pages)/shop/shop-view.ts",
      "utf8",
    );
    expect(src).toContain("regularUnitPrice: priced.regularSelling");
    // `base` is the struck-through list price. Reaching for it here is the
    // exact regression above.
    expect(src).not.toContain("regularUnitPrice: priced.base");
  });
});

// ---------------------------------------------------------------------------
// offerTagFor — the marker for offers that have no per-unit price to quote.
//
// ★★ THE GAP IT CLOSES. `offerBadgeFor` prices ONE unit, so buy-X-get-Y,
// bundles and quantity breaks all score zero there — correctly, because none of
// them is a claim about buying one. But the product grid's only marker WAS that
// price badge, so a merchant's buy-1-get-1 was invisible to every shopper
// browsing the shop, and invisible on the product page, which had no marker of
// any kind.
// ---------------------------------------------------------------------------

const b1g1 = (over: Partial<Offer> = {}) =>
  offer({
    reward: {
      type: "buy_x_get_y",
      buyQuantity: 1,
      getQuantity: 1,
      getPercent: 100,
    },
    productIds: ["p1"],
    ...over,
  });

describe("offerTagFor", () => {
  it("tags a buy-1-get-1, which the price badge correctly cannot", () => {
    expect(offerBadgeFor(product(), [b1g1()], policy, NOW)).toBeNull();
    expect(offerTagFor(product(), [b1g1()], policy, NOW)).toMatchObject({
      label: "Buy 1, get 1 free",
      offerId: "o1",
    });
  });

  it("tags a bundle and a quantity break at the quantity that earns them", () => {
    const bundle = offer({
      reward: { type: "bundle_price", bundleQuantity: 3, bundlePrice: 999 },
      productIds: ["p1"],
    });
    expect(
      offerTagFor(product({ unitPrice: 500 }), [bundle], policy, NOW),
    ).not.toBeNull();

    const vol = offer({
      reward: {
        type: "volume_break",
        breaks: [{ minQuantity: 10, percent: 15 }],
      },
      productIds: ["p1"],
    });
    expect(offerTagFor(product(), [vol], policy, NOW)).not.toBeNull();
  });

  // ★★ THE PROPERTY THAT KEEPS THIS FROM BECOMING "the offer says 20%". The
  // probe runs the real engine, so every gate the cart applies has already
  // been passed by anything that returns a tag.
  it("shows nothing for an offer the cart would refuse", () => {
    const cases: Array<[string, Offer]> = [
      ["another product", b1g1({ productIds: ["other"] })],
      ["paused", b1g1({ status: "disabled" })],
      ["expired", b1g1({ validUntil: "2026-01-01T00:00:00.000Z" })],
      ["not started", b1g1({ validFrom: "2027-01-01T00:00:00.000Z" })],
      ["POS only", b1g1({ channels: ["pos"] })],
      ["needs a code", b1g1({ delivery: "code", code: "LAUNCH" })],
      ["restricted to a group", b1g1({ groupIds: ["g1"] })],
      ["out of budget", b1g1({ remainingBudget: 0 })],
      ["exhausted", b1g1({ exhausted: true })],
    ];
    for (const [why, o] of cases) {
      expect(offerTagFor(product(), [o], policy, NOW), why).toBeNull();
    }
  });

  it("shows nothing when the store has automatic offers switched off", () => {
    expect(
      offerTagFor(product(), [b1g1()], { ...policy, autoApply: false }, NOW),
    ).toBeNull();
  });

  it("respects the store's sale-price mode", () => {
    // On sale, and the store says offers skip sale items — so there is no
    // offer on this product, and saying otherwise would be a promise the cart
    // declines.
    const onSale = product({ unitPrice: 800, regularUnitPrice: 1000 });
    expect(
      offerTagFor(onSale, [b1g1()], { ...policy, onSalePrice: "skip" }, NOW),
    ).toBeNull();
    expect(offerTagFor(onSale, [b1g1()], policy, NOW)).not.toBeNull();
  });

  it("ignores order-level, shipping, gift and cashback offers", () => {
    // None of them is a fact about THIS product.
    const notLineLevel: Offer[] = [
      offer({ reward: { type: "percent_off", percent: 10 } }),
      offer({ reward: { type: "free_shipping" } }),
      offer({ reward: { type: "credit_back", creditAmount: 100 } }),
    ];
    for (const o of notLineLevel) {
      expect(offerTagFor(product(), [o], policy, NOW)).toBeNull();
    }
  });

  it("covers a category-scoped offer, not only a named product", () => {
    const byCategory = b1g1({ productIds: [], categoryIds: ["c1"] });
    expect(offerTagFor(product(), [byCategory], policy, NOW)).not.toBeNull();
    expect(
      offerTagFor(product({ categoryId: "other" }), [byCategory], policy, NOW),
    ).toBeNull();
  });
});
