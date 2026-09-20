import "server-only";

import { createHash } from "node:crypto";
import { and, count, desc, eq, ne, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  couponUserGroups,
  coupons,
  minkActionApprovals,
  minkActionAudit,
  minkActionToolAccess,
  minkDrafts,
  orderItems,
  orders,
  products,
  productVariants,
  userGroupMembers,
  offers,
  stores,
  userGroups,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import {
  assertCanActivateOffer,
  assertCanCreateCustomerGroup,
  assertCanCreateProduct,
  PlanEntitlementError,
} from "@/lib/plans/entitlements";
import { slugify } from "@/lib/slug";
import {
  domainActionFields,
  domainActionToolForDraftKind,
  isCreateDomainTool,
  isMinkDomainResourceType,
  resourceTypeForDomainTool,
  type MinkDomainActionApproval,
  type MinkDomainActionResult,
  type MinkDomainActionValues,
  type MinkDomainResourceType,
} from "./domain-action-types";
import { normalizeMinkDraftContent } from "./draft-types";
import { MinkRequestError } from "./errors";
import {
  canonicalMinkTimestamp,
  canonicalOptionalMinkTimestamp,
} from "./timestamps";
import {
  isMinkDomainActionTool,
  type MinkDomainActionTool,
  type MinkProductActionOperation,
  type MinkProductActionStatus,
} from "./product-action-types";
import type { MinkActorContext } from "./types";
import { resolveRawNumberSetting } from "@/lib/settings/registry";
import { selectOwnedStorefrontImageUrls } from "./storefront-media-read";

const APPROVAL_TTL_MS = 10 * 60 * 1_000;
const TOOL_VERSION = 1;
const GROUP_COLORS = new Set(["blue", "green", "amber", "violet", "grey"]);

export async function getLatestMinkDomainAction(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkDomainActionResult | null> {
  return withService(async (db) => {
    const rows = await db
      .select()
      .from(minkActionApprovals)
      .where(
        and(
          eq(minkActionApprovals.storeId, actor.storeId),
          eq(minkActionApprovals.adminId, actor.adminId),
          eq(minkActionApprovals.draftId, draftId),
          eq(minkActionApprovals.status, "executed"),
        ),
      )
      .orderBy(desc(minkActionApprovals.executedAt))
      .limit(1);
    if (!rows[0] || !isMinkDomainActionTool(rows[0].toolName)) return null;
    const approval = validateDomainApprovalRow(rows[0]);
    assertDomainActionAuthority(actor, approval.toolName);
    const audit = await readApprovalAudit(db, actor.storeId, approval.id);
    return {
      approval: toDomainApproval(approval),
      auditId: audit?.id ?? null,
      repeated: true,
    };
  });
}

export async function previewMinkDomainAction(input: {
  actor: MinkActorContext;
  draftId: string;
  expectedDraftVersion: number;
  idempotencyKey: string;
}): Promise<MinkDomainActionApproval> {
  return withDomainErrors(async () =>
    withService(async (db) => {
      await lockOwnedDraft(db, input.actor, input.draftId);
      const draft = await readSavedDomainDraft(db, input.actor, input.draftId);
      if (draft.currentVersion !== input.expectedDraftVersion) {
        throw draftConflict();
      }
      const tool = domainActionToolForDraftKind(draft.kind);
      if (!tool) throw unsupportedDraft();
      assertDomainActionAuthority(input.actor, tool);
      await assertToolEnabled(db, input.actor.storeId, tool);

      const content = normalizeDomainDraft(draft.kind, draft.content);
      let resource: ResourceRow | null = null;
      let before: MinkDomainActionValues = emptyValues(tool);
      if (!isCreateDomainTool(tool)) {
        if (!draft.destinationId) throw unsupportedDraft();
        resource = await readResource(
          db,
          input.actor.storeId,
          resourceTypeForDomainTool(tool),
          draft.destinationId,
        );
        before = resourceValues(tool, resource);
        assertResourceEligible(tool, resource);
      }
      const after = normalizeProposedValues(tool, content, before);
      await assertOwnedProductImage(
        db,
        input.actor.storeId,
        tool,
        after.image_url,
      );
      if (resource && sameValues(tool, before, after)) {
        throw new MinkRequestError(
          "mink_action_no_change",
          "This saved proposal already matches the destination.",
          409,
        );
      }
      await assertNoUniqueConflict(
        db,
        input.actor.storeId,
        tool,
        after,
        resource?.id ?? null,
      );
      return createApproval(db, {
        actor: input.actor,
        draftId: draft.id,
        draftVersion: draft.currentVersion,
        tool,
        operation: "apply",
        sourceApprovalId: null,
        resourceType: resourceTypeForDomainTool(tool),
        resourceId: resource?.id ?? null,
        resourceVersion: resource?.version ?? null,
        resourceLabel: resource?.label ?? labelFromValues(tool, after),
        before,
        after,
        idempotencyKey: input.idempotencyKey,
      });
    }),
  );
}

export async function previewMinkDomainActionRollback(input: {
  actor: MinkActorContext;
  draftId: string;
  sourceApprovalId: string;
  idempotencyKey: string;
}): Promise<MinkDomainActionApproval> {
  return withDomainErrors(async () =>
    withService(async (db) => {
      await lockOwnedApproval(db, input.actor, input.sourceApprovalId);
      const source = await readOwnedDomainApproval(
        db,
        input.actor,
        input.sourceApprovalId,
      );
      if (source.draftId !== input.draftId) throw approvalNotFound();
      assertDomainActionAuthority(input.actor, source.toolName);
      if (source.status !== "executed" || source.operation !== "apply") {
        throw rollbackUnavailable();
      }
      await assertToolEnabled(db, input.actor.storeId, source.toolName);
      if (!source.resultId || !source.resultVersion) {
        throw rollbackUnavailable();
      }
      const resource = await readResource(
        db,
        input.actor.storeId,
        source.resourceType,
        source.resultId,
      );
      const current = resourceValues(source.toolName, resource);
      const sourceAfter = readStoredValues(source.toolName, source.afterJson);
      if (
        resource.version !== source.resultVersion ||
        !sameValues(source.toolName, current, sourceAfter)
      ) {
        throw resourceConflict(source.resourceType, "after this Mink action");
      }
      if (isCreateDomainTool(source.toolName)) {
        await assertSafeCreateRollback(db, source.toolName, resource);
      }
      return createApproval(db, {
        actor: input.actor,
        draftId: source.draftId,
        draftVersion: source.draftVersion,
        tool: source.toolName,
        operation: "rollback",
        sourceApprovalId: source.id,
        resourceType: source.resourceType,
        resourceId: resource.id,
        resourceVersion: resource.version,
        resourceLabel: resource.label,
        before: current,
        after: readStoredValues(source.toolName, source.beforeJson),
        idempotencyKey: input.idempotencyKey,
      });
    }),
  );
}

export async function executeMinkDomainAction(input: {
  actor: MinkActorContext;
  draftId: string;
  approvalId: string;
}): Promise<MinkDomainActionResult> {
  return withDomainErrors(async () => {
    const outcome = await withService(async (db) => {
      await lockOwnedApproval(db, input.actor, input.approvalId);
      const approval = await readOwnedDomainApproval(
        db,
        input.actor,
        input.approvalId,
      );
      if (approval.draftId !== input.draftId) throw approvalNotFound();
      assertDomainActionAuthority(input.actor, approval.toolName);

      if (approval.status === "executed") {
        const audit = await readApprovalAudit(
          db,
          input.actor.storeId,
          approval.id,
        );
        return {
          result: {
            approval: toDomainApproval(approval),
            auditId: audit?.id ?? null,
            repeated: true,
          },
        };
      }
      if (approval.status !== "pending") return terminalError(approval.status);
      await assertToolEnabled(db, input.actor.storeId, approval.toolName, true);

      const before = readStoredValues(approval.toolName, approval.beforeJson);
      const after = readStoredValues(approval.toolName, approval.afterJson);
      if (Date.parse(approval.expiresAt) <= Date.now()) {
        const auditId = await finalizeWithoutWrite(db, approval, {
          status: "expired",
          detail: "Approval expired before execution.",
        });
        return {
          error: new MinkRequestError(
            "mink_action_approval_expired",
            "This approval expired. Review the latest proposal and create a new preview.",
            409,
          ),
          auditId,
        };
      }

      if (approval.operation === "apply") {
        if (await hasDraftConflict(db, input.actor, approval)) {
          const auditId = await finalizeWithoutWrite(db, approval, {
            status: "conflicted",
            detail: "The saved private proposal changed after preview.",
          });
          return {
            error: new MinkRequestError(
              "mink_action_draft_conflict",
              "The private proposal changed after this preview. Review it again before applying.",
              409,
            ),
            auditId,
          };
        }
      } else if (await hasRollbackSourceConflict(db, input.actor, approval)) {
        const auditId = await finalizeWithoutWrite(db, approval, {
          status: "conflicted",
          detail: "The source action is no longer a valid rollback checkpoint.",
        });
        return {
          error: new MinkRequestError(
            "mink_action_rollback_conflict",
            "The rollback checkpoint is no longer valid. Review the current destination.",
            409,
          ),
          auditId,
        };
      }

      let current: ResourceRow | null = null;
      if (approval.resourceId) {
        current = await readResource(
          db,
          input.actor.storeId,
          approval.resourceType,
          approval.resourceId,
        );
        if (
          current.version !== approval.resourceVersion ||
          !sameValues(
            approval.toolName,
            resourceValues(approval.toolName, current),
            before,
          )
        ) {
          const auditId = await finalizeWithoutWrite(db, approval, {
            status: "conflicted",
            detail: "The destination changed after preview.",
            resourceVersionAfter: current.version,
          });
          return {
            error: resourceConflict(approval.resourceType, "after preview"),
            auditId,
          };
        }
      } else if (!isCreateDomainTool(approval.toolName)) {
        throw invalidApproval();
      }

      const mutation =
        approval.operation === "rollback" &&
        isCreateDomainTool(approval.toolName)
          ? await deleteCreatedResource(db, approval, current)
          : await writeResource(db, input.actor, approval, after, current);
      const now = new Date().toISOString();
      await db
        .update(minkActionApprovals)
        .set({
          status: "executed",
          approvedAt: now,
          executedAt: now,
          resultId: mutation.id,
          resultVersion: mutation.version,
          resourceLabel: mutation.label,
          updatedAt: now,
        })
        .where(
          and(
            eq(minkActionApprovals.id, approval.id),
            eq(minkActionApprovals.storeId, input.actor.storeId),
          ),
        );

      const auditId = crypto.randomUUID();
      await db.insert(minkActionAudit).values({
        id: auditId,
        approvalId: approval.id,
        storeId: approval.storeId,
        adminId: approval.adminId,
        draftId: approval.draftId,
        productId: null,
        resourceType: approval.resourceType,
        resourceId: approval.resourceId,
        resourceVersionBefore: approval.resourceVersion,
        resourceVersionAfter: mutation.version,
        resultId: mutation.id,
        toolName: approval.toolName,
        operation: approval.operation,
        outcome: "executed",
        beforeJson: before,
        afterJson: after,
        productVersionBefore: null,
        productVersionAfter: null,
        requestHash: approval.requestHash,
        toolVersion: TOOL_VERSION,
        detail: mutation.detail,
      });
      const executed = {
        ...approval,
        status: "executed" as const,
        approvedAt: now,
        executedAt: now,
        resultId: mutation.id,
        resultVersion: mutation.version,
        resourceLabel: mutation.label,
      };
      return {
        result: {
          approval: toDomainApproval(executed),
          auditId,
          repeated: false,
        },
      };
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.result;
  });
}

async function writeResource(
  db: Db,
  actor: MinkActorContext,
  approval: DomainApprovalRow,
  after: MinkDomainActionValues,
  current: ResourceRow | null,
): Promise<MutationResult> {
  await assertNoUniqueConflict(
    db,
    actor.storeId,
    approval.toolName,
    after,
    current?.id ?? null,
  );
  if (approval.toolName === "create_product") {
    await assertOwnedProductImage(
      db,
      actor.storeId,
      approval.toolName,
      after.image_url,
    );
    await assertCanCreateProduct(db, actor.storeId);
    await db.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`mink-product-slug:${actor.storeId}:${after.slug}`}, 0)
      )
    `);
    await assertNoUniqueConflict(
      db,
      actor.storeId,
      approval.toolName,
      after,
      null,
    );
    const [row] = await db
      .insert(products)
      .values({
        name: required(after.name),
        slug: required(after.slug),
        description: nullable(after.description),
        seoTitle: nullable(after.seo_title),
        seoDescription: nullable(after.seo_description),
        basePrice: Number(after.base_price),
        sellingPrice: Number(after.selling_price),
        status: "draft",
        trackInventory: false,
        imageUrl: nullable(after.image_url),
        images: after.image_url ? [after.image_url] : [],
        createdBy: actor.adminId,
        updatedBy: actor.adminId,
        storeId: actor.storeId,
      } as unknown as typeof products.$inferInsert)
      .returning({
        id: products.id,
        name: products.name,
        version: products.contentUpdatedAt,
      });
    if (!row) throw new Error("Product insert returned no row");
    return {
      id: row.id,
      version: row.version,
      label: row.name,
      detail: "Approved unpublished draft product created.",
    };
  }
  if (approval.toolName === "create_coupon") {
    const [row] = await db
      .insert(coupons)
      .values({
        ...couponUpdate(after),
        status: "disabled",
        showOnStorefront: false,
        usedCount: 0,
        createdBy: actor.adminId,
        updatedBy: actor.adminId,
        storeId: actor.storeId,
      })
      .returning({
        id: coupons.id,
        code: coupons.code,
        version: coupons.updatedAt,
      });
    if (!row) throw new Error("Coupon insert returned no row");
    return {
      id: row.id,
      version: row.version,
      label: `Coupon ${row.code}`,
      detail: "Approved disabled, hidden coupon created.",
    };
  }
  if (
    approval.toolName === "create_offer" ||
    approval.toolName === "update_offer" ||
    approval.toolName === "activate_offer"
  ) {
    return writeOffer(db, actor, approval, after, current);
  }
  if (approval.toolName === "create_customer_group") {
    await assertCanCreateCustomerGroup(db, actor.storeId);
    const [row] = await db
      .insert(userGroups)
      .values({
        name: required(after.name),
        description: nullable(after.description),
        color: required(after.color),
        createdBy: actor.adminId,
        storeId: actor.storeId,
      })
      .returning({
        id: userGroups.id,
        name: userGroups.name,
        version: userGroups.updatedAt,
      });
    if (!row) throw new Error("Customer-group insert returned no row");
    return {
      id: row.id,
      version: row.version,
      label: row.name,
      detail: "Approved customer-group metadata created without members.",
    };
  }
  if (!current || !approval.resourceVersion) throw invalidApproval();
  const now = new Date().toISOString();
  if (approval.toolName === "update_coupon") {
    assertResourceEligible(approval.toolName, current);
    const [row] = await db
      .update(coupons)
      .set({ ...couponUpdate(after), updatedBy: actor.adminId, updatedAt: now })
      .where(
        and(
          eq(coupons.id, current.id),
          eq(coupons.storeId, actor.storeId),
          eq(coupons.updatedAt, approval.resourceVersion),
          eq(coupons.status, "disabled"),
          eq(coupons.showOnStorefront, false),
        ),
      )
      .returning({
        id: coupons.id,
        code: coupons.code,
        version: coupons.updatedAt,
      });
    if (!row) throw resourceConflict("coupon", "during execution");
    return {
      id: row.id,
      version: row.version,
      label: `Coupon ${row.code}`,
      detail:
        "Approved disabled-coupon terms updated; activation and audience were unchanged.",
    };
  }
  const [row] = await db
    .update(userGroups)
    .set({
      name: required(after.name),
      description: nullable(after.description),
      color: required(after.color),
      updatedAt: now,
    })
    .where(
      and(
        eq(userGroups.id, current.id),
        eq(userGroups.storeId, actor.storeId),
        eq(userGroups.updatedAt, approval.resourceVersion),
      ),
    )
    .returning({
      id: userGroups.id,
      name: userGroups.name,
      version: userGroups.updatedAt,
    });
  if (!row) throw resourceConflict("customer_group", "during execution");
  return {
    id: row.id,
    version: row.version,
    label: row.name,
    detail:
      "Approved customer-group metadata updated; membership was unchanged.",
  };
}

/**
 * Create, update or activate an offer under an exact human approval.
 *
 * ★★ THREE TIGHTENINGS AN OFFER NEEDS THAT A COUPON DOES NOT (plan §14c), all
 * re-checked HERE rather than only at proposal time — the proposal is a
 * suggestion, this is the boundary.
 */
async function writeOffer(
  db: Db,
  actor: MinkActorContext,
  approval: DomainApprovalRow,
  after: MinkDomainActionValues,
  current: ResourceRow | null,
): Promise<MutationResult> {
  const budget = Number(after.budget);
  const rewardValue = Number(after.reward_value);
  const rewardType = after.reward_type;

  // ★★ 1. A BUDGET CAP IS MANDATORY. A coupon needs a customer to type it; an
  // automatic offer applies itself to every qualifying order from the instant
  // it goes live, and under best-offer-wins it applies whenever it is the most
  // generous rule present. The cap is the difference between a mistake that
  // costs a bounded amount and one that costs whatever the weekend's traffic
  // was. Refused here as well as in the proposal, because a saved proposal can
  // be replayed and the proposal form is not a security boundary.
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new MinkRequestError(
      "mink_offer_budget_required",
      "Mink can only create an offer with a total budget, so a mistake costs a bounded amount.",
      422,
    );
  }

  // ★★ 3. CAPPED IN DEPTH, not just in total. A budget bounds the damage over
  // time; a depth cap stops a single 80%-off order going out at all. Measured
  // against the store's OWN per-order ceiling, read here rather than trusted
  // from the approval — a merchant who tightened the ceiling after the
  // proposal was written must not have a stale limit applied.
  if (rewardType === "percent_off") {
    const ceiling = await readOfferDepthCeiling(db, actor.storeId);
    if (
      !Number.isFinite(rewardValue) ||
      rewardValue <= 0 ||
      rewardValue > ceiling
    ) {
      throw new MinkRequestError(
        "mink_offer_too_deep",
        `Mink can propose a discount of at most ${ceiling}% — this store's own limit for a single order.`,
        422,
      );
    }
  } else if (rewardType === "amount_off") {
    if (!Number.isFinite(rewardValue) || rewardValue <= 0) {
      throw new MinkRequestError(
        "mink_offer_invalid_reward",
        "An offer needs a discount above zero.",
        422,
      );
    }
  } else {
    // ★ THE REWARD SHAPE IS NARROW BY DESIGN. Bundles, gifts, ladders and free
    // delivery change stock, liability or delivery cost in ways a single
    // approval screen cannot show honestly, so they stay a human's job.
    throw new MinkRequestError(
      "mink_offer_reward_unsupported",
      "Mink can propose a percentage or a rupee amount off the order. Bundles, gifts, ladders and free delivery are set up by hand.",
      422,
    );
  }

  const minSubtotal = after.min_subtotal ? Number(after.min_subtotal) : null;
  const maxRedemptions = after.max_redemptions
    ? Math.trunc(Number(after.max_redemptions))
    : null;

  const shared = {
    name: required(after.name),
    description: nullable(after.description),
    rewardType: rewardType as string,
    rewardConfig:
      rewardType === "percent_off"
        ? { percent: rewardValue }
        : { amount: rewardValue },
    triggerType: minSubtotal && minSubtotal > 0 ? "min_subtotal" : "always",
    triggerConfig: minSubtotal && minSubtotal > 0 ? { minSubtotal } : {},
    budgetPaise: Math.round(budget * 100),
    maxRedemptions:
      maxRedemptions && maxRedemptions > 0 ? maxRedemptions : null,
    validUntil: after.valid_until,
    updatedBy: actor.adminId,
    updatedAt: new Date().toISOString(),
  };

  if (approval.toolName === "create_offer") {
    // ★★ 2. CREATED DISABLED, ALWAYS — activation is its own approval. A
    // disabled offer costs exactly nothing, so the review can take as long as
    // it needs. Written literally rather than from `after.status`, so even a
    // tampered approval payload cannot produce a live offer.
    const [row] = await db
      .insert(offers)
      .values({
        ...shared,
        storeId: actor.storeId,
        status: "disabled",
        delivery: "automatic",
        // Website only. A register offer Mink proposed would start discounting
        // in-person sales the merchant is standing in front of.
        channels: ["storefront"],
        createdBy: actor.adminId,
      })
      .returning({
        id: offers.id,
        name: offers.name,
        version: offers.updatedAt,
      });
    if (!row) throw new Error("Offer insert returned no row");
    return {
      id: row.id,
      version: row.version,
      label: row.name,
      detail: "Approved offer created, switched off and awaiting activation.",
    };
  }

  if (!current || current.type !== "offer") {
    throw resourceNotFound("offer");
  }

  if (approval.toolName === "activate_offer") {
    // ★ The plan cap is re-checked at the moment of activation, not at
    // proposal time: a store that has since dropped to a plan with fewer
    // active offers must not have Mink push it over.
    await assertCanActivateOffer(db, actor.storeId, current.id);
    const [row] = await db
      .update(offers)
      .set({
        status: "active",
        updatedBy: actor.adminId,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(offers.id, current.id),
          eq(offers.storeId, actor.storeId),
          // ★ Only from disabled. Re-activating an already-live offer is a
          // no-op that would still write an audit row saying somebody turned
          // it on.
          eq(offers.status, "disabled"),
        ),
      )
      .returning({
        id: offers.id,
        name: offers.name,
        version: offers.updatedAt,
      });
    if (!row) throw resourceConflict("offer", "during activation");
    return {
      id: row.id,
      version: row.version,
      label: row.name,
      detail: "Approved offer switched on.",
    };
  }

  const [row] = await db
    .update(offers)
    .set({ ...shared, status: "disabled" })
    .where(
      and(
        eq(offers.id, current.id),
        eq(offers.storeId, actor.storeId),
        // ★ Terms change only while the offer is OFF, the coupon rule (4C)
        // carrying more weight here: editing a live automatic offer changes
        // what every cart in flight is being quoted.
        eq(offers.status, "disabled"),
      ),
    )
    .returning({
      id: offers.id,
      name: offers.name,
      version: offers.updatedAt,
    });
  if (!row) throw resourceConflict("offer", "during update");
  return {
    id: row.id,
    version: row.version,
    label: row.name,
    detail: "Approved offer terms updated while switched off.",
  };
}

