import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import {
  minkActionApprovals,
  minkActionAudit,
  minkActionToolAccess,
  minkDrafts,
  storeChrome,
} from "@/drizzle/schema";
import { EMPTY_DESIGN_OVERRIDES } from "@/lib/chrome/design";
import { DEFAULT_CHROME, sanitizeChromeForSave } from "@/lib/chrome/types";
import { withService, type Db } from "@/lib/db/client";
import { resolveInstalledThemeDefinitionWithDb } from "@/lib/themes/runtime-registry";
import { readThemeSelection } from "@/lib/themes/meta";
import { hashMinkActionPayload } from "./action-integrity";
import { normalizeMinkDraftContent } from "./draft-types";
import { MinkRequestError } from "./errors";
import {
  digestMinkStorefrontDesign,
  summarizeDesignChange,
} from "./storefront-design-contract";
import {
  readStoredDesign,
  validateStoredDesignProposal,
} from "./storefront-design-proposals";
import type { StorefrontDesignOverrides } from "@/lib/chrome/design";
import type { StoreChrome } from "@/lib/chrome/types";
import type { ThemeDesign } from "@/lib/themes/types";
import type {
  MinkStorefrontDesignActionApproval,
  MinkStorefrontDesignActionResult,
  MinkStorefrontDesignActionValues,
} from "./storefront-design-action-types";
import type { MinkActorContext, MinkStorefrontDesignSummary } from "./types";

// ---------------------------------------------------------------------------
// Phase 9C - saving one approved design to the private Builder draft.
//
// It mirrors 7C and 9B step for step; three things differ, and each is a
// consequence of WHERE the design lives rather than a change of policy.
//
//   1. THE ROW IS SHARED. `store_chrome.draft` holds the header, the footer,
//      the appearance variants AND the design in one jsonb value, so this
//      cannot replace the row -- it reads the current draft under the lock,
//      swaps ONE key, and writes the merged value back. A whole-row write
//      would silently revert a footer edit made between preview and approval.
//   2. THE LOCK IS THE DESIGN DIGEST, NOT `updated_at`. The builder autosaves
//      the whole chrome row on a keystroke and the chat panel floats above the
//      builder canvas, so a row-clock lock would kill an approval every time
//      the merchant nudged an unrelated field. The guarantee that matters --
//      "nothing I am overwriting moved" -- is exactly what the design digest
//      gives.
//      ⚠ SO THE DIGEST LIVES IN `before_json`, NOT IN `resource_version`.
//      That column is `timestamp with time zone` on both the approval and the
//      audit row, so a 64-character digest cannot go in it -- an insert would
//      simply fail. It carries the chrome row's `updated_at` (or NULL for a
//      store that has no row yet) as a coarse record of WHEN, while the
//      digest that actually gates the write rides in the approved values,
//      inside the canonical request hash like every other approved fact.
//   3. THE ROW MAY NOT EXIST. A store that has never opened the Brand panel
//      has no `store_chrome` row and renders `DEFAULT_CHROME`; the write is an
//      upsert onto that default rather than a refusal.
//
// `published`, `published_at` and every publication path are absent from this
// transaction and from this API, exactly as in 7C and 9B: this saves a DRAFT.
// ---------------------------------------------------------------------------

const APPROVAL_TTL_MS = 5 * 60 * 1_000;
const TOOL_NAME = "apply_storefront_design" as const;
const TOOL_VERSION = 1;

type ApprovalRow = typeof minkActionApprovals.$inferSelect & {
  toolName: typeof TOOL_NAME;
  operation: "apply";
  status: "pending" | "executed" | "conflicted" | "expired" | "cancelled";
  resourceType: "storefront_chrome";
  resourceId: string;
};

interface DesignTarget {
  storeId: string;
  rowExists: boolean;
  chrome: StoreChrome;
  design: StorefrontDesignOverrides;
  designDigest: string;
  chromeVersion: string | null;
  theme: ThemeDesign | null;
  themeName: string | null;
}

interface DesignDraft {
  id: string;
  currentVersion: number;
  original: StorefrontDesignOverrides;
  proposal: ReturnType<typeof validateStoredDesignProposal>;
}

