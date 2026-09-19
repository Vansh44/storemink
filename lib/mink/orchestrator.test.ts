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
    imageModel: "gemini-2.5-flash-image",
    imageLocation: "global",
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

  it("finishes the observed offer-banner trace when its proposal is selected on the last turn", async () => {
    // Production, 2026-09-20: eleven completed tool rounds made these fifteen
    // successful calls. The image was ready, and a twelfth model turn returned
    // another function call, but the old top-of-loop guard rejected it before
    // even recording its name. Supply the expected final layout proposal here
    // to pin the completion path that was previously impossible at the cap.
    const toolTurns = [
      ["list_current_offers", "get_storefront_page_context"],
      ["get_storefront_section_context", "list_storefront_media"],
      ["search_help_centre"],
      ["search_help_centre"],
      ["list_storefront_pages"],
      ["search_help_centre"],
      ["search_help_centre"],
      ["search_products", "search_products"],
      ["get_catalog_summary"],
      ["search_products", "search_products"],
      ["generate_storefront_image"],
      ["propose_storefront_layout"],
    ];
    const names = [...new Set(toolTurns.flat())];
    const traceRegistry = new MinkToolRegistry(
      names.map((name) => ({
        declaration: {
          name,
          description: name,
          parametersJsonSchema: { type: "object", properties: {} },
        },
        permission: { section: "dashboard", action: "view" },
        timeoutMs: 5_000,
        ...(name === "propose_storefront_layout"
          ? {
              stepLimitCompletionText: "The layout proposal is ready.",
              artifact: () =>
                ({
                  type: "storefront_layout_proposal",
                  title: "Home",
                }) as never,
            }
          : {}),
        execute: vi.fn(async () => ({ ok: true })),
      })),
    );
    let nextTurn = 0;
    const modelTurn = () =>
      turn({
        functionCalls: toolTurns[nextTurn++].map((name, index) => ({
          id: `turn-${nextTurn}-call-${index + 1}`,
          name,
          args: { sequence: nextTurn, index },
        })),
      });
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () => modelTurn()),
      // There must be no thirteenth, prose-only model call after the final
      // proposal: deterministic completion is the bounded cost of this fix.
      sendToolResponses: vi.fn(async () => modelTurn()),
    };
    const onEvent = vi.fn();

    const result = await runMinkAgent({
      actor: ACTOR,
      message:
        "Create the banner on the homepage carousel for this buy 1 get 1 offer.",
      config: config({ maxSteps: 12, maxToolCalls: 16 }),
      registry: traceRegistry,
      session,
      onEvent,
    });

    expect(result).toMatchObject({
      text: "The layout proposal is ready.",
      steps: 12,
      toolCalls: 16,
      artifacts: [{ type: "storefront_layout_proposal" }],
    });
    expect(session.sendToolResponses).toHaveBeenCalledTimes(11);
    expect(onEvent).toHaveBeenCalledWith({
      type: "tool_call",
      sequence: 16,
      call: expect.objectContaining({ name: "propose_storefront_layout" }),
    });
  });

  it("does not spend the last-turn escape hatch on a read", async () => {
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

  it("does not claim last-turn success when a marked finalizer produces no review artifact", async () => {
    const finalizerRegistry = new MinkToolRegistry([
      {
        declaration: {
          name: "propose_storefront_layout",
          description: "Propose a layout.",
          parametersJsonSchema: { type: "object", properties: {} },
        },
        permission: { section: "dashboard", action: "view" },
        timeoutMs: 5_000,
        stepLimitCompletionText: "The layout proposal is ready.",
        execute: vi.fn(async () => ({ ok: true })),
      },
    ]);
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [{ name: "propose_storefront_layout", args: {} }],
        }),
      ),
      sendToolResponses: vi.fn(),
    };

    await expect(
      runMinkAgent({
        actor: ACTOR,
        message: "Create the banner.",
        config: config({ maxSteps: 1 }),
        registry: finalizerRegistry,
        session,
      }),
    ).rejects.toMatchObject({ code: "step_limit_reached" });
    expect(session.sendToolResponses).not.toHaveBeenCalled();
  });

  it("finishes a bounded compound workflow that needs more than eight model turns", async () => {
    let completedToolTurns = 0;
    const anotherRead = () =>
      turn({
        functionCalls: [{ name: "get_store_profile", args: {} }],
      });
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () => anotherRead()),
      sendToolResponses: vi.fn(async () => {
        completedToolTurns += 1;
        return completedToolTurns < 8
          ? anotherRead()
          : turn({ text: "The image and homepage proposal are ready." });
      }),
    };

    const result = await runMinkAgent({
      actor: ACTOR,
      message: "Create an image and prepare my homepage carousel.",
      config: config({ maxSteps: 12 }),
      registry: registry(),
      session,
    });

    expect(result).toMatchObject({ steps: 9, toolCalls: 8 });
    expect(result.text).toContain("homepage proposal");
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

