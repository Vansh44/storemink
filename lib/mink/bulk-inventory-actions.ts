import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  inventoryLevels,
  minkActionApprovals,
  minkActionAudit,
  minkActionToolAccess,
  minkDrafts,
  stockMovements,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import {
  resolveMinkBulkInventoryTargets,
  type MinkBulkInventoryTarget,
} from "./bulk-inventory-targets";
import type {
  MinkBulkInventoryActionApproval,
  MinkBulkInventoryActionLine,
  MinkBulkInventoryActionResult,
  MinkBulkInventoryValidationDetail,
} from "./bulk-inventory-action-types";
import {
  INVENTORY_ADJUSTMENT_REASONS,
  parseMinkBulkInventoryDraftLines,
  type MinkBulkInventoryDraftLine,
} from "./draft-types";
import { MinkRequestError } from "./errors";
import type { MinkActorContext } from "./types";

const APPROVAL_TTL_MS = 5 * 60 * 1_000;
const MAX_DELTA = 1_000_000;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const TOOL_VERSION = 1;

type ApprovalRow = typeof minkActionApprovals.$inferSelect & {
  toolName: "bulk_adjust_inventory";
  operation: "apply";
  status: "pending" | "executed" | "conflicted" | "expired" | "cancelled";
  resourceType: "inventory_bulk";
  resourceId: null;
  locationId: null;
  variantId: null;
  productId: null;
};

interface InternalBulkLine {
  line: number;
  level_id: string | null;
  product_id: string;
  variant_id: string | null;
  location_id: string;
  product: string;
  variant: string | null;
  sku: string;
  location: string;
  on_hand: number;
  reserved: number;
  version: string | null;
  quantity_change: number;
  resulting_on_hand: number;
  reason: string;
  note: string;
}

interface InternalBulkPayload {
  lines: InternalBulkLine[];
}

export class MinkBulkInventoryValidationError extends MinkRequestError {
  constructor(
    message: string,
    public readonly lineErrors: MinkBulkInventoryValidationDetail[],
  ) {
    super("mink_bulk_inventory_lines_invalid", message, 409);
    this.name = "MinkBulkInventoryValidationError";
  }
}

class BulkInventoryWriteConflict extends Error {}

