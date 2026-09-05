import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  minkActionApprovals,
  minkActionAudit,
  minkActionToolAccess,
  minkDrafts,
  storePages,
  stores,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { sanitizeBlogContent } from "@/lib/sanitize";
import {
  validateSections,
  type CustomCodeConfig,
  type PageSectionItem,
  type RichTextConfig,
} from "@/lib/sections/registry";
import { resolveStoreSettings } from "@/lib/settings/registry";
import { hashMinkActionPayload } from "./action-integrity";
import { normalizeMinkDraftContent } from "./draft-types";
import { MinkRequestError } from "./errors";
import {
  digestMinkStorefrontValue,
  type ValidatedMinkStorefrontCodePatch,
} from "./storefront-code-contract";
import {
  readStoredStorefrontCodeConfig,
  validateStoredStorefrontProposal,
} from "./storefront-code-proposals";
import {
  validateMinkStorefrontBrowserValidation,
  validateMinkStorefrontPublicationStatic,
} from "./storefront-publication-validation";
import type {
  MinkStorefrontBrowserValidation,
  MinkStorefrontPublicationApproval,
  MinkStorefrontPublicationResult,
  MinkStorefrontPublicationValues,
} from "./storefront-publication-types";
import type { MinkActorContext } from "./types";

const APPROVAL_TTL_MS = 5 * 60 * 1_000;
const EXECUTION_BROWSER_MAX_AGE_MS = 7 * 60 * 1_000;
const TOOL_VERSION = 1;
const TOOL_NAME = "publish_storefront_code" as const;

type ApprovalStatus =
  | "pending"
  | "executed"
  | "conflicted"
  | "expired"
  | "cancelled";

type PublicationApprovalRow = typeof minkActionApprovals.$inferSelect & {
  toolName: typeof TOOL_NAME;
  operation: "apply" | "rollback";
  status: ApprovalStatus;
  resourceType: "storefront_page";
  resourceId: string;
  resourceVersion: string;
  sourceApprovalId: string;
};

type DraftSaveApprovalRow = typeof minkActionApprovals.$inferSelect & {
  toolName: "apply_storefront_code";
  operation: "apply";
  status: "executed";
  resourceType: "storefront_section";
  resourceId: string;
  resourceVersion: string;
  resultId: string;
  resultVersion: string;
};

type AuditRow = typeof minkActionAudit.$inferSelect;

interface StoredPublicationSnapshot {
  schema_version: 1;
  page_slug: string;
  page_title: string;
  page_status: "draft" | "published";
  published_at: string | null;
  sections_digest: string;
  target_section_id: string;
  target_section_digest: string;
  sections: PageSectionItem[];
  browser_validation: MinkStorefrontBrowserValidation | null;
}

interface PublicationPage {
  id: string;
  slug: string;
  title: string;
  status: "draft" | "published";
  publishedAt: string | null;
  updatedAt: string;
  sections: PageSectionItem[];
  publishedSections: PageSectionItem[];
  targetSection: PageSectionItem & {
    type: "custom_code";
    config: CustomCodeConfig;
  };
}

