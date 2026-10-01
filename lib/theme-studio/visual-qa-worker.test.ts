import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  themeStudioProjects,
  themeStudioVersions,
  themeStudioRuns,
  themeStudioMessages,
  themeStudioCaptures,
} from "@/drizzle/schema";
import { gate, GATE_LABELS, type GateId } from "./acceptance-gates";

const { service, generate, verify } = vi.hoisted(() => ({
  service: vi.fn(),
  generate: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ withService: service }));
vi.mock("./repository", () => ({ recordThemeStudioEvent: vi.fn() }));
vi.mock("./acceptance", () => ({
  currentAcceptanceBuildId: () => "build-new",
  verifyCandidateEvidenceWithDb: verify,
}));
vi.mock("./config", () => ({
  getThemeStudioConfig: () => ({
    provider: "fake",
    autoQaEnabled: true,
    disabledModels: new Set(),
  }),
}));
vi.mock("./fake-provider", () => ({
  createFakeModelClient: () => ({ generate }),
}));
import { runThemeStudioVisualQaWorker } from "./visual-qa";

const passing = () =>
  (Object.keys(GATE_LABELS) as GateId[]).map((id) =>
    gate(id, [], { required: id !== "browser.performance" }),
  );
const report = {
  verdict: "pass",
  scores: {
    artDirection: 5,
    distinctness: 5,
    commerceClarity: 5,
    typography: 5,
    imagery: 5,
    responsiveComposition: 5,
    detailQuality: 5,
    brandAdaptability: 5,
  },
  rejections: [],
  findings: [],
  revisionBrief: null,
};

function fixture({
  fail = false,
  iteration = 0,
  oldBuild = false,
  lostLease = false,
  claimStatus = "generating",
  settleStatus = "generating",
} = {}) {
  const gates = passing().map((g) =>
    fail && g.id === "browser.accessibility"
      ? gate(g.id, [
          {
            code: "contrast",
            where: "phone360 · home",
            message: "Improve price contrast",
          },
        ])
      : g,
  );
  const buildId = oldBuild ? "build-old" : "build-new";
  const qa = {
    id: "qa",
    projectId: "project",
    versionId: "version",
    packageDigest: "digest",
    screenshotAssetIds: [],
    qaIteration: iteration,
    createdBy: "operator",
    attemptCount: 0,
    maxAttempts: 3,
    browserReport: { acceptanceRunId: "acceptance", buildId, gates },
  };
  const reads = [
    [],
    [qa],
    [{ name: "Crave", modelKey: "gemini-3.8-flash", status: claimStatus }],
    [{ packageJson: {} }],
    [],
    lostLease ? [] : [qa],
    [{ status: settleStatus }],
    [
      {
        id: "acceptance",
        packageDigest: "digest",
        buildId,
        status: fail ? "failed" : "passed",
        serverReport: { gates },
        browserReport: { gates: [] },
      },
    ],
  ];
  const writes: { table: unknown; values: Record<string, unknown> }[] = [];
  const db = {
    select: () => {
      const result = reads.shift();
      const query = {
        from: () => query,
        where: () => query,
        for: () => query,
        orderBy: () => query,
        limit: () => query,
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
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        writes.push({ table, values });
        return { returning: async () => [{ id: "inserted" }] };
      },
    }),
  };
  service.mockImplementation(async (work) => work(db));
  return writes;
}

beforeEach(() => {
  vi.clearAllMocks();
  generate.mockResolvedValue({ kind: "ok", value: report, usage: {} });
  verify.mockResolvedValue({ ok: true });
});

