import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, count, eq, gt, inArray, lte, max, sql } from "drizzle-orm";
import {
  themeStudioAssets,
  themeStudioGenerationResponses,
  themeStudioMessages,
  themeStudioProjects,
  themeStudioRuns,
  themeStudioVersions,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { getThemeDefinition, isBundledThemeId } from "@/lib/themes";
import type {
  ThemeCatalogSize,
  ThemeFeature,
  ThemeIndustry,
} from "@/lib/themes/meta";
import { createVertexModelClient, getVertexConfig } from "./gemini-vertex";
import { sharedProviderCapacity } from "./provider-capacity-store";
import { themePromptFeatures } from "./prompt-features";
import { loadVarietyContext, VarietyLeaseLostError } from "./variety-context";
import {
  readDistinctnessReport,
  type ExistingThemeFingerprint,
  type DistinctnessReport,
} from "./fingerprint";
import { getThemeStudioConfig, type ThemeStudioProvider } from "./config";
import {
  THEME_STUDIO_LIMITS,
  validateThemeIntent,
  validateThemePackageV2,
  type ThemeIntent,
  type ThemePackageV2,
} from "./contracts";
import { createFakeModelClient } from "./fake-provider";
import {
  createFakeImageClient,
  createFakeImageReviewClient,
} from "./image-fake";
import { THEME_IMAGE_REVIEW_MODEL_KEY } from "./image-review";
import {
  applyGeneratedImages,
  generatableSlots,
  productSetReferenceSha,
} from "./image-generation-core";
import { captureBlockers } from "./capture-core";
import {
  runThemeImageGeneration,
  type ThemeImageReviewer,
  type ThemeImageRunResult,
} from "./image-generation";
import {
  THEME_STUDIO_IMAGE_MODEL_KEY,
  getThemeStudioImageConfig,
} from "./image-models";
import { describeSlots } from "./slot-images-core";
import type { ThemeStudioImageClient } from "./image-provider";
import { createVertexImageClient } from "./image-vertex";
import {
  THEME_STUDIO_MODELS,
  resolveThemeStudioModel,
  type ThemeStudioModelKey,
} from "./models";
import { runThemeGeneration, type GenerationOutcome } from "./pipeline";
import type { ThemeStudioModelClient } from "./provider";
import {
  generationRecoveryDelayMs,
  resumableGenerationClient,
  type SavedModelResponse,
} from "./generation-recovery";
import { digestThemeStudioJson, recordThemeStudioEvent } from "./repository";
import { runThemeStudioVisualQaWorker } from "./visual-qa";
import {
  automaticImageProvider,
  queueAutomaticCapture,
} from "./automatic-work";
import { createImageCheckpointStore } from "./image-checkpoint-store";
import {
  IMAGE_CRASH_ATTEMPTS,
  ImageCheckpointError,
  imageReviewRecoveryDelayMs,
  resumableImageClient,
  resumableImageReview,
} from "./image-recovery";

// ---------------------------------------------------------------------------
// The Theme Studio run worker.
//
// ★ IT ACCEPTS NO OPERATOR INPUT. It claims a queued row and derives every
// other fact — the brief, the references, the model — from service-owned
// storage. Nothing a browser sent reaches it except through those rows.
//
// ★ A LEASE, NOT A LOCK HELD ACROSS WORK. A claim is one short transaction
// that marks the run `running` with an expiry; the provider call happens
// outside any transaction, and a second short transaction records the
// outcome only if this worker still holds the lease. A crashed worker's run
// becomes claimable again when its lease expires, until its attempts run out.
//
// ★ EXACTLY ONE VERSION PER RUN. `theme_studio_versions.run_id` is UNIQUE, so
// a finish that somehow ran twice cannot create a second version.
//
// ★ Logs carry ids, provider, model key, status and safe codes — never the
// brief, a reference, or model output (Phase 0 threat model).
// ---------------------------------------------------------------------------

const LEASE_SECONDS = THEME_STUDIO_LIMITS.runWallTimeSeconds;

export interface ThemeStudioWorkerResult {
  claimed: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  requeued: number;
  reaped: number;
}

type ClaimedRun = {
  id: string;
  projectId: string;
  messageId: string;
  kind: "generate" | "revise" | "images";
  baseVersionId: string | null;
  basePackageDigest: string | null;
  contextMessageIds: string[];
  /** Image runs: the slots to redraw; empty means every placeholder. */
  imageSlotIds: string[];
  provider: string;
  modelKey: string;
  providerModel: string;
  promptVersion: string;
  attemptCount: number;
  maxAttempts: number;
  rateLimitDeferrals: number;
  imageReviewDeferrals: number;
  automatic: boolean;
  qaIteration: number;
  createdBy: string | null;
};

async function reapExhaustedLeases(db: Db): Promise<number> {
  // Two kinds of dead lease end here instead of being re-run: one out of
  // attempts, and one whose operator already asked to cancel it. Reclaiming the
  // second would pay for a whole provider call only to throw the result away.
  const rows = await db.execute(sql`
    WITH expired AS (
      SELECT id, project_id, (cancel_requested_at IS NOT NULL) AS cancelled
      FROM theme_studio_runs
      WHERE status = 'running' AND lease_expires_at <= now()
        AND (attempt_count >= max_attempts OR cancel_requested_at IS NOT NULL)
      ORDER BY created_at
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    )
    UPDATE theme_studio_runs r
    SET status = CASE WHEN expired.cancelled THEN 'cancelled' ELSE 'failed' END,
        error_code = CASE WHEN expired.cancelled THEN NULL ELSE 'lease_expired' END,
        lease_owner = NULL, lease_expires_at = NULL,
        finished_at = now(), updated_at = now()
    FROM expired WHERE r.id = expired.id
    RETURNING r.id AS "id", r.project_id AS "projectId", r.status AS "status",
              r.automatic AS "automatic", r.base_version_id AS "baseVersionId"
  `);
  const reaped = rows.rows as {
    id: string;
    projectId: string;
    status: "failed" | "cancelled";
    automatic: boolean;
    baseVersionId: string | null;
  }[];
  for (const run of reaped) {
    if (
      !(await revealAutomaticBase(
        db,
        run,
        run.status === "cancelled" ? "cancelled" : "lease_expired",
      ))
    ) {
      await settleProjectWithoutVersion(db, run.projectId);
    }
    await recordThemeStudioEvent(db, {
      projectId: run.projectId,
      runId: run.id,
      actor: "worker",
      eventType: run.status === "cancelled" ? "run_cancelled" : "run_failed",
      detail: run.status === "cancelled" ? {} : { errorCode: "lease_expired" },
    });
  }
  return reaped.length;
}

async function claimRun(
  db: Db,
  workerId: string,
  providers: readonly ThemeStudioProvider[],
): Promise<ClaimedRun | null> {
  const providerList = sql.join(
    providers.map((p) => sql`${p}`),
    sql`, `,
  );
  // Older workers cannot reclaim retryable image runs without durable replay.
  // Migration 0150 gates claims on this transaction-local protocol declaration.
  const rows = await db.execute(sql`
    WITH protocol AS MATERIALIZED (
      SELECT set_config('app.theme_studio_image_recovery','v1',true)
    ), candidate AS (
      SELECT id FROM theme_studio_runs CROSS JOIN protocol
      WHERE provider IN (${providerList})
        AND ((status = 'queued' AND cancel_requested_at IS NULL
              AND (retry_not_before IS NULL OR retry_not_before <= now()))
         OR (status = 'running' AND lease_expires_at <= now()
             AND attempt_count < max_attempts AND cancel_requested_at IS NULL))
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE OF theme_studio_runs SKIP LOCKED
    )
    UPDATE theme_studio_runs r
    SET status = 'running',
        max_attempts = CASE WHEN r.kind='images' THEN ${IMAGE_CRASH_ATTEMPTS} ELSE r.max_attempts END,
        lease_owner = ${workerId}::uuid,
        lease_expires_at = now() + (${LEASE_SECONDS}::int * interval '1 second'),
        attempt_count = r.attempt_count + CASE WHEN r.retry_not_before IS NULL THEN 1 ELSE 0 END,
        retry_not_before = NULL,
        started_at = coalesce(r.started_at, now()),
        updated_at = now()
    FROM candidate WHERE r.id = candidate.id
    RETURNING r.id AS "id", r.project_id AS "projectId", r.message_id AS "messageId",
              r.kind AS "kind", r.base_version_id AS "baseVersionId",
              r.base_package_digest AS "basePackageDigest",
              r.context_message_ids AS "contextMessageIds",
              r.image_slot_ids AS "imageSlotIds",
              r.provider AS "provider", r.model_key AS "modelKey",
              r.provider_model AS "providerModel", r.prompt_version AS "promptVersion",
              r.attempt_count AS "attemptCount", r.max_attempts AS "maxAttempts",
              r.rate_limit_deferrals AS "rateLimitDeferrals",
              r.image_review_deferrals AS "imageReviewDeferrals",
              r.automatic AS "automatic", r.qa_iteration AS "qaIteration",
              r.created_by AS "createdBy"
  `);
  const row = rows.rows[0] as ClaimedRun | undefined;
  return row ?? null;
}

/**
 * ★★ AN IMAGE RUN WITH GAPS IS KEPT AND REFILLED, NEVER THROWN AWAY.
 * Measured in production (2026-09-29): an automatic run drew 14 of 18 images
 * (~$2.22) and failed as `auto_images_incomplete`, because four slots were
 * rate-limited or refused — so version 1 was revealed with every placeholder
 * and the operator had to press Generate again, which then left five more.
 * Now the images that came back are saved as a version and a FILL run is
 * queued for exactly the slots still missing, reusing the same art-direction
 * image, up to IMAGE_FILL_ROUNDS times. Only then does automatic QA capture
 * (or reveal the most complete version). A manual run is refilled the same
 * way, so "Generate images" means every image, not most of them.
 *
 * The round is recorded in the fill run's idempotency key,
 * `images_fill_<first image run id>_<round>`, which bounds the chain with no
 * new column and lets the unique key refuse a double-queue.
 */
export const IMAGE_FILL_ROUNDS = 3;
const FILL_KEY = /^images_fill_([0-9a-f-]{36})_(\d+)$/;

function fillPosition(
  runId: string,
  idempotencyKey: string | null,
): { root: string; round: number } {
  const match = idempotencyKey ? FILL_KEY.exec(idempotencyKey) : null;
  return match
    ? { root: match[1], round: Number(match[2]) }
    : { root: runId, round: 0 };
}

async function queueFillImages(
  db: Db,
  run: ClaimedRun,
  base: { id: string; packageDigest: string },
  slotIds: readonly string[],
  next: { root: string; round: number },
): Promise<boolean> {
  const resolved = automaticImageProvider(run);
  if (!resolved || slotIds.length === 0) return false;
  const [message] = await db
    .insert(themeStudioMessages)
    .values({
      projectId: run.projectId,
      kind: "images",
      body: `Draw the ${slotIds.length} image${slotIds.length === 1 ? "" : "s"} the last run could not finish (round ${next.round} of ${IMAGE_FILL_ROUNDS}).`,
      referenceAssetIds: [],
      createdBy: run.createdBy,
    })
    .returning({ id: themeStudioMessages.id });
  const [fillRun] = await db
    .insert(themeStudioRuns)
    .values({
      projectId: run.projectId,
      messageId: message.id,
      kind: "images",
      baseVersionId: base.id,
      basePackageDigest: base.packageDigest,
      contextMessageIds: [],
      provider: run.provider,
      modelKey: run.modelKey,
      providerModel: resolved.providerModel,
      promptVersion: resolved.promptVersion,
      idempotencyKey: `images_fill_${next.root}_${next.round}`,
      maxAttempts: IMAGE_CRASH_ATTEMPTS,
      imageSlotIds: [...slotIds],
      automatic: run.automatic,
      qaIteration: run.qaIteration,
      createdBy: run.createdBy,
    })
    .onConflictDoNothing({ target: themeStudioRuns.idempotencyKey })
    .returning({ id: themeStudioRuns.id });
  if (!fillRun) return false;
  await recordThemeStudioEvent(db, {
    projectId: run.projectId,
    runId: fillRun.id,
    actor: "worker",
    eventType: "images_requested",
    detail: {
      versionId: base.id,
      slots: slotIds.length,
      automatic: run.automatic,
      qaIteration: run.qaIteration,
      fillRound: next.round,
    },
  });
  return true;
}

/** Reveal the most complete version with a failed QA result for recovery. */
async function revealIncomplete(
  db: Db,
  run: ClaimedRun,
  versionId: string,
): Promise<void> {
  await revealAutomaticBase(
    db,
    { ...run, baseVersionId: versionId },
    "auto_images_incomplete",
  );
}

/** Only legal from `generating`; a project in any other state is left alone. */
async function settleProjectWithoutVersion(db: Db, projectId: string) {
  await db
    .update(themeStudioProjects)
    .set({
      status: sql`CASE WHEN ${themeStudioProjects.currentVersionId} IS NULL THEN 'failed' ELSE 'ready' END`,
      revision: sql`${themeStudioProjects.revision} + 1`,
    })
    .where(
      and(
        eq(themeStudioProjects.id, projectId),
        eq(themeStudioProjects.status, "generating"),
      ),
    );
}

/** An automated child failed after its hidden base existed. Reveal that last
 * complete base as a clearly failed QA result instead of stranding the
 * project with no operator-visible outcome. */
async function revealAutomaticBase(
  db: Db,
  run: Pick<ClaimedRun, "id" | "projectId" | "automatic" | "baseVersionId">,
  errorCode: string,
): Promise<boolean> {
  if (!run.automatic || !run.baseVersionId) return false;
  const revealed = await db
    .update(themeStudioVersions)
    .set({ visibility: "operator", qaStatus: "failed" })
    .where(
      and(
        eq(themeStudioVersions.id, run.baseVersionId),
        eq(themeStudioVersions.projectId, run.projectId),
        eq(themeStudioVersions.visibility, "internal"),
        eq(themeStudioVersions.qaStatus, "pending"),
      ),
    )
    .returning({ id: themeStudioVersions.id });
  if (revealed.length === 0) return false;
  await db
    .update(themeStudioProjects)
    .set({
      status: "ready",
      currentVersionId: run.baseVersionId,
      revision: sql`${themeStudioProjects.revision} + 1`,
    })
    .where(
      and(
        eq(themeStudioProjects.id, run.projectId),
        eq(themeStudioProjects.status, "generating"),
      ),
    );
  await recordThemeStudioEvent(db, {
    projectId: run.projectId,
    runId: run.id,
    actor: "worker",
    eventType: "auto_qa_failed",
    detail: { versionId: run.baseVersionId, errorCode },
  });
  return true;
}

type RunInput = {
  existingThemes?: ExistingThemeFingerprint[];
  project: typeof themeStudioProjects.$inferSelect;
  messages: { kind: "brief" | "revision"; body: string }[];
  references: { bytes: Buffer; sha256: string; createdAt: string }[];
  versionNumber: number;
  revision: { baseIntent: ThemeIntent; basePackage: ThemePackageV2 } | null;
};

async function loadRunInput(
  run: ClaimedRun,
  workerId: string,
): Promise<RunInput | { errorCode: string } | null> {
  return withService(async (db) => {
    const [project] = await db
      .select()
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, run.projectId))
      .limit(1);
    const [message] = await db
      .select({
        createdAt: themeStudioMessages.createdAt,
        referenceAssetIds: themeStudioMessages.referenceAssetIds,
      })
      .from(themeStudioMessages)
      .where(
        and(
          eq(themeStudioMessages.id, run.messageId),
          eq(themeStudioMessages.projectId, run.projectId),
        ),
      )
      .limit(1);
    if (!project || !message) return null;

    let messages: { kind: "brief" | "revision"; body: string }[];
    let citedReferenceIds = message.referenceAssetIds;
    let revision: RunInput["revision"] = null;
    if (run.kind === "revise") {
      // ★ Exactly the messages the run was queued with, in that order. A
      // revision never reads the original brief (its intent already carries
      // it) or a sibling branch's requests.
      const rows = run.contextMessageIds.length
        ? await db
            .select({
              id: themeStudioMessages.id,
              kind: themeStudioMessages.kind,
              body: themeStudioMessages.body,
              referenceAssetIds: themeStudioMessages.referenceAssetIds,
            })
            .from(themeStudioMessages)
            .where(
              and(
                eq(themeStudioMessages.projectId, run.projectId),
                inArray(themeStudioMessages.id, run.contextMessageIds),
              ),
            )
        : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = run.contextMessageIds.map((id) => byId.get(id));
      if (ordered.length === 0 || ordered.some((m) => !m)) return null;
      messages = ordered.map((m) => ({
        kind: m!.kind as "brief" | "revision",
        body: m!.body,
      }));
      // Each reply snapshots its own selected attachments. In particular,
      // screenshots added while answering a question must reach this run.
      citedReferenceIds = ordered.at(-1)!.referenceAssetIds;

      if (!run.baseVersionId || !run.basePackageDigest) return null;
      const [base] = await db
        .select({
          intentJson: themeStudioVersions.intentJson,
          packageJson: themeStudioVersions.packageJson,
          packageDigest: themeStudioVersions.packageDigest,
        })
        .from(themeStudioVersions)
        .where(
          and(
            eq(themeStudioVersions.id, run.baseVersionId),
            eq(themeStudioVersions.projectId, run.projectId),
          ),
        )
        .limit(1);
      if (!base || !base.packageJson) return { errorCode: "base_missing" };
      // ★ The content address is recomputed, not only compared as stored: a
      // run revises exactly the package the operator was shown.
      if (
        base.packageDigest !== run.basePackageDigest ||
        digestThemeStudioJson(base.packageJson) !== run.basePackageDigest
      ) {
        return { errorCode: "base_changed" };
      }
      const intent = validateThemeIntent(base.intentJson);
      const pkg = validateThemePackageV2(base.packageJson);
      if (!intent.ok || !pkg.ok) return { errorCode: "base_invalid" };
      revision = { baseIntent: intent.value, basePackage: pkg.value };
    } else {
      // Every message up to and including the run's own: the brief plus any
      // answers to earlier clarifying questions, in order.
      messages = (await db
        .select({
          kind: themeStudioMessages.kind,
          body: themeStudioMessages.body,
        })
        .from(themeStudioMessages)
        .where(
          and(
            eq(themeStudioMessages.projectId, run.projectId),
            lte(themeStudioMessages.createdAt, message.createdAt),
          ),
        )
        .orderBy(asc(themeStudioMessages.createdAt))) as {
        kind: "brief" | "revision";
        body: string;
      }[];
    }
    const references =
      citedReferenceIds.length > 0
        ? await db
            .select({
              id: themeStudioAssets.id,
              bytes: themeStudioAssets.bytes,
              sha256: themeStudioAssets.sha256,
              createdAt: themeStudioAssets.createdAt,
            })
            .from(themeStudioAssets)
            .where(
              and(
                eq(themeStudioAssets.projectId, run.projectId),
                eq(themeStudioAssets.purpose, "reference"),
                inArray(themeStudioAssets.id, citedReferenceIds),
              ),
            )
            .orderBy(asc(themeStudioAssets.createdAt))
        : [];
    const [{ latest }] = await db
      .select({ latest: max(themeStudioVersions.versionNumber) })
      .from(themeStudioVersions)
      .where(eq(themeStudioVersions.projectId, run.projectId));
    return {
      project,
      messages,
      ...(themePromptFeatures(run.promptVersion).variety
        ? {
            existingThemes: await loadVarietyContext(
              db,
              run.id,
              run.projectId,
              project.themeId,
              workerId,
            ),
          }
        : {}),
      references: references.sort(
        (a, b) =>
          citedReferenceIds.indexOf(a.id) - citedReferenceIds.indexOf(b.id),
      ),
      versionNumber: (latest ?? 0) + 1,
      revision,
    };
  });
}