/** Restore the newest completed publish or rollback card for this proposal. */
export async function getLatestMinkStorefrontPublication(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkStorefrontPublicationResult | null> {
  assertAuthority(actor);
  return withService(async (db) => {
    const rows = await db
      .select()
      .from(minkActionApprovals)
      .where(
        and(
          eq(minkActionApprovals.storeId, actor.storeId),
          eq(minkActionApprovals.adminId, actor.adminId),
          eq(minkActionApprovals.draftId, draftId),
          eq(minkActionApprovals.toolName, TOOL_NAME),
          eq(minkActionApprovals.status, "executed"),
        ),
      )
      .orderBy(desc(minkActionApprovals.executedAt))
      .limit(1);
    if (!rows[0]) return null;
    const approval = validatePublicationApproval(rows[0]);
    const audit = await readAudit(db, actor.storeId, approval.id);
    if (!audit || audit.outcome !== "executed") throw invalidApproval();
    return resultFrom(approval, audit, true);
  });
}

/** Create a separate five-minute publication approval after all checks pass. */
export async function previewMinkStorefrontPublication(input: {
  actor: MinkActorContext;
  draftId: string;
  sourceApprovalId: string;
  idempotencyKey: string;
  browserValidation: unknown;
}): Promise<MinkStorefrontPublicationApproval> {
  assertAuthority(input.actor);
  return withService(async (db) => {
    await assertToolEnabled(db, input.actor.storeId);
    // ★★ CANONICAL LOCK ORDER: approval row -> tool access -> draft -> page.
    //
    // Every other Mink action phase is deadlock-free because of one invariant:
    // no path locks a draft and THEN waits on an existing approval row. Their
    // previews lock only the draft (the approval they create is a fresh row
    // nothing can be holding), and their executes take their own approval
    // first. Phase 7D is the first preview that must lock a PRE-EXISTING
    // approval — the completed Phase 7C save — so acquiring the draft first
    // inverted that order against `executeMinkStorefrontCodeAction`, which
    // locks its approval and then the draft. Approving a Builder draft save
    // while a second tab reviewed publication for the same proposal could then
    // deadlock: Postgres aborts one side and the route reports a bare 503.
    // The reads below keep their original sequence, so error precedence is
    // unchanged; only acquisition order moves.
    await lockApproval(db, input.actor, input.sourceApprovalId);
    await lockDraft(db, input.actor, input.draftId);
    const draft = await readDraft(db, input.actor, input.draftId);
    const proposal = validateStoredStorefrontProposal(draft.content);
    const storedBefore = readStoredStorefrontCodeConfig(draft.before, "before");

    const source = await readDraftSaveApproval(
      db,
      input.actor,
      input.sourceApprovalId,
      input.draftId,
    );
    const sourceAudit = await readAudit(db, input.actor.storeId, source.id);
    if (
      !sourceAudit ||
      sourceAudit.outcome !== "executed" ||
      sourceAudit.resourceVersionAfter !== source.resultVersion
    ) {
      throw sourceConflict();
    }

    await lockPage(db, input.actor, source.resourceId);
    const page = await readPage(
      db,
      input.actor,
      source.resourceId,
      proposal.value.patch.target.sectionId,
    );
    assertDraftSaveMatchesPage({
      source,
      proposal: proposal.value,
      storedBefore,
      page,
    });
    const staticValidation = validateMinkStorefrontPublicationStatic(
      page.targetSection.config,
    );
    if (!staticValidation.passed) {
      throw new MinkRequestError(
        "mink_storefront_accessibility_failed",
        `The storefront code did not pass publication checks: ${staticValidation.issues.join(" ")}`,
        409,
      );
    }
    const browserValidation = readBrowserValidation(
      input.browserValidation,
      proposal.value.patchDigest,
    );
    const before = snapshot(page, "published", null);
    const after = snapshot(page, "draft", browserValidation);
    if (
      before.page_status === "published" &&
      before.sections_digest === after.sections_digest
    ) {
      throw new MinkRequestError(
        "mink_storefront_publication_no_change",
        "The live page already matches this exact Builder draft.",
        409,
      );
    }
    return createApproval(db, {
      actor: input.actor,
      draftId: input.draftId,
      sourceApprovalId: source.id,
      idempotencyKey: input.idempotencyKey,
      page,
      operation: "apply",
      before,
      after,
    });
  });
}

/** Create a fresh rollback approval from an exact completed publication audit. */
export async function previewMinkStorefrontPublicationRollback(input: {
  actor: MinkActorContext;
  draftId: string;
  sourceApprovalId: string;
  idempotencyKey: string;
}): Promise<MinkStorefrontPublicationApproval> {
  assertAuthority(input.actor);
  return withService(async (db) => {
    await assertToolEnabled(db, input.actor.storeId);
    await lockApproval(db, input.actor, input.sourceApprovalId);
    const source = await readPublicationApproval(
      db,
      input.actor,
      input.sourceApprovalId,
    );
    if (
      source.draftId !== input.draftId ||
      source.status !== "executed" ||
      source.operation !== "apply"
    ) {
      throw rollbackUnavailable();
    }
    const sourceAudit = await readAudit(db, input.actor.storeId, source.id);
    if (!sourceAudit || sourceAudit.outcome !== "executed") {
      throw rollbackUnavailable();
    }
    const sourceBefore = readSnapshot(sourceAudit.beforeJson, false, null);
    const sourceAfter = readSnapshot(sourceAudit.afterJson, false, null);
    await lockPage(db, input.actor, source.resourceId);
    const page = await readPage(
      db,
      input.actor,
      source.resourceId,
      sourceAfter.target_section_id,
    );
    const current = snapshot(page, "published", null);
    if (
      page.updatedAt !== sourceAudit.resourceVersionAfter ||
      !sameSnapshotState(current, sourceAfter)
    ) {
      throw targetConflict(
        "The live page changed after this Mink publication. Nothing was rolled back.",
      );
    }
    return createApproval(db, {
      actor: input.actor,
      draftId: input.draftId,
      sourceApprovalId: source.id,
      idempotencyKey: input.idempotencyKey,
      page,
      operation: "rollback",
      before: current,
      after: { ...sourceBefore, browser_validation: null },
    });
  });
}

/** Publish or roll back one exact page snapshot through an idempotent transaction. */
export async function executeMinkStorefrontPublication(input: {
  actor: MinkActorContext;
  draftId: string;
  approvalId: string;
}): Promise<MinkStorefrontPublicationResult> {
  assertAuthority(input.actor);
  const outcome = await withService(async (db) => {
    await lockApproval(db, input.actor, input.approvalId);
    const approval = await readPublicationApproval(
      db,
      input.actor,
      input.approvalId,
    );
    if (approval.draftId !== input.draftId) throw approvalNotFound();
    if (approval.status === "executed") {
      const audit = await readAudit(db, input.actor.storeId, approval.id);
      if (!audit || audit.outcome !== "executed") throw invalidApproval();
      return { result: resultFrom(approval, audit, true) };
    }
    if (approval.status !== "pending") {
      throw terminalApproval();
    }
    await assertToolEnabled(db, input.actor.storeId, true);
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      await finalizeWithoutWrite(
        db,
        approval,
        "expired",
        "Publication approval expired before execution.",
      );
      return { error: expiredApproval() };
    }

    const before = readSnapshot(approval.beforeJson, false);
    const after = readSnapshot(
      approval.afterJson,
      approval.operation === "apply",
      approval.operation === "apply" ? EXECUTION_BROWSER_MAX_AGE_MS : undefined,
    );
    if (approval.requestHash !== requestHash(approval, before, after)) {
      throw invalidApproval();
    }

    // Same canonical order as the preview paths above and as every other
    // action phase: approval rows, then the draft, then the page. Taking the
    // draft before the source approval here would deadlock against
    // `executeMinkStorefrontCodeAction`, which holds that approval while it
    // waits for the same draft.
    await lockApproval(db, input.actor, approval.sourceApprovalId);
    if (approval.operation === "apply") {
      await lockDraft(db, input.actor, approval.draftId);
    }
    await lockPage(db, input.actor, approval.resourceId);
    const page = await readPage(
      db,
      input.actor,
      approval.resourceId,
      before.target_section_id,
    );
    const current = snapshot(page, "published", null);
    if (
      page.updatedAt !== approval.resourceVersion ||
      !sameSnapshotState(current, before)
    ) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The exact live page changed after publication review.",
        page.updatedAt,
      );
      return { error: targetConflict() };
    }

    if (approval.operation === "apply") {
      const sourceOkay = await validateApplySource(
        db,
        input.actor,
        approval,
        page,
        after,
      );
      if (!sourceOkay) {
        await finalizeWithoutWrite(
          db,
          approval,
          "conflicted",
          "The Builder draft or its guarded save checkpoint changed before publication.",
          page.updatedAt,
        );
        return { error: sourceConflict() };
      }
    } else {
      const sourceOkay = await validateRollbackSource(
        db,
        input.actor,
        approval,
        before,
        after,
      );
      if (!sourceOkay) {
        await finalizeWithoutWrite(
          db,
          approval,
          "conflicted",
          "The publication rollback checkpoint is no longer exact.",
          page.updatedAt,
        );
        return { error: rollbackUnavailable() };
      }
    }

    const now = new Date().toISOString();
    const executedAfter: StoredPublicationSnapshot = {
      ...after,
      published_at: approval.operation === "apply" ? now : after.published_at,
    };
    const updated = await db
      .update(storePages)
      .set({
        publishedSections: executedAfter.sections,
        status: executedAfter.page_status,
        publishedAt: executedAfter.published_at,
        updatedBy: input.actor.adminId,
      })
      .where(
        and(
          eq(storePages.id, page.id),
          eq(storePages.storeId, input.actor.storeId),
          eq(storePages.updatedAt, approval.resourceVersion),
        ),
      )
      .returning({ id: storePages.id, updatedAt: storePages.updatedAt });
    if (!updated[0]) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The page changed during publication execution.",
      );
      return { error: targetConflict() };
    }
    const finalized = await db
      .update(minkActionApprovals)
      .set({
        status: "executed",
        approvedAt: now,
        executedAt: now,
        resultId: updated[0].id,
        resultVersion: updated[0].updatedAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(minkActionApprovals.id, approval.id),
          eq(minkActionApprovals.storeId, input.actor.storeId),
          eq(minkActionApprovals.status, "pending"),
        ),
      )
      .returning({ id: minkActionApprovals.id });
    if (!finalized[0]) throw invalidApproval();
    const auditId = crypto.randomUUID();
    await db.insert(minkActionAudit).values({
      id: auditId,
      approvalId: approval.id,
      storeId: approval.storeId,
      adminId: approval.adminId,
      draftId: approval.draftId,
      productId: null,
      resourceType: "storefront_page",
      resourceId: approval.resourceId,
      locationId: null,
      variantId: null,
      resourceVersionBefore: approval.resourceVersion,
      resourceVersionAfter: updated[0].updatedAt,
      resultId: updated[0].id,
      toolName: TOOL_NAME,
      operation: approval.operation,
      outcome: "executed",
      beforeJson: before,
      afterJson: executedAfter,
      productVersionBefore: null,
      productVersionAfter: null,
      requestHash: approval.requestHash,
      toolVersion: TOOL_VERSION,
      detail:
        approval.operation === "apply"
          ? "Exact checked Website Builder draft published after separate human approval."
          : "Exact prior published page snapshot restored after separate human rollback approval.",
    });
    return {
      result: resultFrom(
        {
          ...approval,
          status: "executed",
          approvedAt: now,
          executedAt: now,
          resultId: updated[0].id,
          resultVersion: updated[0].updatedAt,
        },
        {
          id: auditId,
          outcome: "executed",
          afterJson: executedAfter,
        } as AuditRow,
        false,
      ),
    };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

