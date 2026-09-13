import { describe, it, expect } from "vitest";
import {
  applyOffers,
  MAX_EVALUATED_OFFERS,
  storeLocalTime,
  withinTimeWindow,
  type OfferContext,
  type OfferLine,
} from "./apply";
import type { Offer } from "./types";

const NOW = new Date("2026-09-02T10:00:00.000Z");

function ctx(over: Partial<OfferContext> = {}): OfferContext {
  return {
    channel: "storefront",
    locationId: "loc-1",
    customerId: "cus-1",
    groupIds: [],
    now: NOW,
    code: null,
    onSalePrice: "best",
    maxTotalDiscountPercent: 100,
    autoApply: true,
    ...over,
  };
}

function offer(over: Partial<Offer> = {}): Offer {
  return {
    id: "o1",
    name: "Test offer",
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
    reward: { type: "percent_off", percent: 10 },
    productIds: [],
    variantIds: [],
    categoryIds: [],
    ...over,
  };
}

function line(over: Partial<OfferLine> = {}): OfferLine {
  return {
    id: "l1",
    productId: "p1",
    variantId: null,
    categoryId: "c1",
    quantity: 1,
    unitPrice: 1000,
    ...over,
  };
}

describe("applyOffers — the basics", () => {
  it("applies a percentage off the order, allocated to the line", () => {
    const r = applyOffers({
      lines: [line()],
      offers: [offer({ reward: { type: "percent_off", percent: 10 } })],
      context: ctx(),
    });
    expect(r.discount).toBe(100);
    expect(r.lines).toEqual([{ id: "l1", offerDiscount: 100 }]);
    expect(r.applied[0]).toMatchObject({
      offerId: "o1",
      level: "order",
      amount: 100,
    });
  });

  it("★ allocates a fixed amount across lines so the parts sum to the whole", () => {
    const r = applyOffers({
      lines: [
        line({ id: "a", unitPrice: 333 }),
        line({ id: "b", unitPrice: 333 }),
        line({ id: "c", unitPrice: 334 }),
      ],
      offers: [offer({ reward: { type: "amount_off", amount: 100 } })],
      context: ctx(),
    });
    const sum = r.lines.reduce((s, l) => s + l.offerDiscount, 0);
    expect(sum).toBe(100);
    expect(r.discount).toBe(100);
  });

  it("never discounts more than the cart is worth", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 50 })],
      offers: [offer({ reward: { type: "amount_off", amount: 500 } })],
      context: ctx(),
    });
    expect(r.discount).toBe(50);
  });

  it("works on an empty cart without applying anything", () => {
    const r = applyOffers({ lines: [], offers: [offer()], context: ctx() });
    expect(r.discount).toBe(0);
    expect(r.applied).toEqual([]);
    expect(r.scenario.chosen).toBeNull();
  });

  it("offers work on the amount left after a manual markdown, not before", () => {
    // ₹1,000 line with ₹200 knocked off at the till → 10% of ₹800.
    const r = applyOffers({
      lines: [line({ lineDiscount: 200 })],
      offers: [offer({ reward: { type: "percent_off", percent: 10 } })],
      context: ctx(),
    });
    expect(r.subtotal).toBe(800);
    expect(r.discount).toBe(80);
  });
});

describe("applyOffers — best offer wins", () => {
  const shakes = line({
    id: "shake",
    productId: "p-shake",
    categoryId: "cat-shake",
    unitPrice: 100,
  });
  const other = line({
    id: "other",
    productId: "p-other",
    categoryId: "cat-other",
    unitPrice: 900,
  });

  const fivePctShakes = offer({
    id: "shakes5",
    name: "5% off shakes",
    reward: { type: "percent_off_items", percent: 5 },
    categoryIds: ["cat-shake"],
  });
  const twentyPctOrder = offer({
    id: "order20",
    name: "20% off order",
    reward: { type: "percent_off", percent: 20 },
  });

  it("★ order_only beats line_and_order — the whole reason the comparison exists", () => {
    // line_and_order = ₹5 + 20% × ₹900 = ₹185
    // order_only     =      20% × ₹1,000 = ₹200  ← must win
    const r = applyOffers({
      lines: [shakes, other],
      offers: [fivePctShakes, twentyPctOrder],
      context: ctx(),
    });
    expect(r.discount).toBe(200);
    expect(r.scenario.chosen).toBe("order_only");

    const lineAndOrder = r.scenario.scores.find(
      (s) => s.id === "line_and_order",
    );
    expect(lineAndOrder?.discount).toBe(185);
  });

  it("keeps the line offer when it is worth more than the order offer", () => {
    // 50% off shakes (₹50) vs 2% off order (₹20): line_and_order wins at ₹68.
    const r = applyOffers({
      lines: [shakes, other],
      offers: [
        offer({
          id: "shakes50",
          name: "50% off shakes",
          reward: { type: "percent_off_items", percent: 50 },
          categoryIds: ["cat-shake"],
        }),
        offer({
          id: "order2",
          name: "2% off order",
          reward: { type: "percent_off", percent: 2 },
        }),
      ],
      context: ctx(),
    });
    expect(r.scenario.chosen).toBe("line_and_order");
    expect(r.discount).toBe(50 + 18);
  });

  it("falls back to line_only when there is no order offer", () => {
    const r = applyOffers({
      lines: [shakes, other],
      offers: [fivePctShakes],
      context: ctx(),
    });
    expect(r.scenario.chosen).toBe("line_only");
    expect(r.discount).toBe(5);
  });

  it("★ one offer per line — a claimed line is removed from the order offer's base", () => {
    const r = applyOffers({
      lines: [shakes, other],
      offers: [
        offer({
          id: "shakes50",
          reward: { type: "percent_off_items", percent: 50 },
          categoryIds: ["cat-shake"],
        }),
        offer({ id: "order2", reward: { type: "percent_off", percent: 2 } }),
      ],
      context: ctx(),
    });
    // The shake line carries ONLY the 50% line offer, not 50% + 2%.
    const shakeLine = r.lines.find((l) => l.id === "shake");
    expect(shakeLine?.offerDiscount).toBe(50);
    const allocs = r.allocations.filter((a) => a.lineId === "shake");
    expect(allocs).toHaveLength(1);
    expect(allocs[0].offerId).toBe("shakes50");
  });

  it("reports every scenario it scored, so a counter can explain the choice", () => {
    const r = applyOffers({
      lines: [shakes, other],
      offers: [fivePctShakes, twentyPctOrder],
      context: ctx(),
    });
    expect(r.scenario.scores.map((s) => s.id)).toEqual([
      "line_only",
      "line_and_order",
      "order_only",
    ]);
    expect(
      r.skipped.some(
        (s) => s.offerId === "shakes5" && s.reason === "outscored",
      ),
    ).toBe(true);
  });

  it("★ picks the best of several competing order offers", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 1000 })],
      offers: [
        offer({ id: "a", reward: { type: "percent_off", percent: 5 } }),
        offer({ id: "b", reward: { type: "amount_off", amount: 250 } }),
        offer({ id: "c", reward: { type: "percent_off", percent: 20 } }),
      ],
      context: ctx(),
    });
    expect(r.discount).toBe(250);
    expect(r.applied[0].offerId).toBe("b");
  });
});

describe("applyOffers — determinism", () => {
  it("★ ties break on priority, then age, then id — never on input order", () => {
    const a = offer({
      id: "zzz",
      priority: 1,
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    const b = offer({
      id: "aaa",
      priority: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const forwards = applyOffers({
      lines: [line()],
      offers: [a, b],
      context: ctx(),
    });
    const backwards = applyOffers({
      lines: [line()],
      offers: [b, a],
      context: ctx(),
    });
    // Older wins at equal priority, whichever order they arrive in.
    expect(forwards.applied[0].offerId).toBe("aaa");
    expect(backwards.applied[0].offerId).toBe("aaa");
  });

  it("higher priority wins a tie over an older offer", () => {
    const old = offer({
      id: "old",
      priority: 0,
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    const important = offer({
      id: "imp",
      priority: 5,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const r = applyOffers({
      lines: [line()],
      offers: [old, important],
      context: ctx(),
    });
    expect(r.applied[0].offerId).toBe("imp");
  });

  it("produces byte-identical results across repeated calls", () => {
    const args = {
      lines: [
        line({ id: "a", unitPrice: 333 }),
        line({ id: "b", unitPrice: 667 }),
      ],
      offers: [offer({ reward: { type: "amount_off" as const, amount: 137 } })],
      context: ctx(),
    };
    expect(applyOffers(args)).toEqual(applyOffers(args));
  });

  it("★ caps the candidate set so engine cost cannot follow merchant behaviour", () => {
    const many = Array.from({ length: MAX_EVALUATED_OFFERS + 5 }, (_, i) =>
      offer({
        id: `o${i}`,
        priority: -i,
        reward: { type: "percent_off", percent: 1 },
      }),
    );
    const r = applyOffers({ lines: [line()], offers: many, context: ctx() });
    expect(
      r.skipped.filter((s) => s.reason === "beyond_candidate_cap"),
    ).toHaveLength(5);
  });
});

describe("applyOffers — thresholds", () => {
  it("applies when the subtotal clears the minimum", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 1000 })],
      offers: [offer({ trigger: { type: "min_subtotal", minSubtotal: 1000 } })],
      context: ctx(),
    });
    expect(r.discount).toBe(100);
  });

  it("refuses when it does not", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 999 })],
      offers: [offer({ trigger: { type: "min_subtotal", minSubtotal: 1000 } })],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
    expect(r.skipped).toEqual([{ offerId: "o1", reason: "trigger_unmet" }]);
  });

  it("★ measures the threshold against the UNDISCOUNTED subtotal", () => {
    // A ₹1,000 cart with a 20% order offer must still qualify a ₹900-minimum
    // offer — testing after discounts would be circular.
    const r = applyOffers({
      lines: [line({ unitPrice: 1000 })],
      offers: [
        offer({ id: "big", reward: { type: "percent_off", percent: 20 } }),
        offer({
          id: "min900",
          trigger: { type: "min_subtotal", minSubtotal: 900 },
          reward: { type: "percent_off", percent: 30 },
        }),
      ],
      context: ctx(),
    });
    expect(r.applied[0].offerId).toBe("min900");
    expect(r.discount).toBe(300);
  });
});

