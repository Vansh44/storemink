import "server-only";

import { collectBusinessBriefSnapshot } from "./business-brief-data";
import {
  buildBusinessBriefResult,
  type BusinessBriefInput,
  type BusinessBriefPeriod,
  type BusinessBriefResult,
  type BusinessBriefSnapshot,
} from "./business-brief-types";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { can, normalizePermissions } from "@/app/dashboard/lib/permissions";
import {
  activityEvents,
  adminLocations,
  admins,
  minkWorkflowEvents,
  minkWorkflowRuns,
  minkWorkflowSteps,
  platformAdmins,
  roles,
  storeLocations,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { recordEvent } from "@/lib/notifications/record";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { getMinkStoreAccess } from "./access";
import { getMinkConfig } from "./config";
import { MinkRequestError, MinkToolInputError } from "./errors";
import { resolveMinkLocation } from "./tools/location-scope";
import type { MinkActorContext } from "./types";
import {
  collectDelayedPickupSnapshot,
  collectProductLaunchSnapshot,
  collectRevenueDeclineSnapshot,
  collectSlowInventorySnapshot,
  collectWeeklyTradingSnapshot,
  resolveProductLaunchTarget,
  type WorkflowExecutionScope,
} from "./workflow-template-data";
import {
  buildDelayedPickupReviewResult,
  buildProductLaunchPreparationResult,
  buildRevenueDeclineInvestigationResult,
  buildSlowInventoryPromotionResult,
  buildWeeklyTradingReportResult,
  isMinkWorkflowTemplate,
  isMinkWorkflowStatus,
  narrowMinkWorkflowLocationIds,
  type DelayedPickupReviewInput,
  type DelayedPickupReviewResult,
  type DelayedPickupSnapshot,
  type MinkWorkflowEventView,
  type MinkWorkflowResult,
  type MinkWorkflowStatus,
  type MinkWorkflowTemplate,
  type MinkWorkflowView,
  type ProductLaunchPreparationInput,
  type ProductLaunchPreparationResult,
  type ProductLaunchSnapshot,
  type RevenueDeclineInvestigationInput,
  type RevenueDeclineInvestigationResult,
  type RevenueDeclineSnapshot,
  type MinkRevenuePeriod,
  type MinkSlowInventoryPeriod,
  type SlowInventoryPromotionInput,
  type SlowInventoryPromotionResult,
  type SlowInventorySnapshot,
  type WeeklyTradingReportInput,
  type WeeklyTradingReportResult,
  type WeeklyTradingReportSnapshot,
} from "./workflow-types";

const WORKFLOW_STEPS: Record<MinkWorkflowTemplate, readonly string[]> = {
  business_brief: ["snapshot", "analyse", "finalise"],
  weekly_trading_report: ["snapshot", "analyse", "finalise"],
  revenue_decline_investigation: ["snapshot", "diagnose", "finalise"],
  product_launch_preparation: ["snapshot", "assess", "finalise"],
  slow_inventory_promotion: ["snapshot", "prepare", "finalise"],
  delayed_pickup_review: ["snapshot", "prepare", "finalise"],
};
const WORKFLOW_LEASE_SECONDS = 120;
const MAX_WORKFLOW_LOCATIONS = 50;
export const MAX_MINK_WORKFLOW_CLAIMS_PER_RUN = 15;

type WorkflowRow = typeof minkWorkflowRuns.$inferSelect;
type ClaimedWorkflow = Pick<
  WorkflowRow,
  | "id"
  | "storeId"
  | "adminId"
  | "template"
  | "status"
  | "inputJson"
  | "currentStep"
  | "totalSteps"
  | "attemptCount"
  | "maxAttempts"
  | "leaseOwner"
  | "cancelRequestedAt"
>;

export interface MinkWorkflowWorkerResult {
  claims: number;
  stepsCompleted: number;
  workflowsCompleted: number;
  workflowsCancelled: number;
  retriesScheduled: number;
  workflowsFailed: number;
  notificationsDelivered: number;
}

class WorkflowCancellationRequestedError extends Error {}

export async function enqueueBusinessBrief(
  actor: MinkActorContext,
  options: { period: BusinessBriefPeriod; locationName?: unknown },
): Promise<MinkWorkflowView> {
  assertQueueAuthority(actor, "business_brief");
  if (options.period !== "daily" && options.period !== "weekly")
    throw new MinkToolInputError(
      "Choose daily or weekly for a business brief.",
    );
  const input: BusinessBriefInput = {
    ...(await buildAuthorityInput(actor, options.locationName)),
    period: options.period,
    defaultLowStockThreshold: actor.defaultLowStockThreshold,
  };
  return enqueueWorkflow(actor, {
    template: "business_brief",
    input,
    idempotencyKey: `agent-run:${actor.runId}:business-brief:${input.period}:${input.locationIds.join(",")}:${input.includeUnassigned}:v1`,
  });
}

/** Queue one deterministic read-only report. Model retries reuse source run. */
export async function enqueueWeeklyTradingReport(
  actor: MinkActorContext,
): Promise<MinkWorkflowView> {
  assertQueueAuthority(actor, "weekly_trading_report");
  const input = await buildAuthorityInput(actor);
  return enqueueWorkflow(actor, {
    template: "weekly_trading_report",
    input,
    idempotencyKey: `agent-run:${actor.runId}:weekly-trading-report:v1`,
  });
}

export async function enqueueRevenueDeclineInvestigation(
  actor: MinkActorContext,
  options: { period: MinkRevenuePeriod; locationName?: unknown },
): Promise<MinkWorkflowView> {
  assertQueueAuthority(actor, "revenue_decline_investigation");
  const input: RevenueDeclineInvestigationInput = {
    ...(await buildAuthorityInput(actor, options.locationName)),
    period: options.period,
  };
  const scopeKey = input.includeUnassigned
    ? "accessible-scope"
    : input.locationIds[0];
  return enqueueWorkflow(actor, {
    template: "revenue_decline_investigation",
    input,
    idempotencyKey: `agent-run:${actor.runId}:revenue-decline:${options.period}:${scopeKey}:v1`,
  });
}

export async function enqueueProductLaunchPreparation(
  actor: MinkActorContext,
  options: { productSku: unknown },
): Promise<MinkWorkflowView> {
  assertQueueAuthority(actor, "product_launch_preparation");
  const target = await resolveProductLaunchTarget(
    actor.storeId,
    options.productSku,
  );
  const input: ProductLaunchPreparationInput = {
    ...(await buildAuthorityInput(actor)),
    productId: target.productId,
    variantId: target.variantId,
    requestedSku: target.sku,
    defaultLowStockThreshold: actor.defaultLowStockThreshold,
  };
  return enqueueWorkflow(actor, {
    template: "product_launch_preparation",
    input,
    idempotencyKey: `agent-run:${actor.runId}:product-launch:${target.productId}:${target.variantId ?? "all"}:v1`,
  });
}

export async function enqueueSlowInventoryPromotion(
  actor: MinkActorContext,
  options: { period: MinkSlowInventoryPeriod; locationName?: unknown },
): Promise<MinkWorkflowView> {
  assertQueueAuthority(actor, "slow_inventory_promotion");
  const input: SlowInventoryPromotionInput = {
    ...(await buildAuthorityInput(actor, options.locationName, false)),
    period: options.period,
  };
  const scopeKey = input.locationIds.join(",") || "no-active-location";
  return enqueueWorkflow(actor, {
    template: "slow_inventory_promotion",
    input,
    idempotencyKey: `agent-run:${actor.runId}:slow-inventory:${options.period}:${scopeKey}:v1`,
  });
}

export async function enqueueDelayedPickupReview(
  actor: MinkActorContext,
  options: { locationName?: unknown },
): Promise<MinkWorkflowView> {
  assertQueueAuthority(actor, "delayed_pickup_review");
  const input: DelayedPickupReviewInput = await buildAuthorityInput(
    actor,
    options.locationName,
    false,
  );
  const scopeKey = input.locationIds.join(",") || "no-active-location";
  return enqueueWorkflow(actor, {
    template: "delayed_pickup_review",
    input,
    idempotencyKey: `agent-run:${actor.runId}:delayed-pickup:${scopeKey}:v1`,
  });
}

async function buildAuthorityInput(
  actor: MinkActorContext,
  locationName?: unknown,
  includeUnassigned = true,
): Promise<WeeklyTradingReportInput> {
  const location = await resolveMinkLocation(actor, locationName);
  const locationIds = location.selectedId
    ? [location.selectedId]
    : location.availableLocations.map((item) => item.id);
  if (locationIds.length > MAX_WORKFLOW_LOCATIONS) {
    throw new MinkToolInputError(
      `This workflow supports at most ${MAX_WORKFLOW_LOCATIONS} accessible active locations. Choose one exact location.`,
    );
  }
  const now = new Date().toISOString();
  return {
    timeZone: actor.analyticsTimeZone,
    currency: actor.currency,
    // Persist exact active IDs instead of null/all. A location created later
    // can never silently enter work that was already authorized and queued.
    locationIds,
    restrictedLocationScope: actor.locationIds !== null,
    includeUnassigned: includeUnassigned && location.includeUnassigned,
    locationLabel:
      includeUnassigned && location.includeUnassigned && !location.selectedId
        ? `${location.label} plus online or unassigned orders`
        : location.label,
    requesterEmail: actor.email?.trim().toLowerCase() ?? null,
    requestedAt: now,
  };
}

async function enqueueWorkflow(
  actor: MinkActorContext,
  options: {
    template: MinkWorkflowTemplate;
    input:
      | BusinessBriefInput
      | WeeklyTradingReportInput
      | RevenueDeclineInvestigationInput
      | ProductLaunchPreparationInput
      | SlowInventoryPromotionInput
      | DelayedPickupReviewInput;
    idempotencyKey: string;
  },
): Promise<MinkWorkflowView> {
  if (!actor.runId) {
    throw new MinkToolInputError(
      "A workflow can be queued only from an active Mink AI run.",
    );
  }
  const steps = WORKFLOW_STEPS[options.template];
  const now = options.input.requestedAt;
  return withService(async (db) => {
    const inserted = await db
      .insert(minkWorkflowRuns)
      .values({
        storeId: actor.storeId,
        adminId: actor.adminId,
        sourceRunId: actor.runId,
        template: options.template,
        status: "queued",
        idempotencyKey: options.idempotencyKey,
        inputJson: options.input,
        totalSteps: steps.length,
        maxAttempts: 6,
        runAfter: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          minkWorkflowRuns.storeId,
          minkWorkflowRuns.adminId,
          minkWorkflowRuns.idempotencyKey,
        ],
      })
      .returning();
    let run = inserted[0];
    if (run) {
      await db.insert(minkWorkflowSteps).values(
        steps.map((stepKey, position) => ({
          runId: run!.id,
          storeId: actor.storeId,
          stepKey,
          position,
          inputJson: {},
        })),
      );
      await insertWorkflowEvent(db, {
        runId: run.id,
        storeId: actor.storeId,
        eventKey: "queued",
        eventType: "queued",
        detail: { template: options.template },
      });
    } else {
      const existing = await db
        .select()
        .from(minkWorkflowRuns)
        .where(
          and(
            eq(minkWorkflowRuns.storeId, actor.storeId),
            eq(minkWorkflowRuns.adminId, actor.adminId),
            eq(minkWorkflowRuns.idempotencyKey, options.idempotencyKey),
          ),
        )
        .limit(1);
      run = existing[0];
    }
    if (!run) throw new Error("Mink workflow idempotency lookup failed");
    return toWorkflowView(run);
  });
}

