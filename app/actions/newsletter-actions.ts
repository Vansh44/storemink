"use server";

import { headers } from "next/headers";
import { newsletterSubscribers } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { isDemoStore } from "@/lib/store/launch";
import { DEMO_STORE_MESSAGE } from "@/lib/store/demo-guard";

export interface NewsletterActionState {
  status: "idle" | "success" | "error";
  message: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_CONSENT_RECORD =
  "Email marketing consent granted through this store's newsletter form.";

/** Anonymous storefront subscription. Store identity comes from the host,
 * never the form; repeated submissions reactivate the same store/email row. */
export async function subscribeNewsletter(
  _previous: NewsletterActionState,
  formData: FormData,
): Promise<NewsletterActionState> {
  // Honeypot: bots commonly fill every field. Return the normal success shape
  // so the endpoint does not teach them how to bypass it.
  if (String(formData.get("website") ?? "").trim()) {
    return { status: "success", message: "You're on the list — thank you." };
  }

  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 320);
  if (!EMAIL_RE.test(email)) {
    return { status: "error", message: "Enter a valid email address." };
  }
  if (formData.get("consent") !== "on") {
    return {
      status: "error",
      message: "Please confirm that you'd like to receive emails.",
    };
  }

  // Never use the never-null fallback resolver for an anonymous storefront
  // write: an unknown/platform host must not subscribe someone to WholeSip.
  const store = await getCurrentStoreOrNull();
  if (!store) {
    return { status: "error", message: "This store isn't available." };
  }
  // A theme preview has nobody to honour the consent; store none.
  if (isDemoStore(store)) {
    return { status: "error", message: DEMO_STORE_MESSAGE };
  }
  const storeId = store.id;
  const ip = clientIp(await headers());
  const { allowed } = await rateLimit(`newsletter:${storeId}:${ip}`, {
    max: 10,
    windowSeconds: 3600,
  });
  if (!allowed) {
    return {
      status: "error",
      message: "Too many attempts. Please try again later.",
    };
  }

  const source = formData.get("source") === "footer" ? "footer" : "section";
  const consentText =
    String(formData.get("consent_text") ?? "")
      .trim()
      .slice(0, 240) || DEFAULT_CONSENT_RECORD;
  const now = new Date().toISOString();
  try {
    await withService((db) =>
      db
        .insert(newsletterSubscribers)
        .values({
          storeId,
          email,
          source,
          status: "active",
          consentText,
          consentedAt: now,
        })
        .onConflictDoUpdate({
          target: [newsletterSubscribers.storeId, newsletterSubscribers.email],
          set: {
            source,
            status: "active",
            consentText,
            consentedAt: now,
          },
        }),
    );
  } catch (error) {
    console.error("Failed to save newsletter subscription:", error);
    return {
      status: "error",
      message: "We couldn't save your subscription. Please try again.",
    };
  }

  // Same response for a new or existing address: do not expose membership.
  return { status: "success", message: "You're on the list — thank you." };
}
