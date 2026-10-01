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
const openPreview = vi.hoisted(() => vi.fn());
vi.mock("./preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./preview")>()),
  openThemeStudioPreview: openPreview,
}));

import {
  queueThemeStudioCapture,
  finishThemeStudioCapture,
  claimThemeStudioCapture,
} from "./capture";
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

/** One last-attempt capture whose every read answers `held`. */
function finishDb(held: Record<string, unknown>) {
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
    insert: () => ({ values: async () => [] }),
  };
  withService.mockImplementation(async (work) => work(db));
  return writes;
}

describe("why an automatic capture failed", () => {
  afterEach(() => vi.unstubAllEnvs());
  const lastAttempt = {
    id: input.versionId,
    projectId: input.projectId,
    versionId: input.versionId,
    automatic: true,
    attemptCount: 5,
    maxAttempts: 5,
  };

  it.each([
    [undefined, "capture_job_outdated"],
    ["earlier-build", "capture_build_changed"],
  ])(
    "tells an outdated capture job (build %s) apart from a deploy: %s",
    async (buildId, code) => {
      vi.stubEnv("THEME_STUDIO_BUILD_ID", "current-build");
      const writes = finishDb(lastAttempt);
      expect(
        await finishThemeStudioCapture({
          captureId: input.versionId,
          leaseToken: actor.id,
          images: [],
          qa: { buildId, evidence: {}, screenshots: [] },
        }),
      ).toEqual({ status: "failed", errorCode: code });
      expect(writes[0]).toMatchObject({ status: "failed", errorCode: code });
    },
  );

  it("reports a missing QA payload as invalid evidence, not a build change", async () => {
    vi.stubEnv("THEME_STUDIO_BUILD_ID", "current-build");
    finishDb({ ...lastAttempt, origin: "run", editDetail: {} });
    expect(
      await finishThemeStudioCapture({
        captureId: input.versionId,
        leaseToken: actor.id,
        images: [],
      }),
    ).toEqual({ status: "failed", errorCode: "qa_report_invalid" });
  });
});

describe("claiming a capture", () => {
  afterEach(() => vi.unstubAllEnvs());

  function claimDb({
    automatic = true,
    role = "superadmin",
    version = {},
  }: {
    automatic?: boolean;
    role?: string;
    version?: Record<string, unknown>;
  }) {
    const capture = {
      id: "44444444-4444-4444-8444-444444444444",
      projectId: input.projectId,
      versionId: input.versionId,
      packageDigest: input.expectedPackageDigest,
      automatic,
      attemptCount: 0,
      maxAttempts: 5,
      createdBy: actor.id,
    };
    const reads = [
      [],
      [capture],
      [
        {
          packageJson: {},
          packageDigest: input.expectedPackageDigest,
          origin: "run",
          visibility: "internal",
          qaStatus: "pending",
          editDetail: {},
          ...version,
        },
      ],
      [{ ...actor, role }],
    ];
    const writes: Record<string, unknown>[] = [];
    const db = {
      select: () => {
        const result = reads.shift();
        const query = {
          from: () => query,
          where: () => query,
          orderBy: () => query,
          limit: () => query,
          for: () => query,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(result).then(resolve),
        };
        return query;
      },
      update: () => ({
        set: (values: Record<string, unknown>) => {
          writes.push(values);
          return { where: async () => [] };
        },
      }),
      insert: () => ({ values: async () => [] }),
    };
    withService.mockImplementation(async (work) => work(db));
    return writes;
  }

  it("refuses an automatic capture for a demoted owner before any browser work", async () => {
    const writes = claimDb({ role: "member" });
    expect(await claimThemeStudioCapture()).toBeNull();
    expect(openPreview).not.toHaveBeenCalled();
    expect(writes.at(-1)).toBeDefined();
    expect(
      writes.find((w) => w.errorCode === "operator_removed"),
    ).toBeDefined();
  });

  it("asks for no catalog shots when re-measuring a version a capture already produced", async () => {
    vi.stubEnv("CRON_SECRET", "x".repeat(40));
    openPreview.mockResolvedValueOnce({
      origin: "http://studio-preview-ab.localhost:3000",
      storeId: "55555555-5555-4555-8555-555555555555",
      pages: [{ surface: "home", path: "/", label: "Home" }],
    });
    claimDb({
      version: { origin: "asset_edit", editDetail: { kind: "capture" } },
    });
    const claim = await claimThemeStudioCapture();
    expect(claim?.shots).toEqual([]);
    expect(claim?.qa?.pages).toEqual([{ surface: "home", path: "/" }]);
  });
});
