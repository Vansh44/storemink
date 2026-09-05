import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  minkDraftCreditUsage,
  minkDrafts,
  minkDraftVersions,
} from "@/drizzle/schema";
import { currentPeriod } from "@/lib/ai/quota";
import { withService, type Db } from "@/lib/db/client";
import { limitsFor } from "@/lib/plans";
import {
  MINK_DRAFT_CONFIG,
  isMinkDraftKind,
  minkDraftFields,
  normalizeMinkDraftContent,
  type MinkDraftContent,
  type MinkDraftCreditSource,
  type MinkDraftKind,
  type MinkDraftVersionSummary,
} from "./draft-types";
import { MinkRequestError, MinkToolInputError } from "./errors";
import { getLatestMinkDomainAction } from "./domain-actions";
import type { MinkDomainActionResult } from "./domain-action-types";
import { getLatestMinkInventoryAction } from "./inventory-actions";
import type { MinkInventoryActionResult } from "./inventory-action-types";
import { getLatestMinkBulkInventoryAction } from "./bulk-inventory-actions";
import type { MinkBulkInventoryActionResult } from "./bulk-inventory-action-types";
import { getLatestMinkBulkPriceAction } from "./bulk-price-actions";
import type { MinkBulkPriceActionResult } from "./bulk-price-action-types";
import { getLatestMinkOrderStatusAction } from "./order-status-actions";
import type { MinkOrderStatusActionResult } from "./order-status-action-types";
import { getLatestMinkBlogPublication } from "./blog-publication-actions";
import type { MinkBlogPublicationResult } from "./blog-publication-action-types";
import { getLatestMinkCampaign } from "./campaign-actions";
import type { MinkCampaignResult } from "./campaign-action-types";
import { getLatestMinkProductAction } from "./product-actions";
import type { MinkProductActionResult } from "./product-action-types";
import type { MinkActorContext, MinkArtifact } from "./types";

const DRAFT_PERMISSION: Record<
  MinkDraftKind,
  { section: string; action: "manage" }
> = {
  product_description: { section: "products", action: "manage" },
  product_seo: { section: "products", action: "manage" },
  blog: { section: "blogs", action: "manage" },
  coupon_email: { section: "marketing", action: "manage" },
  customer_message: { section: "users", action: "manage" },
  product_create: { section: "products", action: "manage" },
  coupon_create: { section: "marketing", action: "manage" },
  coupon_update: { section: "marketing", action: "manage" },
  customer_group_create: { section: "users", action: "manage" },
  customer_group_update: { section: "users", action: "manage" },
  inventory_adjustment: { section: "inventory", action: "manage" },
  bulk_inventory_adjustment: { section: "inventory", action: "manage" },
  order_status_transition: { section: "orders", action: "manage" },
  bulk_price_update: { section: "products", action: "manage" },
  // ★ The `promotions` section, which is where offers live. It kept that key
  // when the coupons page folded into Offers, so a role already granted
  // promotions covers this with no re-grant (CODEBASE §38).
  offer_create: { section: "promotions", action: "manage" },
  offer_update: { section: "promotions", action: "manage" },
  offer_activate: { section: "promotions", action: "manage" },
  storefront_custom_code: { section: "builder", action: "manage" },
};

export interface MinkDraftState {
  id: string;
  kind: MinkDraftKind;
  title: string;
  status: "proposed" | "draft";
  destinationLabel: string;
  destinationPath: string;
  before: MinkDraftContent;
  content: MinkDraftContent;
  currentVersion: number;
  expectedCredits: number;
  chargedCredits: number;
  creditSource: MinkDraftCreditSource;
  versions: MinkDraftVersionSummary[];
  lastProductAction: MinkProductActionResult | null;
  lastDomainAction: MinkDomainActionResult | null;
  lastInventoryAction: MinkInventoryActionResult | null;
  lastBulkInventoryAction: MinkBulkInventoryActionResult | null;
  lastBulkPriceAction: MinkBulkPriceActionResult | null;
  lastOrderStatusAction: MinkOrderStatusActionResult | null;
  lastBlogPublication: MinkBlogPublicationResult | null;
  lastCampaign: MinkCampaignResult | null;
}

