import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  previewTokensConfigured,
  signPreviewToken,
  verifyPreviewToken,
} from "./preview-token";

const CLAIMS = {
  storeId: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
  actorId: "33333333-3333-4333-8333-333333333333",
};

afterEach(() => vi.unstubAllEnvs());

describe("Theme Studio preview tokens", () => {
  it("round-trips a token of the same type", () => {
    vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "explicit-secret");
    const token = signPreviewToken("enter", CLAIMS, 60);
    expect(verifyPreviewToken(token, "enter")).toMatchObject({
      sid: CLAIMS.storeId,
      vid: CLAIMS.versionId,
      aid: CLAIMS.actorId,
    });
  });

  it("refuses the other token type, so an entry token is never a grant", () => {
    vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "explicit-secret");
    const enter = signPreviewToken("enter", CLAIMS, 60);
    expect(verifyPreviewToken(enter, "grant")).toBeNull();
  });

  it("refuses an expired token", () => {
    vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "explicit-secret");
    const now = Date.now();
    const token = signPreviewToken("grant", CLAIMS, 60, now);
    expect(verifyPreviewToken(token, "grant", now + 59_000)).not.toBeNull();
    expect(verifyPreviewToken(token, "grant", now + 60_000)).toBeNull();
  });

  it("refuses a tampered payload and a token signed with another key", () => {
    vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "explicit-secret");
    const token = signPreviewToken("grant", CLAIMS, 60);
    const [payload, mac] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, "base64url").toString()),
        vid: "44444444-4444-4444-8444-444444444444",
      }),
    ).toString("base64url");
    expect(verifyPreviewToken(`${forged}.${mac}`, "grant")).toBeNull();
    vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "a-different-secret");
    expect(verifyPreviewToken(token, "grant")).toBeNull();
  });

  it("derives a purpose-bound key from CRON_SECRET when no explicit key is set", () => {
    vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "");
    vi.stubEnv("CRON_SECRET", "cron-secret");
    expect(previewTokensConfigured()).toBe(true);
    const token = signPreviewToken("enter", CLAIMS, 60);
    const [payload, mac] = token.split(".");
    // Not a plain HMAC under CRON_SECRET itself.
    expect(
      createHmac("sha256", "cron-secret").update(payload).digest("base64url"),
    ).not.toBe(mac);
    expect(verifyPreviewToken(token, "enter")).not.toBeNull();
  });

  it("is unconfigured, and signs nothing, with neither secret", () => {
    vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "");
    vi.stubEnv("CRON_SECRET", "");
    expect(previewTokensConfigured()).toBe(false);
    expect(() => signPreviewToken("enter", CLAIMS, 60)).toThrow();
    expect(verifyPreviewToken("a.b", "enter")).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "explicit-secret");
    for (const bad of [null, undefined, "", "nodot", ".x", "x".repeat(3000)]) {
      expect(verifyPreviewToken(bad, "grant")).toBeNull();
    }
  });
});