async function validateApplySource(
  db: Db,
  actor: MinkActorContext,
  approval: PublicationApprovalRow,
  page: PublicationPage,
  after: StoredPublicationSnapshot,
) {
  const draft = await readDraft(db, actor, approval.draftId);
  const proposal = validateStoredStorefrontProposal(draft.content);
  const storedBefore = readStoredStorefrontCodeConfig(draft.before, "before");
  const source = await readDraftSaveApproval(
    db,
    actor,
    approval.sourceApprovalId,
    approval.draftId,
  );
  const audit = await readAudit(db, actor.storeId, source.id);
  if (!audit || audit.outcome !== "executed") return false;
  try {
    assertDraftSaveMatchesPage({
      source,
      proposal: proposal.value,
      storedBefore,
      page,
    });
  } catch (error) {
    if (error instanceof MinkRequestError) return false;
    throw error;
  }
  const currentDraft = snapshot(page, "draft", after.browser_validation);
  const staticValidation = validateMinkStorefrontPublicationStatic(
    page.targetSection.config,
  );
  return (
    staticValidation.passed &&
    after.browser_validation?.patchDigest === proposal.value.patchDigest &&
    sameSnapshotState(currentDraft, after)
  );
}

async function validateRollbackSource(
  db: Db,
  actor: MinkActorContext,
  approval: PublicationApprovalRow,
  before: StoredPublicationSnapshot,
  after: StoredPublicationSnapshot,
) {
  const source = await readPublicationApproval(
    db,
    actor,
    approval.sourceApprovalId,
  );
  const audit = await readAudit(db, actor.storeId, source.id);
  if (
    source.status !== "executed" ||
    source.operation !== "apply" ||
    !audit ||
    audit.outcome !== "executed"
  ) {
    return false;
  }
  return (
    sameSnapshotState(before, readSnapshot(audit.afterJson, false, null)) &&
    sameSnapshotState(after, readSnapshot(audit.beforeJson, false, null))
  );
}

