import type { NextConfig } from "next";
import { totalmem } from "node:os";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig: NextConfig = {
  // Self-contained server bundle (.next/standalone) for the Cloud Run container
  // (GCP migration Phase 4). Copies only the traced node_modules + a minimal
  // server.js, so the runtime image stays small. Ignored by Vercel (which uses
  // its own build adapter), so this is safe to keep on during the transition.
  output: "standalone",
  // AI copy actions and Mink read Markdown prompts at runtime via fs. On serverless
  // hosts (e.g. Vercel) a function only bundles files Next.js traces, and a
  // runtime readFile path isn't traced automatically — force both prompt sources
  // into every server trace. This also puts them in .next/standalone for Cloud
  // Run. Harmless on Node hosts.
  outputFileTracingIncludes: {
    "/**": ["./brand/tasks/**", "./docs/mink-ai-system-prompt.md"],
  },
  images: {
    // Serve modern formats — AVIF (~50% smaller than JPEG) with WebP fallback.
    // Next negotiates per request via the Accept header.
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      // Google Cloud Storage (media backend, GCP migration Phase 3).
      {
        protocol: "https",
        hostname: "storage.googleapis.com",
        port: "",
        pathname: "/**",
      },
    ],
    // DEV ONLY: on DNS64/NAT64 networks (common on Indian ISPs) public hosts
    // resolve to 64:ff9b::/96 addresses, which Next 16's image-optimizer SSRF
    // guard classifies as private and blocks — every remote (GCS) image
    // 400s locally. Relax the check in development only; production keeps the
    // full SSRF protection.
    dangerouslyAllowLocalIP: process.env.NODE_ENV === "development",
  },
  experimental: {
    // Tree-shake barrel imports to per-export modules. lucide-react is already
    // optimized by default; these heavy ones are not. (They're also lazily
    // loaded via next/dynamic, so this trims what lands in their split chunks.)
    optimizePackageImports: [
      "recharts",
      "@tiptap/react",
      "@tiptap/starter-kit",
    ],
    // CSV import posts rows to a server action in chunks (CODEBASE §31). The
    // 1 MB default is comfortably enough for the 200-row chunks the importer
    // sends, but a product row carries a full description, so a chunk of long
    // ones can approach it — and the failure mode is an opaque request error
    // mid-import. Raised to leave real headroom; the chunk size, not this, is
    // what actually bounds a request.
    serverActions: { bodySizeLimit: "4mb" },
  },
  // Non-production environments serve `X-Robots-Tag: noindex` on EVERY response.
  //
  // robots.txt was doing this job alone, and it cannot finish it: `Disallow: /`
  // stops Google FETCHING a URL, but a URL that is linked from anywhere can
  // still be indexed without being fetched — it appears in results with no
  // snippet. Worse, the Disallow guarantees Google never sees a `noindex` in the
  // HTML, because it never loads the HTML. An HTTP header is the one signal that
  // survives that, and it covers non-HTML responses (JSON, XML, images) too.
  //
  // Gated on the same SEARCH_INDEXABLE rule as robots.ts / sitemap.ts, derived
  // from the baked NEXT_PUBLIC_ROOT_DOMAIN — so staging, `*.staging`, Cloud Run
  // preview URLs and localhost all get it, production never does, and there is
  // no per-deploy flag anyone can forget. Duplicated here rather than imported
  // because next.config.ts is evaluated outside the app's module graph.
  //
  // ★ HSTS IS SET HERE TOO, and it is the half that stops a repeat of the
  // pos.storemink.com outage. The load balancer had no port-80 rule at all, so
  // `http://` closed the connection — and with no HSTS a browser has no way to
  // know it should have used HTTPS, so a freshly TYPED host (no history entry
  // to autocomplete a scheme from) failed outright. The LB redirect fixes the
  // request; this stops the request being made over HTTP in the first place.
  //
  // ⚠ `includeSubDomains` is applied to OUR root domain ONLY. On storemink.com
  // that is exactly the point — one visit to the apex protects `pos.`, `help.`,
  // `themes.` and every merchant subdomain, which is what the incident needed.
  // On a MERCHANT'S custom domain it would be an overreach: we serve `acme.com`
  // over HTTPS, but `blog.acme.com` may be theirs, elsewhere, on plain HTTP,
  // and pinning it is not ours to do. Custom domains therefore get the bare
  // directive for their own host.
  //
  // No `preload`: the list is slow to leave, so it is a deliberate later step,
  // not something to inherit from a copy-pasted snippet.
  //
  // Skipped in development — the header is ignored over plain HTTP by spec
  // (RFC 6797 §8.1), so this is belt-and-braces rather than load-bearing.
  async headers() {
    const root = (process.env.NEXT_PUBLIC_ROOT_DOMAIN || "storemink.com")
      .trim()
      .toLowerCase();
    const indexable =
      root === "storemink.com" && process.env.NEXT_PUBLIC_NOINDEX !== "1";

    // Next compiles a `has`/`missing` value as `new RegExp(`^${value}$`)` and
    // matches it against the host with the PORT STRIPPED. So the port has to
    // come off this side too — `NEXT_PUBLIC_ROOT_DOMAIN` carries one in local
    // dev ("localhost:3000"), and a pattern that keeps it can never match, which
    // silently downgrades every response to the weaker header. Caught by testing
    // a built manifest rather than reading the docs. Anchoring is what makes the
    // match exact: `evilstoremink.com` cannot satisfy it.
    const ownHost = `(.*\\.)?${root
      .split(":", 1)[0]
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`;
    const hsts =
      process.env.NODE_ENV === "development"
        ? []
        : [
            {
              source: "/:path*",
              has: [{ type: "host" as const, value: ownHost }],
              headers: [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=31536000; includeSubDomains",
                },
              ],
            },
            {
              source: "/:path*",
              missing: [{ type: "host" as const, value: ownHost }],
              headers: [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=31536000",
                },
              ],
            },
          ];

    if (indexable) return hsts;
    return [
      ...hsts,
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },

  // The logs hub moved from /dashboard/activity to /dashboard/logs — one name
  // for a section that holds five logs, only one of which is the activity feed.
  //
  // ★ THE OLD PATHS MUST KEEP WORKING, and not merely as a courtesy to
  // bookmarks: every notification email ALREADY SENT carries an absolute
  // /dashboard/activity link (lib/email/notification-emails.ts), and those are
  // sitting in inboxes we cannot edit. Without this the "view in dashboard"
  // button on months of mail 404s.
  //
  // 307, not 308: temporary, so no browser pins it forever. This is an internal
  // admin path behind a login — there are no SEO signals to consolidate, and a
  // permanent redirect cached indefinitely is the trap `proxy.ts` already had to
  // work around with `Cache-Control: no-store` on the custom-domain hop.
  //
  // The query string is preserved automatically, so
  // /dashboard/activity/import-export?kind=export lands correctly.
  async redirects() {
    return [
      // Offers (docs/offers-plan.md §2). A coupon is a DELIVERY METHOD of an
      // offer, not a separate feature, so the coupons pages fold into
      // /dashboard/offers rather than living beside it.
      //
      // ⚠ `/dashboard/promotions` had no route behind it at ALL — the
      // permission section pointed there and every merchant granted it saw a
      // link that 404'd. This is the first thing that has ever answered it.
      //
      // 307, not 308, for the reason the log redirects below give: these are
      // admin paths behind a login with no SEO signals to consolidate, and a
      // 308 is cached by browsers indefinitely.
      {
        source: "/dashboard/promotions",
        destination: "/dashboard/offers",
        permanent: false,
      },
      {
        source: "/dashboard/marketing/coupons",
        destination: "/dashboard/offers",
        permanent: false,
      },
      {
        // A new discount is an offer now, so this lands on the offer editor
        // rather than bouncing to a list the merchant then has to act on.
        source: "/dashboard/marketing/coupons/new",
        destination: "/dashboard/offers/new",
        permanent: false,
      },
      // ★★ NO CATCH-ALL. `/:path*` also swallowed `[id]/edit` and
      // `[id]/email`, and BOTH are still live surfaces over the `coupons`
      // TABLE, which offers has not replaced:
      //   • coupon EMAIL CAMPAIGNS are keyed on a coupon row throughout
      //     (`lib/mink/campaign-*`, `email_campaigns`), so `[id]/email` is the
      //     only way to send one — the Pro feature had no reachable UI at all.
      //   • Mink Phase 4C still CREATES `coupons`, and its own artifacts hand
      //     the merchant `/dashboard/marketing/coupons/{id}/edit`
      //     (`lib/mink/tools/draft-tools.ts`, `lib/mink/domain-actions.ts`).
      //     That id may exist ONLY in `coupons`, so redirecting it to the
      //     offers list dead-ends on a list that cannot contain it.
      // Retiring those two means migrating campaigns off coupons first; until
      // then this covers the destinations that genuinely moved.
      {
        source: "/dashboard/activity",
        destination: "/dashboard/logs",
        permanent: false,
      },
      {
        source: "/dashboard/activity/:path*",
        destination: "/dashboard/logs/:path*",
        permanent: false,
      },
      // The OPERATOR console's two logs moved under the same hub, for the same
      // reason: they were top-level entries with no relationship shown, so the
      // console had two answers to "where do I look?" and no list of the rest.
      //
      // ⚠ These sources are platform-only paths — the merchant dashboard has
      // never had `/dashboard/email-logs` or `/dashboard/failures` (its logs
      // were `/dashboard/activity/*`, redirected above). So a global redirect
      // is safe on every host: on a merchant host these 404 today, and
      // afterwards they land on that store's own equivalent, which is an
      // improvement rather than a hazard.
      //
      // 307 again, deliberately. `getPlatformOverview`-era links and operator
      // bookmarks point here, and a 308 is cached by browsers indefinitely —
      // the trap proxy.ts already had to work around with `Cache-Control:
      // no-store` on the custom-domain hop (§30). There are no SEO signals to
      // consolidate behind a login.
      {
        source: "/dashboard/email-logs",
        destination: "/dashboard/logs/email-logs",
        permanent: false,
      },
      {
        source: "/dashboard/failures",
        destination: "/dashboard/logs/failures",
        permanent: false,
      },
    ];
  },
};

export default function configForPhase(phase: string): NextConfig {
  if (phase !== PHASE_DEVELOPMENT_SERVER) return nextConfig;

  const lowMemory = totalmem() <= 12 * 1024 ** 3;
  const parallelism = Number(
    process.env.DEV_WEBPACK_PARALLELISM ?? (lowMemory ? 8 : 32),
  );
  if (!Number.isSafeInteger(parallelism) || parallelism < 1) {
    throw new Error("DEV_WEBPACK_PARALLELISM must be a positive integer.");
  }

  return {
    ...nextConfig,
    // Explicit Turbopack remains available; the callback below is Webpack-only.
    turbopack: {},
    ...(lowMemory
      ? { onDemandEntries: { maxInactiveAge: 25_000, pagesBufferLength: 2 } }
      : {}),
    webpack(config) {
      // Webpack defaults to 100 concurrent modules PER compiler. Next runs
      // client/server compilers: trade some cold-build throughput for headroom.
      config.parallelism = parallelism;
      // Avoid per-module path comments and their GC cost. Keep Next's source
      // maps, loaders, chunking and filesystem/MemoryWithGc caches intact.
      config.output = { ...config.output, pathinfo: false };
      return config;
    },
  };
}