describe("applyOffers — scope and delivery", () => {
  it("refuses a disabled offer", () => {
    const r = applyOffers({
      lines: [line()],
      offers: [offer({ status: "disabled" })],
      context: ctx(),
    });
    expect(r.skipped).toEqual([{ offerId: "o1", reason: "disabled" }]);
  });

  it("respects the validity window in both directions", () => {
    const early = applyOffers({
      lines: [line()],
      offers: [offer({ validFrom: "2026-12-01T00:00:00.000Z" })],
      context: ctx(),
    });
    expect(early.skipped[0].reason).toBe("not_started");

    const late = applyOffers({
      lines: [line()],
      offers: [offer({ validUntil: "2026-01-01T00:00:00.000Z" })],
      context: ctx(),
    });
    expect(late.skipped[0].reason).toBe("expired");
  });

  it("refuses the wrong channel", () => {
    const r = applyOffers({
      lines: [line()],
      offers: [offer({ channels: ["pos"] })],
      context: ctx({ channel: "storefront" }),
    });
    expect(r.skipped[0].reason).toBe("wrong_channel");
  });

  it("★ a location-scoped offer fails CLOSED when the location is unknown", () => {
    const r = applyOffers({
      lines: [line()],
      offers: [offer({ locationIds: ["loc-9"] })],
      context: ctx({ locationId: null }),
    });
    expect(r.skipped[0].reason).toBe("wrong_location");
  });

  it("an unscoped offer applies at every location", () => {
    const r = applyOffers({
      lines: [line()],
      offers: [offer({ locationIds: [] })],
      context: ctx({ locationId: null }),
    });
    expect(r.discount).toBe(100);
  });

  it("restricts to customer groups when set", () => {
    const restricted = offer({ groupIds: ["g-vip"] });
    const out = applyOffers({
      lines: [line()],
      offers: [restricted],
      context: ctx({ groupIds: ["g-other"] }),
    });
    expect(out.skipped[0].reason).toBe("not_in_group");

    const inGroup = applyOffers({
      lines: [line()],
      offers: [restricted],
      context: ctx({ groupIds: ["g-vip"] }),
    });
    expect(inGroup.discount).toBe(100);
  });

  it("an automatic offer needs the store's auto-apply switch", () => {
    const r = applyOffers({
      lines: [line()],
      offers: [offer({ delivery: "automatic" })],
      context: ctx({ autoApply: false }),
    });
    expect(r.skipped[0].reason).toBe("auto_apply_off");
  });

  it("★ a code offer works even with auto-apply off — the shopper holds the code", () => {
    const r = applyOffers({
      lines: [line()],
      offers: [offer({ delivery: "code", code: "SAVE10" })],
      context: ctx({ autoApply: false, code: "save10" }),
    });
    expect(r.discount).toBe(100);
  });

  it("a code offer without the code does not apply", () => {
    const r = applyOffers({
      lines: [line()],
      offers: [offer({ delivery: "code", code: "SAVE10" })],
      context: ctx({ code: null }),
    });
    expect(r.skipped[0].reason).toBe("code_required");
  });

  it("matches codes case-insensitively and ignoring spaces", () => {
    const r = applyOffers({
      lines: [line()],
      offers: [offer({ delivery: "code", code: "SAVE10" })],
      context: ctx({ code: " sa ve10 " }),
    });
    expect(r.discount).toBe(100);
  });
});

describe("applyOffers — limits", () => {
  it("refuses an exhausted offer", () => {
    const r = applyOffers({
      lines: [line()],
      offers: [offer({ exhausted: true })],
      context: ctx(),
    });
    expect(r.skipped[0].reason).toBe("exhausted");
  });

  it("★ caps an offer's contribution at its remaining budget, not all-or-nothing", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 1000 })],
      offers: [
        offer({
          reward: { type: "percent_off", percent: 20 },
          remainingBudget: 40,
        }),
      ],
      context: ctx(),
    });
    expect(r.discount).toBe(40);
  });

  it("refuses an offer whose budget is spent", () => {
    const r = applyOffers({
      lines: [line()],
      offers: [offer({ remainingBudget: 0 })],
      context: ctx(),
    });
    expect(r.skipped[0].reason).toBe("no_budget");
  });

  it("★ the per-order ceiling clamps the total and scales the lines down", () => {
    const r = applyOffers({
      lines: [
        line({ id: "a", unitPrice: 500 }),
        line({ id: "b", unitPrice: 500 }),
      ],
      offers: [offer({ reward: { type: "percent_off", percent: 80 } })],
      context: ctx({ maxTotalDiscountPercent: 50 }),
    });
    expect(r.discount).toBe(500); // 50% of ₹1,000, not 80%
    expect(r.cappedByCeiling).toBe(true);
    const sum = r.lines.reduce((s, l) => s + l.offerDiscount, 0);
    expect(sum).toBe(500);
  });

  it("a ceiling of 0 means no offer may discount anything", () => {
    const r = applyOffers({
      lines: [line()],
      offers: [offer()],
      context: ctx({ maxTotalDiscountPercent: 0 }),
    });
    expect(r.discount).toBe(0);
  });

  it("★ the ceiling is applied while SCORING, so scenarios compare deliverable value", () => {
    // 80% order offer and a 30% line offer, ceiling 25%. Both clamp to ₹250, so
    // the comparison must not pick on pre-clamp headline figures.
    const r = applyOffers({
      lines: [line({ unitPrice: 1000 })],
      offers: [
        offer({ id: "big", reward: { type: "percent_off", percent: 80 } }),
        offer({
          id: "small",
          reward: { type: "percent_off_items", percent: 30 },
        }),
      ],
      context: ctx({ maxTotalDiscountPercent: 25 }),
    });
    expect(r.discount).toBe(250);
    r.scenario.scores.forEach((s) =>
      expect(s.discount).toBeLessThanOrEqual(250),
    );
  });
});

describe("applyOffers — special prices (offers.onSalePrice)", () => {
  // ₹1,000 regular, ₹800 special. A 10% offer off regular = ₹900.
  const onSale = line({ unitPrice: 800, regularUnitPrice: 1000 });
  const tenPct = offer({ reward: { type: "percent_off", percent: 10 } });

  it("best: the special price already beats the offer, so the offer adds nothing", () => {
    const r = applyOffers({
      lines: [onSale],
      offers: [tenPct],
      context: ctx({ onSalePrice: "best" }),
    });
    expect(r.discount).toBe(0);
  });

  it("best: a deeper offer beats the special price, and only the difference counts", () => {
    // 30% off ₹1,000 = ₹700, which beats the ₹800 special by ₹100.
    const r = applyOffers({
      lines: [onSale],
      offers: [offer({ reward: { type: "percent_off", percent: 30 } })],
      context: ctx({ onSalePrice: "best" }),
    });
    expect(r.discount).toBe(100);
  });

  it("stack: the offer discounts the special price again", () => {
    const r = applyOffers({
      lines: [onSale],
      offers: [tenPct],
      context: ctx({ onSalePrice: "stack" }),
    });
    expect(r.discount).toBe(80); // 10% of ₹800
  });

  it("skip: a line on a special price is excluded entirely", () => {
    const r = applyOffers({
      lines: [onSale],
      offers: [tenPct],
      context: ctx({ onSalePrice: "skip" }),
    });
    expect(r.discount).toBe(0);
  });

  it("skip: removes the on-sale line from a fixed-amount offer's base", () => {
    const r = applyOffers({
      lines: [onSale, line({ id: "full", unitPrice: 500 })],
      offers: [offer({ reward: { type: "amount_off", amount: 1000 } })],
      context: ctx({ onSalePrice: "skip" }),
    });
    // Only the ₹500 full-price line may be discounted.
    expect(r.discount).toBe(500);
    expect(r.lines.find((l) => l.id === "l1")?.offerDiscount).toBe(0);
  });

  it("★ every mode agrees when the line is NOT on sale", () => {
    const plain = line({ unitPrice: 1000 });
    const results = (["best", "skip", "stack"] as const).map(
      (m) =>
        applyOffers({
          lines: [plain],
          offers: [tenPct],
          context: ctx({ onSalePrice: m }),
        }).discount,
    );
    expect(results).toEqual([100, 100, 100]);
  });
});

describe("applyOffers — near misses", () => {
  const nudge = offer({
    id: "ship",
    name: "Free delivery over ₹1,000",
    trigger: { type: "min_subtotal", minSubtotal: 1000 },
  });

  it("reports the gap to an offer the cart nearly qualifies for", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 800 })],
      offers: [nudge],
      context: ctx(),
    });
    expect(r.nearMiss).toEqual([
      expect.objectContaining({ offerId: "ship", gap: 200 }),
    ]);
  });

  it("reports nothing once the cart qualifies", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 1000 })],
      offers: [nudge],
      context: ctx(),
    });
    expect(r.nearMiss).toEqual([]);
  });

  it("★ never nudges a code offer — that would leak the code to every visitor", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 800 })],
      offers: [offer({ ...nudge, delivery: "code", code: "SAVE10" })],
      context: ctx(),
    });
    expect(r.nearMiss).toEqual([]);
  });

  it("★ never nudges a group-restricted offer — the restriction was the point", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 800 })],
      offers: [offer({ ...nudge, groupIds: ["g-wholesale"] })],
      context: ctx({ groupIds: ["g-wholesale"] }),
    });
    expect(r.nearMiss).toEqual([]);
  });

  it("drops a gap far larger than the cart itself", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 100 })],
      offers: [
        offer({
          ...nudge,
          trigger: { type: "min_subtotal", minSubtotal: 50000 },
        }),
      ],
      context: ctx(),
    });
    expect(r.nearMiss).toEqual([]);
  });

  it("sorts nearest-first so the UI can show one", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 800 })],
      offers: [
        offer({
          id: "far",
          trigger: { type: "min_subtotal", minSubtotal: 1500 },
        }),
        offer({
          id: "near",
          trigger: { type: "min_subtotal", minSubtotal: 900 },
        }),
      ],
      context: ctx(),
    });
    expect(r.nearMiss.map((n) => n.offerId)).toEqual(["near", "far"]);
  });
});

