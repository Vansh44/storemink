import "server-only";

import { and, eq, or } from "drizzle-orm";
import { cookies } from "next/headers";
import { withService } from "@/lib/db/client";
import { orders, users } from "@/drizzle/schema";
import { formatIndianMobile, textablePhone } from "@/lib/phone";
import type { PosOperator } from "@/lib/pos/operator";
import { signToken, verifyToken, type BaseClaims } from "@/lib/pos/session";

export type PosCustomerVerificationPurpose = "pickup" | "return";

export const POS_CUSTOMER_VERIFICATION_COOKIE = "pos_customer_verified";
export const POS_CUSTOMER_VERIFICATION_MAX_AGE_S = 30 * 60;

interface CustomerVerificationClaims extends BaseClaims {
  t: "customer_phone";
  purpose: PosCustomerVerificationPurpose;
  orderId: string;
  storeId: string;
  locationId: string;
  actor: string;
  phone: string;
}

function actorKey(op: PosOperator): string {
  return `${op.source}:${op.staffId ?? "owner"}:${op.name}`;
}

export function signCustomerVerification(input: {
  purpose: PosCustomerVerificationPurpose;
  orderId: string;
  phone: string;
  op: PosOperator;
  now?: number;
}): string {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  return signToken({
    t: "customer_phone",
    purpose: input.purpose,
    orderId: input.orderId,
    storeId: input.op.storeId,
    locationId: input.op.locationId,
    actor: actorKey(input.op),
    phone: input.phone,
    iat: now,
    exp: now + POS_CUSTOMER_VERIFICATION_MAX_AGE_S,
  });
}

export function verificationMatches(
  token: string | null | undefined,
  input: {
    purpose: PosCustomerVerificationPurpose;
    orderId: string;
    op: PosOperator;
  },
): boolean {
  const claims = verifyToken<CustomerVerificationClaims>(
    token,
    "customer_phone",
  );
  return !!(
    claims &&
    claims.purpose === input.purpose &&
    claims.orderId === input.orderId &&
    claims.storeId === input.op.storeId &&
    claims.locationId === input.op.locationId &&
    claims.actor === actorKey(input.op)
  );
}

export async function hasCustomerVerification(
  purpose: PosCustomerVerificationPurpose,
  orderId: string,
  op: PosOperator,
): Promise<boolean> {
  const token = (await cookies()).get(POS_CUSTOMER_VERIFICATION_COOKIE)?.value;
  return verificationMatches(token, { purpose, orderId, op });
}

export async function saveCustomerVerification(token: string): Promise<void> {
  (await cookies()).set(POS_CUSTOMER_VERIFICATION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/pos",
    maxAge: POS_CUSTOMER_VERIFICATION_MAX_AGE_S,
    priority: "high",
  });
}

/**
 * Which mobile an order can be verified against, if any.
 *
 * ★★ THE ONE IMPLEMENTATION, because THREE callers have to agree:
 * `beginCustomerPhoneVerification` (which number to text),
 * `confirmCustomerPhoneVerification` (which number the token must match), and
 * `markCollected`/`processReturn` (whether the OTP was even POSSIBLE, which is
 * what decides whether a manager may proceed without one). A second copy that
 * disagreed with the first would either text a number the confirm then rejects,
 * or — far worse — let an override be offered for an order that HAS a
 * verifiable mobile, turning a narrow legacy escape hatch into a general OTP
 * bypass.
 *
 * ★ `found` AND `phone` ARE SEPARATE ANSWERS. "This order isn't waiting at this
 * counter" and "it is, but carries no usable mobile" were previously both a
 * bare null, so the counter could not tell a wrong scan from a legacy row —
 * and an override must NEVER be offered for the first.
 */
export interface VerificationTarget {
  /** The order exists, at this store, and is in a state this purpose allows. */
  found: boolean;
  /**
   * FULL E.164, or null when nothing on the order can be texted.
   *
   * ★★ E.164, NOT THE TEN NATIONAL DIGITS. It used to be the latter, and the
   * caller prefixed "+91" — which was safe only while every customer was
   * Indian. The register now records a country code (`PHONE_COUNTRIES`), and
   * `normalizeIndianMobile` accepts a stored "+6591234567" as the ten digits
   * "6591234567", so that caller texted a code to "+916591234567": an
   * unrelated Indian subscriber. Worse, a non-null phone suppresses the
   * manager override, so the collection could not be handed over at all.
   * Carrying the country code means no caller can reassemble one.
   */
  phone: string | null;
}

