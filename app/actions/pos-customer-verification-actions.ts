"use server";

import { eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { users } from "@/drizzle/schema";
import { getFirebaseAdminAuth } from "@/lib/auth/firebase-admin";
import { textablePhone } from "@/lib/phone";
import { resolvePosOperator, type PosOperator } from "@/lib/pos/operator";
import { posCan } from "@/lib/pos/permissions";
import {
  hasCustomerVerification,
  loadVerificationTarget,
  saveCustomerVerification,
  signCustomerVerification,
  type PosCustomerVerificationPurpose,
} from "@/lib/pos/customer-verification";
import { rateLimit } from "@/lib/rate-limit";
import {
  posSessionConfigured,
  POS_SECRET_MISSING_ERROR,
} from "@/lib/pos/session";
import { logError } from "@/lib/observability/logger";

function canVerify(op: PosOperator, purpose: PosCustomerVerificationPurpose) {
  return posCan(op.role, purpose === "pickup" ? "sell" : "refund");
}

function validPurpose(value: unknown): value is PosCustomerVerificationPurpose {
  return value === "pickup" || value === "return";
}

/** What the counter is told when an order carries no textable mobile. */
const UNVERIFIABLE_COPY =
  "This order has no mobile number that can be texted, so the customer can't be verified by code.";

/**
 * `signInWithPhoneNumber` creates a Firebase identity when the number has never
 * signed in before. At a counter that identity is only an OTP transport; leaving
 * it behind would later make the real customer's signup say the phone is taken.
 *
 * The client tells us Firebase marked this credential as new, but that flag is
 * not trusted by itself. Delete only a just-created, phone-only identity with no
 * application profile anywhere. A failed cleanup never invalidates the OTP
 * proof; it is reported for reconciliation instead.
 */
async function cleanupTemporaryPhoneIdentity(
  auth: NonNullable<ReturnType<typeof getFirebaseAdminAuth>>,
  uid: string,
  phone: string,
): Promise<void> {
  try {
    const profiles = await withService((db) =>
      db.select({ id: users.id }).from(users).where(eq(users.id, uid)).limit(1),
    );
    if (profiles.length > 0) return;

    const record = await auth.getUser(uid);
    const createdAt = Date.parse(record.metadata.creationTime);
    const justCreated =
      Number.isFinite(createdAt) && Date.now() - createdAt <= 5 * 60 * 1000;
    const phoneOnly =
      !record.email &&
      record.providerData.length > 0 &&
      record.providerData.every((provider) => provider.providerId === "phone");
    if (
      justCreated &&
      phoneOnly &&
      textablePhone(record.phoneNumber) === phone
    ) {
      await auth.deleteUser(uid);
    }
  } catch (err) {
    logError("pos.customer_otp_identity_cleanup", err, { uid });
  }
}

export async function beginCustomerPhoneVerification(
  orderId: string,
  purpose: PosCustomerVerificationPurpose,
): Promise<{
  phone?: string;
  maskedPhone?: string;
  alreadyVerified?: boolean;
  /** The order exists here but carries no textable mobile, so the OTP cannot
   *  run at all. Distinct from `error`, which means the counter should stop. */
  unverifiable?: boolean;
  /** Whether THIS operator may proceed without a code (`override_verification`
   *  — manager and above). A cashier gets the explanation and no button. */
  canOverride?: boolean;
  error?: string;
}> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!validPurpose(purpose) || !canVerify(op, purpose)) {
    return { error: "You are not allowed to verify this customer." };
  }
  if (typeof orderId !== "string" || !orderId) {
    return { error: "Invalid order." };
  }
  if (await hasCustomerVerification(purpose, orderId, op)) {
    return { alreadyVerified: true };
  }
  if (!posSessionConfigured()) return { error: POS_SECRET_MISSING_ERROR };

  const limited = await rateLimit(
    `pos-customer-otp:${op.storeId}:${op.locationId}:${orderId}`,
    { max: 5, windowSeconds: 900 },
  );
  if (!limited.allowed) {
    return { error: "Too many codes were requested. Please wait 15 minutes." };
  }

  const target = await loadVerificationTarget(op, orderId, purpose).catch(
    () => null,
  );
  // A read failure is NOT "no phone" — reporting it as unverifiable would hand
  // a manager an override button because the database blinked. Fails closed.
  if (!target) return { error: "Couldn't read the order. Please try again." };
  if (!target.found) {
    return { error: "That order isn't waiting at this counter." };
  }
  if (!target.phone) {
    // ★ Not an error: the counter has to be able to finish. See
    // `override_verification` — the goods are paid for and the customer is
    // standing there, so the answer is a deliberate, recorded decision by
    // someone senior, not a permanent refusal.
    return {
      unverifiable: true,
      canOverride: posCan(op.role, "override_verification"),
      error: UNVERIFIABLE_COPY,
    };
  }
  if (!getFirebaseAdminAuth()) {
    return {
      error:
        "Phone verification isn't configured on this server. Contact support.",
    };
  }
  // ★ SENT AS-IS. `loadVerificationTarget` returns full E.164 precisely so
  // nothing here reassembles a country code; prefixing "+91" is what texted a
  // Singapore customer's code to an unrelated Indian number.
  return {
    phone: target.phone,
    maskedPhone: `••••••${target.phone.slice(-4)}`,
  };
}

export async function confirmCustomerPhoneVerification(input: {
  orderId: string;
  purpose: PosCustomerVerificationPurpose;
  idToken: string;
  cleanupCreatedAuthUser?: boolean;
}): Promise<{ verified?: boolean; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!validPurpose(input?.purpose) || !canVerify(op, input.purpose)) {
    return { error: "You are not allowed to verify this customer." };
  }
  if (!input.orderId || !input.idToken) {
    return { error: "The verification proof is missing. Try again." };
  }

  const limited = await rateLimit(
    `pos-customer-otp-confirm:${op.storeId}:${op.locationId}:${input.orderId}`,
    { max: 10, windowSeconds: 900 },
  );
  if (!limited.allowed) {
    return { error: "Too many verification attempts. Please wait 15 minutes." };
  }

  const target = await loadVerificationTarget(
    op,
    input.orderId,
    input.purpose,
  ).catch(() => null);
  // No phone means no proof can be MINTED here either — the override path is
  // the only way through, and it is markCollected/processReturn's decision.
  if (!target?.found || !target.phone) {
    return {
      error:
        "This order has no valid customer mobile number. It can't be verified at the till.",
    };
  }

  const auth = getFirebaseAdminAuth();
  if (!auth) return { error: "Phone verification isn't configured." };
  try {
    const decoded = await auth.verifyIdToken(input.idToken, true);
    // Both sides through the SAME normaliser, so the comparison cannot be
    // satisfied by two different renderings of two different numbers.
    const tokenPhone = textablePhone(decoded.phone_number);
    const recent =
      typeof decoded.auth_time === "number" &&
      Math.floor(Date.now() / 1000) - decoded.auth_time <= 5 * 60;
    if (
      decoded.firebase?.sign_in_provider !== "phone" ||
      !recent ||
      !tokenPhone ||
      tokenPhone !== target.phone
    ) {
      return { error: "That code didn't verify this order's mobile number." };
    }
    await saveCustomerVerification(
      signCustomerVerification({
        purpose: input.purpose,
        orderId: input.orderId,
        phone: target.phone,
        op,
      }),
    );
    if (input.cleanupCreatedAuthUser === true) {
      await cleanupTemporaryPhoneIdentity(auth, decoded.uid, target.phone);
    }
    return { verified: true };
  } catch {
    return { error: "That code is invalid or expired. Request a new one." };
  }
}
