import type { RoutingScope } from "./routing";
// ---------------------------------------------------------------------------
// Event registry — the single source of truth for everything that can happen
// on StoreMink and who hears about it.
//
// The model has two halves, and keeping them apart is what makes "notify on
// every activity" survivable:
//
//   • EVERY event in this catalog is RECORDED in activity_events. That is the
//     audit trail (/dashboard/logs) — complete by construction.
//   • Only events with a non-empty `audiences` entry are FANNED OUT into
//     someone's inbox. An event with `audiences: {}` is audit-only: visible in
//     the feed, silent in the bell. That is how a busy store gets a full
//     history without 400 unread badges a day.
//
// Adding a notification is therefore ONE entry here: the preferences matrix,
// the routing, and the settings UI all derive from this list — exactly like
// permissions.ts and lib/settings/registry.ts.
//
// Pure module (no server imports) so server actions, the client preference
// editor, and tests can all import it.
// ---------------------------------------------------------------------------

/** Who a notification can be routed to. */
export type Audience = "store-admins" | "customer" | "operators";

/** Delivery channels. Add one here + a column in notification_preferences. */
export type Channel = "inApp" | "email";

export type Severity = "info" | "success" | "warning" | "critical";

/** Email batching. In-app delivery is always instant. */
export type Digest = "instant" | "hourly" | "daily";
export const DIGESTS: readonly Digest[] = ["instant", "hourly", "daily"];

export interface ChannelDefaults {
  inApp: boolean;
  email: boolean;
}

/** Display grouping in the preferences matrix + the activity feed filters. */
export type EventGroup =
  | "Orders"
  | "Inventory"
  | "Catalog"
  | "Customers"
  | "Content"
  | "Marketing"
  | "Team & security"
  | "Plan & billing"
  | "Platform";

export const EVENT_GROUPS: readonly EventGroup[] = [
  "Orders",
  "Inventory",
  "Catalog",
  "Customers",
  "Content",
  "Marketing",
  "Team & security",
  "Plan & billing",
  "Platform",
];

export interface EventDef {
  key: EventKey;
  /** Short label shown in the settings matrix and the feed filter. */
  label: string;
  description: string;
  group: EventGroup;
  /**
   * Dashboard permission section that governs this event (permissions.ts).
   * Doubles as the ROUTING rule for `store-admins`: only admins who may
   * `view` this section are notified, so a blog editor never gets paged about
   * payouts. Deriving recipients from the existing permission map means there
   * is no second recipient config to drift out of sync.
   */
  section: string;
  severity: Severity;
  /**
   * Who is notified, and the default channels per audience. Empty = audit-only
   * (recorded in the feed, no inbox rows).
   */
  audiences: Partial<Record<Audience, ChannelDefaults>>;
  /**
   * True when this event can carry a `locationId` — i.e. some emitter passes
   * one. Only these can meaningfully use the `event_location` routing scope,
   * so the console hides that control for everything else rather than offering
   * a switch that would do nothing (lib/notifications/routing.ts).
   */
  hasLocation?: boolean;
  /**
   * The routing scope to use when the merchant has not chosen one.
   *
   * ★ ONLY FOR EVENTS THAT ARE INHERENTLY ABOUT ONE SHOP. A collection is
   * physically at a location, so the people who need to act on it are the ones
   * standing in that shop — narrowing it is the useful default. `order.placed`
   * deliberately does NOT set this: it fires for every order including
   * deliveries, so narrowing it would change who hears about ordinary orders
   * for every existing store (roadmap invariant 1).
   */
  defaultScope?: RoutingScope;
  /**
   * False = the merchant cannot switch it off. Reserved for events a store
   * owner must not be able to go blind on (role changes, failed billing,
   * password changes) — the ones that matter in a dispute or a breach.
   * Defaults to true.
   */
  configurable?: boolean;
}

