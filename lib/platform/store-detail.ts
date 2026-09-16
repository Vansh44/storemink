import "server-only";

import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import {
  aiAllowanceFor,
  effectivePlan,
  normalizePlan,
  type Plan,
} from "@/lib/plans";
import { getPlanAllowancesLive } from "@/lib/plans/allowances";
import { getMinkConfig } from "@/lib/mink/config";

// ---------------------------------------------------------------------------
// Everything an operator needs to know about ONE store, on one screen.
//
// ── ★ WHY THIS IS NOT IN `app/actions/platform.ts` ─────────────────────────
// Every export of a `"use server"` file is a publicly reachable endpoint. This
// is a pure READ called by a server component that has already resolved the
// viewer, so exporting it as an action would add a public endpoint returning
// cross-tenant data for no benefit. Same reasoning as `lib/domains/reconcile.ts`
// (§30) and `lib/retention/prune.ts` (§32): the core lives in `lib/`, the gate
// lives at the entry point. It gates again anyway — defence in depth is cheap
// when the cost of being wrong is every store's data.
//
// ── ★ ONE ROUND TRIP, NOT FIFTEEN ──────────────────────────────────────────
// A store detail wants ~15 counts. Issued separately that is 15 × the ~46ms
// round trip to Cloud SQL in Mumbai (docs/local-dev-performance.md), i.e. most
// of a second spent waiting before React starts. They go in one statement of
// scalar subqueries, the shape `getPlatformOverview` already uses.
//
// ── ★ IT NEVER RETURNS A SECRET ────────────────────────────────────────────
// Channel state is "connected / paused / none" and nothing else. The gateway,
// logistics and SMS credentials are encrypted at rest and write-only by design
// (§18, §35, §37); an operator console is not a reason to widen that.
// ---------------------------------------------------------------------------

/** Whether a store has connected a given channel, and whether it is live. */
export type ChannelState = "none" | "enabled" | "paused";