type Outcome =
  | { kind: "generated"; result: GenerationOutcome; versionNumber: number }
  | {
      kind: "images";
      result: ThemeImageRunResult;
      distinctnessReport?: DistinctnessReport | null;
      intent: ThemeIntent;
      package: ThemePackageV2;
      versionNumber: number;
      /** A redraw's reused art-direction image, recorded like a new one. */
      reusedAnchorAssetId: string | null;
    }
  | { kind: "failed"; errorCode: string; detail?: Record<string, unknown> }
  | { kind: "retry"; errorCode: string };

/** The run's own deadline, inside its lease so a finish always holds it. */
const RUN_DEADLINE_MS = (THEME_STUDIO_LIMITS.runWallTimeSeconds - 60) * 1000;
const CANCEL_POLL_MS = 10_000;

function clientFor(
  provider: string,
  input: RunInput,
): ThemeStudioModelClient | null {
  if (provider === "fake") {
    return createFakeModelClient({
      name: input.project.name,
      brief: input.messages.map((m) => m.body).join("\n\n"),
      industries: input.project.industries as ThemeIndustry[],
      catalogSizes: input.project.catalogSizes as ThemeCatalogSize[],
      requiredFeatures: input.project.requiredFeatures as ThemeFeature[],
      referenceCount: input.references.length,
      answered: input.revision
        ? input.messages.length > 1
        : input.messages.some((m) => m.kind === "revision"),
    });
  }
  if (provider === "vertex-gemini") {
    const vertex = getVertexConfig();
    return vertex
      ? createVertexModelClient(vertex, {
          capacity: (model) =>
            sharedProviderCapacity(vertex.projectId, vertex.region, model),
        })
      : null;
  }
  return null;
}

