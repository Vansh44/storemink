import "server-only";

import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  minkActionApprovals,
  minkActionAudit,
  minkActionToolAccess,
  minkDrafts,
  products,
  productVariants,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import type {
  MinkBulkPriceActionApproval,
  MinkBulkPriceActionLine,
  MinkBulkPriceActionResult,
  MinkBulkPriceImpactSummary,
  MinkBulkPriceValidationDetail,
} from "./bulk-price-action-types";
import {
  assertMinkSpecialPriceSupported,
  formatMoneyPaise,
  MAX_MINK_BULK_PRICE_LINES,
  moneyToPaise,
  normalizeMinkPriceSet,
  parseMinkBulkPriceDraftLines,
  type MinkBulkPriceDraftLine,
} from "./bulk-price-policy";
import {
  resolveMinkBulkPriceTargets,
  type MinkBulkPriceTarget,
} from "./bulk-price-targets";
import { MinkRequestError } from "./errors";
import type { MinkActorContext } from "./types";

const APPROVAL_TTL_MS = 5 * 60 * 1_000;
const TOOL_VERSION = 1;

type ApprovalRow = typeof minkActionApprovals.$inferSelect & {
  toolName: "bulk_update_prices";
  operation: "apply";
  status: "pending" | "executed" | "conflicted" | "expired" | "cancelled";
  resourceType: "price_bulk";
  resourceId: null;
  productId: null;
  locationId: null;
  variantId: null;
};

interface InternalPriceLine {
  line: number;
  product_id: string;
  variant_id: string | null;
  product: string;
  variant: string | null;
  sku: string;
  slug: string;
  publication_status: string;
  product_version: string;
  before_base_price: string;
  before_selling_price: string;
  before_special_price: string | null;
  before_effective_price: string;
  after_base_price: string;
  after_selling_price: string;
  after_special_price: string | null;
  after_effective_price: string;
}

interface InternalPricePayload {
  lines: InternalPriceLine[];
}

export class MinkBulkPriceValidationError extends MinkRequestError {
  constructor(
    message: string,
    public readonly lineErrors: MinkBulkPriceValidationDetail[],
  ) {
    super("mink_bulk_price_lines_invalid", message, 409);
    this.name = "MinkBulkPriceValidationError";
  }
}

