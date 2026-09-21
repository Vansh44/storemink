import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  blogs,
  minkActionApprovals,
  minkActionAudit,
  minkActionToolAccess,
  minkBlogPublications,
  minkDrafts,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { hashMinkActionPayload } from "./action-integrity";
import {
  minkBlogReadingTime,
  renderMinkBlogMarkdown,
} from "./blog-publication-content";
import type {
  MinkBlogPublicationApproval,
  MinkBlogPublicationExecutionResult,
  MinkBlogPublicationResult,
  MinkBlogPublicationValues,
} from "./blog-publication-action-types";
import {
  MinkBlogPublicationTimingError,
  normalizeMinkBlogPublicationTiming,
  type MinkBlogPublicationTiming,
} from "./blog-publication-policy";
import { normalizeMinkDraftContent } from "./draft-types";
import { MinkRequestError } from "./errors";
import type { MinkActorContext } from "./types";
import { selectOwnedStorefrontImageUrls } from "./storefront-media-read";

const APPROVAL_TTL_MS = 5 * 60 * 1_000;
const TOOL_VERSION = 1;

type ApprovalRow = typeof minkActionApprovals.$inferSelect & {
  toolName: "publish_blog";
  operation: "apply";
  status: "pending" | "executed" | "conflicted" | "expired" | "cancelled";
  resourceType: "blog";
  resourceId: null;
};

type PublicationRow = typeof minkBlogPublications.$inferSelect & {
  mode: "publish_now" | "schedule";
  status: "scheduled" | "published" | "conflicted" | "cancelled";
};

