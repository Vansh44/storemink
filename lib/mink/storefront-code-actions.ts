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
import {
  validateSections,
  type CustomCodeConfig,
  type PageSectionItem,
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
import type {
  MinkStorefrontCodeActionApproval,
  MinkStorefrontCodeActionResult,
  MinkStorefrontCodeActionValues,
} from "./storefront-code-action-types";
import type { MinkActorContext } from "./types";

const APPROVAL_TTL_MS = 5 * 60 * 1_000;
const TOOL_VERSION = 1;

type ApprovalRow = typeof minkActionApprovals.$inferSelect & {
  toolName: "apply_storefront_code";
  operation: "apply";
  status: "pending" | "executed" | "conflicted" | "expired" | "cancelled";
  resourceType: "storefront_section";
  resourceId: string;
  resourceVersion: string;
};

type StorefrontTarget = {
  id: string;
  slug: string;
  title: string;
  updatedAt: string;
  sections: PageSectionItem[];
  sectionIndex: number;
  section: PageSectionItem & {
    type: "custom_code";
    config: CustomCodeConfig;
  };
  sectionDigest: string;
};

/** Read the latest completed draft save for restored conversation cards. */
export async function getLatestMinkStorefrontCodeAction(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkStorefrontCodeActionResult | null> {
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
          eq(minkActionApprovals.toolName, "apply_storefront_code"),
          eq(minkActionApprovals.status, "executed"),
        ),
      )
      .orderBy(desc(minkActionApprovals.executedAt))
      .limit(1);
    if (!rows[0]) return null;
    const approval = validateApproval(rows[0]);
    const audit = await readAudit(db, actor.storeId, approval.id);
    if (!audit) throw invalidApproval();
    return {
      approval: toApproval(approval),
      auditId: audit.id,
      repeated: true,
    };
  });
}

/** Create a fresh, idempotent approval against the exact current Builder draft. */
export async function previewMinkStorefrontCodeAction(input: {
  actor: MinkActorContext;
  draftId: string;
  expectedDraftVersion: number;
  idempotencyKey: string;
}): Promise<MinkStorefrontCodeActionApproval> {
  return withService(async (db) => {
    assertAuthority(input.actor);
    await lockDraft(db, input.actor, input.draftId);
    const draft = await readDraft(db, input.actor, input.draftId);
    if (draft.currentVersion !== input.expectedDraftVersion) {
      throw conflict(
        "mink_storefront_draft_conflict",
        "The saved storefront proposal changed. Review the latest proposal again.",
      );
    }
    await assertToolEnabled(db, input.actor.storeId);
    const proposal = validateStoredStorefrontProposal(draft.content);
    const storedBefore = readStoredStorefrontCodeConfig(draft.before, "before");
    const target = await readTargetBySlug(
      db,
      input.actor,
      proposal.value.patch.target.pageSlug,
      proposal.value.patch.target.sectionId,
    );
    assertProposalMatchesTarget(proposal.value, storedBefore, target);
    const before = values(target, target.section.config, target.sectionDigest);
    const afterSection = {
      ...target.section,
      config: proposal.value.config,
    } as StorefrontTarget["section"];
    const after = values(
      target,
      proposal.value.config,
      digestMinkStorefrontValue(afterSection),
    );
    return createApproval(db, {
      actor: input.actor,
      draftId: draft.id,
      draftVersion: draft.currentVersion,
      target,
      before,
      after,
      idempotencyKey: input.idempotencyKey,
    });
  });
}

/**
 * Apply one approved replacement to store_pages.sections. Publication columns
 * are intentionally absent from this transaction and from this API contract.
 */