async function cancelRequested(runId: string): Promise<boolean> {
  const [row] = await withService((db) =>
    db
      .select({ at: themeStudioRuns.cancelRequestedAt })
      .from(themeStudioRuns)
      .where(eq(themeStudioRuns.id, runId))
      .limit(1),
  );
  return Boolean(row?.at);
}

// ── Image runs (Track 3.2) ────────────────────────────────────────────────

type ImageRunInput = {
  distinctnessReport: DistinctnessReport | null;
  corrections: Record<string, string>;
  intent: ThemeIntent;
  package: ThemePackageV2;
  versionNumber: number;
};

/** The version an image run fills, re-verified exactly as a revision's is. */
async function loadImageRunInput(
  run: ClaimedRun,
): Promise<ImageRunInput | { errorCode: string }> {
  return withService(async (db) => {
    if (!run.baseVersionId || !run.basePackageDigest) {
      return { errorCode: "base_missing" };
    }
    const [base] = await db
      .select({
        distinctnessReport: themeStudioVersions.distinctnessReport,
        correctionBody: sql<
          string | null
        >`(SELECT m.body FROM theme_studio_messages m WHERE m.id=${run.messageId}::uuid AND m.project_id=${run.projectId}::uuid AND EXISTS (SELECT 1 FROM theme_studio_runs r WHERE r.message_id=m.id AND r.automatic))`,
        intentJson: themeStudioVersions.intentJson,
        packageJson: themeStudioVersions.packageJson,
        packageDigest: themeStudioVersions.packageDigest,
      })
      .from(themeStudioVersions)
      .where(
        and(
          eq(themeStudioVersions.id, run.baseVersionId),
          eq(themeStudioVersions.projectId, run.projectId),
        ),
      )
      .limit(1);
    if (!base || !base.packageJson) return { errorCode: "base_missing" };
    // ★ Recomputed, not only compared as stored: the run draws images for
    // exactly the package the operator was shown.
    if (
      base.packageDigest !== run.basePackageDigest ||
      digestThemeStudioJson(base.packageJson) !== run.basePackageDigest
    ) {
      return { errorCode: "base_changed" };
    }
    const intent = validateThemeIntent(base.intentJson);
    const pkg = validateThemePackageV2(base.packageJson);
    if (!intent.ok || !pkg.ok) return { errorCode: "base_invalid" };
    const [{ latest }] = await db
      .select({ latest: max(themeStudioVersions.versionNumber) })
      .from(themeStudioVersions)
      .where(eq(themeStudioVersions.projectId, run.projectId));
    const corrections: Record<string, string> = {};
    if (run.automatic && run.imageSlotIds.length && base.correctionBody) {
      try {
        const parsed = JSON.parse(base.correctionBody)?.qaImageCorrections;
        for (const id of run.imageSlotIds)
          if (typeof parsed?.[id] === "string" && parsed[id].length <= 800)
            corrections[id] = parsed[id];
      } catch {
        /* Older automatic image messages contain plain text. */
      }
    }
    return {
      corrections,
      distinctnessReport: readDistinctnessReport(base.distinctnessReport),
      intent: intent.value,
      package: pkg.value,
      versionNumber: (latest ?? 0) + 1,
    };
  });
}

