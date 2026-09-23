import "server-only";

import { randomUUID } from "node:crypto";
import { and, count, eq, max, sql } from "drizzle-orm";
import {
  themeStudioMessages,
  themeStudioProjects,
  themeStudioRuns,
  themeStudioVersions,
} from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import { logError, logInfo } from "@/lib/observability/logger";
import type {
  ThemeCatalogSize,
  ThemeFeature,
  ThemeIndustry,
} from "@/lib/themes/meta";
import {
  THEME_STUDIO_LIMITS,
  type ThemeContractResult,
  type ThemeIntent,
} from "./contracts";
import { runFakeProvider } from "./fake-provider";
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

async function claimRun(db: Db, workerId: string): Promise<ClaimedRun | null> {
  const rows = await db.execute(sql`
    WITH candidate AS (
      SELECT id FROM theme_studio_runs
      WHERE (status = 'queued' AND cancel_requested_at IS NULL)
         OR (status = 'running' AND lease_expires_at <= now()
             AND attempt_count < max_attempts AND cancel_requested_at IS NULL)
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
      .select({
        name: themeStudioProjects.name,
        industries: themeStudioProjects.industries,
        catalogSizes: themeStudioProjects.catalogSizes,
        requiredFeatures: themeStudioProjects.requiredFeatures,
      })
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, run.projectId))
      .limit(1);
    const [message] = await db
      .select({
        body: themeStudioMessages.body,
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
    return project && message ? { project, message } : null;
  });
}

type Outcome =
  | { kind: "succeeded"; intent: ThemeIntent }
  | { kind: "failed"; errorCode: string }
  | { kind: "retry"; errorCode: string };

async function execute(run: ClaimedRun): Promise<Outcome> {
  const input = await loadRunInput(run);
  if (!input) return { kind: "failed", errorCode: "input_missing" };
  if (run.provider !== "fake") {
    // Refused at queue time; reaching here means a row predates a rollback.
    return { kind: "failed", errorCode: "provider_unavailable" };
  }
  let result: ThemeContractResult<ThemeIntent>;
  try {
    result = runFakeProvider({
      name: input.project.name,
      brief: input.message.body,
      industries: input.project.industries as ThemeIndustry[],
      catalogSizes: input.project.catalogSizes as ThemeCatalogSize[],
      requiredFeatures: input.project.requiredFeatures as ThemeFeature[],
      referenceCount: input.message.referenceAssetIds.length,
      failWith: input.message.body.includes("[[fake:invalid_output]]")
        ? "invalid_output"
        : undefined,
    });
  } catch {
    return run.attemptCount < run.maxAttempts
      ? { kind: "retry", errorCode: "provider_error" }
      : { kind: "failed", errorCode: "provider_error" };
  }
  // Invalid structured output is a failure, never a version. Phase 3 adds a
  // bounded repair loop before this point.
  return result.ok
    ? { kind: "succeeded", intent: result.value }
    : { kind: "failed", errorCode: "invalid_output" };
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
    const locked = rows[0];
    const [project] = await db
      .select()
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, run.projectId))
      .for("update")
      .limit(1);

    const terminal = {
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    };

    if (locked.cancelRequestedAt) {
      await db
        .update(themeStudioRuns)
        .set({ ...terminal, status: "cancelled" })
        .where(eq(themeStudioRuns.id, run.id));
      await settleProjectWithoutVersion(db, run.projectId);
      await recordThemeStudioEvent(db, {
        projectId: run.projectId,
        runId: run.id,
        actor: "worker",
        eventType: "run_cancelled",
      });
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

    if (
      outcome.kind === "failed" ||
      !project ||
      project.status !== "generating"
    ) {
      const errorCode =
        outcome.kind === "failed" ? outcome.errorCode : "project_state_changed";
      await db
        .update(themeStudioRuns)
        .set({ ...terminal, status: "failed", errorCode })
        .where(eq(themeStudioRuns.id, run.id));
      if (project) await settleProjectWithoutVersion(db, run.projectId);
      await recordThemeStudioEvent(db, {
        projectId: run.projectId,
        runId: run.id,
        actor: "worker",
        eventType: "run_failed",
        detail: { errorCode },
      });
      return "failed";
    }

    const [{ latest }] = await db
      .select({ latest: max(themeStudioVersions.versionNumber) })
      .from(themeStudioVersions)
      .where(eq(themeStudioVersions.projectId, run.projectId));
    const intentDigest = digestThemeStudioJson(outcome.intent);
    const [version] = await db
      .insert(themeStudioVersions)
      .values({
        projectId: run.projectId,
        runId: run.id,
        parentVersionId: project.currentVersionId,
        versionNumber: (latest ?? 0) + 1,
        intentJson: outcome.intent,
        intentDigest,
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
        usage: { provider: run.provider },
      })
      .where(eq(themeStudioRuns.id, run.id));
    await db
      .update(themeStudioProjects)
      .set({
        status: "ready",
        currentVersionId: version.id,
        revision: project.revision + 1,
      })
      .where(eq(themeStudioProjects.id, run.projectId));
    await recordThemeStudioEvent(db, {
      projectId: run.projectId,
      runId: run.id,
      actor: "worker",
      eventType: "run_succeeded",
    });
    await recordThemeStudioEvent(db, {
      projectId: run.projectId,
      runId: run.id,
      actor: "worker",
      eventType: "version_created",
      detail: {
        versionId: version.id,
        versionNumber: version.versionNumber,
        intentDigest,
      },
    });
    return "succeeded";
  });
}

/** Drain a bounded amount of queued work. Safe to call concurrently: claims
 * use SKIP LOCKED and finishes are fenced on the lease owner. */
export async function runThemeStudioWorker(
  options: { maxRuns?: number; budgetMs?: number } = {},
): Promise<ThemeStudioWorkerResult> {
  const maxRuns = options.maxRuns ?? 5;
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
    const run = await withService((db) => claimRun(db, workerId));
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