export async function getLatestMinkBulkInventoryAction(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkBulkInventoryActionResult | null> {
  return withService(async (db) => {
    const rows = await db
      .select()
      .from(minkActionApprovals)
      .where(
        and(
          eq(minkActionApprovals.storeId, actor.storeId),
          eq(minkActionApprovals.adminId, actor.adminId),
          eq(minkActionApprovals.draftId, draftId),
          eq(minkActionApprovals.toolName, "bulk_adjust_inventory"),
          eq(minkActionApprovals.status, "executed"),
        ),
      )
      .orderBy(desc(minkActionApprovals.executedAt))
      .limit(1);
    if (!rows[0]) return null;
    assertBulkInventoryAuthority(actor);
    const approval = validateApproval(rows[0]);
    const audit = await readAudit(db, actor.storeId, approval.id);
    return {
      approval: toApproval(approval),
      auditId: audit?.id ?? null,
      repeated: true,
    };
  });
}

export async function previewMinkBulkInventoryAction(input: {
  actor: MinkActorContext;
  draftId: string;
  expectedDraftVersion: number;
  idempotencyKey: string;
}): Promise<MinkBulkInventoryActionApproval> {
  return withService(async (db) => {
    assertBulkInventoryAuthority(input.actor);
    await lockDraft(db, input.actor, input.draftId);
    const draft = await readDraft(db, input.actor, input.draftId);
    if (draft.currentVersion !== input.expectedDraftVersion) {
      throw conflict(
        "mink_bulk_inventory_draft_conflict",
        "The saved bulk inventory proposal changed. Save and review it again.",
      );
    }
    await assertToolEnabled(db, input.actor.storeId);
    const draftLines = normalizeDraftLines(draft.content);
    const resolved = await resolveMinkBulkInventoryTargets(
      db,
      input.actor,
      draftLines.map((line) => ({
        sku: line.sku,
        locationName: line.location,
      })),
    );
    const { lines, errors } = buildInternalLines(draftLines, resolved);
    if (errors.length) throw lineValidationError(errors);
    return createApproval(db, {
      actor: input.actor,
      draftId: draft.id,
      draftVersion: draft.currentVersion,
      lines,
      idempotencyKey: input.idempotencyKey,
    });
  });
}

export async function executeMinkBulkInventoryAction(input: {
  actor: MinkActorContext;
  draftId: string;
  approvalId: string;
}): Promise<MinkBulkInventoryActionResult> {
  try {
    const outcome = await withService(async (db) => {
      assertBulkInventoryAuthority(input.actor);
      await lockApproval(db, input.actor, input.approvalId);
      const approval = await readApproval(db, input.actor, input.approvalId);
      if (approval.draftId !== input.draftId) throw approvalNotFound();
      if (approval.status === "executed") {
        const audit = await readAudit(db, input.actor.storeId, approval.id);
        return {
          result: {
            approval: toApproval(approval),
            auditId: audit?.id ?? null,
            repeated: true,
          },
        };
      }
      if (approval.status !== "pending") {
        throw conflict(
          "mink_bulk_inventory_approval_terminal",
          "This bulk inventory approval is no longer available.",
        );
      }
      await assertToolEnabled(db, input.actor.storeId, true);
      if (Date.parse(approval.expiresAt) <= Date.now()) {
        const auditId = await finalizeWithoutWrite(
          db,
          approval,
          "expired",
          "Bulk inventory approval expired before execution.",
        );
        return {
          error: new MinkRequestError(
            "mink_bulk_inventory_approval_expired",
            "This approval expired. Review all lines against current stock again.",
            409,
          ),
          auditId,
        };
      }

      await lockDraft(db, input.actor, approval.draftId);
      const draft = await readDraft(db, input.actor, approval.draftId);
      const draftLines = normalizeDraftLines(draft.content);
      const approvedPayload = payloadFromJson(approval.afterJson);
      if (
        draft.currentVersion !== approval.draftVersion ||
        hashValues(draftSignature(draftLines)) !==
          hashValues(internalSignature(approvedPayload.lines))
      ) {
        const auditId = await finalizeWithoutWrite(
          db,
          approval,
          "conflicted",
          "The saved bulk inventory proposal changed after preview.",
        );
        return {
          error: conflict(
            "mink_bulk_inventory_draft_conflict",
            "The saved bulk inventory proposal changed after preview. Review it again.",
          ),
          auditId,
        };
      }

      await lockInventoryLevels(db, input.actor.storeId, approvedPayload.lines);
      const resolved = await resolveMinkBulkInventoryTargets(
        db,
        input.actor,
        approvedPayload.lines.map((line) => ({
          sku: line.sku,
          locationName: line.location,
        })),
      );
      const conflictErrors = compareFreshTargets(
        approvedPayload.lines,
        resolved,
      );
      if (conflictErrors.length) {
        const auditId = await finalizeWithoutWrite(
          db,
          approval,
          "conflicted",
          "One or more bulk inventory lines changed after preview.",
        );
        return {
          error: new MinkBulkInventoryValidationError(
            "Some inventory lines changed after preview. No stock was changed.",
            conflictErrors,
          ),
          auditId,
        };
      }

      const mutations = [] as Array<{
        line: InternalBulkLine;
        levelId: string;
        version: string;
        movementId: string;
      }>;
      const ordered = [...approvedPayload.lines].sort((a, b) =>
        targetLockKey(a).localeCompare(targetLockKey(b)),
      );
      for (const line of ordered) {
        const mutation = await writeAdjustment(db, input.actor, line);
        if (!mutation) throw new BulkInventoryWriteConflict();
        mutations.push({ line, ...mutation });
      }

      const now = new Date().toISOString();
      await db
        .update(minkActionApprovals)
        .set({
          status: "executed",
          approvedAt: now,
          executedAt: now,
          resultId: null,
          resultVersion: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(minkActionApprovals.id, approval.id),
            eq(minkActionApprovals.storeId, input.actor.storeId),
            eq(minkActionApprovals.status, "pending"),
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
        resourceType: "inventory_bulk",
        resourceId: null,
        locationId: null,
        variantId: null,
        resourceVersionBefore: null,
        resourceVersionAfter: null,
        resultId: null,
        toolName: "bulk_adjust_inventory",
        operation: "apply",
        outcome: "executed",
        beforeJson: approval.beforeJson,
        afterJson: approvedPayload,
        productVersionBefore: null,
        productVersionAfter: null,
        requestHash: approval.requestHash,
        toolVersion: TOOL_VERSION,
        detail: `Approved atomic bulk inventory adjustment; ${mutations.length} stock movements recorded.`,
      });
      return {
        result: {
          approval: toApproval({
            ...approval,
            status: "executed",
            approvedAt: now,
            executedAt: now,
            resultId: null,
            resultVersion: null,
          }),
          auditId,
          repeated: false,
        },
      };
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.result;
  } catch (error) {
    if (!(error instanceof BulkInventoryWriteConflict)) throw error;
    return finalizeRolledBackWriteConflict(input);
  }
}

async function finalizeRolledBackWriteConflict(input: {
  actor: MinkActorContext;
  draftId: string;
  approvalId: string;
}): Promise<never> {
  const error = await withService(async (db) => {
    assertBulkInventoryAuthority(input.actor);
    await lockApproval(db, input.actor, input.approvalId);
    const approval = await readApproval(db, input.actor, input.approvalId);
    if (approval.draftId !== input.draftId) throw approvalNotFound();
    if (approval.status === "executed") {
      throw conflict(
        "mink_bulk_inventory_already_executed",
        "This bulk inventory action was already completed.",
      );
    }
    if (approval.status === "pending") {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "Inventory changed during atomic bulk execution; the transaction was rolled back.",
      );
    }
    return conflict(
      "mink_bulk_inventory_stock_conflict",
      "Inventory changed during approval. The entire batch was rolled back; review all lines again.",
    );
  });
  throw error;
}

function buildInternalLines(
  draftLines: MinkBulkInventoryDraftLine[],
  resolved: Awaited<ReturnType<typeof resolveMinkBulkInventoryTargets>>,
) {
  const lines: InternalBulkLine[] = [];
  const errors: MinkBulkInventoryValidationDetail[] = [];
  for (const result of resolved) {
    const draft = draftLines[result.line - 1];
    if (!draft) throw invalidApproval();
    if (result.error) {
      errors.push({
        line: result.line,
        sku: draft.sku,
        location: draft.location,
        code: result.error.code,
        message: result.error.message,
      });
      continue;
    }
    const resulting = result.target.onHand + draft.quantity_change;
    if (
      resulting < 0 ||
      resulting < result.target.reserved ||
      resulting > MAX_POSTGRES_INTEGER
    ) {
      errors.push({
        line: result.line,
        sku: draft.sku,
        location: draft.location,
        code: "stock_invariant",
        message:
          resulting < 0
            ? "The adjustment would reduce on-hand stock below zero."
            : resulting < result.target.reserved
              ? `The adjustment would reduce on-hand stock below ${result.target.reserved} reserved units.`
              : "The resulting stock is outside the supported range.",
      });
      continue;
    }
    lines.push(internalLine(result.line, draft, result.target, resulting));
  }
  return { lines, errors };
}

function internalLine(
  line: number,
  draft: MinkBulkInventoryDraftLine,
  target: MinkBulkInventoryTarget,
  resulting: number,
): InternalBulkLine {
  return {
    line,
    level_id: target.levelId,
    product_id: target.productId,
    variant_id: target.variantId,
    location_id: target.locationId,
    product: target.productName,
    variant: target.variantName,
    sku: target.sku,
    location: target.locationName,
    on_hand: target.onHand,
    reserved: target.reserved,
    version: target.version,
    quantity_change: draft.quantity_change,
    resulting_on_hand: resulting,
    reason: draft.reason,
    note: draft.note,
  };
}

function compareFreshTargets(
  approved: InternalBulkLine[],
  resolved: Awaited<ReturnType<typeof resolveMinkBulkInventoryTargets>>,
) {
  const errors: MinkBulkInventoryValidationDetail[] = [];
  for (const result of resolved) {
    const before = approved[result.line - 1];
    if (!before) throw invalidApproval();
    if (result.error) {
      errors.push({
        line: result.line,
        sku: before.sku,
        location: before.location,
        code: result.error.code,
        message: result.error.message,
      });
      continue;
    }
    const target = result.target;
    const resulting = target.onHand + before.quantity_change;
    if (
      target.levelId !== before.level_id ||
      target.productId !== before.product_id ||
      target.variantId !== before.variant_id ||
      target.locationId !== before.location_id ||
      target.productName !== before.product ||
      target.variantName !== before.variant ||
      target.sku !== before.sku ||
      target.locationName !== before.location ||
      target.onHand !== before.on_hand ||
      target.reserved !== before.reserved ||
      target.version !== before.version ||
      resulting !== before.resulting_on_hand ||
      resulting < 0 ||
      resulting < target.reserved ||
      resulting > MAX_POSTGRES_INTEGER
    ) {
      errors.push({
        line: result.line,
        sku: before.sku,
        location: before.location,
        code: "checkpoint_conflict",
        message:
          "The SKU, location, stock or reservation changed after preview.",
      });
    }
  }
  return errors;
}

async function writeAdjustment(
  db: Db,
  actor: MinkActorContext,
  line: InternalBulkLine,
) {
  let levelId = line.level_id;
  let version = line.version;
  if (!levelId) {
    const inserted = await db
      .insert(inventoryLevels)
      .values({
        storeId: actor.storeId,
        locationId: line.location_id,
        productId: line.product_id,
        variantId: line.variant_id,
        onHand: line.resulting_on_hand,
        reserved: 0,
      })
      .onConflictDoNothing()
      .returning({
        id: inventoryLevels.id,
        version: inventoryLevels.updatedAt,
      });
    if (!inserted[0]) return null;
    levelId = inserted[0].id;
    version = inserted[0].version;
  } else {
    if (!version) throw invalidApproval();
    const updated = await db
      .update(inventoryLevels)
      .set({
        onHand: line.resulting_on_hand,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(inventoryLevels.id, levelId),
          eq(inventoryLevels.storeId, actor.storeId),
          eq(inventoryLevels.locationId, line.location_id),
          eq(inventoryLevels.productId, line.product_id),
          line.variant_id
            ? eq(inventoryLevels.variantId, line.variant_id)
            : sql`${inventoryLevels.variantId} is null`,
          eq(inventoryLevels.onHand, line.on_hand),
          eq(inventoryLevels.reserved, line.reserved),
          eq(inventoryLevels.updatedAt, version),
        ),
      )
      .returning({
        id: inventoryLevels.id,
        version: inventoryLevels.updatedAt,
      });
    if (!updated[0]) return null;
    levelId = updated[0].id;
    version = updated[0].version;
  }
  if (!version) throw invalidApproval();
  const movements = await db
    .insert(stockMovements)
    .values({
      storeId: actor.storeId,
      productId: line.product_id,
      variantId: line.variant_id,
      locationId: line.location_id,
      delta: line.quantity_change,
      reason: line.reason,
      balanceAfter: line.resulting_on_hand,
      note: line.note || null,
      createdBy: actor.adminId,
    })
    .returning({ id: stockMovements.id });
  if (!movements[0])
    throw new Error("Inventory movement insert returned no row");
  return { levelId, version, movementId: movements[0].id };
}

async function createApproval(
  db: Db,
  input: {
    actor: MinkActorContext;
    draftId: string;
    draftVersion: number;
    lines: InternalBulkLine[];
    idempotencyKey: string;
  },
) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const payload: InternalBulkPayload = { lines: input.lines };
  const requestHash = hashValues({
    storeId: input.actor.storeId,
    adminId: input.actor.adminId,
    draftId: input.draftId,
    draftVersion: input.draftVersion,
    payload,
  });
  const inserted = await db
    .insert(minkActionApprovals)
    .values({
      id,
      storeId: input.actor.storeId,
      adminId: input.actor.adminId,
      draftId: input.draftId,
      productId: null,
      resourceType: "inventory_bulk",
      resourceId: null,
      resourceVersion: null,
      resourceLabel: `${input.lines.length} inventory adjustments`,
      locationId: null,
      variantId: null,
      sourceApprovalId: null,
      toolName: "bulk_adjust_inventory",
      operation: "apply",
      draftVersion: input.draftVersion,
      productVersion: null,
      beforeJson: payload,
      afterJson: payload,
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
      "mink_bulk_inventory_idempotency_conflict",
      "This approval request key was already used for a different preview.",
    );
  }
  return toApproval(row);
}

function toApproval(row: ApprovalRow): MinkBulkInventoryActionApproval {
  const payload = payloadFromJson(row.afterJson);
  return {
    id: row.id,
    sourceApprovalId: null,
    toolName: "bulk_adjust_inventory",
    operation: "apply",
    status: row.status,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    resource: {
      type: "inventory_bulk",
      label:
        row.resourceLabel ?? `${payload.lines.length} inventory adjustments`,
      dashboardPath: "/dashboard/inventory",
      lineCount: payload.lines.length,
    },
    lines: payload.lines.map(publicLine),
    expiresAt: row.expiresAt,
    executedAt: row.executedAt,
  };
}

function publicLine(line: InternalBulkLine): MinkBulkInventoryActionLine {
  return {
    line: line.line,
    productId: line.product_id,
    variantId: line.variant_id,
    locationId: line.location_id,
    product: line.product,
    variant: line.variant,
    sku: line.sku,
    location: line.location,
    onHand: line.on_hand,
    reserved: line.reserved,
    available: line.on_hand - line.reserved,
    quantityChange: line.quantity_change,
    resultingOnHand: line.resulting_on_hand,
    resultingAvailable: line.resulting_on_hand - line.reserved,
    reason: line.reason,
    note: line.note,
  };
}

function payloadFromJson(value: unknown): InternalBulkPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidApproval();
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => key !== "lines")) throw invalidApproval();
  if (
    !Array.isArray(row.lines) ||
    row.lines.length < 1 ||
    row.lines.length > 20
  ) {
    throw invalidApproval();
  }
  const lines = row.lines.map((item, index) =>
    validateInternalLine(item, index),
  );
  const keys = new Set(lines.map(targetLockKey));
  if (keys.size !== lines.length) throw invalidApproval();
  return { lines };
}