/**
 * What a redraw reuses (Track 3.5): the art-direction image the version's
 * images were drawn to match, and a product photo to stage products against.
 *
 * ★ The anchor is found by walking up the version's parents to the nearest
 * image run that recorded one: an operator upload or an earlier redraw in
 * between writes a new version but keeps the lineage. None found (images
 * only ever uploaded) means the redraw draws a fresh anchor, like a full run.
 *
 * ★ The set shot is the first product slot in package order that is NOT
 * being redrawn and has a real image — generated or uploaded, both show the
 * staging the redrawn products should match.
 */
async function loadImageSeed(
  run: ClaimedRun,
  pkg: ThemePackageV2,
): Promise<{
  seed: {
    anchor: { bytes: Uint8Array; mediaType: "image/webp" };
    set: { bytes: Uint8Array; mediaType: "image/webp" } | null;
  };
  anchorAssetId: string;
} | null> {
  if (!run.baseVersionId) return null;
  return withService(async (db) => {
    const anchors = await db.execute(sql`
      WITH RECURSIVE chain(id, parent, run_id, depth) AS (
        SELECT v.id, v.parent_version_id, v.run_id, 0
          FROM theme_studio_versions v
         WHERE v.id = ${run.baseVersionId}::uuid AND v.project_id = ${run.projectId}::uuid
        UNION ALL
        SELECT v.id, v.parent_version_id, v.run_id, c.depth + 1
          FROM theme_studio_versions v
          JOIN chain c ON v.id = c.parent
         WHERE c.depth < 50 AND v.project_id = ${run.projectId}::uuid
      )
      SELECT a.id AS "id", a.bytes AS "bytes",
        ARRAY(
          SELECT DISTINCT asset ->> 'sha256'
            FROM chain history
            JOIN theme_studio_versions v ON v.id = history.id
            JOIN theme_studio_runs image_run ON image_run.id = history.run_id
             AND image_run.project_id = ${run.projectId}::uuid AND image_run.kind = 'images'
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(image_run.outcome_detail -> 'outcomes', '[]'::jsonb)) outcome
            CROSS JOIN LATERAL jsonb_array_elements(v.package_json -> 'assets') asset
           WHERE outcome ->> 'status' = 'generated'
             AND outcome ->> 'review' = 'passed'
             AND asset ->> 'id' = outcome ->> 'slotId'
             AND asset ->> 'kind' = 'product'
        ) AS "passedProducts"
        FROM chain c
        JOIN theme_studio_runs r ON r.id = c.run_id AND r.kind = 'images'
        JOIN theme_studio_assets a
          ON a.project_id = ${run.projectId}::uuid
         AND a.purpose = 'anchor'
         AND a.media_type = 'image/webp'
         AND a.id::text = r.outcome_detail ->> 'anchorAssetId'
       ORDER BY c.depth
       LIMIT 1
    `);
    const anchor = anchors.rows[0] as
      | { id: string; bytes: Buffer; passedProducts: string[] }
      | undefined;
    if (!anchor) return null;

    const sha = productSetReferenceSha(
      pkg,
      run.imageSlotIds,
      anchor.passedProducts,
    );
    let set: { bytes: Uint8Array; mediaType: "image/webp" } | null = null;
    if (sha) {
      const [row] = await db
        .select({ bytes: themeStudioAssets.bytes })
        .from(themeStudioAssets)
        .where(
          and(
            eq(themeStudioAssets.projectId, run.projectId),
            eq(themeStudioAssets.sha256, sha),
            eq(themeStudioAssets.purpose, "image"),
            eq(themeStudioAssets.mediaType, "image/webp"),
          ),
        )
        .limit(1);
      if (row)
        set = { bytes: new Uint8Array(row.bytes), mediaType: "image/webp" };
    }
    return {
      seed: {
        anchor: {
          bytes: new Uint8Array(anchor.bytes),
          mediaType: "image/webp",
        },
        set,
      },
      anchorAssetId: anchor.id,
    };
  });
}

function imageClientFor(provider: string): ThemeStudioImageClient | null {
  if (provider === "fake") return createFakeImageClient();
  if (provider === "vertex-gemini") {
    const config = getThemeStudioImageConfig();
    return config
      ? createVertexImageClient(config, {
          capacity: sharedProviderCapacity(
            config.projectId,
            config.location,
            config.providerModel,
          ),
        })
      : null;
  }
  return null;
}

/**
 * The vision reviewer for an image run (Track 3.4): the fast Studio text
 * model. Null when the provider has no reviewer or an operator has switched
 * that model off — the run then keeps its images, marked unreviewed, rather
 * than failing: the review is a quality check, not the safety boundary.
 */