export async function getLatestMinkBulkPriceAction(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkBulkPriceActionResult | null> {
  return withService(async (db) => {
    assertBulkPriceAuthority(actor);
    const rows = await db
      .select()
      .from(minkActionApprovals)
      .where(
        and(
          eq(minkActionApprovals.storeId, actor.storeId),
          eq(minkActionApprovals.adminId, actor.adminId),
          eq(minkActionApprovals.draftId, draftId),
          eq(minkActionApprovals.toolName, "bulk_update_prices"),
          eq(minkActionApprovals.status, "executed"),
        ),
      )
      .orderBy(desc(minkActionApprovals.executedAt))
      .limit(1);
    if (!rows[0]) return null;
    const approval = validateApproval(rows[0]);
    const audit = await readAudit(db, actor.storeId, approval.id);
    return {
      approval: toApproval(approval),
      auditId: audit?.id ?? null,
      repeated: true,
    };
  });
}

export async function previewMinkBulkPriceAction(input: {
  actor: MinkActorContext;
  draftId: string;
  expectedDraftVersion: number;
  idempotencyKey: string;
}): Promise<MinkBulkPriceActionApproval> {
  return withService(async (db) => {
    assertBulkPriceAuthority(input.actor);
    await lockDraft(db, input.actor, input.draftId);
    const draft = await readDraft(db, input.actor, input.draftId);
    if (draft.currentVersion !== input.expectedDraftVersion) {
      throw conflict(
        "mink_bulk_price_draft_conflict",
        "The saved bulk price proposal changed. Save and review it again.",
      );
    }
    await assertToolEnabled(db, input.actor.storeId);
    const draftLines = normalizeDraftLines(draft.content);
    const resolved = await resolveMinkBulkPriceTargets(
      db,
      input.actor,
      draftLines.map((line) => ({ sku: line.sku })),
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

export async function executeMinkBulkPriceAction(input: {
  actor: MinkActorContext;
  draftId: string;
  approvalId: string;
}): Promise<MinkBulkPriceActionResult> {
  const outcome = await withService(async (db) => {
    assertBulkPriceAuthority(input.actor);
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
        "mink_bulk_price_approval_terminal",
        "This bulk price approval is no longer available.",
      );
    }
    await assertToolEnabled(db, input.actor.storeId, true);
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      await finalizeWithoutWrite(
        db,
        approval,
        "expired",
        "Bulk price approval expired before execution.",
      );
      return {
        error: conflict(
          "mink_bulk_price_approval_expired",
          "This approval expired. Review every current price again.",
        ),
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
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The saved bulk price proposal changed after preview.",
      );
      return {
        error: conflict(
          "mink_bulk_price_draft_conflict",
          "The saved bulk price proposal changed after preview. Review it again.",
        ),
      };
    }

    await lockPriceTargets(db, input.actor.storeId, approvedPayload.lines);
    const resolved = await resolveMinkBulkPriceTargets(
      db,
      input.actor,
      approvedPayload.lines.map((line) => ({ sku: line.sku })),
    );
    const freshErrors = compareFreshTargets(approvedPayload.lines, resolved);
    if (freshErrors.length) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "One or more product prices changed after preview.",
      );
      return {
        error: new MinkBulkPriceValidationError(
          "Some price lines changed after preview. No prices were changed.",
          freshErrors,
        ),
      };
    }

    for (const line of [...approvedPayload.lines].sort((a, b) =>
      targetKey(a).localeCompare(targetKey(b)),
    )) {
      if (!(await writePrice(db, input.actor, line))) {
        throw conflict(
          "mink_bulk_price_write_conflict",
          "A product price changed during approval. No prices were changed.",
        );
      }
    }
    const variantParentIds = [
      ...new Set(
        approvedPayload.lines
          .filter((line) => line.variant_id !== null)
          .map((line) => line.product_id),
      ),
    ];
    if (variantParentIds.length) {
      await db
        .update(products)
        .set({ updatedBy: input.actor.adminId })
        .where(
          and(
            eq(products.storeId, input.actor.storeId),
            inArray(products.id, variantParentIds),
          ),
        );
    }

    const now = new Date().toISOString();
    await db
      .update(minkActionApprovals)
      .set({
        status: "executed",
        approvedAt: now,
        executedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(minkActionApprovals.id, approval.id),
          eq(minkActionApprovals.storeId, approval.storeId),
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
      resourceType: "price_bulk",
      resourceId: null,
      locationId: null,
      variantId: null,
      resourceVersionBefore: null,
      resourceVersionAfter: null,
      resultId: null,
      toolName: "bulk_update_prices",
      operation: "apply",
      outcome: "executed",
      beforeJson: approval.beforeJson,
      afterJson: approval.afterJson,
      productVersionBefore: null,
      productVersionAfter: null,
      requestHash: approval.requestHash,
      toolVersion: TOOL_VERSION,
      detail: `Applied ${approvedPayload.lines.length} exact SKU price changes atomically.`,
    });
    return {
      result: {
        approval: toApproval({
          ...approval,
          status: "executed",
          approvedAt: now,
          executedAt: now,
          updatedAt: now,
        }),
        auditId,
        repeated: false,
      },
    };
  });
  if ("error" in outcome) throw outcome.error;
  return outcome.result;
}

