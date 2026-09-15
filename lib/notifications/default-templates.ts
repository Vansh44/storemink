// ---------------------------------------------------------------------------
// Default email copy for every notification.
//
// WHY THIS EXISTS: the bell needs one short line ("New order ORD10010004 ·
// ₹1,240"); an email needs a subject, an opening line, the details laid out so
// they can be scanned, and a reason to click. Using the bell's line as an email
// body left the console's Message box looking empty and the mail itself thin.
//
// The copy is TEMPLATE TEXT — the same {{tokens}} a merchant can edit — so what
// the console shows as the placeholder is exactly what would be sent, and
// "customise this" starts from something already good rather than a blank box.
//
// Bodies are built from the event's own declared variables (variables.ts), so a
// new event gets a sensible email for free and no template can reference a
// value its emitter doesn't provide.
//
// Pure module: no DB, no server imports.
// ---------------------------------------------------------------------------

import { getEventDef, type EventKey } from "./events";
import { refundCopy } from "./refund-copy";
import { BASE_VARIABLES, variablesFor } from "./variables";
import { HIDDEN_VARIABLES } from "./format";

/** Which audience the copy is written for. Team and customer read completely
 *  differently — "New order · ₹1,240 · from Priya S." vs "Thanks, we've got
 *  your order" — so the default copy is per audience, not one text reused. */
export type TemplateAudience = "team" | "customer";

const BASE_NAMES = new Set(BASE_VARIABLES.map((v) => v.name));

/**
 * Events whose email carries a rendered order summary (the emitter passes
 * `email:` to emitEvent — see EmitEventInput). For these the table below is the
 * detail, so the fact list must not repeat it.
 */
const HAS_ORDER_SUMMARY = new Set(["order.placed"]);

/** What that table already shows. Still valid {{tokens}} for a merchant who
 *  wants them; simply not repeated in the built-in copy. */
const SUMMARY_OWNED = new Set([
  "items",
  "total",
  "subtotal",
  "discount",
  "tax",
  "shipping",
]);

/** Opening line per event. Falls back to the registry description, which is
 *  already written as a sentence. */
const INTRO: Record<string, string> = {
  "order.placed": "You've received a new order.",
  "order.status_changed": "An order has moved to a new status.",
  "order.cancellation_requested":
    "A customer has asked to cancel an order. It's waiting for your review.",
  "order.cancelled": "An order has been cancelled.",
  "order.payment_received": "A payment has been captured.",
  "order.payment_failed":
    "An online payment didn't go through. The order is still unpaid.",
  "order.refund_issued": "A refund is on its way back to the customer.",
  "inventory.low_stock":
    "One of your items is running low. Restock it before it sells out.",
  "inventory.out_of_stock": "An item has sold out and can no longer be bought.",
  "product.deleted": "A product has been removed from your catalog.",
  "customer.signed_up": "A new customer has created an account on your store.",
  "customer.review_submitted": "A customer has left a review on your product.",
  "enquiry.received": "Someone has sent you a message through your store.",
  "blog.submitted":
    "A customer has submitted a blog post. It's waiting for approval.",
  "blog.published": "A blog post is now live on your storefront.",
  "blog.comment_posted": "Someone has commented on one of your posts.",
  "campaign.sent": "Your email campaign has finished sending.",
  "admin.invited": "A new team member has been invited to your dashboard.",
  "admin.role_changed": "A team member's role has changed.",
  "admin.removed": "A team member no longer has access to your store.",
  "security.password_changed":
    "An account password was changed. If this wasn't you, reset it now.",
  "plan.changed": "Your StoreMink plan has changed.",
  "plan.expiring":
    "Your plan is about to expire. Renew to keep your paid features.",
  "subscription.payment_failed":
    "We couldn't collect your plan payment. Update your payment method to avoid losing paid features.",
  "ai.credits_low": "Your included Mink credits are nearly used up.",
  "ai.credits_purchased": "Your Mink credits have been topped up.",
};