function imageReviewerFor(provider: string): ThemeImageReviewer | null {
  if (provider === "fake") {
    return { client: createFakeImageReviewClient(), providerModel: "fake" };
  }
  if (provider !== "vertex-gemini") return null;
  if (getThemeStudioConfig().disabledModels.has(THEME_IMAGE_REVIEW_MODEL_KEY)) {
    return null;
  }
  const vertex = getVertexConfig();
  if (!vertex) return null;
  return {
    client: createVertexModelClient(vertex, {
      capacity: (model) =>
        sharedProviderCapacity(vertex.projectId, vertex.region, model),
    }),
    providerModel: resolveThemeStudioModel(THEME_IMAGE_REVIEW_MODEL_KEY)
      .providerModel,
  };
}

async function executeImages(
  run: ClaimedRun,
  workerId: string,
): Promise<Outcome> {
  if (!getThemeStudioConfig().generationEnabled) {
    return { kind: "failed", errorCode: "generation_disabled" };
  }
  const input = await loadImageRunInput(run);
  if ("errorCode" in input) {
    return { kind: "failed", errorCode: input.errorCode };
  }
  const only = run.imageSlotIds.length > 0 ? run.imageSlotIds : undefined;
  if (generatableSlots(input.package, input.intent, only).length === 0) {
    return { kind: "failed", errorCode: "images_nothing_to_draw" };
  }
  const client = imageClientFor(run.provider);
  if (!client) return { kind: "failed", errorCode: "provider_unavailable" };
  // Filling new slots beside finished artwork must keep the original style.
  // A wholly new art set may establish a fresh anchor.
  const hasFinishedArt = describeSlots(input.package).some(
    (slot) =>
      !slot.placeholder &&
      ["hero", "product", "category", "content"].includes(slot.kind),
  );
  const reuse =
    only || hasFinishedArt ? await loadImageSeed(run, input.package) : null;

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), RUN_DEADLINE_MS);
  const poll = setInterval(() => {
    void cancelRequested(run.id)
      .then((yes) => {
        if (yes) controller.abort();
      })
      .catch(() => {});
  }, CANCEL_POLL_MS);
  try {
    // An abort stops drawing new images but keeps those already drawn: a
    // timeout's images are paid for and good, and a cancel is settled by
    // finish(), which sees cancel_requested_at and writes no version.
    const store = createImageCheckpointStore({
      id: run.id,
      projectId: run.projectId,
      workerId,
    });
    const result = await runThemeImageGeneration(
      resumableImageClient(client, run.providerModel, run.promptVersion, store),
      {
        pkg: input.package,
        intent: input.intent,
        reviewer: imageReviewerFor(run.provider),
        ...(only ? { only } : {}),
        seed: reuse?.seed ?? null,
      },
      controller.signal,
      {
        review: resumableImageReview(store, run.imageReviewDeferrals),
        deferUnavailableReviews: true,
        corrections: input.corrections,
      },
    );
    return {
      kind: "images",
      distinctnessReport: input.distinctnessReport,
      result,
      intent: input.intent,
      package: input.package,
      versionNumber: input.versionNumber,
      reusedAnchorAssetId: reuse?.anchorAssetId ?? null,
    };
  } finally {
    clearTimeout(deadline);
    clearInterval(poll);
  }
}

async function execute(run: ClaimedRun, workerId: string): Promise<Outcome> {
  if (run.kind === "images") return executeImages(run, workerId);
  const config = getThemeStudioConfig();
  // Re-checked at execution, not only at queue time: the emergency stop and a
  // disabled model must also stop work that was already waiting.
  if (!config.generationEnabled) {
    return { kind: "failed", errorCode: "generation_disabled" };
  }
  if (config.disabledModels.has(run.modelKey as ThemeStudioModelKey)) {
    return { kind: "failed", errorCode: "model_disabled" };
  }
  const input = await loadRunInput(run, workerId);
  if (!input) return { kind: "failed", errorCode: "input_missing" };
  if ("errorCode" in input)
    return { kind: "failed", errorCode: input.errorCode };
  const client = clientFor(run.provider, input);
  if (!client) return { kind: "failed", errorCode: "provider_unavailable" };

  const modelKey = input.project.modelKey as ThemeStudioModelKey;
  const baseEngine =
    input.project.baseThemeId && isBundledThemeId(input.project.baseThemeId)
      ? getThemeDefinition(input.project.baseThemeId).engine
      : null;
  const baseThemeName =
    input.project.baseThemeId && isBundledThemeId(input.project.baseThemeId)
      ? getThemeDefinition(input.project.baseThemeId).name
      : null;

  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, RUN_DEADLINE_MS);
  // An operator's Cancel stops the provider call mid-flight rather than paying
  // for the rest of a run that will be thrown away.
  const poll = setInterval(() => {
    void cancelRequested(run.id)
      .then((yes) => {
        if (yes) controller.abort();
      })
      .catch(() => {});
  }, CANCEL_POLL_MS);
  try {
    const result = await runThemeGeneration(
      run.provider === "vertex-gemini"
        ? resumableGenerationClient(client, {
            read: (digest) =>
              withService(async (db) => {
                const [saved] = await db
                  .select({
                    response: themeStudioGenerationResponses.responseJson,
                  })
                  .from(themeStudioGenerationResponses)
                  .where(
                    and(
                      eq(themeStudioGenerationResponses.runId, run.id),
                      eq(themeStudioGenerationResponses.requestDigest, digest),
                    ),
                  )
                  .limit(1);
                return (
                  (saved?.response as SavedModelResponse | undefined) ?? null
                );
              }),
            write: (digest, response) =>
              withService(async (db) => {
                // Fence the checkpoint with the same lease as the final version.
                // Locking only for this short write never holds up a model call.
                const [lease] = await db
                  .select({ id: themeStudioRuns.id })
                  .from(themeStudioRuns)
                  .where(
                    and(
                      eq(themeStudioRuns.id, run.id),
                      eq(themeStudioRuns.status, "running"),
                      eq(themeStudioRuns.leaseOwner, workerId),
                    ),
                  )
                  .for("update")
                  .limit(1);
                if (!lease) throw new Error("Theme generation lost its lease.");
                await db
                  .insert(themeStudioGenerationResponses)
                  .values({
                    runId: run.id,
                    requestDigest: digest,
                    responseJson: response,
                  })
                  .onConflictDoNothing();
              }),
          })
        : client,
      {
        facts: {
          name: input.project.name,
          themeId: input.project.themeId,
          industries: input.project.industries as ThemeIndustry[],
          catalogSizes: input.project.catalogSizes,
          requiredFeatures: input.project.requiredFeatures,
          baseThemeName,
        },
        compile: {
          themeId: input.project.themeId,
          name: input.project.name,
          industries: input.project.industries as ThemeIndustry[],
          catalogSizes: input.project.catalogSizes as ThemeCatalogSize[],
          requiredFeatures: input.project.requiredFeatures as ThemeFeature[],
          baseEngine,
          versionNumber: input.versionNumber,
          modelKey,
          modelLabel:
            THEME_STUDIO_MODELS.find((m) => m.key === modelKey)?.label ??
            modelKey,
          referenceDigests: input.references.map((r) => r.sha256),
        },
        providerModel: run.providerModel,
        promptVersion: run.promptVersion,
        messages: input.messages,
        existingThemes: input.existingThemes,
        references: input.references.map((r) => ({
          base64: r.bytes.toString("base64"),
          sha256: r.sha256,
        })),
        ...(input.revision ? { revision: input.revision } : {}),
        // Old queued runs must retain their original request sequence so paid
        // Stage A checkpoints remain replayable and included in their usage.
        automaticRepair:
          run.automatic &&
          run.kind === "revise" &&
          themePromptFeatures(run.promptVersion).targetedRepair,
      },
      controller.signal,
    );
    if (controller.signal.aborted) {
      return timedOut
        ? { kind: "failed", errorCode: "run_timeout", detail: {} }
        : { kind: "generated", result, versionNumber: input.versionNumber };
    }
    return { kind: "generated", result, versionNumber: input.versionNumber };
  } catch (error) {
    if (controller.signal.aborted) {
      // A cancel is settled by finish(), which sees cancel_requested_at.
      return timedOut
        ? { kind: "failed", errorCode: "run_timeout" }
        : { kind: "failed", errorCode: "cancelled" };
    }
    throw error;
  } finally {
    clearTimeout(deadline);
    clearInterval(poll);
  }
}