export async function createMinkDraftProposal(input: {
  actor: MinkActorContext;
  kind: MinkDraftKind;
  title: string;
  destinationType: string;
  destinationId?: string | null;
  destinationLocationId?: string | null;
  destinationVariantId?: string | null;
  destinationLabel: string;
  destinationPath: string;
  before?: MinkDraftContent;
  content: unknown;
}): Promise<MinkArtifact> {
  const { actor, kind } = input;
  assertDraftAuthority(actor, kind, true);
  if (!actor.runId) {
    throw new MinkToolInputError("The draft run is not available. Try again.");
  }
  const title = boundedText(input.title, "title", 200);
  const destinationType = boundedText(
    input.destinationType,
    "destination type",
    80,
  );
  const destinationLabel = boundedText(
    input.destinationLabel,
    "destination label",
    200,
  );
  if (
    !input.destinationPath.startsWith("/dashboard") ||
    input.destinationPath.length > 500
  ) {
    throw new MinkToolInputError("The draft destination is invalid.");
  }
  const content = normalizeForTool(kind, input.content);
  const before = normalizeOptionalContent(kind, input.before);
  const expectedCredits = MINK_DRAFT_CONFIG[kind].expectedCredits;
  const draftId = crypto.randomUUID();
  const planCap = limitsFor(actor.effectivePlan).aiGenerationsPerMonth;

  return withService(async (db) => {
    await db.insert(minkDrafts).values({
      id: draftId,
      storeId: actor.storeId,
      adminId: actor.adminId,
      runId: actor.runId!,
      kind,
      destinationType,
      destinationId: input.destinationId ?? null,
      locationId: input.destinationLocationId ?? null,
      variantId: input.destinationVariantId ?? null,
      destinationLabel,
      destinationPath: input.destinationPath,
      title,
      beforeJson: before,
      contentJson: content,
      expectedCredits,
    });

    const charge = await db.execute(sql`
      select public.consume_mink_draft_credits(
        p_store => ${actor.storeId}::uuid,
        p_admin => ${actor.adminId},
        p_run => ${actor.runId}::uuid,
        p_draft => ${draftId}::uuid,
        p_period => ${currentPeriod()},
        p_plan_cap => ${planCap},
        p_credits => ${expectedCredits},
        p_kind => ${kind}
      ) as source
    `);
    const source = (charge.rows[0] as { source?: string } | undefined)?.source;
    if (source === "insufficient") {
      await db
        .delete(minkDrafts)
        .where(
          and(
            eq(minkDrafts.id, draftId),
            eq(minkDrafts.storeId, actor.storeId),
          ),
        );
      throw new MinkToolInputError(
        `This ${MINK_DRAFT_CONFIG[kind].label.toLocaleLowerCase("en-IN")} needs ${expectedCredits} AI credits. The store's monthly allowance and AI-credit balance do not have enough remaining.`,
      );
    }
    if (!isCreditSource(source)) {
      throw new Error("Mink draft charge did not return a valid source");
    }
    const chargedCredits = source === "plan_unlimited" ? 0 : expectedCredits;
    await db
      .update(minkDrafts)
      .set({ creditSource: source, chargedCredits })
      .where(
        and(eq(minkDrafts.id, draftId), eq(minkDrafts.storeId, actor.storeId)),
      );

    return {
      type: "proposal",
      draftId,
      draftKind: kind,
      title,
      destinationLabel,
      destinationPath: input.destinationPath,
      before: minkDraftFields(kind, before),
      after: minkDraftFields(kind, content),
      content,
      status: "proposed",
      currentVersion: 0,
      expectedCredits,
      chargedCredits,
      creditSource: source,
    };
  });
}

