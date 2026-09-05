import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({
  enabled: true,
  run: vi.fn(),
  actor: vi.fn(),
  rateAllowed: true,
  startRun: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
  startTool: vi.fn(),
  completeTool: vi.fn(),
  runTimeoutMs: 120_000,
  declarations: [] as Array<{ name: string }>,
  createSession: vi.fn(() => ({})),
}));

vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: vi.fn(() => ({
    enabled: holder.enabled,
    betaRequireInvite: true,
    projectId: "project-1",
    location: "global",
    model: "gemini-3.7-flash",
    maxSteps: 8,
    maxToolCalls: 16,
    maxParallelReadTools: 4,
    maxOutputTokens: 2_048,
    maxModelRetries: 1,
    runTimeoutMs: holder.runTimeoutMs,
  })),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: holder.actor,
}));
vi.mock("@/lib/mink/orchestrator", () => ({
  runMinkAgent: holder.run,
}));
vi.mock("@/lib/mink/persistence", () => ({
  startMinkRun: holder.startRun,
  completeMinkRun: holder.completeRun,
  failMinkRun: holder.failRun,
  startMinkToolCall: holder.startTool,
  completeMinkToolCall: holder.completeTool,
}));
vi.mock("@/lib/mink/tools/read-tools", () => ({
  minkReadToolRegistry: {
    declarationsFor: vi.fn(() => holder.declarations),
  },
}));
vi.mock("@/lib/mink/vertex-client", () => ({
  createVertexMinkSession: holder.createSession,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.rateAllowed })),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  holder.enabled = true;
  holder.rateAllowed = true;
  holder.runTimeoutMs = 120_000;
  holder.declarations = [];
  holder.actor.mockResolvedValue({
    storeId: "store-1",
    adminId: "admin-1",
    email: "owner@example.com",
    roleSlug: "superadmin",
    permissions: {},
    isSuperadmin: true,
    effectivePlan: "pro",
    locationIds: null,
    analyticsTimeZone: "Asia/Kolkata",
    currency: "INR",
    defaultLowStockThreshold: 5,
    requestId: "request-1",
  });
  holder.startRun.mockResolvedValue({
    conversationId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    history: [],
  });
  holder.completeRun.mockResolvedValue(undefined);
  holder.failRun.mockResolvedValue(undefined);
  holder.startTool.mockResolvedValue(undefined);
  holder.completeTool.mockResolvedValue(undefined);
  holder.run.mockResolvedValue({
    text: "You have 12 published products.",
    model: "gemini-3.7-flash",
    steps: 2,
    toolCalls: 1,
    retryCount: 0,
    usage: {
      promptTokens: 100,
      outputTokens: 20,
      thoughtTokens: 10,
      totalTokens: 130,
    },
    artifacts: [],
  });
});

describe("POST /api/mink/stream", () => {
  it("is unreachable until explicitly enabled", async () => {
    holder.enabled = false;
    const response = await POST(request({ message: "Hello" }));

    expect(response.status).toBe(404);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request before charging or reading store data", async () => {
    const response = await POST(
      request({ message: "Hello" }, { origin: "https://attacker.example" }),
    );

    expect(response.status).toBe(403);
    expect(holder.actor).not.toHaveBeenCalled();
  });

  it("accepts the public dashboard origin behind an internal proxy host", async () => {
    const publicHost = "echos.staging.storemink.com";
    const response = await POST(
      request(
        { message: "Hello" },
        {
          origin: `https://${publicHost}`,
          "x-forwarded-host": publicHost,
          host: "internal-service:8080",
        },
      ),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(holder.actor).toHaveBeenCalledOnce();
  });

  it("accepts a same-origin local store host without proxy headers", async () => {
    const response = await POST(
      request(
        { message: "Hello" },
        {
          origin: "http://echos.localhost:3000",
          host: "echos.localhost:3000",
        },
      ),
    );
    await response.text();

    expect(response.status).toBe(200);
  });

  it("returns app-level SSE events and trims the user message", async () => {
    const response = await POST(request({ message: "  Show my catalog  " }));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(holder.run).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Show my catalog" }),
    );
    expect(holder.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Show my catalog",
        conversationId: undefined,
      }),
    );
    expect(holder.completeRun).toHaveBeenCalledOnce();
    expect(body).toContain("event: status");
    expect(body).toContain("11111111-1111-4111-8111-111111111111");
    expect(body).toContain("event: message");
    expect(body).toContain("You have 12 published products.");
    expect(body).toContain("event: usage");
    expect(body).toContain("event: done");
  });

  it("uses high thinking only for an authorised storefront code request", async () => {
    holder.declarations = [{ name: "propose_storefront_custom_code" }];
    const response = await POST(
      request({
        message: "Redesign my homepage hero and generate custom code",
      }),
    );
    await response.text();

    expect(holder.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingLevel: "high" }),
    );
    expect(holder.createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      holder.declarations,
      expect.objectContaining({ thinkingLevel: "high" }),
    );

    holder.declarations = [];
    const readResponse = await POST(
      request({
        message: "Redesign my homepage hero and generate custom code",
      }),
    );
    await readResponse.text();
    expect(holder.startRun).toHaveBeenLastCalledWith(
      expect.objectContaining({ thinkingLevel: "low" }),
    );
  });

  it("rejects invalid messages before opening a model session", async () => {
    const response = await POST(request({ message: "   " }));

    expect(response.status).toBe(400);
    expect(holder.run).not.toHaveBeenCalled();
    expect(holder.startRun).not.toHaveBeenCalled();
  });

  it("rate limits per actor before calling Vertex", async () => {
    holder.rateAllowed = false;
    const response = await POST(request({ message: "Hello" }));

    expect(response.status).toBe(429);
    expect(holder.run).not.toHaveBeenCalled();
  });

  it("continues only a well-formed conversation id", async () => {
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const response = await POST(
      request({ message: "And drafts?", conversationId }),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(holder.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId }),
    );

    const rejected = await POST(
      request({ message: "And drafts?", conversationId: "not-an-id" }),
    );
    expect(rejected.status).toBe(400);
  });

  it("records a failed run before returning a safe SSE error", async () => {
    holder.run.mockRejectedValueOnce(new Error("database details"));
    const response = await POST(request({ message: "Show my catalog" }));
    const body = await response.text();

    expect(holder.failRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "mink_failed" }),
    );
    expect(body).toContain("Mink AI couldn't complete that request.");
    expect(body).not.toContain("database details");
  });

  it("fails a hard-timeout run instead of recording it as user cancellation", async () => {
    holder.runTimeoutMs = 5;
    holder.run.mockImplementationOnce(
      () =>
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new DOMException("aborted", "AbortError")),
            10,
          ),
        ),
    );
    const response = await POST(request({ message: "Slow question" }));
    const body = await response.text();

    expect(holder.failRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", errorCode: "run_timeout" }),
    );
    expect(body).toContain("Mink AI took too long to finish");
  });
});

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://acme.storemink.com/api/mink/stream", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
