// ---------------------------------------------------------------------------
// Plan catalog — the single source of truth for StoreMink's subscription plans.
//
// Three plans, gated by business maturity:
//   free  → try it         (COD only, subdomain, small catalog)
//   basic → run a business (online payments, shipping, team tools)
//   pro   → scale it        (advanced analytics, POS, campaigns)
//
// `stores.plan` holds one of PLAN_IDS (DB CHECK constraint, plans_02_*.sql).
// Plans can be TIMED: `stores.plan_expires_at` (timestamptz, NULL = indefinite)
// bounds an operator-granted plan. Enforcement is two-layered — every read-site
// resolves the plan through effectivePlan() (expired ⇒ free, precise), and the
// daily /api/cron/plan-expiry job durably flips expired rows to free.
//
// Feature gating goes through planAllows()/limits here + the settings registry's
// per-setting `minPlan`. Pricing lives ONLY in this file so repricing is a
// one-line change; billing (Razorpay subscriptions) will consume these values.
//
// Pure module (no server/React imports) — shared by server actions, client
// components, and tests alike. Mirrors lib/settings/registry.ts.
// ---------------------------------------------------------------------------

export const PLAN_IDS = ["free", "basic", "pro"] as const;
export type Plan = (typeof PLAN_IDS)[number];

export const PLAN_RANK: Record<Plan, number> = {
  free: 0,
  basic: 1,
  pro: 2,
};

// Retired plan ids that may linger in un-migrated rows (or cached store
// objects) during a rollout — they degrade to their nearest live plan, never
// to a crash. "starter" was renamed to "basic" in plans_02_basic_and_expiry.sql.
const LEGACY_PLAN_ALIASES: Record<string, Plan> = {
  starter: "basic",
};

/** Coerce an arbitrary stores.plan value to a known plan (unknown → free). */
export function normalizePlan(plan: unknown): Plan {
  if (typeof plan !== "string") return "free";
  if (plan in PLAN_RANK) return plan as Plan;
  return LEGACY_PLAN_ALIASES[plan] ?? "free";
}

/**
 * What a store may be entitled to, as `effectivePlan` reads it.
 *
 * ★★ THE COMP FIELDS ARE REQUIRED, AND THAT IS THE POINT — not an oversight to
 * tidy into optionals later.
 *
 * `plan`/`plan_expires_at` are optional because they always were, and 18 of the
 * 40 call sites pass an object literal or a `?? {}` fallback. If the comp fields
 * were optional too, every one of those would compile unchanged and silently
 * ignore the comp: the merchant is told they have Pro and gets Basic, with no
 * error anywhere and nothing in a log. Requiring them turns that into one build
 * error per call site — the same technique `OrderInsert` uses for the two
 * trigger-owned columns and `withUser` for the email field.
 *
 * A caller that genuinely has no comp data passes `null` explicitly and means
 * it.
 */
export interface PlanEntitlement {
  plan?: unknown;
  plan_expires_at?: string | Date | null;
  comp_plan: unknown;
  comp_expires_at: string | Date | null;
}

/** A store with no comp overlay — the explicit "I checked, there isn't one". */
export const NO_COMP = { comp_plan: null, comp_expires_at: null } as const;