describe("applyOffers — robustness", () => {
  it("survives junk quantities and prices without producing NaN", () => {
    const r = applyOffers({
      lines: [
        line({ id: "a", quantity: Number.NaN, unitPrice: 100 }),
        line({ id: "b", quantity: 2, unitPrice: Number.NaN }),
        line({ id: "c", quantity: -3, unitPrice: 100 }),
        line({ id: "d", quantity: 1, unitPrice: 100 }),
      ],
      offers: [offer()],
      context: ctx(),
    });
    expect(Number.isFinite(r.discount)).toBe(true);
    expect(r.lines.every((l) => Number.isFinite(l.offerDiscount))).toBe(true);
    expect(r.subtotal).toBe(100);
  });

  it("never allocates to a ₹0 line", () => {
    const r = applyOffers({
      lines: [
        line({ id: "free", unitPrice: 0 }),
        line({ id: "paid", unitPrice: 100 }),
      ],
      offers: [offer({ reward: { type: "amount_off", amount: 50 } })],
      context: ctx(),
    });
    expect(r.lines.find((l) => l.id === "free")?.offerDiscount).toBe(0);
    expect(r.lines.find((l) => l.id === "paid")?.offerDiscount).toBe(50);
  });

  it("tolerates a malformed offers argument", () => {
    const r = applyOffers({
      lines: [line()],
      offers: undefined as unknown as Offer[],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
  });

  it("★ the allocated lines always sum to the reported discount", () => {
    const r = applyOffers({
      lines: Array.from({ length: 7 }, (_, i) =>
        line({ id: `l${i}`, unitPrice: 137 + i * 11 }),
      ),
      offers: [offer({ reward: { type: "amount_off", amount: 291 } })],
      context: ctx(),
    });
    const sum = r.lines.reduce((s, l) => s + l.offerDiscount, 0);
    expect(sum).toBeCloseTo(r.discount, 10);
  });
});

// ---------------------------------------------------------------------------
// Phase B: line-scoped rewards and contents triggers.
// ---------------------------------------------------------------------------

describe("applyOffers — scoping a reward to products", () => {
  const shake = line({
    id: "shake",
    productId: "p-shake",
    categoryId: "cat-shake",
    unitPrice: 100,
  });
  const shoe = line({
    id: "shoe",
    productId: "p-shoe",
    categoryId: "cat-shoe",
    unitPrice: 900,
  });

  it("discounts only the lines it covers", () => {
    const r = applyOffers({
      lines: [shake, shoe],
      offers: [
        offer({
          reward: { type: "percent_off_items", percent: 20 },
          categoryIds: ["cat-shake"],
        }),
      ],
      context: ctx(),
    });
    expect(r.discount).toBe(20);
    expect(r.lines.find((l) => l.id === "shake")?.offerDiscount).toBe(20);
    expect(r.lines.find((l) => l.id === "shoe")?.offerDiscount).toBe(0);
  });

  it("matches a specific product, and a specific variant", () => {
    const withVariant = line({
      id: "v",
      productId: "p1",
      variantId: "var-9",
      unitPrice: 500,
    });
    const byProduct = applyOffers({
      lines: [withVariant],
      offers: [
        offer({
          reward: { type: "percent_off_items", percent: 10 },
          productIds: ["p1"],
        }),
      ],
      context: ctx(),
    });
    expect(byProduct.discount).toBe(50);

    const byVariant = applyOffers({
      lines: [withVariant],
      offers: [
        offer({
          reward: { type: "percent_off_items", percent: 10 },
          variantIds: ["var-9"],
        }),
      ],
      context: ctx(),
    });
    expect(byVariant.discount).toBe(50);
  });

  it("covers everything when no scope is set", () => {
    const r = applyOffers({
      lines: [shake, shoe],
      offers: [offer({ reward: { type: "percent_off_items", percent: 10 } })],
      context: ctx(),
    });
    expect(r.discount).toBe(100);
  });

  it("applies nothing when the scope matches no line", () => {
    const r = applyOffers({
      lines: [shake],
      offers: [
        offer({
          reward: { type: "percent_off_items", percent: 50 },
          categoryIds: ["cat-nope"],
        }),
      ],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
  });
});

describe("applyOffers — fixed price", () => {
  it("charges the named price per unit", () => {
    // 2 tees at ₹800 each, "any tee ₹499" → ₹602 off.
    const r = applyOffers({
      lines: [line({ quantity: 2, unitPrice: 800 })],
      offers: [offer({ reward: { type: "fixed_price", unitPrice: 499 } })],
      context: ctx(),
    });
    expect(r.discount).toBe(602);
  });

  it("★ never marks an item UP to meet the offer", () => {
    // The line is already cheaper than the fixed price.
    const r = applyOffers({
      lines: [line({ unitPrice: 300 })],
      offers: [offer({ reward: { type: "fixed_price", unitPrice: 499 } })],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
  });

  it("is worth zero on a line already at that exact price", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 499 })],
      offers: [offer({ reward: { type: "fixed_price", unitPrice: 499 } })],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
  });

  it("works on the amount left after a manual markdown", () => {
    // ₹1,000 line, ₹100 knocked off at the till → charged ₹900; target ₹499.
    const r = applyOffers({
      lines: [line({ unitPrice: 1000, lineDiscount: 100 })],
      offers: [offer({ reward: { type: "fixed_price", unitPrice: 499 } })],
      context: ctx(),
    });
    expect(r.discount).toBe(401);
  });

  it("is scoped like any other line reward", () => {
    const r = applyOffers({
      lines: [
        line({ id: "tee", productId: "p-tee", unitPrice: 800 }),
        line({ id: "bag", productId: "p-bag", unitPrice: 800 }),
      ],
      offers: [
        offer({
          reward: { type: "fixed_price", unitPrice: 499 },
          productIds: ["p-tee"],
        }),
      ],
      context: ctx(),
    });
    expect(r.lines.find((l) => l.id === "tee")?.offerDiscount).toBe(301);
    expect(r.lines.find((l) => l.id === "bag")?.offerDiscount).toBe(0);
  });

  it("★ skip leaves an on-sale line alone; best takes only the difference", () => {
    // ₹1,000 regular, ₹600 special, fixed price ₹499.
    const onSale = line({ unitPrice: 600, regularUnitPrice: 1000 });
    const reward = offer({
      reward: { type: "fixed_price" as const, unitPrice: 499 },
    });

    expect(
      applyOffers({
        lines: [onSale],
        offers: [reward],
        context: ctx({ onSalePrice: "skip" }),
      }).discount,
    ).toBe(0);
    // best: charge ₹499 instead of ₹600 → ₹101 off.
    expect(
      applyOffers({
        lines: [onSale],
        offers: [reward],
        context: ctx({ onSalePrice: "best" }),
      }).discount,
    ).toBe(101);
    // ★ stack behaves as best for a TARGET price — discounting a fixed price
    // again would charge a number the merchant never named.
    expect(
      applyOffers({
        lines: [onSale],
        offers: [reward],
        context: ctx({ onSalePrice: "stack" }),
      }).discount,
    ).toBe(101);
  });

  it("competes with other rewards on value, like anything else", () => {
    // ₹1,000 line: fixed ₹499 saves ₹501; 20% off saves ₹200.
    const r = applyOffers({
      lines: [line({ unitPrice: 1000 })],
      offers: [
        offer({ id: "fixed", reward: { type: "fixed_price", unitPrice: 499 } }),
        offer({
          id: "pct",
          reward: { type: "percent_off_items", percent: 20 },
        }),
      ],
      context: ctx(),
    });
    expect(r.applied[0].offerId).toBe("fixed");
    expect(r.discount).toBe(501);
  });
});

describe("applyOffers — contents triggers", () => {
  const shake = line({
    id: "shake",
    productId: "p-shake",
    categoryId: "cat-shake",
    unitPrice: 100,
  });
  const shoe = line({
    id: "shoe",
    productId: "p-shoe",
    categoryId: "cat-shoe",
    unitPrice: 900,
  });

  const containsShakes = offer({
    trigger: { type: "contains_category" },
    reward: { type: "percent_off", percent: 10 },
    categoryIds: ["cat-shake"],
  });

  it("★ qualifies off the offer's OWN scope — one list, not two", () => {
    const withShake = applyOffers({
      lines: [shake, shoe],
      offers: [containsShakes],
      context: ctx(),
    });
    // Qualifies, and being an ORDER-level reward it discounts the whole cart.
    expect(withShake.discount).toBe(100);

    const withoutShake = applyOffers({
      lines: [shoe],
      offers: [containsShakes],
      context: ctx(),
    });
    expect(withoutShake.discount).toBe(0);
    expect(withoutShake.skipped).toEqual([
      { offerId: "o1", reason: "trigger_unmet" },
    ]);
  });

  it("qualifies on a specific product too", () => {
    const r = applyOffers({
      lines: [shoe],
      offers: [
        offer({
          trigger: { type: "contains_product" },
          reward: { type: "amount_off", amount: 50 },
          productIds: ["p-shoe"],
        }),
      ],
      context: ctx(),
    });
    expect(r.discount).toBe(50);
  });

  it("★ does NOT qualify when skip has declined every matching line", () => {
    // The only shake is on a special price and the store skips those, so the
    // reward would apply to nothing — promising it would be a lie.
    const onSaleShake = line({
      id: "shake",
      productId: "p-shake",
      categoryId: "cat-shake",
      unitPrice: 60,
      regularUnitPrice: 100,
    });
    const r = applyOffers({
      lines: [onSaleShake, shoe],
      offers: [
        offer({
          trigger: { type: "contains_category" },
          reward: { type: "percent_off_items", percent: 10 },
          categoryIds: ["cat-shake"],
        }),
      ],
      context: ctx({ onSalePrice: "skip" }),
    });
    expect(r.discount).toBe(0);
    expect(r.skipped[0].reason).toBe("trigger_unmet");
  });

  it("an unscoped contents trigger behaves as 'any order'", () => {
    // Validation refuses to CREATE this, but the engine must still be sane if
    // one exists — it matches every line, so it qualifies.
    const r = applyOffers({
      lines: [shoe],
      offers: [offer({ trigger: { type: "contains_product" } })],
      context: ctx(),
    });
    expect(r.discount).toBe(90);
  });
});

describe("applyOffers — scope means different things per reward level", () => {
  const shake = line({
    id: "shake",
    productId: "p-shake",
    categoryId: "cat-shake",
    unitPrice: 100,
  });
  const shoe = line({
    id: "shoe",
    productId: "p-shoe",
    categoryId: "cat-shoe",
    unitPrice: 900,
  });

  it("★ a LINE reward discounts only the scope", () => {
    const r = applyOffers({
      lines: [shake, shoe],
      offers: [
        offer({
          reward: { type: "percent_off_items", percent: 10 },
          categoryIds: ["cat-shake"],
        }),
      ],
      context: ctx(),
    });
    expect(r.discount).toBe(10); // 10% of the ₹100 shake only
  });

  it("★ an ORDER reward discounts the whole cart, scope only qualifies it", () => {
    const r = applyOffers({
      lines: [shake, shoe],
      offers: [
        offer({
          trigger: { type: "contains_category" },
          reward: { type: "percent_off", percent: 10 },
          categoryIds: ["cat-shake"],
        }),
      ],
      context: ctx(),
    });
    expect(r.discount).toBe(100); // 10% of the full ₹1,000
  });

  it("and both are spendable on the same cart, best offer winning", () => {
    const r = applyOffers({
      lines: [shake, shoe],
      offers: [
        offer({
          id: "items",
          reward: { type: "percent_off_items", percent: 50 },
          categoryIds: ["cat-shake"],
        }),
        offer({
          id: "order",
          trigger: { type: "contains_category" },
          reward: { type: "percent_off", percent: 10 },
          categoryIds: ["cat-shake"],
        }),
      ],
      context: ctx(),
    });
    // order_only = ₹100 beats line_and_order = ₹50 + 10%×₹900 = ₹140? No:
    // line_and_order wins at ₹140, because the claimed shake leaves the
    // order offer only the ₹900 shoe.
    expect(r.discount).toBe(140);
    expect(r.scenario.chosen).toBe("line_and_order");
  });
});

// ---------------------------------------------------------------------------
// Phase C: buy X get Y — the first reward valued across MULTIPLE lines.
// ---------------------------------------------------------------------------

describe("applyOffers — buy X get Y", () => {
  const bxgy = (
    over: Partial<Offer["reward"]> = {},
    rest: Partial<Offer> = {},
  ) =>
    offer({
      reward: { type: "buy_x_get_y", buyQuantity: 1, getQuantity: 1, ...over },
      ...rest,
    });

  it("buy 1 get 1 on a single line of two units", () => {
    const r = applyOffers({
      lines: [line({ quantity: 2, unitPrice: 500 })],
      offers: [bxgy()],
      context: ctx(),
    });
    expect(r.discount).toBe(500);
  });

  it("★ counts UNITS ACROSS LINES — one set can span three lines", () => {
    // Buy 2 get 1, three separate lines of one unit each = one complete set.
    const r = applyOffers({
      lines: [
        line({ id: "a", unitPrice: 300 }),
        line({ id: "b", unitPrice: 200 }),
        line({ id: "c", unitPrice: 100 }),
      ],
      offers: [bxgy({ buyQuantity: 2, getQuantity: 1 })],
      context: ctx(),
    });
    // The CHEAPEST unit is the free one.
    expect(r.discount).toBe(100);
    expect(r.lines.find((l) => l.id === "c")?.offerDiscount).toBe(100);
    expect(r.lines.find((l) => l.id === "a")?.offerDiscount).toBe(0);
  });

  it("★ the cheapest units are free — '3 for the price of 2'", () => {
    const r = applyOffers({
      lines: [
        line({ id: "cheap", quantity: 2, unitPrice: 100 }),
        line({ id: "dear", quantity: 1, unitPrice: 900 }),
      ],
      offers: [bxgy({ buyQuantity: 2, getQuantity: 1 })],
      context: ctx(),
    });
    expect(r.discount).toBe(100);
    expect(r.lines.find((l) => l.id === "cheap")?.offerDiscount).toBe(100);
  });

  it("★ three units on buy-1-get-1 is ONE set, not one and a half", () => {
    const r = applyOffers({
      lines: [line({ quantity: 3, unitPrice: 100 })],
      offers: [bxgy()],
      context: ctx(),
    });
    expect(r.discount).toBe(100);
  });

  it("four units on buy-1-get-1 is two sets", () => {
    const r = applyOffers({
      lines: [line({ quantity: 4, unitPrice: 100 })],
      offers: [bxgy()],
      context: ctx(),
    });
    expect(r.discount).toBe(200);
  });

  it("does nothing below one complete set", () => {
    const r = applyOffers({
      lines: [line({ quantity: 2, unitPrice: 100 })],
      offers: [bxgy({ buyQuantity: 2, getQuantity: 1 })],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
  });

  it("buy 1 get 2 gives two units per three", () => {
    const r = applyOffers({
      lines: [line({ quantity: 3, unitPrice: 100 })],
      offers: [bxgy({ buyQuantity: 1, getQuantity: 2 })],
      context: ctx(),
    });
    expect(r.discount).toBe(200);
  });

  it("buy 1 get 1 at half price discounts the free unit by 50%", () => {
    const r = applyOffers({
      lines: [line({ quantity: 2, unitPrice: 500 })],
      offers: [bxgy({ getPercent: 50 })],
      context: ctx(),
    });
    expect(r.discount).toBe(250);
  });

  it("★ maxSets stops a bulk cart giving half the shop away", () => {
    const r = applyOffers({
      lines: [line({ quantity: 20, unitPrice: 100 })],
      offers: [bxgy({ maxSets: 2 })],
      context: ctx(),
    });
    expect(r.discount).toBe(200); // 2 sets, not 10
  });

  it("is scoped like any other line reward", () => {
    const r = applyOffers({
      lines: [
        line({ id: "in", productId: "p-in", quantity: 2, unitPrice: 100 }),
        line({ id: "out", productId: "p-out", quantity: 2, unitPrice: 100 }),
      ],
      offers: [bxgy({}, { productIds: ["p-in"] })],
      context: ctx(),
    });
    expect(r.lines.find((l) => l.id === "in")?.offerDiscount).toBe(100);
    expect(r.lines.find((l) => l.id === "out")?.offerDiscount).toBe(0);
  });

  it("respects its budget cap", () => {
    const r = applyOffers({
      lines: [line({ quantity: 4, unitPrice: 100 })],
      offers: [bxgy({}, { remainingBudget: 150 })],
      context: ctx(),
    });
    expect(r.discount).toBe(150);
  });

  it("never takes a line below zero", () => {
    const r = applyOffers({
      lines: [line({ quantity: 2, unitPrice: 1 })],
      offers: [bxgy({ getQuantity: 1 })],
      context: ctx(),
    });
    const l = r.lines[0];
    expect(l.offerDiscount).toBeGreaterThanOrEqual(0);
    expect(l.offerDiscount).toBeLessThanOrEqual(2);
  });
});

describe("applyOffers — a group offer competes on value", () => {
  it("★ loses to a deeper per-line offer on the same products", () => {
    // B1G1 on 2×₹100 saves ₹100. 80% off items saves ₹160.
    const r = applyOffers({
      lines: [line({ quantity: 2, unitPrice: 100 })],
      offers: [
        offer({
          id: "bxgy",
          reward: { type: "buy_x_get_y", buyQuantity: 1, getQuantity: 1 },
        }),
        offer({
          id: "deep",
          reward: { type: "percent_off_items", percent: 80 },
        }),
      ],
      context: ctx(),
    });
    expect(r.applied[0].offerId).toBe("deep");
    expect(r.discount).toBe(160);
  });

  it("★ wins when it is worth more, replacing the per-line winner", () => {
    // B1G1 on 2×₹100 saves ₹100. 10% off items saves ₹20.
    const r = applyOffers({
      lines: [line({ quantity: 2, unitPrice: 100 })],
      offers: [
        offer({
          id: "bxgy",
          reward: { type: "buy_x_get_y", buyQuantity: 1, getQuantity: 1 },
        }),
        offer({
          id: "weak",
          reward: { type: "percent_off_items", percent: 10 },
        }),
      ],
      context: ctx(),
    });
    expect(r.applied[0].offerId).toBe("bxgy");
    expect(r.discount).toBe(100);
  });

  it("★ still leaves exactly one offer per line", () => {
    const r = applyOffers({
      lines: [line({ id: "l", quantity: 2, unitPrice: 100 })],
      offers: [
        offer({
          id: "bxgy",
          reward: { type: "buy_x_get_y", buyQuantity: 1, getQuantity: 1 },
        }),
        offer({
          id: "weak",
          reward: { type: "percent_off_items", percent: 10 },
        }),
      ],
      context: ctx(),
    });
    expect(r.allocations.filter((a) => a.lineId === "l")).toHaveLength(1);
  });

  it("does not depend on the order the offers arrive in", () => {
    const a = offer({
      id: "bxgy",
      reward: { type: "buy_x_get_y" as const, buyQuantity: 1, getQuantity: 1 },
    });
    const b = offer({
      id: "weak",
      reward: { type: "percent_off_items" as const, percent: 10 },
    });
    const lines = [line({ quantity: 2, unitPrice: 100 })];
    const fwd = applyOffers({ lines, offers: [a, b], context: ctx() });
    const rev = applyOffers({ lines, offers: [b, a], context: ctx() });
    expect(fwd.discount).toBe(rev.discount);
    expect(fwd.applied[0].offerId).toBe(rev.applied[0].offerId);
  });
});

describe("applyOffers — buy X get Y near miss", () => {
  const bxgy = offer({
    name: "Buy 1 get 1 on shakes",
    reward: { type: "buy_x_get_y", buyQuantity: 1, getQuantity: 1 },
    categoryIds: ["cat-shake"],
  });
  const shake = (q: number) =>
    line({
      id: "s",
      productId: "p-shake",
      productName: "Almond shake",
      categoryId: "cat-shake",
      quantity: q,
      unitPrice: 100,
    });

  it("★ says how many MORE units are needed, not a rupee gap", () => {
    const r = applyOffers({
      lines: [shake(1)],
      offers: [bxgy],
      context: ctx(),
    });
    expect(r.nearMiss[0]).toMatchObject({
      kind: "units",
      gap: 1,
      getQuantity: 1,
      productName: "Almond shake",
    });
  });

  it("says nothing once a set is complete", () => {
    const r = applyOffers({
      lines: [shake(2)],
      offers: [bxgy],
      context: ctx(),
    });
    expect(r.nearMiss).toEqual([]);
  });

  it("counts from the incomplete remainder, not from zero", () => {
    // 3 units on buy-1-get-1: one complete set plus one unit → 1 short.
    const r = applyOffers({
      lines: [shake(3)],
      offers: [bxgy],
      context: ctx(),
    });
    expect(r.nearMiss[0]).toMatchObject({ kind: "units", gap: 1 });
  });

  it("★ says nothing to a cart holding none of the products — that is an advert", () => {
    const other = line({
      id: "o",
      productId: "p-other",
      categoryId: "cat-other",
      unitPrice: 500,
    });
    const r = applyOffers({ lines: [other], offers: [bxgy], context: ctx() });
    expect(r.nearMiss).toEqual([]);
  });

  it("★ never nudges a code or group-restricted group offer either", () => {
    const coded = applyOffers({
      lines: [shake(1)],
      offers: [{ ...bxgy, delivery: "code" as const, code: "BOGO" }],
      context: ctx(),
    });
    expect(coded.nearMiss).toEqual([]);

    const restricted = applyOffers({
      lines: [shake(1)],
      offers: [{ ...bxgy, groupIds: ["g-vip"] }],
      context: ctx({ groupIds: ["g-vip"] }),
    });
    expect(restricted.nearMiss).toEqual([]);
  });

  it("★ a unit gap is offered before a spend gap — a smaller ask", () => {
    const r = applyOffers({
      lines: [shake(1)],
      offers: [
        bxgy,
        offer({
          id: "spend",
          trigger: { type: "min_subtotal", minSubtotal: 150 },
        }),
      ],
      context: ctx(),
    });
    expect(r.nearMiss[0].kind).toBe("units");
    expect(r.nearMiss.map((n) => n.kind)).toContain("spend");
  });
});

describe("applyOffers — spend-more-save-more tiers", () => {
  const ladder = offer({
    reward: {
      type: "tiered",
      tierMode: "percent",
      tiers: [
        { minSubtotal: 1000, value: 5 },
        { minSubtotal: 2000, value: 10 },
        { minSubtotal: 5000, value: 15 },
      ],
    },
  });

  it("applies the highest qualifying rung, never the sum of them", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 2500 })],
      offers: [ladder],
      context: ctx(),
    });
    // 10% of 2500, not 5+10 = 15%.
    expect(r.discount).toBe(250);
  });

  it("takes the top rung on a large cart", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 6000 })],
      offers: [ladder],
      context: ctx(),
    });
    expect(r.discount).toBe(900);
  });

  it("refuses below the lowest rung, and says why", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 400 })],
      offers: [ladder],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
    expect(r.skipped).toEqual([{ offerId: "o1", reason: "trigger_unmet" }]);
  });

  it("chooses the rung on the UNDISCOUNTED subtotal, so it cannot deselect itself", () => {
    // 2000 exactly reaches the 10% rung. Were the rung re-tested after the
    // discount (1800), it would fall back to 5% — and then 1900 would qualify
    // again, which is the circularity `min_subtotal` avoids the same way.
    const r = applyOffers({
      lines: [line({ unitPrice: 2000 })],
      offers: [ladder],
      context: ctx(),
    });
    expect(r.discount).toBe(200);
  });

  it("supports a rupee ladder as well as a percentage one", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 3000 })],
      offers: [
        offer({
          reward: {
            type: "tiered",
            tierMode: "amount",
            tiers: [
              { minSubtotal: 1000, value: 100 },
              { minSubtotal: 2500, value: 300 },
            ],
          },
        }),
      ],
      context: ctx(),
    });
    expect(r.discount).toBe(300);
  });

  it("honours the per-order depth ceiling like any other reward", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 6000 })],
      offers: [ladder],
      context: ctx({ maxTotalDiscountPercent: 5 }),
    });
    expect(r.discount).toBe(300);
    expect(r.cappedByCeiling).toBe(true);
  });

  it("loses to a deeper flat offer under best-offer-wins", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 2500 })],
      offers: [
        ladder,
        offer({ id: "flat", reward: { type: "percent_off", percent: 20 } }),
      ],
      context: ctx(),
    });
    expect(r.discount).toBe(500);
    expect(r.applied[0].offerId).toBe("flat");
  });
});

