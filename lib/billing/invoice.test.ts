import { describe, expect, it } from "vitest";
import {
  amountDuePaise,
  buildAiCreditsInvoice,
  buildSubscriptionInvoice,
  prorationPaise,
  taxOnPaise,
  taxWithinPaise,
  type TaxContext,
} from "./invoice";
import { splitGstPaise } from "./gst";

const NO_TAX: TaxContext = {
  enabled: false,
  rateBps: 1800,
  inclusive: false,
  supplierStateCode: null,
  placeOfSupply: null,
};
// ★ NUMERIC GST state codes ("07" Delhi, "29" Karnataka) — normalizeStateCode
// rejects anything non-numeric, and a rejected code falls back to INTRA-state.
const GST_INTRA: TaxContext = {
  enabled: true,
  rateBps: 1800,
  inclusive: false,
  supplierStateCode: "07",
  placeOfSupply: "07",
};
/** Same rate, but the listed price already contains the tax. */
const GST_INCL: TaxContext = { ...GST_INTRA, inclusive: true };
const GST_INTER: TaxContext = {
  enabled: true,
  rateBps: 1800,
  inclusive: false,
  supplierStateCode: "07",
  placeOfSupply: "29",
};

describe("splitGstPaise", () => {
  it("halves intra-state tax and re-sums exactly", () => {
    const s = splitGstPaise(17_700_00 - 15_000_00, true);
    expect(s.cgstPaise + s.sgstPaise).toBe(2_700_00);
    expect(s.igstPaise).toBe(0);
    expect(s.intraState).toBe(true);
  });

  it("★ gives sgst the odd paise, so the halves always re-sum", () => {
    const s = splitGstPaise(5, true);
    expect([s.cgstPaise, s.sgstPaise]).toEqual([2, 3]);
    expect(s.cgstPaise + s.sgstPaise).toBe(5);
  });

  it("puts everything in IGST inter-state", () => {
    const s = splitGstPaise(2_700_00, false);
    expect(s).toEqual({
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 2_700_00,
      intraState: false,
    });
  });

  it("never returns negative tax", () => {
    expect(splitGstPaise(-500, true).cgstPaise).toBe(0);
  });
});

describe("taxOnPaise", () => {
  it("is 18% of the taxable base, half-up", () => {
    expect(taxOnPaise(15_000_00, 1800)).toBe(2_700_00);
    expect(taxOnPaise(1_500_00, 1800)).toBe(270_00);
  });

  it("rounds a fractional paise half-up", () => {
    // 1_00 paise (₹1) at 18% = 18 paise exactly; 3 paise at 18% = 0.54 → 1.
    expect(taxOnPaise(1_00, 1800)).toBe(18);
    expect(taxOnPaise(3, 1800)).toBe(1);
  });

  it("is zero at a zero rate or base", () => {
    expect(taxOnPaise(15_000_00, 0)).toBe(0);
    expect(taxOnPaise(0, 1800)).toBe(0);
  });
});

