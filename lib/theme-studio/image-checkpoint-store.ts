import "server-only";

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { themeStudioImageCheckpoints, themeStudioRuns } from "@/drizzle/schema";
import { withService, type Db } from "@/lib/db/client";
import {
  ImageCheckpointError,
  imageCheckpointUsage,
  type ImageCheckpoint,
  type ImageCheckpointStore,
} from "./image-recovery";

type Binding = { id: string; projectId: string; workerId: string };

async function fence(db: Db, binding: Binding, write: boolean) {
  const query = db
    .select({ id: themeStudioRuns.id })
    .from(themeStudioRuns)
    .where(
      and(
        eq(themeStudioRuns.id, binding.id),
        eq(themeStudioRuns.projectId, binding.projectId),
        eq(themeStudioRuns.status, "running"),
        eq(themeStudioRuns.kind, "images"),
        eq(themeStudioRuns.leaseOwner, binding.workerId),
        gt(themeStudioRuns.leaseExpiresAt, sql`now()`),
        ...(!write ? [isNull(themeStudioRuns.cancelRequestedAt)] : []),
      ),
    );
  const [lease] = await (write ? query.for("update") : query).limit(1);
  if (!lease) throw new ImageCheckpointError();
}

function unpack(
  payload: ImageCheckpoint,
  bytes: Buffer | null,
): ImageCheckpoint {
  return payload.stage === "draw" && payload.response.kind === "ok"
    ? {
        ...payload,
        response: { ...payload.response, bytes: new Uint8Array(bytes!) },
      }
    : payload;
}

async function insert(
  db: Db,
  binding: Binding,
  key: string,
  checkpoint: ImageCheckpoint,
) {
  const bytes =
    checkpoint.stage === "draw" && checkpoint.response.kind === "ok"
      ? Buffer.from(checkpoint.response.bytes)
      : null;
  const payload = bytes
    ? { ...checkpoint, response: { ...checkpoint.response, bytes: undefined } }
    : checkpoint;
  await db
    .insert(themeStudioImageCheckpoints)
    .values({
      runId: binding.id,
      requestDigest: key,
      responseJson: payload,
      imageBytes: bytes,
    })
    .onConflictDoNothing();
  // The ledger is committed with each checkpoint, including on cancellation
  // and before a crash. Read small metadata only, never all image bytes.
  const rows = await db
    .select({
      stage: sql<string>`${themeStudioImageCheckpoints.responseJson}->>'stage'`,
      call: sql<
        ImageCheckpoint["call"]
      >`${themeStudioImageCheckpoints.responseJson}->'call'`,
    })
    .from(themeStudioImageCheckpoints)
    .where(eq(themeStudioImageCheckpoints.runId, binding.id))
    .orderBy(
      themeStudioImageCheckpoints.createdAt,
      themeStudioImageCheckpoints.requestDigest,
    );
  await db
    .update(themeStudioRuns)
    .set({
      usage: sql`coalesce(${themeStudioRuns.usage}, '{}'::jsonb) || ${JSON.stringify(imageCheckpointUsage(rows as Pick<ImageCheckpoint, "stage" | "call">[]))}::jsonb`,
      updatedAt: sql`now()`,
    })
    .where(eq(themeStudioRuns.id, binding.id));
}

/** Private original images: no public asset URL until normal settlement. All
 * reads and writes are project scoped and fenced on the current, live lease. */
export function createImageCheckpointStore(
  binding: Binding,
): ImageCheckpointStore {
  const guarded = async <T>(work: (db: Db) => Promise<T>): Promise<T> => {
    try {
      return await withService(work);
    } catch {
      throw new ImageCheckpointError();
    }
  };
  return {
    read: (key) =>
      guarded(async (db) => {
        await fence(db, binding, false);
        const [saved] = await db
          .select()
          .from(themeStudioImageCheckpoints)
          .where(
            and(
              eq(themeStudioImageCheckpoints.runId, binding.id),
              eq(themeStudioImageCheckpoints.requestDigest, key),
            ),
          )
          .limit(1);
        if (saved)
          return unpack(
            saved.responseJson as ImageCheckpoint,
            saved.imageBytes,
          );
        // An operator retry can recover artwork from its exact immutable base.
        // Follow only retry ancestry, scoped to this project, up to fifty links.
        // Unavailable evidence is excluded so an explicit retry gets fresh review.
        const prior = await db.execute(sql`
        WITH RECURSIVE ancestry AS (
          SELECT r.retry_of_run_id AS id, r.project_id, r.base_version_id,
                 r.base_package_digest, 1 AS depth
          FROM theme_studio_runs r WHERE r.id = ${binding.id}::uuid
          UNION ALL
          SELECT r.retry_of_run_id, a.project_id, a.base_version_id,
                 a.base_package_digest, a.depth + 1
          FROM ancestry a JOIN theme_studio_runs r ON r.id = a.id
          WHERE r.project_id = a.project_id AND r.kind = 'images'
            AND r.base_version_id = a.base_version_id
            AND r.base_package_digest = a.base_package_digest AND a.depth < 50
        )
        SELECT c.response_json AS payload, c.image_bytes AS bytes
        FROM ancestry a JOIN theme_studio_runs r ON r.id = a.id
        JOIN theme_studio_image_checkpoints c ON c.run_id = r.id
        WHERE r.project_id = ${binding.projectId}::uuid AND r.kind = 'images'
          AND r.base_version_id = a.base_version_id
          AND r.base_package_digest = a.base_package_digest
          AND c.request_digest = ${key}
          AND ((c.response_json->>'stage' = 'draw' AND c.response_json->'response'->>'kind' <> 'error')
            OR c.response_json->'response'->>'kind' = 'reviewed')
        ORDER BY a.depth LIMIT 1
      `);
        const row = prior.rows[0] as
          | { payload: ImageCheckpoint; bytes: Buffer | null }
          | undefined;
        if (!row) return null;
        const reused = unpack(row.payload, row.bytes);
        // Original spend belongs to the original run, once. This run pays only
        // for new calls, while retaining the candidate's actual quality evidence.
        reused.response.usage = {
          ...reused.response.usage,
          inputTokens: 0,
          outputTokens: 0,
        };
        if (reused.stage === "review") {
          reused.response.usage = {
            ...reused.response.usage,
            thinkingTokens: 0,
            cachedTokens: 0,
          };
          reused.response.estimatedCostMicroUsd = 0;
          reused.call = { ...reused.call, thinkingTokens: 0 };
        }
        reused.call = {
          ...reused.call,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostMicroUsd: 0,
        };
        await fence(db, binding, true);
        await insert(db, binding, key, reused);
        return reused;
      }),
    write: (key, checkpoint) =>
      guarded(async (db) => {
        await fence(db, binding, true);
        await insert(db, binding, key, checkpoint);
      }),
  };
}
