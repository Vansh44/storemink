import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { stores } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { parseHost } from "@/lib/store/host";
import { actorMayPreview } from "@/lib/theme-studio/preview-access";
import {
  isSafePreviewPath,
  studioPreviewMarker,
} from "@/lib/theme-studio/preview-store";
import {
  PREVIEW_COOKIE,
  PREVIEW_GRANT_TTL_SECONDS,
  signPreviewToken,
  verifyPreviewToken,
} from "@/lib/theme-studio/preview-token";

// The door into a Theme Studio preview store.
//
// The Studio's preview action (superadmin-gated, on the platform host) mints a
// ten-minute `enter` token; this route, on the PREVIEW STORE'S OWN HOST,
// exchanges it for an hour-long, host-only, httpOnly grant cookie and redirects
// to the page asked for. From then on the store resolver's gate
// (lib/theme-studio/preview-access.ts) reads the cookie on every request.
//
// ★ Everything is re-proved here, nothing is trusted from the URL: the token's
// signature and expiry, that it names THIS host's store and that store's
// current version, and that its actor is still a superadmin.
//
// ★ A cookie in a frame. The Studio shows the preview in an iframe. Where the
// platform and the preview host are the same site (every *.storemink.com
// environment) a Lax cookie works there; where they are not (localhost and a
// store subdomain of it are different sites) only a Partitioned SameSite=None
// cookie survives, so a framed request gets that and a top-level one — the
// pop-out — gets an ordinary Lax cookie.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function refuse(): NextResponse {
  return new NextResponse(
    "This preview link has expired. Open it again from Theme Studio.",
    {
      status: 403,
      headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
    },
  );
}

export async function GET(request: NextRequest) {
  const claims = verifyPreviewToken(
    request.nextUrl.searchParams.get("token"),
    "enter",
  );
  if (!claims) return refuse();
  const host =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    "";
  const kind = parseHost(host);
  if (kind.type !== "store-subdomain") return refuse();

  const [store] = await withService((db) =>
    db
      .select({ slug: stores.slug, settings: stores.settings })
      .from(stores)
      .where(eq(stores.id, claims.sid))
      .limit(1),
  ).catch(() => []);
  const marker = store ? studioPreviewMarker(store.settings) : null;
  if (!store || store.slug !== kind.slug || marker?.versionId !== claims.vid) {
    return refuse();
  }
  if (!(await actorMayPreview(claims.aid, host))) return refuse();

  const requested = request.nextUrl.searchParams.get("path");
  const path = isSafePreviewPath(requested) ? requested : "/";
  // A RELATIVE Location, so the browser stays on the host it asked: behind a
  // proxy (and in development) `nextUrl.origin` is the server's own address,
  // not the preview store's, and would send the operator somewhere else.
  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: path },
  });
  const framed = request.headers.get("sec-fetch-dest") === "iframe";
  const secure = request.nextUrl.protocol === "https:";
  response.cookies.set({
    name: PREVIEW_COOKIE,
    value: signPreviewToken(
      "grant",
      { storeId: claims.sid, versionId: claims.vid, actorId: claims.aid },
      PREVIEW_GRANT_TTL_SECONDS,
    ),
    httpOnly: true,
    path: "/",
    maxAge: PREVIEW_GRANT_TTL_SECONDS,
    ...(framed
      ? { sameSite: "none" as const, secure: true, partitioned: true }
      : { sameSite: "lax" as const, secure }),
  });
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