function buildInternalLines(
  drafts: MinkBulkPriceDraftLine[],
  resolved: Awaited<ReturnType<typeof resolveMinkBulkPriceTargets>>,
) {
  const lines: InternalPriceLine[] = [];
  const errors: MinkBulkPriceValidationDetail[] = [];
  for (const result of resolved) {
    const draft = drafts[result.line - 1];
    if (!draft) throw invalidApproval();
    if (result.error) {
      errors.push(result.error);
      continue;
    }
    const after = normalizeMinkPriceSet(
      draft.base_price,
      draft.selling_price,
      draft.special_price,
      `Line ${result.line} (${draft.sku})`,
    );
    try {
      assertMinkSpecialPriceSupported(
        after.specialPrice,
        result.target.supportsSpecialPrice,
        `Line ${result.line} (${draft.sku})`,
      );
    } catch (error) {
      errors.push({
        line: result.line,
        sku: draft.sku,
        code: "special_price_unsupported",
        message:
          error instanceof Error
            ? error.message
            : "This SKU cannot have a special price.",
      });
      continue;
    }
    if (
      after.basePrice === result.target.basePrice &&
      after.sellingPrice === result.target.sellingPrice &&
      after.specialPrice === result.target.specialPrice
    ) {
      errors.push({
        line: result.line,
        sku: draft.sku,
        code: "no_price_change",
        message: "The proposed prices are identical to the current prices.",
      });
      continue;
    }
    lines.push(internalLine(result.line, result.target, after));
  }
  return { lines, errors };
}

function internalLine(
  line: number,
  target: MinkBulkPriceTarget,
  after: ReturnType<typeof normalizeMinkPriceSet>,
): InternalPriceLine {
  return {
    line,
    product_id: target.productId,
    variant_id: target.variantId,
    product: target.productName,
    variant: target.variantName,
    sku: target.sku,
    slug: target.slug,
    publication_status: target.publicationStatus,
    product_version: target.productVersion,
    before_base_price: target.basePrice,
    before_selling_price: target.sellingPrice,
    before_special_price: target.specialPrice,
    before_effective_price: target.effectivePrice,
    after_base_price: after.basePrice,
    after_selling_price: after.sellingPrice,
    after_special_price: after.specialPrice,
    after_effective_price: after.effectivePrice,
  };
}

function compareFreshTargets(
  approved: InternalPriceLine[],
  resolved: Awaited<ReturnType<typeof resolveMinkBulkPriceTargets>>,
) {
  const errors: MinkBulkPriceValidationDetail[] = [];
  for (const result of resolved) {
    const before = approved[result.line - 1];
    if (!before) throw invalidApproval();
    if (result.error) {
      errors.push(result.error);
      continue;
    }
    const target = result.target;
    if (
      target.productId !== before.product_id ||
      target.variantId !== before.variant_id ||
      target.productName !== before.product ||
      target.variantName !== before.variant ||
      target.sku !== before.sku ||
      target.slug !== before.slug ||
      target.publicationStatus !== before.publication_status ||
      target.productVersion !== before.product_version ||
      target.basePrice !== before.before_base_price ||
      target.sellingPrice !== before.before_selling_price ||
      target.specialPrice !== before.before_special_price ||
      target.effectivePrice !== before.before_effective_price
    ) {
      errors.push({
        line: result.line,
        sku: before.sku,
        code: "checkpoint_conflict",
        message:
          "The product, variant, publication state or current price changed after preview.",
      });
    }
  }
  return errors;
}

async function writePrice(
  db: Db,
  actor: MinkActorContext,
  line: InternalPriceLine,
) {
  if (line.variant_id) {
    const updated = await db
      .update(productVariants)
      .set({
        basePrice: Number(line.after_base_price),
        sellingPrice: Number(line.after_selling_price),
        specialPrice:
          line.after_special_price === null
            ? null
            : Number(line.after_special_price),
      })
      .where(
        and(
          eq(productVariants.id, line.variant_id),
          eq(productVariants.storeId, actor.storeId),
          eq(productVariants.productId, line.product_id),
          eq(productVariants.sku, line.sku),
          eq(productVariants.basePrice, Number(line.before_base_price)),
          eq(productVariants.sellingPrice, Number(line.before_selling_price)),
          line.before_special_price === null
            ? isNull(productVariants.specialPrice)
            : eq(
                productVariants.specialPrice,
                Number(line.before_special_price),
              ),
        ),
      )
      .returning({ id: productVariants.id });
    return updated.length === 1;
  }
  const updated = await db
    .update(products)
    .set({
      basePrice: Number(line.after_base_price),
      sellingPrice: Number(line.after_selling_price),
      updatedAt: new Date().toISOString(),
      updatedBy: actor.adminId,
    })
    .where(
      and(
        eq(products.id, line.product_id),
        eq(products.storeId, actor.storeId),
        eq(products.sku, line.sku),
        eq(products.basePrice, Number(line.before_base_price)),
        eq(products.sellingPrice, Number(line.before_selling_price)),
      ),
    )
    .returning({ id: products.id });
  return updated.length === 1;
}