/** Parse a timestamp that may be a Date, an ISO string, or junk. */
function instant(raw: string | Date | null | undefined): number | null {
  if (raw == null) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * The plan a store is ACTUALLY entitled to right now.
 *
 * Two independent grants, resolved by rank:
 *
 *   - the PAID entitlement — `plan`, unless `plan_expires_at` has passed;
 *   - the COMP overlay — `comp_plan`, while `comp_expires_at` is in the future.
 *
 * Every gate that reads `stores.plan` must resolve through this. The expiry
 * crons flip both durably, but only once a day.
 *
 * ★★ THE COMP IS AN OVERLAY, NEVER A REPLACEMENT, and that is what makes its
 * expiry free. Nothing writes the comp into `plan`, so when the window closes
 * the paid entitlement underneath is simply what remains — there is no "put
 * them back on Basic" step that could be forgotten or fail. See
 * docs/comped-plans-spec.md §4.
 *
 * ★ IT CAN ONLY EVER RAISE. A comp at or below the paid rank is inert, so a Pro
 * subscriber handed a comped Basic keeps Pro rather than being quietly demoted
 * by a gift.
 *
 * ★ An unparseable expiry is treated as INDEFINITE for the paid plan (fail
 * open — junk data must never strip a paying merchant) and as ABSENT for the
 * comp (fail closed — junk data must never manufacture an entitlement nobody
 * granted). The asymmetry is deliberate: one direction protects a customer, the
 * other protects the business, and both err away from the expensive mistake.
 */
export function effectivePlan(
  store: PlanEntitlement,
  now: Date = new Date(),
): Plan {
  const paid = paidEntitlement(store, now);
  const comp = compEntitlement(store, now);
  return PLAN_RANK[comp] > PLAN_RANK[paid] ? comp : paid;
}

function paidEntitlement(store: PlanEntitlement, now: Date): Plan {
  const plan = normalizePlan(store.plan);
  if (plan === "free") return plan;
  const expiresAt = instant(store.plan_expires_at);
  if (expiresAt === null) return plan; // indefinite, or unparseable — fail open.
  return expiresAt <= now.getTime() ? "free" : plan;
}

function compEntitlement(store: PlanEntitlement, now: Date): Plan {
  const plan = normalizePlan(store.comp_plan);
  if (plan === "free") return "free";
  const expiresAt = instant(store.comp_expires_at);
  // No window, or an unreadable one, means no comp. Fail closed.
  if (expiresAt === null) return "free";
  return expiresAt <= now.getTime() ? "free" : plan;
}

/** Is a comp overlay live right now? For UI that must name it explicitly. */
export function compActive(
  store: PlanEntitlement,
  now: Date = new Date(),
): boolean {
  return compEntitlement(store, now) !== "free";
}

/** Is `plan` at or above `minPlan`? (No minPlan = available on every plan.) */
export function planAllows(plan: Plan, minPlan?: Plan): boolean {
  if (!minPlan) return true;
  return PLAN_RANK[plan] >= PLAN_RANK[minPlan];
}

/** How a store came to be on its plan — a comp (operator-granted) plan must
 *  never be overwritten by billing webhooks, and vice versa. */
export const PLAN_SOURCES = ["comp", "paid", "trial"] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];

// ── Display metadata (pricing page, upgrade dialogs, billing) ──────────────

export interface PlanMeta {
  id: Plan;
  name: string;
  tagline: string;
  /** INR per month, billed monthly. 0 = free. */
  monthlyInr: number;
  /** INR per year, billed yearly (≈2 months free). 0 = free. */
  yearlyInr: number;
}

export const PLAN_META: Record<Plan, PlanMeta> = {
  free: {
    id: "free",
    name: "Free",
    tagline: "Try StoreMink and set up your store",
    monthlyInr: 0,
    yearlyInr: 0,
  },
  basic: {
    id: "basic",
    name: "Basic",
    tagline: "Run a real business — payments, shipping, team tools",
    monthlyInr: 1500,
    // Ten months for twelve — the "two months free" the pricing page and the
    // FAQ both promise. Keep the 10× relationship if these ever move, or that
    // promise quietly stops being true.
    yearlyInr: 15000,
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "Scale with your team — advanced analytics, POS, campaigns",
    monthlyInr: 5000,
    yearlyInr: 50000,
  },
};