/**
 * The store's own per-order discount ceiling.
 *
 * ★ FAILS TO THE REGISTRY DEFAULT, never to 100. An unreadable settings row
 * must not become permission for an 80%-off offer.
 */
async function readOfferDepthCeiling(db: Db, storeId: string): Promise<number> {
  try {
    const rows = await db
      .select({ settings: stores.settings })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    const features = ((rows[0]?.settings as Record<string, unknown> | null)
      ?.features ?? {}) as Record<string, unknown>;
    // ★ Through the registry, which owns the default, the floor and the
    // ceiling. Gating on `value > 0` here read a deliberate 0 — "stop offers
    // discounting anything" — as unset and handed back 50%.
    return resolveRawNumberSetting(
      "offers.maxTotalDiscountPercent",
      features["offers.maxTotalDiscountPercent"],
    );
  } catch {
    // An unreadable store falls back to the registry default, not to no
    // ceiling at all.
    return resolveRawNumberSetting("offers.maxTotalDiscountPercent", undefined);
  }
}

async function deleteCreatedResource(
  db: Db,
  approval: DomainApprovalRow,
  current: ResourceRow | null,
): Promise<MutationResult> {
  if (!current || !approval.resourceVersion) throw invalidApproval();
  await assertSafeCreateRollback(db, approval.toolName, current);
  if (approval.toolName === "create_product") {
    const rows = await db
      .delete(products)
      .where(
        and(
          eq(products.id, current.id),
          eq(products.storeId, approval.storeId),
          eq(products.contentUpdatedAt, approval.resourceVersion),
          eq(products.status, "draft"),
        ),
      )
      .returning({ id: products.id });
    if (!rows[0]) throw resourceConflict("product", "during rollback");
  } else if (approval.toolName === "create_coupon") {
    const rows = await db
      .delete(coupons)
      .where(
        and(
          eq(coupons.id, current.id),
          eq(coupons.storeId, approval.storeId),
          eq(coupons.updatedAt, approval.resourceVersion),
          eq(coupons.status, "disabled"),
          eq(coupons.showOnStorefront, false),
          eq(coupons.usedCount, 0),
        ),
      )
      .returning({ id: coupons.id });
    if (!rows[0]) throw resourceConflict("coupon", "during rollback");
  } else if (approval.toolName === "create_offer") {
    const rows = await db
      .delete(offers)
      .where(
        and(
          eq(offers.id, current.id),
          eq(offers.storeId, approval.storeId),
          eq(offers.updatedAt, approval.resourceVersion),
          // ★ THE SAME THREE FACTS `assertSafeCreateRollback` CHECKED, re-checked
          // inside the statement that deletes. A human can switch the offer on
          // or it can price an order between the read and the write, and
          // `offer_redemptions` and `order_item_offers` point at this row —
          // deleting it then would orphan the attribution behind every line it
          // discounted.
          eq(offers.status, "disabled"),
          eq(offers.redemptionCount, 0),
          eq(offers.spentPaise, 0),
        ),
      )
      .returning({ id: offers.id });
    if (!rows[0]) throw resourceConflict("offer", "during rollback");
  } else if (approval.toolName === "create_customer_group") {
    const rows = await db
      .delete(userGroups)
      .where(
        and(
          eq(userGroups.id, current.id),
          eq(userGroups.storeId, approval.storeId),
          eq(userGroups.updatedAt, approval.resourceVersion),
        ),
      )
      .returning({ id: userGroups.id });
    if (!rows[0]) throw resourceConflict("customer_group", "during rollback");
  } else {
    throw invalidApproval();
  }
  return {
    id: current.id,
    version: null,
    label: current.label,
    detail:
      "Approved safe rollback removed the unchanged, unused record created by Mink.",
  };
}

