import { expect, it } from "vitest";
import { acceptanceRepairDraft } from "./acceptance-repair";
import { gate } from "./acceptance-gates";
import type { ThemeStudioAcceptanceRunView } from "./acceptance";
import { THEME_STUDIO_LIMITS } from "./contracts";

const version = { id: "v8", versionNumber: 8, packageDigest: "digest" };
const run: ThemeStudioAcceptanceRunView = {
  id: "run",
  versionId: "v8",
  packageDigest: "digest",
  assetsDigest: "assets",
  buildId: "build",
  currentBuild: true,
  evidenceDigest: "evidence",
  status: "failed",
  createdByEmail: "operator@example.com",
  createdAt: "2026-09-29",
  completedAt: "2026-09-29",
  userAgent: null,
  gates: [
    gate("routes.render", [{ code: "indexable", message: "Missing noindex" }]),
    gate("assets.provenance", [
      { code: "placeholder", message: "Capture screenshots" },
    ]),
    gate("browser.accessibility", [
      {
        code: "contrast",
        where: "phone360 · home",
        message: "Low contrast in .shop-card",
      },
    ]),
  ],
};

it("drafts actionable theme findings without asking the model to fix capture or metadata", () => {
  const draft = acceptanceRepairDraft(run, version)!;
  expect(draft).toContain("version 8");
  expect(draft).toContain("phone360 · home: Low contrast in .shop-card");
  expect(draft).not.toContain("Missing noindex");
  expect(draft).not.toContain("Capture screenshots");
});
it("refuses stale, mismatched, incomplete and successful evidence", () => {
  for (const patch of [
    { currentBuild: false },
    { versionId: "another" },
    { packageDigest: "old" },
    { status: "awaiting_browser" as const },
    { status: "passed" as const },
  ])
    expect(acceptanceRepairDraft({ ...run, ...patch }, version)).toBeNull();
});
it("caps repeated findings and keeps the revision within the message limit", () => {
  const huge = {
    ...run,
    gates: [
      gate(
        "browser.clipped_text",
        Array.from({ length: 100 }, (_, i) => ({
          code: "clip",
          message: `${i}${"x".repeat(9000)}`,
        })),
      ),
    ],
  };
  expect(acceptanceRepairDraft(huge, version)!.length).toBeLessThanOrEqual(
    THEME_STUDIO_LIMITS.promptChars - 2000,
  );
  expect(
    acceptanceRepairDraft({ ...run, gates: run.gates.slice(0, 2) }, version),
  ).toBeNull();
});