interface TemplateFact {
  label: string;
  token: string;
}

/**
 * `intro`/`closing` may be a function of the event's RAW payload when the
 * honest sentence depends on what actually happened — a refund's wording turns
 * on the method it was settled by, and the formatted `values` have already lost
 * the raw enum. Everything else stays a plain string.
 */
type BlueprintCopy = string | ((payload: Record<string, unknown>) => string);

interface TemplateBlueprint {
  subject: string;
  intro: BlueprintCopy;
  facts?: TemplateFact[];
  spotlight?: { label: string; token: string; hint?: string };
  closing?: BlueprintCopy;
}

/**
 * Customer transactional mail is hand-written. A generic event dump is fine
 * for an internal audit alert; it is not fine for a shopper waiting to learn
 * whether an order, return or refund is safe.
 *
 * The class names are progressively enhanced by lib/email/shell.ts. The
 * underlying headings, paragraphs and lists stay readable when a mail client
 * strips every style.
 */
const CUSTOMER_BLUEPRINTS: Partial<Record<EventKey, TemplateBlueprint>> = {
  "order.placed": {
    subject: "Order {{subject_label}} confirmed",
    intro:
      "Thank you for your order. We've received it and will keep you updated as it moves forward.",
    facts: [
      { label: "Order", token: "subject_label" },
      { label: "Payment", token: "payment_method" },
      { label: "Fulfilment", token: "fulfilment" },
      { label: "Placed", token: "date" },
    ],
    closing: "You can view the latest order status at any time.",
  },
  "order.status_changed": {
    subject: "Order {{subject_label}} is now {{status}}",
    intro: "Your order has moved to the next step.",
    facts: [
      { label: "Order", token: "subject_label" },
      { label: "Status", token: "status" },
      { label: "Payment status", token: "payment_status" },
      { label: "Updated", token: "date" },
    ],
    closing: "Open your order to see its complete timeline.",
  },
  "order.cancellation_declined": {
    subject: "Update on cancellation request · {{subject_label}}",
    intro:
      "We couldn't cancel this order, so it remains active and will continue to be processed.",
    facts: [
      { label: "Order", token: "subject_label" },
      { label: "Reason", token: "reason" },
      { label: "Decision made", token: "date" },
    ],
    closing:
      "If you need more help, reply to this email and the store team can review it with you.",
  },
  "order.cancelled": {
    subject: "Order {{subject_label}} was cancelled",
    intro: "This order has been cancelled and will not be fulfilled.",
    facts: [
      { label: "Order", token: "subject_label" },
      { label: "Reason", token: "reason" },
      { label: "Refund still due", token: "refund_due" },
      { label: "Cancelled", token: "date" },
    ],
    closing:
      "If money is still due back, the store will confirm the refund separately once it has been issued.",
  },
  "order.refund_issued": {
    subject: "Refund issued for order {{subject_label}}",
    // ★ Method-aware: this said "sent to your original payment method" for
    // every refund, including store credit, where no money leaves at all.
    intro: (p) =>
      `Your refund has been ${refundCopy(p.paymentMethod).destination}.`,
    facts: [
      { label: "Order", token: "subject_label" },
      { label: "Refund amount", token: "amount" },
      { label: "Issued", token: "date" },
    ],
    closing: (p) =>
      refundCopy(p.paymentMethod).bankDelay
        ? "Most banks show refunds within 5–7 working days. Your bank may take a little longer."
        : "",
  },
  "order.ready_for_pickup": {
    subject: "Order {{subject_label}} is ready for pickup",
    intro:
      "Your order is packed and waiting for you at the collection point below.",
    spotlight: {
      label: "Collection code",
      token: "collection_code",
      hint: "Show this code to the team when you arrive.",
    },
    facts: [
      { label: "Pickup location", token: "pickup_location" },
      { label: "Address", token: "pickup_address" },
      { label: "Order", token: "subject_label" },
    ],
    closing: "Open your order for the collection QR and latest details.",
  },
  "order.collected": {
    subject: "Order {{subject_label}} collected",
    intro: "Your pickup is complete. Thank you for shopping with us.",
    facts: [
      { label: "Order", token: "subject_label" },
      { label: "Collected from", token: "pickup_location" },
      { label: "Collected", token: "date" },
    ],
  },
  "order.pickup_expiring": {
    subject: "Reminder: collect order {{subject_label}} by {{expires_on}}",
    intro:
      "Your order is still waiting. Please collect it before the deadline so the items aren't returned to stock.",
    facts: [
      { label: "Pickup location", token: "pickup_location" },
      { label: "Address", token: "pickup_address" },
      { label: "Collect by", token: "expires_on" },
      { label: "Order", token: "subject_label" },
    ],
    closing: "Open your order for the collection code and QR.",
  },
  "order.pickup_expired": {
    subject: "Pickup order {{subject_label}} was cancelled",
    intro:
      "The collection window ended before this order was picked up, so it has been cancelled and the items were returned to stock.",
    facts: [
      { label: "Order", token: "subject_label" },
      { label: "Pickup location", token: "pickup_location" },
      { label: "Refund still due", token: "refund_due" },
      { label: "Cancelled", token: "date" },
    ],
    closing:
      "If you paid online, the store will confirm any refund separately once it has been issued.",
  },
  "order.return_approved": {
    subject: "Return approved · {{subject_label}}",
    intro: "Your return has been approved.",
    facts: [
      { label: "Order", token: "subject_label" },
      { label: "Expected refund", token: "refund_amount" },
      { label: "Deductions", token: "fees" },
      { label: "Store instructions", token: "note" },
    ],
    closing:
      "Open the return for its current status. A refund is confirmed separately after the returned items are received and checked.",
  },
  "order.return_rejected": {
    subject: "Return decision · {{subject_label}}",
    intro: "The store wasn't able to approve this return.",
    facts: [
      { label: "Order", token: "subject_label" },
      { label: "Reason", token: "note" },
      { label: "Decision made", token: "date" },
    ],
    closing:
      "Reply to this email if you need the store team to explain the decision.",
  },
  "order.exchange_ready": {
    subject: "Your exchange is on its way · {{exchange_ref}}",
    intro:
      "Your return has been received and the replacement order is ready to move forward.",
    facts: [
      { label: "Original order", token: "subject_label" },
      { label: "Replacement order", token: "exchange_ref" },
      { label: "Replacement items", token: "items" },
      { label: "Balance refunded", token: "refund_amount" },
    ],
    closing: "Open the replacement order to follow its progress.",
  },
  "blog.approved": {
    subject: "Your post is live · {{subject_label}}",
    intro: "Your post has been approved and published on the store.",
    facts: [
      { label: "Post", token: "subject_label" },
      { label: "Published", token: "date" },
    ],
    closing: "Open it to see the published version.",
  },
  "blog.rejected": {
    subject: "Update on your post · {{subject_label}}",
    intro: "Thanks for your submission. It wasn't published this time.",
    facts: [
      { label: "Post", token: "subject_label" },
      { label: "Reason", token: "reason" },
      { label: "Reviewed", token: "date" },
    ],
    closing: "You can update your draft and submit it again.",
  },
};

