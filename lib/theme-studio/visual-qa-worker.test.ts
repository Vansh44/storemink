import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  themeStudioProjects,
  themeStudioVersions,
  themeStudioRuns,
  themeStudioMessages,
  themeStudioCaptures,
} from "@/drizzle/schema";
import { gate, GATE_LABELS, type GateId } from "./acceptance-gates";
import { qaProgress } from "./qa-diagnosis";
import { repairTargets } from "./targeted-repair";
import { runThemeGeneration } from "./pipeline";
import type { ThemeIntent } from "./contracts";
import { operatorImagePackage } from "./_test-helpers";

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
  acceptanceStatus = undefined as string | undefined,
  recaptures = 0,
  history = [] as unknown[],
  phase = "final",
  failId = "browser.accessibility" as GateId,
  pkg = operatorImagePackage(),
  intent = undefined as ThemeIntent | undefined,
} = {}) {
  const gates = passing()
    .filter((g) => phase !== "layout" || g.id.startsWith("browser."))
    .map((g) =>
      fail && g.id === failId
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
    browserReport: {
      ...(phase === "final" ? { acceptanceRunId: "acceptance" } : {}),
      phase,
      buildId,
      gates,
    },
  };
  const reads = [
    [],
    [qa],
    [{ name: "Crave", modelKey: "gemini-3.8-flash", status: claimStatus }],
    [{ packageJson: pkg }],
    [],
    lostLease ? [] : [qa],
    [{ status: settleStatus }],
    ...(phase === "final"
      ? [
          [
            {
              id: "acceptance",
              packageDigest: "digest",
              buildId,
              status: acceptanceStatus ?? (fail ? "failed" : "passed"),
              serverReport: { gates },
              browserReport: { gates: [] },
            },
          ],
        ]
      : !fail && !oldBuild
        ? [[{ intentJson: intent, packageDigest: "digest" }]]
        : []),
    // Prior build recaptures of this version (read only on a build change).
    ...(oldBuild ? [[{ n: recaptures }]] : []),
    ...(!oldBuild && iteration > 0 && iteration < 3 ? [history] : []),
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

  it("stops after three repairs without marking failed work passed", async () => {
    const writes = fixture({ fail: true, iteration: 3 });
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
  it("still repairs at the second iteration, queueing the third and final attempt", async () => {
    const writes = fixture({ fail: true, iteration: 2 });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ revisionQueued: 1, failed: 0 });
    expect(
      writes.find((w) => w.table === themeStudioRuns)?.values,
    ).toMatchObject({ qaIteration: 3 });
  });
  it("recaptures after a deployment without regenerating the theme", async () => {
    const writes = fixture({ oldBuild: true });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ recaptureQueued: 1, revisionQueued: 0, passed: 0 });
    expect(generate).not.toHaveBeenCalled();
    expect(
      writes.find((w) => w.table === themeStudioCaptures)?.values,
    ).toMatchObject({ versionId: "version", automatic: true, qaIteration: 0 });
    expect(writes.some((w) => w.table === themeStudioRuns)).toBe(false);
  });
  it("stops recapturing a version whose evidence keeps going stale", async () => {
    const writes = fixture({ oldBuild: true, recaptures: 2 });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1, recaptureQueued: 0 });
    expect(writes.some((w) => w.table === themeStudioCaptures)).toBe(false);
    expect(writes.find((w) => w.values.errorCode)?.values.errorCode).toBe(
      "acceptance_build_unstable",
    );
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
  it("stops, rather than paying for a revision, when passing gates disagree with a non-passed stored outcome", async () => {
    const writes = fixture({ acceptanceStatus: "failed" });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1, passed: 0, revisionQueued: 0 });
    expect(writes.some((w) => w.table === themeStudioRuns)).toBe(false);
    expect(writes.some((w) => w.values.status === "candidate")).toBe(false);
    expect(writes.find((w) => w.values.errorCode)?.values.errorCode).toBe(
      "acceptance_outcome_mismatch",
    );
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

async function draft() {
  const actual =
    await vi.importActual<typeof import("./fake-provider")>("./fake-provider");
  const outcome = await runThemeGeneration(
    actual.createFakeModelClient({
      name: "Clay",
      brief: "A ceramics shop",
      industries: ["home"],
      catalogSizes: ["small"],
      requiredFeatures: [],
      referenceCount: 0,
    }),
    {
      facts: {
        themeId: "clay",
        name: "Clay",
        industries: ["home"],
        catalogSizes: ["small"],
        requiredFeatures: [],
        baseThemeName: null,
      },
      compile: {
        themeId: "clay",
        name: "Clay",
        industries: ["home"],
        catalogSizes: ["small"],
        requiredFeatures: [],
        baseEngine: null,
        versionNumber: 1,
        modelKey: "gemini-3.8-flash",
        modelLabel: "Gemini",
        referenceDigests: [],
      },
      providerModel: "fake",
      promptVersion: "test",
      messages: [{ kind: "brief", body: "A ceramics shop" }],
      references: [],
    },
    new AbortController().signal,
  );
  if (outcome.kind !== "version") throw new Error(outcome.kind);
  return { pkg: outcome.package, intent: outcome.intent };
}