export async function getMinkWorkflow(
  actor: MinkActorContext,
  workflowId: string,
  includeEvents = true,
): Promise<MinkWorkflowView> {
  return withService(async (db) => {
    const rows = await db
      .select()
      .from(minkWorkflowRuns)
      .where(ownerPredicate(actor, workflowId))
      .limit(1);
    const run = rows[0];
    if (!run) {
      throw new MinkRequestError(
        "mink_workflow_not_found",
        "That Mink workflow is not available.",
        404,
      );
    }
    assertActorWorkflowAccess(actor, run.template, run.inputJson);
    assertActorStillSeesCapturedScope(actor, run.template, run.inputJson);
    const events = includeEvents
      ? await db
          .select()
          .from(minkWorkflowEvents)
          .where(
            and(
              eq(minkWorkflowEvents.runId, run.id),
              eq(minkWorkflowEvents.storeId, actor.storeId),
            ),
          )
          .orderBy(
            asc(minkWorkflowEvents.createdAt),
            asc(minkWorkflowEvents.id),
          )
          .limit(100)
      : [];
    return toWorkflowView(
      run,
      events.map((event) => ({
        id: event.id,
        type: event.eventType,
        stepKey: event.stepKey,
        detail: readObject(event.detailJson),
        createdAt: event.createdAt,
      })),
    );
  });
}

export async function cancelMinkWorkflow(
  actor: MinkActorContext,
  workflowId: string,
): Promise<MinkWorkflowView> {
  return withService(async (db) => {
    const rows = await db
      .select()
      .from(minkWorkflowRuns)
      .where(ownerPredicate(actor, workflowId))
      .limit(1)
      .for("update");
    const run = rows[0];
    if (!run) {
      throw new MinkRequestError(
        "mink_workflow_not_found",
        "That Mink workflow is not available.",
        404,
      );
    }
    assertActorWorkflowAccess(actor, run.template, run.inputJson);
    // ★★ THE SAME SCOPE GUARD THE READ APPLIES, because this returns the same
    // view. A completed run falls straight through to `toWorkflowView(run)`
    // below, and that carries `result_json` — so without this line an admin who
    // is refused 403 on GET could press Stop and be handed the store-wide
    // figures anyway. The card makes that a one-click path rather than a
    // theoretical one: the artifact persisted in the thread still says
    // "queued", so `active` is true and the Stop button renders on every
    // re-open.
    assertActorStillSeesCapturedScope(actor, run.template, run.inputJson);
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      return toWorkflowView(run);
    }
    const now = new Date().toISOString();
    if (run.status === "running") {
      const updated = await db
        .update(minkWorkflowRuns)
        .set({ cancelRequestedAt: now, updatedAt: now })
        .where(ownerPredicate(actor, workflowId))
        .returning();
      await insertWorkflowEvent(db, {
        runId: run.id,
        storeId: actor.storeId,
        eventKey: "cancel-requested",
        eventType: "cancel_requested",
        detail: {},
      });
      return toWorkflowView(updated[0] ?? run);
    }
    const updated = await db
      .update(minkWorkflowRuns)
      .set({
        status: "cancelled",
        cancelRequestedAt: now,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(ownerPredicate(actor, workflowId))
      .returning();
    await db
      .update(minkWorkflowSteps)
      .set({ status: "cancelled", completedAt: now, updatedAt: now })
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, actor.storeId),
          inArray(minkWorkflowSteps.status, [
            "queued",
            "running",
            "waiting_approval",
          ]),
        ),
      );
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: actor.storeId,
      eventKey: "cancelled",
      eventType: "cancelled",
      detail: {},
    });
    return toWorkflowView(updated[0] ?? run);
  });
}