async function createApproval(
  db: Db,
  input: {
    actor: MinkActorContext;
    draftId: string;
    sourceApprovalId: string;
    idempotencyKey: string;
    page: PublicationPage;
    operation: "apply" | "rollback";
    before: StoredPublicationSnapshot;
    after: StoredPublicationSnapshot;
  },
) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const requestHashValue = hashMinkActionPayload({
    storeId: input.actor.storeId,
    adminId: input.actor.adminId,
    draftId: input.draftId,
    draftVersion: 0,
    sourceApprovalId: input.sourceApprovalId,
    operation: input.operation,
    resourceId: input.page.id,
    resourceVersion: input.page.updatedAt,
    before: input.before,
    after: input.after,
    toolVersion: TOOL_VERSION,
  });
  const inserted = await db
    .insert(minkActionApprovals)
    .values({
      id,
      storeId: input.actor.storeId,
      adminId: input.actor.adminId,
      draftId: input.draftId,
      productId: null,
      resourceType: "storefront_page",
      resourceId: input.page.id,
      resourceVersion: input.page.updatedAt,
      resourceLabel: `${input.page.title} · storefront page`,
      locationId: null,
      variantId: null,
      resultId: null,
      sourceApprovalId: input.sourceApprovalId,
      toolName: TOOL_NAME,
      operation: input.operation,
      draftVersion: 0,
      productVersion: null,
      beforeJson: input.before,
      afterJson: input.after,
      requestHash: requestHashValue,
      idempotencyKey: input.idempotencyKey,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  const approval = inserted[0]
    ? validatePublicationApproval(inserted[0])
    : await readByIdempotency(db, input.actor, input.idempotencyKey);
  if (approval.requestHash !== requestHashValue) {
    throw conflict(
      "mink_storefront_publication_idempotency_conflict",
      "This request key was already used for a different storefront publication review.",
    );
  }
  return toApproval(approval);
}

async function readDraft(db: Db, actor: MinkActorContext, draftId: string) {
  const rows = await db
    .select({
      id: minkDrafts.id,
      kind: minkDrafts.kind,
      status: minkDrafts.status,
      before: minkDrafts.beforeJson,
      content: minkDrafts.contentJson,
      currentVersion: minkDrafts.currentVersion,
    })
    .from(minkDrafts)
    .where(
      and(
        eq(minkDrafts.id, draftId),
        eq(minkDrafts.storeId, actor.storeId),
        eq(minkDrafts.adminId, actor.adminId),
      ),
    )
    .limit(1);
  const draft = rows[0];
  if (
    !draft ||
    draft.kind !== "storefront_custom_code" ||
    draft.status !== "proposed" ||
    draft.currentVersion !== 0
  ) {
    throw conflict(
      "mink_storefront_publication_draft_unavailable",
      "This immutable storefront proposal is not available for publication.",
    );
  }
  try {
    return {
      ...draft,
      // `before` is a copy of the merchant's existing section, so it is held
      // to its shape only — never to the generated-patch size ceiling.
      before: normalizeMinkDraftContent(
        "storefront_custom_code",
        draft.before,
        { historicalSnapshot: true },
      ),
      content: normalizeMinkDraftContent(
        "storefront_custom_code",
        draft.content,
      ),
    };
  } catch (error) {
    // A stored payload we cannot parse is a conflict to report, not an
    // unexplained 503 from the route's generic catch.
    throw conflict(
      "mink_storefront_publication_draft_invalid",
      error instanceof Error ? error.message : "Invalid storefront proposal.",
    );
  }
}

async function readPage(
  db: Db,
  actor: MinkActorContext,
  pageId: string,
  targetSectionId: string,
): Promise<PublicationPage> {
  const rows = await db
    .select({
      id: storePages.id,
      slug: storePages.slug,
      title: storePages.title,
      status: storePages.status,
      sections: storePages.sections,
      publishedSections: storePages.publishedSections,
      publishedAt: storePages.publishedAt,
      updatedAt: storePages.updatedAt,
      settings: stores.settings,
    })
    .from(storePages)
    .innerJoin(
      stores,
      and(eq(stores.id, storePages.storeId), eq(stores.id, actor.storeId)),
    )
    .where(
      and(eq(storePages.storeId, actor.storeId), eq(storePages.id, pageId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row || (row.status !== "draft" && row.status !== "published")) {
    throw targetConflict();
  }
  if (
    resolveStoreSettings(
      isRecord(row.settings) ? row.settings : {},
      actor.effectivePlan,
    )["pages.customCode"] !== true
  ) {
    throw new MinkRequestError(
      "mink_storefront_custom_code_disabled",
      "Custom code is not enabled for this store and plan.",
      403,
    );
  }
  const draft = validateSections(row.sections, { mode: "publish" });
  if ("error" in draft) {
    throw conflict(
      "mink_storefront_page_not_publishable",
      `The Builder draft is not publishable: ${draft.error}`,
    );
  }
  const sanitized = draft.sections.map((section) =>
    section.type === "rich_text"
      ? {
          ...section,
          config: {
            ...(section.config as RichTextConfig),
            html: sanitizeBlogContent((section.config as RichTextConfig).html),
          },
        }
      : section,
  );
  if (
    digestMinkStorefrontValue(sanitized) !==
    digestMinkStorefrontValue(draft.sections)
  ) {
    throw conflict(
      "mink_storefront_page_requires_builder_save",
      "The page contains rich text that needs to be normalized in Website Builder before Mink can publish it.",
    );
  }
  const published = validateSections(row.publishedSections, { mode: "draft" });
  if ("error" in published) {
    throw conflict(
      "mink_storefront_published_snapshot_invalid",
      "The current live page cannot be checkpointed safely. Publish it manually in Website Builder.",
    );
  }
  const target = draft.sections.find(
    (section) => section.id === targetSectionId,
  );
  if (!target || target.type !== "custom_code") throw targetConflict();
  return {
    id: row.id,
    slug: row.slug === "" ? "home" : row.slug,
    title: boundedTitle(row.title, row.slug || "Home"),
    status: row.status,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    sections: draft.sections,
    publishedSections: published.sections,
    targetSection: target as PublicationPage["targetSection"],
  };
}

function assertDraftSaveMatchesPage(input: {
  source: DraftSaveApprovalRow;
  proposal: ValidatedMinkStorefrontCodePatch;
  storedBefore: CustomCodeConfig;
  page: PublicationPage;
}) {
  const sourceAfter = readDraftSaveValues(input.source.afterJson);
  if (
    input.source.resultVersion !== input.page.updatedAt ||
    input.source.resultId !== input.page.id ||
    input.proposal.patch.target.pageSlug !== input.page.slug ||
    input.proposal.patch.target.sectionId !== input.page.targetSection.id ||
    sourceAfter.page_slug !== input.page.slug ||
    sourceAfter.section_id !== input.page.targetSection.id ||
    sourceAfter.section_digest !==
      digestMinkStorefrontValue(input.page.targetSection) ||
    hashMinkActionPayload(input.proposal.config) !==
      hashMinkActionPayload(input.page.targetSection.config) ||
    hashMinkActionPayload(input.storedBefore) ===
      hashMinkActionPayload(input.page.targetSection.config)
  ) {
    throw sourceConflict();
  }
}

function snapshot(
  page: PublicationPage,
  source: "draft" | "published",
  browserValidation: MinkStorefrontBrowserValidation | null,
): StoredPublicationSnapshot {
  const sections = source === "draft" ? page.sections : page.publishedSections;
  const target = sections.find(
    (section) => section.id === page.targetSection.id,
  );
  return {
    schema_version: 1,
    page_slug: page.slug,
    page_title: page.title,
    page_status: source === "draft" ? "published" : page.status,
    published_at: source === "draft" ? null : page.publishedAt,
    sections_digest: digestMinkStorefrontValue(sections),
    target_section_id: page.targetSection.id,
    target_section_digest: digestMinkStorefrontValue(target ?? null),
    sections,
    browser_validation: browserValidation,
  };
}

function readSnapshot(
  value: unknown,
  requireBrowserValidation: boolean,
  browserMaxAgeMs?: number | null,
): StoredPublicationSnapshot {
  if (!isRecord(value)) throw invalidApproval();
  const keys = [
    "schema_version",
    "page_slug",
    "page_title",
    "page_status",
    "published_at",
    "sections_digest",
    "target_section_id",
    "target_section_digest",
    "sections",
    "browser_validation",
  ];
  const sections = validateSections(value.sections, { mode: "draft" });
  const publishedAt = value.published_at;
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value)) ||
    value.schema_version !== 1 ||
    typeof value.page_slug !== "string" ||
    !/^(?:home|[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(value.page_slug) ||
    value.page_slug.length > 60 ||
    typeof value.page_title !== "string" ||
    value.page_title.length < 1 ||
    value.page_title.length > 120 ||
    (value.page_status !== "draft" && value.page_status !== "published") ||
    !(
      publishedAt === null ||
      (typeof publishedAt === "string" &&
        !Number.isNaN(Date.parse(publishedAt)))
    ) ||
    typeof value.sections_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sections_digest) ||
    typeof value.target_section_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.target_section_id) ||
    typeof value.target_section_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.target_section_digest) ||
    "error" in sections ||
    digestMinkStorefrontValue(sections.sections) !== value.sections_digest ||
    digestMinkStorefrontValue(
      sections.sections.find(
        (section) => section.id === value.target_section_id,
      ) ?? null,
    ) !== value.target_section_digest
  ) {
    throw invalidApproval();
  }
  let browserValidation: MinkStorefrontBrowserValidation | null = null;
  if (value.browser_validation !== null) {
    const proposalDigest = isRecord(value.browser_validation)
      ? String(value.browser_validation.patchDigest ?? "")
      : "";
    try {
      browserValidation = validateMinkStorefrontBrowserValidation({
        value: value.browser_validation,
        patchDigest: proposalDigest,
        maxAgeMs: browserMaxAgeMs ?? undefined,
        skipFreshness: browserMaxAgeMs === null,
      });
    } catch {
      throw invalidApproval();
    }
  }
  if (requireBrowserValidation && !browserValidation) throw invalidApproval();
  return {
    schema_version: 1,
    page_slug: value.page_slug,
    page_title: value.page_title,
    page_status: value.page_status,
    published_at: publishedAt,
    sections_digest: value.sections_digest,
    target_section_id: value.target_section_id,
    target_section_digest: value.target_section_digest,
    sections: sections.sections,
    browser_validation: browserValidation,
  };
}