/**
 * An extra POS location, beyond what the plan includes (roadmap Step 5).
 *
 * THE DEFAULT ONLY — a platform operator sets the live price from the console
 * (`plan_prices`, key `extra_location`, see plans_05). This is what applies
 * until one ever has, exactly as `PLAN_META`'s prices are the fallback for the
 * tiers. Read it through `getExtraLocationPricingLive()` anywhere the number
 * decides what someone is CHARGED; never import this constant for that.
 *
 * Because `razorpay_plans` is keyed on the AMOUNT, a reprice mints a new
 * Razorpay plan and existing subscribers keep what they authorised until they
 * change something (§15b's grandfathering rule, inherited for free).
 *
 * Yearly is 10× monthly, the same "two months free" relationship `PLAN_META`
 * promises. Keep that ratio if these move, or the promise quietly stops being
 * true for the add-on while staying true for the plan.
 */
export const EXTRA_LOCATION_PRICE = {
  monthlyInr: 1000,
  yearlyInr: 10000,
} as const;

/**
 * The key the add-on is stored under in `plan_prices` (plans_05).
 *
 * ★ IT LIVES HERE, NOT IN lib/plans/pricing.ts, AND THAT IS LOAD-BEARING.
 * That module is `import "server-only"` — it pulls in the db client, and
 * therefore `pg` and `fs`. The operator's Pricing panel is a CLIENT component
 * and needs this key at runtime to tell the add-on row from a tier, so importing
 * it from there fails the BUILD (typecheck passes happily, which is what makes
 * it worth a comment). The TYPES may still come from pricing.ts — those are
 * erased. Same split as lib/logs/failure-types.ts and lib/themes/meta.ts.
 */
export const EXTRA_LOCATION_KEY = "extra_location";

// ── Limits & feature matrix ─────────────────────────────────────────────────
// `null` = unlimited. Enforced SERVER-SIDE in the owning action (a limit that
// only exists in the UI is a suggestion, not a limit). Enforcement is
// soft-on-downgrade: existing data is never deleted; creating NEW rows past the
// cap is blocked with an upgrade prompt.

