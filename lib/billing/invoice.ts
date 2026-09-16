/**
 * Building an invoice: line items, tax, totals.
 *
 * PURE. Integer paise everywhere; no floats, no Date.now(), no DB. The caller
 * supplies prices and tax configuration, so the same function serves the
 * renewal worker, the upgrade path and the merchant-facing preview — and a
 * preview can never quote a total the charge then disagrees with (§22's
 * posTotals lesson, applied to billing).
 *
 * Design: docs/billing-architecture.md §5, §13.
 */

import { isIntraState, splitGstPaise, type GstSplitPaise } from "./gst";
import type { BillingPeriod } from "@/lib/plans/location-billing";

/** A line on an invoice. `kind` must explain itself (spec §13). */
export interface InvoiceLine {
  kind:
    | "base_plan"
    | "location"
    | "addon"
    | "proration"
    | "discount"
    | "tax"
    | "account_credit"
    | "ai_credits";
  description: string;
  quantity: number;
  unitAmountPaise: number;
  amountPaise: number;
}

/**
 * Tax configuration for one invoice, read from platform_billing_settings and
 * the merchant's billing account.
 */
export interface TaxContext {
  /** False until the platform has a GSTIN. Then tax is simply 0. */
  enabled: boolean;
  rateBps: number;
  /**
   * Do the listed plan prices already INCLUDE tax?
   *
   * ★ EXCLUSIVE (false, the default): ₹15,000 + 18% = ₹17,700 charged.
   * ★ INCLUSIVE (true): ₹15,000 charged, of which ₹2,288.14 is GST.
   *
   * Operator-configured (`platform_billing_settings.tax_inclusive`), because it
   * has to match what the pricing page advertises. It also decides whether
   * enabling GST later changes what merchants pay: under inclusive it does not,
   * under exclusive every bill rises 18% — which is why `mandateSizePaise`
   * provisions for tax only in exclusive mode.
   */
  inclusive: boolean;
  /** StoreMink's state. Null ⇒ treated as intra-state (gst.ts's default). */
  supplierStateCode: string | null;
  /** The merchant's state. */
  placeOfSupply: string | null;
}

export interface BuiltInvoice {
  lines: InvoiceLine[];
  subtotalPaise: number;
  discountPaise: number;
  taxPaise: number;
  totalPaise: number;
  /** Snapshotted onto the invoice: a later rate change must not rewrite it. */
  taxRateBps: number;
  gst: GstSplitPaise;
}

const paise = (n: number) => (Number.isFinite(n) ? Math.round(n) : 0);
const nonNeg = (n: number) => Math.max(0, paise(n));

/**
 * Tax on an already-discounted base.
 *
 * ★ Computed on (subtotal − discount), never on the gross. Half-up rounding,
 * which is the Indian GST convention, and applied ONCE to the whole taxable
 * value rather than per line — per-line rounding would make the parts disagree
 * with the total, and the total is what gets debited.
 */
export function taxOnPaise(taxablePaise: number, rateBps: number): number {
  const base = nonNeg(taxablePaise);
  const bps = nonNeg(rateBps);
  return Math.round((base * bps) / 10_000);
}

/**
 * The tax ALREADY CONTAINED in a tax-inclusive amount.
 *
 * ★ `gross × r / (1 + r)`, not `gross × r`. In basis points that is
 * `gross × bps / (10_000 + bps)` — ₹15,000 at 18% contains ₹2,288.14, not
 * ₹2,700. Getting this wrong under-declares output tax on every invoice.
 *
 * The caller derives the taxable value by SUBTRACTION (`gross − tax`) rather
 * than by a second division, so the two always re-sum to the gross exactly —
 * the same remainder trick `splitGstPaise` uses on the halves.
 */
export function taxWithinPaise(grossPaise: number, rateBps: number): number {
  const gross = nonNeg(grossPaise);
  const bps = nonNeg(rateBps);
  if (bps === 0) return 0;
  return Math.round((gross * bps) / (10_000 + bps));
}

