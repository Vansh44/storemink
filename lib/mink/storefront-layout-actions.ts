import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  minkActionApprovals,
  minkActionAudit,
  minkActionToolAccess,
  minkDrafts,
  storePages,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import {
  validateSections,
  type PageSectionItem,
} from "@/lib/sections/registry";
import { hashMinkActionPayload } from "./action-integrity";
import { normalizeMinkDraftContent } from "./draft-types";
import { MinkRequestError } from "./errors";
import {
  assertLayoutPreservesCustomCode,
  digestMinkStorefrontSections,
  summarizeLayoutChange,
} from "./storefront-layout-contract";
import {
  readStoredLayoutSections,
  validateStoredLayoutProposal,
} from "./storefront-layout-proposals";
import {
  assertLayoutMediaIsOwned,
  collectSectionMediaUrls,
} from "./storefront-media-policy";
import { selectOwnedMediaUrls } from "./storefront-media-read";
import type {
  MinkStorefrontLayoutActionApproval,
  MinkStorefrontLayoutActionResult,
  MinkStorefrontLayoutActionValues,
} from "./storefront-layout-action-types";
import type { MinkActorContext, MinkStorefrontLayoutSummary } from "./types";

// ---------------------------------------------------------------------------
// Phase 9B - saving one approved section list to the private Builder draft.
//
// It mirrors Phase 7C step for step, and the two differences are the ones
// worth stating:
//
//   1. NO `pages.customCode` GATE. 7C writes merchant HTML/CSS/JS, which that
//      entitlement exists to govern. A hero or a gallery is neither, and it is
//      rendered by our own components -- so requiring the setting would
//      withhold ordinary layout editing from the majority of stores, for which
//      it is off by default.
//   2. THE APPROVAL CARRIES DIGESTS, NOT THE LISTS. See the action-types file.
//
// `published_sections`, `status` and `published_at` are absent from this
// transaction and from this API, exactly as in 7C: this saves a DRAFT.
// ---------------------------------------------------------------------------

const APPROVAL_TTL_MS = 5 * 60 * 1_000;
const TOOL_NAME = "apply_storefront_layout" as const;
const TOOL_VERSION = 1;

type ApprovalRow = typeof minkActionApprovals.$inferSelect & {
  toolName: typeof TOOL_NAME;
  operation: "apply";
  status: "pending" | "executed" | "conflicted" | "expired" | "cancelled";
  resourceType: "storefront_page";
  resourceId: string;
  resourceVersion: string;
};

interface LayoutTarget {
  id: string;
  slug: string;
  title: string;
  updatedAt: string;
  sections: PageSectionItem[];
  sectionsDigest: string;
}