/** The team alerts that most often need an immediate, unambiguous action. */
const TEAM_BLUEPRINTS: Partial<Record<EventKey, TemplateBlueprint>> = {
  "order.placed": {
    subject: "New order {{subject_label}} · {{total}}",
    intro: "A new order is ready for review.",
    facts: [
      { label: "Order", token: "subject_label" },
      { label: "Customer", token: "actor_name" },
      { label: "Payment", token: "payment_method" },
      { label: "Fulfilment", token: "fulfilment" },
      { label: "Received", token: "date" },
    ],
  },
  "order.cancellation_requested": {
    subject: "Cancellation request · {{subject_label}}",
    intro:
      "A customer is waiting for you to approve or decline a cancellation.",
    facts: [
      { label: "Order", token: "subject_label" },
      { label: "Customer", token: "actor_name" },
      { label: "Reason", token: "reason" },
      { label: "Requested", token: "date" },
    ],
  },
  "order.payment_failed": {
    subject: "Payment failed · {{subject_label}}",
    intro: "An online payment didn't complete. The order remains unpaid.",
    facts: [
      { label: "Order", token: "subject_label" },
      { label: "Reason", token: "reason" },
      { label: "Failed", token: "date" },
    ],
  },
  "order.return_requested": {
    subject: "Return request · {{subject_label}}",
    intro: "A customer is waiting for you to review a return request.",
    facts: [
      { label: "Order", token: "subject_label" },
      { label: "Customer", token: "actor_name" },
      { label: "Items", token: "items" },
      { label: "Reason", token: "reason" },
      { label: "Potential refund", token: "refund_amount" },
      { label: "Requested", token: "date" },
    ],
  },
  "inventory.low_stock": {
    subject: "Low stock: {{subject_label}} · {{stock}} left",
    intro: "This item has reached its low-stock threshold.",
    facts: [
      { label: "Item", token: "subject_label" },
      { label: "Available", token: "stock" },
      { label: "Detected", token: "date" },
    ],
  },
  "inventory.out_of_stock": {
    subject: "Out of stock: {{subject_label}}",
    intro: "This item has sold out and can no longer be purchased.",
    facts: [
      { label: "Item", token: "subject_label" },
      { label: "Available", token: "stock" },
      { label: "Detected", token: "date" },
    ],
  },
};