export const EVENT_KEYS = [
  // ── Orders ──────────────────────────────────────────────────────────────
  "order.placed",
  "order.status_changed",
  "order.cancellation_requested",
  "order.cancellation_declined",
  "order.cancelled",
  "order.payment_received",
  "order.payment_failed",
  "order.refund_issued",
  "order.return_requested",
  "order.return_approved",
  "order.return_rejected",
  "order.exchange_ready",
  "order.ready_for_pickup",
  "order.collected",
  "order.pickup_expiring",
  "order.pickup_expired",
  // ── Inventory ───────────────────────────────────────────────────────────
  "inventory.low_stock",
  "inventory.out_of_stock",
  "inventory.adjusted",
  // ── Catalog ─────────────────────────────────────────────────────────────
  "product.created",
  "product.updated",
  "product.deleted",
  // ── Customers ───────────────────────────────────────────────────────────
  "customer.signed_up",
  "customer.review_submitted",
  "enquiry.received",
  // ── Content ─────────────────────────────────────────────────────────────
  "blog.submitted",
  "blog.published",
  "blog.approved",
  "blog.rejected",
  "blog.comment_posted",
  "page.published",
  // ── Marketing ───────────────────────────────────────────────────────────
  "coupon.created",
  "campaign.sent",
  // ── Team & security ─────────────────────────────────────────────────────
  "admin.invited",
  "admin.role_changed",
  "admin.removed",
  "security.password_changed",
  "settings.changed",
  "store.created",
  "store.domain_live",
  "store.domain_reverted",
  // ── Plan & billing ──────────────────────────────────────────────────────
  "store.comp_ended",
  "plan.changed",
  "plan.expiring",
  "subscription.invoice_due",
  "subscription.payment_failed",
  "ai.credits_low",
  "ai.credits_purchased",
  "mink.workflow_completed",
  "mink.watch_ready",
  // ── Data (CSV import/export) ────────────────────────────────────────────
  "data.import_started",
  "data.imported",
  "data.exported",
  // ── Platform (store_id IS NULL — StoreMink operators) ───────────────────
  "platform.store_created",
  "platform.store_suspended",
  "platform.plan_changed",
  "platform.domain_verified",
] as const;

export type EventKey = (typeof EVENT_KEYS)[number];

// Channel shorthands, so the catalog below reads as data rather than braces.
const OFF: ChannelDefaults = { inApp: false, email: false };
const IN_APP: ChannelDefaults = { inApp: true, email: false };
const BOTH: ChannelDefaults = { inApp: true, email: true };

