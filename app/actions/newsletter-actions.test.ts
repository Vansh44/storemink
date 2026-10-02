/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { newsletterSubscribers } from "@/drizzle/schema";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/headers", () => ({
  headers: vi
    .fn()
    .mockResolvedValue(new Headers({ "x-forwarded-for": "1.2.3.4" })),
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreOrNull: vi.fn(async () => ({
    id: "a0000000-0000-4000-8000-000000000001",
  })),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  clientIp: vi.fn(() => "1.2.3.4"),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import { rateLimit } from "@/lib/rate-limit";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { subscribeNewsletter } from "./newsletter-actions";

const initial = { status: "idle", message: "" } as const;

function form(values: Record<string, string> = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    email: " Ada@Example.com ",
    consent: "on",
    source: "section",
    consent_text: " I agree to receive product news. ",
    ...values,
  })) {
    data.set(key, value);
  }
  return data;
}

describe("subscribeNewsletter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock();
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true });
    vi.mocked(getCurrentStoreOrNull).mockResolvedValue({
      id: "a0000000-0000-4000-8000-000000000001",
    } as any);
  });

  it("stores no consent on a theme demo store", async () => {
    vi.mocked(getCurrentStoreOrNull).mockResolvedValue({
      id: "a0000000-0000-4000-8000-000000000001",
      settings: { demo: true },
    } as any);
    expect(await subscribeNewsletter(initial, form())).toEqual({
      status: "error",
      message:
        "This is a theme preview, so orders, accounts and forms are turned off.",
    });
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("rejects malformed email and missing consent before persistence", async () => {
    expect(
      await subscribeNewsletter(initial, form({ email: "bad" })),
    ).toMatchObject({
      status: "error",
      message: expect.stringMatching(/valid email/i),
    });
    expect(
      await subscribeNewsletter(initial, form({ consent: "" })),
    ).toMatchObject({
      status: "error",
      message: expect.stringMatching(/confirm/i),
    });
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("quietly accepts honeypot submissions without touching storage", async () => {
    const result = await subscribeNewsletter(initial, form({ website: "bot" }));
    expect(result.status).toBe("success");
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("does not fall back to another tenant for an unknown host", async () => {
    vi.mocked(getCurrentStoreOrNull).mockResolvedValue(null);
    const result = await subscribeNewsletter(initial, form());
    expect(result).toMatchObject({
      status: "error",
      message: expect.stringMatching(/isn't available/i),
    });
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("upserts a normalised, consented store subscription", async () => {
    const result = await subscribeNewsletter(initial, form());
    expect(result.status).toBe("success");
    expect(dbHolder.current.calls.insert[0]).toBe(newsletterSubscribers);
    expect(dbHolder.current.calls.values[0]).toMatchObject({
      storeId: "a0000000-0000-4000-8000-000000000001",
      email: "ada@example.com",
      source: "section",
      status: "active",
      consentText: "I agree to receive product news.",
      consentedAt: expect.any(String),
    });
    expect(dbHolder.current.calls.onConflict).toHaveLength(1);
    expect(rateLimit).toHaveBeenCalledWith(
      "newsletter:a0000000-0000-4000-8000-000000000001:1.2.3.4",
      { max: 10, windowSeconds: 3600 },
    );
  });

  it("limits source to footer or section", async () => {
    await subscribeNewsletter(initial, form({ source: "untrusted" }));
    expect(dbHolder.current.calls.values[0].source).toBe("section");
    await subscribeNewsletter(initial, form({ source: "footer" }));
    expect(dbHolder.current.calls.values[1].source).toBe("footer");
  });

  it("rejects rate-limited attempts before persistence", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false });
    const result = await subscribeNewsletter(initial, form());
    expect(result).toMatchObject({
      status: "error",
      message: expect.stringMatching(/too many/i),
    });
    expect(dbHolder.current.calls.insert).toHaveLength(0);
  });

  it("returns a friendly error when persistence fails", async () => {
    dbHolder.current = makeDbMock({ failInsertFor: [newsletterSubscribers] });
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const result = await subscribeNewsletter(initial, form());
    expect(result).toMatchObject({
      status: "error",
      message: expect.stringMatching(/couldn't save/i),
    });
    consoleSpy.mockRestore();
  });
});