describe("buildSubscriptionInvoice", () => {
  it("bills the bare plan with no tax while GST is off", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Basic",
      period: "yearly",
      planPaise: 15_000_00,
      tax: NO_TAX,
    });
    expect(inv.subtotalPaise).toBe(15_000_00);
    expect(inv.taxPaise).toBe(0);
    expect(inv.totalPaise).toBe(15_000_00);
    expect(inv.taxRateBps).toBe(0);
    expect(inv.lines).toHaveLength(1);
    expect(inv.lines[0].kind).toBe("base_plan");
    expect(inv.lines[0].description).toBe("Basic plan · 1 year");
  });

  it("★ Basic yearly becomes ₹17,700 once GST is on", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Basic",
      period: "yearly",
      planPaise: 15_000_00,
      tax: GST_INTRA,
    });
    expect(inv.totalPaise).toBe(17_700_00);
    expect(inv.taxPaise).toBe(2_700_00);
    expect(inv.gst.cgstPaise + inv.gst.sgstPaise).toBe(2_700_00);
  });

  it("splits inter-state tax as IGST", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      tax: GST_INTER,
    });
    expect(inv.gst.igstPaise).toBe(900_00);
    expect(inv.gst.cgstPaise).toBe(0);
  });

  it("bills extra locations as their own line", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      locations: { count: 3, unitPaise: 1_000_00 },
      tax: NO_TAX,
    });
    const loc = inv.lines.find((l) => l.kind === "location");
    expect(loc?.quantity).toBe(3);
    expect(loc?.amountPaise).toBe(3_000_00);
    expect(inv.totalPaise).toBe(8_000_00);
  });

  it("omits the location line at zero, and singularises at one", () => {
    expect(
      buildSubscriptionInvoice({
        planLabel: "Pro",
        period: "monthly",
        planPaise: 5_000_00,
        locations: { count: 0, unitPaise: 1_000_00 },
        tax: NO_TAX,
      }).lines.some((l) => l.kind === "location"),
    ).toBe(false);

    expect(
      buildSubscriptionInvoice({
        planLabel: "Pro",
        period: "monthly",
        planPaise: 5_000_00,
        locations: { count: 1, unitPaise: 1_000_00 },
        tax: NO_TAX,
      }).lines.find((l) => l.kind === "location")?.description,
    ).toContain("Extra location");
  });

  it("taxes AFTER the discount, never the gross", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      discountPaise: 1_000_00,
      tax: GST_INTRA,
    });
    expect(inv.discountPaise).toBe(1_000_00);
    expect(inv.taxPaise).toBe(720_00); // 18% of 4,000, not of 5,000
    expect(inv.totalPaise).toBe(4_720_00);
  });

  it("shows the discount as a NEGATIVE line", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      discountPaise: 1_000_00,
      tax: NO_TAX,
    });
    expect(inv.lines.find((l) => l.kind === "discount")?.amountPaise).toBe(
      -1_000_00,
    );
  });

  it("caps a discount at the subtotal rather than going negative", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Basic",
      period: "monthly",
      planPaise: 1_500_00,
      discountPaise: 9_999_00,
      tax: GST_INTRA,
    });
    expect(inv.discountPaise).toBe(1_500_00);
    expect(inv.totalPaise).toBe(0);
  });

  it("clamps a negative proration instead of issuing a silent credit", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      proration: { amountPaise: -2_000_00 },
      tax: NO_TAX,
    });
    expect(inv.lines.some((l) => l.kind === "proration")).toBe(false);
    expect(inv.totalPaise).toBe(5_000_00);
  });

  it("★ always satisfies the billing_invoices_total_adds_up CHECK", () => {
    for (const tax of [NO_TAX, GST_INTRA, GST_INTER]) {
      for (const discount of [0, 1, 777_77, 1_500_00]) {
        const inv = buildSubscriptionInvoice({
          planLabel: "Pro",
          period: "monthly",
          planPaise: 5_000_00,
          locations: { count: 2, unitPaise: 1_000_00 },
          proration: { amountPaise: 333_33 },
          discountPaise: discount,
          tax,
        });
        expect(inv.totalPaise).toBe(
          inv.subtotalPaise - inv.discountPaise + inv.taxPaise,
        );
        expect(Number.isInteger(inv.totalPaise)).toBe(true);
      }
    }
  });

  it("★ never emits an ai_credits line on a subscription invoice", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      locations: { count: 2, unitPaise: 1_000_00 },
      proration: { amountPaise: 100 },
      tax: GST_INTRA,
    });
    expect(inv.lines.some((l) => l.kind === "ai_credits")).toBe(false);
  });

  it("★ never emits an account_credit line — credit is a payment, not a discount", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      tax: GST_INTRA,
    });
    expect(inv.lines.some((l) => l.kind === "account_credit")).toBe(false);
  });
});

// ★★ This is the hazard, pinned so nobody has to rediscover it. A non-numeric
// or missing state code is rejected by normalizeStateCode, and isIntraState then
// falls back to INTRA-state — correct for a POS walk-in, WRONG for platform
// billing, where supplier and merchant are usually in different states. The
// real guard is the DB CHECK on both state_code columns (billing_01); these
// tests document what happens if a bad value ever reaches this layer.
describe("★★ state-code format is load-bearing", () => {
  const inter = (supplier: string | null, place: string | null) =>
    buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      tax: {
        enabled: true,
        rateBps: 1800,
        inclusive: false,
        supplierStateCode: supplier,
        placeOfSupply: place,
      },
    }).gst;

  it("splits IGST for a genuine inter-state pair", () => {
    expect(inter("07", "29")).toMatchObject({
      igstPaise: 900_00,
      cgstPaise: 0,
      intraState: false,
    });
  });

  it("accepts an unpadded numeric code", () => {
    expect(inter("7", "07").intraState).toBe(true);
    expect(inter("7", "29").intraState).toBe(false);
  });

  it("★ a two-LETTER code silently becomes intra-state — the wrong tax", () => {
    expect(inter("DL", "KA").intraState).toBe(true);
    expect(inter("DL", "KA").igstPaise).toBe(0);
  });

  it("★ a missing code silently becomes intra-state", () => {
    expect(inter(null, "29").intraState).toBe(true);
    expect(inter("07", null).intraState).toBe(true);
  });

  it("charges the same TOTAL either way — only the split differs", () => {
    const a = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      tax: GST_INTRA,
    });
    const b = buildSubscriptionInvoice({
      planLabel: "Pro",
      period: "monthly",
      planPaise: 5_000_00,
      tax: GST_INTER,
    });
    expect(a.totalPaise).toBe(b.totalPaise);
    expect(a.gst.cgstPaise + a.gst.sgstPaise).toBe(b.gst.igstPaise);
  });
});