export const EVENTS: readonly EventDef[] = [
  // ── Orders ──────────────────────────────────────────────────────────────
  {
    key: "order.placed",
    label: "New order",
    description: "A shopper completed checkout.",
    group: "Orders",
    // placePosSale passes the register's location; placeOrder passes the
    // fulfilment location Phase D resolves.
    hasLocation: true,
    section: "orders",
    severity: "success",
    audiences: { "store-admins": BOTH, customer: BOTH },
  },
  {
    key: "order.ready_for_pickup",
    label: "Ready to collect",
    description: "A pickup order has been packed and is waiting at the shop.",
    group: "Orders",
    section: "orders",
    severity: "info",
    hasLocation: true,
    // Pickup is inherently about ONE shop; safe to default because no
    // store had pickup enabled when this shipped (owner, 2026-08-09).
    defaultScope: "event_location" as const,
    // The SHOPPER is the point of this one — they need to know it's there.
    // Staff get it in-app so the queue stays honest without a mail each time.
    audiences: { "store-admins": IN_APP, customer: BOTH },
  },
  {
    key: "order.collected",
    label: "Order collected",
    description: "A shopper picked their order up from the shop.",
    group: "Orders",
    section: "orders",
    severity: "info",
    hasLocation: true,
    // Pickup is inherently about ONE shop; safe to default because no
    // store had pickup enabled when this shipped (owner, 2026-08-09).
    defaultScope: "event_location" as const,
    audiences: { "store-admins": IN_APP, customer: BOTH },
  },
  {
    key: "order.pickup_expiring",
    label: "Collection expiring",
    description: "A pickup order is close to its collection deadline.",
    group: "Orders",
    section: "orders",
    severity: "warning",
    hasLocation: true,
    // Pickup is inherently about ONE shop; safe to default because no
    // store had pickup enabled when this shipped (owner, 2026-08-09).
    defaultScope: "event_location" as const,
    audiences: { customer: BOTH },
  },
  {
    key: "order.pickup_expired",
    label: "Collection expired",
    description:
      "Nobody collected a pickup order in time — it was cancelled and its stock returned.",
    group: "Orders",
    section: "orders",
    severity: "warning",
    hasLocation: true,
    // Pickup is inherently about ONE shop; safe to default because no
    // store had pickup enabled when this shipped (owner, 2026-08-09).
    defaultScope: "event_location" as const,
    audiences: { "store-admins": BOTH, customer: BOTH },
  },
  {
    key: "order.status_changed",
    label: "Order status updated",
    description: "An order moved to processing, shipped, or delivered.",
    group: "Orders",
    section: "orders",
    severity: "info",
    audiences: { "store-admins": IN_APP, customer: BOTH },
  },
  {
    key: "order.cancellation_requested",
    label: "Cancellation requested",
    description: "A customer asked to cancel an order and is awaiting review.",
    group: "Orders",
    section: "orders",
    severity: "warning",
    audiences: { "store-admins": BOTH },
  },
  {
    key: "order.cancellation_declined",
    label: "Cancellation declined",
    description:
      "A merchant declined a customer's request to cancel an order. The order stays active.",
    group: "Orders",
    section: "orders",
    severity: "info",
    // ★ THE CUSTOMER IS THE POINT. They asked and are waiting; a decision they
    // are never told about reads as being ignored, and the merchant's reason is
    // what stops the next message being a complaint. The team gets it in-app
    // only — they made the decision, so mailing it back to them is noise.
    audiences: { "store-admins": IN_APP, customer: BOTH },
  },
  {
    key: "order.cancelled",
    label: "Order cancelled",
    description:
      "An order was cancelled by the customer, an admin, or the system.",
    group: "Orders",
    section: "orders",
    severity: "warning",
    audiences: { "store-admins": IN_APP, customer: BOTH },
  },
  {
    key: "order.payment_received",
    label: "Payment received",
    description: "An online payment was captured for an order.",
    group: "Orders",
    section: "orders",
    severity: "success",
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "order.payment_failed",
    label: "Payment failed",
    description: "An online payment failed or was abandoned at checkout.",
    group: "Orders",
    section: "orders",
    severity: "critical",
    audiences: { "store-admins": BOTH },
  },
  {
    key: "order.refund_issued",
    label: "Refund issued",
    description: "A refund was sent back to the customer's payment method.",
    group: "Orders",
    section: "orders",
    severity: "info",
    audiences: { "store-admins": IN_APP, customer: BOTH },
  },
  {
    key: "order.return_requested",
    label: "Return requested",
    description: "A customer asked to send something back.",
    group: "Orders",
    section: "orders",
    severity: "warning",
    // Team only, and by EMAIL: a request nobody sees is a customer waiting.
    // The shopper already knows — they just pressed the button — so telling
    // them their own action happened is noise.
    audiences: { "store-admins": BOTH },
  },
  {
    key: "order.return_approved",
    label: "Return approved",
    description:
      "A return was accepted. The customer is told what to send back and what they'll get.",
    group: "Orders",
    section: "orders",
    severity: "success",
    audiences: { "store-admins": IN_APP, customer: BOTH },
  },
  {
    key: "order.return_rejected",
    label: "Return declined",
    description: "A return was declined, with the store's reason.",
    group: "Orders",
    section: "orders",
    severity: "warning",
    audiences: { "store-admins": IN_APP, customer: BOTH },
  },
  {
    key: "order.exchange_ready",
    label: "Exchange on its way",
    description: "Returned goods arrived and the replacement order was raised.",
    group: "Orders",
    section: "orders",
    severity: "success",
    audiences: { "store-admins": IN_APP, customer: BOTH },
  },

  // ── Inventory ───────────────────────────────────────────────────────────
  {
    key: "inventory.low_stock",
    label: "Low stock",
    description: "An item fell to or below its low-stock threshold.",
    group: "Inventory",
    section: "inventory",
    severity: "warning",
    audiences: { "store-admins": BOTH },
  },
  {
    key: "inventory.out_of_stock",
    label: "Out of stock",
    description: "An item sold out and is no longer purchasable.",
    group: "Inventory",
    section: "inventory",
    severity: "critical",
    audiences: { "store-admins": BOTH },
  },
  {
    key: "inventory.adjusted",
    // POS inventory and the dashboard's location selector both target a shop.
    hasLocation: true,
    label: "Stock adjusted",
    description: "Stock was changed manually or in bulk. Recorded for audit.",
    group: "Inventory",
    section: "inventory",
    severity: "info",
    audiences: {},
  },

  // ── Catalog ─────────────────────────────────────────────────────────────
  {
    key: "product.created",
    label: "Product created",
    description: "A new product was added to the catalog.",
    group: "Catalog",
    section: "products",
    severity: "info",
    audiences: {},
  },
  {
    key: "product.updated",
    label: "Product updated",
    description: "A product's details, price, or status changed.",
    group: "Catalog",
    section: "products",
    severity: "info",
    audiences: {},
  },
  {
    key: "product.deleted",
    label: "Product deleted",
    description: "A product was removed from the catalog.",
    group: "Catalog",
    section: "products",
    severity: "warning",
    audiences: { "store-admins": IN_APP },
  },

  // ── Customers ───────────────────────────────────────────────────────────
  {
    key: "customer.signed_up",
    label: "New customer",
    description: "A shopper created an account on your storefront.",
    group: "Customers",
    section: "users",
    severity: "info",
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "customer.review_submitted",
    label: "New product review",
    description: "A customer left a review on one of your products.",
    group: "Customers",
    section: "products",
    severity: "info",
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "enquiry.received",
    label: "New enquiry",
    description: "Someone submitted the contact / enquiry form.",
    group: "Customers",
    section: "enquiries",
    severity: "info",
    audiences: { "store-admins": BOTH },
  },

  // ── Content ─────────────────────────────────────────────────────────────
  {
    key: "blog.submitted",
    label: "Blog submitted for review",
    description: "A customer submitted a blog post that needs approval.",
    group: "Content",
    section: "blogs",
    severity: "info",
    audiences: { "store-admins": BOTH },
  },
  {
    key: "blog.published",
    label: "Blog published",
    description: "A blog post went live on the storefront.",
    group: "Content",
    section: "blogs",
    severity: "info",
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "blog.approved",
    label: "Blog approved",
    description: "A customer's submitted post was approved and published.",
    group: "Content",
    section: "blogs",
    severity: "success",
    audiences: { customer: BOTH },
  },
  {
    key: "blog.rejected",
    label: "Blog rejected",
    description: "A customer's submitted post was declined.",
    group: "Content",
    section: "blogs",
    severity: "info",
    audiences: { customer: BOTH },
  },
  {
    key: "blog.comment_posted",
    label: "New blog comment",
    description: "Someone commented on one of your blog posts.",
    group: "Content",
    section: "blogs",
    severity: "info",
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "page.published",
    label: "Page published",
    description: "A page was published from the website builder.",
    group: "Content",
    section: "builder",
    severity: "info",
    audiences: { "store-admins": OFF },
  },

  // ── Marketing ───────────────────────────────────────────────────────────
  {
    key: "coupon.created",
    label: "Coupon created",
    description: "A new discount coupon was created.",
    group: "Marketing",
    section: "marketing",
    severity: "info",
    audiences: {},
  },
  {
    key: "campaign.sent",
    label: "Email campaign sent",
    description: "A coupon email campaign finished sending.",
    group: "Marketing",
    section: "marketing",
    severity: "info",
    audiences: { "store-admins": IN_APP },
  },

  // ── Team & security ─────────────────────────────────────────────────────
  {
    key: "admin.invited",
    label: "Team member invited",
    description: "A staff member was invited to this store's dashboard.",
    group: "Team & security",
    section: "admins",
    severity: "info",
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "admin.role_changed",
    label: "Team member's role changed",
    description: "A staff member's role or permissions were changed.",
    group: "Team & security",
    section: "admins",
    severity: "warning",
    audiences: { "store-admins": BOTH },
    // Not switchable: silently changing who can do what is exactly the event
    // an owner must never be able to miss.
    configurable: false,
  },
  {
    key: "admin.removed",
    label: "Team member removed",
    description: "A staff member lost access to this store.",
    group: "Team & security",
    section: "admins",
    severity: "warning",
    audiences: { "store-admins": BOTH },
    configurable: false,
  },
  {
    key: "security.password_changed",
    label: "Password changed",
    description: "An account password was changed or reset.",
    group: "Team & security",
    section: "settings",
    severity: "warning",
    audiences: { "store-admins": BOTH },
    configurable: false,
  },
  {
    key: "settings.changed",
    label: "Store settings changed",
    description: "A store setting or feature toggle was updated.",
    group: "Team & security",
    section: "settings",
    severity: "info",
    audiences: {},
  },

  // ── Plan & billing ──────────────────────────────────────────────────────
  {
    key: "store.created",
    label: "Store created",
    description: "Welcome mail for a merchant who has just finished signup.",
    group: "Team & security",
    section: "settings",
    severity: "success",
    // BOTH, and the ONLY thing that greets a new merchant. Store creation used
    // to emit `platform.store_created` alone — operators, in-app — so the
    // person who had just signed up received nothing at all: no confirmation,
    // no store address, no next step.
    audiences: { "store-admins": BOTH },
    // Not switchable: a merchant cannot have turned this off before they had
    // an account to turn it off in.
    configurable: false,
  },
  {
    key: "store.domain_live",
    label: "Custom domain live",
    description: "This store is now being served on its own domain.",
    group: "Team & security",
    section: "settings",
    severity: "success",
    // BOTH, and EMAIL is the point. Connecting a domain finishes in the
    // background — the certificate routinely issues long after the merchant has
    // closed the dashboard (CODEBASE.md §30) — so without a mail nobody is told
    // the thing they were waiting for happened. They would have to keep going
    // back to the settings page to guess.
    //
    // The operator-facing `platform.domain_verified` is the SAME moment for a
    // different audience, exactly as store.created / platform.store_created are.
    // Not duplication: one is a merchant milestone, the other is console
    // telemetry, and they carry different copy to different inboxes.
    audiences: { "store-admins": BOTH },
  },
  {
    key: "store.domain_reverted",
    label: "Custom domain stopped working",
    description:
      "A live custom domain failed repeated checks, so the store is back on its StoreMink address.",
    group: "Team & security",
    section: "settings",
    severity: "warning",
    // BOTH, and NOT configurable. The store's public address has just changed
    // underneath the merchant — every link they have shared now redirects
    // somewhere else. There is no version of "they opted out of hearing this"
    // that is defensible, and email is the only channel that reaches someone who
    // is not looking at the dashboard.
    audiences: { "store-admins": BOTH },
    configurable: false,
  },
  {
    key: "store.comp_ended",
    label: "Free plan upgrade ended",
    description:
      "A comped plan reached the end of its window; the store is back on the plan it pays for.",
    group: "Plan & billing",
    section: "ai",
    severity: "info",
    // ★ BOTH channels, and NOT configurable. What the store can DO changed
    // while nobody was looking — POS, analytics and campaigns may all have just
    // switched off. Email is the only channel that reaches someone who is not
    // in the dashboard.
    //
    // ★ Its OWN event rather than `plan.changed`: this is a gift ending, not a
    // downgrade, and the merchant did nothing wrong. Reusing the downgrade copy
    // would tell a paying Basic subscriber they had been demoted.
    audiences: { "store-admins": BOTH },
    configurable: false,
  },
  {
    key: "plan.changed",
    label: "Plan changed",
    description: "This store moved to a different StoreMink plan.",
    group: "Plan & billing",
    section: "ai",
    severity: "info",
    // IN-APP ONLY, deliberately. StoreMink's own billing sender
    // (lib/email/billing-emails.ts) already mails the merchant from
    // billing@storemink.com with the receipt/activation details — a second
    // mail from the store's own address saying the same thing is noise, and
    // it's platform correspondence, not the store's. Same for the two below.
    audiences: { "store-admins": IN_APP },
    configurable: false,
  },
  {
    key: "plan.expiring",
    label: "Plan expiring soon",
    description: "A timed plan is about to lapse back to Free.",
    group: "Plan & billing",
    section: "ai",
    severity: "warning",
    // The exception to the rule above: nothing else warns BEFORE a plan
    // lapses, so this notification is the only sender and keeps its email.
    audiences: { "store-admins": BOTH },
  },
  {
    key: "subscription.invoice_due",
    label: "Renewal invoice issued",
    description: "A subscription invoice was raised for the next cycle.",
    group: "Plan & billing",
    section: "ai",
    severity: "info",
    // In-app only — renewalDueTemplate already mails this one from
    // billing@storemink.com (the dedicated-sender rule above). NOT configurable:
    // while automatic collection is gated, this notice IS how a merchant learns
    // they have to pay, and an opt-out would let someone silently lose their
    // plan for a bill they switched off.
    audiences: { "store-admins": IN_APP },
    configurable: false,
  },
  {
    key: "subscription.payment_failed",
    label: "Subscription payment failed",
    description: "A recurring plan payment could not be collected.",
    group: "Plan & billing",
    section: "ai",
    severity: "critical",
    // In-app only — paymentFailedTemplate already mails this one.
    audiences: { "store-admins": IN_APP },
    configurable: false,
  },
  {
    key: "ai.credits_low",
    label: "Mink credits running low",
    description: "Your included Mink credits are nearly used up.",
    group: "Plan & billing",
    section: "ai",
    severity: "warning",
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "ai.credits_purchased",
    label: "Mink credits purchased",
    description: "A credit pack was bought and added to your balance.",
    group: "Plan & billing",
    section: "ai",
    severity: "success",
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "mink.watch_ready",
    label: "Mink watch update",
    description:
      "A personally enabled watch has new evidence or a scheduled brief.",
    group: "Plan & billing",
    section: "dashboard",
    severity: "info",
    audiences: { "store-admins": IN_APP },
    configurable: false,
  },
  {
    key: "mink.workflow_completed",
    label: "Mink workflow ready",
    description: "A requested Mink background workflow finished safely.",
    group: "Plan & billing",
    section: "dashboard",
    severity: "success",
    audiences: { "store-admins": IN_APP },
    configurable: false,
  },

  // ── Data (CSV import/export) ─────────────────────────────────────────────
  //
  // ★ ONE EVENT PER JOB, NOT PER ROW. A 2,000-product import emits ONE
  // `data.imported`, because the alternative is 2,000 activity rows burying
  // every other thing that happened that day and 2,000 chances to page the
  // team. The per-row detail already has a better home: the job's own error
  // log, which is searchable and doesn't expire.
  {
    key: "data.import_started",
    label: "Import started",
    description:
      "A CSV import began. Links straight to its log, which fills in as it runs.",
    group: "Catalog",
    section: "activity",
    severity: "info",
    // ★ IN-APP ONLY, AND NOT CONFIGURABLE OFF THE EMAIL — there is no email to
    // turn off. Mailing "your import started" and then "your import finished"
    // is the pattern §24 says trains people to ignore a channel: two messages
    // for one action, the first of which is obsolete by the time it arrives.
    //
    // It exists at all because an import now runs in the BACKGROUND: the
    // merchant is redirected to its log, but they are free to navigate away,
    // and without a record there would be nothing to click to get back. The
    // finish event alone can't do that — it doesn't exist yet while they're
    // wondering where their import went.
    audiences: { "store-admins": IN_APP },
  },
  {
    key: "data.imported",
    label: "Import finished",
    description:
      "A CSV import finished. Says what was created, updated and rejected.",
    group: "Catalog",
    // Not `products`: an import can touch coupons or stock, and the person who
    // should hear about a bulk change to the shop's data is whoever watches
    // its audit trail.
    section: "activity",
    severity: "info",
    audiences: { "store-admins": BOTH },
  },
  {
    key: "data.exported",
    label: "Data exported",
    description:
      "Someone downloaded a CSV of your store's data. Recorded for audit.",
    group: "Catalog",
    section: "activity",
    severity: "info",
    // In-app only, deliberately. An export is worth RECORDING — an orders file
    // carries every customer's name, address and phone number, and "who took a
    // copy of that, and when" is a question you only get to ask afterwards if
    // someone wrote it down. But it is a routine action a merchant may do
    // weekly, so emailing about it would train them to ignore the log.
    audiences: { "store-admins": IN_APP },
  },

  // ── Platform (operators only; these events carry store_id = NULL) ────────
  {
    key: "platform.store_created",
    label: "Store created",
    description: "A merchant finished signup and created a store.",
    group: "Platform",
    section: "activity",
    severity: "success",
    audiences: { operators: IN_APP },
  },
  {
    key: "platform.store_suspended",
    label: "Store suspended",
    description: "A store was suspended or reinstated by an operator.",
    group: "Platform",
    section: "activity",
    severity: "warning",
    audiences: { operators: IN_APP },
  },
  {
    key: "platform.plan_changed",
    label: "Store plan changed",
    description: "An operator granted, upgraded, or downgraded a store's plan.",
    group: "Platform",
    section: "activity",
    severity: "info",
    audiences: { operators: IN_APP },
  },
  {
    key: "platform.domain_verified",
    label: "Custom domain verified",
    description: "A store's custom domain passed DNS verification.",
    group: "Platform",
    section: "activity",
    severity: "success",
    audiences: { operators: IN_APP },
  },
];

