// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ThemeStudioProjectDetail } from "@/lib/theme-studio/repository";

const { refresh, router } = vi.hoisted(() => {
  const refresh = vi.fn();
  return { refresh, router: { refresh } };
});
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/actions/theme-studio-actions", () => ({
  archiveThemeStudioProjectAction: vi.fn(),
  cancelThemeStudioRunAction: vi.fn(),
  queueThemeStudioGenerationAction: vi.fn(),
  removeThemeStudioReferenceAction: vi.fn(),
  restoreThemeStudioVersionAction: vi.fn(),
  retryThemeStudioRunAction: vi.fn(),
  reviseThemeStudioVersionAction: vi.fn(),
  submitThemeStudioDetailsAction: vi.fn(),
}));
import { ProjectWorkspace } from "./workspace";

const project: ThemeStudioProjectDetail = {
  id: "p",
  themeId: "crave",
  name: "Crave",
  status: "generating",
  modelKey: "gemini-3.8-flash",
  industries: ["home"],
  catalogSizes: ["small"],
  requiredFeatures: [],
  baseThemeId: null,
  draftBrief: "Grocery shop",
  currentVersionId: null,
  revision: 3,
  createdByEmail: "operator@example.com",
  createdAt: "2026-09-29T04:30:00Z",
  updatedAt: "2026-09-29T05:30:00Z",
  references: [],
  messages: [],
  runs: [],
  versions: [],
  previews: [],
  events: [],
};
const props = {
  project,
  modelLabel: "Gemini",
  generationEnabled: true,
  testProvider: false,
  referenceLimit: 10,
  acceptance: {},
};
it("shows visual findings beside passing browser checks and resolves a hidden parent version number", () => {
  render(
    <ProjectWorkspace
      {...props}
      acceptance={{ v: { status: "passed" } } as never}
      project={{
        ...project,
        status: "ready",
        currentVersionId: "v",
        versions: [
          {
            id: "v",
            versionNumber: 12,
            parentVersionId: "hidden",
            parentVersionNumber: 11,
            runId: null,
            origin: "asset_edit",
            editedSlots: ["hero"],
            intentDigest: "digest",
            packageDigest: "package",
            packageSummary: null,
            designDirection: "magazine-editorial",
            paletteFamily: "light",
            distinctness: {
              version: 1,
              score: 0.25,
              threshold: 0.35,
              nearestThemeId: "studio",
              sharedAttributes: ["card", "hero"],
              changedAxes: 2,
              status: "similar",
              repairAttempted: true,
            },
            summary: "Vanta",
            assumptions: [],
            hasPackage: true,
            qaStatus: "failed",
            qaIteration: 3,
            qaFindings: ["Product titles split mid-word at laptop widths."],
            qaDiagnosis: "These findings require a platform renderer fix.",
            qaRepairs: [
              {
                kind: "renderer",
                target: null,
                reason: "Product title wrapping",
              },
            ],
            createdAt: project.createdAt,
          },
        ],
      }}
    />,
  );
  expect(screen.getByText("Automatic QA needs attention")).toBeTruthy();
  expect(screen.getByText(/Design distinctness: 25%/)).toBeTruthy();
  expect(screen.getByText(/Closest theme: studio/)).toBeTruthy();
  expect(
    screen.getByText(/This design still resembles the catalogue/),
  ).toBeTruthy();
  expect(
    screen.getByText(/One automatic variety correction was attempted/),
  ).toBeTruthy();
  expect(
    screen.getByText("These findings require a platform renderer fix."),
  ).toBeTruthy();
  expect(screen.getByText(/Product title wrapping/)).toBeTruthy();
  expect(
    screen.getByText("Product titles split mid-word at laptop widths."),
  ).toBeTruthy();
  expect(
    screen.getByText(/images replaced \(1\) on version/).textContent,
  ).toContain("11");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("keeps refreshing through capture and QA with no active generation run, then stops on ready", () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const view = render(<ProjectWorkspace {...props} />);
  expect(screen.getByText(/Generated drafts stay private/)).toBeTruthy();
  vi.advanceTimersByTime(2500);
  expect(refresh).toHaveBeenCalledTimes(1);
  view.rerender(
    <ProjectWorkspace {...props} project={{ ...project, status: "ready" }} />,
  );
  vi.advanceTimersByTime(5000);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("refreshes immediately when an unfinished theme tab becomes visible again", () => {
  vi.useFakeTimers();
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  render(<ProjectWorkspace {...props} />);
  vi.advanceTimersByTime(5000);
  expect(refresh).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(refresh).toHaveBeenCalledTimes(1);
});

it.each(["revise", "images"] as const)(
  "shows the correct %s cooldown with cancellation, without offering another retry",
  (kind) => {
    render(
      <ProjectWorkspace
        {...props}
        project={{
          ...project,
          runs: [
            {
              id: "run",
              kind,
              status: "queued",
              provider: "vertex-gemini",
              modelKey: "gemini-3.8-flash",
              attemptCount: 1,
              maxAttempts: 3,
              retryNotBefore: "2026-10-02T05:30:00Z",
              rateLimitDeferrals: 2,
              imageReviewDeferrals: 1,
              errorCode: null,
              cancelRequested: false,
              retryOfRunId: null,
              baseVersionId: null,
              createdAt: "2026-10-02T05:00:00Z",
              startedAt: "2026-10-02T05:00:00Z",
              finishedAt: null,
              usage: null,
              images: null,
              imageSlotIds: [],
              questions: [],
              declineReason: null,
              refusalCategory: null,
            },
          ],
        }}
      />,
    );
    if (kind === "images")
      expect(screen.getByText(/Artwork is saved/).textContent).toContain(
        "Image review retry 1/2",
      );
    else
      expect(
        screen.getByText(/Waiting for model provider capacity/).textContent,
      ).toContain("Automatic recovery 2/4");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  },
);
