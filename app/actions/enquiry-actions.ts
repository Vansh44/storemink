"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { emitEvent } from "@/lib/notifications/record";
import { headers } from "next/headers";
import { withService } from "@/lib/db/client";
import { enquiries } from "@/drizzle/schema";
import { getManagerUserId, getActingStoreId } from "@/app/dashboard/lib/access";
import { getCurrentStoreId } from "@/lib/store/resolve";
import { demoStoreRefusal } from "@/lib/store/demo-guard";
import { getStoreBrand } from "@/lib/store/brand";
import { sendEnquiryAcknowledgementEmail } from "@/lib/email/enquiry-notifications";
import { rateLimit, clientIp } from "@/lib/rate-limit";

export type EnquiryStatus = "new" | "in_progress" | "resolved" | "archived";

// Note: a "use server" module may only export async functions (+ type-only
// exports), so the valid-status list lives inside the action below rather than
// as an exported const.

export interface EnquiryInput {
  name: string;
  email: string;
  phone: string;
  subject?: string;
  subjectDetail?: string;
  message: string;
}

export interface ActionResult {
  success?: boolean;
  error?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Storefront submission. Enquiries are ANONYMOUS — the enquirer is never logged
 * in and no customer account is created. The phone is verified client-side via
 * a throwaway (non-persisting) OTP client before this runs; here we simply
 * store what was submitted using the service scope (so no auth session is
 * required). Sends a best-effort acknowledgement email and never blocks success
 * on it.
 */
export async function submitEnquiry(
  input: EnquiryInput,
): Promise<ActionResult> {
  const demoRefusal = await demoStoreRefusal();
  if (demoRefusal) return { error: demoRefusal };
  const name = input.name?.trim();
  const email = input.email?.trim();
  const phone = input.phone?.trim();
  const subject = input.subject?.trim() || null;
  const subjectDetail = input.subjectDetail?.trim() || null;
  const message = input.message?.trim();

  if (!name) return { error: "Please enter your name." };
  if (!email || !EMAIL_RE.test(email)) {
    return { error: "Please enter a valid email address." };
  }
  if (!phone || phone.replace(/\D/g, "").length < 8) {
    return { error: "A verified phone number is required." };
  }
  if (!subject) return { error: "Please select a subject." };
  if (!message) return { error: "Please enter a message." };

  // Anonymous public endpoint — throttle per IP so it can't be used to spam
  // the inbox (and our acknowledgement-email quota). 5 submissions / hour.
  const ip = clientIp(await headers());
  const { allowed } = await rateLimit(`enquiry:${ip}`, {
    max: 5,
    windowSeconds: 3600,
  });
  if (!allowed) {
    return {
      error: "Too many enquiries from your network. Please try again later.",
    };
  }

  const storeId = await getCurrentStoreId();
  let enquiryId: string | undefined;
  try {
    const inserted = await withService((db) =>
      db
        .insert(enquiries)
        .values({
          name,
          email,
          phone,
          subject,
          subjectDetail,
          message,
          storeId,
        })
        .returning({ id: enquiries.id }),
    );
    enquiryId = inserted[0]?.id;
  } catch (err) {
    console.error("Failed to insert enquiry:", err);
    return {
      error: "Something went wrong saving your enquiry. Please try again.",
    };
  }

  // The customer sees their real subject in the email; for "Other" that's the
  // free-text they typed (the dashboard list shows just "Other").
  const emailSubject =
    subject === "Other" && subjectDetail ? subjectDetail : subject;

  // Best-effort acknowledgement — failure is logged inside, never thrown.
  const brand = await getStoreBrand();
  await sendEnquiryAcknowledgementEmail({
    to: email,
    name,
    subject: emailSubject,
    message,
    brand,
  });

  emitEvent({
    type: "enquiry.received",
    storeId,
    actor: { type: "customer", label: name },
    subject: { type: "enquiry", id: enquiryId ?? null, label: subject },
    payload: { subject: emailSubject },
  });

  revalidatePath("/dashboard/enquiries");
  return { success: true };
}

/** Dashboard: change an enquiry's workflow status. */
export async function updateEnquiryStatus(
  id: string,
  status: EnquiryStatus,
): Promise<ActionResult> {
  const managerId = await getManagerUserId("enquiries");
  if (!managerId) {
    return { error: "You don't have permission to manage enquiries." };
  }
  const validStatuses: EnquiryStatus[] = [
    "new",
    "in_progress",
    "resolved",
    "archived",
  ];
  if (!validStatuses.includes(status)) {
    return { error: "Invalid status." };
  }

  // Scope by store_id — the service scope bypasses RLS, so an id alone would
  // let a store admin mutate another store's enquiry.
  const storeId = await getActingStoreId();
  try {
    await withService((db) =>
      db
        .update(enquiries)
        .set({ status })
        .where(and(eq(enquiries.id, id), eq(enquiries.storeId, storeId))),
    );
  } catch (err) {
    console.error("Failed to update enquiry status:", err);
    return { error: "Failed to update status. Please try again." };
  }

  revalidatePath("/dashboard/enquiries");
  return { success: true };
}

/** Dashboard: permanently delete an enquiry. */
export async function deleteEnquiry(id: string): Promise<ActionResult> {
  const managerId = await getManagerUserId("enquiries");
  if (!managerId) {
    return { error: "You don't have permission to manage enquiries." };
  }

  const storeId = await getActingStoreId();
  try {
    await withService((db) =>
      db
        .delete(enquiries)
        .where(and(eq(enquiries.id, id), eq(enquiries.storeId, storeId))),
    );
  } catch (err) {
    console.error("Failed to delete enquiry:", err);
    return { error: "Failed to delete enquiry. Please try again." };
  }

  revalidatePath("/dashboard/enquiries");
  return { success: true };
}