async function createApproval(
  db: Db,
  input: {
    actor: MinkActorContext;
    draftId: string;
    draftVersion: number;
    tool: MinkDomainActionTool;
    operation: MinkProductActionOperation;
    sourceApprovalId: string | null;
    resourceType: MinkDomainResourceType;
    resourceId: string | null;
    resourceVersion: string | null;
    resourceLabel: string;
    before: MinkDomainActionValues;
    after: MinkDomainActionValues;
    idempotencyKey: string;
  },
) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const requestHash = hashRequest({
    storeId: input.actor.storeId,
    adminId: input.actor.adminId,
    draftId: input.draftId,
    draftVersion: input.draftVersion,
    tool: input.tool,
    operation: input.operation,
    sourceApprovalId: input.sourceApprovalId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    resourceVersion: input.resourceVersion,
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
      productVersion: null,
      sourceApprovalId: input.sourceApprovalId,
      toolName: input.tool,
      operation: input.operation,
      draftVersion: input.draftVersion,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      resourceVersion: input.resourceVersion,
      resourceLabel: input.resourceLabel,
      beforeJson: input.before,
      afterJson: input.after,
      requestHash,
      idempotencyKey: input.idempotencyKey,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0]
    ? validateDomainApprovalRow(inserted[0])
    : await readApprovalByIdempotency(db, input.actor, input.idempotencyKey);
  if (row.requestHash !== requestHash) {
    throw new MinkRequestError(
      "mink_action_idempotency_conflict",
      "This approval request key was already used for a different preview.",
      409,
    );
  }
  return toDomainApproval(row);
}

