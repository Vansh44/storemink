import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  enabled: true,
  actor: vi.fn(),
  usage: vi.fn(),
  allowed: true,
}));

vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({ enabled: holder.enabled })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/ai/quota", () => ({ getAiUsage: holder.usage }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.allowed })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { GET } from "./route";

beforeEach(() => {
  holder.enabled = true;
  holder.allowed = true;
  holder.actor.mockResolvedValue({ storeId: "store-1", adminId: "admin-1" });
  holder.usage.mockResolvedValue({
    used: 8,
    cap: 20,
    creditBalance: 5,
    resetsAt: "2026-10-15T06:30:00.000Z",
    available: true,
  });
});

describe("GET /api/mink/credits", () => {
  it("returns the trusted actor's own store balance", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(holder.usage).toHaveBeenCalledWith("store-1");
    expect(body).toMatchObject({ used: 8, cap: 20, creditBalance: 5 });
  });

  it("is unavailable while the global Mink switch is off", async () => {
    holder.enabled = false;
    const response = await GET();

    expect(response.status).toBe(404);
    // The actor resolve is the expensive half (permissions, store, brand voice),
    // so the emergency switch has to short-circuit BEFORE it, not after.
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("rate limits balance reads per actor", async () => {
    holder.allowed = false;
    const response = await GET();

    expect(response.status).toBe(429);
    expect(holder.usage).not.toHaveBeenCalled();
  });

  // ★ getAiUsage reports `cap: null` when its READ FAILS, which is
  // indistinguishable from an unmetered plan. Serving it would have the
  // composer paint a full green ring reading "Unlimited Mink credits" over a
  // store with nothing left, so an unreadable balance is a 503.
  it("never serves a failed read as an unlimited balance", async () => {
    holder.usage.mockResolvedValue({
      used: 0,
      cap: null,
      creditBalance: 0,
      resetsAt: "2026-10-01T00:00:00.000Z",
      available: false,
    });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("cap");
  });
});