/** Generic approval-resume primitive; cancelled workflows are never resumable. */
export async function resumeMinkWorkflow(
  actor: MinkActorContext,
  workflowId: string,
): Promise<MinkWorkflowView> {
  return withService(async (db) => {
    const rows = await db
      .select()
      .from(minkWorkflowRuns)
      .where(ownerPredicate(actor, workflowId))
      .limit(1)
      .for("update");
    const run = rows[0];
    if (!run) {
      throw new MinkRequestError(
        "mink_workflow_not_found",
        "That Mink workflow is not available.",
        404,
      );
    }
    assertActorWorkflowAccess(actor, run.template, run.inputJson);
    // Approving more work on a scope you can no longer see is the same
    // question as reading its result, so it gets the same answer.
    assertActorStillSeesCapturedScope(actor, run.template, run.inputJson);
    if (run.status !== "waiting_approval") {
      throw new MinkRequestError(
        "mink_workflow_not_resumable",
        run.status === "cancelled"
          ? "Cancelled Mink workflows cannot be resumed."
          : "This Mink workflow is not waiting for approval.",
        409,
      );
    }
    const now = new Date().toISOString();
    const updated = await db
      .update(minkWorkflowRuns)
      .set({
        status: "queued",
        // ★ Same reason as `completeIntermediateStep`: a run parked at
        // `waiting_approval` may already sit at the ceiling, and re-queueing it
        // there would accept the approval and then never act on it. A human
        // asking for this to continue is the clearest possible signal that it
        // should get a fresh budget.
        attemptCount: 0,
        runAfter: now,
        updatedAt: now,
      })
      .where(ownerPredicate(actor, workflowId))
      .returning();
    await db
      .update(minkWorkflowSteps)
      .set({ status: "queued", updatedAt: now })
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, actor.storeId),
          eq(minkWorkflowSteps.position, run.currentStep),
          eq(minkWorkflowSteps.status, "waiting_approval"),
        ),
      );
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: actor.storeId,
      eventKey: `resumed:${run.currentStep}`,
      eventType: "resumed",
      detail: { step: run.currentStep },
    });
    return toWorkflowView(updated[0] ?? run);
  });
}

export async function runMinkWorkflowWorker(
  limit = MAX_MINK_WORKFLOW_CLAIMS_PER_RUN,
): Promise<MinkWorkflowWorkerResult> {
  const result: MinkWorkflowWorkerResult = {
    claims: 0,
    stepsCompleted: 0,
    workflowsCompleted: 0,
    workflowsCancelled: 0,
    retriesScheduled: 0,
    workflowsFailed: 0,
    notificationsDelivered: 0,
  };
  const config = getMinkConfig();
  if (!config.enabled) return result;
  const bounded = Math.max(
    1,
    Math.min(MAX_MINK_WORKFLOW_CLAIMS_PER_RUN, Math.trunc(limit)),
  );
  const workerId = crypto.randomUUID();
  // ★★ ONE FAILING PASS MUST NOT COST THE OTHER TWO. This heartbeat does three
  // independent things — reap dead leases, walk the queue, deliver completion
  // notices — and they used to share one uncaught path: a throw in the reaper
  // ran before the loop, so it took the queue AND the notification outbox down
  // with it, and a workflow could finish with nobody ever told. That is the
  // same failure `parseClaimedWorkflow` was fixed for, reachable from a
  // different throw site.
  //
  // ★ HELD, NOT SWALLOWED. The first failure is rethrown once every pass has
  // had its turn, so the cron still answers 503 and a corrupt claimed row stays
  // exactly as loud as it was — the only thing that changed is that one broken
  // pass no longer jumps over the other two.
  let passError: unknown = null;
  try {
    result.workflowsFailed += await failExpiredExhaustedWorkflows(bounded);
  } catch (error) {
    logError("mink workflow worker: lease reaper failed", error, { workerId });
    passError ??= error;
  }
  for (let index = 0; index < bounded; index += 1) {
    let run: ClaimedWorkflow | null;
    try {
      run = await claimWorkflow(workerId);
    } catch (error) {
      // Deliberately outside the per-run try below: with no claimed run there
      // is nothing to retry or cancel, so stop walking the queue and let the
      // completion pass still run before this surfaces.
      logError("mink workflow worker: claim failed", error, { workerId });
      passError ??= error;
      break;
    }
    if (!run) break;
    result.claims += 1;
    try {
      if (run.cancelRequestedAt) {
        await cancelClaimedWorkflow(run, workerId, "cancel_requested");
        result.workflowsCancelled += 1;
        continue;
      }
      if (config.betaRequireInvite || requiresWorkflowDrafting(run.template)) {
        const access = await getMinkStoreAccess(run.storeId);
        if (
          (config.betaRequireInvite && !access.enabled) ||
          (requiresWorkflowDrafting(run.template) && !access.draftingEnabled)
        ) {
          await cancelClaimedWorkflow(run, workerId, "store_access_revoked");
          result.workflowsCancelled += 1;
          continue;
        }
      }
      const executionScope = await revalidateWorkflowAuthority(run);
      if (!executionScope) {
        await cancelClaimedWorkflow(run, workerId, "authorization_revoked");
        result.workflowsCancelled += 1;
        continue;
      }
      const outcome = await executeClaimedStep(run, workerId, executionScope);
      result.stepsCompleted += 1;
      if (outcome.completed) result.workflowsCompleted += 1;
    } catch (error) {
      if (error instanceof WorkflowCancellationRequestedError) {
        await cancelClaimedWorkflow(run, workerId, "cancel_requested");
        result.workflowsCancelled += 1;
        continue;
      }
      const failure = await scheduleWorkflowRetry(run, workerId, error);
      if (failure === "retry") result.retriesScheduled += 1;
      else result.workflowsFailed += 1;
    }
  }
  try {
    result.notificationsDelivered =
      await deliverPendingWorkflowNotifications(bounded);
  } catch (error) {
    logError("mink workflow worker: completion delivery failed", error, {
      workerId,
    });
    passError ??= error;
  }
  if (result.claims > 0) {
    logInfo("mink workflow worker: completed", { workerId, ...result });
  }
  if (passError) throw passError;
  return result;
}

/**
 * Re-check durable work at execution time. A queued job is never a capability
 * token: removing Analytics access, suspending the requester, removing their
 * platform-operator row, or narrowing an explicit location assignment takes
 * effect before the next step reads store data.
 */
async function revalidateWorkflowAuthority(
  run: ClaimedWorkflow,
): Promise<WorkflowExecutionScope | null> {
  if (!isMinkWorkflowTemplate(run.template)) return null;
  const template = run.template;
  const input = readWorkflowInput(template, run.inputJson);
  return withService(async (db) => {
    let isPlatformOperator = false;
    let isStoreSuperadmin = false;
    if (input.requesterEmail) {
      const platformRows = await db
        .select({ id: platformAdmins.id })
        .from(platformAdmins)
        .where(eq(platformAdmins.email, input.requesterEmail))
        .limit(1);
      isPlatformOperator = Boolean(platformRows[0]);
    }

    if (!isPlatformOperator) {
      const adminRows = await db
        .select({ role: admins.role, isSuspended: admins.isSuspended })
        .from(admins)
        .where(and(eq(admins.id, run.adminId), eq(admins.storeId, run.storeId)))
        .limit(1);
      const admin = adminRows[0];
      if (!admin || admin.isSuspended === true) return null;
      isStoreSuperadmin = admin.role === "superadmin";
      if (admin.role !== "superadmin") {
        const roleRows = await db
          .select({ permissions: roles.permissions })
          .from(roles)
          .where(
            and(eq(roles.storeId, run.storeId), eq(roles.slug, admin.role)),
          )
          .limit(1);
        const permissions = normalizePermissions(roleRows[0]?.permissions);
        if (!hasWorkflowPermissions(permissions, template)) return null;
      }
    }

    const activeLocations =
      input.locationIds.length === 0
        ? []
        : await db
            .select({ id: storeLocations.id })
            .from(storeLocations)
            .where(
              and(
                eq(storeLocations.storeId, run.storeId),
                eq(storeLocations.active, true),
                inArray(storeLocations.id, input.locationIds),
              ),
            );
    const bindings =
      isPlatformOperator || isStoreSuperadmin
        ? null
        : await db
            .select({ locationId: adminLocations.locationId })
            .from(adminLocations)
            .where(
              and(
                eq(adminLocations.adminId, run.adminId),
                eq(adminLocations.storeId, run.storeId),
              ),
            );
    const locationIds = narrowMinkWorkflowLocationIds(
      input,
      activeLocations.map((location) => location.id),
      bindings?.map((binding) => binding.locationId) ?? null,
    );
    if (locationIds === null) return null;
    // A checkpoint can already contain a whole-scope brief. Never reuse it
    // after authority narrows, even at the finalisation step.
    if (
      template === "business_brief" &&
      (locationIds.length !== input.locationIds.length ||
        (input.includeUnassigned && bindings !== null && bindings.length > 0))
    )
      return null;
    return {
      locationIds,
      locationLabel:
        locationIds.length === input.locationIds.length
          ? input.locationLabel
          : `${locationIds.length} currently authorized ${locationIds.length === 1 ? "location" : "locations"} (narrowed from ${input.locationIds.length} queued)`,
    };
  });
}