async function createApproval(
  db: Db,
  input: {
    actor: MinkActorContext;
    draftId: string;
    draftVersion: number;
    lines: InternalPriceLine[];
    idempotencyKey: string;
  },
) {
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const payload: InternalPricePayload = { lines: input.lines };
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
      resourceType: "price_bulk",
      resourceId: null,
      resourceVersion: null,
      resourceLabel: `${input.lines.length} SKU price changes`,
      locationId: null,
      variantId: null,
      resultId: null,
      sourceApprovalId: null,
      toolName: "bulk_update_prices",
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
      "mink_bulk_price_idempotency_conflict",
      "This approval request key was already used for a different preview.",
    );
  }
  return toApproval(row);
}

function toApproval(row: ApprovalRow): MinkBulkPriceActionApproval {
  const payload = payloadFromJson(row.afterJson);
  return {
    id: row.id,
    sourceApprovalId: null,
    toolName: "bulk_update_prices",
    operation: "apply",
    status: row.status,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    resource: {
      type: "price_bulk",
      label: row.resourceLabel ?? `${payload.lines.length} SKU price changes`,
      dashboardPath: "/dashboard/products",
      lineCount: payload.lines.length,
    },
    lines: payload.lines.map(publicLine),
    impact: impactSummary(payload.lines),
    expiresAt: row.expiresAt,
    executedAt: row.executedAt,
  };
}

function publicLine(line: InternalPriceLine): MinkBulkPriceActionLine {
  const change =
    moneyToPaise(line.after_effective_price) -
    moneyToPaise(line.before_effective_price);
  const before = moneyToPaise(line.before_effective_price);
  return {
    line: line.line,
    productId: line.product_id,
    variantId: line.variant_id,
    product: line.product,
    variant: line.variant,
    sku: line.sku,
    publicationStatus: line.publication_status,
    before: {
      basePrice: line.before_base_price,
      sellingPrice: line.before_selling_price,
      specialPrice: line.before_special_price,
      effectivePrice: line.before_effective_price,
    },
    after: {
      basePrice: line.after_base_price,
      sellingPrice: line.after_selling_price,
      specialPrice: line.after_special_price,
      effectivePrice: line.after_effective_price,
    },
    effectiveChange: signedMoney(change),
    effectiveChangePercent: percent(change, before),
  };
}

function impactSummary(lines: InternalPriceLine[]): MinkBulkPriceImpactSummary {
  const current = lines.reduce(
    (sum, line) => sum + moneyToPaise(line.before_effective_price),
    0,
  );
  const proposed = lines.reduce(
    (sum, line) => sum + moneyToPaise(line.after_effective_price),
    0,
  );
  const change = proposed - current;
  const changes = lines.map(
    (line) =>
      moneyToPaise(line.after_effective_price) -
      moneyToPaise(line.before_effective_price),
  );
  return {
    currency: "INR",
    basis: "one_unit_each",
    currentUnitBasket: formatMoneyPaise(current),
    proposedUnitBasket: formatMoneyPaise(proposed),
    change: signedMoney(change),
    changePercent: percent(change, current),
    increases: changes.filter((value) => value > 0).length,
    decreases: changes.filter((value) => value < 0).length,
    unchangedEffective: changes.filter((value) => value === 0).length,
    publishedLines: lines.filter(
      (line) => line.publication_status === "published",
    ).length,
    note: "Impact compares one unit of each selected SKU. It is not a sales or revenue forecast; existing orders retain their saved prices.",
  };
}