function validateInternalLine(value: unknown, index: number): InternalBulkLine {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidApproval();
  }
  const row = value as Record<string, unknown>;
  const exactKeys = [
    "line",
    "level_id",
    "product_id",
    "variant_id",
    "location_id",
    "product",
    "variant",
    "sku",
    "location",
    "on_hand",
    "reserved",
    "version",
    "quantity_change",
    "resulting_on_hand",
    "reason",
    "note",
  ];
  if (
    Object.keys(row).length !== exactKeys.length ||
    Object.keys(row).some((key) => !exactKeys.includes(key)) ||
    row.line !== index + 1 ||
    !isUuidOrNull(row.level_id) ||
    !isUuid(row.product_id) ||
    !isUuidOrNull(row.variant_id) ||
    !isUuid(row.location_id) ||
    !isTextOrNull(row.variant, 200) ||
    !isTextOrNull(row.version, 100) ||
    !isText(row.product, 200) ||
    !isText(row.sku, 100) ||
    !isText(row.location, 100) ||
    !Number.isInteger(row.on_hand) ||
    Number(row.on_hand) < 0 ||
    !Number.isInteger(row.reserved) ||
    Number(row.reserved) < 0 ||
    !Number.isInteger(row.quantity_change) ||
    Number(row.quantity_change) === 0 ||
    Math.abs(Number(row.quantity_change)) > MAX_DELTA ||
    !Number.isInteger(row.resulting_on_hand) ||
    Number(row.resulting_on_hand) !==
      Number(row.on_hand) + Number(row.quantity_change) ||
    Number(row.resulting_on_hand) < Number(row.reserved) ||
    Number(row.resulting_on_hand) > MAX_POSTGRES_INTEGER ||
    !isText(row.reason, 20) ||
    !INVENTORY_ADJUSTMENT_REASONS.includes(row.reason as never) ||
    (row.reason === "other" && !isText(row.note, 200)) ||
    !isText(row.note, 200, true)
  ) {
    throw invalidApproval();
  }
  return row as unknown as InternalBulkLine;
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
    draft.kind !== "bulk_inventory_adjustment" ||
    draft.status !== "draft" ||
    draft.currentVersion < 1
  ) {
    throw new MinkRequestError(
      "mink_bulk_inventory_draft_unavailable",
      "Save this private bulk inventory proposal before reviewing it.",
      409,
    );
  }
  return draft;
}

