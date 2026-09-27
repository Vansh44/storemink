import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import type { Plan } from "@/lib/plans";

// ---------------------------------------------------------------------------
// The operator home screen's data.
//
// ── ★ AN OVERVIEW ANSWERS "WHAT NEEDS ME?", NOT "HOW MANY OF EVERYTHING?" ──
// A wall of totals looks like a dashboard and is read once. The `attention`
// block is the part that earns the screen: every number in it is a queue with
// a destination, and every one of them is zero on a good day. Counts that
// never demand action (total stores, plan mix) are context around it, not the
// point of it — the same rule §22 states for sidebar badges, where a hardcoded
// "12" on Orders taught people to ignore the badges that moved.
//
// ── ★ EVERY FIGURE HERE IS DERIVED, NOTHING IS STORED ──────────────────────
// So there is no counter to drift, no backfill, and no "recompute the
// dashboard" job. It costs one round trip (see store-detail.ts on why that
// matters), which is the whole reason these are scalar subqueries rather than
// fifteen awaits.
//
// ── ★ IT FAILS TO AN EMPTY SNAPSHOT, NOT AN EXCEPTION ──────────────────────
// This is the screen an operator opens when something is wrong. A page that
// 500s because one aggregate failed is the worst possible behaviour for it,
// so a read error logs and renders zeroes; `ok: false` tells the page to say
// so rather than present zeroes as good news.
// ---------------------------------------------------------------------------

export interface SignupPoint {
  /** ISO date of the week's Monday. */
  weekStart: string;
  count: number;
}

export interface AttentionCounts {
  suspendedStores: number;
  /** Subscriptions inside the 48h grace window — about to lose their plan. */
  billingGrace: number;
  /** Custom domains that have been provisioning for more than 3 days (§30). */
  stuckDomains: number;
  emailFailures24h: number;
  smsFailures24h: number;
  openReconciliation: number;
}

export interface RecentStore {
  id: string;
  slug: string;
  name: string;
  plan: string;
  status: string;
  createdAt: string;
  ownerEmail: string | null;
}

export interface PlatformInsights {
  ok: boolean;
  totals: {
    stores: number;
    active: number;
    paid: number;
    new30d: number;
    new7d: number;
    /** Stores that have published something and are therefore indexable. */
    launched: number;
  };
  planMix: Record<Plan, number>;
  signups: SignupPoint[];
  attention: AttentionCounts;
  recent: RecentStore[];
}

const EMPTY: PlatformInsights = {
  ok: false,
  totals: {
    stores: 0,
    active: 0,
    paid: 0,
    new30d: 0,
    new7d: 0,
    launched: 0,
  },
  planMix: { free: 0, basic: 0, pro: 0 },
  signups: [],
  attention: {
    suspendedStores: 0,
    billingGrace: 0,
    stuckDomains: 0,
    emailFailures24h: 0,
    smsFailures24h: 0,
    openReconciliation: 0,
  },
  recent: [],
};

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The operator home snapshot. Never throws — an unreadable database renders
 * `ok: false` and the page says the figures are unavailable.
 */
// Theme Studio preview stores are platform plumbing, not merchants: they are
// created and removed by operators reviewing a theme, so counting them would
// report signups nobody made. Every query below reads this CTE, never
// `stores` directly.
const MERCHANT_STORES = sql.raw(
  "with merchant_stores as (select * from stores where not (settings ? 'studioPreview'))",
);