/**
 * Events whose copy is HAND-WRITTEN rather than generated from their variables.
 *
 * The generated shape — an intro, then a Reference/Who/When fact list — is
 * right for a report ("stock is low", "a payment failed") and wrong for
 * anything a person is meant to feel something about. A welcome rendered as a
 * fact list reads like a receipt for having existed.
 *
 * Keep this map small. If an event only needs a better opening line, put it in
 * INTRO; this is for the handful that need a different SHAPE.
 */
const BESPOKE: Record<string, { subject: string; body: string }> = {
  "store.created": {
    subject: "{{subject_label}} is live on StoreMink",
    body: [
      "<p>Your store is ready — here it is:</p>",
      '<p><a href="{{store_url}}">{{store_url}}</a></p>',
      "<p>Three things worth doing next:</p>",
      "<ol>",
      "  <li><strong>Add your first product</strong> so there's something to sell.</li>",
      "  <li><strong>Make it yours</strong> — logo, colours and pages live in the website builder.</li>",
      "  <li><strong>Take a test order</strong> to see the whole flow end to end.</li>",
      "</ol>",
      "<p>Everything is editable later, including the store name and address.</p>",
    ].join("\n"),
  },
  // A milestone the merchant has usually been waiting days for, and the reason
  // they can walk away from the settings page at all. As a generated fact list
  // ("Domain / Store url / When") it would read like a status row rather than
  // the answer to "did it work?".
  "store.domain_live": {
    subject: "{{domain}} is live",
    body: [
      "<p>Your store is now open on your own domain:</p>",
      '<p><a href="{{store_url}}">{{store_url}}</a></p>',
      "<p>HTTPS is set up and renews on its own — there's nothing for you to maintain.</p>",
      "<p>Your original StoreMink address keeps working too, so any links you've already shared stay valid.</p>",
    ].join("\n"),
  },
  // Bad news, and it has to lead with what is still WORKING. A generated fact
  // list would open with "Domain: acme.com" and leave the merchant to work out
  // whether their shop is down — which is the only question they have.
  // ★ Bespoke, because the generated fact list would open with
  // "Comp plan: Pro" and leave the merchant to work out whether they have just
  // lost something they were paying for — which is their only question.
  "store.comp_ended": {
    subject: "Your free {{comp_plan}} upgrade has ended",
    body: [
      "<p><strong>Nothing is switched off that you pay for.</strong> Your free {{comp_plan}} upgrade has run its course, and your store is back on <strong>{{plan}}</strong> — the plan you were on all along.</p>",
      "<p>Your billing is unchanged: the free upgrade never replaced your own plan, so there is nothing to restart and nothing extra to pay.</p>",
      "<p>If you'd like to keep {{comp_plan}}, you can upgrade any time from Plans &amp; Billing.</p>",
    ].join("\n"),
  },
  "store.domain_reverted": {
    subject: "Action needed: {{domain}} has stopped working",
    body: [
      "<p><strong>Your store is still open.</strong> It's being served on your StoreMink address again:</p>",
      '<p><a href="{{store_url}}">{{store_url}}</a></p>',
      "<p>We checked <strong>{{domain}}</strong> several times over a few hours and couldn't reach it, so we moved your store back rather than leave it unreachable.</p>",
      "<p>{{reason}}</p>",
      "<p>This is almost always a DNS change at your domain provider. Open Settings → Domain in your dashboard to see the exact records to restore — your store will move back automatically once they're in place.</p>",
    ].join("\n"),
  },
};