/**
 * The delivery address's own phone, which outranks the customer record.
 *
 * ⚠ STILL THE INDIAN NORMALISER, deliberately: this is free text typed into an
 * Indian storefront checkout, validated on the way in by `formatIndianMobile`
 * (checkout-actions.ts), and its placeholder rejection is what makes a junk
 * address phone fall through to the customer record instead of eating the OTP.
 */
function mobileFromAddress(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const address = value as Record<string, unknown>;
  return formatIndianMobile(address.phone ?? address.mobile);
}

export async function loadVerificationTarget(
  op: PosOperator,
  orderId: string,
  purpose: PosCustomerVerificationPurpose,
): Promise<VerificationTarget> {
  const rows = await withService((db) =>
    db
      .select({
        shippingAddress: orders.shippingAddress,
        customerPhone: users.phone,
      })
      .from(orders)
      .leftJoin(
        users,
        and(eq(users.id, orders.customerId), eq(users.storeId, orders.storeId)),
      )
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.storeId, op.storeId),
          // A pickup must be waiting at THIS counter. A return is deliberately
          // store-scoped only — BORIS takes back orders this shop never sold.
          purpose === "pickup"
            ? and(
                eq(orders.fulfilmentType, "pickup"),
                eq(orders.pickupLocationId, op.locationId),
                or(
                  eq(orders.pickupStatus, "awaiting"),
                  eq(orders.pickupStatus, "ready"),
                ),
              )
            : undefined,
        ),
      )
      .limit(1),
  );
  const row = rows[0];
  if (!row) return { found: false, phone: null };
  return {
    found: true,
    phone:
      mobileFromAddress(row.shippingAddress) ??
      textablePhone(row.customerPhone),
  };
}

export type VerificationGate =
  /** A valid proof is on the request. Proceed. */
  | { ok: true; overridden: false }
  /** No proof, and no mobile to text — but this operator acknowledged it and
   *  may. Proceed, and AUDIT it. */
  | { ok: true; overridden: true }
  /** No proof, but one is obtainable. The counter must run the OTP. */
  | { ok: false; verificationRequired: true; error: string }
  /** No proof and none obtainable, and this operator either did not
   *  acknowledge it or may not. The counter offers the override, or explains. */
  | {
      ok: false;
      verificationUnavailable: true;
      canOverride: boolean;
      error: string;
    };

/**
 * May this hand-over / return proceed?
 *
 * ★★ THE ACKNOWLEDGEMENT IS NEVER TAKEN ON THE CLIENT'S WORD. `acknowledged`
 * only ever selects between "refuse" and "proceed" AFTER the server has
 * re-derived, from the order row, that no mobile exists to text. Trusting the
 * flag alone would turn a narrow escape hatch for legacy data into a universal
 * OTP bypass that any caller could set — the `managerApproved` boolean mistake
 * that `lib/pos/approval.ts` exists to undo, repeated.
 *
 * ★ AND IT FAILS CLOSED. A read failure is reported as "verification required",
 * never as "unverifiable" — otherwise a database blip would hand out override
 * buttons for orders that have a perfectly good phone number.
 */
export async function gateCustomerVerification(input: {
  op: PosOperator;
  orderId: string;
  purpose: PosCustomerVerificationPurpose;
  acknowledged: boolean;
  /** `posCan(op.role, "override_verification")`, passed in so this module
   *  stays free of the permission table it would otherwise import. */
  mayOverride: boolean;
  requiredCopy: string;
}): Promise<VerificationGate> {
  if (await hasCustomerVerification(input.purpose, input.orderId, input.op)) {
    return { ok: true, overridden: false };
  }

  const target = await loadVerificationTarget(
    input.op,
    input.orderId,
    input.purpose,
  ).catch(() => null);

  // Unreadable, or the order has a textable mobile ⇒ run the OTP.
  if (!target || !target.found || target.phone) {
    return {
      ok: false,
      verificationRequired: true,
      error: input.requiredCopy,
    };
  }

  if (input.acknowledged && input.mayOverride) {
    return { ok: true, overridden: true };
  }
  return {
    ok: false,
    verificationUnavailable: true,
    canOverride: input.mayOverride,
    error: input.mayOverride
      ? "This order has no mobile number that can be texted. Confirm you have checked who the customer is."
      : "This order has no mobile number that can be texted, so it can't be verified here. A manager has to complete it.",
  };
}

export async function clearCustomerVerification(): Promise<void> {
  (await cookies()).set(POS_CUSTOMER_VERIFICATION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/pos",
    maxAge: 0,
  });
}