describe("applyOffers — tier upgrade nudge", () => {
  const ladder = offer({
    reward: {
      type: "tiered",
      tierMode: "percent",
      tiers: [
        { minSubtotal: 1000, value: 10 },
        { minSubtotal: 1200, value: 15 },
      ],
    },
  });

  it("names the next rung AND what the cart already earns", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 1050 })],
      offers: [ladder],
      context: ctx(),
    });
    // The cart is being discounted at 10% right now…
    expect(r.discount).toBe(105);
    // …and is told what 150 more would buy, against what it has.
    expect(r.nearMiss).toHaveLength(1);
    expect(r.nearMiss[0]).toMatchObject({
      kind: "spend",
      gap: 150,
      percent: 15,
      currentPercent: 10,
    });
  });

  it("says nothing on the top rung", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 1300 })],
      offers: [ladder],
      context: ctx(),
    });
    expect(r.nearMiss).toEqual([]);
  });

  it("carries NO current value before the ladder applies at all", () => {
    // ★ The distinction the UI branches on: without a current value the
    // sentence is "get 10% off", with one it is "get 15% instead of 10%".
    const r = applyOffers({
      lines: [line({ unitPrice: 900 })],
      offers: [ladder],
      context: ctx(),
    });
    expect(r.nearMiss[0]).toMatchObject({ gap: 100, percent: 10 });
    expect(r.nearMiss[0].currentPercent).toBeUndefined();
  });

  it("never nudges an upgrade for a coded or group-only ladder", () => {
    for (const over of [
      { delivery: "code" as const, code: "LADDER" },
      { groupIds: ["g1"] },
    ]) {
      const r = applyOffers({
        lines: [line({ unitPrice: 1050 })],
        offers: [{ ...ladder, ...over }],
        context: ctx({ code: "LADDER", groupIds: ["g1"] }),
      });
      expect(r.nearMiss).toEqual([]);
    }
  });
});