type RunRow = typeof themeStudioRuns.$inferSelect;

function usageRecord(run: ClaimedRun, outcome: Outcome) {
  const telemetry =
    outcome.kind === "generated" || outcome.kind === "images"
      ? outcome.result.telemetry
      : undefined;
  return {
    provider: run.provider,
    // An image run records the image model it actually called; the run row's
    // model_key column keeps the project's text model.
    modelKey:
      run.kind === "images" ? THEME_STUDIO_IMAGE_MODEL_KEY : run.modelKey,
    providerModel: run.providerModel,
    promptVersion: run.promptVersion,
    ...(telemetry ?? {}),
  };
}

async function finish(
  workerId: string,
  run: ClaimedRun,
  outcome: Outcome,
): Promise<"succeeded" | "failed" | "cancelled" | "requeued" | "lost"> {
  return withService(async (db) => {
    const rows = await db
      .select()
      .from(themeStudioRuns)
      .where(
        and(
          eq(themeStudioRuns.id, run.id),
          eq(themeStudioRuns.status, "running"),
          eq(themeStudioRuns.leaseOwner, workerId),
          ...(run.kind === "images"
            ? [gt(themeStudioRuns.leaseExpiresAt, sql`now()`)]
            : []),
        ),
      )
      .for("update")
      .limit(1);
    if (!rows[0]) return "lost"; // lease expired and another worker took it
    const locked: RunRow = rows[0];
    const [project] = await db
      .select()
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, run.projectId))
      .for("update")
      .limit(1);

    const usage = {
      // A cancelled/timed-out replay can stop before it reconstructs telemetry.
      // Keep spend already recorded by an earlier capacity wait in that case.
      ...(outcome.kind !== "generated" && outcome.kind !== "images"
        ? (locked.usage as Record<string, unknown>)
        : {}),
      ...usageRecord(run, outcome),
      // Checkpoints own image spend, including calls from earlier claims.
      ...(run.kind === "images"
        ? (locked.usage as Record<string, unknown>)
        : {}),
    };
    const terminal = {
      leaseOwner: null,
      leaseExpiresAt: null,
      retryNotBefore: null,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
      usage,
    };
    const event = (eventType: string, detail: Record<string, unknown> = {}) =>
      recordThemeStudioEvent(db, {
        projectId: run.projectId,
        runId: run.id,
        actor: "worker",
        eventType,
        detail,
      });
    const failRun = async (
      errorCode: string,
      outcomeDetail: Record<string, unknown> = {},
    ) => {
      await db
        .update(themeStudioRuns)
        .set({ ...terminal, status: "failed", errorCode, outcomeDetail })
        .where(eq(themeStudioRuns.id, run.id));
      if (project && !(await revealAutomaticBase(db, run, errorCode))) {
        await settleProjectWithoutVersion(db, run.projectId);
      }
      await event("run_failed", { errorCode });
      return "failed" as const;
    };

    if (locked.cancelRequestedAt) {
      // Spend already incurred is still recorded, so the cap counts it.
      await db
        .update(themeStudioRuns)
        .set({ ...terminal, status: "cancelled" })
        .where(eq(themeStudioRuns.id, run.id));
      if (!(await revealAutomaticBase(db, run, "cancelled"))) {
        await settleProjectWithoutVersion(db, run.projectId);
      }
      await event("run_cancelled");
      return "cancelled";
    }

    if (outcome.kind === "retry") {
      await db
        .update(themeStudioRuns)
        .set({
          status: "queued",
          leaseOwner: null,
          leaseExpiresAt: null,
          usage,
          updatedAt: sql`now()`,
        })
        .where(eq(themeStudioRuns.id, run.id));
      return "requeued";
    }
    if (!project || project.status !== "generating") {
      return failRun("project_state_changed");
    }
    if (outcome.kind === "failed")
      return failRun(outcome.errorCode, outcome.detail);

    if (outcome.kind === "images") {
      return finishImages(db, {
        run,
        project,
        outcome,
        terminal,
        event,
        failRun,
      });
    }

    const result = outcome.result;
    if (
      result.kind === "failed" &&
      result.errorCode === "rate_limited" &&
      run.provider === "vertex-gemini"
    ) {
      const delay = generationRecoveryDelayMs(locked.rateLimitDeferrals);
      if (delay !== null) {
        const retryNotBefore = new Date(Date.now() + delay).toISOString();
        await db
          .update(themeStudioRuns)
          .set({
            status: "queued",
            leaseOwner: null,
            leaseExpiresAt: null,
            retryNotBefore,
            rateLimitDeferrals: locked.rateLimitDeferrals + 1,
            usage,
            outcomeDetail: {
              kind: "rate_limit_wait",
              stage: result.detail.stage,
            },
            updatedAt: sql`now()`,
          })
          .where(eq(themeStudioRuns.id, run.id));
        await event("run_queued", {
          reason: "rate_limited",
          retryNotBefore,
          recovery: locked.rateLimitDeferrals + 1,
        });
        return "requeued";
      }
    }
    if (result.kind === "failed")
      return failRun(result.errorCode, result.detail);
    if (result.kind === "declined") {
      return failRun("model_declined", {
        kind: "declined",
        reason: result.reason,
      });
    }
    if (result.kind === "clarify") {
      if (run.automatic) return failRun("auto_revision_clarified");
      await db
        .update(themeStudioRuns)
        .set({
          ...terminal,
          status: "succeeded",
          outcomeDetail: { kind: "clarify", questions: result.questions },
        })
        .where(eq(themeStudioRuns.id, run.id));
      await db
        .update(themeStudioProjects)
        .set({ status: "blocked", revision: project.revision + 1 })
        .where(eq(themeStudioProjects.id, run.projectId));
      await event("run_succeeded");
      await event("clarification_requested", {
        questions: result.questions.length,
      });
      return "succeeded";
    }

    // A version. Its number was fixed before the provider call because the
    // package's release version embeds it; one active run per project makes a
    // mismatch impossible in practice, and if it happens the run fails rather
    // than writing a package that disagrees with its own row.
    const [{ latest }] = await db
      .select({ latest: max(themeStudioVersions.versionNumber) })
      .from(themeStudioVersions)
      .where(eq(themeStudioVersions.projectId, run.projectId));
    if ((latest ?? 0) + 1 !== outcome.versionNumber) {
      return failRun("project_state_changed");
    }
    for (const image of result.placeholders.values()) {
      await db
        .insert(themeStudioAssets)
        .values({
          projectId: run.projectId,
          purpose: "placeholder",
          mediaType: "image/webp",
          bytes: image.bytes,
          byteSize: image.bytes.byteLength,
          width: image.width,
          height: image.height,
          sha256: image.sha256,
          originalMediaType: "image/webp",
          originalByteSize: image.bytes.byteLength,
        })
        .onConflictDoNothing({
          target: [themeStudioAssets.projectId, themeStudioAssets.sha256],
        });
    }
    const intentDigest = digestThemeStudioJson(result.intent);
    const packageDigest = digestThemeStudioJson(result.package);
    const automaticQa = run.automatic || getThemeStudioConfig().autoQaEnabled;
    const automaticSlots = automaticQa
      ? generatableSlots(result.package, result.intent).length
      : 0;
    if (run.automatic && !getThemeStudioConfig().autoQaEnabled) {
      return failRun("auto_qa_disabled");
    }
    if (automaticSlots > 0 && !automaticImageProvider(run)) {
      return failRun("image_provider_unavailable");
    }
    const [version] = await db
      .insert(themeStudioVersions)
      .values({
        projectId: run.projectId,
        runId: run.id,
        // A revision's parent is the version it revised — which is how a
        // revision of an older version becomes a branch.
        parentVersionId: run.baseVersionId ?? project.currentVersionId,
        versionNumber: outcome.versionNumber,
        intentJson: result.intent,
        intentDigest,
        packageJson: result.package,
        distinctnessReport: result.distinctness ?? null,
        packageDigest,
        ...(automaticQa
          ? {
              visibility: "internal",
              qaStatus: "pending",
              qaIteration: run.qaIteration,
            }
          : {}),
      })
      .returning({
        id: themeStudioVersions.id,
        versionNumber: themeStudioVersions.versionNumber,
      });
    await db
      .update(themeStudioRuns)
      .set({ ...terminal, status: "succeeded" })
      .where(eq(themeStudioRuns.id, run.id));
    await db
      .update(themeStudioProjects)
      .set({
        status: automaticQa ? "generating" : "ready",
        ...(automaticQa ? {} : { currentVersionId: version.id }),
        revision: project.revision + 1,
      })
      .where(eq(themeStudioProjects.id, run.projectId));
    await event("run_succeeded");
    await event("version_created", {
      versionId: version.id,
      versionNumber: version.versionNumber,
      intentDigest,
      packageDigest,
      placeholders: result.placeholders.size,
      parentVersionId: run.baseVersionId ?? project.currentVersionId,
      automaticQa,
      qaIteration: run.qaIteration,
    });
    if (automaticQa) {
      await event("auto_qa_started", {
        versionId: version.id,
        qaIteration: run.qaIteration,
      });
      // Measure the native layout with its planned image ratios before paying
      // for artwork. Passing this stage cannot create acceptance evidence.
      await queueAutomaticCapture(db, run, version, packageDigest, "layout");
    }
    return "succeeded";
  });
}

