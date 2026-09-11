import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@google/genai", () => ({
  ThinkingLevel: { HIGH: "HIGH", LOW: "LOW" },
  GoogleGenAI: class {
    chats = { create: h.create };
  },
}));

import { createVertexMinkSession } from "./vertex-client";
import type { MinkConfig } from "./config";
import type { MinkActorContext } from "./types";

const actor: MinkActorContext = {
  storeId: "store-1",
  adminId: "owner",
  email: null,
  effectivePlan: "pro",
  roleSlug: "manager",
  permissions: { dashboard: ["view"] },
  isSuperadmin: false,
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "test",
};
const config = {
  projectId: "test",
  model: "gemini-3.7-flash",
  location: "global",
  maxOutputTokens: 100,
  maxModelRetries: 0,
} as MinkConfig;

const reply = (usageMetadata: Record<string, number>) => ({
  candidates: [{ content: { parts: [{ text: "ok" }] } }],
  usageMetadata,
});

function session() {
  return createVertexMinkSession(config, actor, [], { history: [] });
}

// The deterministic system-prompt + tool-declaration prefix is re-sent on every
// step of every run and is the largest single cost line. Whether a provider
// cache is serving it is invisible unless this mapping exists, so these pin the
// read itself — deleting the line would otherwise change no visible behaviour.
describe("Vertex usage mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.create.mockReturnValue({ sendMessage: h.send });
    h.send.mockResolvedValue(reply({}));
  });

  it("reads the provider's cached prompt-token count", async () => {
    h.send.mockResolvedValue(
      reply({
        promptTokenCount: 11_000,
        candidatesTokenCount: 250,
        thoughtsTokenCount: 40,
        totalTokenCount: 11_290,
        cachedContentTokenCount: 10_400,
      }),
    );
    const turn = await session().sendUserMessage("hello");
    expect(turn.usage.cachedTokens).toBe(10_400);
  });

  it("keeps the cached count OUT of promptTokens — it is a subset, not an addition", async () => {
    // The provider documents promptTokenCount as already including cached
    // content. Adding the two would inflate every run's input on the one line
    // the cost estimate is most sensitive to.
    h.send.mockResolvedValue(
      reply({ promptTokenCount: 11_000, cachedContentTokenCount: 10_400 }),
    );
    const turn = await session().sendUserMessage("hello");
    expect(turn.usage.promptTokens).toBe(11_000);
  });

  it("treats a provider that reports no cache as zero cached, not as a failure", async () => {
    h.send.mockResolvedValue(reply({ promptTokenCount: 11_000 }));
    const turn = await session().sendUserMessage("hello");
    expect(turn.usage).toMatchObject({ promptTokens: 11_000, cachedTokens: 0 });
  });

  it("survives a response with no usage metadata at all", async () => {
    h.send.mockResolvedValue(reply({} as Record<string, number>));
    const turn = await session().sendUserMessage("hello");
    expect(turn.usage.cachedTokens).toBe(0);
  });
});