describe("applyOffers — volume breaks", () => {
  const caseprice = offer({
    productIds: ["p1", "p2"],
    reward: {
      type: "volume_break",
      breaks: [
        { minQuantity: 6, percent: 10 },
        { minQuantity: 12, percent: 15 },
      ],
    },
  });

  it("counts units ACROSS the scoped lines, not per line", () => {
    // Six of one and six of another reach the twelve-unit rung together.
    const r = applyOffers({
      lines: [
        line({ id: "a", productId: "p1", quantity: 6, unitPrice: 100 }),
        line({ id: "b", productId: "p2", quantity: 6, unitPrice: 100 }),
      ],
      offers: [caseprice],
      context: ctx(),
    });
    expect(r.discount).toBe(180); // 15% of 1200
  });

  it("discounts EVERY scoped unit once the rung is reached, not only the ones above it", () => {
    const r = applyOffers({
      lines: [line({ quantity: 6, unitPrice: 100 })],
      offers: [caseprice],
      context: ctx(),
    });
    expect(r.discount).toBe(60); // 10% of all six, not of one
  });

  it("refuses below the first rung", () => {
    const r = applyOffers({
      lines: [line({ quantity: 5, unitPrice: 100 })],
      offers: [caseprice],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
    expect(r.skipped).toEqual([{ offerId: "o1", reason: "trigger_unmet" }]);
  });

  it("ignores units outside its scope", () => {
    const r = applyOffers({
      lines: [
        line({ id: "in", productId: "p1", quantity: 5, unitPrice: 100 }),
        line({ id: "out", productId: "zzz", quantity: 5, unitPrice: 100 }),
      ],
      offers: [caseprice],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
  });

  it("does not displace a deeper line offer on the same products", () => {
    const r = applyOffers({
      lines: [line({ quantity: 6, unitPrice: 100 })],
      offers: [
        caseprice,
        offer({
          id: "deep",
          productIds: ["p1"],
          reward: { type: "percent_off_items", percent: 25 },
        }),
      ],
      context: ctx(),
    });
    expect(r.discount).toBe(150); // 25%, not the 10% case price
    expect(r.applied[0].offerId).toBe("deep");
  });

  it("nudges toward the next quantity rung, with what the cart already earns", () => {
    const r = applyOffers({
      lines: [line({ quantity: 10, unitPrice: 100 })],
      offers: [caseprice],
      context: ctx(),
    });
    expect(r.discount).toBe(100); // 10% of ten units
    expect(r.nearMiss).toHaveLength(1);
    expect(r.nearMiss[0]).toMatchObject({
      kind: "units",
      gap: 2,
      percent: 15,
      currentPercent: 10,
    });
  });

  it("nudges toward the FIRST rung, but only when the cart holds a scoped item", () => {
    const near = applyOffers({
      lines: [line({ quantity: 4, unitPrice: 100 })],
      offers: [caseprice],
      context: ctx(),
    });
    expect(near.nearMiss[0]).toMatchObject({
      kind: "units",
      gap: 2,
      percent: 10,
    });
    expect(near.nearMiss[0].currentPercent).toBeUndefined();

    // ★ Nothing of the product in the cart is an advert, not a nudge: it would
    // fire on every basket in the store.
    const none = applyOffers({
      lines: [line({ productId: "zzz", quantity: 1, unitPrice: 100 })],
      offers: [caseprice],
      context: ctx(),
    });
    expect(none.nearMiss).toEqual([]);
  });

  it("respects a total budget cap", () => {
    const r = applyOffers({
      lines: [line({ quantity: 12, unitPrice: 100 })],
      offers: [{ ...caseprice, remainingBudget: 50 }],
      context: ctx(),
    });
    expect(r.discount).toBe(50);
  });

  it("skips on-sale lines under `skip`, so they neither qualify nor discount", () => {
    const r = applyOffers({
      lines: [line({ quantity: 6, unitPrice: 80, regularUnitPrice: 100 })],
      offers: [caseprice],
      context: ctx({ onSalePrice: "skip" }),
    });
    expect(r.discount).toBe(0);
  });
});

describe("applyOffers — extra conditions", () => {
  const prepaid = offer({
    trigger: { type: "min_subtotal", minSubtotal: 500 },
    conditions: [{ type: "payment_method", methods: ["razorpay"] }],
    reward: { type: "amount_off", amount: 50 },
  });

  const cart = () => [line({ unitPrice: 1000 })];

  it("holds when the shopper chose an allowed method", () => {
    const r = applyOffers({
      lines: cart(),
      offers: [prepaid],
      context: ctx({ paymentMethod: "razorpay" }),
    });
    expect(r.discount).toBe(50);
  });

  it("refuses another method, and names WHICH condition failed", () => {
    const r = applyOffers({
      lines: cart(),
      offers: [prepaid],
      context: ctx({ paymentMethod: "cod" }),
    });
    expect(r.discount).toBe(0);
    expect(r.skipped).toEqual([
      { offerId: "o1", reason: "wrong_payment_method" },
    ]);
  });

  it("fails CLOSED when no method was stated", () => {
    // A discount for paying online must not be granted to a caller that
    // declined to say how it is paying.
    const r = applyOffers({
      lines: cart(),
      offers: [prepaid],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
    expect(r.skipped[0].reason).toBe("wrong_payment_method");
  });

  it("combines with the trigger rather than replacing it", () => {
    // ★ THE WHOLE REASON CONDITIONS ARE A LIST. "₹50 off prepaid orders over
    // ₹500" is inexpressible if payment method is an alternative trigger type.
    const r = applyOffers({
      lines: [line({ unitPrice: 400 })],
      offers: [prepaid],
      context: ctx({ paymentMethod: "razorpay" }),
    });
    expect(r.discount).toBe(0);
    expect(r.skipped[0].reason).toBe("trigger_unmet");
  });

  it("requires EVERY condition, not any", () => {
    const both = offer({
      conditions: [
        { type: "payment_method", methods: ["razorpay"] },
        { type: "first_order" },
      ],
      reward: { type: "percent_off", percent: 10 },
    });
    expect(
      applyOffers({
        lines: cart(),
        offers: [both],
        context: ctx({ paymentMethod: "razorpay", isFirstOrder: true }),
      }).discount,
    ).toBe(100);
    expect(
      applyOffers({
        lines: cart(),
        offers: [both],
        context: ctx({ paymentMethod: "razorpay", isFirstOrder: false }),
      }).discount,
    ).toBe(0);
  });

  it("gates on delivery or pickup", () => {
    const pickupOnly = offer({
      conditions: [{ type: "fulfilment_type", fulfilment: ["pickup"] }],
      reward: { type: "percent_off", percent: 5 },
    });
    expect(
      applyOffers({
        lines: cart(),
        offers: [pickupOnly],
        context: ctx({ fulfilmentType: "pickup" }),
      }).discount,
    ).toBe(50);
    const away = applyOffers({
      lines: cart(),
      offers: [pickupOnly],
      context: ctx({ fulfilmentType: "delivery" }),
    });
    expect(away.skipped[0].reason).toBe("wrong_fulfilment_type");
  });

  it("treats an UNKNOWN first-order state as not-first", () => {
    // ★ A guest has no history to check, so "unknown means first" would hand
    // every guest the new-customer discount on every order forever.
    const newCustomer = offer({
      conditions: [{ type: "first_order" }],
      reward: { type: "percent_off", percent: 20 },
    });
    for (const isFirstOrder of [null, undefined]) {
      const r = applyOffers({
        lines: cart(),
        offers: [newCustomer],
        context: ctx({ isFirstOrder }),
      });
      expect(r.skipped[0].reason).toBe("not_first_order");
    }
  });

  it("REFUSES an offer whose stored condition could not be read", () => {
    // ★★ Failing closed costs a discount somebody expected; failing open gives
    // away money nobody authorised. An offer restricted to first orders must
    // not start discounting every order because we could not parse the rule.
    const r = applyOffers({
      lines: cart(),
      offers: [
        offer({
          conditionsUnreadable: true,
          reward: { type: "percent_off", percent: 50 },
        }),
      ],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
    expect(r.skipped).toEqual([
      { offerId: "o1", reason: "conditions_unreadable" },
    ]);
  });

  it("does NOT nudge an offer blocked by a condition", () => {
    // "You're ₹200 from an offer you cannot have because you chose cash" is
    // worse than saying nothing. Conditions are checked before the trigger, so
    // a blocked offer never reaches the near-miss collector.
    const r = applyOffers({
      lines: [line({ unitPrice: 400 })],
      offers: [prepaid],
      context: ctx({ paymentMethod: "cod" }),
    });
    expect(r.nearMiss).toEqual([]);
  });

  it("still nudges when the conditions pass and only the trigger is short", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 400 })],
      offers: [prepaid],
      context: ctx({ paymentMethod: "razorpay" }),
    });
    expect(r.nearMiss[0]).toMatchObject({ kind: "spend", gap: 100 });
  });
});

describe("applyOffers — time windows", () => {
  const happyHour = (over: Partial<OfferContext> = {}) =>
    applyOffers({
      lines: [line({ unitPrice: 1000 })],
      offers: [
        offer({
          conditions: [
            {
              type: "time_window",
              days: [1], // Monday
              startMinute: 16 * 60,
              endMinute: 19 * 60,
            },
          ],
          reward: { type: "percent_off", percent: 20 },
        }),
      ],
      context: ctx(over),
    });

  it("applies inside the window, in the STORE's timezone", () => {
    // 12:00 UTC on Monday 2026-09-07 = 17:30 IST, inside 16:00–19:00.
    const r = happyHour({
      now: new Date("2026-09-07T12:00:00.000Z"),
      timeZone: "Asia/Kolkata",
    });
    expect(r.discount).toBe(200);
  });

  it("★ the SAME instant is outside the window in another store timezone", () => {
    // 12:00 UTC is 08:00 in New York — Monday, but before 16:00. This is the
    // whole point of resolving in the store's zone: the answer must be a fact
    // about the shop, not about the shopper.
    const r = happyHour({
      now: new Date("2026-09-07T12:00:00.000Z"),
      timeZone: "America/New_York",
    });
    expect(r.discount).toBe(0);
    expect(r.skipped[0].reason).toBe("outside_time_window");
  });

  it("fails closed with no timezone, and with a nonsense one", () => {
    for (const timeZone of [null, undefined, "Mars/Olympus"]) {
      const r = happyHour({
        now: new Date("2026-09-07T12:00:00.000Z"),
        timeZone,
      });
      expect(r.skipped[0].reason).toBe("outside_time_window");
    }
  });

  it("refuses the right time on the wrong day", () => {
    // Tuesday 17:30 IST.
    const r = happyHour({
      now: new Date("2026-09-08T12:00:00.000Z"),
      timeZone: "Asia/Kolkata",
    });
    expect(r.discount).toBe(0);
  });

  it("is half-open, so the end minute is already outside", () => {
    // Exactly 19:00 IST on Monday.
    const at19 = happyHour({
      now: new Date("2026-09-07T13:30:00.000Z"),
      timeZone: "Asia/Kolkata",
    });
    expect(at19.discount).toBe(0);
    // …and the start minute is inside.
    const at16 = happyHour({
      now: new Date("2026-09-07T10:30:00.000Z"),
      timeZone: "Asia/Kolkata",
    });
    expect(at16.discount).toBe(200);
  });
});

describe("withinTimeWindow — wrapping past midnight", () => {
  // ★★ A wrapped window belongs to the day it BEGINS on. "Friday 22:00–02:00"
  // is one four-hour evening, not two hours on Friday plus two unrelated hours
  // before dawn. Checking the current day's bit would cut every late-night
  // offer in half, silently, on the day the merchant actually chose.
  const friNight = { days: [5], startMinute: 22 * 60, endMinute: 2 * 60 };

  it("includes Friday evening", () => {
    expect(withinTimeWindow({ day: 5, minute: 23 * 60 }, friNight)).toBe(true);
  });

  it("includes SATURDAY's early hours, because Friday's window runs into them", () => {
    expect(withinTimeWindow({ day: 6, minute: 60 }, friNight)).toBe(true);
  });

  it("excludes FRIDAY's early hours, which belong to Thursday's window", () => {
    expect(withinTimeWindow({ day: 5, minute: 60 }, friNight)).toBe(false);
  });

  it("excludes the middle of Friday", () => {
    expect(withinTimeWindow({ day: 5, minute: 12 * 60 }, friNight)).toBe(false);
  });

  it("wraps the week boundary: Sunday's window reaches into Monday", () => {
    const sunNight = { days: [0], startMinute: 23 * 60, endMinute: 60 };
    expect(withinTimeWindow({ day: 1, minute: 30 }, sunNight)).toBe(true);
    // …and Sunday's own early hours belong to Saturday's window, not its own.
    expect(withinTimeWindow({ day: 0, minute: 30 }, sunNight)).toBe(false);
  });

  it("never matches with no days selected", () => {
    expect(
      withinTimeWindow(
        { day: 3, minute: 600 },
        { days: [], startMinute: 0, endMinute: 1439 },
      ),
    ).toBe(false);
  });
});

describe("storeLocalTime", () => {
  it("resolves the store's own day and minute", () => {
    // 18:45 UTC Monday = 00:15 IST TUESDAY — the day rolls over, which a
    // naive UTC read would miss entirely.
    expect(
      storeLocalTime(new Date("2026-09-07T18:45:00.000Z"), "Asia/Kolkata"),
    ).toEqual({ day: 2, minute: 15 });
  });

  it("handles a zone observing daylight saving", () => {
    // 2026-09-07 is inside US DST, so New York is UTC-4: 12:00Z = 08:00.
    expect(
      storeLocalTime(new Date("2026-09-07T12:00:00.000Z"), "America/New_York"),
    ).toEqual({ day: 1, minute: 8 * 60 });
    // In January it is UTC-5: 12:00Z = 07:00. Hand-rolled offsets get this
    // wrong at exactly the boundaries a happy-hour offer cares about.
    expect(
      storeLocalTime(new Date("2026-01-05T12:00:00.000Z"), "America/New_York"),
    ).toEqual({ day: 1, minute: 7 * 60 });
  });

  it("returns null rather than falling back to UTC on a bad zone", () => {
    expect(storeLocalTime(NOW, "Mars/Olympus")).toBeNull();
    expect(storeLocalTime(NOW, "")).toBeNull();
  });

  it("reads midnight as minute zero, not 1440", () => {
    expect(
      storeLocalTime(new Date("2026-09-07T18:30:00.000Z"), "Asia/Kolkata"),
    ).toEqual({ day: 2, minute: 0 });
  });
});

describe("applyOffers — free shipping is a separate axis", () => {
  const freeDelivery = offer({
    id: "ship",
    trigger: { type: "min_subtotal", minSubtotal: 500 },
    reward: { type: "free_shipping" },
  });

  it("reports the waiver without touching the merchandise discount", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 600 })],
      offers: [freeDelivery],
      context: ctx(),
    });
    // ★ NOT part of `discount`: a waiver reduces the SHIPPING charge, and
    // adding it here would misstate the tax base and every refund computed
    // from the per-line allocation.
    expect(r.discount).toBe(0);
    expect(r.lines[0].offerDiscount).toBe(0);
    expect(r.shipping).toMatchObject({ offerId: "ship", amount: 0 });
  });

  it("★ applies ALONGSIDE a merchandise offer, never instead of it", () => {
    // A shopper must not lose free delivery because a category discount scored
    // higher — they are different pockets of the bill.
    const r = applyOffers({
      lines: [line({ unitPrice: 600 })],
      offers: [
        freeDelivery,
        offer({ id: "pct", reward: { type: "percent_off", percent: 10 } }),
      ],
      context: ctx(),
    });
    expect(r.discount).toBe(60);
    expect(r.applied[0].offerId).toBe("pct");
    expect(r.shipping?.offerId).toBe("ship");
  });

  it("survives a cart where every merchandise offer fails", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 600 })],
      offers: [
        freeDelivery,
        offer({
          id: "dead",
          trigger: { type: "min_subtotal", minSubtotal: 99999 },
          reward: { type: "percent_off", percent: 10 },
        }),
      ],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
    expect(r.shipping?.offerId).toBe("ship");
  });

  it("is NOT counted against the per-order depth ceiling", () => {
    // The ceiling bounds how deeply merchandise may be discounted. Shipping is
    // a different pocket, and the engine cannot price it anyway.
    const r = applyOffers({
      lines: [line({ unitPrice: 600 })],
      offers: [freeDelivery],
      context: ctx({ maxTotalDiscountPercent: 0 }),
    });
    expect(r.shipping?.offerId).toBe("ship");
  });

  it("respects its own trigger", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 400 })],
      offers: [freeDelivery],
      context: ctx(),
    });
    expect(r.shipping).toBeNull();
    expect(r.skipped[0].reason).toBe("trigger_unmet");
  });

  it("nudges toward free delivery BY NAME — the reward's main use", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 400 })],
      offers: [freeDelivery],
      context: ctx(),
    });
    expect(r.nearMiss[0]).toMatchObject({
      kind: "spend",
      gap: 100,
      rewardType: "free_shipping",
    });
  });

  it("picks ONE when two qualify, and records the other as skipped", () => {
    // Every waiver is identical, so there is nothing to compare on value:
    // candidate order decides, and the loser is recorded rather than silent.
    const r = applyOffers({
      lines: [line({ unitPrice: 600 })],
      offers: [
        { ...freeDelivery, id: "a", priority: 1 },
        { ...freeDelivery, id: "b", priority: 5 },
      ],
      context: ctx(),
    });
    expect(r.shipping?.offerId).toBe("b");
    expect(r.skipped).toContainEqual({ offerId: "a", reason: "outscored" });
  });

  it("★ a shipping offer that wins is never reported as outscored", () => {
    // It never entered the merchandise comparison; saying it lost there would
    // tell an operator the wrong reason on the screen that answers "why?".
    const r = applyOffers({
      lines: [line({ unitPrice: 600 })],
      offers: [
        freeDelivery,
        offer({ id: "pct", reward: { type: "percent_off", percent: 10 } }),
      ],
      context: ctx(),
    });
    expect(r.skipped.some((s) => s.offerId === "ship")).toBe(false);
  });

  it("waives nothing on an empty cart", () => {
    const r = applyOffers({
      lines: [],
      offers: [freeDelivery],
      context: ctx(),
    });
    expect(r.shipping).toBeNull();
  });
});