/** Read the latest completed draft save, for a restored conversation card. */
export async function getLatestMinkStorefrontLayoutAction(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkStorefrontLayoutActionResult | null> {
  return withService(async (db) => {
    assertAuthority(actor);
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
    const approval = validateApproval(rows[0]);
    const audit = await readAudit(db, actor.storeId, approval.id);
    if (!audit) throw invalidApproval();
    const draft = await readDraft(db, actor, approval.draftId);
    return {
      approval: toApproval(approval, summaryFor(draft)),
      auditId: audit.id,
      repeated: true,
    };
  });
}

/** Create a fresh, idempotent approval against the exact current Builder draft. */
export async function previewMinkStorefrontLayoutAction(input: {
  actor: MinkActorContext;
  draftId: string;
  expectedDraftVersion: number;
  idempotencyKey: string;
}): Promise<MinkStorefrontLayoutActionApproval> {
  return withService(async (db) => {
    assertAuthority(input.actor);
    await lockDraft(db, input.actor, input.draftId);
    const draft = await readDraft(db, input.actor, input.draftId);
    if (draft.currentVersion !== input.expectedDraftVersion) {
      throw draftConflict();
    }
    await assertToolEnabled(db, input.actor.storeId);

    const target = await readTargetBySlug(
      db,
      input.actor,
      draft.proposal.target.pageSlug,
    );
    assertProposalMatchesTarget(draft, target);

    return createApproval(db, {
      actor: input.actor,
      draftId: draft.id,
      draftVersion: draft.currentVersion,
      target,
      before: values(target, target.sections, target.sectionsDigest),
      after: values(
        target,
        draft.proposal.sections,
        digestMinkStorefrontSections(draft.proposal.sections),
      ),
      summary: summaryFor(draft),
      idempotencyKey: input.idempotencyKey,
    });
  });
}

/**
 * Save one approved section list to store_pages.sections.
 *
 * Every recheck 7C performs is performed here: tenant, drafting, Builder
 * Manage, the operator tool gate (locked), approval status and expiry, the
 * draft version, the canonical request hash, the exact page version and the
 * digest of both lists. A replay of an executed approval returns the original
 * result; anything that moved underneath finalizes without a write.
 */
export async function executeMinkStorefrontLayoutAction(input: {
  actor: MinkActorContext;
  draftId: string;
  approvalId: string;
}): Promise<MinkStorefrontLayoutActionResult> {
  const outcome = await withService(async (db) => {
    assertAuthority(input.actor);
    await lockApproval(db, input.actor, input.approvalId);
    const approval = await readApproval(db, input.actor, input.approvalId);
    if (approval.draftId !== input.draftId) throw approvalNotFound();

    if (approval.status === "executed") {
      const audit = await readAudit(db, input.actor.storeId, approval.id);
      if (!audit) throw invalidApproval();
      const executedDraft = await readDraft(db, input.actor, approval.draftId);
      return {
        result: {
          approval: toApproval(approval, summaryFor(executedDraft)),
          auditId: audit.id,
          repeated: true,
        },
      };
    }
    if (approval.status !== "pending") {
      throw conflict(
        "mink_storefront_layout_approval_terminal",
        "This layout approval is no longer available.",
      );
    }
    await assertToolEnabled(db, input.actor.storeId, true);
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      await finalizeWithoutWrite(
        db,
        approval,
        "expired",
        "Approval expired before the Builder draft save.",
      );
      return {
        error: conflict(
          "mink_storefront_layout_approval_expired",
          "This approval expired. Review the latest Builder draft and create a new approval.",
        ),
      };
    }

    await lockDraft(db, input.actor, approval.draftId);
    let draft: LayoutDraft;
    try {
      draft = await readDraft(db, input.actor, approval.draftId);
    } catch (error) {
      if (!(error instanceof MinkRequestError)) throw error;
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The saved layout proposal failed integrity validation.",
      );
      return { error: draftConflict() };
    }

    const approvedBefore = valuesFromJson(approval.beforeJson);
    const approvedAfter = valuesFromJson(approval.afterJson);
    if (
      approval.requestHash !==
      requestHash(approval, approvedBefore, approvedAfter)
    ) {
      throw invalidApproval();
    }
    if (
      draft.currentVersion !== approval.draftVersion ||
      draft.proposal.target.pageSlug !== approvedBefore.page_slug ||
      draft.proposal.target.expectedPageVersion !== approval.resourceVersion ||
      draft.proposal.target.expectedSectionsDigest !==
        approvedBefore.sections_digest ||
      digestMinkStorefrontSections(draft.proposal.sections) !==
        approvedAfter.sections_digest
    ) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The saved layout proposal changed after approval preview.",
      );
      return { error: draftConflict() };
    }

    await lockPage(db, input.actor, approval.resourceId);
    let target: LayoutTarget;
    try {
      target = await readTargetById(db, input.actor, approval.resourceId);
    } catch (error) {
      if (!(error instanceof MinkRequestError)) throw error;
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The exact Website Builder page is no longer available.",
        null,
      );
      return { error: targetConflict() };
    }
    const currentValues = values(
      target,
      target.sections,
      target.sectionsDigest,
    );
    if (
      target.updatedAt !== approval.resourceVersion ||
      hashMinkActionPayload(currentValues) !==
        hashMinkActionPayload(approvedBefore)
    ) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The Website Builder page changed after preview.",
        target.updatedAt,
      );
      return { error: targetConflict() };
    }
    // ★ RE-RUN, even though the digest above already proves the page has not
    //   moved. It costs one pass over a bounded list, and it is the check that
    //   stands between an approved layout and a merchant's own custom code
    //   being silently dropped or edited -- the one thing this path must never
    //   do. A guard worth having is worth having on the write side too.
    const codeIssues = assertLayoutPreservesCustomCode(
      draft.proposal.sections,
      target.sections,
    );
    if (codeIssues.length > 0) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The approved layout no longer preserves the page's custom code.",
        target.updatedAt,
      );
      return { error: targetConflict() };
    }

    // ★ AND THE IMAGES AGAIN, UNDER THE SAME TRANSACTION. The page digest
    //   above proves the page has not moved, so the only thing that can have
    //   changed since the preview is the MEDIA LIBRARY -- an asset deleted
    //   between approval and execution would otherwise be written live as a
    //   broken image. `db` is threaded in deliberately: a second connection
    //   would answer about a library this write is not protected against.
    const onPage = new Set(collectSectionMediaUrls(target.sections));
    const candidates = [
      ...new Set(
        collectSectionMediaUrls(draft.proposal.sections).filter(
          (url) => !onPage.has(url),
        ),
      ),
    ];
    const owned = await selectOwnedMediaUrls(
      db,
      input.actor.storeId,
      candidates,
    );
    const mediaIssues = assertLayoutMediaIsOwned(draft.proposal.sections, [
      ...onPage,
      ...owned,
    ]);
    if (mediaIssues.length > 0) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "An image in the approved layout is no longer in this store's Media Library.",
        target.updatedAt,
      );
      return { error: targetConflict() };
    }

    const now = new Date().toISOString();
    const updated = await db
      .update(storePages)
      .set({
        sections: draft.proposal.sections,
        updatedBy: input.actor.adminId,
      })
      .where(
        and(
          eq(storePages.id, target.id),
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
        "The Website Builder page changed during execution.",
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

    const summary = summaryFor(draft);
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
      operation: "apply",
      outcome: "executed",
      beforeJson: approvedBefore,
      afterJson: approvedAfter,
      productVersionBefore: null,
      productVersionAfter: null,
      requestHash: approval.requestHash,
      toolVersion: TOOL_VERSION,
      detail: auditDetail(summary),
    });

    return {
      result: {
        approval: toApproval(
          {
            ...approval,
            status: "executed",
            approvedAt: now,
            executedAt: now,
            resultId: updated[0].id,
            resultVersion: updated[0].updatedAt,
          },
          summary,
        ),
        auditId,
        repeated: false,
      },
    };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