function sameSnapshotState(
  left: StoredPublicationSnapshot,
  right: StoredPublicationSnapshot,
) {
  return (
    left.page_slug === right.page_slug &&
    left.page_title === right.page_title &&
    left.page_status === right.page_status &&
    samePublicationTime(left.published_at, right.published_at) &&
    left.sections_digest === right.sections_digest &&
    left.target_section_id === right.target_section_id &&
    left.target_section_digest === right.target_section_digest &&
    hashMinkActionPayload(left.sections) ===
      hashMinkActionPayload(right.sections)
  );
}

// PostgreSQL returns timestamp text with a space and UTC offset, whereas the
// execution audit records ISO text. Compare instants without rewriting the
// stored snapshot: rollback must preserve its original microsecond precision.
function samePublicationTime(left: string | null, right: string | null) {
  if (left === null || right === null) return left === right;
  const subMilliseconds = (value: string) =>
    (/[T ]\d{2}:\d{2}:\d{2}\.(\d+)/.exec(value)?.[1] ?? "")
      .padEnd(6, "0")
      .slice(3, 6);
  return (
    Date.parse(left) === Date.parse(right) &&
    subMilliseconds(left) === subMilliseconds(right)
  );
}

function readBrowserValidation(value: unknown, patchDigest: string) {
  try {
    return validateMinkStorefrontBrowserValidation({ value, patchDigest });
  } catch (error) {
    throw new MinkRequestError(
      "mink_storefront_browser_validation_failed",
      error instanceof Error
        ? error.message
        : "Desktop and mobile browser validation did not pass.",
      409,
    );
  }
}