describe("taxWithinPaise (inclusive)", () => {
  it("★ carves out gross×r/(1+r), NOT gross×r", () => {
    // ₹15,000 inclusive at 18% contains ₹2,288.14 — not the ₹2,700 that
    // exclusive would ADD. Getting this wrong under-declares output tax.
    expect(taxWithinPaise(15_000_00, 1800)).toBe(2_288_14);
    expect(taxWithinPaise(15_000_00, 1800)).not.toBe(
      taxOnPaise(15_000_00, 1800),
    );
  });

  it("is zero at a zero rate or gross", () => {
    expect(taxWithinPaise(15_000_00, 0)).toBe(0);
    expect(taxWithinPaise(0, 1800)).toBe(0);
  });

  it("★ round-trips: gross − taxWithin, re-taxed exclusively, returns the gross", () => {
    for (const gross of [1_500_00, 5_000_00, 15_000_00, 50_000_00, 129_00, 7]) {
      const inside = taxWithinPaise(gross, 1800);
      const taxable = gross - inside;
      // Allow the single-paise rounding slack the two roundings can produce.
      expect(
        Math.abs(taxable + taxOnPaise(taxable, 1800) - gross),
      ).toBeLessThanOrEqual(1);
    }
  });
});

describe("★ inclusive vs exclusive tax mode", () => {
  const basicYearly = (tax: TaxContext) =>
    buildSubscriptionInvoice({
      planLabel: "Basic",
      period: "yearly",
      planPaise: 15_000_00,
      tax,
    });

  it("★ inclusive holds the total at the listed price", () => {
    const inv = basicYearly(GST_INCL);
    expect(inv.totalPaise).toBe(15_000_00);
    expect(inv.taxPaise).toBe(2_288_14);
    expect(inv.subtotalPaise).toBe(12_711_86);
  });

  it("★ exclusive raises the total above the listed price", () => {
    const inv = basicYearly(GST_INTRA);
    expect(inv.totalPaise).toBe(17_700_00);
    expect(inv.taxPaise).toBe(2_700_00);
    expect(inv.subtotalPaise).toBe(15_000_00);
  });

  it("★ subtotal + tax re-sums to the listed price exactly under inclusive", () => {
    for (const p of [
      1_500_00, 5_000_00, 15_000_00, 50_000_00, 1, 7, 12_345_67,
    ]) {
      const inv = buildSubscriptionInvoice({
        planLabel: "X",
        period: "monthly",
        planPaise: p,
        tax: GST_INCL,
      });
      expect(inv.subtotalPaise + inv.taxPaise).toBe(p);
      expect(inv.totalPaise).toBe(p);
    }
  });

  it("★ enabling GST changes nothing under inclusive, and +18% under exclusive", () => {
    const off = basicYearly(NO_TAX).totalPaise;
    expect(basicYearly(GST_INCL).totalPaise).toBe(off);
    expect(basicYearly(GST_INTRA).totalPaise).toBeGreaterThan(off);
  });

  it("still satisfies total_adds_up in inclusive mode, with a discount", () => {
    for (const discount of [0, 1, 777_77, 1_500_00]) {
      const inv = buildSubscriptionInvoice({
        planLabel: "Pro",
        period: "monthly",
        planPaise: 5_000_00,
        locations: { count: 2, unitPaise: 1_000_00 },
        discountPaise: discount,
        tax: GST_INCL,
      });
      expect(inv.totalPaise).toBe(
        inv.subtotalPaise - inv.discountPaise + inv.taxPaise,
      );
      // Inclusive: the merchant pays the listed price less any discount.
      expect(inv.totalPaise).toBe(7_000_00 - Math.min(discount, 7_000_00));
    }
  });

  it("labels an inclusive tax line as included, so it can't read as an extra charge", () => {
    expect(
      basicYearly(GST_INCL).lines.find((l) => l.kind === "tax")?.description,
    ).toBe("GST @ 18% (included)");
    expect(
      basicYearly(GST_INTRA).lines.find((l) => l.kind === "tax")?.description,
    ).toBe("GST @ 18%");
  });

  it("splits an inclusive tax the same way as an exclusive one", () => {
    const inv = buildSubscriptionInvoice({
      planLabel: "Basic",
      period: "yearly",
      planPaise: 15_000_00,
      tax: { ...GST_INCL, placeOfSupply: "29" },
    });
    expect(inv.gst.igstPaise).toBe(2_288_14);
    expect(inv.gst.cgstPaise).toBe(0);
  });

  it("applies to AI credit invoices too", () => {
    const incl = buildAiCreditsInvoice({
      packLabel: "Popular",
      credits: 60,
      amountPaise: 129_00,
      tax: GST_INCL,
    });
    expect(incl.totalPaise).toBe(129_00);
    expect(incl.subtotalPaise + incl.taxPaise).toBe(129_00);
  });
});