export interface PlanLimits {
  /** Max products a store may have (null = unlimited). */
  maxProducts: number | null;
  /** Max staff accounts incl. the owner (null = unlimited). */
  maxStaff: number | null;
  /** Legacy-sized Mink credits per plan cycle (null = unlimited). Purchased
   *  top-ups (lib/ai) extend this after the included allowance is consumed. */
  aiGenerationsPerMonth: number | null;
  /**
   * The allowance once a Mink conversation SPENDS from the same pool.
   *
   * ★★ A SECOND NUMBER, NOT AN EDIT TO THE ONE ABOVE, BECAUSE THE TWO MUST
   * SWITCH TOGETHER. `aiGenerationsPerMonth` is sized for ~₹0.90 product
   * descriptions; a Mink run costs 1–8 credits. Charging against the smaller
   * cap would give a Free store one Mink question a month, and raising the cap
   * without charging is a pure cost increase. `aiAllowanceFor()` picks between
   * them from the one flag, so neither half can ship on its own.
   */
  aiCreditsPerMonth: number | null;
  /** Max simultaneously-active coupons (null = unlimited). */
  maxActiveCoupons: number | null;
  /**
   * Active offers a store may run at once. `null` = unlimited.
   *
   * ★ THE OFFER POOL INCLUDES MIGRATED COUPONS, so this is not additive with
   * `maxActiveCoupons` — counting the two separately would hand a free store
   * three of each. `maxActiveCoupons` stays only for the legacy coupon table's
   * own gate until nothing reads it.
   */
  maxActiveOffers: number | null;
  /** May connect a custom domain. */
  customDomain: boolean;
  /** May connect a payment gateway (Razorpay) for online payments. */
  onlinePayments: boolean;
  /** May accept customer-authored blog drafts/submissions. Stored drafts are
   *  retained below this plan and become available again after an upgrade. */
  customerBlogSubmissions: boolean;
  /** May add and run sandboxed custom-code page sections. */
  customCode: boolean;
  /** May create and assign customer groups. */
  customerGroups: boolean;
  /** May create and edit custom dashboard roles. */
  customRoles: boolean;
  /** May connect Shiprocket for rates, fulfilment and tracking. */
  shippingIntegration: boolean;
  /** May customise the analytics dashboard and save layouts. */
  analyticsCustomization: boolean;
  /** May open drill-down analytics reports, CSV and Search Console data. */
  detailedAnalytics: boolean;
  /** May buy additional Mink credits after the included allowance is used. */
  aiCreditTopUps: boolean;
  /** May send coupon email campaigns. */
  emailCampaigns: boolean;
  /** May connect merchant analytics pixels and use advanced conversion/margin
   *  reporting. Platform availability is a separate operator-controlled gate. */
  advancedAnalytics: boolean;
  /** "Powered by StoreMink" badge is removed from the storefront footer. */
  removeBadge: boolean;
  /** May use the Point of Sale (in-store register at /pos). Pro only. */
  posEnabled: boolean;
  /** POS locations included at no extra cost. Additional locations are billed
   *  per month (see docs/pos-plan.md §9.2 / Phase 7). 0 = POS not available. */
  posLocationsIncluded: number;
  /** Max simultaneously-authorized POS devices per location. Bounds the blast
   *  radius of a leaked pairing code and keeps the device list reviewable —
   *  a real shop runs a handful of registers, not dozens. */
  posDevicesPerLocation: number;
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    maxProducts: 5,
    maxStaff: 1,
    aiGenerationsPerMonth: 3,
    aiCreditsPerMonth: 20,
    maxActiveCoupons: 3,
    maxActiveOffers: 3,
    customDomain: false,
    onlinePayments: false,
    customerBlogSubmissions: false,
    customCode: false,
    customerGroups: false,
    customRoles: false,
    shippingIntegration: false,
    analyticsCustomization: false,
    detailedAnalytics: false,
    aiCreditTopUps: true,
    emailCampaigns: false,
    advancedAnalytics: false,
    removeBadge: false,
    posEnabled: false,
    posLocationsIncluded: 0,
    posDevicesPerLocation: 0,
  },
  basic: {
    maxProducts: 50,
    maxStaff: 3,
    aiGenerationsPerMonth: 10,
    aiCreditsPerMonth: 100,
    maxActiveCoupons: null,
    maxActiveOffers: null,
    // Pro only. Connecting a domain provisions a certificate per merchant on
    // the platform's load balancer — real infrastructure with a real ceiling,
    // unlike a row limit — so it sits on the top tier. The pricing page derives
    // its feature list from here, so this flag is also what it advertises.
    customDomain: false,
    onlinePayments: true,
    customerBlogSubmissions: true,
    customCode: true,
    customerGroups: true,
    customRoles: true,
    shippingIntegration: true,
    analyticsCustomization: true,
    detailedAnalytics: true,
    aiCreditTopUps: true,
    emailCampaigns: false,
    advancedAnalytics: false,
    removeBadge: true,
    posEnabled: false,
    posLocationsIncluded: 0,
    posDevicesPerLocation: 0,
  },
  pro: {
    maxProducts: null,
    maxStaff: null,
    aiGenerationsPerMonth: 50,
    aiCreditsPerMonth: 300,
    maxActiveCoupons: null,
    maxActiveOffers: null,
    customDomain: true,
    onlinePayments: true,
    customerBlogSubmissions: true,
    customCode: true,
    customerGroups: true,
    customRoles: true,
    shippingIntegration: true,
    analyticsCustomization: true,
    detailedAnalytics: true,
    aiCreditTopUps: true,
    emailCampaigns: true,
    advancedAnalytics: true,
    removeBadge: true,
    posEnabled: true,
    posLocationsIncluded: 2,
    posDevicesPerLocation: 5,
  },
};

