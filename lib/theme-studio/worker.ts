import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, lte, max, sql } from "drizzle-orm";
import {
  themeStudioAssets,
  themeStudioMessages,
  themeStudioProjects,
  themeStudioRuns,
  themeStudioVersions,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/observability/logger";
import { getThemeDefinition, isBundledThemeId } from "@/lib/themes";
import type {
  ThemeCatalogSize,
  ThemeFeature,
  ThemeIndustry,
} from "@/lib/themes/meta";
import { createVertexModelClient, getVertexConfig } from "./gemini-vertex";
import { getThemeStudioConfig, type ThemeStudioProvider } from "./config";
import { THEME_STUDIO_LIMITS } from "./contracts";
import { createFakeModelClient } from "./fake-provider";
import { THEME_STUDIO_MODELS, type ThemeStudioModelKey } from "./models";
import { runThemeGeneration, type GenerationOutcome } from "./pipeline";
import type { ThemeStudioModelClient } from "./provider";
import { digestThemeStudioJson, recordThemeStudioEvent } from "./repository";

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
  provider: string;
  modelKey: string;
  providerModel: string;
  promptVersion: string;
  attemptCount: number;
  maxAttempts: number;
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
    RETURNING r.id AS "id", r.project_id AS "projectId", r.status AS "status"
  `);
  const reaped = rows.rows as {
    id: string;
    projectId: string;
    status: "failed" | "cancelled";
  }[];
  for (const run of reaped) {
    await settleProjectWithoutVersion(db, run.projectId);
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
  const rows = await db.execute(sql`
    WITH candidate AS (
      SELECT id FROM theme_studio_runs
      WHERE provider IN (${providerList})
        AND ((status = 'queued' AND cancel_requested_at IS NULL)
         OR (status = 'running' AND lease_expires_at <= now()
             AND attempt_count < max_attempts AND cancel_requested_at IS NULL))
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE theme_studio_runs r
    SET status = 'running',
        lease_owner = ${workerId}::uuid,
        lease_expires_at = now() + (${LEASE_SECONDS}::int * interval '1 second'),
        attempt_count = r.attempt_count + 1,
        started_at = coalesce(r.started_at, now()),
        updated_at = now()
    FROM candidate WHERE r.id = candidate.id
    RETURNING r.id AS "id", r.project_id AS "projectId", r.message_id AS "messageId",
              r.provider AS "provider", r.model_key AS "modelKey",
              r.provider_model AS "providerModel", r.prompt_version AS "promptVersion",
              r.attempt_count AS "attemptCount", r.max_attempts AS "maxAttempts"
  `);
  const row = rows.rows[0] as ClaimedRun | undefined;
  return row ?? null;
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

async function loadRunInput(run: ClaimedRun) {
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
    // Every message up to and including the run's own: the brief plus any
    // answers to earlier clarifying questions, in order.
    const messages = await db
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
      .orderBy(asc(themeStudioMessages.createdAt));
    const references =
      message.referenceAssetIds.length > 0
        ? await db
            .select({
              bytes: themeStudioAssets.bytes,
              sha256: themeStudioAssets.sha256,
              createdAt: themeStudioAssets.createdAt,
            })
            .from(themeStudioAssets)
            .where(
              and(
                eq(themeStudioAssets.projectId, run.projectId),
                eq(themeStudioAssets.purpose, "reference"),
                inArray(themeStudioAssets.id, message.referenceAssetIds),
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
      messages: messages as { kind: "brief" | "revision"; body: string }[],
      references,
      versionNumber: (latest ?? 0) + 1,
    };
  });
}

type Outcome =
  | { kind: "generated"; result: GenerationOutcome; versionNumber: number }
  | { kind: "failed"; errorCode: string; detail?: Record<string, unknown> }
  | { kind: "retry"; errorCode: string };

/** The run's own deadline, inside its lease so a finish always holds it. */
const RUN_DEADLINE_MS = (THEME_STUDIO_LIMITS.runWallTimeSeconds - 60) * 1000;
const CANCEL_POLL_MS = 10_000;

function clientFor(
  provider: string,
  input: NonNullable<Awaited<ReturnType<typeof loadRunInput>>>,
): ThemeStudioModelClient | null {
  if (provider === "fake") {
    return createFakeModelClient({
      name: input.project.name,
      brief: input.messages.map((m) => m.body).join("\n\n"),
      industries: input.project.industries as ThemeIndustry[],
      catalogSizes: input.project.catalogSizes as ThemeCatalogSize[],
      requiredFeatures: input.project.requiredFeatures as ThemeFeature[],
      referenceCount: input.references.length,
      answered: input.messages.some((m) => m.kind === "revision"),
    });
  }
  if (provider === "vertex-gemini") {
    const vertex = getVertexConfig();
    return vertex ? createVertexModelClient(vertex) : null;
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

async function execute(run: ClaimedRun): Promise<Outcome> {
  const config = getThemeStudioConfig();
  // Re-checked at execution, not only at queue time: the emergency stop and a
  // disabled model must also stop work that was already waiting.
  if (!config.generationEnabled) {
    return { kind: "failed", errorCode: "generation_disabled" };
  }
  if (config.disabledModels.has(run.modelKey as ThemeStudioModelKey)) {
    return { kind: "failed", errorCode: "model_disabled" };
  }
  const input = await loadRunInput(run);
  if (!input) return { kind: "failed", errorCode: "input_missing" };
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
      client,
      {
        facts: {
          name: input.project.name,
          themeId: input.project.themeId,
          industries: input.project.industries,
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
        references: input.references.map((r) => ({
          base64: r.bytes.toString("base64"),
          sha256: r.sha256,
        })),
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
    outcome.kind === "generated" ? outcome.result.telemetry : undefined;
  return {
    provider: run.provider,
    modelKey: run.modelKey,
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

    const usage = usageRecord(run, outcome);
    const terminal = {
      leaseOwner: null,
      leaseExpiresAt: null,
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
      if (project) await settleProjectWithoutVersion(db, run.projectId);
      await event("run_failed", { errorCode });
      return "failed" as const;
    };

    if (locked.cancelRequestedAt) {
      // Spend already incurred is still recorded, so the cap counts it.
      await db
        .update(themeStudioRuns)
        .set({ ...terminal, status: "cancelled" })
        .where(eq(themeStudioRuns.id, run.id));
      await settleProjectWithoutVersion(db, run.projectId);
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

    const result = outcome.result;
    if (result.kind === "failed")
      return failRun(result.errorCode, result.detail);
    if (result.kind === "declined") {
      return failRun("model_declined", {
        kind: "declined",
        reason: result.reason,
      });
    }
    if (result.kind === "clarify") {
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
    const [version] = await db
      .insert(themeStudioVersions)
      .values({
        projectId: run.projectId,
        runId: run.id,
        parentVersionId: project.currentVersionId,
        versionNumber: outcome.versionNumber,
        intentJson: result.intent,
        intentDigest,
        packageJson: result.package,
        packageDigest,
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
        status: "ready",
        currentVersionId: version.id,
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
    });
    return "succeeded";
  });
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
      outcome = await execute(run);
    } catch (error) {
      logError("theme studio: run execution threw", error, { runId: run.id });
      outcome =
        run.attemptCount < run.maxAttempts
          ? { kind: "retry", errorCode: "worker_error" }
          : { kind: "failed", errorCode: "worker_error" };
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