/** Read the latest completed draft save, for a restored conversation card. */
export async function getLatestMinkStorefrontDesignAction(
  actor: MinkActorContext,
  draftId: string,
): Promise<MinkStorefrontDesignActionResult | null> {
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
    const target = await readTarget(db, actor);
    const draft = await readDraft(db, actor, approval.draftId, target.theme);
    return {
      approval: toApproval(approval, summaryFor(draft, target.theme), target),
      auditId: audit.id,
      repeated: true,
    };
  });
}

/** Create a fresh, idempotent approval against the exact current design. */
export async function previewMinkStorefrontDesignAction(input: {
  actor: MinkActorContext;
  draftId: string;
  expectedDraftVersion: number;
  idempotencyKey: string;
}): Promise<MinkStorefrontDesignActionApproval> {
  return withService(async (db) => {
    assertAuthority(input.actor);
    await lockDraft(db, input.actor, input.draftId);
    const target = await readTarget(db, input.actor);
    const draft = await readDraft(db, input.actor, input.draftId, target.theme);
    if (draft.currentVersion !== input.expectedDraftVersion) {
      throw draftConflict();
    }
    await assertToolEnabled(db, input.actor.storeId);
    assertProposalMatchesTarget(draft, target);

    const proposedDigest = digestMinkStorefrontDesign(draft.proposal.design);
    return createApproval(db, {
      actor: input.actor,
      draftId: draft.id,
      draftVersion: draft.currentVersion,
      target,
      before: values(target.design, target.designDigest),
      after: values(draft.proposal.design, proposedDigest),
      summary: summaryFor(draft, target.theme),
      idempotencyKey: input.idempotencyKey,
    });
  });
}

/**
 * Save one approved design to the private Builder draft.
 *
 * Every recheck 7C and 9B perform is performed here: tenant, drafting, Builder
 * Manage, the operator tool gate (locked), approval status and expiry, the
 * draft version, the canonical request hash, and the digest of both designs.
 * A replay of an executed approval returns the original result; anything that
 * moved underneath finalizes without a write.
 */
