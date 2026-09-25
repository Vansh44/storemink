import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The gate, not the plumbing. Every export of the actions module is a public
// POST endpoint, so each one must refuse a non-superadmin BEFORE any
// repository call — a forged request from a member or a signed-out browser
// must not read or mutate a Studio project.
// ---------------------------------------------------------------------------

const repo = vi.hoisted(() => ({
  createThemeStudioProject: vi.fn(async () => ({ id: "p1" })),
  queueThemeStudioGeneration: vi.fn(async () => ({
    runId: "r1",
    duplicate: false,
  })),
  cancelThemeStudioRun: vi.fn(async () => ({ status: "cancelled" })),
  retryThemeStudioRun: vi.fn(async () => ({ runId: "r2", duplicate: false })),
  submitThemeStudioDetails: vi.fn(async () => ({
    runId: "r3",
    duplicate: false,
  })),
  removeThemeStudioReference: vi.fn(async () => undefined),
  archiveThemeStudioProject: vi.fn(async () => undefined),
  // Phase 6 (lib/theme-studio/publication), mocked below.
  submitThemeStudioReview: vi.fn(async () => ({ reviewId: "rv1" })),
  approveThemeStudioCandidate: vi.fn(async () => undefined),
  publishThemeStudioProject: vi.fn(async () => ({
    ok: true as const,
    publicationId: "pub1",
    themeId: "clay-co",
    releaseVersion: "1.0.0",
    demoSlug: "demo-clay-co",
  })),
  changeThemeStudioCatalog: vi.fn(async () => ({ changed: true })),
}));
const actorState = vi.hoisted(() => ({
  actor: null as null | { id: string; email: string },
}));

vi.mock("@/lib/theme-studio/access", () => ({
  getThemeStudioActor: vi.fn(async () => actorState.actor),
}));
vi.mock("@/lib/theme-studio/repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/theme-studio/repository")>();
  return { ...actual, ...repo };
});
vi.mock("@/lib/theme-studio/publication", () => ({
  submitThemeStudioReview: repo.submitThemeStudioReview,
  approveThemeStudioCandidate: repo.approveThemeStudioCandidate,
  publishThemeStudioProject: repo.publishThemeStudioProject,
  changeThemeStudioCatalog: repo.changeThemeStudioCatalog,
}));
vi.mock("@/lib/theme-studio/worker", () => ({
  runThemeStudioWorker: vi.fn(async () => ({})),
}));
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  revalidatePath: vi.fn(),
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

import * as actions from "./theme-studio-actions";

const projectId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";

const calls: [
  string,
  () => Promise<{ ok: boolean; error?: string }>,
  keyof typeof repo,
][] = [
  [
    "create",
    () =>
      actions.createThemeStudioProjectAction({
        name: "Clay",
        themeId: "clay-co",
        brief: "calm",
        industries: ["home"],
        catalogSizes: ["small"],
        requiredFeatures: [],
        baseThemeId: null,
        modelKey: "gemini-3.8-flash",
      }),
    "createThemeStudioProject",
  ],
  [
    "queue",
    () =>
      actions.queueThemeStudioGenerationAction({
        projectId,
        expectedRevision: 0,
        idempotencyKey: "k".repeat(20),
      }),
    "queueThemeStudioGeneration",
  ],
  [
    "cancel",
    () => actions.cancelThemeStudioRunAction({ projectId, runId }),
    "cancelThemeStudioRun",
  ],
  [
    "retry",
    () =>
      actions.retryThemeStudioRunAction({
        projectId,
        runId,
        idempotencyKey: "k".repeat(20),
      }),
    "retryThemeStudioRun",
  ],
  [
    "submit details",
    () =>
      actions.submitThemeStudioDetailsAction({
        projectId,
        expectedRevision: 0,
        body: "Photography comes from the operator.",
        idempotencyKey: "k".repeat(20),
      }),
    "submitThemeStudioDetails",
  ],
  [
    "remove reference",
    () =>
      actions.removeThemeStudioReferenceAction({ projectId, assetId: runId }),
    "removeThemeStudioReference",
  ],
  [
    "archive",
    () =>
      actions.archiveThemeStudioProjectAction({
        projectId,
        expectedRevision: 0,
      }),
    "archiveThemeStudioProject",
  ],
  [
    "submit review",
    () =>
      actions.submitThemeStudioReviewAction({
        projectId,
        versionId: runId,
        expectedPackageDigest: "d".repeat(64),
        scorecard: {},
      }),
    "submitThemeStudioReview",
  ],
  [
    "approve",
    () =>
      actions.approveThemeStudioCandidateAction({
        projectId,
        expectedRevision: 0,
      }),
    "approveThemeStudioCandidate",
  ],
  [
    "publish",
    () =>
      actions.publishThemeStudioProjectAction({
        projectId,
        expectedRevision: 0,
        confirmThemeId: "clay-co",
      }),
    "publishThemeStudioProject",
  ],
  [
    "change catalog",
    () =>
      actions.changeThemeStudioCatalogAction({
        projectId,
        change: { action: "hide", reason: "Broken cart" },
      }),
    "changeThemeStudioCatalog",
  ],
];

describe("Theme Studio actions", () => {
  beforeEach(() => {
    actorState.actor = null;
  });

  it.each(calls)(
    "%s refuses a non-superadmin before touching data",
    async (_name, call, fn) => {
      const result = await call();
      expect(result).toEqual({
        ok: false,
        error: expect.stringMatching(/superadmin/),
      });
      expect(repo[fn]).not.toHaveBeenCalled();
    },
  );

  it.each(calls)(
    "%s passes the session actor, never a client-supplied one",
    async (_name, call, fn) => {
      actorState.actor = {
        id: "11111111-1111-4111-8111-111111111111",
        email: "owner@storemink.com",
      };
      const result = await call();
      expect(result.ok).toBe(true);
      const mock = repo[fn] as unknown as { mock: { calls: unknown[][] } };
      expect(mock.mock.calls[0][0]).toEqual(actorState.actor);
    },
  );

  it("returns a repository refusal as a sentence, not a crash", async () => {
    actorState.actor = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "owner@storemink.com",
    };
    const { ThemeStudioError } = await import("@/lib/theme-studio/repository");
    repo.queueThemeStudioGeneration.mockRejectedValueOnce(
      new ThemeStudioError("stale", "This project changed in another tab."),
    );
    await expect(
      actions.queueThemeStudioGenerationAction({
        projectId,
        expectedRevision: 0,
        idempotencyKey: "k".repeat(20),
      }),
    ).resolves.toEqual({
      ok: false,
      error: "This project changed in another tab.",
    });
  });

  it("returns a failed publication's reasons without calling it a crash", async () => {
    actorState.actor = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "owner@storemink.com",
    };
    repo.publishThemeStudioProject.mockResolvedValueOnce({
      ok: false,
      publicationId: "pub2",
      problems: ["Demo: /shop answered 500."],
    } as never);
    await expect(
      actions.publishThemeStudioProjectAction({
        projectId,
        expectedRevision: 0,
        confirmThemeId: "clay-co",
      }),
    ).resolves.toEqual({
      ok: false,
      id: "pub2",
      error: "Demo: /shop answered 500.",
      problems: ["Demo: /shop answered 500."],
    });
  });
});
