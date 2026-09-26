import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The refusals that must happen before the database is touched. The full
// review → approve → publish → hide → show sequence, and every database rule
// behind it, is exercised against a real PostgreSQL (docs/mink-ai-theme-
// studio-phase6.md §7); these pin the input boundary.
// ---------------------------------------------------------------------------

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: false,
  gcsPathFromUrl: () => null,
  gcsPublicUrl: (path: string) => `https://storage.googleapis.com/b/${path}`,
  gcsUploadObject: vi.fn(),
}));

import { withService } from "@/lib/db/client";
import {
  approveThemeStudioCandidate,
  changeThemeStudioCatalog,
  getThemeStudioReleaseState,
  publishThemeStudioProject,
  submitThemeStudioReview,
} from "./publication";
import { ThemeStudioError } from "./repository";

const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "owner@storemink.com",
};
const projectId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";

describe("Phase 6 input boundary", () => {
  beforeEach(() => {
    vi.mocked(withService).mockClear();
  });

  it("refuses an unknown project id everywhere", async () => {
    await expect(
      submitThemeStudioReview(actor, {
        projectId: "nope",
        versionId,
        expectedPackageDigest: "d",
        scorecard: {},
      }),
    ).rejects.toBeInstanceOf(ThemeStudioError);
    await expect(
      approveThemeStudioCandidate(actor, {
        projectId: "nope",
        expectedRevision: 0,
      }),
    ).rejects.toThrow(/no longer exists/);
    await expect(
      publishThemeStudioProject(actor, {
        projectId: "nope",
        expectedRevision: 0,
        confirmThemeId: "x",
      }),
    ).rejects.toThrow(/no longer exists/);
    await expect(
      changeThemeStudioCatalog(actor, { projectId: "nope", change: {} }),
    ).rejects.toThrow(/no longer exists/);
    expect(await getThemeStudioReleaseState("nope")).toBeNull();
    expect(withService).not.toHaveBeenCalled();
  });

  it("refuses a scorecard below the bar before touching the database", async () => {
    await expect(
      submitThemeStudioReview(actor, {
        projectId,
        versionId,
        expectedPackageDigest: "d".repeat(64),
        scorecard: {
          role: "design",
          scores: {
            artDirection: 5,
            distinctness: 5,
            commerceClarity: 5,
            typography: 5,
            imagery: 3,
            responsiveComposition: 5,
            detailQuality: 5,
            brandAdaptability: 5,
          },
          rejections: [],
          verdict: "approve",
          notes: "",
        },
      }),
    ).rejects.toThrow(/every row at 4/);
    expect(withService).not.toHaveBeenCalled();
  });

  it("refuses to publish when media storage is not configured", async () => {
    await expect(
      publishThemeStudioProject(actor, {
        projectId,
        expectedRevision: 0,
        confirmThemeId: "clay-co",
      }),
    ).rejects.toThrow(/Media storage is not configured/);
    expect(withService).not.toHaveBeenCalled();
  });

  it("refuses a catalog change without a reason", async () => {
    await expect(
      changeThemeStudioCatalog(actor, {
        projectId,
        change: { action: "hide", reason: "" },
      }),
    ).rejects.toThrow(/reason/);
    expect(withService).not.toHaveBeenCalled();
  });
});