function readDraftSaveValues(value: unknown) {
  if (!isRecord(value)) throw sourceConflict();
  const config = validateSections(
    [
      {
        id: value.section_id,
        type: "custom_code",
        enabled: true,
        config: {
          html: value.html,
          css: value.css,
          js: value.js,
          height_mode: value.height_mode,
          fixed_height: Number(value.fixed_height),
        },
      },
    ],
    { mode: "draft" },
  );
  if (
    "error" in config ||
    typeof value.page_slug !== "string" ||
    typeof value.section_id !== "string" ||
    typeof value.section_digest !== "string"
  ) {
    throw sourceConflict();
  }
  return {
    page_slug: value.page_slug,
    section_id: value.section_id,
    section_digest: value.section_digest,
  };
}

function toApproval(
  row: PublicationApprovalRow,
  auditedAfter?: unknown,
): MinkStorefrontPublicationApproval {
  const before = readSnapshot(row.beforeJson, false);
  const after = readSnapshot(
    auditedAfter ?? row.afterJson,
    row.operation === "apply",
    null,
  );
  const browser = after.browser_validation;
  return {
    id: row.id,
    sourceApprovalId: row.sourceApprovalId,
    toolName: TOOL_NAME,
    operation: row.operation,
    status: row.status,
    draftId: row.draftId,
    draftVersion: 0,
    resource: {
      type: "storefront_page",
      id: row.resourceId,
      label: row.resourceLabel ?? `${before.page_title} · storefront page`,
      dashboardPath: `/dashboard/builder?page=${encodeURIComponent(before.page_slug)}&section=${encodeURIComponent(before.target_section_id)}`,
      publicPath: before.page_slug === "home" ? "/" : `/${before.page_slug}`,
    },
    before: publicValues(before),
    after: publicValues(after),
    checks: {
      staticChecksPassed: true,
      browserChecksPassed: row.operation === "rollback" || Boolean(browser),
      desktopWidth: browser?.viewports.desktop.width ?? 0,
      mobileWidth: browser?.viewports.mobile.width ?? 0,
      browserFamily: browser?.browser.family ?? null,
      browserMajor: browser?.browser.major ?? null,
    },
    expiresAt: row.expiresAt,
    executedAt: row.executedAt,
  };
}

