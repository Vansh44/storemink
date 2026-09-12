import { describe, expect, it, vi } from "vitest";
import type { MinkConfig } from "./config";
import { runMinkAgent } from "./orchestrator";
import type {
  MinkActorContext,
  MinkModelSession,
  MinkModelTurn,
  MinkUsage,
} from "./types";
import { MinkToolRegistry } from "./tools/registry";

const ZERO_USAGE: MinkUsage = {
  promptTokens: 0,
  outputTokens: 0,
  thoughtTokens: 0,
  totalTokens: 0,
  cachedTokens: 0,
};

const ACTOR: MinkActorContext = {
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
};

function config(overrides: Partial<MinkConfig> = {}): MinkConfig {
  return {
    enabled: true,
    betaRequireInvite: true,
    // Off, matching production: the orchestrator must behave identically
    // whether or not a run is billed.
    chargeCredits: false,
    projectId: "project-1",
    location: "global",
    model: "gemini-3.7-flash",
    imageModel: "imagen-4.0-generate-001",
    imageLocation: "us-central1",
    maxSteps: 8,
    maxToolCalls: 16,
    maxParallelReadTools: 4,
    maxOutputTokens: 2_048,
    maxModelRetries: 1,
    runTimeoutMs: 120_000,
    ...overrides,
  };
}

function turn(overrides: Partial<MinkModelTurn> = {}): MinkModelTurn {
  return {
    text: "",
    functionCalls: [],
    usage: ZERO_USAGE,
    retryCount: 0,
    ...overrides,
  };
}

function registry() {
  return new MinkToolRegistry([
    {
      declaration: {
        name: "get_store_profile",
        description: "Read store.",
        parametersJsonSchema: { type: "object", properties: {} },
      },
      permission: { section: "dashboard", action: "view" },
      timeoutMs: 5_000,
      execute: vi.fn(async (actor) => ({ storeId: actor.storeId })),
    },
  ]);
}

describe("runMinkAgent", () => {
  it("executes model-selected reads, returns results, and accumulates usage", async () => {
    const sendToolResponses = vi.fn(async () =>
      turn({
        text: "Your store is ready.",
        usage: {
          promptTokens: 20,
          outputTokens: 5,
          thoughtTokens: 2,
          totalTokens: 27,
          cachedTokens: 12,
        },
      }),
    );
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [
            { id: "call-1", name: "get_store_profile", args: {} },
          ],
          usage: {
            promptTokens: 10,
            outputTokens: 3,
            thoughtTokens: 1,
            totalTokens: 14,
            cachedTokens: 7,
          },
        }),
      ),
      sendToolResponses,
    };
    const onEvent = vi.fn();

    const result = await runMinkAgent({
      actor: ACTOR,
      message: "How is my store?",
      config: config(),
      registry: registry(),
      session,
      onEvent,
    });

    expect(sendToolResponses).toHaveBeenCalledWith([
      {
        id: "call-1",
        name: "get_store_profile",
        response: { output: { storeId: "store-1" } },
      },
    ]);
    expect(result).toEqual({
      text: "Your store is ready.",
      model: "gemini-3.7-flash",
      steps: 2,
      toolCalls: 1,
      retryCount: 0,
      usage: {
        promptTokens: 30,
        outputTokens: 8,
        thoughtTokens: 3,
        totalTokens: 41,
        // 7 + 12. Each step re-sends the same deterministic system+tools
        // prefix, so the run-level cached figure has to be the SUM across
        // steps — that total is what the cost estimate prices against.
        cachedTokens: 19,
      },
      artifacts: [],
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "tool_call",
      sequence: 1,
      call: { id: "call-1", name: "get_store_profile", args: {} },
    });
    expect(onEvent).toHaveBeenCalledWith({
      type: "tool_result",
      sequence: 1,
      name: "get_store_profile",
      ok: true,
    });
  });

  it("accumulates retry telemetry and reports progress without changing tool execution", async () => {
    const onProgress = vi.fn();
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [{ name: "get_store_profile", args: {} }],
          retryCount: 1,
        }),
      ),
      sendToolResponses: vi.fn(async () =>
        turn({ text: "Ready.", retryCount: 1 }),
      ),
    };

    const result = await runMinkAgent({
      actor: ACTOR,
      message: "Check my store.",
      config: config(),
      registry: registry(),
      session,
      onProgress,
    });

    expect(result.retryCount).toBe(2);
    expect(onProgress).toHaveBeenLastCalledWith(
      expect.objectContaining({ steps: 2, toolCalls: 1, retryCount: 2 }),
    );
  });

  it("stops before exceeding the reasoning-step cap", async () => {
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [{ name: "get_store_profile", args: {} }],
        }),
      ),
      sendToolResponses: vi.fn(),
    };

    await expect(
      runMinkAgent({
        actor: ACTOR,
        message: "Keep reading forever.",
        config: config({ maxSteps: 1 }),
        registry: registry(),
        session,
      }),
    ).rejects.toMatchObject({ code: "step_limit_reached" });
    expect(session.sendToolResponses).not.toHaveBeenCalled();
  });

  it("rejects an empty final answer", async () => {
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () => turn()),
      sendToolResponses: vi.fn(),
    };

    await expect(
      runMinkAgent({
        actor: ACTOR,
        message: "Hello",
        config: config(),
        registry: registry(),
        session,
      }),
    ).rejects.toMatchObject({ code: "empty_model_response" });
  });
});
