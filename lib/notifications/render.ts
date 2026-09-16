// ---------------------------------------------------------------------------
// Notification copy — turns a recorded event into the line a recipient reads.
//
// Pure and audience-aware: the same event says different things to the store
// ("New order ORD10010004 · ₹1,240") and to the shopper ("Your order is on its
// way"). Kept out of events.ts so the registry stays scannable data, and out of
// the recorder so every string is unit-testable without a database.
//
// Anything missing falls back to the registry's label, so a half-populated
// payload degrades to a dull-but-correct notification instead of "undefined".
// ---------------------------------------------------------------------------

import { getEventDef, type Audience } from "./events";
import { refundCopy } from "./refund-copy";

export interface RenderableEvent {
  type: string;
  actorLabel?: string | null;
  subjectId?: string | null;
  subjectLabel?: string | null;
  payload?: Record<string, unknown> | null;
}

export interface RenderedNotification {
  title: string;
  body: string | null;
  url: string | null;
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** ₹1,240 — display only; the invoice remains the authority on money. */
function money(value: unknown, currency = "INR"): string | null {
  const n = num(value);
  if (n === null) return null;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n}`;
  }
}

/** Deep link to an order in the dashboard list (the detail is a drawer, so the
 *  list's `q` search over order_ref is the addressable form). */
function adminOrderUrl(e: RenderableEvent): string {
  const ref = str(e.subjectLabel) ?? str(e.payload?.orderRef);
  return ref
    ? `/dashboard/orders?q=${encodeURIComponent(ref)}`
    : "/dashboard/orders";
}

/** The shopper's own order page (app/(storefront)/(pages)/orders/[id]). */
function customerOrderUrl(e: RenderableEvent): string {
  const id = str(e.subjectId);
  return id ? `/orders/${id}` : "/orders";
}

function safeDashboardUrl(value: unknown): string {
  const path = str(value);
  return path && /^\/dashboard(?:[/?#]|$)/.test(path) ? path : "/dashboard";
}

/**
 * Render one event for one audience. Returns null when this audience has no
 * copy for the event — the router treats that as "don't deliver", so an event
 * can never reach an inbox as a blank row.
 */
export function renderNotification(
  event: RenderableEvent,
  audience: Audience,
): RenderedNotification | null {
  const def = getEventDef(event.type);
  if (!def) return null;
  if (!def.audiences[audience]) return null;

  const subject = str(event.subjectLabel);
  const actor = str(event.actorLabel);
  const p = event.payload ?? {};
  const currency = str(p.currency) ?? "INR";
  const total = money(p.total, currency);
  const fallback: RenderedNotification = {
    title: def.label,
    body: subject,
    url: null,
  };

  switch (event.type) {
    // ── Orders ────────────────────────────────────────────────────────────
    case "order.placed":
      return audience === "customer"
        ? {
            title: "Order confirmed",
            body: subject
              ? `We've received your order ${subject}${total ? ` · ${total}` : ""}.`
              : "We've received your order.",
            url: customerOrderUrl(event),
          }
        : {
            title: `New order${subject ? ` ${subject}` : ""}`,
            body:
              [total, actor && `from ${actor}`].filter(Boolean).join(" · ") ||
              null,
            url: adminOrderUrl(event),
          };

    case "order.status_changed": {
      const to = str(p.status);
      return audience === "customer"
        ? {
            title: `Your order is ${to ?? "updated"}`,
            body: subject ? `Order ${subject}` : null,
            url: customerOrderUrl(event),
          }
        : {
            title: `Order ${subject ?? ""} → ${to ?? "updated"}`.trim(),
            body: actor ? `Updated by ${actor}` : null,
            url: adminOrderUrl(event),
          };
    }

    case "order.cancellation_requested":
      return {
        title: `Cancellation requested${subject ? ` · ${subject}` : ""}`,
        body:
          [str(p.reason), actor && `by ${actor}`].filter(Boolean).join(" · ") ||
          "Awaiting your review.",
        url: adminOrderUrl(event),
      };

    case "order.cancelled":
      return audience === "customer"
        ? {
            title: "Order cancelled",
            body: subject
              ? `Order ${subject} has been cancelled${total ? ` · ${total}` : ""}.`
              : "Your order has been cancelled.",
            url: customerOrderUrl(event),
          }
        : {
            title: `Order cancelled${subject ? ` · ${subject}` : ""}`,
            body:
              [str(p.reason), actor && `by ${actor}`]
                .filter(Boolean)
                .join(" · ") || null,
            url: adminOrderUrl(event),
          };

    case "order.payment_received":
      return {
        title: `Payment received${total ? ` · ${total}` : ""}`,
        body: subject ? `Order ${subject}` : null,
        url: adminOrderUrl(event),
      };

    case "order.payment_failed":
      return {
        title: `Payment failed${subject ? ` · ${subject}` : ""}`,
        body: str(p.reason) ?? "The shopper's online payment did not complete.",
        url: adminOrderUrl(event),
      };

    case "order.refund_issued": {
      const amount = money(p.amount, currency);
      // Both emitters send `amount`; `total` here silently rendered nothing.
      const copy = refundCopy(p.paymentMethod);
      return audience === "customer"
        ? {
            title: "Refund on its way",
            body: `${amount ?? "Your refund"} has been ${copy.destination}.${
              copy.bankDelay ? " Banks usually take 5–7 working days." : ""
            }`,
            url: customerOrderUrl(event),
          }
        : {
            title: `Refund issued${amount ? ` · ${amount}` : ""}`,
            body: subject ? `Order ${subject}` : null,
            url: adminOrderUrl(event),
          };
    }

    // ── Inventory ─────────────────────────────────────────────────────────
    case "inventory.low_stock": {
      const left = num(p.stock);
      return {
        title: `Low stock${subject ? ` · ${subject}` : ""}`,
        body: left === null ? "Running low." : `Only ${left} left in stock.`,
        url: "/dashboard/inventory",
      };
    }

    case "inventory.out_of_stock":
      return {
        title: `Out of stock${subject ? ` · ${subject}` : ""}`,
        body: "This item is sold out and can no longer be bought.",
        url: "/dashboard/inventory",
      };

    // ── Catalog ───────────────────────────────────────────────────────────
    case "product.deleted":
      return {
        title: `Product deleted${subject ? ` · ${subject}` : ""}`,
        body: actor ? `Deleted by ${actor}` : null,
        url: "/dashboard/products",
      };

    // ── Customers ─────────────────────────────────────────────────────────
    case "customer.signed_up":
      return {
        title: "New customer",
        body: subject ?? actor,
        url: "/dashboard/users",
      };

    case "customer.review_submitted": {
      const rating = num(p.rating);
      return {
        title: `New review${rating !== null ? ` · ${rating}★` : ""}`,
        body: subject ? `On ${subject}` : null,
        url: "/dashboard/products",
      };
    }

    case "enquiry.received":
      return {
        title: "New enquiry",
        body: [actor, str(p.subject)].filter(Boolean).join(" · ") || null,
        url: str(event.subjectId)
          ? `/dashboard/enquiries/${event.subjectId}`
          : "/dashboard/enquiries",
      };

    // ── Content ───────────────────────────────────────────────────────────
    case "blog.submitted":
      return {
        title: "Blog submitted for review",
        body:
          [subject, actor && `by ${actor}`].filter(Boolean).join(" · ") || null,
        url: "/dashboard/blogs",
      };

    case "blog.published":
      return {
        title: `Blog published${subject ? ` · ${subject}` : ""}`,
        body: actor ? `Published by ${actor}` : null,
        url: "/dashboard/blogs",
      };

    case "blog.approved":
      return {
        title: "Your post is live",
        body: subject ? `“${subject}” was approved and published.` : null,
        url: str(p.slug) ? `/blogs/${str(p.slug)}` : "/blogs/my-submissions",
      };

    case "blog.rejected":
      return {
        title: "Your post wasn't published",
        body:
          str(p.reason) ??
          (subject ? `“${subject}” was not approved this time.` : null),
        url: "/blogs/my-submissions",
      };

    case "blog.comment_posted":
      return {
        title: "New blog comment",
        body:
          [subject, actor && `by ${actor}`].filter(Boolean).join(" · ") || null,
        url: "/dashboard/blogs",
      };

    // ── Marketing ─────────────────────────────────────────────────────────
    case "campaign.sent": {
      const sent = num(p.sent);
      return {
        title: "Email campaign sent",
        body: sent === null ? subject : `Delivered to ${sent} recipients.`,
        url: "/dashboard/marketing/coupons",
      };
    }

    // ── Team & security ───────────────────────────────────────────────────
    case "admin.invited":
      return {
        title: "Team member invited",
        body:
          [subject, actor && `by ${actor}`].filter(Boolean).join(" · ") || null,
        url: "/dashboard/admins",
      };

    case "admin.role_changed":
      return {
        title: "Team member's role changed",
        body:
          [subject, str(p.role) && `now ${str(p.role)}`, actor && `by ${actor}`]
            .filter(Boolean)
            .join(" · ") || null,
        url: "/dashboard/admins",
      };

    case "admin.removed":
      return {
        title: "Team member removed",
        body:
          [subject, actor && `by ${actor}`].filter(Boolean).join(" · ") || null,
        url: "/dashboard/admins",
      };

    case "security.password_changed":
      return {
        title: "Password changed",
        body: subject
          ? `The password for ${subject} was changed. If this wasn't you, reset it now.`
          : "An account password was changed. If this wasn't you, reset it now.",
        url: "/dashboard/settings/account",
      };

    // ── Plan & billing ────────────────────────────────────────────────────
    case "plan.changed":
      return {
        title: `Plan changed${str(p.plan) ? ` · ${str(p.plan)}` : ""}`,
        body: str(p.note) ?? (actor ? `Changed by ${actor}` : null),
        url: "/dashboard/plans",
      };

    case "plan.expiring": {
      const days = num(p.daysLeft);
      return {
        title: "Your plan is expiring",
        body:
          days === null
            ? "Renew to keep your paid features."
            : `${days} day${days === 1 ? "" : "s"} left before this store returns to Free.`,
        url: "/dashboard/plans",
      };
    }

    case "subscription.payment_failed":
      return {
        title: "Subscription payment failed",
        body:
          str(p.reason) ??
          "We couldn't collect your plan payment. Update your payment method to avoid losing paid features.",
        url: "/dashboard/plans",
      };

    case "ai.credits_low": {
      const left = num(p.balance);
      return {
        title: "Mink credits running low",
        body:
          left === null
            ? "Top up to keep generating."
            : `${left} generation${left === 1 ? "" : "s"} left this month.`,
        url: "/dashboard/ai",
      };
    }

    case "ai.credits_purchased": {
      const credits = num(p.credits);
      return {
        title: "Mink credits added",
        body:
          credits === null
            ? null
            : `${credits} credits are now in your balance.`,
        url: "/dashboard/ai",
      };
    }

    case "mink.workflow_completed":
      return {
        title: "Mink workflow ready",
        body: subject ?? "Your requested Mink workflow is complete.",
        url: safeDashboardUrl(p.url),
      };

    case "mink.watch_ready":
      return {
        title: "Your Mink watch has an update",
        body: "Open your private watches to review the latest evidence.",
        url: "/dashboard/mink-watches",
      };

    // The merchant's own welcome. Deliberately separate from
    // platform.store_created below, which is the operators' copy of the same
    // moment — different audience, different words, different destination.
    case "store.created":
      return {
        title: `Welcome to StoreMink, ${subject ?? "your store"} is live`,
        body: str(p.store_url) || null,
        url: "/dashboard",
      };

    // The merchant milestone. platform.domain_verified below is the operators'
    // copy of the same moment, with the store named rather than addressed.
    case "store.domain_live":
      return {
        title: `${subject ?? "Your domain"} is live`,
        body: str(p.extra_hosts)
          ? `Also serving ${str(p.extra_hosts)}`
          : "Your store is now open on your own domain.",
        // The DOMAIN, not /dashboard: the one thing anyone wants on being told
        // this is to click through and see their own shop answer on it.
        url: str(p.store_url) || "/dashboard/settings/domain",
      };

    case "store.comp_ended":
      return {
        title: `Your free ${str(p.comp_plan) || "plan"} upgrade has ended`,
        body: `You're back on ${str(p.plan) || "your usual plan"}.`,
        url: "/dashboard/plans",
      };

    case "store.domain_reverted":
      return {
        title: `${subject ?? "Your domain"} has stopped working`,
        body:
          str(p.reason) ||
          "Your store is being served on its StoreMink address again.",
        // Straight to the domain settings, where the outstanding records are.
        url: "/dashboard/settings/domain",
      };

    // ── Data (CSV import/export) ──────────────────────────────────────────
    //
    // ★ THESE CARRY A URL NOW. All three used to fall through to the default,
    // which renders the event's label and NO link — so "Import finished" sat in
    // the bell as a dead end, next to an import whose whole point is the row-by-
    // row log one click away. `subjectId` is the job id (see the emit sites).
    case "data.import_started":
      return {
        title: `Importing ${subject ?? "data"}…`,
        body: str(p.file) ?? "Running in the background.",
        url: event.subjectId
          ? `/dashboard/logs/import-export/${event.subjectId}`
          : "/dashboard/logs/import-export?kind=import",
      };

    case "data.imported": {
      // Lead with what went wrong when something did — that is the reason
      // anyone opens this — and stay quiet about zeroes otherwise.
      const failed = Number(p.failed ?? 0);
      const changed = Number(p.created ?? 0) + Number(p.updated ?? 0);
      return {
        title: failed > 0 ? "Import finished with errors" : "Import finished",
        body:
          [
            subject,
            `${changed.toLocaleString("en-IN")} row${changed === 1 ? "" : "s"}`,
            failed > 0
              ? `${failed.toLocaleString("en-IN")} couldn't be imported`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || null,
        url: event.subjectId
          ? `/dashboard/logs/import-export/${event.subjectId}`
          : "/dashboard/logs/import-export?kind=import",
      };
    }

    case "data.exported":
      return {
        title: `Exported ${subject ?? "data"}`,
        body: [actor && `By ${actor}`, str(p.file)].filter(Boolean).join(" · "),
        url: event.subjectId
          ? `/dashboard/logs/import-export/${event.subjectId}`
          : "/dashboard/logs/import-export?kind=export",
      };

    // ── Platform (operator console) ───────────────────────────────────────
    case "platform.store_created":
      return {
        title: `New store · ${subject ?? "unnamed"}`,
        body: [str(p.slug), str(p.plan)].filter(Boolean).join(" · ") || null,
        url: "/dashboard",
      };

    case "platform.store_suspended":
      return {
        title: `Store ${str(p.status) === "active" ? "reinstated" : "suspended"}${subject ? ` · ${subject}` : ""}`,
        body: actor ? `By ${actor}` : null,
        url: "/dashboard",
      };

    case "platform.plan_changed":
      return {
        title: `Store plan changed${subject ? ` · ${subject}` : ""}`,
        body:
          [str(p.plan), actor && `by ${actor}`].filter(Boolean).join(" · ") ||
          null,
        url: "/dashboard",
      };

    case "platform.domain_verified":
      return {
        title: `Custom domain verified${subject ? ` · ${subject}` : ""}`,
        body: str(p.domain),
        url: "/dashboard",
      };

    default:
      return fallback;
  }
}