function normalizeDraftLines(content: unknown) {
  try {
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      throw new Error("Bulk inventory content must be an object.");
    }
    const linesJson = (content as Record<string, unknown>).lines_json;
    if (typeof linesJson !== "string") {
      throw new Error("Bulk inventory lines are unavailable.");
    }
    return parseMinkBulkInventoryDraftLines(linesJson);
  } catch (error) {
    throw new MinkRequestError(
      "mink_bulk_inventory_draft_invalid",
      error instanceof Error
        ? error.message
        : "Invalid bulk inventory proposal.",
      400,
    );
  }
}

function draftSignature(lines: MinkBulkInventoryDraftLine[]) {
  return lines.map((line) => ({
    sku: line.sku,
    location: line.location,
    quantity_change: line.quantity_change,
    reason: line.reason,
    note: line.note,
  }));
}

function internalSignature(lines: InternalBulkLine[]) {
  return lines.map((line) => ({
    sku: line.sku,
    location: line.location,
    quantity_change: line.quantity_change,
    reason: line.reason,
    note: line.note,
  }));
}

function validateApproval(
  row: typeof minkActionApprovals.$inferSelect,
): ApprovalRow {
  if (
    row.toolName !== "bulk_adjust_inventory" ||
    row.operation !== "apply" ||
    !["pending", "executed", "conflicted", "expired", "cancelled"].includes(
      row.status,
    ) ||
    row.resourceType !== "inventory_bulk" ||
    row.resourceId !== null ||
    row.productId !== null ||
    row.locationId !== null ||
    row.variantId !== null ||
    row.sourceApprovalId !== null
  ) {
    throw invalidApproval();
  }
  payloadFromJson(row.afterJson);
  return row as ApprovalRow;
}