export async function getMinkDraft(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkDraftState> {
  const state = await withService(async (db) => {
    const draft = await selectOwnedDraft(db, actor, draftId);
    const versions = await db
      .select({
        version: minkDraftVersions.version,
        action: minkDraftVersions.action,
        createdAt: minkDraftVersions.createdAt,
        createdBy: minkDraftVersions.createdBy,
      })
      .from(minkDraftVersions)
      .where(
        and(
          eq(minkDraftVersions.draftId, draftId),
          eq(minkDraftVersions.storeId, actor.storeId),
        ),
      )
      .orderBy(desc(minkDraftVersions.version))
      .limit(10);
    return toDraftState(draft, versions);
  });
  return {
    ...state,
    lastProductAction:
      state.kind === "product_description" || state.kind === "product_seo"
        ? await getLatestMinkProductAction(actor, draftId)
        : null,
    lastDomainAction: domainActionToolForKind(state.kind)
      ? await getLatestMinkDomainAction(actor, draftId)
      : null,
    lastInventoryAction:
      state.kind === "inventory_adjustment"
        ? await getLatestMinkInventoryAction(actor, draftId)
        : null,
    lastBulkInventoryAction:
      state.kind === "bulk_inventory_adjustment"
        ? await getLatestMinkBulkInventoryAction(actor, draftId)
        : null,
    lastBulkPriceAction:
      state.kind === "bulk_price_update"
        ? await getLatestMinkBulkPriceAction(actor, draftId)
        : null,
    lastOrderStatusAction:
      state.kind === "order_status_transition"
        ? await getLatestMinkOrderStatusAction(actor, draftId)
        : null,
    lastBlogPublication:
      state.kind === "blog"
        ? await getLatestMinkBlogPublication(actor, draftId)
        : null,
    lastCampaign:
      state.kind === "coupon_email"
        ? await getLatestMinkCampaign(actor, draftId)
        : null,
  };
}

function domainActionToolForKind(kind: MinkDraftKind) {
  return (
    kind === "product_create" ||
    kind === "coupon_create" ||
    kind === "coupon_update" ||
    kind === "customer_group_create" ||
    kind === "customer_group_update"
  );
}

export async function saveMinkDraftVersion(input: {
  actor: MinkActorContext;
  draftId: string;
  expectedVersion: number;
  content: unknown;
}): Promise<MinkDraftState> {
  return mutateDraft(input.actor, input.draftId, async (db, draft) => {
    assertEditableDraft(draft.kind);
    assertExpectedVersion(draft.currentVersion, input.expectedVersion);
    const content = normalizeForRequest(draft.kind, input.content);
    const version = draft.currentVersion + 1;
    const now = new Date().toISOString();
    await db.insert(minkDraftVersions).values({
      draftId: draft.id,
      storeId: draft.storeId,
      version,
      contentJson: content,
      action: "save",
      createdBy: input.actor.adminId,
    });
    await db
      .update(minkDrafts)
      .set({
        contentJson: content,
        status: "draft",
        currentVersion: version,
        updatedAt: now,
      })
      .where(
        and(
          eq(minkDrafts.id, draft.id),
          eq(minkDrafts.storeId, draft.storeId),
          eq(minkDrafts.adminId, input.actor.adminId),
        ),
      );
    return draft.id;
  });
}

export async function rollbackMinkDraftVersion(input: {
  actor: MinkActorContext;
  draftId: string;
  expectedVersion: number;
  targetVersion: number;
}): Promise<MinkDraftState> {
  return mutateDraft(input.actor, input.draftId, async (db, draft) => {
    assertEditableDraft(draft.kind);
    assertExpectedVersion(draft.currentVersion, input.expectedVersion);
    if (
      !Number.isInteger(input.targetVersion) ||
      input.targetVersion < 1 ||
      input.targetVersion > draft.currentVersion
    ) {
      throw new MinkRequestError(
        "mink_draft_version_invalid",
        "Choose a saved draft version to restore.",
        400,
      );
    }
    const targetRows = await db
      .select({ content: minkDraftVersions.contentJson })
      .from(minkDraftVersions)
      .where(
        and(
          eq(minkDraftVersions.draftId, draft.id),
          eq(minkDraftVersions.storeId, draft.storeId),
          eq(minkDraftVersions.version, input.targetVersion),
        ),
      )
      .limit(1);
    if (!targetRows[0]) {
      throw new MinkRequestError(
        "mink_draft_version_missing",
        "That draft version is no longer available.",
        404,
      );
    }
    const content = normalizeForRequest(draft.kind, targetRows[0].content);
    const version = draft.currentVersion + 1;
    const now = new Date().toISOString();
    await db.insert(minkDraftVersions).values({
      draftId: draft.id,
      storeId: draft.storeId,
      version,
      contentJson: content,
      action: "rollback",
      createdBy: input.actor.adminId,
      sourceVersion: input.targetVersion,
    });
    await db
      .update(minkDrafts)
      .set({ contentJson: content, currentVersion: version, updatedAt: now })
      .where(
        and(
          eq(minkDrafts.id, draft.id),
          eq(minkDrafts.storeId, draft.storeId),
          eq(minkDrafts.adminId, input.actor.adminId),
        ),
      );
    return draft.id;
  });
}

function assertEditableDraft(kind: MinkDraftKind): void {
  if (kind !== "storefront_custom_code") return;
  throw new MinkRequestError(
    "mink_storefront_preview_immutable",
    "This Phase 7B code proposal is preview-only. It cannot be edited, saved or restored.",
    409,
  );
}

async function mutateDraft(
  actor: MinkActorContext,
  draftId: string,
  mutation: (
    db: Db,
    draft: Awaited<ReturnType<typeof selectOwnedDraft>>,
  ) => Promise<string>,
): Promise<MinkDraftState> {
  await withService(async (db) => {
    await db.execute(sql`
      select id from public.mink_drafts
      where id = ${draftId}::uuid and store_id = ${actor.storeId}::uuid
        and admin_id = ${actor.adminId}
      for update
    `);
    const draft = await selectOwnedDraft(db, actor, draftId);
    await mutation(db, draft);
  });
  return getMinkDraft(actor, draftId);
}

async function selectOwnedDraft(
  db: Db,
  actor: MinkActorContext,
  draftId: string,
) {
  const rows = await db
    .select({
      id: minkDrafts.id,
      storeId: minkDrafts.storeId,
      kind: minkDrafts.kind,
      title: minkDrafts.title,
      status: minkDrafts.status,
      destinationLabel: minkDrafts.destinationLabel,
      destinationPath: minkDrafts.destinationPath,
      before: minkDrafts.beforeJson,
      content: minkDrafts.contentJson,
      currentVersion: minkDrafts.currentVersion,
      expectedCredits: minkDrafts.expectedCredits,
      chargedCredits: minkDrafts.chargedCredits,
      creditSource: minkDrafts.creditSource,
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
  if (!draft || !isMinkDraftKind(draft.kind)) {
    throw new MinkRequestError(
      "mink_draft_not_found",
      "This private draft is not available.",
      404,
    );
  }
  assertDraftAuthority(actor, draft.kind, false);
  if (
    (draft.status !== "proposed" && draft.status !== "draft") ||
    !isCreditSource(draft.creditSource)
  ) {
    throw new MinkRequestError(
      "mink_draft_unavailable",
      "This private draft is not available.",
      409,
    );
  }
  return {
    ...draft,
    kind: draft.kind,
    status: draft.status as "proposed" | "draft",
    creditSource: draft.creditSource as MinkDraftCreditSource,
  };
}

function toDraftState(
  draft: Awaited<ReturnType<typeof selectOwnedDraft>>,
  versions: Array<{
    version: number;
    action: string;
    createdAt: string;
    createdBy: string;
  }>,
): MinkDraftState {
  return {
    id: draft.id,
    kind: draft.kind,
    title: draft.title,
    status: draft.status,
    destinationLabel: draft.destinationLabel,
    destinationPath: draft.destinationPath,
    before: normalizeOptionalContent(draft.kind, draft.before),
    content: normalizeForRequest(draft.kind, draft.content),
    currentVersion: draft.currentVersion,
    expectedCredits: draft.expectedCredits,
    chargedCredits: draft.chargedCredits,
    creditSource: draft.creditSource,
    versions: versions.flatMap((version) =>
      version.action === "save" || version.action === "rollback"
        ? [
            {
              version: version.version,
              action: version.action,
              createdAt: version.createdAt,
              createdBy: version.createdBy,
            },
          ]
        : [],
    ),
    lastProductAction: null,
    lastDomainAction: null,
    lastInventoryAction: null,
    lastBulkInventoryAction: null,
    lastBulkPriceAction: null,
    lastOrderStatusAction: null,
    lastBlogPublication: null,
    lastCampaign: null,
  };
}

function assertDraftAuthority(
  actor: MinkActorContext,
  kind: MinkDraftKind,
  forTool: boolean,
) {
  const permission = DRAFT_PERMISSION[kind];
  const allowed =
    actor.draftingEnabled === true &&
    can(
      actor.permissions,
      permission.section,
      permission.action,
      actor.isSuperadmin,
    );
  if (allowed) return;
  if (forTool) {
    throw new MinkToolInputError(
      "Private drafting is not enabled or permitted for this admin.",
    );
  }
  throw new MinkRequestError(
    "mink_draft_access_denied",
    "You don't have permission to use this private draft.",
    403,
  );
}

function assertExpectedVersion(current: number, expected: number) {
  if (!Number.isInteger(expected) || expected < 0) {
    throw new MinkRequestError(
      "mink_draft_version_invalid",
      "The draft version is invalid.",
      400,
    );
  }
  if (current !== expected) {
    throw new MinkRequestError(
      "mink_draft_version_conflict",
      "This draft changed in another tab. Reload it before saving.",
      409,
    );
  }
}

function normalizeForTool(kind: MinkDraftKind, content: unknown) {
  try {
    return normalizeMinkDraftContent(kind, content);
  } catch (error) {
    throw new MinkToolInputError(
      error instanceof Error ? error.message : "The draft content is invalid.",
    );
  }
}

function normalizeForRequest(kind: MinkDraftKind, content: unknown) {
  try {
    return normalizeMinkDraftContent(kind, content);
  } catch (error) {
    throw new MinkRequestError(
      "mink_draft_content_invalid",
      error instanceof Error ? error.message : "The draft content is invalid.",
      400,
    );
  }
}

function normalizeOptionalContent(
  kind: MinkDraftKind,
  content: unknown,
): MinkDraftContent {
  const raw =
    content && typeof content === "object" && !Array.isArray(content)
      ? (content as Record<string, unknown>)
      : {};
  const result: MinkDraftContent = {};
  for (const field of MINK_DRAFT_CONFIG[kind].fields) {
    const value = raw[field.key];
    result[field.key] =
      typeof value === "string" ? value.slice(0, field.maxLength) : "";
  }
  return result;
}

function boundedText(value: string, field: string, maxLength: number) {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maxLength) {
    throw new MinkToolInputError(
      `${field} must be between 1 and ${maxLength} characters.`,
    );
  }
  return normalized;
}

function isCreditSource(value: unknown): value is MinkDraftCreditSource {
  return (
    value === "plan" ||
    value === "credit" ||
    value === "mixed" ||
    value === "plan_unlimited"
  );
}

/** Used by the run ledger after the proposal transaction has completed. */
export async function getMinkRunDraftUsage(
  db: Db,
  storeId: string,
  runId: string,
): Promise<{ chargedCredits: number; proposalCount: number }> {
  const rows = await db
    .select({
      charged: sql<number>`coalesce(sum(${minkDraftCreditUsage.chargedCredits}), 0)::int`,
      proposals: sql<number>`count(*)::int`,
    })
    .from(minkDraftCreditUsage)
    .where(
      and(
        eq(minkDraftCreditUsage.storeId, storeId),
        eq(minkDraftCreditUsage.runId, runId),
      ),
    );
  return {
    chargedCredits: Number(rows[0]?.charged ?? 0),
    proposalCount: Number(rows[0]?.proposals ?? 0),
  };
}

/** Compensate proposals the user never receives when the enclosing run fails. */
export async function discardFailedMinkRunDrafts(
  db: Db,
  storeId: string,
  runId: string,
): Promise<void> {
  await db.execute(sql`
    select public.discard_failed_mink_run_drafts(
      ${storeId}::uuid,
      ${runId}::uuid
    )
  `);
}