function publicValues(
  value: StoredPublicationSnapshot,
): MinkStorefrontPublicationValues {
  return {
    page_slug: value.page_slug,
    page_title: value.page_title,
    page_status: value.page_status,
    published_at: value.published_at,
    sections_digest: value.sections_digest,
    target_section_id: value.target_section_id,
    target_section_digest: value.target_section_digest,
  };
}

function resultFrom(
  approval: PublicationApprovalRow,
  audit: Pick<AuditRow, "id" | "afterJson">,
  repeated: boolean,
): MinkStorefrontPublicationResult {
  return {
    approval: toApproval(approval, audit.afterJson),
    auditId: audit.id,
    repeated,
  };
}

function validatePublicationApproval(
  row: typeof minkActionApprovals.$inferSelect,
): PublicationApprovalRow {
  if (
    row.toolName !== TOOL_NAME ||
    (row.operation !== "apply" && row.operation !== "rollback") ||
    !["pending", "executed", "conflicted", "expired", "cancelled"].includes(
      row.status,
    ) ||
    row.resourceType !== "storefront_page" ||
    row.draftVersion !== 0 ||
    !row.resourceId ||
    !row.resourceVersion ||
    !row.sourceApprovalId ||
    row.productId ||
    row.locationId ||
    row.variantId ||
    (row.status === "executed" &&
      (!row.resultId ||
        row.resultId !== row.resourceId ||
        !row.resultVersion ||
        !row.approvedAt ||
        !row.executedAt)) ||
    (row.status !== "executed" && (row.resultId || row.resultVersion))
  ) {
    throw invalidApproval();
  }
  readSnapshot(row.beforeJson, false);
  readSnapshot(row.afterJson, row.operation === "apply", null);
  return row as PublicationApprovalRow;
}

