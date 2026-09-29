import type { ThemeStudioAcceptanceRunView } from "./acceptance";
import { THEME_STUDIO_LIMITS } from "./contracts";

/** Draft only: operators review this in chat before queuing a revision. */
export function acceptanceRepairDraft(
  run: ThemeStudioAcceptanceRunView,
  version: { id: string; packageDigest: string | null; versionNumber: number },
): string | null {
  if (
    !run.currentBuild ||
    run.versionId !== version.id ||
    run.packageDigest !== version.packageDigest ||
    run.status !== "failed"
  )
    return null;
  const repairable = new Set([
    "package.schema",
    "package.content",
    "package.design",
    "routes.links",
    "routes.markup",
    "browser.overflow",
    "browser.clipped_text",
    "browser.tap_targets",
    "browser.image_crops",
    "browser.accessibility",
  ]);
  const sections = run.gates
    .filter(
      (gate) =>
        gate.required && gate.status === "fail" && repairable.has(gate.id),
    )
    .map((gate) => {
      const examples = [
        ...new Set(
          gate.findings.map(
            (finding) => `${finding.where ?? "Theme"}: ${finding.message}`,
          ),
        ),
      ].slice(0, 6);
      return `${gate.label} (${gate.findings.length} reported findings):\n${examples.map((text) => `- ${text.slice(0, 700)}`).join("\n")}`;
    });
  if (!sections.length) return null;
  return `Fix the theme-specific acceptance failures in version ${version.versionNumber}. Keep its visual identity, content and existing images. Repair the relevant palette, section settings, layout and content across all affected pages and viewport sizes. Do not hide content or disable checks to make them pass. If a finding needs a shared storefront code change that the theme cannot express, explain that limitation.\n\nAcceptance run ${run.id}:\n${sections.join("\n\n")}`.slice(
    0,
    THEME_STUDIO_LIMITS.promptChars - 2000,
  );
}