// ---------------------------------------------------------------------------

interface LayoutDraft {
  id: string;
  currentVersion: number;
  original: PageSectionItem[];
  proposal: ReturnType<typeof validateStoredLayoutProposal>;
}

function summaryFor(draft: LayoutDraft): MinkStorefrontLayoutSummary {
  return summarizeLayoutChange(draft.proposal.sections, draft.original);
}

/** One sentence for the append-only audit row; never model-authored text. */
function auditDetail(summary: MinkStorefrontLayoutSummary): string {
  const parts = [
    `${summary.added.length} added`,
    `${summary.removed.length} removed`,
    `${summary.kept.length} kept`,
  ];
  if (summary.reordered) parts.push("order changed");
  return `Approved section list saved to the private Website Builder draft (${parts.join(", ")}); publication state was not changed.`;
}

async function createApproval(
  db: Db,
  input: {
    actor: MinkActorContext;
    draftId: string;
    draftVersion: number;
    target: LayoutTarget;
    before: MinkStorefrontLayoutActionValues;
    after: MinkStorefrontLayoutActionValues;
    summary: MinkStorefrontLayoutSummary;
    idempotencyKey: string;
  },
) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const hash = hashMinkActionPayload({
    storeId: input.actor.storeId,
    adminId: input.actor.adminId,
    draftId: input.draftId,
    draftVersion: input.draftVersion,
    resourceId: input.target.id,
    resourceVersion: input.target.updatedAt,
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
      resourceId: input.target.id,
      resourceVersion: input.target.updatedAt,
      resourceLabel: `${input.target.title} · layout`,
      locationId: null,
      variantId: null,
      resultId: null,
      sourceApprovalId: null,
      toolName: TOOL_NAME,
      operation: "apply",
      draftVersion: input.draftVersion,
      productVersion: null,
      beforeJson: input.before,
      afterJson: input.after,
      requestHash: hash,
      idempotencyKey: input.idempotencyKey,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0]
    ? validateApproval(inserted[0])
    : await readByIdempotency(db, input.actor, input.idempotencyKey);
  if (row.requestHash !== hash) {
    throw conflict(
      "mink_storefront_layout_idempotency_conflict",
      "This approval request key was already used for a different layout preview.",
    );
  }
  return toApproval(row, input.summary);
}