function assemble(
  lines: InvoiceLine[],
  discountPaise: number,
  tax: TaxContext,
): BuiltInvoice {
  const listed = lines.reduce((n, l) => n + l.amountPaise, 0);
  const discount = Math.min(nonNeg(discountPaise), listed);
  const rateBps = tax.enabled ? nonNeg(tax.rateBps) : 0;

  // ★ The two modes differ in WHAT MOVES. Exclusive raises the total and leaves
  // the taxable value alone; inclusive holds the total fixed and carves the tax
  // out of it. Both must satisfy `total = subtotal − discount + tax` exactly,
  // because that is a CHECK constraint, not a convention.
  const inclusive = tax.enabled && tax.inclusive;
  const taxPaise = !tax.enabled
    ? 0
    : inclusive
      ? taxWithinPaise(listed - discount, rateBps)
      : taxOnPaise(listed - discount, rateBps);

  // Exclusive: the listed amount IS the taxable value.
  // Inclusive: the taxable value is the listed amount less the tax inside it —
  // by subtraction, so subtotal + tax re-sums to the listed price exactly.
  const subtotalPaise = inclusive ? listed - taxPaise : listed;

  const withTax = [...lines];
  if (discount > 0) {
    withTax.push({
      kind: "discount",
      description: "Discount",
      quantity: 1,
      unitAmountPaise: -discount,
      amountPaise: -discount,
    });
  }
  if (taxPaise > 0) {
    withTax.push({
      kind: "tax",
      // Inclusive tax is not an extra charge, so the line says so — printing a
      // bare "GST ₹2,288.14" under a ₹15,000 total reads as ₹17,288.14 owed.
      description: inclusive
        ? `GST @ ${rateBps / 100}% (included)`
        : `GST @ ${rateBps / 100}%`,
      quantity: 1,
      unitAmountPaise: taxPaise,
      amountPaise: taxPaise,
    });
  }

  return {
    lines: withTax,
    subtotalPaise,
    discountPaise: discount,
    taxPaise,
    // Must satisfy the billing_invoices_total_adds_up CHECK exactly.
    // Exclusive → listed − discount + tax. Inclusive → listed − discount,
    // because subtotal already had the tax removed from it.
    totalPaise: subtotalPaise - discount + taxPaise,
    taxRateBps: rateBps,
    gst: splitGstPaise(
      taxPaise,
      isIntraState(tax.supplierStateCode, tax.placeOfSupply),
    ),
  };
}

export interface SubscriptionInvoiceInput {
  /** "Basic" / "Pro" — printed, so it comes from PLAN_META rather than the id. */
  planLabel: string;
  period: BillingPeriod;
  planPaise: number;
  /** Extra POS locations being billed. Omit or 0 for a plan with no POS. */
  locations?: { count: number; unitPaise: number };
  /** A mid-cycle upgrade's catch-up charge. See prorationPaise(). */
  proration?: { amountPaise: number; description?: string };
  discountPaise?: number;
  tax: TaxContext;
}

/**
 * The renewal (or upgrade) invoice for a subscription.
 *
 * ★ AI credits are NEVER a line here (spec §1). They are their own invoice
 * kind, so `buildAiCreditsInvoice` exists separately and nothing can
 * accidentally fold one into a subscription bill.
 *
 * ★ An account credit is NOT applied here either. Credit is a PAYMENT, not a
 * discount — §29's rule — so `totalPaise` stays the full value of what was
 * sold and the credit reduces what is COLLECTED (see amountDuePaise). Netting
 * it into the subtotal would understate the sale and compute GST on the wrong
 * base, which is the same mistake §29 documents for store credit on orders.
 */