async function assertToolEnabled(db: Db, storeId: string, lock = false) {
  if (lock) {
    const result = await db.execute(sql`
      select enabled from public.mink_action_tool_access
      where store_id = ${storeId}::uuid and tool_name = 'bulk_adjust_inventory'
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
          eq(minkActionToolAccess.toolName, "bulk_adjust_inventory"),
        ),
      )
      .limit(1);
    if (rows[0]?.enabled) return;
  }
  throw new MinkRequestError(
    "mink_bulk_inventory_tool_disabled",
    "StoreMink support has not enabled Mink bulk inventory adjustments for this store.",
    403,
  );
}

function assertBulkInventoryAuthority(actor: MinkActorContext) {
  if (
    !actor.draftingEnabled ||
    !can(actor.permissions, "inventory", "manage", actor.isSuperadmin)
  ) {
    throw authorityDenied();
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

async function lockInventoryLevels(
  db: Db,
  storeId: string,
  lines: InternalBulkLine[],
) {
  const ids = lines
    .map((line) => line.level_id)
    .filter((id): id is string => !!id)
    .sort();
  if (!ids.length) return;
  await db.execute(sql`
    select id from public.inventory_levels
    where store_id = ${storeId}::uuid and id = any(${sql.param(ids)}::uuid[])
    order by id
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
) {
  await db
    .update(minkActionApprovals)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(minkActionApprovals.id, approval.id),
        eq(minkActionApprovals.storeId, approval.storeId),
        eq(minkActionApprovals.status, "pending"),
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
    resourceType: "inventory_bulk",
    resourceId: null,
    locationId: null,
    variantId: null,
    resourceVersionBefore: null,
    resourceVersionAfter: null,
    resultId: null,
    toolName: "bulk_adjust_inventory",
    operation: "apply",
    outcome: status,
    beforeJson: approval.beforeJson,
    afterJson: approval.afterJson,
    productVersionBefore: null,
    productVersionAfter: null,
    requestHash: approval.requestHash,
    toolVersion: TOOL_VERSION,
    detail,
  });
  return id;
}