/** The resolved limits for a raw stores.plan value (unknown plans → free). */
export function limitsFor(plan: unknown): PlanLimits {
  return PLAN_LIMITS[normalizePlan(plan)];
}

/** Boolean capabilities in PlanLimits. Used by the server entitlement helper
 * and the comparison UI so feature names cannot drift between layers. */
export type PlanFeature = {
  [K in keyof PlanLimits]: PlanLimits[K] extends boolean ? K : never;
}[keyof PlanLimits];

export type PlanMatrixValue = boolean | string;
export interface PlanMatrixRow {
  label: string;
  free: PlanMatrixValue;
  basic: PlanMatrixValue;
  pro: PlanMatrixValue;
}
export interface PlanMatrixSection {
  title: string;
  rows: readonly PlanMatrixRow[];
}

/** Complete customer-facing comparison. Values that are limits are derived
 * from PLAN_LIMITS; feature availability is enforced from the same object. */
/**
 * The monthly AI allowance in force, in credits.
 *
 * ⚠ ONE SWITCH FOR BOTH HALVES. Read it wherever the cap is needed — the quota
 * gate, Mink settlement and the advertised matrix — so the number a merchant is
 * shown, the number they are billed against and the number the pool enforces
 * are always the same. `docs/cron-jobs.md`'s standing lesson applies: a release
 * step that has to be remembered per surface is one that gets forgotten.
 */
export function aiAllowanceFor(
  plan: Plan,
  minkChargesCredits: boolean,
): number | null {
  const limits = PLAN_LIMITS[plan];
  return minkChargesCredits
    ? limits.aiCreditsPerMonth
    : limits.aiGenerationsPerMonth;
}