const EVENT_BY_KEY = new Map<string, EventDef>(EVENTS.map((e) => [e.key, e]));

// ── URL forms ──────────────────────────────────────────────────────────────
// Event keys contain dots (`order.placed`), which must NEVER appear in a
// dashboard URL: proxy.ts exempts asset-like paths from the session gate, and
// a dotted segment used to slip through it. So routes address a notification by
// its SLUG form, and the reverse lookup scans the registry rather than trying
// to invert the transformation — a lookup can't be tricked by a key that
// happens to contain the separator.

/** `order.placed` → `order-placed`, for use in a URL segment. */
export function eventKeySlug(key: string): string {
  return key.replace(/\./g, "-");
}

/** The event whose slug form matches, or undefined. */
export function eventFromSlug(slug: string): EventDef | undefined {
  if (!slug) return undefined;
  const wanted = slug.toLowerCase();
  return EVENTS.find((e) => eventKeySlug(e.key) === wanted);
}

export function getEventDef(key: string): EventDef | undefined {
  return EVENT_BY_KEY.get(key);
}

export function isEventKey(key: unknown): key is EventKey {
  return typeof key === "string" && EVENT_BY_KEY.has(key);
}

/** Events a store's admins can actually be notified about, grouped for the UI. */
export function storeAdminEvents(): EventDef[] {
  return EVENTS.filter(
    (e) => e.audiences["store-admins"] !== undefined && e.group !== "Platform",
  );
}