function payloadFromJson(value: unknown): InternalPricePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidApproval();
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 1 ||
    !Array.isArray(row.lines) ||
    row.lines.length < 1 ||
    row.lines.length > MAX_MINK_BULK_PRICE_LINES
  ) {
    throw invalidApproval();
  }
  const lines = row.lines.map((line, index) =>
    validateInternalLine(line, index),
  );
  if (new Set(lines.map((line) => line.sku)).size !== lines.length) {
    throw invalidApproval();
  }
  return { lines };
}

function validateInternalLine(
  value: unknown,
  index: number,
): InternalPriceLine {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidApproval();
  }
  const row = value as Record<string, unknown>;
  const keys = [
    "line",
    "product_id",
    "variant_id",
    "product",
    "variant",
    "sku",
    "slug",
    "publication_status",
    "product_version",
    "before_base_price",
    "before_selling_price",
    "before_special_price",
    "before_effective_price",
    "after_base_price",
    "after_selling_price",
    "after_special_price",
    "after_effective_price",
  ];
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key)) ||
    row.line !== index + 1 ||
    !isUuid(row.product_id) ||
    !isUuidOrNull(row.variant_id) ||
    !isText(row.product, 200) ||
    !isTextOrNull(row.variant, 200) ||
    !isText(row.sku, 100) ||
    !isText(row.slug, 200) ||
    !isText(row.publication_status, 30) ||
    !isIsoTimestamp(row.product_version)
  ) {
    throw invalidApproval();
  }
  let before: ReturnType<typeof normalizeMinkPriceSet>;
  let after: ReturnType<typeof normalizeMinkPriceSet>;
  try {
    before = normalizeMinkPriceSet(
      row.before_base_price,
      row.before_selling_price,
      row.before_special_price,
    );
    after = normalizeMinkPriceSet(
      row.after_base_price,
      row.after_selling_price,
      row.after_special_price,
    );
  } catch {
    throw invalidApproval();
  }
  if (
    before.basePrice !== row.before_base_price ||
    before.sellingPrice !== row.before_selling_price ||
    before.specialPrice !== row.before_special_price ||
    before.effectivePrice !== row.before_effective_price ||
    after.basePrice !== row.after_base_price ||
    after.sellingPrice !== row.after_selling_price ||
    after.specialPrice !== row.after_special_price ||
    after.effectivePrice !== row.after_effective_price ||
    (before.basePrice === after.basePrice &&
      before.sellingPrice === after.sellingPrice &&
      before.specialPrice === after.specialPrice)
  ) {
    throw invalidApproval();
  }
  return row as unknown as InternalPriceLine;
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
    draft.kind !== "bulk_price_update" ||
    draft.status !== "draft" ||
    draft.currentVersion < 1
  ) {
    throw new MinkRequestError(
      "mink_bulk_price_draft_unavailable",
      "Save this private bulk price proposal before reviewing it.",
      409,
    );
  }
  return draft;
}

function normalizeDraftLines(content: unknown) {
  try {
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      throw new Error("Bulk price content must be an object.");
    }
    const linesJson = (content as Record<string, unknown>).lines_json;
    if (typeof linesJson !== "string") {
      throw new Error("Bulk price lines are unavailable.");
    }
    return parseMinkBulkPriceDraftLines(linesJson);
  } catch (error) {
    throw new MinkRequestError(
      "mink_bulk_price_draft_invalid",
      error instanceof Error ? error.message : "Invalid bulk price proposal.",
      400,
    );
  }
}

function draftSignature(lines: MinkBulkPriceDraftLine[]) {
  return lines.map((line) => ({ ...line }));
}

function internalSignature(lines: InternalPriceLine[]) {
  return lines.map((line) => ({
    sku: line.sku,
    base_price: line.after_base_price,
    selling_price: line.after_selling_price,
    special_price: line.after_special_price ?? "",
  }));
}