/**
 * A finished report is not a capability token either.
 *
 * ★★ THE WORKER RE-DERIVES SCOPE; THE READ DID NOT. `revalidateWorkflowAuthority`
 * narrows a run's captured locations to what the actor may still see before
 * every background step — but a run that already COMPLETED has its figures
 * sitting in `result_json`, and `getMinkWorkflow` returned them on nothing more
 * than owner + permission. So an unrestricted admin could queue a store-wide
 * trading report, be bound to one location by the owner, reopen the Mink thread
 * and read store-wide net sales, orders and top products that
 * `/dashboard/analytics` and the orders list would both now refuse them
 * (CODEBASE §23). `narrowMinkWorkflowLocationIds` existed and was reachable only
 * from the worker.
 *
 * ★ REFUSED, NOT NARROWED. The numbers were computed ACROSS the captured scope
 * and cannot be re-cut after the fact; showing a subset of a total is worse than
 * showing nothing, because it looks like an answer. A fresh request under the
 * actor's current authority is the honest way to get one.
 *
 * ★ THE ACTOR'S OWN `locationIds` IS THE SOURCE, already server-derived by
 * `getMinkActorContext` — the same value every other permission-aware read
 * uses — so this costs no query. `null` is the §23 contract for unrestricted.
 */
function assertActorStillSeesCapturedScope(
  actor: MinkActorContext,
  templateValue: unknown,
  inputValue: unknown,
) {
  if (actor.isSuperadmin) return;
  const bindings = actor.locationIds;
  // Unrestricted: null by contract, and an empty array means the same thing —
  // "no rows = unrestricted" is what `admin_locations` has always meant.
  // A missing value is read the same way rather than thrown on: the type says
  // `string[] | null` and `getMinkActorContext` always fills it, so `undefined`
  // means a caller built an actor by hand — and a TypeError there is worse than
  // either honest answer.
  if (!bindings || bindings.length === 0) return;
  if (!isMinkWorkflowTemplate(templateValue)) return;
  const input = readWorkflowInput(templateValue, inputValue);

  const allowed = new Set(bindings);
  // A store-wide run (no captured locations) or one that counted unassigned and
  // online orders covers ground a location-bound admin may not see at all.
  const withinScope =
    input.locationIds.length > 0 &&
    !input.includeUnassigned &&
    input.locationIds.every((id) => allowed.has(id));
  if (!withinScope) {
    throw new MinkRequestError(
      "mink_workflow_access_denied",
      "This result covers locations you no longer have access to. Ask Mink again to get one for your current locations.",
      403,
    );
  }
}

function hasWorkflowPermissions(
  permissions: MinkActorContext["permissions"],
  template: MinkWorkflowTemplate,
  isSuperadmin = false,
): boolean {
  if (template === "business_brief") {
    return (
      can(permissions, "analytics", "view", isSuperadmin) &&
      can(permissions, "products", "view", isSuperadmin) &&
      can(permissions, "inventory", "view", isSuperadmin) &&
      can(permissions, "orders", "view", isSuperadmin)
    );
  }
  if (template === "product_launch_preparation") {
    return (
      can(permissions, "products", "view", isSuperadmin) &&
      can(permissions, "inventory", "view", isSuperadmin)
    );
  }
  if (template === "slow_inventory_promotion") {
    return (
      can(permissions, "analytics", "view", isSuperadmin) &&
      can(permissions, "products", "view", isSuperadmin) &&
      can(permissions, "inventory", "view", isSuperadmin) &&
      can(permissions, "promotions", "manage", isSuperadmin)
    );
  }
  if (template === "delayed_pickup_review") {
    return can(permissions, "orders", "manage", isSuperadmin);
  }
  return can(permissions, "analytics", "view", isSuperadmin);
}

/**
 * Completion delivery is a reconciled outbox: the partial unique index on
 * activity_events makes concurrent/retried deliveries exactly-once per run.
 */
async function deliverPendingWorkflowNotifications(limit: number) {
  const pending = await withService((db) =>
    db
      .select({
        id: minkWorkflowRuns.id,
        storeId: minkWorkflowRuns.storeId,
        adminId: minkWorkflowRuns.adminId,
        template: minkWorkflowRuns.template,
        result: minkWorkflowRuns.resultJson,
      })
      .from(minkWorkflowRuns)
      .where(
        and(
          eq(minkWorkflowRuns.status, "completed"),
          sql`NOT EXISTS (
            SELECT 1
            FROM ${activityEvents}
            WHERE ${activityEvents.storeId} = ${minkWorkflowRuns.storeId}
              AND ${activityEvents.type} = 'mink.workflow_completed'
              AND ${activityEvents.subjectId} = ${minkWorkflowRuns.id}::text
          )`,
        ),
      )
      .orderBy(asc(minkWorkflowRuns.completedAt), asc(minkWorkflowRuns.id))
      .limit(Math.max(1, Math.min(limit, 25))),
  );
  let delivered = 0;
  for (const run of pending) {
    if (!isMinkWorkflowTemplate(run.template)) continue;
    const eventId = await recordEvent({
      type: "mink.workflow_completed",
      storeId: run.storeId,
      actor: { type: "system", label: "Mink AI" },
      subject: {
        type: "mink_workflow",
        id: run.id,
        label: workflowLabel(run.template),
      },
      payload: {
        template: run.template,
        url: workflowNotificationUrl(run.template, run.result),
      },
      // ★★ TO THE ADMIN WHO ASKED, AND NOBODY ELSE. The event's section is
      // `dashboard`, which every admin can view, so the default permission
      // routing told the whole team about one person's request — including the
      // private drafting workflows (slow inventory, delayed pickup) that only
      // the requester can open, and linking them to a page they may have no
      // permission for. `restrictToAdminIds` narrows the already
      // permission-filtered set, so it can only ever remove people: if the
      // requester has since lost even Home access, nobody is notified and the
      // activity_events row still stands as the record.
      restrictToAdminIds: [run.adminId],
      deduplicate: true,
    });
    if (eventId) delivered += 1;
  }
  return delivered;
}

/**
 * A process can die on its final permitted attempt before it records a retry.
 * Reap that expired lease explicitly; otherwise the max-attempt predicate would
 * leave the run permanently stuck in `running`.
 */