describe("applyOffers — a free gift", () => {
  const GIFT = "11111111-1111-4111-8111-111111111111";
  const tumbler = offer({
    id: "gift",
    trigger: { type: "min_subtotal", minSubtotal: 2000 },
    reward: { type: "free_item", giftProductId: GIFT, giftQuantity: 1 },
    giftAvailable: true,
  });

  it("names the gift without discounting anything", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 2500 })],
      offers: [tumbler],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
    expect(r.gift).toEqual({
      offerId: "gift",
      offerName: "Test offer",
      code: null,
      productId: GIFT,
      variantId: null,
      quantity: 1,
    });
  });

  it("★ applies ALONGSIDE a discount, not instead of one", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 2500 })],
      offers: [
        tumbler,
        offer({ id: "pct", reward: { type: "percent_off", percent: 10 } }),
      ],
      context: ctx(),
    });
    expect(r.discount).toBe(250);
    expect(r.gift?.offerId).toBe("gift");
  });

  it("★★ STOPS OFFERING a gift with no stock, rather than failing at reserve time", () => {
    // Promising it and failing later is the worst outcome available: the
    // shopper has been told they are getting a tumbler, and the failure
    // arrives after they commit.
    const r = applyOffers({
      lines: [line({ unitPrice: 2500 })],
      offers: [{ ...tumbler, giftAvailable: false }],
      context: ctx(),
    });
    expect(r.gift).toBeNull();
    expect(r.skipped).toEqual([
      { offerId: "gift", reason: "gift_unavailable" },
    ]);
  });

  it("★ treats UNCHECKED availability as available, not as unavailable", () => {
    // A caller that does not resolve gifts — a historical replay, a cached
    // register catalogue — must not have every gift offer silently vanish.
    // Only an explicit false withdraws it.
    // Deleted rather than destructured away: an unused `_omit` binding is a
    // lint warning here, and `delete` states the intent — the field is ABSENT,
    // which is what "unchecked" means. `giftAvailable` is optional, so this is
    // type-safe.
    const unchecked = { ...tumbler };
    delete unchecked.giftAvailable;
    const r = applyOffers({
      lines: [line({ unitPrice: 2500 })],
      offers: [unchecked],
      context: ctx(),
    });
    expect(r.gift?.offerId).toBe("gift");
  });

  it("refuses a gift offer that names no product", () => {
    // Only reachable by direct SQL, and running it as "no gift" would make the
    // offer look applied while handing over nothing.
    const r = applyOffers({
      lines: [line({ unitPrice: 2500 })],
      offers: [{ ...tumbler, reward: { type: "free_item", giftQuantity: 1 } }],
      context: ctx(),
    });
    expect(r.gift).toBeNull();
    expect(r.skipped[0].reason).toBe("gift_unavailable");
  });

  it("respects its own trigger and nudges toward it", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 1900 })],
      offers: [tumbler],
      context: ctx(),
    });
    expect(r.gift).toBeNull();
    expect(r.nearMiss[0]).toMatchObject({ gap: 100, rewardType: "free_item" });
  });

  it("gives ONE gift when two offers qualify, and records the loser", () => {
    // Each gift is real stock going out of the door, so two would need a rule
    // for which comes first that a merchant could not predict.
    const r = applyOffers({
      lines: [line({ unitPrice: 2500 })],
      offers: [
        { ...tumbler, id: "a", priority: 1 },
        { ...tumbler, id: "b", priority: 9 },
      ],
      context: ctx(),
    });
    expect(r.gift?.offerId).toBe("b");
    expect(r.skipped).toContainEqual({ offerId: "a", reason: "outscored" });
  });

  it("★ a gift that wins is never reported as outscored by a merchandise offer", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 2500 })],
      offers: [
        tumbler,
        offer({ id: "pct", reward: { type: "percent_off", percent: 10 } }),
      ],
      context: ctx(),
    });
    expect(r.skipped.some((s) => s.offerId === "gift")).toBe(false);
  });

  it("carries a specific variant through", () => {
    const VAR = "22222222-2222-4222-8222-222222222222";
    const r = applyOffers({
      lines: [line({ unitPrice: 2500 })],
      offers: [
        {
          ...tumbler,
          reward: {
            type: "free_item",
            giftProductId: GIFT,
            giftVariantId: VAR,
            giftQuantity: 2,
          },
        },
      ],
      context: ctx(),
    });
    expect(r.gift).toMatchObject({ variantId: VAR, quantity: 2 });
  });
});