/**
 * Settle an image run: store the anchor and each generated image, then write
 * ONE version whose package points at them and whose parent is the version
 * filled. Nothing generated is a failure that keeps the base version current.
 */
async function finishImages(
  db: Db,
  ctx: {
    run: ClaimedRun;
    project: typeof themeStudioProjects.$inferSelect;
    outcome: Extract<Outcome, { kind: "images" }>;
    terminal: Record<string, unknown>;
    event: (type: string, detail?: Record<string, unknown>) => Promise<void>;
    failRun: (
      errorCode: string,
      detail?: Record<string, unknown>,
    ) => Promise<"failed">;
  },
): Promise<"succeeded" | "failed" | "requeued"> {
  const { run, project, outcome, terminal, event, failRun } = ctx;
  const result = outcome.result;
  const detail = {
    kind: "images",
    outcomes: result.outcomes,
    ...(result.anchorFailure ? { anchorFailure: result.anchorFailure } : {}),
    ...(result.anchorFailure?.kind === "refused"
      ? { category: result.anchorFailure.reason ?? "IMAGE_SAFETY" }
      : {}),
  };
  const pending = result.outcomes.filter(
    (o) => o.status === "failed" && o.code === "image_review_pending",
  );
  if (
    (result.anchorFailure?.kind === "failed" &&
      result.anchorFailure.code === "image_review_pending") ||
    pending.length
  ) {
    const delay = imageReviewRecoveryDelayMs(run.imageReviewDeferrals);
    if (delay === null) return failRun("image_review_unavailable", detail);
    const retryNotBefore = new Date(Date.now() + delay).toISOString();
    await db
      .update(themeStudioRuns)
      .set({
        status: "queued",
        leaseOwner: null,
        leaseExpiresAt: null,
        retryNotBefore,
        imageReviewDeferrals: run.imageReviewDeferrals + 1,
        usage: terminal.usage,
        outcomeDetail: { ...detail, kind: "image_review_wait" },
        updatedAt: sql`now()`,
      })
      .where(eq(themeStudioRuns.id, run.id));
    await event("run_queued", {
      reason: "image_review_unavailable",
      retryNotBefore,
      recovery: run.imageReviewDeferrals + 1,
    });
    return "requeued";
  }
  if (result.anchorFailure) {
    const failure = result.anchorFailure;
    return failRun(
      failure.kind === "refused"
        ? "images_anchor_refused"
        : failure.kind === "rejected"
          ? "images_anchor_rejected"
          : `images_anchor_${failure.code}`.slice(0, 64),
      detail,
    );
  }
  const missing = result.outcomes
    .filter((o) => o.status !== "generated")
    .map((o) => o.slotId);
  const [self] = await db
    .select({ idempotencyKey: themeStudioRuns.idempotencyKey })
    .from(themeStudioRuns)
    .where(eq(themeStudioRuns.id, run.id))
    .limit(1);
  const position = fillPosition(run.id, self?.idempotencyKey ?? null);
  const nextFill =
    missing.length > 0 && position.round < IMAGE_FILL_ROUNDS
      ? { root: position.root, round: position.round + 1 }
      : null;
  if (result.images.length === 0) {
    // Nothing came back (a rate-limit storm): try the same slots again on the
    // same base while rounds remain, rather than giving up.
    if (nextFill && run.baseVersionId && run.basePackageDigest) {
      await db
        .update(themeStudioRuns)
        .set({
          ...terminal,
          status: "failed",
          errorCode: "images_none",
          outcomeDetail: detail,
        })
        .where(eq(themeStudioRuns.id, run.id));
      await event("run_failed", { errorCode: "images_none" });
      if (
        await queueFillImages(
          db,
          run,
          { id: run.baseVersionId, packageDigest: run.basePackageDigest },
          missing,
          nextFill,
        )
      ) {
        return "failed";
      }
      if (!(await revealAutomaticBase(db, run, "images_none"))) {
        await settleProjectWithoutVersion(db, run.projectId);
      }
      return "failed";
    }
    return failRun("images_none", detail);
  }
  if (run.automatic && !getThemeStudioConfig().autoQaEnabled) {
    return failRun("auto_qa_disabled", detail);
  }

  const [{ latest }] = await db
    .select({ latest: max(themeStudioVersions.versionNumber) })
    .from(themeStudioVersions)
    .where(eq(themeStudioVersions.projectId, run.projectId));
  if ((latest ?? 0) + 1 !== outcome.versionNumber) {
    return failRun("project_state_changed");
  }
  const applied = applyGeneratedImages(
    outcome.package,
    result.images.map(({ slotId, image }) => ({
      slotId,
      sha256: image.sha256,
      width: image.width,
      height: image.height,
    })),
    outcome.versionNumber,
    THEME_STUDIO_IMAGE_MODEL_KEY,
  );
  if (!applied.ok) return failRun("images_package_invalid", detail);

  const store = async (
    image: ThemeImageRunResult["images"][number]["image"],
    purpose: "image" | "anchor",
  ) => {
    await db
      .insert(themeStudioAssets)
      .values({
        projectId: run.projectId,
        purpose,
        mediaType: "image/webp",
        bytes: Buffer.from(image.bytes),
        byteSize: image.bytes.byteLength,
        width: image.width,
        height: image.height,
        sha256: image.sha256,
        originalMediaType: image.originalMediaType,
        originalByteSize: image.originalByteSize,
      })
      .onConflictDoNothing({
        target: [themeStudioAssets.projectId, themeStudioAssets.sha256],
      });
    const [row] = await db
      .select({ id: themeStudioAssets.id, purpose: themeStudioAssets.purpose })
      .from(themeStudioAssets)
      .where(
        and(
          eq(themeStudioAssets.projectId, run.projectId),
          eq(themeStudioAssets.sha256, image.sha256),
        ),
      )
      .limit(1);
    return row ?? null;
  };
  for (const { image } of result.images) {
    const row = await store(image, "image");
    // The same bytes stored earlier under another purpose would be served and
    // published by the wrong rules; refuse rather than point a slot at it.
    if (!row || row.purpose !== "image") {
      return failRun("images_asset_conflict", detail);
    }
  }
  const anchorRow = result.anchor ? await store(result.anchor, "anchor") : null;

  const intentDigest = digestThemeStudioJson(outcome.intent);
  const packageDigest = digestThemeStudioJson(applied.value);
  const [version] = await db
    .insert(themeStudioVersions)
    .values({
      projectId: run.projectId,
      runId: run.id,
      parentVersionId: run.baseVersionId,
      versionNumber: outcome.versionNumber,
      distinctnessReport: outcome.distinctnessReport ?? null,
      intentJson: outcome.intent,
      intentDigest,
      packageJson: applied.value,
      packageDigest,
      ...(run.automatic
        ? {
            visibility: "internal",
            qaStatus: "pending",
            qaIteration: run.qaIteration,
          }
        : {}),
    })
    .returning({
      id: themeStudioVersions.id,
      versionNumber: themeStudioVersions.versionNumber,
    });
  await db
    .update(themeStudioRuns)
    .set({
      ...terminal,
      status: "succeeded",
      outcomeDetail: {
        ...detail,
        // A redraw records the anchor it reused, so the next redraw finds it
        // on this run without walking further.
        ...(anchorRow?.purpose === "anchor"
          ? { anchorAssetId: anchorRow.id }
          : outcome.reusedAnchorAssetId
            ? { anchorAssetId: outcome.reusedAnchorAssetId }
            : {}),
      },
    })
    .where(eq(themeStudioRuns.id, run.id));
  // A fill run is queued in this transaction, before the project settles, so
  // a manual chain stays `generating` until every round is done.
  const filling = nextFill
    ? await queueFillImages(
        db,
        run,
        { id: version.id, packageDigest },
        missing,
        nextFill,
      )
    : false;
  await db
    .update(themeStudioProjects)
    .set({
      status: run.automatic || filling ? "generating" : "ready",
      ...(run.automatic ? {} : { currentVersionId: version.id }),
      revision: project.revision + 1,
    })
    .where(eq(themeStudioProjects.id, run.projectId));
  await event("run_succeeded");
  await event("version_created", {
    versionId: version.id,
    versionNumber: version.versionNumber,
    intentDigest,
    packageDigest,
    images: result.images.length,
    imagesMissing: missing.length,
    fillQueued: filling,
    parentVersionId: run.baseVersionId,
    automaticQa: run.automatic,
    qaIteration: run.qaIteration,
  });
  if (run.automatic && !filling) {
    // Every round is spent: capture only a complete version, otherwise reveal
    // the most complete one as a failed QA result.
    if (captureBlockers(applied.value).length > 0) {
      await revealIncomplete(db, run, version.id);
    } else {
      await queueAutomaticCapture(db, run, version, packageDigest);
    }
  }
  return "succeeded";
}