export async function getPlatformInsights(): Promise<PlatformInsights> {
  try {
    return await withService(async (db) => {
      // Headline counts + the attention queues, in one statement.
      //
      // ⚠ The paid / plan-mix predicates use `plan_expires_at` exactly as
      // `effectivePlan` does (expired timed grant ⇒ free). SQL and TypeScript
      // agreeing here is load-bearing: if this screen counted stored plans
      // while the gates read effective ones, the console would report revenue
      // the product is not actually delivering.
      const summary = await db.execute(sql`
        ${MERCHANT_STORES}
        select
          (select count(*)::int from merchant_stores) as stores,
          (select count(*)::int from merchant_stores where status = 'active') as active,
          (select count(*)::int from merchant_stores
            where plan <> 'free'
              and (plan_expires_at is null or plan_expires_at > now())) as paid,
          (select count(*)::int from merchant_stores
            where created_at >= now() - interval '30 days') as new_30d,
          (select count(*)::int from merchant_stores
            where created_at >= now() - interval '7 days') as new_7d,
          (select count(*)::int from merchant_stores
            where coalesce(settings->>'launched', 'true') <> 'false') as launched,
          (select count(*)::int from merchant_stores
            where (plan_expires_at is null or plan_expires_at > now())
              and plan = 'basic') as plan_basic,
          (select count(*)::int from merchant_stores
            where (plan_expires_at is null or plan_expires_at > now())
              and plan = 'pro') as plan_pro,
          (select count(*)::int from merchant_stores where status = 'suspended') as suspended,
          (select count(*)::int from billing_subscriptions
            where grace_ends_at is not null and grace_ends_at > now()) as billing_grace,
          (select count(*)::int from merchant_stores
            where settings->>'domain_pending_since' is not null
              and (settings->>'domain_pending_since')::timestamptz
                    < now() - interval '3 days'
              and coalesce((settings->>'custom_domain_verified')::boolean, false)
                    is not true) as stuck_domains,
          (select count(*)::int from email_logs
            where status = 'failed'
              and created_at >= now() - interval '24 hours') as email_failures,
          (select count(*)::int from sms_logs
            where status = 'failed'
              and created_at >= now() - interval '24 hours') as sms_failures,
          (select count(*)::int from billing_reconciliation_items
            where status = 'open') as open_reconciliation
      `);

      const row = (summary.rows[0] ?? {}) as Record<string, unknown>;

      // Signups per week for the last 12 weeks. generate_series so a week with
      // no signups is a zero rather than a gap — a sparse series renders as a
      // chart that silently rescales its own x-axis every time it is opened.
      const signupRows = await db.execute(sql`
        ${MERCHANT_STORES}
        select
          to_char(w.week, 'YYYY-MM-DD') as week_start,
          (select count(*)::int from merchant_stores s
            where s.created_at >= w.week
              and s.created_at < w.week + interval '7 days') as count
        from generate_series(
          date_trunc('week', now()) - interval '11 weeks',
          date_trunc('week', now()),
          interval '1 week'
        ) as w(week)
        order by w.week asc
      `);

      const recentRows = await db.execute(sql`
        ${MERCHANT_STORES}
        select
          s.id, s.slug, s.name, s.plan, s.status, s.created_at,
          (select a.email from admins a
            where a.store_id = s.id and a.role = 'superadmin'
            order by a.created_at asc limit 1) as owner_email
        from merchant_stores s
        order by s.created_at desc
        limit 8
      `);

      const stores = num(row.stores);
      const basic = num(row.plan_basic);
      const pro = num(row.plan_pro);

      return {
        ok: true,
        totals: {
          stores,
          active: num(row.active),
          paid: num(row.paid),
          new30d: num(row.new_30d),
          new7d: num(row.new_7d),
          launched: num(row.launched),
        },
        // Free is the remainder rather than its own count: a store whose timed
        // plan lapsed is stored as `basic`/`pro` but IS free today, and
        // deriving it keeps the three figures summing to the total no matter
        // how many expiry cases exist.
        planMix: { free: Math.max(0, stores - basic - pro), basic, pro },
        signups: signupRows.rows.map((r) => {
          const s = r as Record<string, unknown>;
          return { weekStart: String(s.week_start), count: num(s.count) };
        }),
        attention: {
          suspendedStores: num(row.suspended),
          billingGrace: num(row.billing_grace),
          stuckDomains: num(row.stuck_domains),
          emailFailures24h: num(row.email_failures),
          smsFailures24h: num(row.sms_failures),
          openReconciliation: num(row.open_reconciliation),
        },
        recent: recentRows.rows.map((r) => {
          const s = r as Record<string, unknown>;
          return {
            id: String(s.id),
            slug: String(s.slug),
            name: String(s.name),
            plan: String(s.plan ?? "free"),
            status: String(s.status ?? "active"),
            createdAt: String(s.created_at),
            ownerEmail:
              typeof s.owner_email === "string" && s.owner_email
                ? s.owner_email
                : null,
          };
        }),
      };
    });
  } catch (error) {
    logError("getPlatformInsights failed", error);
    return EMPTY;
  }
}
