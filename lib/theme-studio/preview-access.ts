import "server-only";

import { cache } from "react";
import { cookies, headers } from "next/headers";
import { and, eq, gt, sql } from "drizzle-orm";
import { platformAdmins, themeStudioCaptures } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { cookieDomainForHost } from "@/lib/store/host";
import { getThemeStudioActor } from "./access";
import {
  CAPTURE_COOKIE,
  PREVIEW_COOKIE,
  verifyPreviewToken,
} from "./preview-token";

// ---------------------------------------------------------------------------
// The gate in front of a Theme Studio preview store.
//
// A preview store is an ordinary active store row, so without this the host
// lookup would serve it to anyone who learned its address. The store resolver
// (lib/store/resolve.ts) asks this question for every preview store it
// resolves and treats a "no" exactly like an unclaimed subdomain: the page is a
// 404 and a server action falls back as it does for any unknown host.
//
// ★ AT THE RESOLVER, NOT THE LAYOUT. A layout notFound() does not stop child
// pages that are already rendering, so a gate there would still stream the
// candidate's pages into the HTML. Every storefront page and action resolves
// its store through the resolver, so gating there covers all of them.
//
// What must hold, on every request:
//   1. a grant cookie signed for THIS store and THIS version, unexpired;
//   2. the superadmin who minted it is still a superadmin;
//   3. where the session cookie is shared with the preview host (every real
//      *.storemink.com environment), the session is that same superadmin.
// Condition 3 cannot hold on a host-only-cookie environment such as local
// development, where the platform's session never reaches a store subdomain;
// there the grant plus condition 2 is the gate.
//
// ★ OR a capture cookie (Track 3.6): the headless capture job has no session,
// so it presents a token minted for one capture, and the gate honours it only
// while THAT capture is running with an unexpired lease, for exactly the
// version it captures. A leaked capture cookie is worthless once the capture
// ends, which is minutes, and it can open nothing but that one preview.
// ---------------------------------------------------------------------------

async function actorIsSuperadmin(actorId: string): Promise<boolean> {
  try {
    const rows = await withService((db) =>
      db
        .select({ role: platformAdmins.role })
        .from(platformAdmins)
        .where(eq(platformAdmins.id, actorId))
        .limit(1),
    );
    return rows[0]?.role === "superadmin";
  } catch {
    return false; // fail closed: an unreadable row is not a superadmin
  }
}

/** Conditions 2 and 3 for the actor a token names, on this request's host.
 * Shared by the gate and by the enter route that issues the grant cookie. */
export async function actorMayPreview(
  actorId: string,
  host: string,
): Promise<boolean> {
  if (!(await actorIsSuperadmin(actorId))) return false;
  if (cookieDomainForHost(host)) {
    const actor = await getThemeStudioActor();
    if (actor?.id !== actorId) return false;
  }
  return true;
}

/** Request-deduplicated: the resolver runs many times per render. */
/** A capture cookie whose capture is running now, for this version. */
async function captureIsRunning(
  captureId: string,
  versionId: string,
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(captureId)) return false;
  try {
    const rows = await withService((db) =>
      db
        .select({ id: themeStudioCaptures.id })
        .from(themeStudioCaptures)
        .where(
          and(
            eq(themeStudioCaptures.id, captureId),
            eq(themeStudioCaptures.versionId, versionId),
            eq(themeStudioCaptures.status, "running"),
            gt(themeStudioCaptures.leaseExpiresAt, sql`now()`),
          ),
        )
        .limit(1),
    );
    return rows.length === 1;
  } catch {
    return false; // fail closed
  }
}

export const studioPreviewAllowed = cache(
  async (storeId: string, versionId: string): Promise<boolean> => {
    const jar = await cookies();
    const capture = verifyPreviewToken(
      jar.get(CAPTURE_COOKIE)?.value,
      "capture",
    );
    if (
      capture &&
      capture.sid === storeId &&
      capture.vid === versionId &&
      (await captureIsRunning(capture.aid, versionId))
    ) {
      return true;
    }
    const claims = verifyPreviewToken(jar.get(PREVIEW_COOKIE)?.value, "grant");
    if (!claims || claims.sid !== storeId || claims.vid !== versionId) {
      return false;
    }
    const headerList = await headers();
    const host =
      headerList.get("x-forwarded-host") || headerList.get("host") || "";
    return actorMayPreview(claims.aid, host);
  },
);
