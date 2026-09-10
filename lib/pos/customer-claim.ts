// ---------------------------------------------------------------------------
// Till-created customers, and how a real signup adopts one (roadmap Step 4).
//
// PURE. Everything here is a rule or a string; the DB work lives in the actions
// that call it, so the decisions can be tested without a database.
//
// ── The shape ──────────────────────────────────────────────────────────────
// A walk-in the till records gets a `users` row with a synthetic id and
// `claimed_at IS NULL`. When that same person signs up online with the same
// phone, the row is ADOPTED: its id becomes their Firebase uid. Their in-store
// history is theirs from the moment they create an account — which is the point
// of the feature, not a side effect of it.
// ---------------------------------------------------------------------------

import { parseStoredPhone } from "@/lib/phone";

/** Prefix marking a row the till invented rather than a signup creating. */
export const POS_CUSTOMER_PREFIX = "pos_";

/**
 * ★ AN UNCLAIMED ROW CAN NEVER LOG IN, AND NOTHING HAD TO BE BUILT FOR THAT.
 * Customer RLS is `auth.uid() = users.id`; a `pos_…` id matches no Firebase uid,
 * so these rows are invisible to every session. Do NOT add a policy for them —
 * the id shape is the mechanism.
 */
export function isPosCustomerId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(POS_CUSTOMER_PREFIX);
}

/** A new id for a till-created row. `crypto.randomUUID` is injected so this
 *  stays pure and testable. */
export function newPosCustomerId(uuid: () => string): string {
  return `${POS_CUSTOMER_PREFIX}${uuid()}`;
}

export interface ClaimCandidate {
  id: string;
  claimedAt: string | null;
}

export type ClaimDecision =
  | { action: "adopt"; posId: string }
  | { action: "attach"; existingId: string }
  | { action: "create" };

/**
 * What should happen when someone signs up with a phone that may already be on
 * a row for this store?
 *
 * ★ A COLLISION WITH A *CLAIMED* ROW IS NOT A CLAIM. If the matching row already
 * has an account behind it, that phone belongs to a real person — the signup
 * ATTACHES to it rather than adopting it. Adopting would hand one customer's
 * entire order history to whoever typed their number, which is the worst thing
 * this feature could do and the reason `claimed_at` exists at all.
 *
 * ★ AND THE ID SHAPE IS CHECKED TOO, not just `claimed_at`. A real signup row
 * also has `claimed_at IS NULL` (nothing backfills it — see the migration), so
 * treating NULL alone as "adoptable" would let a signup take over another
 * signup's row. Both conditions, always.
 */
export function decideClaim(existing: ClaimCandidate | null): ClaimDecision {
  if (!existing) return { action: "create" };
  if (isPosCustomerId(existing.id) && existing.claimedAt === null) {
    return { action: "adopt", posId: existing.id };
  }
  return { action: "attach", existingId: existing.id };
}

export interface PosCustomerInput {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

export type PosCustomerValidation =
  | { ok: true; name: string; phone: string; email: string | null }
  | { ok: false; error: string };

/**
 * What the till must have before it can invent a customer.
 *
 * ★ PHONE IS REQUIRED, EMAIL IS NOT — and that asymmetry is the whole claim
 * story. The phone is what a later signup matches on, so a row without one can
 * never be adopted and is just an orphan with a name on it. Email is a nicety
 * for a receipt.
 *
 * ★ A WALK-IN WITH NO DETAILS IS STILL A SALE. This validates a customer the
 * cashier chose to record; it must never become a precondition for ringing one
 * up (roadmap invariant 6).
 */
export function validatePosCustomer(
  input: PosCustomerInput,
): PosCustomerValidation {
  const name = (input.name ?? "").trim().slice(0, 80);
  const phone = normalizePhone(input.phone);
  const email = (input.email ?? "").trim().toLowerCase().slice(0, 160) || null;

  if (!name) return { ok: false, error: "Give the customer a name." };
  if (!phone) {
    return {
      ok: false,
      error: "A mobile number is needed so they can be found again later.",
    };
  }
  if (email && !email.includes("@")) {
    return { ok: false, error: "That email doesn't look right." };
  }
  return { ok: true, name, phone, email };
}

export type PosCheckoutDetails =
  | {
      ok: true;
      firstName: string;
      lastName: string | null;
      email: string | null;
    }
  | { ok: false; error: string };

/**
 * The details the till must put to a number it has just met.
 *
 * ★★ A FIRST NAME IS REQUIRED (owner's decision, 2026-09-11), which
 * DELIBERATELY OVERRIDES roadmap invariant 6 for the register — "a walk-in who
 * will not give their name is still a sale". The register used to record a
 * phone-only row instead of asking, and that is what filled merchants'
 * customer lists with anonymous "Customer" entries; the owner would rather the
 * counter always ask. The consequence is intended and worth stating: a new
 * number cannot be charged until it has a name.
 *
 * ★ ENFORCED HERE, NOT ONLY IN THE UI. The checkout disables its button until
 * a name is typed, but a disabled button is an affordance and this action is
 * reachable without it.
 *
 * ★ THE LAST NAME STAYS OPTIONAL. Plenty of customers give one name, and
 * `users.last_name` is nullable precisely for that; requiring it would refuse
 * a sale over a field the schema never wanted.
 *
 * ★ THE EMAIL STAYS OPTIONAL, but is CHECKED when given, because a typo there
 * is silent: it becomes the address a receipt is sent to, and nothing bounces
 * back to the cashier while the customer is still in the shop.
 */
export function validatePosCheckoutDetails(input: {
  firstName?: string;
  lastName?: string;
  email?: string;
}): PosCheckoutDetails {
  const firstName = (input.firstName ?? "").trim().slice(0, 60);
  const lastName = (input.lastName ?? "").trim().slice(0, 60) || null;
  const email = (input.email ?? "").trim().toLowerCase().slice(0, 160) || null;

  if (!firstName) {
    return { ok: false, error: "Enter the customer's first name." };
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: "That email doesn't look right." };
  }
  return { ok: true, firstName, lastName, email };
}

/**
 * A customer's number, reduced to the ONE shape `users.phone` stores: E.164.
 *
 * ★ IT MUST MATCH WHAT SIGNUP STORES, or the claim never fires. Someone whose
 * number the till took and who later signs up is the SAME person, and if the
 * two strings differ they get two rows and lose their history. That invariant
 * was written here from the start and was broken for months anyway, because
 * signup wrote Identity Platform's E.164 while this returned the bare ten
 * digits. E.164 is now canonical on both sides (owner's decision,
 * 2026-09-11), and `storedPhoneVariants` matches the legacy shape for rows
 * written before that.
 *
 * ★★ IT DELEGATES TO `parseStoredPhone` RATHER THAN REIMPLEMENTING IT. A
 * second copy would drift, and this one already had: it accepted repeated-digit
 * placeholders that its previous delegate rejected. ⚠ Note the reason for that
 * rejection was always the CARRIER's — Shiprocket cannot book 8888888888 —
 * which is a different question from who was at the counter, so recording one
 * is now allowed (owner's decision, 2026-09-11) while `normalizeIndianMobile`
 * still refuses it at the courier boundary.
 *
 * ⚠ The return type is "" rather than null because every caller feeds a NOT
 * NULL text column and a falsy check reads the same.
 */
export function normalizePhone(raw: unknown): string {
  return parseStoredPhone(raw)?.e164 ?? "";
}

/** Split a single typed name into the two columns `users` actually has. */
export function splitName(full: string): {
  first: string;
  last: string | null;
} {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: null };
  if (parts.length === 1) return { first: parts[0], last: null };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}
