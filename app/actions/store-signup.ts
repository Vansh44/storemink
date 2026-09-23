"use server";

import { updateTag } from "next/cache";
import { eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { admins, storeBillingSettings, stores } from "@/drizzle/schema";
import { getServerUser } from "@/lib/auth/server-user";
import { STORE_TAG } from "@/lib/store/resolve";
import { ROOT_DOMAIN } from "@/lib/store/host";
import { slugify } from "@/lib/slug";
import { emitEvent } from "@/lib/notifications/record";
import { recordSignupConsent } from "@/lib/legal/store";
import { applyTheme } from "@/lib/themes/apply";
import { DEFAULT_THEME_ID, isThemeSelectable } from "@/lib/themes/meta";
import { getThemeCatalog } from "@/lib/themes/runtime-registry";
import { COUNTRIES } from "@/lib/countries";

// Subdomains we can never hand out (platform-reserved or operational).
const RESERVED = new Set([
  "www",
  "app",
  "help",
  "pos",
  "themes",
  "api",
  "admin",
  "dashboard",
  "auth",
  "mail",
  "email",
  "smtp",
  "ftp",
  "blog",
  "status",
  "support",
  "billing",
  "account",
  "accounts",
  "login",
  "signup",
  "store",
  "stores",
  "storiq",
  "storemink",
  "assets",
  "cdn",
  "static",
  "media",
  "img",
  "images",
]);

export interface SlugCheck {
  slug: string;
  available: boolean;
  reason?: string;
}

/**
 * Live store-name → subdomain availability check for signup. Derives the slug
 * from what the user typed, validates its shape, rejects reserved names, then
 * checks (via the service role, so pending/suspended stores count too) whether
 * any store already owns it.
 */
export async function checkStoreSlugAvailability(
  raw: string,
): Promise<SlugCheck> {
  const slug = slugify(raw || "");

  if (!slug) {
    return { slug, available: false, reason: "Enter a store name." };
  }
  if (slug.length < 3) {
    return { slug, available: false, reason: "At least 3 characters." };
  }
  if (slug.length > 40) {
    return { slug, available: false, reason: "Too long (40 characters max)." };
  }
  if (RESERVED.has(slug)) {
    return { slug, available: false, reason: "This name is reserved." };
  }
  // The demo- namespace belongs to theme demo stores (seedDemoStore).
  if (/^demo(-|$)/.test(slug)) {
    return { slug, available: false, reason: "This name is reserved." };
  }

  try {
    const rows = await withService((db) =>
      db
        .select({ id: stores.id })
        .from(stores)
        .where(eq(stores.slug, slug))
        .limit(1),
    );
    if (rows[0]) {
      return { slug, available: false, reason: "This name is not available." };
    }
    return { slug, available: true };
  } catch (err) {
    console.error(
      "checkStoreSlugAvailability:",
      err instanceof Error ? err.message : err,
    );
    return { slug, available: false, reason: "Couldn't check right now." };
  }
}

export interface SignupResume {
  /** Whether there's an authenticated session (email/password or Google). */
  authenticated: boolean;
  /** Whether this account already owns a store (→ send them to the dashboard). */
  hasStore: boolean;
  /** The owned store's slug, when hasStore. */
  slug?: string;
  /** Whether the account's phone is OTP-verified already. */
  phoneConfirmed: boolean;
  /** Google verifies this itself; password signup verifies it with our OTP. */
  emailConfirmed: boolean;
  email?: string;
  /** Name prefill (from Google profile metadata when signing in with Google). */
  firstName?: string;
  lastName?: string;
}

/**
 * What the signup wizard needs on load to resume: after a Google redirect (or a
 * refreshed tab), an account may already have a session — and possibly a store.
 * Lets the client jump straight to the phone/name step (prefilling the Google
 * name), or bounce a finished account to its dashboard.
 */
export async function getSignupResumeInfo(): Promise<SignupResume> {
  const user = await getServerUser();
  if (!user) {
    return {
      authenticated: false,
      hasStore: false,
      phoneConfirmed: false,
      emailConfirmed: false,
    };
  }

  let storeIdOwned: string | undefined;
  let slug: string | undefined;
  try {
    const existing = await withService((db) =>
      db
        .select({ store_id: admins.storeId })
        .from(admins)
        .where(eq(admins.id, user.id))
        .limit(1),
    );
    storeIdOwned = existing[0]?.store_id ?? undefined;

    if (storeIdOwned) {
      const storeRows = await withService((db) =>
        db
          .select({ slug: stores.slug })
          .from(stores)
          .where(eq(stores.id, storeIdOwned!))
          .limit(1),
      );
      slug = storeRows[0]?.slug ?? undefined;
    }
  } catch (err) {
    console.error("getSignupResumeInfo:", err);
  }

  // Best-effort name prefill from OAuth profile metadata.
  const meta = user.metadata ?? {};
  const full = String(meta.full_name || meta.name || "").trim();
  const parts = full ? full.split(/\s+/) : [];
  const firstName = (meta.given_name as string) || parts[0] || undefined;
  const lastName =
    (meta.family_name as string) ||
    (parts.length > 1 ? parts.slice(1).join(" ") : undefined);

  return {
    authenticated: true,
    hasStore: !!storeIdOwned,
    slug,
    phoneConfirmed: user.phoneConfirmed,
    emailConfirmed: user.emailConfirmed,
    email: user.email ?? undefined,
    firstName,
    lastName,
  };
}

export interface CreateStoreInput {
  /** Store display name (also seeds the subdomain slug). */
  name: string;
  /** Chosen theme/template id (see lib/themes/meta). */
  template?: string;
  /** Owner's first name (written to admins.first_name). */
  firstName?: string;
  /** Owner's last name (admins.last_name; optional). */
  lastName?: string;
  /** ISO country code the merchant sells from (settings.business.country). */
  country?: string;
  /** Street/building line for the invoice address. Required. */
  addressLine1?: string;
  /** Suite, floor, landmark, etc. Optional because many addresses have none. */
  addressLine2?: string;
  /** City the merchant sells from (settings.business.city). Required. */
  city?: string;
  /** State, province or region. Required. */
  state?: string;
  /** Postal or PIN code. Required. */
  postalCode?: string;
  /** Pin coordinates, when captured. Stored as numbers, not strings, so the
   *  eventual "stores near you" query doesn't have to parse them back. */
  lat?: number;
  lng?: number;
}

export interface CreateStoreResult {
  slug?: string;
  storeId?: string;
  error?: string;
}

/**
 * Provision a new store. Called AFTER the owner has phone-OTP-verified (so
 * there's an authenticated session — see the signup wizard). Creates the store,
 * makes the caller its superadmin (recording their name + selling location),
 * and returns the slug + id. Runs the writes via the service role because a
 * brand-new owner isn't yet a superadmin of any store (so RLS would block them).
 */
export async function createStore(
  input: CreateStoreInput,
): Promise<CreateStoreResult> {
  const rawName = input.name;
  const requestedTheme = input.template || DEFAULT_THEME_ID;
  const themeMeta = (await getThemeCatalog()).find(
    (theme) => theme.id === requestedTheme,
  );
  if (!themeMeta || !isThemeSelectable(themeMeta)) {
    return { error: "That store theme is not available." };
  }
  const template = themeMeta.id;

  const user = await getServerUser();
  if (!user) {
    return { error: "Please sign in before creating a store." };
  }
  // Client steps are an affordance, never the security boundary. Both contact
  // channels are authoritative server-side requirements: Google supplies a
  // verified email claim; password signup earns it through signup-email-otp.
  if (!user.emailConfirmed) {
    return {
      error: "Please verify your email address before creating a store.",
    };
  }
  if (!user.phoneConfirmed) {
    return {
      error: "Please verify your phone number before creating a store.",
    };
  }

  // Authoritative re-check (the client check is just for live feedback).
  const check = await checkStoreSlugAvailability(rawName);
  if (!check.available) {
    return { error: check.reason ?? "This name is not available." };
  }
  const slug = check.slug;

  // One store per owner for now (admins.id is the auth user id).
  const existing = await withService((db) =>
    db
      .select({ store_id: admins.storeId })
      .from(admins)
      .where(eq(admins.id, user.id))
      .limit(1),
  ).catch(() => []);
  if (existing[0]) {
    return { error: "This account already has a store." };
  }

  // Where the merchant sells from — captured at signup, non-secret (it prints on
  // invoices later), so it lives in the anon-readable stores.settings jsonb
  // under `business` (never a secret — convention #9).
  const country = (input.country || "").trim().slice(0, 2).toUpperCase();
  const addressLine1 = (input.addressLine1 || "").trim().slice(0, 160);
  const addressLine2 = (input.addressLine2 || "").trim().slice(0, 160);
  const city = (input.city || "").trim().slice(0, 80);
  const state = (input.state || "").trim().slice(0, 80);
  const postalCode = (input.postalCode || "").trim().slice(0, 20);

  // Required server-side, not just in the wizard: a client can post whatever it
  // likes, and every invoice this store ever prints carries this address.
  if (!country) return { error: "Please choose the country you sell from." };
  if (!addressLine1)
    return { error: "Please enter your street and building address." };
  if (!city) return { error: "Please enter the city you sell from." };
  if (!state) return { error: "Please enter your state or province." };
  if (!postalCode) return { error: "Please enter your postal or PIN code." };

  const countryName =
    COUNTRIES.find((candidate) => candidate.code === country)?.name ?? country;
  const formattedAddress = [
    addressLine1,
    addressLine2,
    `${city}, ${state} ${postalCode}`,
    countryName,
  ]
    .filter(Boolean)
    .join("\n");

  const business: Record<string, string | number> = {
    country,
    addressLine1,
    city,
    state,
    postalCode,
    // Keep one display-ready form for existing readers while the structured
    // fields remain the canonical, editable source.
    address: formattedAddress,
  };
  if (addressLine2) business.addressLine2 = addressLine2;

  // Coordinates are optional — they come from the map pin or the browser's
  // geolocation, and a merchant who declines the permission prompt must still
  // be able to finish signing up. Bounds-checked so a bad client can't store
  // nonsense that later breaks a distance query.
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  if (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  ) {
    business.lat = lat;
    business.lng = lng;
  }

  // Create the store.
  let store: { id: string; slug: string };
  try {
    const [created] = await withService((db) =>
      db
        .insert(stores)
        .values({
          slug,
          name: rawName.trim(),
          status: "active",
          plan: "free",
          settings: {
            template,
            brand: { name: rawName.trim() },
            // Not indexable until the merchant publishes something of their
            // own. Written EXPLICITLY false because absence means "launched" —
            // stores created before this flag existed are already in Google,
            // and treating a missing value as unlaunched would deindex live
            // shops. See lib/store/launch.ts.
            launched: false,
            ...(Object.keys(business).length ? { business } : {}),
          },
        })
        .returning({ id: stores.id, slug: stores.slug }),
    );
    store = created;
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { error: "That name was just taken — try another." };
    }
    console.error(
      "createStore (store insert):",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not create your store. Please try again." };
  }

  // Make the owner the store's superadmin, recording their name (falls back to
  // the email local-part so admins.first_name is never blank).
  const firstName =
    (input.firstName || "").trim() ||
    (user.email ? user.email.split("@")[0] : "Owner");
  const lastName = (input.lastName || "").trim() || null;
  try {
    await withService((db) =>
      db.insert(admins).values({
        id: user.id,
        email: user.email ?? "",
        role: "superadmin",
        storeId: store.id,
        firstName: firstName.slice(0, 80),
        lastName: lastName ? lastName.slice(0, 80) : null,
        // ★★ THE VERIFIED NUMBER MUST LAND HERE, NOT ONLY ON THE INVOICE
        // PROFILE. `createStore` runs only after phone OTP (see the
        // phoneConfirmed gate above), and `admins.phone` is where every server
        // reader looks for a billing contact — `resolveBillingEmail`, and
        // therefore `startEnrolment`, which needs BOTH an email and a phone to
        // register a Razorpay mandate. Writing it to store_billing_settings
        // alone left `admins.phone` NULL on every wizard-created store, so
        // Subscribe answered "We couldn't prepare autopay" before a single
        // gateway call. Same value setVerifiedPhone stores.
        phone: user.phone ?? null,
        // The owner set their own password during signup — the admins column
        // defaults force_password_reset=true (that's for INVITED staff who get
        // a temporary password), so override it here or the owner is bounced to
        // /auth/set-password on their first login.
        forcePasswordReset: false,
      }),
    );
  } catch (err) {
    // Roll back the store so a retry isn't blocked by the now-taken slug.
    await withService((db) =>
      db.delete(stores).where(eq(stores.id, store.id)),
    ).catch(() => {});
    console.error(
      "createStore (admin insert):",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not set up your store account. Please try again." };
  }

  // The invoice renderer reads store_billing_settings, not stores.settings.
  // Seed both from the one validated signup address so the first invoice does
  // not silently omit the identity the wizard promised would appear on it.
  try {
    await withService((db) =>
      db.insert(storeBillingSettings).values({
        storeId: store.id,
        businessName: rawName.trim(),
        businessAddress: formattedAddress,
        contactEmail: user.email ?? null,
        contactPhone: user.phone ?? null,
        updatedBy: user.id,
      }),
    );
  } catch (err) {
    // This is required signup data, not an optional enhancement. The store FK
    // cascades the owner + partial billing row, leaving a clean retry.
    await withService((db) =>
      db.delete(stores).where(eq(stores.id, store.id)),
    ).catch(() => {});
    console.error(
      "createStore (billing profile insert):",
      err instanceof Error ? err.message : err,
    );
    return { error: "Could not save your business address. Please try again." };
  }

  // Seed the chosen theme: homepage + content pages (published), menus, brand
  // accents, and clearly-labeled sample products/categories — the merchant
  // starts by EDITING a real website, not building from a blank canvas.
  // Best-effort: a partial seed still leaves a working store, and applyTheme
  // is idempotent (upserts by store_id+slug) so it can be re-run.
  const seeded = await applyTheme(store.id, template, {
    publish: true,
    actorUserId: user.id,
  });
  if (!seeded.success) {
    console.error("createStore (theme seed):", seeded.errors.join(" | "));
  }

  // New store row must be resolvable on the VERY NEXT request. `revalidateTag`
  // with the `max` profile is stale-while-revalidate: the first dashboard load
  // can therefore receive the cached "slug does not exist" result, fall back
  // to the legacy WholeSip store, and tell the new owner they have no access.
  // This is a Server Action and signup immediately redirects to the new host,
  // so Next 16's read-your-own-writes primitive is the correct contract here.
  updateTag(STORE_TAG);

  // NOTE: search engines are deliberately NOT notified here any more.
  //
  // A store at this instant is pure theme seed — the same homepage, the same
  // ~17 content pages and the same sample catalogue as every other store on
  // this template. Submitting that to Google and IndexNow the moment it exists
  // meant the platform repeatedly showed search engines thin, near-duplicate
  // content, and the reputational cost lands on the whole *.storemink.com
  // domain — including the stores that did the work. `robots.txt` cannot undo
  // it either: Disallow stops future crawling, it does not deindex.
  //
  // The store is submitted the first time its owner publishes something of
  // their own, which is where markStoreLaunched() is called from
  // (page-actions.publishPage, product-actions). See lib/store/launch.ts.
  //
  // Still needed below: the welcome email tells the merchant their address.
  const storeUrl = `https://${store.slug}.${ROOT_DOMAIN}`;

  // Belt and braces: consent is recorded right after the account is created,
  // but a wizard resumed from a refreshed tab or a Google redirect can reach
  // store creation by a path that skipped it. The unique index makes this a
  // no-op when it already landed, and an account that owns a store with NO
  // recorded agreement is the one outcome worth a second write to avoid.
  await recordSignupConsent({
    userId: user.id,
    email: user.email ?? null,
    actorType: "merchant",
    storeId: store.id,
    context: "signup",
  });

  // The MERCHANT's welcome — the only thing that greets someone who has just
  // finished signup. Without it a new store owner completed the wizard and
  // received nothing: no confirmation, no store address, no next step.
  // Scoped to the new store so it reaches the owner's own dashboard and inbox.
  emitEvent({
    type: "store.created",
    storeId: store.id,
    actor: { type: "system" },
    subject: { type: "store", id: store.id, label: rawName.trim() },
    payload: { storeUrl, plan: "free" },
  });

  // The OPERATORS' copy of the same moment (store_id NULL): same trigger,
  // different audience, different words — the two-audience rule (§23).
  emitEvent({
    type: "platform.store_created",
    storeId: null,
    actor: { type: "admin", id: user.id, label: user.email ?? null },
    subject: { type: "store", id: store.id, label: rawName.trim() },
    payload: { slug: store.slug, template },
  });

  return { slug: store.slug, storeId: store.id };
}