/** Drain a bounded amount of queued work. Safe to call concurrently: claims
 * use SKIP LOCKED and finishes are fenced on the lease owner. */
export async function runThemeStudioWorker(
  options: {
    maxRuns?: number;
    budgetMs?: number;
    /** Which providers this invocation may execute. The shared heartbeat and
     * the after-response kick pass only `fake`, which finishes instantly; a
     * model run can take many minutes and runs only on the dedicated worker
     * route, where it has its own long request. */
    providers?: readonly ThemeStudioProvider[];
    /** The dedicated route gives visual QA its own concurrent lane. */
    skipVisualQa?: boolean;
  } = {},
): Promise<ThemeStudioWorkerResult> {
  const maxRuns = options.maxRuns ?? 5;
  const providers = options.providers ?? (["fake", "vertex-gemini"] as const);
  const deadline = Date.now() + (options.budgetMs ?? 40_000);
  const workerId = randomUUID();
  const result: ThemeStudioWorkerResult = {
    claimed: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    requeued: 0,
    reaped: 0,
  };
  result.reaped = await withService(reapExhaustedLeases);

  while (result.claimed < maxRuns && Date.now() < deadline) {
    const run = await withService((db) => claimRun(db, workerId, providers));
    if (!run) break;
    result.claimed += 1;
    let outcome: Outcome;
    try {
      outcome = await execute(run, workerId);
    } catch (error) {
      // Losing the lease to a reclaim is expected and already safe: the
      // variety freeze uses finish()'s own fence (running + lease owner), so
      // finish() below finds no row and settles this run as `lost`.
      if (error instanceof VarietyLeaseLostError)
        logWarn("theme studio: run lease lost before start", {
          runId: run.id,
        });
      else
        logError("theme studio: run execution threw", error, {
          runId: run.id,
        });
      outcome =
        run.attemptCount < run.maxAttempts
          ? { kind: "retry", errorCode: "worker_error" }
          : {
              kind: "failed",
              errorCode:
                error instanceof ImageCheckpointError
                  ? "image_checkpoint_unavailable"
                  : "worker_error",
            };
    }
    const settled = await finish(workerId, run, outcome);
    if (settled !== "lost") result[settled] += 1;
    logInfo("theme studio: run settled", {
      runId: run.id,
      provider: run.provider,
      modelKey: run.modelKey,
      attempt: run.attemptCount,
      outcome: settled,
    });
    // A requeued run is picked up again next pass, not in a tight loop.
    if (settled === "requeued") break;
  }
  if (!options.skipVisualQa && Date.now() < deadline) {
    const qa = await runThemeStudioVisualQaWorker({ providers });
    if (qa.claimed > 0) {
      logInfo("theme studio: visual QA settled", { ...qa });
    }
  }
  return result;
}

/** How much work is waiting, for the heartbeat's response body. */
export async function countQueuedThemeStudioRuns(): Promise<number> {
  const [{ n }] = await withService((db) =>
    db
      .select({ n: count() })
      .from(themeStudioRuns)
      .where(eq(themeStudioRuns.status, "queued")),
  );
  return Number(n);
}