export function buildSubscriptionInvoice(
  input: SubscriptionInvoiceInput,
): BuiltInvoice {
  const term = input.period === "yearly" ? "year" : "month";
  const lines: InvoiceLine[] = [
    {
      kind: "base_plan",
      description: `${input.planLabel} plan · 1 ${term}`,
      quantity: 1,
      unitAmountPaise: nonNeg(input.planPaise),
      amountPaise: nonNeg(input.planPaise),
    },
  ];

  const count = Math.max(0, Math.floor(input.locations?.count ?? 0));
  if (count > 0) {
    const unit = nonNeg(input.locations?.unitPaise ?? 0);
    lines.push({
      kind: "location",
      description: `Extra ${count === 1 ? "location" : "locations"} · ${count} × 1 ${term}`,
      quantity: count,
      unitAmountPaise: unit,
      amountPaise: unit * count,
    });
  }

  // Proration may be negative in principle; a downgrade never prorates in this
  // system (it waits for the cycle), so a negative here means a caller bug and
  // is clamped rather than silently issuing a credit note.
  const pro = nonNeg(input.proration?.amountPaise ?? 0);
  if (pro > 0) {
    lines.push({
      kind: "proration",
      description: input.proration?.description ?? "Plan change (part period)",
      quantity: 1,
      unitAmountPaise: pro,
      amountPaise: pro,
    });
  }

  return assemble(lines, input.discountPaise ?? 0, input.tax);
}

/** A one-time AI credit purchase — its own invoice, always (spec §1, §14). */
export function buildAiCreditsInvoice(input: {
  packLabel: string;
  credits: number;
  amountPaise: number;
  tax: TaxContext;
}): BuiltInvoice {
  return assemble(
    [
      {
        kind: "ai_credits",
        description: `Mink credits · ${input.packLabel} (${Math.max(0, Math.floor(input.credits))} credits)`,
        quantity: 1,
        unitAmountPaise: nonNeg(input.amountPaise),
        amountPaise: nonNeg(input.amountPaise),
      },
    ],
    0,
    input.tax,
  );
}

/**
 * A mid-cycle add-on — today, extra locations bought part way through a period.
 *
 * ★ ONE LINE, kind `addon`, and NO cycle_seq on the invoice that carries it. It
 * is a one-off document dated to the day it was paid, not a periodic one: a
 * merchant may buy a shop in January and another in February, and each is its own
 * receipt. The recurring cost then rides the next subscription invoice's
 * `location` line, so nothing is billed twice.
 */
export function buildAddonInvoice(input: {
  description: string;
  amountPaise: number;
  tax: TaxContext;
}): BuiltInvoice {
  return assemble(
    [
      {
        kind: "addon",
        description: input.description,
        quantity: 1,
        unitAmountPaise: nonNeg(input.amountPaise),
        amountPaise: nonNeg(input.amountPaise),
      },
    ],
    0,
    input.tax,
  );
}

/**
 * The catch-up charge for moving to a dearer plan mid-cycle.
 *
 * ★ Days are rounded to the NEAREST whole day, not up or down. Whole days
 * because that is what an invoice line can explain ("18 of 30 days"); nearest
 * because ceiling systematically overcharges and flooring systematically
 * undercharges, and neither is defensible as a default.
 *
 * Returns 0 when the target is not dearer — a downgrade waits for the cycle
 * boundary (§7), so there is nothing to prorate and nothing to refund.
 */
export function prorationPaise(input: {
  currentPeriodPaise: number;
  targetPeriodPaise: number;
  period: BillingPeriod;
  periodEnd: Date;
  now: Date;
  periodDays: number;
}): number {
  const delta =
    paise(input.targetPeriodPaise) - paise(input.currentPeriodPaise);
  if (delta <= 0) return 0;

  const dayMs = 24 * 60 * 60 * 1000;
  const remainingDays = Math.min(
    Math.max(
      0,
      Math.round((input.periodEnd.getTime() - input.now.getTime()) / dayMs),
    ),
    input.periodDays,
  );
  if (remainingDays === 0) return 0;

  return Math.round((delta * remainingDays) / input.periodDays);
}

/**
 * What must actually be collected: the invoice total less any account credit
 * already applied to it.
 *
 * ★ Never negative and never above the total. A credit larger than the invoice
 * leaves the remainder on the balance rather than producing a payable of −₹200,
 * which nothing downstream could charge.
 */
export function amountDuePaise(
  totalPaise: number,
  appliedCreditPaise: number,
): number {
  const total = nonNeg(totalPaise);
  return Math.max(0, total - Math.min(nonNeg(appliedCreditPaise), total));
}