describe("layout preflight and failure routing", () => {
  it("queues artwork after layout passes without vision, publication evidence or another version", async () => {
    const writes = fixture({ phase: "layout", ...(await draft()) });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ layoutPassed: 1, passed: 0, failed: 0 });
    expect(generate).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(
      writes.find((w) => w.table === themeStudioRuns)?.values,
    ).toMatchObject({
      kind: "images",
      baseVersionId: "version",
      qaIteration: 0,
    });
    expect(
      writes.some(
        (w) =>
          w.table === themeStudioVersions || w.table === themeStudioProjects,
      ),
    ).toBe(false);
  });
  it("recaptures stale preflight builds in the same phase", async () => {
    const writes = fixture({ phase: "layout", oldBuild: true });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ recaptureQueued: 1 });
    expect(
      writes.find((w) => w.table === themeStudioCaptures)?.values.phase,
    ).toBe("layout");
    expect(generate).not.toHaveBeenCalled();
  });
  it("stops a tap-target defect before purchasing artwork or a settings repair", async () => {
    const writes = fixture({
      phase: "layout",
      fail: true,
      failId: "browser.tap_targets",
    });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1, revisionQueued: 0 });
    expect(writes.find((w) => w.values.errorCode)?.values.errorCode).toBe(
      "renderer_fix_required",
    );
    expect(writes.some((w) => w.table === themeStudioRuns)).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });
  it("routes a preflight contrast failure to the focused settings repair", async () => {
    const writes = fixture({ phase: "layout", fail: true });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ revisionQueued: 1 });
    expect(
      writes.find((w) => w.table === themeStudioRuns)?.values,
    ).toMatchObject({ kind: "revise", automatic: true, qaIteration: 1 });
    expect(generate).not.toHaveBeenCalled();
  });
  it("stops identical failed settings evidence at the first non-improving revision", async () => {
    const bad = passing().map((g) =>
      g.id === "browser.accessibility"
        ? gate(g.id, [
            {
              code: "contrast",
              where: "phone360 · home",
              message: "Improve price contrast",
            },
          ])
        : g,
    );
    const writes = fixture({
      fail: true,
      iteration: 1,
      history: [{ visionReport: { progress: qaProgress(bad) } }],
    });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ failed: 1, revisionQueued: 0 });
    expect(writes.find((w) => w.values.errorCode)?.values.errorCode).toBe(
      "qa_no_progress",
    );
    expect(writes.some((w) => w.table === themeStudioRuns)).toBe(false);
  });
  it("redraws only the named generated slot and binds the QA correction to that image run", async () => {
    const pkg = operatorImagePackage();
    const slot = pkg.assets.find(
      (a) =>
        a.path !== pkg.definition.catalog.previewImage &&
        !pkg.definition.catalog.screenshots.some((s) => s.src === a.path),
    )!;
    slot.source = "generated";
    generate.mockResolvedValue({
      kind: "ok",
      usage: {},
      value: {
        ...report,
        verdict: "revise",
        repairs: [
          {
            kind: "image",
            target: slot.id,
            reason: "Match the existing SET backdrop",
          },
        ],
      },
    });
    const writes = fixture({ pkg });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ revisionQueued: 1 });
    expect(
      writes.find((w) => w.table === themeStudioRuns)?.values,
    ).toMatchObject({
      kind: "images",
      imageSlotIds: [slot.id],
      qaIteration: 1,
    });
    expect(
      writes.find((w) => w.table === themeStudioMessages)?.values.body,
    ).toContain("Match the existing SET backdrop");
    expect(
      writes.find((w) => w.values.status === "revision_queued")?.values
        .revisionRunId,
    ).toBe("inserted");
  });
  it("repairs settings first for a mixed settings/artwork verdict without sending redraw instructions to the text model", async () => {
    const pkg = operatorImagePackage();
    const slot = pkg.assets.find(
      (a) =>
        a.path !== pkg.definition.catalog.previewImage &&
        !pkg.definition.catalog.screenshots.some((s) => s.src === a.path),
    )!;
    slot.source = "generated";
    const setting = repairTargets(pkg)[0].path;
    generate.mockResolvedValue({
      kind: "ok",
      usage: {},
      value: {
        ...report,
        verdict: "revise",
        revisionBrief: "Change settings and redraw all imagery",
        repairs: [
          {
            kind: "settings",
            target: setting,
            reason: "Improve heading hierarchy",
          },
          {
            kind: "image",
            target: slot.id,
            reason: "Fix the warped mug handle",
          },
        ],
      },
    });
    const writes = fixture({ pkg });
    expect(
      await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
    ).toMatchObject({ revisionQueued: 1, failed: 0 });
    expect(
      writes.find((w) => w.table === themeStudioRuns)?.values,
    ).toMatchObject({ kind: "revise", qaIteration: 1 });
    const brief = writes.find((w) => w.table === themeStudioMessages)?.values
      .body;
    expect(brief).toContain(setting);
    expect(brief).toContain("Improve heading hierarchy");
    expect(brief).not.toContain("Fix the warped mug handle");
    expect(brief).not.toContain("redraw all imagery");
  });
  it("never redraws an owner upload or accepts an invented setting target", async () => {
    const pkg = operatorImagePackage();
    for (const repair of [
      { kind: "image", target: pkg.assets[0].id, reason: "Redraw" },
      { kind: "settings", target: "/css/font", reason: "Fix CSS" },
    ]) {
      generate.mockResolvedValue({
        kind: "ok",
        usage: {},
        value: { ...report, verdict: "revise", repairs: [repair] },
      });
      const writes = fixture({ pkg });
      expect(
        await runThemeStudioVisualQaWorker({ providers: ["fake"] }),
      ).toMatchObject({ failed: 1 });
      expect(writes.find((w) => w.values.errorCode)?.values.errorCode).toBe(
        "repair_not_supported",
      );
      expect(writes.some((w) => w.table === themeStudioRuns)).toBe(false);
    }
  });
});