async function failExpiredExhaustedWorkflows(limit: number): Promise<number> {
  return withService(async (db) => {
    const rows = await db
      .select({
        id: minkWorkflowRuns.id,
        storeId: minkWorkflowRuns.storeId,
        currentStep: minkWorkflowRuns.currentStep,
        attemptCount: minkWorkflowRuns.attemptCount,
        template: minkWorkflowRuns.template,
      })
      .from(minkWorkflowRuns)
      .where(
        and(
          eq(minkWorkflowRuns.status, "running"),
          sql`${minkWorkflowRuns.leaseExpiresAt} <= now()`,
          sql`${minkWorkflowRuns.attemptCount} >= ${minkWorkflowRuns.maxAttempts}`,
        ),
      )
      .orderBy(asc(minkWorkflowRuns.leaseExpiresAt), asc(minkWorkflowRuns.id))
      .limit(Math.max(1, Math.min(limit, 25)))
      .for("update", { skipLocked: true });
    if (rows.length === 0) return 0;
    const now = new Date().toISOString();
    for (const run of rows) {
      await db
        .update(minkWorkflowRuns)
        .set({
          status: "failed",
          errorCode: "workflow_lease_expired_after_max_attempts",
          errorDetail: "Mink could not finish this report after safe retries.",
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(minkWorkflowRuns.id, run.id),
            eq(minkWorkflowRuns.storeId, run.storeId),
            eq(minkWorkflowRuns.status, "running"),
          ),
        );
      await db
        .update(minkWorkflowSteps)
        .set({
          status: "failed",
          errorCode: "workflow_lease_expired_after_max_attempts",
          completedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(minkWorkflowSteps.runId, run.id),
            eq(minkWorkflowSteps.storeId, run.storeId),
            eq(minkWorkflowSteps.position, run.currentStep),
            inArray(minkWorkflowSteps.status, ["queued", "running"]),
          ),
        );
      await insertWorkflowEvent(db, {
        runId: run.id,
        storeId: run.storeId,
        eventKey: `failed:exhausted:${run.attemptCount}`,
        eventType: "failed",
        stepKey: workflowStepKey(run.template, run.currentStep),
        detail: {
          attempt: run.attemptCount,
          code: "workflow_lease_expired_after_max_attempts",
        },
      });
    }
    logWarn("mink workflow worker: expired exhausted leases failed", {
      count: rows.length,
    });
    return rows.length;
  });
}

async function claimWorkflow(
  workerId: string,
): Promise<ClaimedWorkflow | null> {
  return withService(async (db) => {
    const claimed = await db.execute(sql<ClaimedWorkflow>`
      WITH candidate AS (
        SELECT id
        FROM public.mink_workflow_runs
        WHERE (
          (status = 'queued' AND run_after <= now())
          OR (status = 'running' AND lease_expires_at <= now())
        )
          AND attempt_count < max_attempts
        ORDER BY run_after, created_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE public.mink_workflow_runs AS run
      SET status = 'running',
          lease_owner = ${workerId}::uuid,
          lease_expires_at = now() + (${WORKFLOW_LEASE_SECONDS}::int * interval '1 second'),
          attempt_count = run.attempt_count + 1,
          updated_at = now()
      FROM candidate
      WHERE run.id = candidate.id
      RETURNING run.id,
                run.store_id AS "storeId",
                run.admin_id AS "adminId",
                run.template,
                run.status,
                run.input_json AS "inputJson",
                run.current_step AS "currentStep",
                run.total_steps AS "totalSteps",
                run.attempt_count AS "attemptCount",
                run.max_attempts AS "maxAttempts",
                run.lease_owner AS "leaseOwner",
                run.cancel_requested_at AS "cancelRequestedAt"
    `);
    const run = parseClaimedWorkflow(claimed.rows[0]);
    if (run) {
      await insertWorkflowEvent(db, {
        runId: run.id,
        storeId: run.storeId,
        eventKey: `claimed:${run.attemptCount}`,
        eventType: "claimed",
        detail: { attempt: run.attemptCount },
      });
    }
    return run;
  });
}

function parseClaimedWorkflow(value: unknown): ClaimedWorkflow | null {
  // ★★ AN EMPTY QUEUE IS THE STEADY STATE, NOT A MALFORMED ROW. The claim CTE
  // matches nothing on most heartbeats, so `claimed.rows[0]` is `undefined` —
  // and `readObject(undefined)` returns `{}`, which fails every guard below and
  // THREW. `claimWorkflow` is awaited outside the worker's try/catch
  // (`if (!run) break` is written for exactly this case), so that throw escaped
  // `runMinkWorkflowWorker` into a route with no catch: the minute cron
  // answered 500 forever, and because the loop only ever exits by the queue
  // draining, `deliverPendingWorkflowNotifications` below it was unreachable —
  // a workflow finished and nobody was ever told.
  //
  // ★ NOTHING TO CLAIM and A ROW WE CANNOT TRUST stay different answers: the
  // first returns null and ends the run quietly, the second still throws, so a
  // genuinely corrupt row is as loud as it was.
  if (value === undefined || value === null) return null;

  const row = readObject(value);
  const cancelRequestedAt = normalizeTimestamp(row.cancelRequestedAt);
  if (
    typeof row.id !== "string" ||
    typeof row.storeId !== "string" ||
    typeof row.adminId !== "string" ||
    typeof row.template !== "string" ||
    row.status !== "running" ||
    !row.inputJson ||
    typeof row.inputJson !== "object" ||
    Array.isArray(row.inputJson) ||
    !Number.isInteger(row.currentStep) ||
    !Number.isInteger(row.totalSteps) ||
    !Number.isInteger(row.attemptCount) ||
    !Number.isInteger(row.maxAttempts) ||
    typeof row.leaseOwner !== "string" ||
    (row.cancelRequestedAt != null && cancelRequestedAt === null)
  ) {
    throw new Error("invalid_claimed_workflow_row");
  }
  return {
    id: row.id,
    storeId: row.storeId,
    adminId: row.adminId,
    template: row.template,
    status: "running",
    inputJson: row.inputJson,
    currentStep: row.currentStep as number,
    totalSteps: row.totalSteps as number,
    attemptCount: row.attemptCount as number,
    maxAttempts: row.maxAttempts as number,
    leaseOwner: row.leaseOwner,
    cancelRequestedAt,
  };
}

function normalizeTimestamp(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return null;
}

