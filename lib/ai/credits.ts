// ---------------------------------------------------------------------------
// Mink credit packs — the client-safe shape and the bounds a pack must satisfy.
//
// ★ THE CATALOGUE ITSELF LIVES IN THE DATABASE (`mink_credit_packs`, migration
// 0116) and is owned by a platform operator: name, size, price, which pack is
// highlighted and the order are all editable, and packs can be added or
// removed. This module holds no pack list — a hardcoded fallback would be
// worse than none, because it would quote sizes and prices an operator has
// since changed. lib/ai/credit-pricing.ts is the reader.
//
// Credits are per-store top-ups that never expire; the plan's included
// allowance is always consumed first (lib/ai/quota.ts). Purchases settle to the
// PLATFORM's Razorpay account, never the merchant's.
//
// Pure on purpose: client components share this shape, so nothing here may
// import database code.
// ---------------------------------------------------------------------------

export interface CreditPack {
  /** Stable id, carried onto `ai_credit_purchases.pack_id` for history. */
  id: string;
  name: string;
  credits: number;
  priceInr: number;
  /** At most one pack platform-wide; a partial unique index enforces it. */
  popular?: boolean;
}

/** Mirrors the CHECK constraints in migration 0116, so the form, the save
 *  action and the database agree on what a pack may be. */
export const CREDIT_PACK_LIMITS = {
  nameMaxLength: 40,
  minCredits: 1,
  maxCredits: 1_000_000,
  minPriceInr: 1,
  maxPriceInr: 500_000,
  /** A ceiling on the catalogue itself: the merchant picks from these cards,
   *  and a list nobody can compare at a glance is not a price list. */
  maxPacks: 12,
} as const;

export interface CreditPackProblem {
  index: number;
  message: string;
}

/**
 * Validate a whole proposed catalogue. PURE, so the operator form and the
 * server action apply one rule set — a form that accepts what the action then
 * refuses is the failure §23 keeps flagging.
 */
export function validateCreditPacks(
  packs: readonly Partial<CreditPack>[],
): CreditPackProblem[] {
  const problems: CreditPackProblem[] = [];
  if (packs.length === 0) {
    // A store with no packs cannot top up at all once its allowance is spent.
    return [{ index: -1, message: "Keep at least one credit pack." }];
  }
  if (packs.length > CREDIT_PACK_LIMITS.maxPacks) {
    return [
      {
        index: -1,
        message: `At most ${CREDIT_PACK_LIMITS.maxPacks} credit packs.`,
      },
    ];
  }
  const seen = new Set<string>();
  packs.forEach((pack, index) => {
    const name = (pack.name ?? "").trim();
    if (!name || name.length > CREDIT_PACK_LIMITS.nameMaxLength) {
      problems.push({
        index,
        message: `Name must be 1–${CREDIT_PACK_LIMITS.nameMaxLength} characters.`,
      });
    }
    if (
      !Number.isInteger(pack.credits) ||
      (pack.credits ?? 0) < CREDIT_PACK_LIMITS.minCredits ||
      (pack.credits ?? 0) > CREDIT_PACK_LIMITS.maxCredits
    ) {
      problems.push({
        index,
        message: `Credits must be a whole number between ${CREDIT_PACK_LIMITS.minCredits} and ${CREDIT_PACK_LIMITS.maxCredits}.`,
      });
    }
    if (
      !Number.isInteger(pack.priceInr) ||
      (pack.priceInr ?? 0) < CREDIT_PACK_LIMITS.minPriceInr ||
      (pack.priceInr ?? 0) > CREDIT_PACK_LIMITS.maxPriceInr
    ) {
      problems.push({
        index,
        message: `Price must be a whole number between ₹${CREDIT_PACK_LIMITS.minPriceInr} and ₹${CREDIT_PACK_LIMITS.maxPriceInr}.`,
      });
    }
    const id = (pack.id ?? "").trim();
    if (!id) {
      problems.push({ index, message: "Pack is missing its id." });
    } else if (seen.has(id)) {
      // Two rows with one id would silently collapse into a single upsert and
      // quietly drop a pack the operator thinks they just saved.
      problems.push({ index, message: "Duplicate pack id." });
    }
    if (id) seen.add(id);
  });
  const popular = packs.filter((pack) => pack.popular).length;
  if (popular > 1) {
    problems.push({ index: -1, message: "Only one pack can be highlighted." });
  }
  return problems;
}
