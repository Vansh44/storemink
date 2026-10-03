import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { themeStudioProjects, themeStudioRuns } from "@/drizzle/schema";
import { ZERO_USAGE } from "./provider";

const { service, pipeline, event, variety, logs } = vi.hoisted(() => {
  class VarietyLeaseLostError extends Error {}
  return {
    service: vi.fn(),
    pipeline: vi.fn(),
    event: vi.fn(),
    variety: { load: vi.fn(), VarietyLeaseLostError },
    logs: { error: vi.fn(), warn: vi.fn() },
  };
});
vi.mock("@/lib/db/client", () => ({ withService: service }));
vi.mock("./repository", () => ({
  recordThemeStudioEvent: event,
  digestThemeStudioJson: vi.fn(),
}));
vi.mock("./pipeline", () => ({ runThemeGeneration: pipeline }));
vi.mock("./gemini-vertex", () => ({
  getVertexConfig: () => ({}),
  createVertexModelClient: () => ({
    provider: "vertex-gemini",
    generate: vi.fn(),
  }),
}));
vi.mock("./config", () => ({
  getThemeStudioConfig: () => ({
    generationEnabled: true,
    disabledModels: new Set(),
  }),
}));
vi.mock("./visual-qa", () => ({ runThemeStudioVisualQaWorker: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: logs.error,
  logInfo: vi.fn(),
  logWarn: logs.warn,
}));
vi.mock("./variety-context", () => ({
  loadVarietyContext: variety.load,
  VarietyLeaseLostError: variety.VarietyLeaseLostError,
}));
import { runThemeStudioWorker } from "./worker";

function fixture({
  deferrals = 0,
  cancelled = false,
  lostLease = false,
  promptVersion = "version",
} = {}) {
  const run = {
    id: "run",
    projectId: "project",
    messageId: "message",
    kind: "generate",
    provider: "vertex-gemini",
    modelKey: "gemini-3.8-flash",
    providerModel: "gemini-3.8-flash",
    promptVersion,
    attemptCount: 3,
    maxAttempts: 3,
    automatic: false,
    rateLimitDeferrals: deferrals,
    cancelRequestedAt: cancelled ? "now" : null,
    usage: {
      totals: { ...ZERO_USAGE, inputTokens: 100 },
      estimatedCostMicroUsd: 50,
    },
  };
  const project = {
    name: "Crave",
    themeId: "crave",
    status: "generating",
    baseThemeId: null,
    modelKey: run.modelKey,
    industries: ["food"],
    catalogSizes: ["small"],
    requiredFeatures: [],
  };
  const reads: unknown[][] = [
    [project],
    [{ createdAt: "now", referenceAssetIds: [] }],
    [{ kind: "brief", body: "brief" }],
    [{ latest: 14 }],
    lostLease ? [] : [run],
    ...(!lostLease ? [[project]] : []),
  ];
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const executes = [[], [run]];
  const queries: string[] = [];
  const db = {
    execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      queries.push(new PgDialect().sqlToQuery(query).sql);
      return { rows: executes.shift() ?? [] };
    },
    select: () => {
      const result = reads.shift();
      if (!result) throw new Error("Unexpected database read");
      const query = {
        from: () => query,
        where: () => query,
        for: () => query,
        limit: () => query,
        orderBy: () => query,
        then: (resolve: (result: unknown) => unknown) =>
          Promise.resolve(result).then(resolve),
      };
      return query;
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return { where: async () => [] };
      },
    }),
  };
  service.mockImplementation(async (work) => work(db));
  return { writes, queries };
}

beforeEach(() => {
  pipeline.mockResolvedValue({
    kind: "failed",
    errorCode: "rate_limited",
    detail: { stage: "draft" },
    telemetry: {
      calls: [],
      totals: ZERO_USAGE,
      estimatedCostMicroUsd: 0,
      repairs: { intent: 0, draft: 0 },
    },
  });
});
const work = () =>
  runThemeStudioWorker({ providers: ["vertex-gemini"], skipVisualQa: true });