export async function executeMinkStorefrontCodeAction(input: {
  actor: MinkActorContext;
  draftId: string;
  approvalId: string;
}): Promise<MinkStorefrontCodeActionResult> {
  const outcome = await withService(async (db) => {
    assertAuthority(input.actor);
    await lockApproval(db, input.actor, input.approvalId);
    const approval = await readApproval(db, input.actor, input.approvalId);
    if (approval.draftId !== input.draftId) throw approvalNotFound();
    if (approval.status === "executed") {
      const audit = await readAudit(db, input.actor.storeId, approval.id);
      if (!audit) throw invalidApproval();
      return {
        result: {
          approval: toApproval(approval),
          auditId: audit.id,
          repeated: true,
        },
      };
    }
    if (approval.status !== "pending") {
      throw conflict(
        "mink_storefront_approval_terminal",
        "This storefront approval is no longer available.",
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
          "mink_storefront_approval_expired",
          "This approval expired. Review the latest Builder draft and create a new approval.",
        ),
      };
    }

    await lockDraft(db, input.actor, approval.draftId);
    const draft = await readDraft(db, input.actor, approval.draftId);
    let proposal: ReturnType<typeof validateStoredStorefrontProposal>;
    let storedBefore: CustomCodeConfig;
    try {
      proposal = validateStoredStorefrontProposal(draft.content);
      storedBefore = readStoredStorefrontCodeConfig(draft.before, "before");
    } catch (error) {
      if (!(error instanceof MinkRequestError)) throw error;
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The saved storefront proposal failed integrity validation.",
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
      !sameProposal(
        proposal.value,
        storedBefore,
        approval.resourceVersion,
        approvedBefore,
        approvedAfter,
      )
    ) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The saved storefront proposal changed after approval preview.",
      );
      return { error: draftConflict() };
    }

    await lockPage(db, input.actor, approval.resourceId);
    let target: StorefrontTarget;
    try {
      target = await readTargetById(
        db,
        input.actor,
        approval.resourceId,
        approvedBefore.section_id,
      );
    } catch (error) {
      if (!(error instanceof MinkRequestError)) throw error;
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The exact page or custom-code section is no longer available.",
      );
      return { error: targetConflict() };
    }
    const currentValues = values(
      target,
      target.section.config,
      target.sectionDigest,
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
        "The Website Builder page or target section changed after preview.",
        target.updatedAt,
      );
      return { error: targetConflict() };
    }
    const updatedSection = {
      ...target.section,
      config: proposal.value.config,
    } as StorefrontTarget["section"];
    if (
      digestMinkStorefrontValue(updatedSection) !== approvedAfter.section_digest
    ) {
      throw invalidApproval();
    }
    const nextSections = [...target.sections];
    nextSections[target.sectionIndex] = updatedSection;
    const now = new Date().toISOString();
    const updated = await db
      .update(storePages)
      .set({ sections: nextSections, updatedBy: input.actor.adminId })
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
    const auditId = crypto.randomUUID();
    await db.insert(minkActionAudit).values({
      id: auditId,
      approvalId: approval.id,
      storeId: approval.storeId,
      adminId: approval.adminId,
      draftId: approval.draftId,
      productId: null,
      resourceType: "storefront_section",
      resourceId: approval.resourceId,
      locationId: null,
      variantId: null,
      resourceVersionBefore: approval.resourceVersion,
      resourceVersionAfter: updated[0].updatedAt,
      resultId: updated[0].id,
      toolName: "apply_storefront_code",
      operation: "apply",
      outcome: "executed",
      beforeJson: approvedBefore,
      afterJson: approvedAfter,
      productVersionBefore: null,
      productVersionAfter: null,
      requestHash: approval.requestHash,
      toolVersion: TOOL_VERSION,
      detail:
        "Approved exact custom-code replacement saved to the private Website Builder draft; publication state was not changed.",
    });
    return {
      result: {
        approval: toApproval({
          ...approval,
          status: "executed",
          approvedAt: now,
          executedAt: now,
          resultId: updated[0].id,
          resultVersion: updated[0].updatedAt,
        }),
        auditId,
        repeated: false,
      },
    };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

async function createApproval(
  db: Db,
  input: {
    actor: MinkActorContext;
    draftId: string;
    draftVersion: number;
    target: StorefrontTarget;
    before: MinkStorefrontCodeActionValues;
    after: MinkStorefrontCodeActionValues;
    idempotencyKey: string;
  },
) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const requestHash = hashMinkActionPayload({
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
      resourceType: "storefront_section",
      resourceId: input.target.id,
      resourceVersion: input.target.updatedAt,
      resourceLabel: `${input.target.title} · custom code`,
      locationId: null,
      variantId: null,
      resultId: null,
      sourceApprovalId: null,
      toolName: "apply_storefront_code",
      operation: "apply",
      draftVersion: input.draftVersion,
      productVersion: null,
      beforeJson: input.before,
      afterJson: input.after,
      requestHash,
      idempotencyKey: input.idempotencyKey,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0]
    ? validateApproval(inserted[0])
    : await readByIdempotency(db, input.actor, input.idempotencyKey);
  if (row.requestHash !== requestHash) {
    throw conflict(
      "mink_storefront_idempotency_conflict",
      "This approval request key was already used for a different storefront preview.",
    );
  }
  return toApproval(row);
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
    throw new MinkRequestError(
      "mink_storefront_draft_unavailable",
      "This private storefront proposal is not available for approval.",
      409,
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
    throw new MinkRequestError(
      "mink_storefront_draft_invalid",
      error instanceof Error ? error.message : "Invalid storefront proposal.",
      400,
    );
  }
}