async function hasDraftConflict(
  db: Db,
  actor: MinkActorContext,
  approval: DomainApprovalRow,
) {
  await lockOwnedDraft(db, actor, approval.draftId);
  try {
    const draft = await readSavedDomainDraft(db, actor, approval.draftId);
    if (draft.currentVersion !== approval.draftVersion) return true;
    if (domainActionToolForDraftKind(draft.kind) !== approval.toolName)
      return true;
    const content = normalizeDomainDraft(draft.kind, draft.content);
    const proposed = normalizeProposedValues(
      approval.toolName,
      content,
      readStoredValues(approval.toolName, approval.beforeJson),
    );
    return !sameValues(
      approval.toolName,
      proposed,
      readStoredValues(approval.toolName, approval.afterJson),
    );
  } catch (error) {
    if (error instanceof MinkRequestError) return true;
    throw error;
  }
}

async function hasRollbackSourceConflict(
  db: Db,
  actor: MinkActorContext,
  approval: DomainApprovalRow,
) {
  if (!approval.sourceApprovalId) return true;
  await lockOwnedApproval(db, actor, approval.sourceApprovalId);
  const source = await readOwnedDomainApproval(
    db,
    actor,
    approval.sourceApprovalId,
  );
  return (
    source.status !== "executed" ||
    source.operation !== "apply" ||
    source.toolName !== approval.toolName ||
    source.resultId !== approval.resourceId ||
    source.resultVersion !== approval.resourceVersion ||
    !sameValues(
      approval.toolName,
      readStoredValues(approval.toolName, approval.beforeJson),
      readStoredValues(approval.toolName, source.afterJson),
    ) ||
    !sameValues(
      approval.toolName,
      readStoredValues(approval.toolName, approval.afterJson),
      readStoredValues(approval.toolName, source.beforeJson),
    )
  );
}

async function finalizeWithoutWrite(
  db: Db,
  approval: DomainApprovalRow,
  input: {
    status: "conflicted" | "expired";
    detail: string;
    resourceVersionAfter?: string | null;
  },
) {
  const now = new Date().toISOString();
  await db
    .update(minkActionApprovals)
    .set({ status: input.status, updatedAt: now })
    .where(
      and(
        eq(minkActionApprovals.id, approval.id),
        eq(minkActionApprovals.storeId, approval.storeId),
      ),
    );
  const id = crypto.randomUUID();
  await db.insert(minkActionAudit).values({
    id,
    approvalId: approval.id,
    storeId: approval.storeId,
    adminId: approval.adminId,
    draftId: approval.draftId,
    productId: null,
    resourceType: approval.resourceType,
    resourceId: approval.resourceId,
    resourceVersionBefore: approval.resourceVersion,
    resourceVersionAfter: input.resourceVersionAfter ?? null,
    resultId: null,
    toolName: approval.toolName,
    operation: approval.operation,
    outcome: input.status,
    beforeJson: readStoredValues(approval.toolName, approval.beforeJson),
    afterJson: readStoredValues(approval.toolName, approval.afterJson),
    productVersionBefore: null,
    productVersionAfter: null,
    requestHash: approval.requestHash,
    toolVersion: TOOL_VERSION,
    detail: input.detail,
  });
  return id;
}