export async function executeMinkStorefrontDesignAction(input: {
  actor: MinkActorContext;
  draftId: string;
  approvalId: string;
}): Promise<MinkStorefrontDesignActionResult> {
  const outcome = await withService(async (db) => {
    assertAuthority(input.actor);
    await lockApproval(db, input.actor, input.approvalId);
    const approval = await readApproval(db, input.actor, input.approvalId);
    if (approval.draftId !== input.draftId) throw approvalNotFound();

    if (approval.status === "executed") {
      const audit = await readAudit(db, input.actor.storeId, approval.id);
      if (!audit) throw invalidApproval();
      const executedTarget = await readTarget(db, input.actor);
      const executedDraft = await readDraft(
        db,
        input.actor,
        approval.draftId,
        executedTarget.theme,
      );
      return {
        result: {
          approval: toApproval(
            approval,
            summaryFor(executedDraft, executedTarget.theme),
            executedTarget,
          ),
          auditId: audit.id,
          repeated: true,
        },
      };
    }
    if (approval.status !== "pending") {
      throw conflict(
        "mink_storefront_design_approval_terminal",
        "This design approval is no longer available.",
      );
    }
    await assertToolEnabled(db, input.actor.storeId, true);
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      await finalizeWithoutWrite(
        db,
        approval,
        "expired",
        "Approval expired before the storefront design was saved.",
      );
      return {
        error: conflict(
          "mink_storefront_design_approval_expired",
          "This approval expired. Review the latest design and create a new approval.",
        ),
      };
    }

    // ★★ THE CHROME ROW IS LOCKED BEFORE THE DRAFT IS RE-READ, and the order
    //    matters: the builder autosaves this row constantly, so taking it
    //    first is what stops a keystroke landing between the digest check and
    //    the merge. `store_pages` needed no such care.
    await lockChrome(db, input.actor);
    const target = await readTarget(db, input.actor);

    await lockDraft(db, input.actor, approval.draftId);
    let draft: DesignDraft;
    try {
      draft = await readDraft(db, input.actor, approval.draftId, target.theme);
    } catch (error) {
      if (!(error instanceof MinkRequestError)) throw error;
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        `The saved design proposal failed re-validation: ${error.message}`,
      );
      // ★ THE REASON IS PASSED THROUGH RATHER THAN FLATTENED TO "it changed".
      //   The commonest way to land here is a THEME SWITCH between preview and
      //   approval: contrast is judged against the resolved pair, so a palette
      //   that read perfectly over the old preset can be illegible over the
      //   new one — and the proposal itself has not changed at all. Telling a
      //   merchant their proposal "changed" would send them looking for an
      //   edit nobody made.
      return {
        error: conflict("mink_storefront_design_draft_conflict", error.message),
      };
    }

    const approvedBefore = valuesFromJson(approval.beforeJson);
    const approvedAfter = valuesFromJson(approval.afterJson);
    if (
      approval.requestHash !==
      requestHash(approval, approvedBefore, approvedAfter)
    ) {
      throw invalidApproval();
    }
    const proposedDigest = digestMinkStorefrontDesign(draft.proposal.design);
    if (
      draft.currentVersion !== approval.draftVersion ||
      draft.proposal.target.expectedDesignDigest !==
        approvedBefore.design_digest ||
      proposedDigest !== approvedAfter.design_digest
    ) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The saved design proposal changed after approval preview.",
      );
      return { error: draftConflict() };
    }

    if (
      target.designDigest !== approvedBefore.design_digest ||
      hashMinkActionPayload(values(target.design, target.designDigest)) !==
        hashMinkActionPayload(approvedBefore)
    ) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The storefront design changed after preview.",
        target.chromeVersion,
      );
      return { error: targetConflict() };
    }

    const now = new Date().toISOString();
    // ★★ ONE KEY IS REPLACED, THE REST OF THE CHROME IS CARRIED THROUGH. The
    //    value written is the draft read under this same lock, so a header or
    //    footer edit that landed before the lock survives; only `design` is
    //    ours to change.
    const nextDraft = sanitizeChromeForSave({
      ...target.chrome,
      design: draft.proposal.design,
    });
    const written = await db
      .insert(storeChrome)
      .values({
        storeId: input.actor.storeId,
        draft: nextDraft,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: storeChrome.storeId,
        set: { draft: nextDraft, updatedAt: now },
      })
      .returning({
        storeId: storeChrome.storeId,
        updatedAt: storeChrome.updatedAt,
      });
    if (!written[0]) {
      await finalizeWithoutWrite(
        db,
        approval,
        "conflicted",
        "The storefront design changed during execution.",
      );
      return { error: targetConflict() };
    }
    // ★ WHAT LANDED MUST HASH TO WHAT WAS APPROVED. `sanitizeChromeForSave`
    //   re-validates in DRAFT mode on the way past, which is more lenient than
    //   the publish-mode bar the proposal cleared -- so it cannot drop a value
    //   today. It is asserted anyway, and it THROWS: the write is inside this
    //   transaction, so rolling back is the only outcome in which the merchant
    //   has not silently been given a design nobody approved.
    const writtenDigest = digestMinkStorefrontDesign(nextDraft.design);
    if (writtenDigest !== approvedAfter.design_digest) {
      throw invalidApproval();
    }

    const finalized = await db
      .update(minkActionApprovals)
      .set({
        status: "executed",
        approvedAt: now,
        executedAt: now,
        resultId: written[0].storeId,
        resultVersion: written[0].updatedAt,
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

    const summary = summarizeDesignChange(
      nextDraft.design,
      target.design,
      target.theme,
    );
    const auditId = crypto.randomUUID();
    await db.insert(minkActionAudit).values({
      id: auditId,
      approvalId: approval.id,
      storeId: approval.storeId,
      adminId: approval.adminId,
      draftId: approval.draftId,
      productId: null,
      resourceType: "storefront_chrome",
      resourceId: approval.resourceId,
      locationId: null,
      variantId: null,
      resourceVersionBefore: approval.resourceVersion,
      resourceVersionAfter: written[0].updatedAt,
      resultId: written[0].storeId,
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
            resultId: written[0].storeId,
            resultVersion: written[0].updatedAt,
          },
          summary,
          target,
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

function summaryFor(
  draft: DesignDraft,
  theme: ThemeDesign | null,
): MinkStorefrontDesignSummary {
  return summarizeDesignChange(draft.proposal.design, draft.original, theme);
}

/** One sentence for the append-only audit row; never model-authored text. */
function auditDetail(summary: MinkStorefrontDesignSummary): string {
  const parts = [
    `${summary.palette.length} colour${summary.palette.length === 1 ? "" : "s"}`,
    `${summary.fonts.length} typeface${summary.fonts.length === 1 ? "" : "s"}`,
    `${summary.shape.length} corner radi${summary.shape.length === 1 ? "us" : "i"}`,
  ];
  return `Approved storefront design saved to the private Website Builder draft (${parts.join(", ")} changed); the published storefront was not changed.`;
}

async function createApproval(
  db: Db,
  input: {
    actor: MinkActorContext;
    draftId: string;
    draftVersion: number;
    target: DesignTarget;
    before: MinkStorefrontDesignActionValues;
    after: MinkStorefrontDesignActionValues;
    summary: MinkStorefrontDesignSummary;
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
    resourceId: input.target.storeId,
    resourceVersion: input.target.chromeVersion,
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
      resourceType: "storefront_chrome",
      resourceId: input.target.storeId,
      resourceVersion: input.target.chromeVersion,
      resourceLabel: resourceLabel(input.target.themeName),
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
      "mink_storefront_design_idempotency_conflict",
      "This approval request key was already used for a different design preview.",
    );
  }
  return toApproval(row, input.summary, input.target);
}

async function readDraft(
  db: Db,
  actor: MinkActorContext,
  draftId: string,
  theme: ThemeDesign | null,
): Promise<DesignDraft> {
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
    draft.kind !== "storefront_design" ||
    draft.status !== "proposed" ||
    draft.currentVersion !== 0
  ) {
    throw new MinkRequestError(
      "mink_storefront_design_draft_unavailable",
      "This private design proposal is not available for approval.",
      409,
    );
  }
  try {
    return {
      id: draft.id,
      currentVersion: draft.currentVersion,
      // The merchant's own prior design: a snapshot, sanitized rather than
      // held to the publish bar.
      original: readStoredDesign(
        normalizeMinkDraftContent("storefront_design", draft.before, {
          historicalSnapshot: true,
        }),
      ),
      proposal: validateStoredDesignProposal(
        normalizeMinkDraftContent("storefront_design", draft.content),
        theme,
      ),
    };
  } catch (error) {
    throw new MinkRequestError(
      "mink_storefront_design_draft_invalid",
      error instanceof Error ? error.message : "Invalid design proposal.",
      400,
    );
  }
}

async function readTarget(
  db: Db,
  actor: MinkActorContext,
): Promise<DesignTarget> {
  const result = await db.execute(sql`
    select
      store.settings,
      chrome.store_id as chrome_store_id,
      chrome.draft,
      chrome.updated_at
    from stores as store
    left join store_chrome as chrome on chrome.store_id = store.id
    where store.id = ${actor.storeId}::uuid
    limit 1
  `);
  const row = result.rows[0] as
    | {
        settings: unknown;
        chrome_store_id: string | null;
        draft: unknown;
        updated_at: string | null;
      }
    | undefined;
  if (!row) throw targetConflict();
  const settings =
    row.settings && typeof row.settings === "object"
      ? (row.settings as Record<string, unknown>)
      : {};
  const selection = readThemeSelection(settings);
  const definition = await resolveInstalledThemeDefinitionWithDb(db, selection);
  const chrome = row.chrome_store_id
    ? sanitizeChromeForSave(row.draft)
    : DEFAULT_CHROME;
  const design = chrome.design ?? EMPTY_DESIGN_OVERRIDES;
  return {
    storeId: actor.storeId,
    rowExists: Boolean(row.chrome_store_id),
    chrome,
    design,
    designDigest: digestMinkStorefrontDesign(design),
    chromeVersion: row.chrome_store_id ? row.updated_at : null,
    theme: definition?.preset.design ?? null,
    themeName: definition?.name ?? null,
  };
}

function assertProposalMatchesTarget(draft: DesignDraft, target: DesignTarget) {
  if (
    target.designDigest !== draft.proposal.target.expectedDesignDigest ||
    digestMinkStorefrontDesign(draft.original) !== target.designDigest
  ) {
    throw targetConflict();
  }
}

function values(
  design: StorefrontDesignOverrides,
  designDigest: string,
): MinkStorefrontDesignActionValues {
  const count =
    Object.keys(design.palette).length +
    Object.keys(design.shape).length +
    (design.fonts.body ? 1 : 0) +
    (design.fonts.display ? 1 : 0);
  return { design_digest: designDigest, override_count: String(count) };
}

function valuesFromJson(value: unknown): MinkStorefrontDesignActionValues {
  const keys = ["design_digest", "override_count"] as const;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => typeof value[key] !== "string") ||
    !/^[a-f0-9]{64}$/.test(String(value.design_digest)) ||
    !/^(?:0|[1-9][0-9]?)$/.test(String(value.override_count))
  ) {
    throw invalidApproval();
  }
  return value as unknown as MinkStorefrontDesignActionValues;
}