/**
 * Everything a MERCHANT can configure — anything reaching their team OR their
 * customers. This is what the console lists.
 *
 * Distinct from storeAdminEvents(): a shopper-facing notification like
 * "blog.approved" has no team audience at all, and leaving it out of the
 * console is precisely why merchants couldn't find where to edit the emails
 * their customers receive.
 */
export function merchantEvents(): EventDef[] {
  return EVENTS.filter(
    (e) =>
      e.group !== "Platform" &&
      (e.audiences["store-admins"] !== undefined ||
        e.audiences.customer !== undefined),
  );
}

/** Group → events, preserving EVENT_GROUPS order. Empty groups are dropped. */
export function groupEvents(defs: readonly EventDef[]): {
  group: EventGroup;
  events: EventDef[];
}[] {
  return EVENT_GROUPS.map((group) => ({
    group,
    events: defs.filter((d) => d.group === group),
  })).filter((g) => g.events.length > 0);
}

/** A stored preference row, flattened. NULL/undefined = "no opinion here". */
export interface PreferenceOverride {
  inApp?: boolean | null;
  email?: boolean | null;
  digest?: Digest | null;
}

export interface ResolvedChannels {
  inApp: boolean;
  email: boolean;
  digest: Digest;
}

/**
 * Resolve what actually gets delivered, in precedence order:
 *   registry default  ←  store default  ←  the recipient's own override
 *
 * A non-configurable event ignores both overrides — that is the whole point of
 * the flag. Unknown audiences resolve to "deliver nothing", so a routing bug
 * can never fan an event out to people it was never meant for.
 */
export function resolveChannels(
  def: EventDef,
  audience: Audience,
  storePref?: PreferenceOverride | null,
  userPref?: PreferenceOverride | null,
): ResolvedChannels {
  const base = def.audiences[audience];
  if (!base) return { inApp: false, email: false, digest: "instant" };
  if (def.configurable === false) {
    return { inApp: base.inApp, email: base.email, digest: "instant" };
  }

  const pick = (channel: Channel): boolean => {
    const user = userPref?.[channel];
    if (typeof user === "boolean") return user;
    const store = storePref?.[channel];
    if (typeof store === "boolean") return store;
    return base[channel];
  };

  const digest = userPref?.digest ?? storePref?.digest ?? "instant";
  return {
    inApp: pick("inApp"),
    email: pick("email"),
    digest: DIGESTS.includes(digest) ? digest : "instant",
  };
}
