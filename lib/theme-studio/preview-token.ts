import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Theme Studio preview grants.
//
// Two token types, one signing implementation:
//   `enter`  minted by the superadmin-gated preview action, carried once in the
//            URL of the preview host's enter route. Ten minutes.
//   `grant`  what the enter route exchanges it for: a host-only, httpOnly cookie
//            on the preview store's host. One hour.
//
// ★ Both are bound to ONE store and ONE version. A grant for version 3 does not
// open version 4's preview store, and a store re-materialized for another
// version would not accept an old grant.
//
// ★ A token is necessary, never sufficient. The gate that reads it
// (preview-access.ts) also re-checks, on every request, that the actor who
// minted it is still a superadmin. Revoking someone ends their preview access
// within one request, not when the cookie expires.
//
// ★ Its own key. THEME_STUDIO_PREVIEW_SECRET when set; otherwise a key DERIVED
// from CRON_SECRET with a purpose label, so a preview token can never be
// replayed as anything CRON_SECRET authenticates, and vice versa.
// ---------------------------------------------------------------------------

export const PREVIEW_COOKIE = "sm_studio_preview";
export const PREVIEW_ENTER_TTL_SECONDS = 10 * 60;
export const PREVIEW_GRANT_TTL_SECONDS = 60 * 60;

export type PreviewTokenType = "enter" | "grant";

export interface PreviewClaims {
  t: `studio-preview-${PreviewTokenType}`;
  /** Preview store id. */
  sid: string;
  /** Studio version id. */
  vid: string;
  /** platform_admins.id of the superadmin who minted it. */
  aid: string;
  exp: number;
}

function signingKey(): string | null {
  const explicit = process.env.THEME_STUDIO_PREVIEW_SECRET;
  if (explicit) return explicit;
  const cron = process.env.CRON_SECRET;
  if (!cron) return null;
  return createHmac("sha256", cron)
    .update("storemink:theme-studio-preview:v1")
    .digest("base64url");
}

export function previewTokensConfigured(): boolean {
  return signingKey() !== null;
}

function mac(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function signPreviewToken(
  type: PreviewTokenType,
  claims: { storeId: string; versionId: string; actorId: string },
  ttlSeconds: number,
  now: number = Date.now(),
): string {
  const key = signingKey();
  if (!key) {
    throw new Error("No preview signing key is configured.");
  }
  const body: PreviewClaims = {
    t: `studio-preview-${type}`,
    sid: claims.storeId,
    vid: claims.versionId,
    aid: claims.actorId,
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${mac(payload, key)}`;
}

/** Null on a bad signature, the wrong type, a malformed claim or expiry. */
export function verifyPreviewToken(
  token: string | null | undefined,
  type: PreviewTokenType,
  now: number = Date.now(),
): PreviewClaims | null {
  if (!token || typeof token !== "string" || token.length > 2048) return null;
  const key = signingKey();
  if (!key) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const provided = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(payload, key));
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!claims || claims.t !== `studio-preview-${type}`) return null;
  if (
    typeof claims.sid !== "string" ||
    typeof claims.vid !== "string" ||
    typeof claims.aid !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return null;
  }
  if (claims.exp * 1000 <= now) return null;
  return claims as unknown as PreviewClaims;
}