async function readTargetBySlug(
  db: Db,
  actor: MinkActorContext,
  pageSlug: string,
  sectionId: string,
) {
  const storedSlug = pageSlug === "home" ? "" : pageSlug;
  const rows = await db
    .select({
      id: storePages.id,
      slug: storePages.slug,
      title: storePages.title,
      sections: storePages.sections,
      updatedAt: storePages.updatedAt,
      settings: stores.settings,
    })
    .from(storePages)
    .innerJoin(
      stores,
      and(eq(stores.id, storePages.storeId), eq(stores.id, actor.storeId)),
    )
    .where(
      and(
        eq(storePages.storeId, actor.storeId),
        eq(storePages.slug, storedSlug),
      ),
    )
    .limit(1);
  return normalizeTarget(actor, rows[0], sectionId);
}

async function readTargetById(
  db: Db,
  actor: MinkActorContext,
  pageId: string,
  sectionId: string,
) {
  const rows = await db
    .select({
      id: storePages.id,
      slug: storePages.slug,
      title: storePages.title,
      sections: storePages.sections,
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
  return normalizeTarget(actor, rows[0], sectionId);
}

function normalizeTarget(
  actor: MinkActorContext,
  row:
    | {
        id: string;
        slug: string;
        title: string;
        sections: unknown;
        updatedAt: string;
        settings: unknown;
      }
    | undefined,
  sectionId: string,
): StorefrontTarget {
  if (!row) throw targetConflict();
  const settings = isRecord(row.settings) ? row.settings : {};
  if (
    resolveStoreSettings(settings, actor.effectivePlan)["pages.customCode"] !==
    true
  ) {
    throw new MinkRequestError(
      "mink_storefront_custom_code_disabled",
      "Custom code is not enabled for this store and plan.",
      403,
    );
  }
  const validated = validateSections(row.sections, { mode: "draft" });
  if ("error" in validated) {
    throw conflict(
      "mink_storefront_page_invalid",
      "The Builder draft is invalid. Repair it in Website Builder before applying this proposal.",
    );
  }
  const sectionIndex = validated.sections.findIndex(
    (section) => section.id === sectionId,
  );
  const section = validated.sections[sectionIndex];
  if (!section || section.type !== "custom_code") throw targetConflict();
  return {
    id: row.id,
    slug: row.slug === "" ? "home" : row.slug,
    title: boundedTitle(row.title, row.slug || "Home"),
    updatedAt: row.updatedAt,
    sections: validated.sections,
    sectionIndex,
    section: section as StorefrontTarget["section"],
    sectionDigest: digestMinkStorefrontValue(section),
  };
}

function assertProposalMatchesTarget(
  proposal: ValidatedMinkStorefrontCodePatch,
  storedBefore: CustomCodeConfig,
  target: StorefrontTarget,
) {
  if (
    target.slug !== proposal.patch.target.pageSlug ||
    target.updatedAt !== proposal.patch.target.expectedPageVersion ||
    target.sectionDigest !== proposal.patch.target.expectedSectionDigest ||
    hashMinkActionPayload(storedBefore) !==
      hashMinkActionPayload(target.section.config)
  ) {
    throw targetConflict();
  }
}

function sameProposal(
  proposal: ValidatedMinkStorefrontCodePatch,
  storedBefore: CustomCodeConfig,
  approvedPageVersion: string,
  before: MinkStorefrontCodeActionValues,
  after: MinkStorefrontCodeActionValues,
) {
  return (
    proposal.patch.target.pageSlug === before.page_slug &&
    after.page_slug === before.page_slug &&
    after.page_title === before.page_title &&
    proposal.patch.target.sectionId === before.section_id &&
    after.section_id === before.section_id &&
    proposal.patch.target.expectedPageVersion === approvedPageVersion &&
    proposal.patch.target.expectedSectionDigest === before.section_digest &&
    hashMinkActionPayload(storedBefore) ===
      hashMinkActionPayload(configFromValues(before)) &&
    hashMinkActionPayload(proposal.config) ===
      hashMinkActionPayload(configFromValues(after))
  );
}

function values(
  target: StorefrontTarget,
  config: CustomCodeConfig,
  sectionDigest: string,
): MinkStorefrontCodeActionValues {
  return {
    page_slug: target.slug,
    page_title: target.title,
    section_id: target.section.id,
    section_digest: sectionDigest,
    html: config.html,
    css: config.css,
    js: config.js,
    height_mode: config.height_mode,
    fixed_height: String(config.fixed_height),
  };
}

function configFromValues(
  value: MinkStorefrontCodeActionValues,
): CustomCodeConfig {
  return {
    html: value.html,
    css: value.css,
    js: value.js,
    height_mode: value.height_mode,
    fixed_height: Number(value.fixed_height),
  };
}

function valuesFromJson(value: unknown): MinkStorefrontCodeActionValues {
  if (!isRecord(value)) throw invalidApproval();
  const keys = [
    "page_slug",
    "page_title",
    "section_id",
    "section_digest",
    "html",
    "css",
    "js",
    "height_mode",
    "fixed_height",
  ] as const;
  const parsedConfig = validateSections(
    [
      {
        id: String(value.section_id ?? ""),
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
  const normalized =
    "error" in parsedConfig
      ? null
      : (parsedConfig.sections[0]?.config as CustomCodeConfig | undefined);
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => typeof value[key] !== "string") ||
    !/^(?:home|[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(String(value.page_slug)) ||
    String(value.page_slug).length > 60 ||
    String(value.page_title).length < 1 ||
    String(value.page_title).length > 120 ||
    !["auto", "fixed"].includes(String(value.height_mode)) ||
    !/^[a-f0-9]{64}$/.test(String(value.section_digest)) ||
    !normalized ||
    normalized.html !== value.html ||
    normalized.css !== value.css ||
    normalized.js !== value.js ||
    normalized.height_mode !== value.height_mode ||
    String(normalized.fixed_height) !== value.fixed_height
  ) {
    throw invalidApproval();
  }
  return value as unknown as MinkStorefrontCodeActionValues;
}

function toApproval(row: ApprovalRow): MinkStorefrontCodeActionApproval {
  const before = valuesFromJson(row.beforeJson);
  return {
    id: row.id,
    sourceApprovalId: null,
    toolName: "apply_storefront_code",
    operation: "apply",
    status: row.status,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    resource: {
      type: "storefront_section",
      id: row.resourceId,
      label: row.resourceLabel ?? `${before.page_title} · custom code`,
      dashboardPath: `/dashboard/builder?page=${encodeURIComponent(before.page_slug)}&section=${encodeURIComponent(before.section_id)}`,
    },
    before,
    after: valuesFromJson(row.afterJson),
    expiresAt: row.expiresAt,
    executedAt: row.executedAt,
  };
}

function validateApproval(
  row: typeof minkActionApprovals.$inferSelect,
): ApprovalRow {
  if (
    row.toolName !== "apply_storefront_code" ||
    row.operation !== "apply" ||
    !["pending", "executed", "conflicted", "expired", "cancelled"].includes(
      row.status,
    ) ||
    row.resourceType !== "storefront_section" ||
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
        and tool_name = 'apply_storefront_code'
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
          eq(minkActionToolAccess.toolName, "apply_storefront_code"),
        ),
      )
      .limit(1);
    if (rows[0]?.enabled) return;
  }
  throw new MinkRequestError(
    "mink_storefront_tool_disabled",
    "StoreMink support has not enabled Mink Website Builder draft saves for this store.",
    403,
  );
}

function assertAuthority(actor: MinkActorContext) {
  if (
    !actor.draftingEnabled ||
    !can(actor.permissions, "builder", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_storefront_action_access_denied",
      "You do not have permission to save Website Builder drafts through Mink.",
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
    resourceType: "storefront_section",
    resourceId: approval.resourceId,
    locationId: null,
    variantId: null,
    resourceVersionBefore: approval.resourceVersion,
    resourceVersionAfter,
    resultId: null,
    toolName: "apply_storefront_code",
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
  before: MinkStorefrontCodeActionValues,
  after: MinkStorefrontCodeActionValues,
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
    "mink_storefront_approval_invalid",
    "This storefront approval failed integrity validation. Create a new preview.",
    409,
  );
}

function approvalNotFound() {
  return new MinkRequestError(
    "mink_storefront_approval_not_found",
    "This storefront approval is unavailable.",
    404,
  );
}

function draftConflict() {
  return conflict(
    "mink_storefront_draft_conflict",
    "The saved storefront proposal changed after preview. Review it again.",
  );
}

function targetConflict() {
  return conflict(
    "mink_storefront_target_conflict",
    "The Website Builder page or exact section changed. Nothing was saved; generate a fresh proposal from the latest Builder draft.",
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