describe("applyOffers — bundles", () => {
  const bundle = offer({
    id: "b3",
    productIds: ["p1", "p2"],
    reward: { type: "bundle_price", bundleQuantity: 3, bundlePrice: 999 },
  });

  it("prices three qualifying units at the bundle price", () => {
    const r = applyOffers({
      lines: [line({ quantity: 3, unitPrice: 500 })],
      offers: [bundle],
      context: ctx(),
    });
    // 1500 of goods for 999 → 501 off.
    expect(r.discount).toBe(501);
  });

  it("counts units ACROSS the scoped lines", () => {
    const r = applyOffers({
      lines: [
        line({ id: "a", productId: "p1", quantity: 2, unitPrice: 500 }),
        line({ id: "b", productId: "p2", quantity: 1, unitPrice: 500 }),
      ],
      offers: [bundle],
      context: ctx(),
    });
    expect(r.discount).toBe(501);
  });

  it("★★ puts the DEAREST units in the bundle, which is the only way that cannot mark up", () => {
    // ₹500 + ₹400 + ₹300 + ₹200 with "any 3 for ₹999": bundling the three
    // dearest charges ₹999 for ₹1,200 of goods and leaves the ₹200 at full
    // price. Bundling the three CHEAPEST would charge ₹999 for ₹900 — a
    // mark-up on an offer advertised as a saving.
    const r = applyOffers({
      lines: [
        line({ id: "a", productId: "p1", quantity: 1, unitPrice: 500 }),
        line({ id: "b", productId: "p1", quantity: 1, unitPrice: 400 }),
        line({ id: "c", productId: "p2", quantity: 1, unitPrice: 300 }),
        line({ id: "d", productId: "p2", quantity: 1, unitPrice: 200 }),
      ],
      offers: [bundle],
      context: ctx(),
    });
    expect(r.subtotal).toBe(1400);
    expect(r.discount).toBe(201); // 1200 − 999
    // The ₹200 unit is untouched: it was not in the bundle.
    expect(r.lines.find((l) => l.id === "d")?.offerDiscount).toBe(0);
  });

  it("★ NEVER MARKS UP — a set worth less than the bundle price is skipped", () => {
    const r = applyOffers({
      lines: [line({ quantity: 3, unitPrice: 100 })],
      offers: [bundle],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
  });

  it("needs a full bundle", () => {
    const r = applyOffers({
      lines: [line({ quantity: 2, unitPrice: 500 })],
      offers: [bundle],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
  });

  it("repeats, and honours a set cap", () => {
    const six = [line({ quantity: 6, unitPrice: 500 })];
    expect(
      applyOffers({ lines: six, offers: [bundle], context: ctx() }).discount,
    ).toBe(1002);
    expect(
      applyOffers({
        lines: six,
        offers: [
          {
            ...bundle,
            reward: { ...bundle.reward, maxSets: 1 },
          },
        ],
        context: ctx(),
      }).discount,
    ).toBe(501);
  });

  it("ignores units outside its scope", () => {
    const r = applyOffers({
      lines: [
        line({ id: "in", productId: "p1", quantity: 2, unitPrice: 500 }),
        line({ id: "out", productId: "zzz", quantity: 2, unitPrice: 500 }),
      ],
      offers: [bundle],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
  });

  it("respects a budget", () => {
    const r = applyOffers({
      lines: [line({ quantity: 3, unitPrice: 500 })],
      offers: [{ ...bundle, remainingBudget: 200 }],
      context: ctx(),
    });
    expect(r.discount).toBe(200);
  });
});

describe("applyOffers — cashback", () => {
  const cashback = offer({
    id: "cb",
    trigger: { type: "min_subtotal", minSubtotal: 2000 },
    reward: { type: "credit_back", creditAmount: 100 },
  });

  it("★★ changes NOTHING about what the customer pays", () => {
    // Credit is a payment in this system, so netting cashback off the total
    // would understate the sale and mis-compute GST on it.
    const r = applyOffers({
      lines: [line({ unitPrice: 2500 })],
      offers: [cashback],
      context: ctx(),
    });
    expect(r.discount).toBe(0);
    expect(r.lines[0].offerDiscount).toBe(0);
    expect(r.credit).toEqual({
      offerId: "cb",
      offerName: "Test offer",
      code: null,
      amount: 100,
    });
  });

  it("applies alongside a discount", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 2500 })],
      offers: [
        cashback,
        offer({ id: "pct", reward: { type: "percent_off", percent: 10 } }),
      ],
      context: ctx(),
    });
    expect(r.discount).toBe(250);
    expect(r.credit?.amount).toBe(100);
  });

  it("respects its trigger", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 1000 })],
      offers: [cashback],
      context: ctx(),
    });
    expect(r.credit).toBeNull();
  });

  it("issues ONE, and records the loser", () => {
    const r = applyOffers({
      lines: [line({ unitPrice: 2500 })],
      offers: [
        { ...cashback, id: "a", priority: 1 },
        { ...cashback, id: "b", priority: 7 },
      ],
      context: ctx(),
    });
    expect(r.credit?.offerId).toBe("b");
    expect(r.skipped).toContainEqual({ offerId: "a", reason: "outscored" });
  });
});

