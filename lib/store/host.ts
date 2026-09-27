// Pure host classification — no server/Node imports, so it's safe to use from
// the edge proxy (proxy.ts) as well as server components. The DB-backed
// resolution lives in ./resolve.ts (which re-exports parseHost from here).

// The platform's apex domain. Subdomains of it map to stores.
// NOTE: `||` (not `??`) so an EMPTY string falls back too — a build that omits
// the NEXT_PUBLIC_ROOT_DOMAIN arg would otherwise yield "" → PLATFORM_URL
// "https:" → `new URL()` crashes `next build` (see lib/site.ts / app/layout.tsx).
export const ROOT_DOMAIN = (
  process.env.NEXT_PUBLIC_ROOT_DOMAIN || "storemink.com"
).toLowerCase();

// The platform's own origin (the apex). PURE and dependency-free on purpose:
// it lives here rather than in lib/site.ts so callers that need only an origin
// — the email worker's self-call, for one — don't drag in the DB-backed store
// resolver. lib/site.ts re-exports it, so every existing importer is unchanged.
// Local dev serves plain http, so assuming https for a localhost host produces
// a link that simply fails to load. That is how the policy links on
// /auth/policy-update pointed at https://localhost:3000/legal/terms — the one
// screen whose entire job is letting someone READ the document before agreeing
// to it. Real hosts are unaffected.
const schemeFor = (host: string): string =>
  /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host) ? "http" : "https";

/** Origin of a store's own `{slug}.{root}` subdomain, with the scheme this
 * environment actually serves (plain http for a localhost root). */
export function subdomainOrigin(slug: string): string {
  const host = `${slug}.${ROOT_DOMAIN}`;
  return `${schemeFor(ROOT_DOMAIN)}://${host}`;
}

export const PLATFORM_URL = ((): string => {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL;
  const raw = fromEnv
    ? fromEnv.startsWith("http")
      ? fromEnv
      : `${schemeFor(fromEnv)}://${fromEnv}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : `${schemeFor(ROOT_DOMAIN)}://${ROOT_DOMAIN}`;
  return raw.replace(/\/+$/, "");
})();

// Is this deploy the real production platform? Staging
// (ROOT_DOMAIN=staging.storemink.com), Cloud Run previews and local dev are not.
// A build-time constant because NEXT_PUBLIC_* are inlined at build.
//
// Split out from SEARCH_INDEXABLE so the two can't drift, and because they are
// NOT the same question: NEXT_PUBLIC_NOINDEX is an indexing kill-switch, and a
// caller asking "which environment am I?" must not have its answer changed by
// someone hiding production from Google for an afternoon.
export const IS_PRODUCTION_PLATFORM = ROOT_DOMAIN === "storemink.com";

// Search indexing is enabled ONLY on the real production platform apex
// (storemink.com) — and never when NEXT_PUBLIC_NOINDEX=1 forces it off. Staging,
// previews and local dev are therefore never indexed AND never ping search
// engines, with no per-deploy flag to remember (and no risk of accidentally
// no-indexing production). Consumed by app/robots.ts, app/sitemap.ts, and
// lib/seo/search-engines.ts.
export const SEARCH_INDEXABLE =
  IS_PRODUCTION_PLATFORM && process.env.NEXT_PUBLIC_NOINDEX !== "1";

export type HostKind =
  | { type: "store-subdomain"; slug: string }
  | { type: "custom-domain"; domain: string }
  | { type: "platform" };

// Map a raw Host header to what it refers to: a store subdomain, a merchant's
// custom domain, or the Storemink platform itself (apex / app / local dev / preview).
export function parseHost(host: string | null | undefined): HostKind {
  if (!host) return { type: "platform" };
  const hostname = host.split(":")[0].trim().toLowerCase();
  if (!hostname) return { type: "platform" };

  // Local dev + Vercel previews render the platform, except `{slug}.localhost`,
  // which lets us test a store's storefront locally. `pos.localhost` is a
  // reserved public product host, so it must be classified before that generic
  // store escape hatch.
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return { type: "platform" };
  }
  if (hostname === "pos.localhost") return { type: "platform" };
  if (hostname.endsWith(".localhost")) {
    const slug = hostname.slice(0, -".localhost".length);
    return slug ? { type: "store-subdomain", slug } : { type: "platform" };
  }
  if (hostname.endsWith(".vercel.app")) return { type: "platform" };

  // The apex and reserved platform hosts are not stores.
  if (
    hostname === ROOT_DOMAIN ||
    hostname === `www.${ROOT_DOMAIN}` ||
    hostname === `app.${ROOT_DOMAIN}` ||
    hostname === `pos.${ROOT_DOMAIN}` ||
    hostname === `themes.${ROOT_DOMAIN}`
  ) {
    return { type: "platform" };
  }

  // A subdomain of the root domain → store slug (everything before `.root`).
  if (hostname.endsWith(`.${ROOT_DOMAIN}`)) {
    const slug = hostname.slice(0, -(ROOT_DOMAIN.length + 1));
    return slug ? { type: "store-subdomain", slug } : { type: "platform" };
  }

  // Anything else is a merchant's own (custom) domain.
  return { type: "custom-domain", domain: hostname };
}

// True when the host is the Storemink platform (landing / login / signup), not a store.
export function isPlatformHost(host: string | null | undefined): boolean {
  return parseHost(host).type === "platform";
}

// Cookie `Domain` so a Supabase session is shared across ALL *.storemink.com
// subdomains (platform + every store) — lets an owner who signs up on
// storemink.com land logged-in on their {slug}.storemink.com dashboard. Returns
// undefined for localhost, previews, and custom domains (e.g. wholesip.com),
// which stay host-only and are therefore unaffected.
export function cookieDomainForHost(
  host: string | null | undefined,
): string | undefined {
  if (!host) return undefined;
  const hostname = host.split(":")[0].trim().toLowerCase();
  if (hostname === ROOT_DOMAIN || hostname.endsWith(`.${ROOT_DOMAIN}`)) {
    return `.${ROOT_DOMAIN}`;
  }
  return undefined;
}

// The `help.{root}` subdomain — the help centre.
export function isHelpHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const hostname = host.split(":")[0].trim().toLowerCase();
  return hostname === `help.${ROOT_DOMAIN}` || hostname === "help.localhost";
}

// The public theme catalog. It is a platform surface, never a merchant store,
// even though its hostname has the same shape as `{slug}.{ROOT_DOMAIN}`.
export function isThemesHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const hostname = host.split(":")[0].trim().toLowerCase();
  return (
    hostname === `themes.${ROOT_DOMAIN}` || hostname === "themes.localhost"
  );
}

// The public Point of Sale product site. Merchant registers remain on
// `{slug}.{root}/pos`; this reserved host is marketing/discovery only.
export function isPosHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const hostname = host.split(":")[0].trim().toLowerCase();
  return hostname === `pos.${ROOT_DOMAIN}` || hostname === "pos.localhost";
}