describe("rate-limited worker settlement", () => {
  it("queues a delayed recovery even at the crash-attempt limit, preserving the project/version", async () => {
    const { writes, queries } = fixture();
    const before = Date.now();
    expect(await work()).toMatchObject({ claimed: 1, requeued: 1, failed: 0 });
    const update = writes.find(
      (write) => write.table === themeStudioRuns,
    )!.values;
    expect(update).toMatchObject({
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      rateLimitDeferrals: 1,
    });
    expect(Date.parse(update.retryNotBefore as string)).toBeGreaterThanOrEqual(
      before + 225_000,
    );
    expect(Date.parse(update.retryNotBefore as string)).toBeLessThanOrEqual(
      Date.now() + 300_000,
    );
    expect(update.finishedAt).toBeUndefined();
    expect(writes.some((write) => write.table === themeStudioProjects)).toBe(
      false,
    );
    expect(event).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: "run_queued",
        detail: expect.objectContaining({
          reason: "rate_limited",
          recovery: 1,
        }),
      }),
    );
    // Claims skip cooldown rows and don't consume the crash budget on a due recovery.
    expect(queries[1]).toContain("retry_not_before <= now()");
    expect(queries[1]).toContain(
      "CASE WHEN r.retry_not_before IS NULL THEN 1 ELSE 0 END",
    );
    expect(queries).toHaveLength(2); // No immediate retry loop.
  });

  it("ends with a clear failure after four delayed recoveries", async () => {
    const { writes } = fixture({ deferrals: 4 });
    expect(await work()).toMatchObject({ failed: 1, requeued: 0 });
    expect(
      writes.find((write) => write.table === themeStudioRuns)!.values,
    ).toMatchObject({ status: "failed", errorCode: "rate_limited" });
  });

  it("honors cancellation before deciding to recover", async () => {
    const { writes } = fixture({ cancelled: true });
    expect(await work()).toMatchObject({ cancelled: 1, requeued: 0 });
    expect(
      writes.find((write) => write.table === themeStudioRuns)!.values,
    ).toMatchObject({ status: "cancelled" });
  });

  it("cannot recover or finish after losing its lease", async () => {
    const { writes } = fixture({ lostLease: true });
    expect(await work()).toMatchObject({ failed: 0, requeued: 0 });
    expect(writes).toHaveLength(0);
    expect(event).not.toHaveBeenCalled();
  });

  it("treats losing the lease while freezing variety context as expected, not an error", async () => {
    variety.load.mockRejectedValue(new variety.VarietyLeaseLostError());
    const { writes } = fixture({
      lostLease: true,
      promptVersion: "theme-studio-v21",
    });
    expect(await work()).toMatchObject({ failed: 0, requeued: 0 });
    expect(pipeline).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(logs.warn).toHaveBeenCalledWith(
      "theme studio: run lease lost before start",
      { runId: "run" },
    );
    expect(logs.error).not.toHaveBeenCalled();
  });

  it("does not turn authentication failures into capacity retries", async () => {
    const { writes } = fixture();
    pipeline.mockResolvedValue({
      kind: "failed",
      errorCode: "provider_auth",
      detail: {},
      telemetry: {},
    });
    expect(await work()).toMatchObject({ failed: 1, requeued: 0 });
    expect(
      writes.find((write) => write.table === themeStudioRuns)!.values,
    ).toMatchObject({ status: "failed", errorCode: "provider_auth" });
  });

  it("keeps already-recorded spend when recovery stops before reconstructing telemetry", async () => {
    const { writes } = fixture();
    pipeline.mockRejectedValue(new Error("checkpoint read failed"));
    expect(await work()).toMatchObject({ failed: 1 });
    expect(
      writes.find((write) => write.table === themeStudioRuns)!.values.usage,
    ).toMatchObject({
      totals: { inputTokens: 100 },
      estimatedCostMicroUsd: 50,
    });
  });
});