async function readSavedDomainDraft(
  db: Db,
  actor: MinkActorContext,
  draftId: string,
) {
  const rows = await db
    .select({
      id: minkDrafts.id,
      kind: minkDrafts.kind,
      status: minkDrafts.status,
      destinationId: minkDrafts.destinationId,
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
  if (!draft) throw draftNotFound();
  if (
    draft.status !== "draft" ||
    draft.currentVersion < 1 ||
    !domainActionToolForDraftKind(draft.kind)
  ) {
    throw unsupportedDraft();
  }
  return draft;
}

async function readResource(
  db: Db,
  storeId: string,
  type: MinkDomainResourceType,
  id: string,
): Promise<ResourceRow> {
  if (type === "product") {
    const rows = await db
      .select({
        id: products.id,
        storeId: products.storeId,
        name: products.name,
        slug: products.slug,
        description: products.description,
        seoTitle: products.seoTitle,
        seoDescription: products.seoDescription,
        basePrice: products.basePrice,
        sellingPrice: products.sellingPrice,
        imageUrl: products.imageUrl,
        status: products.status,
        trackInventory: products.trackInventory,
        version: products.contentUpdatedAt,
      })
      .from(products)
      .where(and(eq(products.id, id), eq(products.storeId, storeId)))
      .limit(1);
    if (!rows[0]) throw resourceNotFound(type);
    return { type, label: rows[0].name, ...rows[0] };
  }
  if (type === "coupon") {
    const rows = await db
      .select({
        id: coupons.id,
        storeId: coupons.storeId,
        code: coupons.code,
        description: coupons.description,
        discountType: coupons.discountType,
        discountValue: coupons.discountValue,
        minOrderAmount: coupons.minOrderAmount,
        maxUses: coupons.maxUses,
        usedCount: coupons.usedCount,
        status: coupons.status,
        validFrom: coupons.validFrom,
        validUntil: coupons.validUntil,
        showOnStorefront: coupons.showOnStorefront,
        version: coupons.updatedAt,
      })
      .from(coupons)
      .where(and(eq(coupons.id, id), eq(coupons.storeId, storeId)))
      .limit(1);
    if (!rows[0]) throw resourceNotFound(type);
    const [links] = await db
      .select({ n: count() })
      .from(couponUserGroups)
      .where(
        and(
          eq(couponUserGroups.couponId, id),
          eq(couponUserGroups.storeId, storeId),
        ),
      );
    return {
      type,
      label: `Coupon ${rows[0].code}`,
      groupLinks: links?.n ?? 0,
      ...rows[0],
    };
  }
  if (type === "offer") {
    const rows = await db
      .select({
        id: offers.id,
        storeId: offers.storeId,
        name: offers.name,
        description: offers.description,
        status: offers.status,
        rewardType: offers.rewardType,
        rewardConfig: offers.rewardConfig,
        triggerConfig: offers.triggerConfig,
        budgetPaise: offers.budgetPaise,
        spentPaise: offers.spentPaise,
        maxRedemptions: offers.maxRedemptions,
        redemptionCount: offers.redemptionCount,
        validUntil: offers.validUntil,
        version: offers.updatedAt,
      })
      .from(offers)
      .where(and(eq(offers.id, id), eq(offers.storeId, storeId)))
      .limit(1);
    if (!rows[0]) throw resourceNotFound(type);
    return { type, label: rows[0].name, ...rows[0] };
  }

  const rows = await db
    .select({
      id: userGroups.id,
      storeId: userGroups.storeId,
      name: userGroups.name,
      description: userGroups.description,
      color: userGroups.color,
      version: userGroups.updatedAt,
    })
    .from(userGroups)
    .where(and(eq(userGroups.id, id), eq(userGroups.storeId, storeId)))
    .limit(1);
  if (!rows[0]) throw resourceNotFound(type);
  return { type, label: rows[0].name, ...rows[0] };
}

function resourceValues(
  tool: MinkDomainActionTool,
  resource: ResourceRow,
): MinkDomainActionValues {
  if (resource.type === "offer") {
    const reward = (resource.rewardConfig ?? {}) as Record<string, unknown>;
    const trigger = (resource.triggerConfig ?? {}) as Record<string, unknown>;
    // ★ THE SAME TEXT FORMAT `normalizeProposedValues` EMITS, deliberately.
    // `sameValues` compares these field by field as strings, so a stored
    // "5000" against a proposed "5000.00" would report a change nobody made
    // — and for `activate_offer`, whose proposal IS the live row with one
    // field flipped, every activation would read as a terms edit.
    return {
      name: resource.name,
      description: resource.description,
      reward_type: resource.rewardType,
      reward_value: optionalMoney(reward.percent ?? reward.amount),
      min_subtotal: optionalMoney(trigger.minSubtotal),
      budget:
        resource.budgetPaise === null
          ? null
          : money(Number(resource.budgetPaise) / 100),
      max_redemptions:
        resource.maxRedemptions === null
          ? null
          : String(resource.maxRedemptions),
      valid_until: canonicalOptionalMinkTimestamp(resource.validUntil),
      status: resource.status,
    };
  }
  if (resource.type === "product" && tool === "create_product") {
    return {
      name: resource.name,
      slug: resource.slug,
      description: resource.description,
      seo_title: resource.seoTitle,
      seo_description: resource.seoDescription,
      base_price: money(resource.basePrice),
      selling_price: money(resource.sellingPrice),
      image_url: resource.imageUrl,
      status: resource.status,
      track_inventory: resource.trackInventory ? "enabled" : "disabled",
    };
  }
  if (
    resource.type === "coupon" &&
    (tool === "create_coupon" || tool === "update_coupon")
  ) {
    return {
      code: resource.code,
      description: resource.description,
      discount_type: resource.discountType,
      discount_value: money(resource.discountValue),
      min_order_amount: money(resource.minOrderAmount),
      max_uses: String(resource.maxUses),
      valid_from: canonicalOptionalMinkTimestamp(resource.validFrom),
      valid_until: canonicalOptionalMinkTimestamp(resource.validUntil),
      status: resource.status,
      show_on_storefront: resource.showOnStorefront ? "yes" : "no",
      audience:
        resource.groupLinks > 0
          ? `restricted to ${resource.groupLinks} customer group${resource.groupLinks === 1 ? "" : "s"}`
          : "all customers (no group restriction)",
    };
  }
  if (resource.type === "customer_group") {
    return {
      name: resource.name,
      description: resource.description,
      color: resource.color,
    };
  }
  throw invalidApproval();
}

function normalizeProposedValues(
  tool: MinkDomainActionTool,
  content: Record<string, string>,
  before: MinkDomainActionValues,
): MinkDomainActionValues {
  if (tool === "create_product") {
    const base = positiveMoney(content.base_price, "Base price");
    const selling = positiveMoney(content.selling_price, "Selling price");
    if (Number(selling) > Number(base)) {
      throw invalidDraft("Selling price cannot exceed the base price.");
    }
    const slug = slugify(content.slug).slice(0, 200);
    if (!slug) throw invalidDraft("The product URL slug is invalid.");
    return {
      name: requiredText(content.name, "Product name", 200),
      slug,
      description: requiredText(content.description, "Description", 3_000),
      seo_title: requiredText(content.seo_title, "SEO title", 70),
      seo_description: requiredText(
        content.seo_description,
        "SEO description",
        180,
      ),
      base_price: base,
      selling_price: selling,
      image_url: nullableText(content.image_url, 2_048),
      status: "draft",
      track_inventory: "disabled",
    };
  }
  if (tool === "create_coupon" || tool === "update_coupon") {
    const discountType = content.discount_type;
    if (discountType !== "percentage" && discountType !== "fixed") {
      throw invalidDraft("Discount type must be percentage or fixed.");
    }
    const discountValue = positiveMoney(
      content.discount_value,
      "Discount value",
    );
    if (discountType === "percentage" && Number(discountValue) > 100) {
      throw invalidDraft("A percentage discount cannot exceed 100%.");
    }
    const validFrom = optionalTimestamp(content.valid_from, "Valid from");
    const validUntil = optionalTimestamp(content.valid_until, "Valid until");
    if (
      validFrom &&
      validUntil &&
      Date.parse(validFrom) > Date.parse(validUntil)
    ) {
      throw invalidDraft("Valid from must be before valid until.");
    }
    return {
      code: normalizeCouponCode(content.code),
      description: nullableText(content.description, 500),
      discount_type: discountType,
      discount_value: discountValue,
      min_order_amount: nonNegativeMoney(
        content.min_order_amount,
        "Minimum order amount",
      ),
      max_uses: nonNegativeInteger(content.max_uses, "Maximum uses"),
      valid_from: validFrom,
      valid_until: validUntil,
      status: tool === "update_coupon" ? before.status : "disabled",
      show_on_storefront:
        tool === "update_coupon" ? before.show_on_storefront : "no",
      audience:
        tool === "update_coupon"
          ? before.audience
          : "all customers (no group restriction)",
    };
  }
  if (
    tool === "create_offer" ||
    tool === "update_offer" ||
    tool === "activate_offer"
  ) {
    return proposedOfferValues(tool, content, before);
  }
  const color = content.color.trim().toLowerCase();
  if (!GROUP_COLORS.has(color)) {
    throw invalidDraft("Colour must be blue, green, amber, violet or grey.");
  }
  return {
    name: requiredText(content.name, "Group name", 120),
    description: nullableText(content.description, 500),
    color,
  };
}

/**
 * The offer fields Mink may propose.
 *
 * ★★ WITHOUT THIS BRANCH EVERY OFFER PROPOSAL CRASHED. `normalizeProposedValues`
 * ended in the customer-group branch, which reads `content.color` — a key no
 * offer draft has, because `MINK_DRAFT_CONFIG.offer_create` declares eight
 * fields and `normalizeMinkDraftContent` returns exactly the configured keys.
 * So reviewing any offer proposal threw `TypeError: Cannot read properties of
 * undefined (reading 'trim')` and all three offer tools were dead on arrival.
 * The same fallthrough family `resourceTypeForDomainTool` was rewritten to name
 * explicitly; this file dispatches on the tool in several places and every one
 * of them has to name offers.
 */
function proposedOfferValues(
  tool: MinkDomainActionTool,
  content: Record<string, string>,
  before: MinkDomainActionValues,
): MinkDomainActionValues {
  // ★ ACTIVATION MOVES EXACTLY ONE FIELD. Its draft carries only `offer_id`, so
  // the proposed values are the live offer's own values with `status` flipped.
  // That is also what makes `writeOffer`'s mandatory budget and reward
  // re-checks read the offer AS IT STANDS TODAY rather than as the proposal
  // once described it — an offer whose budget was cleared by hand after Mink
  // wrote it must not go live uncapped.
  if (tool === "activate_offer") {
    return { ...before, status: "active" };
  }
  const rewardType = content.reward_type.trim().toLowerCase();
  if (rewardType !== "percent_off" && rewardType !== "amount_off") {
    throw invalidDraft(
      "Reward must be percent_off or amount_off. Bundles, gifts, ladders and free delivery are set up by hand.",
    );
  }
  const rewardValue = positiveMoney(content.reward_value, "Discount");
  if (rewardType === "percent_off" && Number(rewardValue) > 100) {
    throw invalidDraft("A percentage discount cannot exceed 100%.");
  }
  return {
    name: requiredText(content.name, "Offer name", 120),
    description: nullableText(content.description, 500),
    reward_type: rewardType,
    reward_value: rewardValue,
    min_subtotal: optionalPositiveMoney(
      content.min_subtotal,
      "Minimum order value",
    ),
    // ★ REQUIRED, NOT OPTIONAL. An automatic offer applies itself to every
    // qualifying order from the instant it goes live, so the budget cap is the
    // difference between a bounded mistake and an unbounded one. `writeOffer`
    // refuses without it either way; accepting a blank here would only move the
    // refusal to after the merchant had approved.
    budget: positiveMoney(content.budget, "Total budget"),
    max_redemptions: optionalPositiveInteger(
      content.max_redemptions,
      "Maximum uses",
    ),
    valid_until: optionalTimestamp(content.valid_until, "Ends"),
    // ★ PINNED DISABLED, never read from the proposal. Turning an offer on is
    // its own approval (domain-action-types.ts `isActivationTool`).
    status: "disabled",
  };
}

async function assertNoUniqueConflict(
  db: Db,
  storeId: string,
  tool: MinkDomainActionTool,
  after: MinkDomainActionValues,
  excludeId: string | null,
) {
  if (tool === "create_product") {
    const rows = await db
      .select({ id: products.id })
      .from(products)
      .where(
        and(
          eq(products.storeId, storeId),
          eq(products.slug, required(after.slug)),
        ),
      )
      .limit(1);
    if (rows[0])
      throw uniqueConflict("A product with this URL slug already exists.");
    return;
  }
  if (tool === "create_coupon" || tool === "update_coupon") {
    const rows = await db
      .select({ id: coupons.id })
      .from(coupons)
      .where(
        and(
          eq(coupons.storeId, storeId),
          eq(coupons.code, required(after.code)),
          ...(excludeId ? [ne(coupons.id, excludeId)] : []),
        ),
      )
      .limit(1);
    if (rows[0])
      throw uniqueConflict("A coupon with this code already exists.");
    return;
  }
  if (
    tool === "create_offer" ||
    tool === "update_offer" ||
    tool === "activate_offer"
  ) {
    // ★ NOTHING TO COLLIDE WITH. `offers` has no unique constraint on `name`
    // — only (store_id, code) — and Mink only ever writes
    // `delivery: 'automatic'`, which the schema requires to carry a NULL code.
    // This returns rather than falling through to the customer-group check
    // below, which would refuse an offer for sharing a name with an unrelated
    // customer group and never check anything about the offer at all.
    return;
  }
  const rows = await db
    .select({ id: userGroups.id })
    .from(userGroups)
    .where(
      and(
        eq(userGroups.storeId, storeId),
        eq(userGroups.name, required(after.name)),
        ...(excludeId ? [ne(userGroups.id, excludeId)] : []),
      ),
    )
    .limit(1);
  if (rows[0])
    throw uniqueConflict("A customer group with this name already exists.");
}

async function assertOwnedProductImage(
  db: Db,
  storeId: string,
  tool: MinkDomainActionTool,
  imageUrl: string | null | undefined,
) {
  if (tool !== "create_product" || !imageUrl) return;
  const owned = await selectOwnedStorefrontImageUrls(db, storeId, [imageUrl]);
  if (!owned.has(imageUrl)) {
    throw invalidDraft(
      "The proposed product image is no longer available in this store's Media Library. Attach it again and create a new proposal.",
    );
  }
}

async function assertSafeCreateRollback(
  db: Db,
  tool: MinkDomainActionTool,
  resource: ResourceRow,
) {
  if (tool === "create_product" && resource.type === "product") {
    if (resource.status !== "draft" || resource.trackInventory) {
      throw rollbackUnsafe(
        "The product is no longer an untouched, untracked draft.",
      );
    }
    const [[variants], [lines]] = await Promise.all([
      db
        .select({ n: count() })
        .from(productVariants)
        .where(eq(productVariants.productId, resource.id)),
      db
        .select({ n: count() })
        .from(orderItems)
        .where(eq(orderItems.productId, resource.id)),
    ]);
    if ((variants?.n ?? 0) > 0 || (lines?.n ?? 0) > 0) {
      throw rollbackUnsafe("The product now has variants or order history.");
    }
    return;
  }
  if (tool === "create_coupon" && resource.type === "coupon") {
    const [orderRows] = await db
      .select({ n: count() })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, resourceStoreId(resource)),
          eq(orders.appliedCouponCode, resource.code),
        ),
      );
    if (
      resource.status !== "disabled" ||
      resource.showOnStorefront ||
      resource.usedCount !== 0 ||
      resource.groupLinks > 0 ||
      (orderRows?.n ?? 0) > 0
    ) {
      throw rollbackUnsafe(
        "The coupon was enabled, linked, used or added to an order.",
      );
    }
    return;
  }
  if (tool === "create_offer" && resource.type === "offer") {
    // ★★ ONLY AN OFFER THAT HAS NEVER GIVEN ANYTHING AWAY. `create_offer`
    // leaves it disabled, so an untouched one is safe to delete — but a human
    // may have activated it in between, and `offer_redemptions` rows point at
    // it. Deleting an offer that has priced even one order would orphan the
    // attribution behind every order line it discounted, so the invoice and
    // the refund arithmetic would no longer be able to say what the customer
    // was given.
    if (resource.status !== "disabled") {
      throw rollbackUnsafe("The offer has been switched on.");
    }
    if (resource.redemptionCount > 0 || (resource.spentPaise ?? 0) > 0) {
      throw rollbackUnsafe("The offer has already been used on an order.");
    }
    return;
  }
  if (tool === "create_customer_group" && resource.type === "customer_group") {
    const [[members], [links]] = await Promise.all([
      db
        .select({ n: count() })
        .from(userGroupMembers)
        .where(eq(userGroupMembers.groupId, resource.id)),
      db
        .select({ n: count() })
        .from(couponUserGroups)
        .where(eq(couponUserGroups.groupId, resource.id)),
    ]);
    if ((members?.n ?? 0) > 0 || (links?.n ?? 0) > 0) {
      throw rollbackUnsafe(
        "The customer group now has members or coupon links.",
      );
    }
    return;
  }
  throw rollbackUnavailable();
}

