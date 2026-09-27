import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
}));

import { withService } from "@/lib/db/client";
import {
  currentAcceptanceBuildId,
  startThemeStudioAcceptance,
  submitThemeStudioBrowserEvidence,
  verifyThemeStudioCandidateEvidence,
} from "./acceptance";
import { ThemeStudioError } from "./repository";

// The orchestration's database work is exercised against a real PostgreSQL
// (docs/mink-ai-theme-studio-phase5.md, "Verification"); these pin the
// refusals that must happen BEFORE any row is read or written.

const actor = { id: "00000000-0000-4000-8000-000000000001", email: "a@b.c" };
const UUID = "00000000-0000-4000-8000-0000000000aa";

afterEach(() => {
  delete process.env.THEME_STUDIO_BUILD_ID;
  delete process.env.K_REVISION;
});

describe("acceptance build identity", () => {
  it("prefers an explicit build id, then the Cloud Run revision", () => {
    expect(currentAcceptanceBuildId()).toBe("development");
    process.env.K_REVISION = "storemink-web-prod-00042-abc";
    expect(currentAcceptanceBuildId()).toBe("storemink-web-prod-00042-abc");
    process.env.THEME_STUDIO_BUILD_ID = "release-7";
    expect(currentAcceptanceBuildId()).toBe("release-7");
  });
});

describe("acceptance refusals before any database work", () => {
  it("refuses malformed ids on start", async () => {
    await expect(
      startThemeStudioAcceptance(actor, {
        projectId: "nope",
        versionId: UUID,
        sessionCookie: null,
      }),
    ).rejects.toBeInstanceOf(ThemeStudioError);
    expect(withService).not.toHaveBeenCalled();
  });

  it("refuses a malformed browser report without touching the run", async () => {
    await expect(
      submitThemeStudioBrowserEvidence(actor, {
        projectId: UUID,
        runId: UUID,
        nonce: "x",
        evidence: { samples: [] },
      }),
    ).rejects.toThrow(/no samples/);
    await expect(
      submitThemeStudioBrowserEvidence(actor, {
        projectId: UUID,
        runId: UUID,
        nonce: "x",
        evidence: {
          samples: [{ viewport: "desktop", surface: "home", width: "1440" }],
        },
      }),
    ).rejects.toThrow(/measurement/);
    expect(withService).not.toHaveBeenCalled();
  });

  it("an unknown project has no current evidence", async () => {
    expect(await verifyThemeStudioCandidateEvidence("nope")).toEqual({
      ok: false,
      reason: "Unknown project.",
    });
    expect(withService).not.toHaveBeenCalled();
  });
});