async function executeClaimedStep(
  run: ClaimedWorkflow,
  workerId: string,
  executionScope: WorkflowExecutionScope,
): Promise<{ completed: boolean }> {
  if (!isMinkWorkflowTemplate(run.template)) {
    throw new Error("unsupported_workflow_step");
  }
  const stepKey = WORKFLOW_STEPS[run.template][run.currentStep];
  if (!stepKey) throw new Error("unsupported_workflow_step");
  await markStepStarted(run, workerId, stepKey);
  if (run.template === "business_brief") {
    const input = readBusinessBriefInput(run.inputJson);
    if (stepKey === "snapshot") {
      const snapshot = await collectBusinessBriefSnapshot(
        run.storeId,
        { uid: run.adminId, email: input.requesterEmail },
        input,
        executionScope,
      );
      await completeIntermediateStep(run, workerId, stepKey, snapshot);
      return { completed: false };
    }
    if (stepKey === "analyse") {
      const snapshot = await readStepOutput<BusinessBriefSnapshot>(
        run,
        "snapshot",
      );
      await completeIntermediateStep(
        run,
        workerId,
        stepKey,
        buildBusinessBriefResult(snapshot),
      );
      return { completed: false };
    }
    return finalizeFromStep<BusinessBriefResult>(
      run,
      workerId,
      stepKey,
      "analyse",
    );
  }
  if (run.template === "weekly_trading_report") {
    const input = readWeeklyInput(run.inputJson);
    if (stepKey === "snapshot") {
      const snapshot = await collectWeeklyTradingSnapshot(
        run.storeId,
        input,
        executionScope,
      );
      await completeIntermediateStep(run, workerId, stepKey, snapshot);
      return { completed: false };
    }
    if (stepKey === "analyse") {
      const snapshot = await readStepOutput<WeeklyTradingReportSnapshot>(
        run,
        "snapshot",
      );
      await completeIntermediateStep(
        run,
        workerId,
        stepKey,
        buildWeeklyTradingReportResult(snapshot),
      );
      return { completed: false };
    }
    return finalizeFromStep<WeeklyTradingReportResult>(
      run,
      workerId,
      stepKey,
      "analyse",
    );
  }

  if (run.template === "revenue_decline_investigation") {
    const input = readRevenueInput(run.inputJson);
    if (stepKey === "snapshot") {
      const snapshot = await collectRevenueDeclineSnapshot(
        run.storeId,
        input,
        executionScope,
      );
      await completeIntermediateStep(run, workerId, stepKey, snapshot);
      return { completed: false };
    }
    if (stepKey === "diagnose") {
      const snapshot = await readStepOutput<RevenueDeclineSnapshot>(
        run,
        "snapshot",
      );
      await completeIntermediateStep(
        run,
        workerId,
        stepKey,
        buildRevenueDeclineInvestigationResult(snapshot),
      );
      return { completed: false };
    }
    return finalizeFromStep<RevenueDeclineInvestigationResult>(
      run,
      workerId,
      stepKey,
      "diagnose",
    );
  }

  if (run.template === "delayed_pickup_review") {
    const input = readDelayedPickupInput(run.inputJson);
    if (stepKey === "snapshot") {
      const snapshot = await collectDelayedPickupSnapshot(
        run.storeId,
        input,
        executionScope,
      );
      await completeIntermediateStep(run, workerId, stepKey, snapshot);
      return { completed: false };
    }
    if (stepKey === "prepare") {
      const snapshot = await readStepOutput<DelayedPickupSnapshot>(
        run,
        "snapshot",
      );
      await completeIntermediateStep(
        run,
        workerId,
        stepKey,
        buildDelayedPickupReviewResult(snapshot),
      );
      return { completed: false };
    }
    return finalizeFromStep<DelayedPickupReviewResult>(
      run,
      workerId,
      stepKey,
      "prepare",
    );
  }

  if (run.template === "slow_inventory_promotion") {
    const input = readSlowInventoryInput(run.inputJson);
    if (stepKey === "snapshot") {
      const snapshot = await collectSlowInventorySnapshot(
        run.storeId,
        input,
        executionScope,
      );
      await completeIntermediateStep(run, workerId, stepKey, snapshot);
      return { completed: false };
    }
    if (stepKey === "prepare") {
      const snapshot = await readStepOutput<SlowInventorySnapshot>(
        run,
        "snapshot",
      );
      await completeIntermediateStep(
        run,
        workerId,
        stepKey,
        buildSlowInventoryPromotionResult(snapshot),
      );
      return { completed: false };
    }
    return finalizeFromStep<SlowInventoryPromotionResult>(
      run,
      workerId,
      stepKey,
      "prepare",
    );
  }

  const input = readProductLaunchInput(run.inputJson);
  if (stepKey === "snapshot") {
    const snapshot = await collectProductLaunchSnapshot(
      run.storeId,
      input,
      executionScope,
      input.defaultLowStockThreshold,
    );
    await completeIntermediateStep(run, workerId, stepKey, snapshot);
    return { completed: false };
  }
  if (stepKey === "assess") {
    const snapshot = await readStepOutput<ProductLaunchSnapshot>(
      run,
      "snapshot",
    );
    await completeIntermediateStep(
      run,
      workerId,
      stepKey,
      buildProductLaunchPreparationResult(snapshot),
    );
    return { completed: false };
  }
  return finalizeFromStep<ProductLaunchPreparationResult>(
    run,
    workerId,
    stepKey,
    "assess",
  );
}

async function finalizeFromStep<T extends MinkWorkflowResult>(
  run: ClaimedWorkflow,
  workerId: string,
  stepKey: string,
  resultStepKey: string,
): Promise<{ completed: boolean }> {
  const result = await readStepOutput<T>(run, resultStepKey);
  await completeFinalStep(run, workerId, stepKey, result);
  return { completed: true };
}

async function markStepStarted(
  run: ClaimedWorkflow,
  workerId: string,
  stepKey: string,
) {
  await withService(async (db) => {
    await assertActiveLease(db, run, workerId);
    const now = new Date().toISOString();
    await db
      .update(minkWorkflowSteps)
      .set({
        status: "running",
        attemptCount: sql`${minkWorkflowSteps.attemptCount} + 1`,
        startedAt: now,
        errorCode: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, run.storeId),
          eq(minkWorkflowSteps.stepKey, stepKey),
          inArray(minkWorkflowSteps.status, ["queued", "running"]),
        ),
      );
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: run.storeId,
      eventKey: `step-started:${stepKey}:${run.attemptCount}`,
      eventType: "step_started",
      stepKey,
      detail: { attempt: run.attemptCount },
    });
  });
}

async function completeIntermediateStep(
  run: ClaimedWorkflow,
  workerId: string,
  stepKey: string,
  output: object,
) {
  await withService(async (db) => {
    await assertActiveLease(db, run, workerId);
    const now = new Date().toISOString();
    await db
      .update(minkWorkflowSteps)
      .set({
        status: "completed",
        outputJson: output,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, run.storeId),
          eq(minkWorkflowSteps.stepKey, stepKey),
          eq(minkWorkflowSteps.status, "running"),
        ),
      );
    await db
      .update(minkWorkflowRuns)
      .set({
        status: "queued",
        currentStep: run.currentStep + 1,
        // ★★ THE RETRY BUDGET IS PER STEP, AND RESETTING IT IS WHAT STOPS A RUN
        // STRANDING. `claimWorkflow` increments `attempt_count` on EVERY claim
        // and its candidate predicate is `attempt_count < max_attempts`, so a
        // shared run-level budget is consumed by ordinary progress as well as
        // by retries. A step that SUCCEEDS on the last permitted attempt then
        // re-queued the run at the ceiling: never claimable again, and never
        // failed either, because `failExpiredExhaustedWorkflows` only looks at
        // `running`. No result, no notification, no error — the card just polls
        // `queued` forever.
        //
        // ★ THE SCHEMA ALREADY SAID SO. `max_attempts BETWEEN total_steps AND
        // 20` permits a budget equal to the step count, and at that lower bound
        // a healthy run spends every attempt just walking its steps — so ONE
        // retry would strand it. A budget that only works above its own legal
        // minimum is a per-step budget being accounted per run.
        //
        // Terminal failure is unaffected: `scheduleWorkflowRetry` still fails
        // the run after `max_attempts` consecutive failures ON ONE STEP, which
        // is the bound that was always meant.
        attemptCount: 0,
        runAfter: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(activeLeasePredicate(run, workerId));
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: run.storeId,
      eventKey: `step-completed:${stepKey}`,
      eventType: "step_completed",
      stepKey,
      detail: {},
    });
  });
}

async function completeFinalStep(
  run: ClaimedWorkflow,
  workerId: string,
  stepKey: string,
  result: MinkWorkflowResult,
) {
  await withService(async (db) => {
    await assertActiveLease(db, run, workerId);
    const now = new Date().toISOString();
    await db
      .update(minkWorkflowSteps)
      .set({
        status: "completed",
        outputJson: { reportReady: true },
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, run.storeId),
          eq(minkWorkflowSteps.stepKey, stepKey),
          eq(minkWorkflowSteps.status, "running"),
        ),
      );
    await db
      .update(minkWorkflowRuns)
      .set({
        status: "completed",
        currentStep: run.totalSteps,
        resultJson: result,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(activeLeasePredicate(run, workerId));
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: run.storeId,
      eventKey: `step-completed:${stepKey}`,
      eventType: "step_completed",
      stepKey,
      detail: {},
    });
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: run.storeId,
      eventKey: "completed",
      eventType: "completed",
      detail: {},
    });
  });
}

