import { describe, it, expect } from "vitest";
import {
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
} from "next/constants";
import configForPhase from "./next.config";

/**
 * The dashboard redirects, and which paths they are allowed to swallow.
 *
 * ★★ A CATCH-ALL TOOK TWO LIVE SURFACES WITH IT. Folding coupons into offers
 * added `/dashboard/marketing/coupons/:path*` → `/dashboard/offers`, and Next
 * applies `redirects()` BEFORE filesystem routing — so it also captured
 * `[id]/edit` and `[id]/email`, neither of which had moved:
 *
 *   • Coupon EMAIL CAMPAIGNS are keyed on a `coupons` row throughout
 *     (`email_campaigns`, `lib/mink/campaign-*`). `[id]/email` is the only way
 *     to send one, so the Pro feature had no reachable UI at all.
 *   • Mink Phase 4C still CREATES `coupons`, and its own artifacts hand the
 *     merchant `/dashboard/marketing/coupons/{id}/edit`. That id may exist ONLY
 *     in `coupons`, so redirecting it to the offers list dead-ends on a list
 *     that cannot contain it.
 *
 * These are cheap to get wrong again — a catch-all reads like tidying up — so
 * the boundary is asserted rather than remembered.
 */

type Redirect = { source: string; destination: string; permanent: boolean };

async function redirects(phase: string): Promise<Redirect[]> {
  const nextConfig = configForPhase(phase);
  const fn = nextConfig.redirects;
  if (typeof fn !== "function")
    throw new Error("no redirects() in next.config");
  return (await fn.call(nextConfig)) as Redirect[];
}

/** Next's own matching, reduced to what these rules use: `:param` and `:p*`. */
function matches(source: string, path: string): boolean {
  const pattern = source
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:[A-Za-z]+\*/g, ".*")
    .replace(/:[A-Za-z]+/g, "[^/]+");
  return new RegExp(`^${pattern}$`).test(path);
}

const firstMatch = (rules: Redirect[], path: string) =>
  rules.find((r) => matches(r.source, path));

describe.each([
  PHASE_DEVELOPMENT_SERVER,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
])("dashboard redirects (%s)", (phase) => {
  it("★★ leaves the coupon EMAIL campaign page reachable", async () => {
    const rules = await redirects(phase);
    expect(
      firstMatch(rules, "/dashboard/marketing/coupons/abc-123/email"),
    ).toBeUndefined();
  });

  it("★★ leaves a coupon EDIT page reachable, for Mink's own deep links", async () => {
    // `lib/mink/tools/draft-tools.ts` and `lib/mink/domain-actions.ts` hand the
    // merchant this exact path for a coupon Mink proposed.
    const rules = await redirects(phase);
    expect(
      firstMatch(rules, "/dashboard/marketing/coupons/abc-123/edit"),
    ).toBeUndefined();
  });

  it("still retires the destinations that genuinely moved", async () => {
    const rules = await redirects(phase);
    expect(firstMatch(rules, "/dashboard/marketing/coupons")?.destination).toBe(
      "/dashboard/offers",
    );
    // A new discount IS an offer now, so this lands on the editor rather than
    // bouncing to a list the merchant then has to act on.
    expect(
      firstMatch(rules, "/dashboard/marketing/coupons/new")?.destination,
    ).toBe("/dashboard/offers/new");
    expect(firstMatch(rules, "/dashboard/promotions")?.destination).toBe(
      "/dashboard/offers",
    );
  });

  it("★ every dashboard redirect is TEMPORARY", async () => {
    // These sit behind a login, so there are no SEO signals to consolidate —
    // and a 308 is cached by browsers indefinitely, which is the trap `proxy.ts`
    // already works around with `Cache-Control: no-store` (CODEBASE §30).
    const rules = await redirects(phase);
    for (const rule of rules.filter((r) => r.source.startsWith("/dashboard"))) {
      expect(rule.permanent).toBe(false);
    }
  });

  it("★ the retired log paths still resolve, because sent emails carry them", async () => {
    // Absolute `/dashboard/activity` links are in inboxes nobody can edit.
    const rules = await redirects(phase);
    expect(firstMatch(rules, "/dashboard/activity")?.destination).toBe(
      "/dashboard/logs",
    );
  });
});