describe("buildAiCreditsInvoice", () => {
  it("is its own document and carries only a credits line", () => {
    const inv = buildAiCreditsInvoice({
      packLabel: "Popular",
      credits: 60,
      amountPaise: 129_00,
      tax: GST_INTRA,
    });
    expect(inv.lines.filter((l) => l.kind === "ai_credits")).toHaveLength(1);
    expect(inv.lines.some((l) => l.kind === "base_plan")).toBe(false);
    expect(inv.subtotalPaise).toBe(129_00);
    expect(inv.taxPaise).toBe(2322); // 18% of ₹129 = ₹23.22
    expect(inv.totalPaise).toBe(129_00 + 2322);
  });

  it("names the pack and the credit count", () => {
    expect(
      buildAiCreditsInvoice({
        packLabel: "Bulk",
        credits: 150,
        amountPaise: 299_00,
        tax: NO_TAX,
      }).lines[0].description,
    ).toBe("Mink credits · Bulk (150 credits)");
  });
});

describe("prorationPaise", () => {
  const base = {
    period: "monthly" as const,
    periodDays: 30,
    periodEnd: new Date("2026-09-01T00:00:00.000Z"),
  };

  it("charges the difference for the days remaining", () => {
    // 15 of 30 days left, ₹5,000 − ₹1,500 = ₹3,500 → ₹1,750.
    expect(
      prorationPaise({
        ...base,
        currentPeriodPaise: 1_500_00,
        targetPeriodPaise: 5_000_00,
        now: new Date("2026-08-17T00:00:00.000Z"),
      }),
    ).toBe(1_750_00);
  });

  it("★ returns 0 for a downgrade — it waits for the cycle boundary", () => {
    expect(
      prorationPaise({
        ...base,
        currentPeriodPaise: 5_000_00,
        targetPeriodPaise: 1_500_00,
        now: new Date("2026-08-17T00:00:00.000Z"),
      }),
    ).toBe(0);
  });

  it("returns 0 for a same-price move", () => {
    expect(
      prorationPaise({
        ...base,
        currentPeriodPaise: 5_000_00,
        targetPeriodPaise: 5_000_00,
        now: new Date("2026-08-17T00:00:00.000Z"),
      }),
    ).toBe(0);
  });

  it("charges the full difference at the very start of a cycle", () => {
    expect(
      prorationPaise({
        ...base,
        currentPeriodPaise: 1_500_00,
        targetPeriodPaise: 5_000_00,
        now: new Date("2026-08-02T00:00:00.000Z"),
      }),
    ).toBe(3_500_00);
  });

  it("charges nothing once the cycle has ended", () => {
    expect(
      prorationPaise({
        ...base,
        currentPeriodPaise: 1_500_00,
        targetPeriodPaise: 5_000_00,
        now: new Date("2026-09-05T00:00:00.000Z"),
      }),
    ).toBe(0);
  });

  it("never exceeds the full difference, even on a corrupt period_end", () => {
    expect(
      prorationPaise({
        ...base,
        periodEnd: new Date("2027-09-01T00:00:00.000Z"),
        currentPeriodPaise: 1_500_00,
        targetPeriodPaise: 5_000_00,
        now: new Date("2026-08-02T00:00:00.000Z"),
      }),
    ).toBe(3_500_00);
  });

  it("returns whole paise", () => {
    const n = prorationPaise({
      ...base,
      currentPeriodPaise: 1_500_00,
      targetPeriodPaise: 5_000_01,
      now: new Date("2026-08-18T13:00:00.000Z"),
    });
    expect(Number.isInteger(n)).toBe(true);
  });
});

describe("amountDuePaise", () => {
  it("subtracts applied credit from the total", () => {
    expect(amountDuePaise(17_700_00, 5_000_00)).toBe(12_700_00);
  });

  it("★ never goes negative when credit exceeds the invoice", () => {
    expect(amountDuePaise(1_500_00, 9_999_00)).toBe(0);
  });

  it("is the full total with no credit", () => {
    expect(amountDuePaise(17_700_00, 0)).toBe(17_700_00);
  });

  it("ignores a negative credit rather than inflating the bill", () => {
    expect(amountDuePaise(1_500_00, -1_000_00)).toBe(1_500_00);
  });
});