function toApproval(
  row: ApprovalRow,
  summary: MinkStorefrontDesignSummary,
  target: Pick<DesignTarget, "themeName">,
): MinkStorefrontDesignActionApproval {
  return {
    id: row.id,
    sourceApprovalId: null,
    toolName: TOOL_NAME,
    operation: "apply",
    status: row.status,
    draftId: row.draftId,
    draftVersion: row.draftVersion,
    resource: {
      type: "storefront_chrome",
      id: row.resourceId,
      label: row.resourceLabel ?? resourceLabel(target.themeName),
      dashboardPath: "/dashboard/builder",
    },
    before: valuesFromJson(row.beforeJson),
    after: valuesFromJson(row.afterJson),
    summary,
    expiresAt: row.expiresAt,
    executedAt: row.executedAt,
  };
}

function resourceLabel(themeName: string | null): string {
  return themeName ? `Storefront design · ${themeName}` : "Storefront design";
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
    row.resourceType !== "storefront_chrome" ||
    row.draftVersion !== 0 ||
    // ★ The chrome row's PK is the STORE id, so an approval naming another
    //   store's resource is a tenancy error rather than a stale pointer.
    row.resourceId !== row.storeId ||
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
        and tool_name = 'apply_storefront_design'
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
    "mink_storefront_design_tool_disabled",
    "StoreMink support has not enabled Mink storefront design saves for this store.",
    403,
  );
}