function validateApproval(
  row: typeof minkActionApprovals.$inferSelect,
): ApprovalRow {
  if (
    row.toolName !== "bulk_update_prices" ||
    row.operation !== "apply" ||
    !["pending", "executed", "conflicted", "expired", "cancelled"].includes(
      row.status,
    ) ||
    row.resourceType !== "price_bulk" ||
    row.resourceId !== null ||
    row.productId !== null ||
    row.locationId !== null ||
    row.variantId !== null ||
    row.sourceApprovalId !== null ||
    row.resultId !== null
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
      where store_id = ${storeId}::uuid and tool_name = 'bulk_update_prices'
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
          eq(minkActionToolAccess.toolName, "bulk_update_prices"),
        ),
      )
      .limit(1);
    if (rows[0]?.enabled) return;
  }
  throw new MinkRequestError(
    "mink_bulk_price_tool_disabled",
    "StoreMink support has not enabled Mink bulk price updates for this store.",
    403,
  );
}

function assertBulkPriceAuthority(actor: MinkActorContext) {
  if (
    !actor.draftingEnabled ||
    !can(actor.permissions, "products", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_bulk_price_access_denied",
      "You do not have permission to manage product prices through Mink.",
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

async function lockPriceTargets(
  db: Db,
  storeId: string,
  lines: InternalPriceLine[],
) {
  const productIds = [...new Set(lines.map((line) => line.product_id))].sort();
  await db.execute(sql`
    select id from public.products
    where store_id = ${storeId}::uuid and id = any(${sql.param(productIds)}::uuid[])
    order by id for update
  `);
  const variantIds = lines
    .map((line) => line.variant_id)
    .filter((id): id is string => id !== null)
    .sort();
  if (!variantIds.length) return;
  await db.execute(sql`
    select id from public.product_variants
    where store_id = ${storeId}::uuid and id = any(${sql.param(variantIds)}::uuid[])
    order by id for update
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
  await db.insert(minkActionAudit).values({
    id: crypto.randomUUID(),
    approvalId: approval.id,
    storeId: approval.storeId,
    adminId: approval.adminId,
    draftId: approval.draftId,
    productId: null,
    resourceType: "price_bulk",
    resourceId: null,
    locationId: null,
    variantId: null,
    resourceVersionBefore: null,
    resourceVersionAfter: null,
    resultId: null,
    toolName: "bulk_update_prices",
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
}

function lineValidationError(errors: MinkBulkPriceValidationDetail[]) {
  return new MinkBulkPriceValidationError(
    `${errors.length} bulk price ${errors.length === 1 ? "line needs" : "lines need"} correction. No approval was created.`,
    errors,
  );
}

function targetKey(line: Pick<InternalPriceLine, "product_id" | "variant_id">) {
  return JSON.stringify([line.product_id, line.variant_id]);
}

function signedMoney(paise: number) {
  return `${paise > 0 ? "+" : ""}${(paise / 100).toFixed(2)}`;
}

function percent(change: number, before: number) {
  return `${change > 0 ? "+" : ""}${((change / before) * 100).toFixed(2)}%`;
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

function isText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength
  );
}

function isTextOrNull(value: unknown, maxLength: number) {
  return value === null || isText(value, maxLength);
}

function isIsoTimestamp(value: unknown) {
  return (
    typeof value === "string" &&
    value.length <= 50 &&
    Number.isFinite(Date.parse(value))
  );
}

function hashValues(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function invalidApproval() {
  return new MinkRequestError(
    "mink_bulk_price_approval_invalid",
    "This bulk price approval is invalid. Create a new preview.",
    409,
  );
}

function approvalNotFound() {
  return new MinkRequestError(
    "mink_bulk_price_approval_not_found",
    "This bulk price approval is unavailable.",
    404,
  );
}

function conflict(code: string, message: string) {
  return new MinkRequestError(code, message, 409);
}