// ---------------------------------------------------------------------------
// ★★ A REPEATED PURE READ COSTS NO TOOL BUDGET.
//
// Observed on a live run that failed at the step limit: 15 tool calls, every
// one SUCCEEDED, and 8 of them repeated 4 reads the model had already made — so
// it never reached the tools that would have finished the job. The runtime
// prompt already asks it not to repeat a successful read; the memo makes that
// true whether or not the model complies.
// ---------------------------------------------------------------------------
describe("repeated tool calls", () => {
  function memoRegistry(repeatSafe: boolean, execute = vi.fn()) {
    return new MinkToolRegistry([
      {
        declaration: {
          name: "search_products",
          description: "Find products.",
          parametersJsonSchema: { type: "object", properties: {} },
        },
        permission: { section: "products", action: "view" },
        timeoutMs: 5_000,
        repeatSafe,
        artifact: () => ({ type: "records", title: "Products" }) as never,
        execute,
      },
    ]);
  }

  /** Two turns each asking for the same read, then a final answer. */
  function twiceThenAnswer(
    args: [Record<string, unknown>, Record<string, unknown>],
  ) {
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [{ id: "c1", name: "search_products", args: args[0] }],
        }),
      ),
      sendToolResponses: vi
        .fn()
        .mockResolvedValueOnce(
          turn({
            functionCalls: [
              { id: "c2", name: "search_products", args: args[1] },
            ],
          }),
        )
        .mockResolvedValueOnce(turn({ text: "Done." })),
    };
    return session;
  }

  it("serves an identical repeat from the memo and does not re-execute it", async () => {
    const execute = vi.fn(async () => ({ items: [] }));
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: memoRegistry(true, execute),
      session: twiceThenAnswer([{ q: "chair" }, { q: "chair" }]),
    });

    expect(execute).toHaveBeenCalledTimes(1);
    // The budget only counts what actually ran — the point of the whole fix.
    expect(result.toolCalls).toBe(1);
  });

  it("★ key order does not make two identical calls look different", async () => {
    const execute = vi.fn(async () => ({ items: [] }));
    await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: memoRegistry(true, execute),
      session: twiceThenAnswer([
        { q: "chair", limit: 5 },
        { limit: 5, q: "chair" },
      ]),
    });

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("★ a DIFFERENT argument is a different call and still runs", async () => {
    const execute = vi.fn(async () => ({ items: [] }));
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: memoRegistry(true, execute),
      session: twiceThenAnswer([{ q: "chair" }, { q: "lamp" }]),
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toBe(2);
  });

  // ⚠ Opt-in, and it must stay opt-in: the tools that are NOT marked are the
  // ones that queue a workflow, create a proposal, or spend money on an image.
  it("★★ never de-duplicates a tool that is not marked repeat-safe", async () => {
    const execute = vi.fn(async () => ({ items: [] }));
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: memoRegistry(false, execute),
      session: twiceThenAnswer([{ q: "chair" }, { q: "chair" }]),
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toBe(2);
  });

  // ⚠ A failure is often transient; replaying it would deny the model its one
  // legitimate retry.
  it("★ does not remember a failed read", async () => {
    const execute = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ items: [] });
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: memoRegistry(true, execute),
      session: twiceThenAnswer([{ q: "chair" }, { q: "chair" }]),
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.toolCalls).toBe(2);
  });

  // ⚠ The card is already on screen from the first call; pushing it again
  // renders a duplicate.
  it("★ a repeat adds no second artifact", async () => {
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: memoRegistry(
        true,
        vi.fn(async () => ({ items: [] })),
      ),
      session: twiceThenAnswer([{ q: "chair" }, { q: "chair" }]),
    });

    expect(result.artifacts).toHaveLength(1);
  });

  // ★★ EVERY EMITTED SEQUENCE INSERTS A `mink_tool_calls` ROW UNDER A UNIQUE
  // (run, sequence), so a re-used number is not a cosmetic numbering slip — it
  // is a rejected insert that kills the run. When the memo stopped counting
  // repeats against `toolCalls`, that same variable was still the base for the
  // sequence, so a turn holding a hit advanced numbering by less than it
  // emitted and the NEXT turn collided. Observed in production at sequence 5,
  // reported to the merchant as "Mink AI couldn't complete that request."
  it("★★ numbers every call it emits, so a memo hit cannot re-use a sequence", async () => {
    const onEvent = vi.fn();
    const session: MinkModelSession = {
      sendUserMessage: vi.fn(async () =>
        turn({
          functionCalls: [
            { id: "c1", name: "search_products", args: { q: "a" } },
          ],
        }),
      ),
      sendToolResponses: vi
        .fn()
        // Two calls, one of them a repeat of the first turn's read.
        .mockResolvedValueOnce(
          turn({
            functionCalls: [
              { id: "c2", name: "search_products", args: { q: "a" } },
              { id: "c3", name: "search_products", args: { q: "b" } },
            ],
          }),
        )
        .mockResolvedValueOnce(
          turn({
            functionCalls: [
              { id: "c4", name: "search_products", args: { q: "c" } },
            ],
          }),
        )
        .mockResolvedValueOnce(turn({ text: "Done." })),
    };

    const result = await runMinkAgent({
      actor: ACTOR,
      message: "go",
      config: config(),
      registry: memoRegistry(
        true,
        vi.fn(async () => ({ items: [] })),
      ),
      session,
      onEvent,
    });

    const sequences = onEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "tool_call")
      .map((event) => event.sequence);
    expect(sequences).toEqual([1, 2, 3, 4]);
    expect(new Set(sequences).size).toBe(sequences.length);
    // And the budget still ignores the repeat — the two counters are separate,
    // not merely renamed.
    expect(result.toolCalls).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// ★★ WHAT A RUN PRODUCED, NOT WHAT IT READ.
//
// Reported on a live "create the banner on the homepage carousel for this buy
// 1 get 1 offer": the answer carried the page's whole section list, the media
// library, two individual section cards AND the proposal. Every read tool emits
// a card, so an action run stacks its own research in front of the one thing
// the merchant asked for.
// ---------------------------------------------------------------------------
describe("artifacts a run returns", () => {
  function artifactRegistry(artifact: (result: unknown) => unknown) {
    return new MinkToolRegistry([
      {
        declaration: {
          name: "get_storefront_page_context",
          description: "Read a page.",
          parametersJsonSchema: { type: "object", properties: {} },
        },
        permission: { section: "builder", action: "view" },
        timeoutMs: 5_000,
        artifact: artifact as never,
        execute: vi.fn(async () => ({ ok: true })),
      },
      {
        declaration: {
          name: "propose_storefront_layout",
          description: "Propose a layout.",
          parametersJsonSchema: { type: "object", properties: {} },
        },
        permission: { section: "builder", action: "manage" },
        timeoutMs: 5_000,
        artifact: () =>
          ({ type: "storefront_layout_proposal", title: "Home" }) as never,
        execute: vi.fn(async () => ({ ok: true })),
      },
    ]);
  }

  const session = (names: string[]): MinkModelSession => ({
    sendUserMessage: vi.fn(async () =>
      turn({
        functionCalls: names.map((name, i) => ({
          id: `c${i}`,
          name,
          args: {},
        })),
      }),
    ),
    sendToolResponses: vi.fn(async () => turn({ text: "Done." })),
  });

  it("★★ drops the reads that fed a proposal", async () => {
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "create the banner",
      config: config(),
      registry: artifactRegistry(
        () => ({ type: "records", title: "Page" }) as never,
      ),
      session: session([
        "get_storefront_page_context",
        "propose_storefront_layout",
      ]),
    });

    expect(result.artifacts.map((a) => a.type)).toEqual([
      "storefront_layout_proposal",
    ]);
  });

  it("★★ a read-heavy run cannot crowd the proposal out of its own answer", async () => {
    const reads = Array.from(
      { length: 8 },
      () => "get_storefront_page_context",
    );
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "create the banner",
      config: config({ maxParallelReadTools: 12 }),
      registry: artifactRegistry(
        () => ({ type: "records", title: "Page" }) as never,
      ),
      // Eight reads would have filled the old flat cap of six before the
      // proposal was ever made.
      session: session([...reads, "propose_storefront_layout"]),
    });

    expect(result.artifacts.map((a) => a.type)).toEqual([
      "storefront_layout_proposal",
    ]);
  });

  it("★ but a read IS the answer when nothing was produced", async () => {
    const result = await runMinkAgent({
      actor: ACTOR,
      message: "what is on my home page",
      config: config(),
      registry: artifactRegistry(
        () => ({ type: "records", title: "Page" }) as never,
      ),
      session: session(["get_storefront_page_context"]),
    });

    expect(result.artifacts.map((a) => a.type)).toEqual(["records"]);
  });
});