describe("near miss respects the merchant's set cap", () => {
  // ★★ IT DID NOT, AND THE NUDGE LIED ON THE COMMONEST OFFER THERE IS. With
  // "buy 1 get 1 free, max 1 set per order", a cart of three was told "add 1
  // more and one is free" — and the fourth item earned nothing, because the
  // one set the merchant allowed was already spent. A nudge is a promise about
  // what happens if you add something; this one is made after the shopper has
  // put the item in the basket, so getting it wrong is expensive.
  const b1g1 = (maxSets?: number) =>
    offer({
      id: "b1g1",
      reward: {
        type: "buy_x_get_y",
        buyQuantity: 1,
        getQuantity: 1,
        getPercent: 100,
        maxSets,
      },
      productIds: ["p1"],
    });

  const cartOf = (quantity: number) => [
    {
      id: "l1",
      productId: "p1",
      variantId: null,
      categoryId: null,
      quantity,
      unitPrice: 70,
    },
  ];

  it("nudges an incomplete first set", () => {
    const r = applyOffers({
      lines: cartOf(1),
      offers: [b1g1(1)],
      context: ctx(),
    });
    expect(r.nearMiss).toHaveLength(1);
    expect(r.nearMiss[0]).toMatchObject({ kind: "units", gap: 1 });
  });

  it("goes quiet once the cap is reached, because a further set earns nothing", () => {
    const capped = applyOffers({
      lines: cartOf(3),
      offers: [b1g1(1)],
      context: ctx(),
    });
    expect(capped.nearMiss).toEqual([]);
    // And the engine agrees: a fourth item buys no more discount.
    const three = applyOffers({
      lines: cartOf(3),
      offers: [b1g1(1)],
      context: ctx(),
    });
    const four = applyOffers({
      lines: cartOf(4),
      offers: [b1g1(1)],
      context: ctx(),
    });
    expect(four.discount).toBe(three.discount);
  });

  it("keeps nudging an uncapped offer, where the next set really is earned", () => {
    const r = applyOffers({
      lines: cartOf(3),
      offers: [b1g1()],
      context: ctx(),
    });
    expect(r.nearMiss).toHaveLength(1);
    const three = applyOffers({
      lines: cartOf(3),
      offers: [b1g1()],
      context: ctx(),
    });
    const four = applyOffers({
      lines: cartOf(4),
      offers: [b1g1()],
      context: ctx(),
    });
    expect(four.discount).toBeGreaterThan(three.discount);
  });
});

describe("a spend ladder is always worth saying", () => {
  // ★★ THE FLOOR BIT WHERE IT WAS LEAST WANTED. `max(₹500, subtotal)` is right
  // for a one-off threshold — a ₹100 basket does not want telling it is ₹4,900
  // short — but "spend more, save more" IS an invitation to spend, and the
  // ladder is the whole offer. On a 1,000 → 5% ladder a ₹490 basket saw
  // nothing (gap ₹510 against a ₹500 allowance) while ₹560 saw the bar: same
  // offer, one item apart, and the shopper further along was the one told.
  const ladder = () =>
    offer({
      id: "ladder",
      reward: {
        type: "tiered",
        tierMode: "percent",
        tiers: [
          { minSubtotal: 1000, value: 5 },
          { minSubtotal: 2500, value: 10 },
        ],
      },
    });

  const at = (subtotal: number) =>
    applyOffers({
      lines: [
        {
          id: "l1",
          productId: "p1",
          variantId: null,
          categoryId: null,
          quantity: 1,
          unitPrice: subtotal,
        },
      ],
      offers: [ladder()],
      context: ctx(),
    });

  it("nudges a basket that is further from the rung than the floor allows", () => {
    const r = at(490); // gap ₹510, old allowance ₹500 — silently hidden
    expect(r.nearMiss).toHaveLength(1);
    expect(r.nearMiss[0]).toMatchObject({
      kind: "spend",
      gap: 510,
      percent: 5,
    });
  });

  it("nudges a small basket a long way off, which is the point of a ladder", () => {
    expect(at(100).nearMiss[0]).toMatchObject({ gap: 900 });
  });

  it("still nudges the ones it always did", () => {
    expect(at(560).nearMiss[0]).toMatchObject({ gap: 440 });
  });

  // ★ THE EXEMPTION IS THE LADDER'S ALONE. A one-off threshold keeps the floor,
  // or every store with a "₹500 off over ₹5,000" offer starts telling empty
  // baskets how far they are from something they were not going to buy.
  it("leaves the floor in place for a one-off threshold", () => {
    const threshold = offer({
      id: "thresh",
      trigger: { type: "min_subtotal", minSubtotal: 1000 },
      reward: { type: "percent_off", percent: 10 },
    });
    const r = applyOffers({
      lines: [
        {
          id: "l1",
          productId: "p1",
          variantId: null,
          categoryId: null,
          quantity: 1,
          unitPrice: 490,
        },
      ],
      offers: [threshold],
      context: ctx(),
    });
    expect(r.nearMiss).toEqual([]);
  });
});