describe("automatic acceptance and visual settlement", () => {
  it("delivers a candidate only after both checks and current evidence verification pass", async () => {
    const writes = fixture();
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ passed: 1, failed: 0 });
    expect(generate).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
    expect(
      writes
        .filter((w) => w.table === themeStudioProjects)
        .map((w) => w.values.status),
    ).toEqual(["ready", "candidate"]);
    expect(writes.find((w) => w.table === themeStudioVersions)?.values).toEqual(
      { visibility: "operator", qaStatus: "passed" },
    );
  });
  it("queues targeted repairs without spending a vision call on failed deterministic checks", async () => {
    const writes = fixture({ fail: true });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ revisionQueued: 1, passed: 0 });
    expect(generate).not.toHaveBeenCalled();
    expect(
      writes.find((w) => w.table === themeStudioMessages)?.values.body,
    ).toContain("phone360 · home: Improve price contrast");
    expect(
      writes.find((w) => w.table === themeStudioRuns)?.values,
    ).toMatchObject({
      baseVersionId: "version",
      automatic: true,
      qaIteration: 1,
    });
    expect(writes.some((w) => w.table === themeStudioVersions)).toBe(false);
  });
  it("uses the same bounded repair loop for a failed visual verdict", async () => {
    generate.mockResolvedValue({
      kind: "ok",
      value: {
        ...report,
        verdict: "revise",
        findings: ["Strengthen hierarchy"],
        revisionBrief: "Increase heading size",
      },
      usage: {},
    });
    const writes = fixture();
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ revisionQueued: 1 });
    expect(
      writes.find((w) => w.table === themeStudioMessages)?.values.body,
    ).toContain("Increase heading size");
  });
  it("repairs a low score even if the model says pass without supplying a brief", async () => {
    generate.mockResolvedValue({
      kind: "ok",
      value: { ...report, scores: { ...report.scores, typography: 2 } },
      usage: {},
    });
    const writes = fixture();
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ revisionQueued: 1, passed: 0 });
    const brief = writes.find((w) => w.table === themeStudioMessages)?.values
      .body;
    expect(brief).toContain('"typography":2');
    expect(brief).toContain("Raise every row to at least 4");
  });

  it("stops after two repairs without marking failed work passed", async () => {
    const writes = fixture({ fail: true, iteration: 2 });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1, passed: 0, revisionQueued: 0 });
    expect(
      writes.find((w) => w.table === themeStudioVersions)?.values.qaStatus,
    ).toBe("failed");
    expect(
      writes.some(
        (w) => w.table === themeStudioRuns || w.values.status === "candidate",
      ),
    ).toBe(false);
  });
  it("recaptures after a deployment without regenerating the theme", async () => {
    const writes = fixture({ oldBuild: true });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ revisionQueued: 1, passed: 0 });
    expect(generate).not.toHaveBeenCalled();
    expect(
      writes.find((w) => w.table === themeStudioCaptures)?.values,
    ).toMatchObject({ versionId: "version", automatic: true, qaIteration: 0 });
    expect(writes.some((w) => w.table === themeStudioRuns)).toBe(false);
  });
  it("refuses stale asset evidence and results from a lost lease", async () => {
    verify.mockResolvedValue({ ok: false, reason: "Assets changed" });
    let writes = fixture();
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1, passed: 0 });
    expect(writes.some((w) => w.values.status === "candidate")).toBe(false);
    writes = fixture({ lostLease: true });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ passed: 0, failed: 0 });
    expect(writes).toHaveLength(1); // Claim only; no late settlement.
  });
  it("closes a run whose project stopped generating before paying for vision", async () => {
    const writes = fixture({ claimStatus: "archived" });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ claimed: 0, passed: 0, failed: 0 });
    expect(generate).not.toHaveBeenCalled();
    expect(writes.at(-1)?.values).toMatchObject({
      status: "failed",
      errorCode: "project_state_changed",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(writes.some((w) => w.table === themeStudioVersions)).toBe(false);
    expect(writes.some((w) => w.table === themeStudioProjects)).toBe(false);
  });
  it("releases the lease when the project stops generating during the vision call", async () => {
    const writes = fixture({ settleStatus: "archived" });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1, passed: 0 });
    expect(writes.at(-1)?.values).toMatchObject({
      status: "failed",
      errorCode: "project_state_changed",
      leaseOwner: null,
    });
    // The version stays hidden and the project is left as the operator set it.
    expect(writes.some((w) => w.table === themeStudioVersions)).toBe(false);
    expect(writes.some((w) => w.table === themeStudioProjects)).toBe(false);
  });
});
