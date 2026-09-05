import type { MinkArtifact } from "@/lib/mink/types";
import { MINK_WORKFLOW_TEMPLATES } from "@/lib/mink/workflow-types";

const MINK_ARTIFACT_TYPES = new Set<MinkArtifact["type"]>([
  "metrics",
  "clarification",
  "catalog",
  "records",
  "sources",
  "proposal",
  "storefront_code_proposal",
  "workflow",
]);

export function readMinkArtifacts(value: unknown): MinkArtifact[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((artifact): artifact is MinkArtifact => {
      if (!artifact || typeof artifact !== "object") return false;
      const type = (artifact as { type?: unknown }).type;
      const allowed =
        typeof type === "string" &&
        MINK_ARTIFACT_TYPES.has(type as MinkArtifact["type"]);
      if (!allowed) return false;
      if (type === "clarification") {
        const clarification = artifact as Record<string, unknown>;
        return (
          typeof clarification.question === "string" &&
          clarification.question.length <= 300 &&
          Array.isArray(clarification.choices) &&
          clarification.choices.length >= 1 &&
          clarification.choices.length <= 6 &&
          clarification.choices.every((choice) => {
            if (!choice || typeof choice !== "object") return false;
            const row = choice as Record<string, unknown>;
            return (
              typeof row.label === "string" &&
              row.label.length >= 1 &&
              row.label.length <= 100 &&
              typeof row.prompt === "string" &&
              row.prompt.length >= 1 &&
              row.prompt.length <= 1_000 &&
              (row.description === undefined ||
                (typeof row.description === "string" &&
                  row.description.length <= 200))
            );
          })
        );
      }
      if (type === "workflow") {
        const workflow = artifact as Record<string, unknown>;
        return (
          typeof workflow.runId === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            workflow.runId,
          ) &&
          MINK_WORKFLOW_TEMPLATES.includes(
            workflow.template as (typeof MINK_WORKFLOW_TEMPLATES)[number],
          ) &&
          typeof workflow.title === "string" &&
          workflow.title.length <= 120 &&
          typeof workflow.description === "string" &&
          workflow.description.length <= 300 &&
          [
            "queued",
            "running",
            "waiting_approval",
            "completed",
            "failed",
            "cancelled",
          ].includes(String(workflow.status)) &&
          Number.isInteger(workflow.currentStep) &&
          Number(workflow.currentStep) >= 0 &&
          Number.isInteger(workflow.totalSteps) &&
          Number(workflow.totalSteps) >= 1 &&
          Number(workflow.totalSteps) <= 20 &&
          Number(workflow.currentStep) <= Number(workflow.totalSteps)
        );
      }
      if (type === "storefront_code_proposal") {
        return isStorefrontCodeProposal(artifact as Record<string, unknown>);
      }
      if (type !== "catalog") return true;
      const catalog = artifact as Record<string, unknown>;
      return (
        catalog.counts !== null &&
        typeof catalog.counts === "object" &&
        !Array.isArray(catalog.counts) &&
        Array.isArray(catalog.items) &&
        catalog.items.length <= 20 &&
        Array.isArray(catalog.filters) &&
        (catalog.locations === undefined ||
          (Array.isArray(catalog.locations) && catalog.locations.length <= 20))
      );
    })
    .slice(0, 6);
}

function isStorefrontCodeProposal(value: Record<string, unknown>): boolean {
  const target = value.target;
  const changedFields = value.changedFields;
  const checks = value.validationChecks;
  return (
    isUuid(value.draftId) &&
    isBoundedText(value.title, 120) &&
    isBoundedText(value.destinationLabel, 180) &&
    isSafeBuilderPath(value.destinationPath) &&
    isBoundedText(value.explanation, 1_000) &&
    isRecord(target) &&
    isBoundedText(target.pageSlug, 60) &&
    isBoundedText(target.sectionId, 128) &&
    isBoundedText(target.expectedPageVersion, 40) &&
    typeof target.expectedPageVersion === "string" &&
    !Number.isNaN(Date.parse(target.expectedPageVersion)) &&
    typeof target.expectedSectionDigest === "string" &&
    /^[a-f0-9]{64}$/.test(target.expectedSectionDigest) &&
    typeof value.patchDigest === "string" &&
    /^[a-f0-9]{64}$/.test(value.patchDigest) &&
    Array.isArray(changedFields) &&
    changedFields.length >= 1 &&
    changedFields.length <= 4 &&
    changedFields.every((field) =>
      ["html", "css", "js", "height"].includes(String(field)),
    ) &&
    Number.isInteger(value.beforeCharacters) &&
    Number(value.beforeCharacters) >= 0 &&
    Number(value.beforeCharacters) <= 3 * 64 * 1_024 &&
    Number.isInteger(value.afterCharacters) &&
    Number(value.afterCharacters) >= 0 &&
    Number(value.afterCharacters) <= 3 * 64 * 1_024 &&
    Array.isArray(checks) &&
    checks.length >= 1 &&
    checks.length <= 10 &&
    checks.every((check) => isBoundedText(check, 200)) &&
    value.status === "private_preview" &&
    isCreditCount(value.expectedCredits) &&
    isCreditCount(value.chargedCredits) &&
    ["plan", "credit", "mixed", "plan_unlimited"].includes(
      String(value.creditSource),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

function isSafeBuilderPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 400 &&
    (value === "/dashboard/builder" || value.startsWith("/dashboard/builder?"))
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isCreditCount(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 20;
}