async function readStepOutput<T extends object>(
  run: ClaimedWorkflow,
  stepKey: string,
): Promise<T> {
  return withService(async (db) => {
    const rows = await db
      .select({ output: minkWorkflowSteps.outputJson })
      .from(minkWorkflowSteps)
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, run.storeId),
          eq(minkWorkflowSteps.stepKey, stepKey),
          eq(minkWorkflowSteps.status, "completed"),
        ),
      )
      .limit(1);
    const output = readObject(rows[0]?.output);
    if (!rows[0] || Object.keys(output).length === 0) {
      throw new Error(`missing_workflow_step:${stepKey}`);
    }
    return output as unknown as T;
  });
}

async function scheduleWorkflowRetry(
  run: ClaimedWorkflow,
  workerId: string,
  error: unknown,
): Promise<"retry" | "failed"> {
  const safeCode = workflowErrorCode(error);
  const terminal = run.attemptCount >= run.maxAttempts;
  await withService(async (db) => {
    const rows = await db
      .select({ id: minkWorkflowRuns.id })
      .from(minkWorkflowRuns)
      .where(activeLeasePredicate(run, workerId))
      .limit(1)
      .for("update");
    if (!rows[0]) return;
    const now = new Date();
    const nowIso = now.toISOString();
    await db
      .update(minkWorkflowSteps)
      .set({
        status: terminal ? "failed" : "queued",
        errorCode: safeCode,
        completedAt: terminal ? nowIso : null,
        updatedAt: nowIso,
      })
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, run.storeId),
          eq(minkWorkflowSteps.position, run.currentStep),
          eq(minkWorkflowSteps.status, "running"),
        ),
      );
    await db
      .update(minkWorkflowRuns)
      .set(
        terminal
          ? {
              status: "failed",
              errorCode: safeCode,
              errorDetail:
                "Mink could not finish this report after safe retries.",
              completedAt: nowIso,
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: nowIso,
            }
          : {
              status: "queued",
              errorCode: safeCode,
              runAfter: new Date(
                now.getTime() + Math.min(60, 2 ** run.attemptCount) * 1_000,
              ).toISOString(),
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: nowIso,
            },
      )
      .where(activeLeasePredicate(run, workerId));
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: run.storeId,
      eventKey: `${terminal ? "failed" : "retry"}:${run.attemptCount}`,
      eventType: terminal ? "failed" : "retry_scheduled",
      stepKey: workflowStepKey(run.template, run.currentStep),
      detail: { attempt: run.attemptCount, code: safeCode },
    });
  });
  if (terminal) {
    logError("mink workflow worker: workflow failed", error, {
      workflowId: run.id,
      storeId: run.storeId,
      code: safeCode,
    });
    return "failed";
  }
  logWarn("mink workflow worker: retry scheduled", {
    workflowId: run.id,
    storeId: run.storeId,
    attempt: run.attemptCount,
    code: safeCode,
  });
  return "retry";
}

