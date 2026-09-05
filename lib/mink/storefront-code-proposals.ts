import "server-only";

import { sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import { withService } from "@/lib/db/client";
import { resolveStoreSettings } from "@/lib/settings/registry";
import {
  validateConfig,
  validateSections,
  type CustomCodeConfig,
  type PageSectionItem,
} from "@/lib/sections/registry";
import { createMinkDraftProposal, getMinkDraft } from "./drafts";
import { MinkRequestError, MinkToolInputError } from "./errors";
import {
  digestMinkStorefrontValue,
  MINK_STOREFRONT_PATCH_SCHEMA_VERSION,
  MINK_STOREFRONT_SANDBOX_CONTRACT,
  validateMinkStorefrontCodePatch,
  type MinkStorefrontCodePatch,
  type ValidatedMinkStorefrontCodePatch,
} from "./storefront-code-contract";
import type { MinkDraftContent } from "./draft-types";
import type { MinkStorefrontCodePreviewDto } from "./storefront-code-preview-types";
import type { MinkActorContext, MinkArtifact } from "./types";

const EXPLANATION_MAX_CHARS = 1_000;
const VALIDATION_CHECKS = Object.freeze([
  "Exact current-store page and custom-code section matched",
  "Exact page version and section digest matched",
  "Patch schema and code-size limits passed",
  "Unsafe HTML, CSS and JavaScript capabilities were rejected",
  "Preview is opaque-origin and network-isolated",
  "No Website Builder save or publish authority was granted",
]);

type StorefrontTarget = {
  pageSlug: string;
  pageTitle: string;
  pageVersion: string;
  section: PageSectionItem & {
    type: "custom_code";
    config: CustomCodeConfig;
  };
  sectionDigest: string;
};

/**
 * Persist one immutable private proposal after every target and code check has
 * passed. The only write is to Mink's private proposal ledger; store_pages is
 * never updated in Phase 7B.
 */
export async function createMinkStorefrontCodeProposal(input: {
  actor: MinkActorContext;
  patch: unknown;
  explanation: unknown;
}): Promise<Extract<MinkArtifact, { type: "storefront_code_proposal" }>> {
  assertBuilderManage(input.actor, true);
  if (typeof input.explanation !== "string") {
    throw new MinkToolInputError("explanation must be text.");
  }
  const explanation = input.explanation.normalize("NFKC").trim();
  if (!explanation || explanation.length > EXPLANATION_MAX_CHARS) {
    throw new MinkToolInputError(
      `explanation must be between 1 and ${EXPLANATION_MAX_CHARS.toLocaleString("en-IN")} characters.`,
    );
  }

  const validation = validateMinkStorefrontCodePatch(input.patch);
  if (!validation.ok) {
    throw new MinkToolInputError(
      `The generated code proposal is unsafe or invalid: ${validation.issues.join(" ")}`,
    );
  }

  const target = await readExactStorefrontTarget(
    input.actor,
    validation.value.patch.target.pageSlug,
    validation.value.patch.target.sectionId,
  );
  assertFreshTarget(target, validation.value);

  const changedFields = changedCodeFields(
    target.section.config,
    validation.value.config,
  );
  if (!changedFields.length) {
    throw new MinkToolInputError(
      "The generated patch is identical to the current custom-code section.",
    );
  }

  const before = draftContent({
    patch: {
      ...validation.value.patch,
      code: publicCodeConfig(target.section.config),
    },
    patchDigest: digestMinkStorefrontValue(target.section.config),
    explanation: "Current Website Builder code before this proposal.",
  });
  const content = draftContent({
    patch: validation.value.patch,
    patchDigest: validation.value.patchDigest,
    explanation,
  });
  const destinationPath = `/dashboard/builder?page=${encodeURIComponent(target.pageSlug)}&section=${encodeURIComponent(target.section.id)}`;
  const genericProposal = await createMinkDraftProposal({
    actor: input.actor,
    kind: "storefront_custom_code",
    title: `Storefront code for ${target.pageTitle}`,
    destinationType: "storefront_section",
    destinationLabel: `${target.pageTitle} · custom code`,
    destinationPath,
    before,
    content,
  });
  if (genericProposal.type !== "proposal") {
    throw new Error("Storefront proposal persistence returned no proposal");
  }

  return {
    type: "storefront_code_proposal",
    draftId: genericProposal.draftId,
    title: genericProposal.title,
    destinationLabel: genericProposal.destinationLabel,
    destinationPath,
    explanation,
    target: validation.value.patch.target,
    patchDigest: validation.value.patchDigest,
    changedFields,
    beforeCharacters: codeCharacters(target.section.config),
    afterCharacters: codeCharacters(validation.value.config),
    validationChecks: [...VALIDATION_CHECKS],
    status: "private_preview",
    expectedCredits: genericProposal.expectedCredits,
    chargedCredits: genericProposal.chargedCredits,
    creditSource: genericProposal.creditSource,
  };
}

/**
 * Return the owner-only DTO used by the browser preview. Stored code is
 * revalidated every time and compared with the latest builder checkpoint, but
 * it is never executed on the server and no builder mutation is available.
 */
export async function getMinkStorefrontCodePreview(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkStorefrontCodePreviewDto> {
  assertBuilderManage(actor, false);
  const draft = await getMinkDraft(actor, draftId);
  if (draft.kind !== "storefront_custom_code") {
    throw new MinkRequestError(
      "mink_storefront_preview_not_found",
      "This private storefront preview is not available.",
      404,
    );
  }
  const validation = validateStoredStorefrontProposal(draft.content);
  const beforeConfig = readStoredStorefrontCodeConfig(draft.before, "before");
  const changedFields = changedCodeFields(
    beforeConfig,
    validation.value.config,
  );

  let targetState: MinkStorefrontCodePreviewDto["targetState"] = "unavailable";
  let targetMessage =
    "The target section is no longer available. This private preview remains viewable but cannot be applied.";
  try {
    const current = await readExactStorefrontTarget(
      actor,
      validation.value.patch.target.pageSlug,
      validation.value.patch.target.sectionId,
    );
    const currentTarget =
      current.pageVersion ===
        validation.value.patch.target.expectedPageVersion &&
      current.sectionDigest ===
        validation.value.patch.target.expectedSectionDigest;
    targetState = currentTarget ? "current" : "stale";
    targetMessage = currentTarget
      ? "The Website Builder target still matches this preview checkpoint."
      : "The Website Builder page or section changed after this proposal. Generate a fresh proposal before any later save workflow.";
  } catch (error) {
    if (!(error instanceof MinkToolInputError)) throw error;
  }

  return {
    id: draft.id,
    draftVersion: draft.currentVersion,
    title: draft.title,
    destinationLabel: draft.destinationLabel,
    destinationPath: draft.destinationPath,
    explanation: draft.content.explanation,
    target: validation.value.patch.target,
    targetState,
    targetMessage,
    patchDigest: validation.value.patchDigest,
    beforeConfig,
    proposedConfig: validation.value.config,
    changedFields,
    validationChecks: [...VALIDATION_CHECKS],
    sandbox: MINK_STOREFRONT_SANDBOX_CONTRACT,
    authority: {
      canPreview: true,
      canEditProposal: false,
      canSaveBuilderDraft: targetState === "current",
      canPublish: false,
    },
  };
}

async function readExactStorefrontTarget(
  actor: MinkActorContext,
  pageSlug: string,
  sectionId: string,
): Promise<StorefrontTarget> {
  assertBuilderManage(actor, true);
  const storedSlug = pageSlug === "home" ? "" : pageSlug;
  const result = await withService((db) =>
    db.execute(sql`
      select
        page.title,
        page.slug,
        page.sections,
        page.updated_at,
        store.settings
      from store_pages as page
      inner join stores as store
        on store.id = page.store_id
       and store.id = ${actor.storeId}
      where page.store_id = ${actor.storeId}
        and page.slug = ${storedSlug}
      limit 1
    `),
  );
  const row = result.rows[0] as
    | {
        title: string;
        slug: string;
        sections: unknown;
        updated_at: string;
        settings: unknown;
      }
    | undefined;
  if (!row) {
    throw new MinkToolInputError(
      `No storefront page matches exact slug ${JSON.stringify(pageSlug)}.`,
    );
  }
  const resolved = resolveStoreSettings(
    isRecord(row.settings) ? row.settings : {},
    actor.effectivePlan,
  );
  if (resolved["pages.customCode"] !== true) {
    throw new MinkToolInputError(
      "Custom code is not enabled for the current store and plan.",
    );
  }
  const validated = validateSections(row.sections, { mode: "draft" });
  if ("error" in validated) {
    throw new MinkToolInputError(
      `The draft sections for page ${JSON.stringify(pageSlug)} cannot be inspected safely. Repair the page in Website Builder first.`,
    );
  }
  const section = validated.sections.find((item) => item.id === sectionId);
  if (!section) {
    throw new MinkToolInputError(
      `No section with exact id ${JSON.stringify(sectionId)} exists on page ${JSON.stringify(pageSlug)}.`,
    );
  }
  if (section.type !== "custom_code") {
    throw new MinkToolInputError(
      "Phase 7B can propose code only for an existing custom-code section.",
    );
  }
  return {
    pageSlug: row.slug === "" ? "home" : row.slug,
    pageTitle: boundedTitle(row.title, pageSlug),
    pageVersion: row.updated_at,
    section: section as StorefrontTarget["section"],
    sectionDigest: digestMinkStorefrontValue(section),
  };
}

function assertFreshTarget(
  target: StorefrontTarget,
  validation: ValidatedMinkStorefrontCodePatch,
): void {
  if (
    target.pageVersion !== validation.patch.target.expectedPageVersion ||
    target.sectionDigest !== validation.patch.target.expectedSectionDigest
  ) {
    throw new MinkToolInputError(
      "The Website Builder page or section changed. Read the exact page and section again before generating a new code proposal.",
    );
  }
}

export function validateStoredStorefrontProposal(content: MinkDraftContent) {
  const result = validateMinkStorefrontCodePatch({
    schemaVersion: MINK_STOREFRONT_PATCH_SCHEMA_VERSION,
    operation: "replace_custom_code",
    target: {
      pageSlug: content.page_slug,
      sectionId: content.section_id,
      expectedPageVersion: content.expected_page_version,
      expectedSectionDigest: content.expected_section_digest,
    },
    code: {
      html: content.html,
      css: content.css,
      js: content.js,
      heightMode: content.height_mode,
      fixedHeight: Number(content.fixed_height),
    },
  });
  if (!result.ok || result.value.patchDigest !== content.patch_digest) {
    throw new MinkRequestError(
      "mink_storefront_preview_invalid",
      "This private storefront preview failed integrity validation.",
      409,
    );
  }
  return result;
}

export function readStoredStorefrontCodeConfig(
  content: MinkDraftContent,
  label: string,
): CustomCodeConfig {
  // Existing merchant code is historical input, not newly generated output.
  // Validate its shape for escaped diff display, but never execute it in the
  // preview and do not retroactively reject a proposal because old code uses a
  // capability that Phase 7B no longer permits generated code to introduce.
  const result = validateConfig(
    "custom_code",
    {
      html: content.html,
      css: content.css,
      js: content.js,
      height_mode: content.height_mode,
      fixed_height: Number(content.fixed_height),
    },
    "draft",
  );
  if ("error" in result) {
    throw new MinkRequestError(
      "mink_storefront_preview_invalid",
      `The ${label} storefront snapshot failed integrity validation.`,
      409,
    );
  }
  return result.config as CustomCodeConfig;
}

function draftContent(input: {
  patch: MinkStorefrontCodePatch;
  patchDigest: string;
  explanation: string;
}): MinkDraftContent {
  return {
    page_slug: input.patch.target.pageSlug,
    section_id: input.patch.target.sectionId,
    expected_page_version: input.patch.target.expectedPageVersion,
    expected_section_digest: input.patch.target.expectedSectionDigest,
    patch_digest: input.patchDigest,
    html: input.patch.code.html,
    css: input.patch.code.css,
    js: input.patch.code.js,
    height_mode: input.patch.code.heightMode,
    fixed_height: String(input.patch.code.fixedHeight),
    explanation: input.explanation,
  };
}

function publicCodeConfig(
  config: CustomCodeConfig,
): MinkStorefrontCodePatch["code"] {
  return {
    html: config.html,
    css: config.css,
    js: config.js,
    heightMode: config.height_mode,
    fixedHeight: config.fixed_height,
  };
}

function changedCodeFields(
  before: CustomCodeConfig,
  after: CustomCodeConfig,
): Array<"html" | "css" | "js" | "height"> {
  const changed: Array<"html" | "css" | "js" | "height"> = [];
  if (before.html !== after.html) changed.push("html");
  if (before.css !== after.css) changed.push("css");
  if (before.js !== after.js) changed.push("js");
  if (
    before.height_mode !== after.height_mode ||
    before.fixed_height !== after.fixed_height
  ) {
    changed.push("height");
  }
  return changed;
}

function codeCharacters(config: CustomCodeConfig): number {
  return config.html.length + config.css.length + config.js.length;
}

function assertBuilderManage(actor: MinkActorContext, forTool: boolean): void {
  const allowed =
    actor.draftingEnabled === true &&
    can(actor.permissions, "builder", "manage", actor.isSuperadmin);
  if (allowed) return;
  if (forTool) {
    throw new MinkToolInputError(
      "Private storefront code proposals require Mink drafting and Website Builder Manage permission.",
    );
  }
  throw new MinkRequestError(
    "mink_storefront_preview_access_denied",
    "You don't have permission to open this private storefront preview.",
    403,
  );
}

function boundedTitle(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const title = value.normalize("NFKC").trim();
  return title ? title.slice(0, 120) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