export interface StoreDetail {
  id: string;
  slug: string;
  name: string;
  status: string;
  /** The stored plan — what an operator granted or the merchant bought. */
  plan: Plan;
  /** What the store can actually DO today: expired timed plans read as free. */
  effective: Plan;
  planSource: string | null;
  planExpiresAt: string | null;
  /**
   * The comped-plan overlay (docs/comped-plans-spec.md). `offer` is granted but
   * not yet accepted; `active` is running. They are mutually exclusive.
   */
  comp: {
    offer: {
      plan: Plan;
      durationDays: number;
      offeredAt: string | null;
    } | null;
    active: { plan: Plan; startsAt: string; expiresAt: string } | null;
  };
  createdAt: string;
  storeNo: number | null;
  customDomain: string | null;
  domainVerified: boolean;
  /** Not indexable until the owner publishes something (lib/store/launch.ts). */
  launched: boolean;
  demo: boolean;
  /** Country/city captured at signup, from the anon-readable settings blob. */
  business: { country: string | null; city: string | null };
  owner: {
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null;
  counts: {
    orders: number;
    orders30d: number;
    products: number;
    customers: number;
    locations: number;
    blogs: number;
    admins: number;
    posStaff: number;
  };
  /** Lifetime and 30-day gross, excluding cancelled orders. */
  revenue: { lifetime: number; last30d: number };
  ai: { used: number; cap: number | null; creditBalance: number };
  mink: {
    betaEnabled: boolean;
  };
  channels: {
    payments: ChannelState;
    logistics: ChannelState;
    sms: ChannelState;
  };
  subscription: {
    plan: string;
    period: string;
    state: string;
    currentPeriodEnd: string | null;
    billedLocations: number;
    cancelAtPeriodEnd: boolean;
    graceEndsAt: string | null;
  } | null;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * One store, fully described — or null when it does not exist.
 *
 * The caller is responsible for having established that the viewer is a
 * platform operator; this re-reads nothing about them, so do not call it from
 * anywhere that has not.
 */
export async function loadStoreDetail(
  storeId: string,
): Promise<StoreDetail | null> {
  try {
    // Read before the one big round trip, so the cap an operator is shown is
    // the cap the quota gate is really enforcing for this store.
    const allowances = await getPlanAllowancesLive();
    return await withService(async (db) => {
      const result = await db.execute(sql`
        select
          s.id,
          s.slug,
          s.name,
          s.status,
          s.plan,
          s.plan_source,
          s.plan_expires_at,
          s.comp_plan,
          s.comp_duration_days,
          s.comp_offered_at,
          s.comp_starts_at,
          s.comp_expires_at,
          s.created_at,
          s.store_no,
          s.custom_domain,
          s.settings,
          (select json_build_object(
             'email', a.email, 'first_name', a.first_name, 'last_name', a.last_name)
             from admins a
            where a.store_id = s.id and a.role = 'superadmin'
            order by a.created_at asc limit 1) as owner,
          (select count(*)::int from orders o where o.store_id = s.id) as orders,
          (select count(*)::int from orders o
            where o.store_id = s.id
              and o.created_at >= now() - interval '30 days') as orders_30d,
          (select coalesce(sum(o.total), 0)::float from orders o
            where o.store_id = s.id and o.status <> 'cancelled') as revenue_lifetime,
          (select coalesce(sum(o.total), 0)::float from orders o
            where o.store_id = s.id and o.status <> 'cancelled'
              and o.created_at >= now() - interval '30 days') as revenue_30d,
          (select count(*)::int from products p where p.store_id = s.id) as products,
          (select count(*)::int from users u where u.store_id = s.id) as customers,
          (select count(*)::int from store_locations l where l.store_id = s.id) as locations,
          (select count(*)::int from blogs b where b.store_id = s.id) as blogs,
          (select count(*)::int from admins a where a.store_id = s.id) as admin_count,
          (select count(*)::int from pos_staff ps where ps.store_id = s.id) as pos_staff,
          (select coalesce(used, 0)::int from ai_usage au
            where au.store_id = s.id
              and au.period = to_char(now(), 'YYYY-MM')) as ai_used,
          (select coalesce(balance, 0)::int from ai_credit_balances cb
            where cb.store_id = s.id) as credit_balance,
          (select enabled from mink_store_access ma
            where ma.store_id = s.id) as mink_beta_enabled,
          (select case when enabled then 'enabled' else 'paused' end
             from store_payment_providers pp where pp.store_id = s.id) as gateway,
          (select case when enabled then 'enabled' else 'paused' end
             from store_logistics_providers lp where lp.store_id = s.id) as logistics,
          (select case when enabled then 'enabled' else 'paused' end
             from store_sms_providers sp where sp.store_id = s.id) as sms,
          (select json_build_object(
             'plan', bs.plan, 'period', bs.period, 'state', bs.state,
             'current_period_end', bs.current_period_end,
             'billed_locations', bs.billed_locations,
             'cancel_at_period_end', bs.cancel_at_period_end,
             'grace_ends_at', bs.grace_ends_at)
             from billing_subscriptions bs where bs.store_id = s.id) as subscription
        from stores s
        where s.id = ${storeId}
        limit 1
      `);

      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;

      const settings = (row.settings ?? {}) as Record<string, unknown>;
      const businessRaw = (settings.business ?? {}) as Record<string, unknown>;
      const owner = row.owner as Record<string, unknown> | null;
      const sub = row.subscription as Record<string, unknown> | null;

      const plan = normalizePlan(String(row.plan ?? "free"));
      const planExpiresAt = str(row.plan_expires_at);
      // The gates read `effectivePlan`, so the console must show it too —
      // otherwise a lapsed timed grant reads as Pro on this screen while the
      // store itself is on free, and every support conversation starts wrong.
      const effective = effectivePlan({
        plan,
        plan_expires_at: planExpiresAt,
        comp_plan: str(row.comp_plan),
        comp_expires_at: str(row.comp_expires_at),
      });

      return {
        id: String(row.id),
        slug: String(row.slug),
        name: String(row.name),
        status: String(row.status ?? "active"),
        plan,
        effective,
        planSource: str(row.plan_source),
        planExpiresAt,
        comp: {
          offer:
            row.comp_plan && row.comp_duration_days && !row.comp_starts_at
              ? {
                  plan: normalizePlan(String(row.comp_plan)),
                  durationDays: num(row.comp_duration_days),
                  offeredAt: str(row.comp_offered_at),
                }
              : null,
          active:
            row.comp_plan && row.comp_starts_at && row.comp_expires_at
              ? {
                  plan: normalizePlan(String(row.comp_plan)),
                  startsAt: String(row.comp_starts_at),
                  expiresAt: String(row.comp_expires_at),
                }
              : null,
        },
        createdAt: String(row.created_at),
        storeNo: row.store_no == null ? null : num(row.store_no),
        customDomain: str(row.custom_domain),
        domainVerified: settings.custom_domain_verified === true,
        // Absence means LAUNCHED — pre-existing stores have no key, and
        // treating them as unlaunched would report every live shop as hidden
        // from search (lib/store/launch.ts).
        launched: settings.launched !== false,
        demo: settings.demo === true,
        business: {
          country: str(businessRaw.country),
          city: str(businessRaw.city),
        },
        owner: owner
          ? {
              email: str(owner.email),
              firstName: str(owner.first_name),
              lastName: str(owner.last_name),
            }
          : null,
        counts: {
          orders: num(row.orders),
          orders30d: num(row.orders_30d),
          products: num(row.products),
          customers: num(row.customers),
          locations: num(row.locations),
          blogs: num(row.blogs),
          admins: num(row.admin_count),
          posStaff: num(row.pos_staff),
        },
        revenue: {
          lifetime: num(row.revenue_lifetime),
          last30d: num(row.revenue_30d),
        },
        ai: {
          used: num(row.ai_used),
          cap: aiAllowanceFor(
            effective,
            getMinkConfig().chargeCredits,
            allowances,
          ),
          creditBalance: num(row.credit_balance),
        },
        mink: {
          betaEnabled: row.mink_beta_enabled === true,
        },
        channels: {
          payments: (str(row.gateway) ?? "none") as ChannelState,
          logistics: (str(row.logistics) ?? "none") as ChannelState,
          sms: (str(row.sms) ?? "none") as ChannelState,
        },
        subscription: sub
          ? {
              plan: String(sub.plan ?? "free"),
              period: String(sub.period ?? "monthly"),
              state: String(sub.state ?? "free"),
              currentPeriodEnd: str(sub.current_period_end),
              billedLocations: num(sub.billed_locations),
              cancelAtPeriodEnd: sub.cancel_at_period_end === true,
              graceEndsAt: str(sub.grace_ends_at),
            }
          : null,
      };
    });
  } catch (error) {
    logError("loadStoreDetail failed", error, { storeId });
    return null;
  }
}

export interface StorePerson {
  id: string;
  kind: "admin" | "pos";
  name: string;
  email: string;
  role: string;
  status: string;
  createdAt: string;
}

/**
 * Who can sign in to this store — dashboard admins and POS staff together.
 *
 * ★ TWO TABLES, ONE LIST, AND THEY ARE NOT THE SAME KIND OF PERSON. An
 * `admins` row is a dashboard login; a `pos_staff` row is a till login with a
 * PIN and no dashboard access at all. They are merged for reading because the
 * operator's question is "who has access to this store?", and `kind` keeps
 * them tellable apart — never collapse it, or revoking the wrong one looks
 * identical to revoking the right one.
 *
 * Never returns `pin_hash`, `invite_token` or `reset_token`: each is a live
 * credential, and none of them answers an operator's question.
 */
export async function loadStorePeople(storeId: string): Promise<StorePerson[]> {
  try {
    return await withService(async (db) => {
      const result = await db.execute(sql`
        select
          a.id::text as id,
          'admin' as kind,
          trim(coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, '')) as name,
          a.email,
          a.role,
          case when a.is_suspended then 'suspended' else 'active' end as status,
          a.created_at
        from admins a
        where a.store_id = ${storeId}
        union all
        select
          ps.id::text as id,
          'pos' as kind,
          ps.name,
          ps.email,
          ps.role,
          case when not ps.active then 'inactive' else ps.status end as status,
          ps.created_at
        from pos_staff ps
        where ps.store_id = ${storeId}
        order by created_at asc
      `);

      return result.rows.map((r) => {
        const row = r as Record<string, unknown>;
        const name = String(row.name ?? "").trim();
        return {
          id: String(row.id),
          kind: row.kind === "pos" ? ("pos" as const) : ("admin" as const),
          name,
          email: String(row.email ?? ""),
          role: String(row.role ?? ""),
          status: String(row.status ?? ""),
          createdAt: String(row.created_at),
        };
      });
    });
  } catch (error) {
    logError("loadStorePeople failed", error, { storeId });
    return [];
  }
}