export async function getLatestMinkBlogPublication(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkBlogPublicationResult | null> {
  return withService(async (db) => {
    assertBlogAuthority(actor);
    const rows = await db
      .select()
      .from(minkActionApprovals)
      .where(
        and(
          eq(minkActionApprovals.storeId, actor.storeId),
          eq(minkActionApprovals.adminId, actor.adminId),
          eq(minkActionApprovals.draftId, draftId),
          eq(minkActionApprovals.toolName, "publish_blog"),
          eq(minkActionApprovals.status, "executed"),
        ),
      )
      .orderBy(desc(minkActionApprovals.executedAt))
      .limit(1);
    if (!rows[0]) return null;
    const approval = validateApproval(rows[0]);
    const publication = await readPublication(db, actor.storeId, approval.id);
    const audit = await readAudit(db, actor.storeId, approval.id);
    return result(approval, publication, audit?.id ?? null, true);
  });
}

export async function previewMinkBlogPublication(input: {
  actor: MinkActorContext;
  draftId: string;
  expectedDraftVersion: number;
  idempotencyKey: string;
  mode: unknown;
  scheduledFor?: unknown;
}): Promise<MinkBlogPublicationApproval> {
  const timing = timingForRequest(input.mode, input.scheduledFor);
  return withService(async (db) => {
    assertBlogAuthority(input.actor);
    await lockDraft(db, input.actor, input.draftId);
    const draft = await readDraft(db, input.actor, input.draftId);
    if (draft.currentVersion !== input.expectedDraftVersion) {
      throw conflict(
        "mink_blog_draft_conflict",
        "The saved blog proposal changed. Save and review it again.",
      );
    }
    await assertToolEnabled(db, input.actor.storeId);
    const content = normalizeBlogContent(draft.content);
    await assertOwnedBlogCover(
      db,
      input.actor.storeId,
      content.cover_image_url,
    );
    const before = values(content, null);
    const after = values(content, timing);
    return createApproval(db, {
      actor: input.actor,
      draftId: draft.id,
      draftVersion: draft.currentVersion,
      title: content.title,
      before,
      after,
      idempotencyKey: input.idempotencyKey,
    });
  });
}

export async function executeMinkBlogPublication(input: {
  actor: MinkActorContext;
  draftId: string;
  approvalId: string;
}): Promise<MinkBlogPublicationExecutionResult> {
  const outcome = await withService(async (db) => {
    assertBlogAuthority(input.actor);
    await lockApproval(db, input.actor, input.approvalId);
    const approval = await readApproval(db, input.actor, input.approvalId);
    if (approval.draftId !== input.draftId) throw approvalNotFound();
    if (approval.status === "executed") {
      const publication = await readPublication(
        db,
        input.actor.storeId,
        approval.id,
      );
      const audit = await readAudit(db, input.actor.storeId, approval.id);
      return {
        result: {
          ...result(approval, publication, audit?.id ?? null, true),
          notifyPublication: false,
          publishedSlug: null,
        },
      };
    }
    if (approval.status !== "pending") {
      throw conflict(
        "mink_blog_approval_terminal",
        "This blog publication approval is no longer available.",
      );
    }
    await assertToolEnabled(db, input.actor.storeId, true);
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      await finalizeWithoutWrite(
        db,
        approval,
        "expired",
        "Approval expired before blog creation.",
      );
      return {
        error: conflict(
          "mink_blog_approval_expired",
          "This blog publication approval expired. Review the saved draft again.",
        ),
      };
    }
    await lockDraft(db, input.actor, approval.draftId);
    const draft = await readDraft(db, input.actor, approval.draftId);
    if (draft.currentVersion !== approval.draftVersion) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The saved blog proposal changed after preview.",
      );
      return {
        error: conflict(
          "mink_blog_draft_conflict",
          "The saved blog proposal changed after preview. Review it again.",
        ),
      };
    }
    const content = normalizeBlogContent(draft.content);
    await assertOwnedBlogCover(
      db,
      input.actor.storeId,
      content.cover_image_url,
    );
    const approvedBefore = valuesFromJson(approval.beforeJson);
    const approvedAfter = valuesFromJson(approval.afterJson);
    const timing = timingFromApproval(approval, approvedAfter);
    if (
      timing.mode === "schedule" &&
      Date.parse(timing.scheduledFor) <= Date.now()
    ) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The scheduled publication time passed before approval.",
      );
      return {
        error: conflict(
          "mink_blog_schedule_passed",
          "The scheduled time has passed. Choose a new future time and review again.",
        ),
      };
    }
    const currentBefore = values(content, null);
    const currentAfter = values(content, timing);
    if (
      hashMinkActionPayload(currentBefore) !==
        hashMinkActionPayload(approvedBefore) ||
      hashMinkActionPayload(currentAfter) !==
        hashMinkActionPayload(approvedAfter) ||
      approval.requestHash !==
        requestHash(approval, approvedBefore, approvedAfter)
    ) {
      throw invalidApproval();
    }

    const now = new Date().toISOString();
    const rendered = renderMinkBlogMarkdown(content.content);
    const inserted = await insertBlog(db, {
      actor: input.actor,
      draftId: draft.id,
      content,
      rendered,
      timing,
      now,
    });
    const finalized = await db
      .update(minkActionApprovals)
      .set({
        status: "executed",
        approvedAt: now,
        executedAt: now,
        resultId: inserted.id,
        resultVersion: inserted.updatedAt,
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

    const publicationRows = await db
      .insert(minkBlogPublications)
      .values({
        id: crypto.randomUUID(),
        storeId: approval.storeId,
        adminId: approval.adminId,
        draftId: approval.draftId,
        approvalId: approval.id,
        blogId: inserted.id,
        mode: timing.mode,
        status: timing.mode === "publish_now" ? "published" : "scheduled",
        scheduledFor: timing.scheduledFor,
        blogVersion: inserted.updatedAt,
        publishedAt: timing.mode === "publish_now" ? now : null,
        detail:
          timing.mode === "publish_now"
            ? "Published immediately after exact approval."
            : "Waiting for the authenticated publication worker.",
      })
      .returning();
    if (!publicationRows[0]) throw invalidApproval();
    const publication = validatePublication(publicationRows[0]);

    const auditId = crypto.randomUUID();
    await db.insert(minkActionAudit).values({
      id: auditId,
      approvalId: approval.id,
      storeId: approval.storeId,
      adminId: approval.adminId,
      draftId: approval.draftId,
      productId: null,
      resourceType: "blog",
      resourceId: null,
      locationId: null,
      variantId: null,
      resourceVersionBefore: null,
      resourceVersionAfter: inserted.updatedAt,
      resultId: inserted.id,
      toolName: "publish_blog",
      operation: "apply",
      outcome: "executed",
      beforeJson: approvedBefore,
      afterJson: approvedAfter,
      productVersionBefore: null,
      productVersionAfter: null,
      requestHash: approval.requestHash,
      toolVersion: TOOL_VERSION,
      detail:
        timing.mode === "publish_now"
          ? "Approved Mink blog created and published immediately."
          : `Approved Mink blog created as a private draft and scheduled for ${timing.scheduledFor}.`,
    });
    const executed: ApprovalRow = {
      ...approval,
      status: "executed",
      approvedAt: now,
      executedAt: now,
      resultId: inserted.id,
      resultVersion: inserted.updatedAt,
    };
    return {
      result: {
        ...result(executed, publication, auditId, false),
        notifyPublication: timing.mode === "publish_now",
        publishedSlug: timing.mode === "publish_now" ? inserted.slug : null,
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
    title: string;
    before: MinkBlogPublicationValues;
    after: MinkBlogPublicationValues;
    idempotencyKey: string;
  },
) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const requestHashValue = hashMinkActionPayload({
    storeId: input.actor.storeId,
    adminId: input.actor.adminId,
    draftId: input.draftId,
    draftVersion: input.draftVersion,
    before: input.before,
    after: input.after,
  });
  const inserted = await db
    .insert(minkActionApprovals)
    .values({
      id,
      storeId: input.actor.storeId,
      adminId: input.actor.adminId,
      draftId: input.draftId,
      productId: null,
      resourceType: "blog",
      resourceId: null,
      resourceVersion: null,
      resourceLabel: input.title,
      locationId: null,
      variantId: null,
      sourceApprovalId: null,
      toolName: "publish_blog",
      operation: "apply",
      draftVersion: input.draftVersion,
      productVersion: null,
      beforeJson: input.before,
      afterJson: input.after,
      requestHash: requestHashValue,
      idempotencyKey: input.idempotencyKey,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0]
    ? validateApproval(inserted[0])
    : await readByIdempotency(db, input.actor, input.idempotencyKey);
  if (row.requestHash !== requestHashValue) {
    throw conflict(
      "mink_blog_idempotency_conflict",
      "This approval request key was already used for a different publication preview.",
    );
  }
  return toApproval(row);
}

async function insertBlog(
  db: Db,
  input: {
    actor: MinkActorContext;
    draftId: string;
    content: ReturnType<typeof normalizeBlogContent>;
    rendered: string;
    timing: MinkBlogPublicationTiming;
    now: string;
  },
) {
  const base = blogSlug(input.content.title);
  const values = (slug: string) => ({
    id: crypto.randomUUID(),
    storeId: input.actor.storeId,
    title: input.content.title,
    slug,
    excerpt: input.content.excerpt,
    content: input.rendered,
    coverImageUrl: input.content.cover_image_url || null,
    status: input.timing.mode === "publish_now" ? "published" : "draft",
    tags: [] as string[],
    categories: [] as string[],
    featured: false,
    seoTitle: input.content.seo_title || null,
    seoDescription: input.content.seo_description || null,
    readingTime: minkBlogReadingTime(input.rendered),
    createdBy: input.actor.adminId,
    updatedBy: input.actor.adminId,
    publishedAt: input.timing.mode === "publish_now" ? input.now : null,
    isCustomerSubmission: false,
    submittedBy: null,
    createdAt: input.now,
    updatedAt: input.now,
  });
  const attempts = [base, `${base}-${input.draftId.slice(0, 8)}`];
  for (const slug of attempts) {
    const rows = await db
      .insert(blogs)
      .values(values(slug))
      .onConflictDoNothing()
      .returning({
        id: blogs.id,
        slug: blogs.slug,
        updatedAt: blogs.updatedAt,
      });
    if (rows[0]) return rows[0];
  }
  throw conflict(
    "mink_blog_slug_conflict",
    "A blog with the generated URL already exists. Change the title slightly and review again.",
  );
}

function blogSlug(value: string) {
  const slug = value
    .normalize("NFKD")
    .toLocaleLowerCase("en-IN")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 170)
    .replace(/-+$/g, "");
  return slug || "post";
}

async function readDraft(db: Db, actor: MinkActorContext, draftId: string) {
  const rows = await db
    .select({
      id: minkDrafts.id,
      kind: minkDrafts.kind,
      status: minkDrafts.status,
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
    draft.kind !== "blog" ||
    draft.status !== "draft" ||
    draft.currentVersion < 1
  ) {
    throw new MinkRequestError(
      "mink_blog_draft_unavailable",
      "Save this private blog proposal before reviewing publication.",
      409,
    );
  }
  return draft;
}

function normalizeBlogContent(value: unknown) {
  try {
    return normalizeMinkDraftContent("blog", value) as {
      title: string;
      excerpt: string;
      content: string;
      cover_image_url: string;
      seo_title: string;
      seo_description: string;
    };
  } catch (error) {
    throw new MinkRequestError(
      "mink_blog_draft_invalid",
      error instanceof Error ? error.message : "Invalid blog proposal.",
      400,
    );
  }
}

function values(
  content: ReturnType<typeof normalizeBlogContent>,
  timing: MinkBlogPublicationTiming | null,
): MinkBlogPublicationValues {
  return {
    publication_status: timing
      ? timing.mode === "publish_now"
        ? "Published"
        : "Scheduled"
      : "Private draft",
    publish_at: timing
      ? timing.mode === "publish_now"
        ? "Immediately after approval"
        : timing.scheduledFor
      : null,
    title: content.title,
    excerpt: content.excerpt,
    content: content.content,
    cover_image_url: content.cover_image_url || null,
    seo_title: content.seo_title || null,
    seo_description: content.seo_description || null,
  };
}

async function assertOwnedBlogCover(
  db: Db,
  storeId: string,
  coverImageUrl: string,
): Promise<void> {
  if (!coverImageUrl) return;
  const owned = await selectOwnedStorefrontImageUrls(db, storeId, [
    coverImageUrl,
  ]);
  if (!owned.has(coverImageUrl)) {
    throw conflict(
      "mink_blog_cover_unavailable",
      "The selected cover image is no longer available in this store. Choose a current Media Library or catalogue image and review again.",
    );
  }
}

function timingForRequest(mode: unknown, scheduledFor: unknown) {
  try {
    return normalizeMinkBlogPublicationTiming({ mode, scheduledFor });
  } catch (error) {
    throw new MinkRequestError(
      "mink_blog_timing_invalid",
      error instanceof Error ? error.message : "Invalid publication timing.",
      400,
    );
  }
}

function timingFromApproval(
  approval: ApprovalRow,
  after: MinkBlogPublicationValues,
) {
  const mode =
    after.publication_status === "Published" ? "publish_now" : "schedule";
  try {
    return normalizeMinkBlogPublicationTiming({
      mode,
      scheduledFor: mode === "schedule" ? after.publish_at : undefined,
      nowMs: Date.parse(approval.createdAt),
    });
  } catch (error) {
    if (error instanceof MinkBlogPublicationTimingError)
      throw invalidApproval();
    throw error;
  }
}

function result(
  approval: ApprovalRow,
  publication: PublicationRow,
  auditId: string | null,
  repeated: boolean,
): MinkBlogPublicationResult {
  return {
    approval: toApproval(approval),
    auditId,
    repeated,
    publication: {
      id: publication.id,
      mode: publication.mode,
      status: publication.status,
      scheduledFor: publication.scheduledFor,
      publishedAt: publication.publishedAt,
    },
  };
}

function toApproval(row: ApprovalRow): MinkBlogPublicationApproval {
  return {
    id: row.id,
    sourceApprovalId: null,
    toolName: "publish_blog",
    operation: "apply",
    status: row.status,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    resource: {
      type: "blog",
      id: row.resultId,
      label: row.resourceLabel ?? "Blog post",
      dashboardPath: "/dashboard/blogs",
    },
    before: valuesFromJson(row.beforeJson),
    after: valuesFromJson(row.afterJson),
    expiresAt: row.expiresAt,
    executedAt: row.executedAt,
  };
}

function validateApproval(
  row: typeof minkActionApprovals.$inferSelect,
): ApprovalRow {
  if (
    row.toolName !== "publish_blog" ||
    row.operation !== "apply" ||
    !["pending", "executed", "conflicted", "expired", "cancelled"].includes(
      row.status,
    ) ||
    row.resourceType !== "blog" ||
    row.resourceId ||
    row.productId ||
    row.locationId ||
    row.variantId ||
    row.sourceApprovalId
  ) {
    throw invalidApproval();
  }
  return row as ApprovalRow;
}

function validatePublication(
  row: typeof minkBlogPublications.$inferSelect,
): PublicationRow {
  if (
    !["publish_now", "schedule"].includes(row.mode) ||
    !["scheduled", "published", "conflicted", "cancelled"].includes(
      row.status,
    ) ||
    (row.mode === "publish_now" &&
      (row.status !== "published" || row.scheduledFor || !row.publishedAt)) ||
    (row.mode === "schedule" && !row.scheduledFor)
  ) {
    throw invalidApproval();
  }
  return row as PublicationRow;
}

async function assertToolEnabled(db: Db, storeId: string, lock = false) {
  if (lock) {
    const result = await db.execute(sql`
      select enabled from public.mink_action_tool_access
      where store_id = ${storeId}::uuid and tool_name = 'publish_blog'
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
          eq(minkActionToolAccess.toolName, "publish_blog"),
        ),
      )
      .limit(1);
    if (rows[0]?.enabled) return;
  }
  throw new MinkRequestError(
    "mink_blog_tool_disabled",
    "StoreMink support has not enabled Mink blog publication for this store.",
    403,
  );
}

function assertBlogAuthority(actor: MinkActorContext) {
  if (
    !actor.draftingEnabled ||
    !can(actor.permissions, "blogs", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_blog_access_denied",
      "You do not have permission to publish blogs through Mink.",
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

async function readPublication(db: Db, storeId: string, approvalId: string) {
  const rows = await db
    .select()
    .from(minkBlogPublications)
    .where(
      and(
        eq(minkBlogPublications.storeId, storeId),
        eq(minkBlogPublications.approvalId, approvalId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw invalidApproval();
  return validatePublication(rows[0]);
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
    resourceType: "blog",
    resourceId: null,
    locationId: null,
    variantId: null,
    resourceVersionBefore: null,
    resourceVersionAfter: null,
    resultId: null,
    toolName: "publish_blog",
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
  before: MinkBlogPublicationValues,
  after: MinkBlogPublicationValues,
) {
  return hashMinkActionPayload({
    storeId: approval.storeId,
    adminId: approval.adminId,
    draftId: approval.draftId,
    draftVersion: approval.draftVersion,
    before,
    after,
  });
}

function valuesFromJson(value: unknown): MinkBlogPublicationValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidApproval();
  }
  const result: MinkBlogPublicationValues = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== null && typeof item !== "string") throw invalidApproval();
    result[key] = item;
  }
  return result;
}

function invalidApproval() {
  return new MinkRequestError(
    "mink_blog_approval_invalid",
    "This blog publication approval is invalid. Create a new preview.",
    409,
  );
}

function approvalNotFound() {
  return new MinkRequestError(
    "mink_blog_approval_not_found",
    "This blog publication approval is unavailable.",
    404,
  );
}

function conflict(code: string, message: string) {
  return new MinkRequestError(code, message, 409);
}