function assertAuthority(actor: MinkActorContext) {
  if (
    !actor.draftingEnabled ||
    !can(actor.permissions, "builder", "manage", actor.isSuperadmin)
  ) {
    throw new MinkRequestError(
      "mink_storefront_design_access_denied",
      "You do not have permission to save storefront designs through Mink.",
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

/**
 * Lock the chrome row.
 *
 * ⚠ A store with no row has nothing to lock, and that is safe here for one
 * reason only: the write is an upsert on the primary key, so two concurrent
 * first-time saves cannot both insert -- one waits on the other's uncommitted
 * key and then loses the digest recheck. `for update` on zero rows is a no-op
 * rather than an error, so no branch is needed.
 */
async function lockChrome(db: Db, actor: MinkActorContext) {
  await db.execute(sql`
    select store_id from public.store_chrome
    where store_id = ${actor.storeId}::uuid
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
    resourceType: "storefront_chrome",
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
  before: MinkStorefrontDesignActionValues,
  after: MinkStorefrontDesignActionValues,
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
    "mink_storefront_design_approval_invalid",
    "This design approval failed integrity validation. Create a new preview.",
    409,
  );
}

function approvalNotFound() {
  return new MinkRequestError(
    "mink_storefront_design_approval_not_found",
    "This design approval is unavailable.",
    404,
  );
}

function draftConflict() {
  return conflict(
    "mink_storefront_design_draft_conflict",
    "The saved design proposal changed. Review the latest proposal again.",
  );
}

function targetConflict() {
  return conflict(
    "mink_storefront_design_target_conflict",
    "The storefront design changed. Nothing was saved; read the current design and propose again.",
  );
}

function conflict(code: string, message: string) {
  return new MinkRequestError(code, message, 409);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