/** Human label for a variable in the details list ("order_ref" → "Order ref"). */
function labelFor(name: string): string {
  return name
    .split("_")
    .map((word, i) => (i === 0 ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

export interface DefaultTemplate {
  subject: string;
  /** HTML. The merchant edits this directly; `inlineEmailStyles` in
   *  lib/email/notification-emails.ts styles the supported tags at send time. */
  body: string;
}

function hasValue(
  token: string,
  values: Record<string, string> | undefined,
): boolean {
  return !values || (values[token] ?? "").trim() !== "";
}

function renderFacts(
  facts: TemplateFact[],
  values: Record<string, string> | undefined,
): string {
  const rows = facts
    .filter((fact) => hasValue(fact.token, values))
    .map(
      (fact) =>
        `  <li class="email-detail"><strong class="email-label">${fact.label}</strong><br />{{${fact.token}}}</li>`,
    )
    .join("\n");
  return rows ? `<ul class="email-details">\n${rows}\n</ul>` : "";
}

function resolveCopy(
  copy: BlueprintCopy | undefined,
  payload: Record<string, unknown>,
): string {
  if (!copy) return "";
  return typeof copy === "function" ? copy(payload) : copy;
}

function renderBlueprint(
  blueprint: TemplateBlueprint,
  values: Record<string, string> | undefined,
  payload: Record<string, unknown>,
): DefaultTemplate {
  const intro = resolveCopy(blueprint.intro, payload);
  const closing = resolveCopy(blueprint.closing, payload);
  const spotlight =
    blueprint.spotlight && hasValue(blueprint.spotlight.token, values)
      ? [
          `<h2>${blueprint.spotlight.label}</h2>`,
          `<p class="email-code">{{${blueprint.spotlight.token}}}</p>`,
          blueprint.spotlight.hint
            ? `<p class="email-note">${blueprint.spotlight.hint}</p>`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "";

  return {
    subject: blueprint.subject,
    body: [
      `<p class="email-lead">${intro}</p>`,
      spotlight,
      renderFacts(blueprint.facts ?? [], values),
      closing ? `<p class="email-note">${closing}</p>` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * The built-in email copy for an event, as editable HTML template text.
 *
 * Customer transactions and the highest-action team alerts use a hand-written
 * blueprint. Everything else falls back to an opening paragraph, the event's
 * own facts as a detail card, and a closing line. Both deliberately use a small
 * vocabulary — `<p>`, `<ul>/<li>`, `<strong>` — so a merchant can edit the copy
 * confidently without knowing email HTML.
 *
 * The facts come from the event's declared variables, so a new event gets a
 * sensible email for free and no template can reference a value its emitter
 * doesn't provide.
 */
export function defaultEmailTemplate(
  eventKey: string,
  audience: TemplateAudience = "team",
  /**
   * ★ The values of a REAL send, if this is one. Given them, a fact whose value
   * is blank is dropped instead of rendering as a label above nothing — which
   * is how a "Ready to collect" email went out with "Pickup location" and
   * "Pickup address" as two empty rows.
   *
   * The generated list comes from the variable CATALOG, so it declares
   * everything an event COULD carry; whether a particular emitter supplies all
   * of it is a different question, and one only the send can answer. Omitted
   * by the console preview on purpose — a preview is showing which tokens
   * exist, so it should show them all.
   */
  values?: Record<string, string>,
  /** The event's RAW payload, for copy that must branch on an enum the
   *  formatted `values` have already turned into a display label. */
  payload?: Record<string, unknown> | null,
): DefaultTemplate {
  const def = getEventDef(eventKey);
  const label = def?.label ?? "Notification";
  const isCustomer = audience === "customer";

  const blueprint = isCustomer
    ? CUSTOMER_BLUEPRINTS[eventKey as EventKey]
    : TEAM_BLUEPRINTS[eventKey as EventKey];
  if (blueprint) return renderBlueprint(blueprint, values, payload ?? {});

  // Hand-written copy wins over the generated fact list (see BESPOKE).
  const bespoke = !isCustomer ? BESPOKE[eventKey] : undefined;
  if (bespoke) return bespoke;

  const intro = isCustomer
    ? "There's an update from the store."
    : (INTRO[eventKey] ??
      def?.description ??
      "Something happened in your store.");

  // Event-specific facts, in the order the variable catalog declares them.
  //
  // Two things are filtered out. HIDDEN_VARIABLES drops values folded into
  // another — `currency` rides on every amount, so a "Currency: INR" row is the
  // email saying it twice. SUMMARY_OWNED drops the ones the rendered order
  // summary already shows in full (lib/email/line-items.ts): listing "Items:
  // 4 items · Amul Taaza…" and "Total ₹343.00" directly above a table of the
  // same items and the same total is the duplication that makes an email look
  // auto-generated. The fact list keeps what the table doesn't carry —
  // reference, payment method, when.
  const summaryOwned = HAS_ORDER_SUMMARY.has(eventKey)
    ? SUMMARY_OWNED
    : new Set<string>();

  const facts: { label: string; token: string }[] = [
    { label: "Reference", token: "subject_label" },
    ...variablesFor(eventKey)
      .filter(
        (v) =>
          !BASE_NAMES.has(v.name) &&
          !HIDDEN_VARIABLES.has(v.name) &&
          !summaryOwned.has(v.name),
      )
      .map((v) => ({ label: labelFor(v.name), token: v.name })),
    // A shopper knows who they are; the team needs to know who acted.
    ...(isCustomer ? [] : [{ label: "Who", token: "actor_name" }]),
    { label: "When", token: "date" },
  ];

  const rows = facts
    .filter((f) => !values || (values[f.token] ?? "").trim() !== "")
    .map(
      (f) =>
        `  <li class="email-detail"><strong class="email-label">${f.label}</strong><br />{{${f.token}}}</li>`,
    )
    .join("\n");

  // No call-to-action here on purpose: renderNotificationEmail already appends
  // a real button (emailButton) from the notification's own url, so putting a
  // link in the editable copy too would give every email two of them.
  const action = isCustomer
    ? `<p>If anything looks wrong, just reply to this email and we'll sort it out.</p>`
    : `<p>Open it in your dashboard to take the next step.</p>`;

  return {
    subject: isCustomer
      ? `${label} · {{subject_label}}`
      : `${label}: {{subject_label}}`,
    body: [
      `<p class="email-lead">${intro}</p>`,
      '<ul class="email-details">',
      rows,
      "</ul>",
      action.replace("<p>", '<p class="email-note">'),
    ].join("\n"),
  };
}