async function cancelClaimedWorkflow(
  run: ClaimedWorkflow,
  workerId: string,
  reason: string,
) {
  await withService(async (db) => {
    await assertActiveLease(db, run, workerId, true);
    const now = new Date().toISOString();
    await db
      .update(minkWorkflowRuns)
      .set({
        status: "cancelled",
        errorCode: reason,
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(activeLeasePredicate(run, workerId));
    await db
      .update(minkWorkflowSteps)
      .set({ status: "cancelled", completedAt: now, updatedAt: now })
      .where(
        and(
          eq(minkWorkflowSteps.runId, run.id),
          eq(minkWorkflowSteps.storeId, run.storeId),
          inArray(minkWorkflowSteps.status, [
            "queued",
            "running",
            "waiting_approval",
          ]),
        ),
      );
    await insertWorkflowEvent(db, {
      runId: run.id,
      storeId: run.storeId,
      eventKey: "cancelled",
      eventType: "cancelled",
      detail: { reason },
    });
  });
}

function ownerPredicate(actor: MinkActorContext, workflowId: string) {
  return and(
    eq(minkWorkflowRuns.id, workflowId),
    eq(minkWorkflowRuns.storeId, actor.storeId),
    eq(minkWorkflowRuns.adminId, actor.adminId),
  );
}

function activeLeasePredicate(run: ClaimedWorkflow, workerId: string) {
  return and(
    eq(minkWorkflowRuns.id, run.id),
    eq(minkWorkflowRuns.storeId, run.storeId),
    eq(minkWorkflowRuns.status, "running"),
    eq(minkWorkflowRuns.leaseOwner, workerId),
  );
}

async function assertActiveLease(
  db: Db,
  run: ClaimedWorkflow,
  workerId: string,
  allowCancellation = false,
) {
  const rows = await db
    .select({
      id: minkWorkflowRuns.id,
      cancelRequestedAt: minkWorkflowRuns.cancelRequestedAt,
    })
    .from(minkWorkflowRuns)
    .where(activeLeasePredicate(run, workerId))
    .limit(1)
    .for("update");
  if (!rows[0]) throw new Error("workflow_lease_lost");
  if (rows[0].cancelRequestedAt && !allowCancellation) {
    throw new WorkflowCancellationRequestedError();
  }
}

async function insertWorkflowEvent(
  db: Db,
  input: {
    runId: string;
    storeId: string;
    eventKey: string;
    eventType: string;
    stepKey?: string;
    detail: Record<string, unknown>;
  },
) {
  await db
    .insert(minkWorkflowEvents)
    .values({
      runId: input.runId,
      storeId: input.storeId,
      eventKey: input.eventKey,
      eventType: input.eventType,
      stepKey: input.stepKey,
      detailJson: input.detail,
    })
    .onConflictDoNothing({
      target: [minkWorkflowEvents.runId, minkWorkflowEvents.eventKey],
    });
}

function toWorkflowView(
  run: WorkflowRow,
  events?: MinkWorkflowEventView[],
): MinkWorkflowView {
  if (
    !isMinkWorkflowStatus(run.status) ||
    !isMinkWorkflowTemplate(run.template)
  ) {
    throw new Error("Invalid Mink workflow record");
  }
  return {
    id: run.id,
    template: run.template,
    status: run.status as MinkWorkflowStatus,
    currentStep: run.currentStep,
    totalSteps: run.totalSteps,
    attemptCount: run.attemptCount,
    errorCode: run.errorCode,
    errorDetail: run.errorDetail,
    cancelRequested: run.cancelRequestedAt !== null,
    result:
      run.status === "completed"
        ? (readObject(run.resultJson) as unknown as MinkWorkflowResult)
        : null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    ...(events ? { events } : {}),
  };
}

function readWeeklyInput(value: unknown): WeeklyTradingReportInput {
  return readAuthorityInput(value, "invalid_weekly_report_input");
}

function readRevenueInput(value: unknown): RevenueDeclineInvestigationInput {
  const row = readObject(value);
  const authority = readAuthorityInput(
    value,
    "invalid_revenue_investigation_input",
  );
  if (!isRevenuePeriod(row.period)) {
    throw new Error("invalid_revenue_investigation_input");
  }
  return { ...authority, period: row.period };
}

function readProductLaunchInput(value: unknown): ProductLaunchPreparationInput {
  const row = readObject(value);
  const authority = readAuthorityInput(value, "invalid_product_launch_input");
  if (
    typeof row.productId !== "string" ||
    !UUID_PATTERN.test(row.productId) ||
    !(
      row.variantId === null ||
      (typeof row.variantId === "string" && UUID_PATTERN.test(row.variantId))
    ) ||
    typeof row.requestedSku !== "string" ||
    row.requestedSku.length < 1 ||
    row.requestedSku.length > 100 ||
    !Number.isInteger(row.defaultLowStockThreshold) ||
    Number(row.defaultLowStockThreshold) < 0 ||
    Number(row.defaultLowStockThreshold) > 1_000_000
  ) {
    throw new Error("invalid_product_launch_input");
  }
  return {
    ...authority,
    productId: row.productId,
    variantId: row.variantId as string | null,
    requestedSku: row.requestedSku,
    defaultLowStockThreshold: Number(row.defaultLowStockThreshold),
  };
}

function readSlowInventoryInput(value: unknown): SlowInventoryPromotionInput {
  const row = readObject(value);
  const authority = readAuthorityInput(value, "invalid_slow_inventory_input");
  if (!isSlowInventoryPeriod(row.period) || authority.includeUnassigned) {
    throw new Error("invalid_slow_inventory_input");
  }
  return { ...authority, period: row.period };
}

function readDelayedPickupInput(value: unknown): DelayedPickupReviewInput {
  const authority = readAuthorityInput(value, "invalid_delayed_pickup_input");
  if (authority.includeUnassigned) {
    throw new Error("invalid_delayed_pickup_input");
  }
  return authority;
}

function readBusinessBriefInput(value: unknown): BusinessBriefInput {
  const authority = readAuthorityInput(value, "invalid_business_brief_input");
  const row = readObject(value);
  if (
    (row.period !== "daily" && row.period !== "weekly") ||
    !Number.isInteger(row.defaultLowStockThreshold) ||
    Number(row.defaultLowStockThreshold) < 0 ||
    Number(row.defaultLowStockThreshold) > 1_000_000
  ) {
    throw new Error("invalid_business_brief_input");
  }
  return {
    ...authority,
    period: row.period,
    defaultLowStockThreshold: Number(row.defaultLowStockThreshold),
  };
}

function readWorkflowInput(
  template: MinkWorkflowTemplate,
  value: unknown,
):
  | BusinessBriefInput
  | WeeklyTradingReportInput
  | RevenueDeclineInvestigationInput
  | ProductLaunchPreparationInput
  | SlowInventoryPromotionInput
  | DelayedPickupReviewInput {
  if (template === "business_brief") return readBusinessBriefInput(value);
  if (template === "revenue_decline_investigation") {
    return readRevenueInput(value);
  }
  if (template === "product_launch_preparation") {
    return readProductLaunchInput(value);
  }
  if (template === "slow_inventory_promotion") {
    return readSlowInventoryInput(value);
  }
  if (template === "delayed_pickup_review") {
    return readDelayedPickupInput(value);
  }
  return readWeeklyInput(value);
}

function readAuthorityInput(
  value: unknown,
  errorCode: string,
): WeeklyTradingReportInput {
  const row = readObject(value);
  if (
    typeof row.timeZone !== "string" ||
    row.timeZone.length < 1 ||
    row.timeZone.length > 100 ||
    typeof row.currency !== "string" ||
    !/^[A-Z]{3}$/.test(row.currency) ||
    !Array.isArray(row.locationIds) ||
    row.locationIds.length > MAX_WORKFLOW_LOCATIONS ||
    !row.locationIds.every(
      (id) => typeof id === "string" && UUID_PATTERN.test(id),
    ) ||
    new Set(row.locationIds).size !== row.locationIds.length ||
    typeof row.restrictedLocationScope !== "boolean" ||
    typeof row.includeUnassigned !== "boolean" ||
    typeof row.locationLabel !== "string" ||
    row.locationLabel.length < 1 ||
    row.locationLabel.length > 200 ||
    !(
      row.requesterEmail === null ||
      (typeof row.requesterEmail === "string" &&
        row.requesterEmail.length <= 320)
    ) ||
    typeof row.requestedAt !== "string" ||
    Number.isNaN(new Date(row.requestedAt).getTime())
  ) {
    throw new Error(errorCode);
  }
  return row as unknown as WeeklyTradingReportInput;
}

function assertQueueAuthority(
  actor: MinkActorContext,
  template: MinkWorkflowTemplate,
) {
  if (!actor.runId) {
    throw new MinkToolInputError(
      "A workflow can be queued only from an active Mink AI run.",
    );
  }
  if (
    !hasWorkflowPermissions(actor.permissions, template, actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_workflow_access_denied",
      "You do not have permission to start this Mink workflow.",
      403,
    );
  }
  if (requiresWorkflowDrafting(template) && !actor.draftingEnabled) {
    throw new MinkRequestError(
      "mink_workflow_access_denied",
      "Mink drafting is not enabled for this store.",
      403,
    );
  }
}

function assertActorWorkflowAccess(
  actor: MinkActorContext,
  templateValue: unknown,
  inputValue: unknown,
) {
  if (!isMinkWorkflowTemplate(templateValue)) {
    throw new MinkRequestError(
      "mink_workflow_not_found",
      "That Mink workflow is not available.",
      404,
    );
  }
  readWorkflowInput(templateValue, inputValue);
  if (
    !hasWorkflowPermissions(
      actor.permissions,
      templateValue,
      actor.isSuperadmin,
    )
  ) {
    throw new MinkRequestError(
      "mink_workflow_access_denied",
      "You no longer have permission to view this workflow.",
      403,
    );
  }
  if (requiresWorkflowDrafting(templateValue) && !actor.draftingEnabled) {
    throw new MinkRequestError(
      "mink_workflow_access_denied",
      "You no longer have access to this private preparation workflow.",
      403,
    );
  }
}

function isRevenuePeriod(value: unknown): value is MinkRevenuePeriod {
  return value === "7d" || value === "30d" || value === "90d";
}

function isSlowInventoryPeriod(
  value: unknown,
): value is MinkSlowInventoryPeriod {
  return value === "30d" || value === "90d";
}

function workflowStepKey(
  templateValue: unknown,
  position: number,
): string | undefined {
  return isMinkWorkflowTemplate(templateValue)
    ? WORKFLOW_STEPS[templateValue][position]
    : undefined;
}

function workflowLabel(template: MinkWorkflowTemplate): string {
  if (template === "business_brief") return "Business brief";
  if (template === "revenue_decline_investigation") {
    return "Revenue decline investigation";
  }
  if (template === "product_launch_preparation") {
    return "Product launch preparation";
  }
  if (template === "slow_inventory_promotion") {
    return "Slow-inventory promotion proposal";
  }
  if (template === "delayed_pickup_review") {
    return "Delayed pickup review";
  }
  return "Weekly trading report";
}

function workflowNotificationUrl(
  template: MinkWorkflowTemplate,
  resultValue: unknown,
): string {
  if (template === "slow_inventory_promotion") {
    return "/dashboard/inventory";
  }
  if (template === "delayed_pickup_review") {
    return "/dashboard/orders";
  }
  if (template !== "product_launch_preparation") {
    return "/dashboard/analytics";
  }
  const productId = readObject(resultValue).productId;
  return typeof productId === "string" && UUID_PATTERN.test(productId)
    ? `/dashboard/products/${productId}`
    : "/dashboard/products";
}

function requiresWorkflowDrafting(template: unknown): boolean {
  return (
    template === "slow_inventory_promotion" ||
    template === "delayed_pickup_review"
  );
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function workflowErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "workflow_step_failed";
  if (/^[a-z0-9_:.-]{1,100}$/i.test(error.message)) return error.message;
  return "workflow_step_failed";
}