async function readDraft(
  db: Db,
  actor: MinkActorContext,
  draftId: string,
): Promise<LayoutDraft> {
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
    draft.kind !== "storefront_layout" ||
    draft.status !== "proposed" ||
    draft.currentVersion !== 0
  ) {
    throw new MinkRequestError(
      "mink_storefront_layout_draft_unavailable",
      "This private layout proposal is not available for approval.",
      409,
    );
  }
  try {
    return {
      id: draft.id,
      currentVersion: draft.currentVersion,
      // The merchant's own prior layout: a snapshot, held only to its shape.
      original: readStoredLayoutSections(
        normalizeMinkDraftContent("storefront_layout", draft.before, {
          historicalSnapshot: true,
        }),
        "draft",
      ),
      proposal: validateStoredLayoutProposal(
        normalizeMinkDraftContent("storefront_layout", draft.content),
      ),
    };
  } catch (error) {
    throw new MinkRequestError(
      "mink_storefront_layout_draft_invalid",
      error instanceof Error ? error.message : "Invalid layout proposal.",
      400,
    );
  }
}

async function readTargetBySlug(
  db: Db,
  actor: MinkActorContext,
  pageSlug: string,
) {
  const storedSlug = pageSlug === "home" ? "" : pageSlug;
  const rows = await db
    .select({
      id: storePages.id,
      slug: storePages.slug,
      title: storePages.title,
      sections: storePages.sections,
      updatedAt: storePages.updatedAt,
    })
    .from(storePages)
    .where(
      and(
        eq(storePages.storeId, actor.storeId),
        eq(storePages.slug, storedSlug),
      ),
    )
    .limit(1);
  return normalizeTarget(rows[0]);
}

async function readTargetById(db: Db, actor: MinkActorContext, pageId: string) {
  const rows = await db
    .select({
      id: storePages.id,
      slug: storePages.slug,
      title: storePages.title,
      sections: storePages.sections,
      updatedAt: storePages.updatedAt,
    })
    .from(storePages)
    .where(
      and(eq(storePages.storeId, actor.storeId), eq(storePages.id, pageId)),
    )
    .limit(1);
  return normalizeTarget(rows[0]);
}

function normalizeTarget(
  row:
    | {
        id: string;
        slug: string;
        title: string;
        sections: unknown;
        updatedAt: string;
      }
    | undefined,
): LayoutTarget {
  if (!row) throw targetConflict();
  const validated = validateSections(row.sections, { mode: "draft" });
  if ("error" in validated) {
    throw conflict(
      "mink_storefront_layout_page_invalid",
      "The Builder draft is invalid. Repair it in Website Builder before applying this proposal.",
    );
  }
  return {
    id: row.id,
    slug: row.slug === "" ? "home" : row.slug,
    title: boundedTitle(row.title, row.slug || "Home"),
    updatedAt: row.updatedAt,
    sections: validated.sections,
    sectionsDigest: digestMinkStorefrontSections(validated.sections),
  };
}

function assertProposalMatchesTarget(draft: LayoutDraft, target: LayoutTarget) {
  if (
    target.slug !== draft.proposal.target.pageSlug ||
    target.updatedAt !== draft.proposal.target.expectedPageVersion ||
    target.sectionsDigest !== draft.proposal.target.expectedSectionsDigest ||
    digestMinkStorefrontSections(draft.original) !== target.sectionsDigest
  ) {
    throw targetConflict();
  }
}

function values(
  target: LayoutTarget,
  sections: PageSectionItem[],
  sectionsDigest: string,
): MinkStorefrontLayoutActionValues {
  return {
    page_slug: target.slug,
    page_title: target.title,
    sections_digest: sectionsDigest,
    section_count: String(sections.length),
  };
}

function valuesFromJson(value: unknown): MinkStorefrontLayoutActionValues {
  const keys = [
    "page_slug",
    "page_title",
    "sections_digest",
    "section_count",
  ] as const;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => typeof value[key] !== "string") ||
    !/^(?:home|[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(String(value.page_slug)) ||
    String(value.page_slug).length > 60 ||
    String(value.page_title).length < 1 ||
    String(value.page_title).length > 120 ||
    !/^[a-f0-9]{64}$/.test(String(value.sections_digest)) ||
    !/^(?:0|[1-9][0-9]{0,3})$/.test(String(value.section_count))
  ) {
    throw invalidApproval();
  }
  return value as unknown as MinkStorefrontLayoutActionValues;
}