async function readDraftSaveApproval(
  db: Db,
  actor: MinkActorContext,
  id: string,
  draftId: string,
): Promise<DraftSaveApprovalRow> {
  const rows = await db
    .select()
    .from(minkActionApprovals)
    .where(
      and(
        eq(minkActionApprovals.id, id),
        eq(minkActionApprovals.storeId, actor.storeId),
        eq(minkActionApprovals.adminId, actor.adminId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (
    !row ||
    row.draftId !== draftId ||
    row.toolName !== "apply_storefront_code" ||
    row.operation !== "apply" ||
    row.status !== "executed" ||
    row.resourceType !== "storefront_section" ||
    row.draftVersion !== 0 ||
    !row.resourceId ||
    !row.resourceVersion ||
    row.resultId !== row.resourceId ||
    !row.resultVersion ||
    row.sourceApprovalId ||
    row.productId ||
    row.locationId ||
    row.variantId
  ) {
    throw sourceConflict();
  }
  readDraftSaveValues(row.afterJson);
  return row as DraftSaveApprovalRow;
}

async function readPublicationApproval(
  db: Db,
  actor: MinkActorContext,
  id: string,
) {
  const rows = await db
    .select()
    .from(minkActionApprovals)
    .where(
      and(
        eq(minkActionApprovals.id, id),
        eq(minkActionApprovals.storeId, actor.storeId),
        eq(minkActionApprovals.adminId, actor.adminId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw approvalNotFound();
  return validatePublicationApproval(rows[0]);
}

async function readByIdempotency(
  db: Db,
  actor: MinkActorContext,
  idempotencyKey: string,
) {
  const rows = await db
    .select()
    .from(minkActionApprovals)
    .where(
      and(
        eq(minkActionApprovals.storeId, actor.storeId),
        eq(minkActionApprovals.adminId, actor.adminId),
        eq(minkActionApprovals.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (!rows[0]) throw approvalNotFound();
  return validatePublicationApproval(rows[0]);
}

async function readAudit(db: Db, storeId: string, approvalId: string) {
  const rows = await db
    .select()
    .from(minkActionAudit)
    .where(
      and(
        eq(minkActionAudit.storeId, storeId),
        eq(minkActionAudit.approvalId, approvalId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function finalizeWithoutWrite(
  db: Db,
  approval: PublicationApprovalRow,
  status: "conflicted" | "expired",
  detail: string,
  resourceVersionAfter: string | null = null,
) {
  await db
    .update(minkActionApprovals)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(minkActionApprovals.id, approval.id),
        eq(minkActionApprovals.storeId, approval.storeId),
      ),
    );
  await db.insert(minkActionAudit).values({
    id: crypto.randomUUID(),
    approvalId: approval.id,
    storeId: approval.storeId,
    adminId: approval.adminId,
    draftId: approval.draftId,
    productId: null,
    resourceType: "storefront_page",
    resourceId: approval.resourceId,
    locationId: null,
    variantId: null,
    resourceVersionBefore: approval.resourceVersion,
    resourceVersionAfter,
    resultId: null,
    toolName: TOOL_NAME,
    operation: approval.operation,
    outcome: status,
    beforeJson: readSnapshot(approval.beforeJson, false),
    afterJson: readSnapshot(
      approval.afterJson,
      approval.operation === "apply",
      null,
    ),
    productVersionBefore: null,
    productVersionAfter: null,
    requestHash: approval.requestHash,
    toolVersion: TOOL_VERSION,
    detail,
  });
}

async function assertToolEnabled(db: Db, storeId: string, lock = false) {
  if (lock) {
    const result = await db.execute(sql`
      select enabled from public.mink_action_tool_access
      where store_id = ${storeId}::uuid and tool_name = ${TOOL_NAME}
      for update
    `);
    if ((result.rows[0] as { enabled?: boolean } | undefined)?.enabled) return;
  } else {
    const rows = await db
      .select({ enabled: minkActionToolAccess.enabled })
      .from(minkActionToolAccess)
      .where(
        and(
          eq(minkActionToolAccess.storeId, storeId),
          eq(minkActionToolAccess.toolName, TOOL_NAME),
        ),
      )
      .limit(1);
    if (rows[0]?.enabled) return;
  }
  throw new MinkRequestError(
    "mink_storefront_publication_disabled",
    "StoreMink support has not enabled Mink storefront publication for this store.",
    403,
  );
}

function assertAuthority(actor: MinkActorContext) {
  if (
    !actor.draftingEnabled ||
    !can(actor.permissions, "builder", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_storefront_publication_access_denied",
      "You do not have permission to publish Website Builder pages through Mink.",
      403,
    );
  }
}

async function lockDraft(db: Db, actor: MinkActorContext, draftId: string) {
  await db.execute(sql`
    select id from public.mink_drafts
    where id = ${draftId}::uuid and store_id = ${actor.storeId}::uuid
      and admin_id = ${actor.adminId}
    for update
  `);
}

async function lockApproval(
  db: Db,
  actor: MinkActorContext,
  approvalId: string,
) {
  await db.execute(sql`
    select id from public.mink_action_approvals
    where id = ${approvalId}::uuid and store_id = ${actor.storeId}::uuid
      and admin_id = ${actor.adminId}
    for update
  `);
}

async function lockPage(db: Db, actor: MinkActorContext, pageId: string) {
  await db.execute(sql`
    select id from public.store_pages
    where id = ${pageId}::uuid and store_id = ${actor.storeId}::uuid
    for update
  `);
}

function requestHash(
  approval: PublicationApprovalRow,
  before: StoredPublicationSnapshot,
  after: StoredPublicationSnapshot,
) {
  return hashMinkActionPayload({
    storeId: approval.storeId,
    adminId: approval.adminId,
    draftId: approval.draftId,
    draftVersion: 0,
    sourceApprovalId: approval.sourceApprovalId,
    operation: approval.operation,
    resourceId: approval.resourceId,
    resourceVersion: approval.resourceVersion,
    before,
    after,
    toolVersion: TOOL_VERSION,
  });
}

function invalidApproval() {
  return new MinkRequestError(
    "mink_storefront_publication_approval_invalid",
    "This storefront publication approval failed integrity validation. Create a new review.",
    409,
  );
}

function approvalNotFound() {
  return new MinkRequestError(
    "mink_storefront_publication_approval_not_found",
    "This storefront publication approval is unavailable.",
    404,
  );
}

function sourceConflict() {
  return conflict(
    "mink_storefront_publication_source_conflict",
    "The guarded Builder draft save or exact draft changed. Run the checks again.",
  );
}

function targetConflict(
  message = "The live storefront page changed. Nothing was published or rolled back.",
) {
  return conflict("mink_storefront_publication_target_conflict", message);
}

function rollbackUnavailable() {
  return conflict(
    "mink_storefront_publication_rollback_unavailable",
    "This publication no longer has an exact rollback checkpoint.",
  );
}

function expiredApproval() {
  return conflict(
    "mink_storefront_publication_approval_expired",
    "This publication approval expired. Run the checks and review the latest page again.",
  );
}

function terminalApproval() {
  return conflict(
    "mink_storefront_publication_approval_terminal",
    "This storefront publication approval is no longer available.",
  );
}

function conflict(code: string, message: string) {
  return new MinkRequestError(code, message, 409);
}

function boundedTitle(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  const normalized = value.normalize("NFKC").trim();
  return normalized ? normalized.slice(0, 120) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