function assertResourceEligible(
  tool: MinkDomainActionTool,
  resource: ResourceRow,
) {
  if (tool === "update_offer" && resource.type === "offer") {
    // Terms change only while the offer is off — editing a live automatic
    // offer changes what every cart in flight is being quoted.
    if (resource.status !== "disabled") {
      throw new MinkRequestError(
        "mink_action_offer_not_disabled",
        "Mink can change an offer's terms only while it is switched off. Switch it off first, or make the change by hand.",
        409,
      );
    }
  }
  if (tool === "activate_offer" && resource.type === "offer") {
    if (resource.status === "active") {
      throw new MinkRequestError(
        "mink_action_offer_already_active",
        "That offer is already switched on.",
        409,
      );
    }
    // ★ A BUDGET IS RE-REQUIRED AT ACTIVATION, not only at creation. An offer
    // whose budget was cleared by hand after Mink created it would otherwise
    // go live uncapped — which is the single thing this whole gate exists to
    // prevent.
    if (resource.budgetPaise === null || resource.budgetPaise <= 0) {
      throw new MinkRequestError(
        "mink_offer_budget_required",
        "Mink can only switch on an offer that has a total budget. Add one, or switch it on by hand.",
        422,
      );
    }
  }
  if (tool === "update_coupon" && resource.type === "coupon") {
    if (resource.status !== "disabled" || resource.showOnStorefront) {
      throw new MinkRequestError(
        "mink_action_coupon_not_disabled",
        "Mink can update coupon terms only while the coupon is disabled and hidden from the storefront.",
        409,
      );
    }
  }
}

