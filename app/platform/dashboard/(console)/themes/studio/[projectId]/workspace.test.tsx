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