function lineValidationError(errors: MinkBulkInventoryValidationDetail[]) {
  return new MinkBulkInventoryValidationError(
    `${errors.length} bulk inventory ${errors.length === 1 ? "line needs" : "lines need"} correction. No approval was created.`,
    errors,
  );
}

function targetLockKey(
  line: Pick<InternalBulkLine, "product_id" | "variant_id" | "location_id">,
) {
  return JSON.stringify([line.location_id, line.product_id, line.variant_id]);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function isUuidOrNull(value: unknown): value is string | null {
  return value === null || isUuid(value);
}

function isText(
  value: unknown,
  maxLength: number,
  emptyAllowed = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    (emptyAllowed || value.length > 0)
  );
}

function isTextOrNull(value: unknown, maxLength: number) {
  return value === null || isText(value, maxLength);
}

function hashValues(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function invalidApproval() {
  return new MinkRequestError(
    "mink_bulk_inventory_approval_invalid",
    "This bulk inventory approval is invalid. Create a new preview.",
    409,
  );
}

function approvalNotFound() {
  return new MinkRequestError(
    "mink_bulk_inventory_approval_not_found",
    "This bulk inventory approval is unavailable.",
    404,
  );
}

function authorityDenied() {
  return new MinkRequestError(
    "mink_bulk_inventory_access_denied",
    "You do not have permission for one or more inventory locations or this action.",
    403,
  );
}

function conflict(code: string, message: string) {
  return new MinkRequestError(code, message, 409);
}