function couponUpdate(values: MinkDomainActionValues) {
  return {
    code: required(values.code),
    description: nullable(values.description),
    discountType: required(values.discount_type),
    discountValue: Number(values.discount_value),
    minOrderAmount: Number(values.min_order_amount),
    maxUses: Number(values.max_uses),
    validFrom: values.valid_from,
    validUntil: values.valid_until,
  };
}

function normalizeDomainDraft(kind: string, value: unknown) {
  if (!domainActionToolForDraftKind(kind)) throw unsupportedDraft();
  try {
    return normalizeMinkDraftContent(
      kind as Parameters<typeof normalizeMinkDraftContent>[0],
      value,
    );
  } catch (error) {
    throw invalidDraft(
      error instanceof Error ? error.message : "The saved proposal is invalid.",
    );
  }
}

function readStoredValues(tool: MinkDomainActionTool, value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidApproval();
  }
  const raw = value as Record<string, unknown>;
  const result: MinkDomainActionValues = {};
  for (const field of domainActionFields(tool)) {
    const item = raw[field];
    if (item !== null && typeof item !== "string") throw invalidApproval();
    result[field] = item ?? null;
  }
  return result;
}

function emptyValues(tool: MinkDomainActionTool): MinkDomainActionValues {
  return Object.fromEntries(
    domainActionFields(tool).map((field) => [field, null]),
  );
}

function sameValues(
  tool: MinkDomainActionTool,
  left: MinkDomainActionValues,
  right: MinkDomainActionValues,
) {
  return domainActionFields(tool).every(
    (field) => (left[field] ?? null) === (right[field] ?? null),
  );
}

function toDomainApproval(row: DomainApprovalRow): MinkDomainActionApproval {
  const resourceId = row.resultId ?? row.resourceId;
  return {
    id: row.id,
    sourceApprovalId: row.sourceApprovalId,
    toolName: row.toolName,
    operation: row.operation,
    status: row.status,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    resource: {
      type: row.resourceType,
      id: resourceId,
      label: row.resourceLabel ?? "Dashboard record",
      dashboardPath: resourcePath(row.resourceType, resourceId),
    },
    before: readStoredValues(row.toolName, row.beforeJson),
    after: readStoredValues(row.toolName, row.afterJson),
    expiresAt: row.expiresAt,
    executedAt: row.executedAt,
  };
}

function resourcePath(type: MinkDomainResourceType, id: string | null) {
  if (type === "product")
    return id ? `/dashboard/products/${id}` : "/dashboard/products";
  if (type === "coupon") {
    return id
      ? `/dashboard/marketing/coupons/${id}/edit`
      : "/dashboard/marketing/coupons";
  }
  if (type === "offer") {
    return id ? `/dashboard/offers/${id}/edit` : "/dashboard/offers";
  }
  return id
    ? `/dashboard/users/user_groups/${id}/edit`
    : "/dashboard/users/user_groups";
}

async function readOwnedDomainApproval(
  db: Db,
  actor: MinkActorContext,
  approvalId: string,
) {
  const rows = await db
    .select()
    .from(minkActionApprovals)
    .where(
      and(
        eq(minkActionApprovals.id, approvalId),
        eq(minkActionApprovals.storeId, actor.storeId),
        eq(minkActionApprovals.adminId, actor.adminId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw approvalNotFound();
  return validateDomainApprovalRow(rows[0]);
}

async function readApprovalByIdempotency(
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
  return validateDomainApprovalRow(rows[0]);
}

async function readApprovalAudit(db: Db, storeId: string, approvalId: string) {
  const rows = await db
    .select({ id: minkActionAudit.id })
    .from(minkActionAudit)
    .where(
      and(
        eq(minkActionAudit.approvalId, approvalId),
        eq(minkActionAudit.storeId, storeId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

function validateDomainApprovalRow(
  row: typeof minkActionApprovals.$inferSelect,
): DomainApprovalRow {
  if (
    !isMinkDomainActionTool(row.toolName) ||
    (row.operation !== "apply" && row.operation !== "rollback") ||
    !isActionStatus(row.status) ||
    !isResourceType(row.resourceType)
  ) {
    throw invalidApproval();
  }
  if (
    !isCreateDomainTool(row.toolName) &&
    (!row.resourceId || !row.resourceVersion)
  ) {
    throw invalidApproval();
  }
  return {
    ...row,
    toolName: row.toolName,
    operation: row.operation,
    status: row.status,
    resourceType: row.resourceType,
  };
}

async function assertToolEnabled(
  db: Db,
  storeId: string,
  tool: MinkDomainActionTool,
  lock = false,
) {
  if (lock) {
    const result = await db.execute(sql`
      select enabled from public.mink_action_tool_access
      where store_id = ${storeId}::uuid and tool_name = ${tool}
      for update
    `);
    if ((result.rows[0] as { enabled?: boolean } | undefined)?.enabled) return;
    throw toolDisabled();
  }
  const rows = await db
    .select({ enabled: minkActionToolAccess.enabled })
    .from(minkActionToolAccess)
    .where(
      and(
        eq(minkActionToolAccess.storeId, storeId),
        eq(minkActionToolAccess.toolName, tool),
      ),
    )
    .limit(1);
  if (!rows[0]?.enabled) throw toolDisabled();
}

async function lockOwnedDraft(
  db: Db,
  actor: MinkActorContext,
  draftId: string,
) {
  await db.execute(sql`
    select id from public.mink_drafts
    where id = ${draftId}::uuid and store_id = ${actor.storeId}::uuid
      and admin_id = ${actor.adminId}
    for update
  `);
}

async function lockOwnedApproval(
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

/**
 * The dashboard section that governs each tool.
 *
 * ★★ A TOTAL MAP, NOT A CHAIN ENDING IN A DEFAULT. This was a ternary whose
 * final arm was `"users"`, so the three offer tools — which nothing else in the
 * codebase gates on anything but `promotions` — were authorised by the CUSTOMER
 * list permission instead. That is wrong in both directions at once: an admin
 * with `users:manage` and no promotions rights could create and switch on a
 * live automatic offer, while the merchant's actual offers manager was refused.
 * Written as a record so a tool added later fails to compile rather than
 * silently inheriting somebody else's section.
 */
const DOMAIN_ACTION_SECTION: Record<MinkDomainActionTool, string> = {
  create_product: "products",
  create_coupon: "marketing",
  update_coupon: "marketing",
  create_offer: "promotions",
  update_offer: "promotions",
  activate_offer: "promotions",
  create_customer_group: "users",
  update_customer_group: "users",
};

function assertDomainActionAuthority(
  actor: MinkActorContext,
  tool: MinkDomainActionTool,
) {
  const section = DOMAIN_ACTION_SECTION[tool];
  if (
    actor.draftingEnabled &&
    can(actor.permissions, section, "manage", actor.isSuperadmin)
  ) {
    return;
  }
  throw new MinkRequestError(
    "mink_action_access_denied",
    "You don't have permission to use this Mink action.",
    403,
  );
}

async function withDomainErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PlanEntitlementError) {
      throw new MinkRequestError("mink_action_plan_limit", error.message, 409);
    }
    if (isUniqueViolation(error)) {
      throw uniqueConflict("That name, code or URL slug is already in use.");
    }
    throw error;
  }
}

function hashRequest(value: Record<string, unknown>) {
  return createHash("sha256")
    .update(JSON.stringify({ ...value, toolVersion: TOOL_VERSION }))
    .digest("hex");
}

function labelFromValues(
  tool: MinkDomainActionTool,
  values: MinkDomainActionValues,
) {
  if (tool === "create_coupon") return `Coupon ${values.code}`;
  return required(values.name);
}

function required(value: string | null | undefined) {
  if (!value) throw invalidApproval();
  return value;
}

function nullable(value: string | null | undefined) {
  return value || null;
}

function requiredText(value: string, label: string, max: number) {
  const result = value.normalize("NFKC").trim();
  if (!result || result.length > max)
    throw invalidDraft(`${label} is invalid.`);
  return result;
}

function nullableText(value: string, max: number) {
  const result = value.normalize("NFKC").trim();
  if (result.length > max) throw invalidDraft("A text field is too long.");
  return result || null;
}

function normalizeCouponCode(value: string) {
  const code = value.normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "");
  if (!code || code.length > 100) throw invalidDraft("Coupon code is invalid.");
  return code;
}

function positiveMoney(value: string, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 99_999_999.99) {
    throw invalidDraft(
      `${label} must be greater than zero and within the supported range.`,
    );
  }
  return money(number);
}

function nonNegativeMoney(value: string, label: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 99_999_999.99) {
    throw invalidDraft(`${label} must be zero or a positive amount.`);
  }
  return money(number);
}

function money(value: number) {
  return (Math.round(Number(value) * 100) / 100).toFixed(2);
}

/** Text form of a stored numeric column, in the same shape `money` emits. */
function optionalMoney(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? money(number) : null;
}

function optionalPositiveMoney(value: string, label: string) {
  return value.trim() ? positiveMoney(value, label) : null;
}

/** Blank means uncapped; a stored cap must be positive (`offers_limits_check`). */
function optionalPositiveInteger(value: string, label: string) {
  if (!value.trim()) return null;
  const result = nonNegativeInteger(value, label);
  if (Number(result) <= 0) {
    throw invalidDraft(`${label} must be greater than zero, or left blank.`);
  }
  return result;
}

function nonNegativeInteger(value: string, label: string) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 1_000_000_000) {
    throw invalidDraft(`${label} must be a non-negative whole number.`);
  }
  return String(number);
}

