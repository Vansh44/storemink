import { afterEach, describe, expect, it, vi } from "vitest";

const withService = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db/client", () => ({ withService }));
vi.mock("./contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./contracts")>()),
  validateThemePackageV2: vi.fn(() => ({ ok: true, value: {} })),
}));
vi.mock("./capture-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./capture-core")>()),
  captureBlockers: vi.fn(() => []),
}));

import { queueThemeStudioCapture, finishThemeStudioCapture } from "./capture";
import { captureBlockers } from "./capture-core";
import { themeStudioCaptures, themeStudioProjects } from "@/drizzle/schema";

const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "op@test.dev",
};
const input = {
  projectId: "22222222-2222-4222-8222-222222222222",
  versionId: "33333333-3333-4333-8333-333333333333",
  expectedRevision: 1,
  expectedPackageDigest: "d".repeat(64),
  idempotencyKey: "capture-test-key-01",
};

function queueDb({
  qaStatus = "failed",
  revision = 1,
  currentVersionId = input.versionId,
  prior = null,
}: {
  qaStatus?: string;
  revision?: number;
  currentVersionId?: string;
  prior?: { id: string; projectId: string } | null;
} = {}) {
  const results = [
    [{ id: input.projectId, status: "ready", revision, currentVersionId }],
    prior ? [prior] : [],
    [{ packageJson: {}, packageDigest: input.expectedPackageDigest, qaStatus }],
  ];
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const db = {
    select: () => {
      const query = {
        from: () => query,
        where: () => query,
        for: () => query,
        limit: async () => results.shift(),
      };
      return query;
    },
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return { returning: async () => [{ id: "capture-id" }] };
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return { where: async () => [] };
      },
    }),
  };
  withService.mockImplementation(async (work) => work(db));
  return writes;
}

describe("Theme Studio catalog capture deployment gate", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "earlier-build"])(
    "retries automatic results from an absent or earlier build (%s) before saving images",
    async (buildId) => {
      vi.stubEnv("THEME_STUDIO_BUILD_ID", "current-build");
      const held = {
        id: input.versionId,
        automatic: true,
        attemptCount: 1,
        maxAttempts: 5,
      };
      const writes: Record<string, unknown>[] = [];
      const db = {
        select: () => {
          const query = {
            from: () => query,
            where: () => query,
            limit: () => query,
            for: () => query,
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve([held]).then(resolve),
          };
          return query;
        },
        update: () => ({
          set: (values: Record<string, unknown>) => {
            writes.push(values);
            return { where: async () => [] };
          },
        }),
        insert: vi.fn(),
      };
      withService.mockImplementation(async (work) => work(db));
      expect(
        await finishThemeStudioCapture({
          captureId: input.versionId,
          leaseToken: actor.id,
          images: [],
          qa: { buildId, evidence: {}, screenshots: [] },
        }),
      ).toEqual({ status: "requeued" });
      expect(writes).toEqual([
        { status: "queued", leaseOwner: null, leaseExpiresAt: null },
      ]);
      expect(db.insert).not.toHaveBeenCalled();
    },
  );

  it("restarts failed automatic QA with browser evidence and a bounded retry budget", async () => {
    vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "true");
    vi.stubEnv("THEME_STUDIO_AUTO_QA_ENABLED", "true");
    const writes = queueDb();
    expect(await queueThemeStudioCapture(actor, input)).toEqual({
      captureId: "capture-id",
      duplicate: false,
    });
    expect(
      writes.find((write) => write.table === themeStudioCaptures)?.values,
    ).toMatchObject({
      versionId: input.versionId,
      packageDigest: input.expectedPackageDigest,
      automatic: true,
      previousStatus: "generating",
      qaIteration: 0,
      maxAttempts: 5,
    });
    expect(
      writes.find((write) => write.table === themeStudioProjects)?.values,
    ).toEqual({ status: "generating", revision: 2 });
  });

  it.each([
    ["not_required", "true"],
    ["passed", "true"],
    ["failed", "false"],
  ])(
    "keeps manual capture for QA status %s with auto QA %s",
    async (qaStatus, enabled) => {
      vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "true");
      vi.stubEnv("THEME_STUDIO_AUTO_QA_ENABLED", enabled);
      const writes = queueDb({ qaStatus });
      await queueThemeStudioCapture(actor, input);
      const capture = writes.find(
        (write) => write.table === themeStudioCaptures,
      )?.values;
      expect(capture).toHaveProperty("previousStatus", "ready");
      expect(capture).not.toHaveProperty("automatic");
      expect(capture).not.toHaveProperty("maxAttempts");
    },
  );

  it("replays the same request without scheduling a second capture", async () => {
    vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "true");
    const writes = queueDb({
      revision: 2,
      prior: { id: "prior", projectId: input.projectId },
    });
    expect(await queueThemeStudioCapture(actor, input)).toEqual({
      captureId: "prior",
      duplicate: true,
    });
    expect(writes).toEqual([]);
  });

  it.each([{ revision: 2 }, { currentVersionId: "another-version" }])(
    "refuses a recovery based on stale project state %j",
    async (state) => {
      vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "true");
      const writes = queueDb(state);
      await expect(queueThemeStudioCapture(actor, input)).rejects.toThrow();
      expect(writes).toEqual([]);
    },
  );

  it("does not restart QA while artwork remains unfinished", async () => {
    vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "true");
    vi.stubEnv("THEME_STUDIO_AUTO_QA_ENABLED", "true");
    const writes = queueDb();
    vi.mocked(captureBlockers).mockReturnValueOnce([
      "Missing category imagery",
    ]);
    await expect(queueThemeStudioCapture(actor, input)).rejects.toThrow(
      "Missing category imagery",
    );
    expect(writes).toEqual([]);
  });

  it("refuses a direct queue call before touching the database", async () => {
    vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "false");

    await expect(
      queueThemeStudioCapture(
        { id: "11111111-1111-4111-8111-111111111111", email: "op@test.dev" },
        {
          projectId: "22222222-2222-4222-8222-222222222222",
          versionId: "33333333-3333-4333-8333-333333333333",
          expectedRevision: 1,
          expectedPackageDigest: "d".repeat(64),
          idempotencyKey: "capture-test-key-01",
        },
      ),
    ).rejects.toThrow(/browser worker is deployed/i);
    expect(withService).not.toHaveBeenCalled();
  });
});
