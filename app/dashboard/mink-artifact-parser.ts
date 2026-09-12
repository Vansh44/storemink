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
  "storefront_layout_proposal",
  "storefront_design_proposal",
  "media_image_proposal",
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
      if (type === "storefront_layout_proposal") {
        return isStorefrontLayoutProposal(artifact as Record<string, unknown>);
      }
      if (type === "storefront_design_proposal") {
        return isStorefrontDesignProposal(artifact as Record<string, unknown>);
      }
      if (type === "media_image_proposal") {
        return isMediaImageProposal(artifact as Record<string, unknown>);
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

function isStorefrontLayoutProposal(value: Record<string, unknown>): boolean {
  const target = value.target;
  const summary = value.summary;
  return (
    isUuid(value.draftId) &&
    isBoundedText(value.title, 120) &&
    isBoundedText(value.destinationLabel, 180) &&
    isSafeBuilderPath(value.destinationPath) &&
    isBoundedText(value.explanation, 1_000) &&
    isRecord(target) &&
    isBoundedText(target.pageSlug, 60) &&
    isBoundedText(target.expectedPageVersion, 40) &&
    !Number.isNaN(Date.parse(String(target.expectedPageVersion))) &&
    isDigest(target.expectedSectionsDigest) &&
    isDigest(value.patchDigest) &&
    Number.isInteger(value.sectionCount) &&
    Number(value.sectionCount) >= 1 &&
    // MAX_PAGE_SECTIONS. Hardcoded rather than imported so this parser stays a
    // pure bounds check over untrusted stored JSON; a restored card being one
    // section over a raised cap must not become a build-time coupling.
    Number(value.sectionCount) <= 40 &&
    isRecord(summary) &&
    typeof summary.reordered === "boolean" &&
    isSectionRefs(summary.kept) &&
    isSectionRefs(summary.added) &&
    isSectionRefs(summary.removed) &&
    value.status === "private_preview" &&
    isCreditCount(value.expectedCredits) &&
    isCreditCount(value.chargedCredits) &&
    ["plan", "credit", "mixed", "plan_unlimited"].includes(
      String(value.creditSource),
    )
  );
}

function isStorefrontDesignProposal(value: Record<string, unknown>): boolean {
  const target = value.target;
  const summary = value.summary;
  return (
    isUuid(value.draftId) &&
    isBoundedText(value.title, 120) &&
    isBoundedText(value.destinationLabel, 180) &&
    isSafeBuilderPath(value.destinationPath) &&
    isBoundedText(value.explanation, 1_000) &&
    isRecord(target) &&
    isDigest(target.expectedDesignDigest) &&
    isDigest(value.patchDigest) &&
    isRecord(summary) &&
    isDesignChanges(summary.palette, isPaletteChange) &&
    isDesignChanges(summary.fonts, isFontChange) &&
    isDesignChanges(summary.shape, isShapeChange) &&
    Array.isArray(summary.contrastIssues) &&
    summary.contrastIssues.length <= 3 &&
    summary.contrastIssues.every((issue) => isBoundedText(issue, 200)) &&
    value.status === "private_preview" &&
    isCreditCount(value.expectedCredits) &&
    isCreditCount(value.chargedCredits) &&
    ["plan", "credit", "mixed", "plan_unlimited"].includes(
      String(value.creditSource),
    )
  );
}

/**
 * ★ EIGHT IS THE WHOLE PALETTE, so a list longer than that is not a big
 * change, it is a forged one. The bounds are hardcoded for `isSectionRefs`'s
 * reason: this parser is a pure check over untrusted stored JSON, and a
 * restored card must not fail to render because a constant moved.
 */
function isDesignChanges(
  value: unknown,
  entry: (row: Record<string, unknown>) => boolean,
): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every((row) => isRecord(row) && entry(row))
  );
}

/**
 * ⚠ THE COLOUR IS RE-CHECKED HERE, not merely bounded, because the card writes
 * it into an inline `style` attribute. `lib/chrome/design.ts` already refuses
 * anything but hex on the way in, and this is the second gate on the way back
 * OUT of stored conversation JSON — the surface that never went through the
 * validator.
 */
function isPaletteChange(row: Record<string, unknown>): boolean {
  return (
    isBoundedText(row.token, 40) &&
    isOptionalHex(row.before) &&
    isOptionalHex(row.after) &&
    isOptionalHex(row.themeDefault)
  );
}

function isFontChange(row: Record<string, unknown>): boolean {
  return (
    (row.slot === "body" || row.slot === "display") &&
    isOptionalText(row.before, 40) &&
    isOptionalText(row.after, 40) &&
    isOptionalText(row.themeDefault, 40)
  );
}

function isShapeChange(row: Record<string, unknown>): boolean {
  return (
    isBoundedText(row.key, 40) &&
    isOptionalRadius(row.before) &&
    isOptionalRadius(row.after) &&
    isOptionalRadius(row.themeDefault)
  );
}

function isOptionalHex(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value))
  );
}

function isOptionalText(value: unknown, max: number): boolean {
  return value === null || isBoundedText(value, max);
}

function isOptionalRadius(value: unknown): boolean {
  return (
    value === null ||
    (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 999)
  );
}

function isSectionRefs(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 40 &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        isBoundedText(entry.id, 128) &&
        isBoundedText(entry.type, 40),
    )
  );
}

/**
 * ★★ THE URL IS THE ONE FIELD HERE THAT GETS RENDERED AS A LIVE RESOURCE, so
 * it is pinned to a generated object under this platform's own media host. A
 * restored card draws `<img src={url}>`; without this, a forged history row
 * would have the dashboard fetch an arbitrary third-party address on open,
 * which is a tracking beacon at best. The bounds are hardcoded for
 * `isSectionRefs`'s reason -- a pure check over untrusted stored JSON must not
 * stop rendering because a constant moved.
 */
function isGeneratedImageUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 500 &&
    /^https:\/\/storage\.googleapis\.com\/[A-Za-z0-9._-]+\/stores\/[0-9a-f-]{36}\/mink-generated\/[0-9a-f-]{36}\.(jpg|png)$/.test(
      value,
    )
  );
}

function isMediaImageProposal(value: Record<string, unknown>): boolean {
  return (
    isUuid(value.draftId) &&
    isBoundedText(value.title, 120) &&
    isBoundedText(value.destinationLabel, 180) &&
    value.destinationPath === "/dashboard/media" &&
    isGeneratedImageUrl(value.url) &&
    isBoundedText(value.alt, 180) &&
    isBoundedText(value.prompt, 600) &&
    ["hero", "gallery", "feature", "banner"].includes(String(value.purpose)) &&
    ["1:1", "4:3", "16:9", "3:4", "9:16"].includes(String(value.aspectRatio)) &&
    isBoundedText(value.placement, 200) &&
    typeof value.saved === "boolean" &&
    value.status === "private_preview" &&
    isCreditCount(value.expectedCredits) &&
    isCreditCount(value.chargedCredits) &&
    ["plan", "credit", "mixed", "plan_unlimited"].includes(
      String(value.creditSource),
    )
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
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