function optionalTimestamp(value: string, label: string) {
  const input = value.trim();
  if (!input) return null;
  try {
    return canonicalMinkTimestamp(input);
  } catch {
    throw invalidDraft(`${label} is not a valid date.`);
  }
}

function resourceStoreId(resource: ResourceRow) {
  return "storeId" in resource ? resource.storeId : "";
}

function isResourceType(value: string): value is MinkDomainResourceType {
  return isMinkDomainResourceType(value);
}

function isActionStatus(value: string): value is MinkProductActionStatus {
  return ["pending", "executed", "conflicted", "expired", "cancelled"].includes(
    value,
  );
}

function terminalError(status: MinkProductActionStatus) {
  return {
    error: new MinkRequestError(
      "mink_action_not_pending",
      status === "expired"
        ? "This approval expired. Create a new preview."
        : "This approval can no longer be executed.",
      409,
    ),
  };
}

function draftNotFound() {
  return new MinkRequestError(
    "mink_draft_not_found",
    "This private proposal is not available.",
    404,
  );
}

function unsupportedDraft() {
  return new MinkRequestError(
    "mink_action_draft_unsupported",
    "Save a supported product, coupon or customer-group proposal before reviewing an action.",
    409,
  );
}

function invalidDraft(message: string) {
  return new MinkRequestError("mink_action_draft_invalid", message, 409);
}

function draftConflict() {
  return new MinkRequestError(
    "mink_action_draft_conflict",
    "The private proposal changed in another tab. Reload it before reviewing.",
    409,
  );
}

function approvalNotFound() {
  return new MinkRequestError(
    "mink_action_approval_not_found",
    "This Mink approval is not available.",
    404,
  );
}

function invalidApproval() {
  return new MinkRequestError(
    "mink_action_approval_invalid",
    "This Mink approval is invalid and cannot be executed.",
    409,
  );
}

function toolDisabled() {
  return new MinkRequestError(
    "mink_action_tool_disabled",
    "This Mink action is not enabled for this store.",
    403,
  );
}

function resourceNotFound(type: MinkDomainResourceType) {
  return new MinkRequestError(
    "mink_action_resource_not_found",
    `The linked ${type.replace("_", " ")} is no longer available in this store.`,
    404,
  );
}

function resourceConflict(type: MinkDomainResourceType, when: string) {
  return new MinkRequestError(
    "mink_action_resource_conflict",
    `The ${type.replace("_", " ")} changed ${when}. Nothing was overwritten; review the latest record.`,
    409,
  );
}

function uniqueConflict(message: string) {
  return new MinkRequestError("mink_action_unique_conflict", message, 409);
}

function rollbackUnavailable() {
  return new MinkRequestError(
    "mink_action_rollback_unavailable",
    "A safe rollback is not available for this action.",
    409,
  );
}

function rollbackUnsafe(message: string) {
  return new MinkRequestError(
    "mink_action_rollback_unsafe",
    `${message} Rollback was refused.`,
    409,
  );
}

type ProductResource = {
  type: "product";
  id: string;
  storeId: string;
  label: string;
  name: string;
  slug: string;
  description: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  basePrice: number;
  sellingPrice: number;
  imageUrl: string | null;
  status: string;
  trackInventory: boolean;
  version: string;
};

type CouponResource = {
  type: "coupon";
  id: string;
  storeId: string;
  label: string;
  code: string;
  description: string | null;
  discountType: string;
  discountValue: number;
  minOrderAmount: number;
  maxUses: number;
  usedCount: number;
  status: string;
  validFrom: string | null;
  validUntil: string | null;
  showOnStorefront: boolean;
  groupLinks: number;
  version: string;
};

type GroupResource = {
  type: "customer_group";
  id: string;
  storeId: string;
  label: string;
  name: string;
  description: string | null;
  color: string;
  version: string;
};

type OfferResource = {
  type: "offer";
  id: string;
  storeId: string;
  label: string;
  name: string;
  description: string | null;
  status: string;
  rewardType: string;
  rewardConfig: unknown;
  triggerConfig: unknown;
  budgetPaise: number | null;
  /** ★ Read so an activation preview can show what has already been spent, and
   *  so a rollback can refuse an offer that has started giving money away. */
  spentPaise: number | null;
  maxRedemptions: number | null;
  redemptionCount: number;
  validUntil: string | null;
  version: string;
};

type ResourceRow =
  | ProductResource
  | CouponResource
  | GroupResource
  | OfferResource;
type MutationResult = {
  id: string;
  version: string | null;
  label: string;
  detail: string;
};
type DomainApprovalRow = Omit<
  typeof minkActionApprovals.$inferSelect,
  "toolName" | "operation" | "status" | "resourceType"
> & {
  toolName: MinkDomainActionTool;
  operation: MinkProductActionOperation;
  status: MinkProductActionStatus;
  resourceType: MinkDomainResourceType;
};