function toApproval(
  row: ApprovalRow,
  summary: MinkStorefrontLayoutSummary,
): MinkStorefrontLayoutActionApproval {
  const before = valuesFromJson(row.beforeJson);
  return {
    id: row.id,
    sourceApprovalId: null,
    toolName: TOOL_NAME,
    operation: "apply",
    status: row.status,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    resource: {
      type: "storefront_page",
      id: row.resourceId,
      label: row.resourceLabel ?? `${before.page_title} · layout`,
      dashboardPath: `/dashboard/builder?page=${encodeURIComponent(before.page_slug)}`,
    },
    before,
    after: valuesFromJson(row.afterJson),
    summary,
    expiresAt: row.expiresAt,
    executedAt: row.executedAt,
  };
}

function validateApproval(
  row: typeof minkActionApprovals.$inferSelect,
): ApprovalRow {
  if (
    row.toolName !== TOOL_NAME ||
    row.operation !== "apply" ||
    !["pending", "executed", "conflicted", "expired", "cancelled"].includes(
      row.status,
    ) ||
    row.resourceType !== "storefront_page" ||
    row.draftVersion !== 0 ||
    !row.resourceId ||
    !row.resourceVersion ||
    row.productId ||
    row.locationId ||
    row.variantId ||
    row.sourceApprovalId ||
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
  valuesFromJson(row.beforeJson);
  valuesFromJson(row.afterJson);
  return row as ApprovalRow;
}

async function assertToolEnabled(db: Db, storeId: string, lock = false) {
  if (lock) {
    const result = await db.execute(sql`
      select enabled from public.mink_action_tool_access
      where store_id = ${storeId}::uuid
        and tool_name = 'apply_storefront_layout'
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
    "mink_storefront_layout_tool_disabled",
    "StoreMink support has not enabled Mink Website Builder layout saves for this store.",
    403,
  );
}

function assertAuthority(actor: MinkActorContext) {
  if (
    !actor.draftingEnabled ||
    !can(actor.permissions, "builder", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_storefront_layout_access_denied",
      "You do not have permission to save Website Builder layouts through Mink.",
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

async function readApproval(db: Db, actor: MinkActorContext, id: string) {
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
  return validateApproval(rows[0]);
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
  return validateApproval(rows[0]);
}

async function readAudit(db: Db, storeId: string, approvalId: string) {
  const rows = await db
    .select({ id: minkActionAudit.id })
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
  approval: ApprovalRow,
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
    operation: "apply",
    outcome: status,
    beforeJson: valuesFromJson(approval.beforeJson),
    afterJson: valuesFromJson(approval.afterJson),
    productVersionBefore: null,
    productVersionAfter: null,
    requestHash: approval.requestHash,
    toolVersion: TOOL_VERSION,
    detail,
  });
}

function requestHash(
  approval: ApprovalRow,
  before: MinkStorefrontLayoutActionValues,
  after: MinkStorefrontLayoutActionValues,
) {
  return hashMinkActionPayload({
    storeId: approval.storeId,
    adminId: approval.adminId,
    draftId: approval.draftId,
    draftVersion: approval.draftVersion,
    resourceId: approval.resourceId,
    resourceVersion: approval.resourceVersion,
    before,
    after,
    toolVersion: TOOL_VERSION,
  });
}

function invalidApproval() {
  return new MinkRequestError(
    "mink_storefront_layout_approval_invalid",
    "This layout approval failed integrity validation. Create a new preview.",
    409,
  );
}

function approvalNotFound() {
  return new MinkRequestError(
    "mink_storefront_layout_approval_not_found",
    "This layout approval is unavailable.",
    404,
  );
}

function draftConflict() {
  return conflict(
    "mink_storefront_layout_draft_conflict",
    "The saved layout proposal changed. Review the latest proposal again.",
  );
}

function targetConflict() {
  return conflict(
    "mink_storefront_layout_target_conflict",
    "The Website Builder page changed. Nothing was saved; generate a fresh layout from the latest Builder draft.",
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