export const PLAN_FEATURE_MATRIX: readonly PlanMatrixSection[] = [
  {
    title: "Storefront & catalogue",
    rows: [
      {
        label: "Hosted storefront and StoreMink subdomain",
        free: true,
        basic: true,
        pro: true,
      },
      {
        label: "Themes and visual page builder",
        free: true,
        basic: true,
        pro: true,
      },
      {
        label: "Products",
        free: String(PLAN_LIMITS.free.maxProducts),
        basic: String(PLAN_LIMITS.basic.maxProducts),
        pro: "Unlimited",
      },
      {
        label: "Custom HTML, CSS and JavaScript sections",
        free: false,
        basic: PLAN_LIMITS.basic.customCode,
        pro: PLAN_LIMITS.pro.customCode,
      },
      {
        label: "Custom domain",
        free: false,
        basic: false,
        pro: PLAN_LIMITS.pro.customDomain,
      },
      {
        label: "Remove Powered by StoreMink badge",
        free: PLAN_LIMITS.free.removeBadge,
        basic: PLAN_LIMITS.basic.removeBadge,
        pro: PLAN_LIMITS.pro.removeBadge,
      },
    ],
  },
  {
    title: "Selling & fulfilment",
    rows: [
      { label: "Cash on delivery", free: true, basic: true, pro: true },
      {
        label: "Online payments (your own gateway)",
        free: PLAN_LIMITS.free.onlinePayments,
        basic: PLAN_LIMITS.basic.onlinePayments,
        pro: PLAN_LIMITS.pro.onlinePayments,
      },
      {
        label: "GST invoices and tax classes",
        free: true,
        basic: true,
        pro: true,
      },
      {
        label: "Inventory, orders and returns",
        free: true,
        basic: true,
        pro: true,
      },
      {
        label: "Shiprocket integration",
        free: PLAN_LIMITS.free.shippingIntegration,
        basic: PLAN_LIMITS.basic.shippingIntegration,
        pro: PLAN_LIMITS.pro.shippingIntegration,
      },
      { label: "Point of Sale", free: false, basic: false, pro: true },
      {
        label: "Multi-location stock, transfers and store pickup",
        free: false,
        basic: false,
        pro: true,
      },
      {
        label: "Included POS locations",
        free: "—",
        basic: "—",
        pro: String(PLAN_LIMITS.pro.posLocationsIncluded),
      },
      {
        label: "Authorised tills per location",
        free: "—",
        basic: "—",
        pro: String(PLAN_LIMITS.pro.posDevicesPerLocation),
      },
    ],
  },
  {
    title: "Customers & marketing",
    rows: [
      {
        label: "Customer accounts, reviews and enquiries",
        free: true,
        basic: true,
        pro: true,
      },
      {
        label: "Customer blog submissions",
        free: PLAN_LIMITS.free.customerBlogSubmissions,
        basic: PLAN_LIMITS.basic.customerBlogSubmissions,
        pro: PLAN_LIMITS.pro.customerBlogSubmissions,
      },
      {
        label: "Customer groups",
        free: PLAN_LIMITS.free.customerGroups,
        basic: PLAN_LIMITS.basic.customerGroups,
        pro: PLAN_LIMITS.pro.customerGroups,
      },
      {
        label: "Active coupons",
        free: String(PLAN_LIMITS.free.maxActiveCoupons),
        basic: "Unlimited",
        pro: "Unlimited",
      },
      {
        label: "Coupon email campaigns",
        free: false,
        basic: false,
        pro: PLAN_LIMITS.pro.emailCampaigns,
      },
    ],
  },
  {
    title: "Team, analytics & AI",
    rows: [
      {
        label: "Staff accounts (including owner)",
        free: String(PLAN_LIMITS.free.maxStaff),
        basic: String(PLAN_LIMITS.basic.maxStaff),
        pro: "Unlimited",
      },
      {
        label: "Custom roles and permissions",
        free: PLAN_LIMITS.free.customRoles,
        basic: PLAN_LIMITS.basic.customRoles,
        pro: PLAN_LIMITS.pro.customRoles,
      },
      { label: "Core analytics dashboard", free: true, basic: true, pro: true },
      {
        label: "Custom dashboard, detailed reports and Search Console",
        free: false,
        basic: true,
        pro: true,
      },
      {
        label: "GA4, Meta Pixel, conversion and gross margin analytics",
        free: false,
        basic: false,
        pro: true,
      },
      {
        label: "Included Mink credits each month",
        free: String(PLAN_LIMITS.free.aiGenerationsPerMonth),
        basic: String(PLAN_LIMITS.basic.aiGenerationsPerMonth),
        pro: String(PLAN_LIMITS.pro.aiGenerationsPerMonth),
      },
      {
        label: "Buy additional Mink credits",
        free: true,
        basic: true,
        pro: true,
      },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Expiry warnings (notifications §22 — "fire on the crossing, not the state")
// ---------------------------------------------------------------------------

/** How many days ahead a merchant is told their timed plan is about to lapse. */
export const EXPIRY_WARN_DAYS = [7, 1] as const;

/**
 * The half-open window `(from, to]` of expiry timestamps that the `days`-ahead
 * warning covers on a run at `now`. PURE, so the once-only property is testable.
 *
 * Each horizon is a 24-HOUR BAND, not "≤ N days away". The cron runs daily, so
 * a band matches each store exactly once per horizon and needs no "already
 * warned" column to stay idempotent — whereas "≤ 7 days" would re-warn every
 * single day for a week, which is how a warning becomes noise.
 *
 * The trade-off is that a skipped cron day skips that horizon's warning. That's
 * acceptable: the backstop (the downgrade email when the plan actually lapses)
 * is unconditional, and the two horizons mean one missed run rarely silences
 * both.
 */
export function expiryWarnWindow(
  now: Date,
  days: number,
): { from: string; to: string } {
  const DAY_MS = 86_400_000;
  return {
    from: new Date(now.getTime() + (days - 1) * DAY_MS).toISOString(),
    to: new Date(now.getTime() + days * DAY_MS).toISOString(),
  };
}
