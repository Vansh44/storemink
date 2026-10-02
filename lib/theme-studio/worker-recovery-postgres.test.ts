// Opt-in local PostgreSQL regression. All DDL, fixtures and worker writes roll
// back; no provider calls. Run THEME_STUDIO_RECOVERY_DB_TEST=1 with Vitest.
import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnvConfig } from "@next/env";
import { createFakeModelClient } from "./fake-provider";
import { ZERO_USAGE, type StructuredRequest } from "./provider";

const { service, generate, draw, review } = vi.hoisted(() => ({
  service: vi.fn(),
  generate: vi.fn(),
  draw: vi.fn(),
  review: vi.fn(),
}));
vi.mock("./image-fake", async (original) => {
  const actual = await original<typeof import("./image-fake")>();
  return {
    ...actual,
    createFakeImageClient: () => ({ provider: "fake", generateImage: draw }),
    createFakeImageReviewClient: () => ({ provider: "fake", generate: review }),
  };
});
vi.mock("@/lib/db/client", () => ({ withService: service }));
vi.mock("./gemini-vertex", () => ({
  getVertexConfig: () => ({}),
  createVertexModelClient: () => ({ provider: "vertex-gemini", generate }),
}));
vi.mock("./config", () => ({
  getThemeStudioConfig: () => ({
    generationEnabled: true,
    autoQaEnabled: false,
    disabledModels: new Set(),
  }),
}));
vi.mock("./visual-qa", () => ({ runThemeStudioVisualQaWorker: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));
import { runThemeStudioWorker } from "./worker";
import { createImageCheckpointStore } from "./image-checkpoint-store";

it.skipIf(process.env.THEME_STUDIO_RECOVERY_DB_TEST !== "1")(
  "applies recovery SQL and resumes the actual worker after cooldown, keeping usage and grants correct",
  async () => {
    loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
    const pg = new Client({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: "postgres",
      password: process.env.DB_ADMIN_PASSWORD,
      connectionTimeoutMillis: 5_000,
    });
    await pg.connect();
    try {
      await pg.query("BEGIN");
      await pg.query("SET LOCAL lock_timeout = '5s'");
      const [checkpointTable] = (
        await pg.query(
          "SELECT to_regclass('public.theme_studio_generation_responses') AS name",
        )
      ).rows;
      if (!checkpointTable.name)
        await pg.query(
          await readFile(
            "drizzle/migrations/sql/20261002_0146_theme_studio_rate_limit_recovery.sql",
            "utf8",
          ),
        );
      if (
        !(
          await pg.query(
            "SELECT to_regclass('public.theme_studio_image_checkpoints') AS name",
          )
        ).rows[0].name
      )
        await pg.query(
          await readFile(
            "drizzle/migrations/sql/20261002_0147_theme_studio_image_checkpoints.sql",
            "utf8",
          ),
        );
      const id = randomUUID();
      const messageId = randomUUID();
      const runId = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_projects (id, theme_id, name, status, industries, catalog_sizes, model_key, draft_brief, created_by_email)
        VALUES ($1, $2, 'Recovery test', 'generating', '{home}', '{small}', 'gemini-3.8-flash', 'A ceramics shop', 'test@example.com')`,
        [id, `recovery-${id}`],
      );
      await pg.query(
        "INSERT INTO theme_studio_messages (id, project_id, kind, body) VALUES ($1, $2, 'brief', 'A ceramics shop')",
        [messageId, id],
      );
      await pg.query(
        `INSERT INTO theme_studio_runs (id, project_id, message_id, kind, provider, model_key, provider_model, prompt_version, idempotency_key, created_at)
        VALUES ($1,$2,$3,'generate','vertex-gemini','gemini-3.8-flash','fake','test',$4,'1900-01-01')`,
        [runId, id, messageId, `recovery_${runId}`],
      );
      const db = drizzle(pg);
      let transactions: Promise<unknown> = Promise.resolve();
      service.mockImplementation((work) => {
        const result = transactions.then(async () => {
          await pg.query("SET LOCAL ROLE app_service");
          try {
            return await work(db);
          } finally {
            await pg.query("RESET ROLE");
          }
        });
        transactions = result.catch(() => {});
        return result;
      });
      const fake = createFakeModelClient({
        name: "Recovery test",
        brief: "A ceramics shop",
        industries: ["home"],
        catalogSizes: ["small"],
        requiredFeatures: [],
        referenceCount: 0,
      });
      let drafts = 0;
      generate.mockImplementation(
        async (request: StructuredRequest, signal: AbortSignal) => {
          if (request.stage === "draft" && drafts++ === 0) {
            return { kind: "error", code: "rate_limited", usage: ZERO_USAGE };
          }
          const response = await fake.generate(request, signal);
          response.usage = {
            ...ZERO_USAGE,
            inputTokens: 100,
            outputTokens: 50,
          };
          return response;
        },
      );
      const options = {
        maxRuns: 1,
        providers: ["vertex-gemini" as const],
        skipVisualQa: true,
      };
      expect(await runThemeStudioWorker(options)).toMatchObject({
        claimed: 1,
        requeued: 1,
      });
      const [waiting] = (
        await pg.query(
          "SELECT status, attempt_count, rate_limit_deferrals, retry_not_before FROM theme_studio_runs WHERE id=$1",
          [runId],
        )
      ).rows;
      expect(waiting).toMatchObject({
        status: "queued",
        attempt_count: 1,
        rate_limit_deferrals: 1,
      });
      expect(waiting.retry_not_before.valueOf()).toBeGreaterThan(Date.now());
      expect(
        (
          await pg.query(
            "SELECT count(*)::int AS n FROM theme_studio_generation_responses WHERE run_id=$1",
            [runId],
          )
        ).rows[0].n,
      ).toBe(1);
      // Every other active row is locked out of this test's claim; all changes
      // roll back. This lets us exercise the real due-time predicate.
      await pg.query(
        "UPDATE theme_studio_runs SET retry_not_before = now() + interval '1 hour' WHERE id<>$1 AND status='queued'",
        [runId],
      );
      expect(await runThemeStudioWorker(options)).toMatchObject({ claimed: 0 });
      await pg.query(
        "UPDATE theme_studio_runs SET retry_not_before = now() - interval '1 second' WHERE id=$1",
        [runId],
      );
      expect(await runThemeStudioWorker(options)).toMatchObject({
        claimed: 1,
        succeeded: 1,
      });
      const [completed] = (
        await pg.query(
          "SELECT status, attempt_count, rate_limit_deferrals, usage, retry_not_before FROM theme_studio_runs WHERE id=$1",
          [runId],
        )
      ).rows;
      expect(completed).toMatchObject({
        status: "succeeded",
        attempt_count: 1,
        rate_limit_deferrals: 1,
        retry_not_before: null,
      });
      expect(completed.usage.totals.inputTokens).toBe(200);
      expect(generate.mock.calls.map(([request]) => request.stage)).toEqual([
        "intent",
        "draft",
        "draft",
      ]);
      expect(
        (
          await pg.query(
            "SELECT count(*)::int AS n FROM theme_studio_versions WHERE run_id=$1",
            [runId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await pg.query(
            "SELECT has_table_privilege('app_user','theme_studio_generation_responses','SELECT') AS read, has_table_privilege('app_service','theme_studio_generation_responses','INSERT') AS write, has_table_privilege('app_service','theme_studio_generation_responses','UPDATE') AS update, has_table_privilege('app_service','theme_studio_generation_responses','DELETE') AS delete",
          )
        ).rows[0],
      ).toEqual({ read: false, write: true, update: false, delete: false });
      // Exercise actual image settlement and the recursive exact-byte review
      // lookup on a redraw. Both runs use offline providers and roll back.
      const actual =
        await vi.importActual<typeof import("./image-fake")>("./image-fake");
      const fakeImage = actual.createFakeImageClient();
      const fakeReview = actual.createFakeImageReviewClient();
      draw.mockImplementation(async (request, signal) => {
        const response = await fakeImage.generateImage(request, signal);
        return { ...response, usage: { inputTokens: 11, outputTokens: 7 } };
      });
      review.mockImplementation(async (request, signal) => {
        const response = await fakeReview.generate(request, signal);
        return {
          ...response,
          usage: { ...ZERO_USAGE, inputTokens: 5, outputTokens: 3 },
        };
      });
      let anchorId: string | null = null;
      for (let round = 0; round < 2; round++) {
        const [base] = (
          await pg.query(
            "SELECT id, package_digest, package_json FROM theme_studio_versions WHERE project_id=$1 ORDER BY version_number DESC LIMIT 1",
            [id],
          )
        ).rows;
        const slot = base.package_json.assets.find(
          (a: { kind: string }) => a.kind === "product",
        ).id;
        const imageMessage = randomUUID();
        let imageRun = randomUUID();
        await pg.query(
          "UPDATE theme_studio_projects SET status='generating' WHERE id=$1",
          [id],
        );
        await pg.query(
          "INSERT INTO theme_studio_messages (id,project_id,kind,body) VALUES ($1,$2,'images','Offline image verification')",
          [imageMessage, id],
        );
        await pg.query(
          `INSERT INTO theme_studio_runs (id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,base_version_id,base_package_digest,image_slot_ids,max_attempts,created_at)
          VALUES ($1,$2,$3,'images','fake','gemini-3.8-flash','fake','test',$4,$5,$6,$7,3,'1900-01-01')`,
          [
            imageRun,
            id,
            imageMessage,
            `images_${imageRun}`,
            base.id,
            base.package_digest,
            round ? [slot] : [],
          ],
        );
        const imageOptions = { ...options, providers: ["fake" as const] };
        if (!round) {
          // Simulate a process dying AFTER its paid draw committed but before
          // review settlement. The next worker must reclaim the saved bytes.
          review.mockImplementationOnce(async () => {
            await pg.query(
              "UPDATE theme_studio_runs SET lease_owner=$2, lease_expires_at=now()-interval '1 second' WHERE id=$1",
              [imageRun, randomUUID()],
            );
            return {
              kind: "ok",
              value: { problems: [], note: "" },
              usage: ZERO_USAGE,
            };
          });
          expect(await runThemeStudioWorker(imageOptions)).toMatchObject({
            claimed: 1,
            succeeded: 0,
            failed: 0,
          });
          const [saved] = (
            await pg.query("SELECT usage FROM theme_studio_runs WHERE id=$1", [
              imageRun,
            ])
          ).rows;
          expect(saved.usage.totals).toEqual({
            inputTokens: 11,
            outputTokens: 7,
          });
          expect(draw).toHaveBeenCalledTimes(1);
          expect(
            (
              await pg.query(
                "SELECT image_bytes FROM theme_studio_image_checkpoints WHERE run_id=$1",
                [imageRun],
              )
            ).rows[0].image_bytes.length,
          ).toBeGreaterThan(0);
          await expect(
            createImageCheckpointStore({
              id: imageRun,
              projectId: id,
              workerId: randomUUID(),
            }).write("b".repeat(64), {
              stage: "review",
              response: {
                kind: "unavailable",
                code: "provider_timeout",
                usage: ZERO_USAGE,
                estimatedCostMicroUsd: 0,
              },
              call: {
                briefId: "anchor",
                attempt: 1,
                outcome: "unavailable",
                problems: [],
                inputTokens: 0,
                outputTokens: 0,
                thinkingTokens: 0,
                estimatedCostMicroUsd: 0,
              },
            }),
          ).rejects.toThrow("Image checkpoint unavailable");
          // A reviewer timeout queues a due-time retry, retaining the anchor.
          review.mockImplementationOnce(async () => ({
            kind: "error",
            code: "provider_timeout",
            usage: ZERO_USAGE,
          }));
          expect(await runThemeStudioWorker(imageOptions)).toMatchObject({
            claimed: 1,
            requeued: 1,
          });
          const [waitingReview] = (
            await pg.query(
              "SELECT status,attempt_count,image_review_deferrals,retry_not_before FROM theme_studio_runs WHERE id=$1",
              [imageRun],
            )
          ).rows;
          expect(waitingReview).toMatchObject({
            status: "queued",
            attempt_count: 2,
            image_review_deferrals: 1,
          });
          expect(draw).toHaveBeenCalledTimes(1);
          expect(await runThemeStudioWorker(imageOptions)).toMatchObject({
            claimed: 0,
          });
          await pg.query(
            "UPDATE theme_studio_runs SET retry_not_before=now()-interval '1 second' WHERE id=$1",
            [imageRun],
          );
        }
        if (round) {
          const drawnBefore = draw.mock.calls.length;
          const failedRun = imageRun;
          for (let pass = 0; pass < 3; pass++) {
            review.mockImplementationOnce(async () => ({
              kind: "error",
              code: "provider_timeout",
              usage: ZERO_USAGE,
            }));
            expect(await runThemeStudioWorker(imageOptions)).toMatchObject({
              claimed: 1,
              ...(pass < 2 ? { requeued: 1 } : { failed: 1 }),
            });
            expect(draw.mock.calls.length).toBe(drawnBefore + 1);
            await pg.query(
              "UPDATE theme_studio_runs SET retry_not_before=now()-interval '1 second' WHERE id=$1 AND status='queued'",
              [failedRun],
            );
          }
          expect(
            (
              await pg.query(
                "SELECT error_code,usage FROM theme_studio_runs WHERE id=$1",
                [failedRun],
              )
            ).rows[0],
          ).toMatchObject({
            error_code: "image_review_unavailable",
            usage: { totals: { inputTokens: 11, outputTokens: 7 } },
          });
          expect(
            (
              await pg.query(
                "SELECT count(*)::int AS n FROM theme_studio_versions WHERE run_id=$1",
                [failedRun],
              )
            ).rows[0].n,
          ).toBe(0);
          // The operator Retry ancestry recovers saved artwork; the new run
          // pays only for its new review, not its parent's completed draw.
          imageRun = randomUUID();
          await pg.query(
            `INSERT INTO theme_studio_runs (id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,base_version_id,base_package_digest,image_slot_ids,max_attempts,retry_of_run_id,created_at)
            SELECT $2,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,$3,base_version_id,base_package_digest,image_slot_ids,3,id,'1900-01-01' FROM theme_studio_runs WHERE id=$1`,
            [failedRun, imageRun, `retry_${imageRun}`],
          );
          await pg.query(
            "UPDATE theme_studio_projects SET status='generating' WHERE id=$1",
            [id],
          );
        }
        expect(await runThemeStudioWorker(imageOptions)).toMatchObject({
          claimed: 1,
          succeeded: 1,
        });
        const [finished] = (
          await pg.query(
            "SELECT status,usage,outcome_detail FROM theme_studio_runs WHERE id=$1",
            [imageRun],
          )
        ).rows;
        expect(finished.status).toBe("succeeded");
        expect(finished.usage.durationMs).toBeGreaterThanOrEqual(0);
        if (!round) anchorId = finished.outcome_detail.anchorAssetId;
        else {
          expect(finished.outcome_detail.anchorAssetId).toBe(anchorId);
          expect(finished.usage.calls).toHaveLength(1);
          expect(finished.usage.calls[0].referenceRoles).toEqual([
            "anchor",
            "set",
          ]);
        }
        expect(finished.usage.totals.inputTokens).toBe(
          round ? 0 : finished.usage.calls.length * 11,
        );
        if (round) expect(finished.usage.reviews).toHaveLength(1);
        expect(
          (
            await pg.query(
              "SELECT count(*)::int AS n FROM theme_studio_versions WHERE run_id=$1",
              [imageRun],
            )
          ).rows[0].n,
        ).toBe(1);
      }
      // A run deadline during review saves a partial image version even when
      // reviewer deferrals are already exhausted; it is not a reviewer outage.
      const timeoutBase = (
        await pg.query(
          "SELECT id,package_digest,package_json FROM theme_studio_versions WHERE project_id=$1 ORDER BY version_number DESC LIMIT 1",
          [id],
        )
      ).rows[0];
      const timeoutRun = randomUUID();
      const timeoutMessage = randomUUID();
      const timeoutSlot = timeoutBase.package_json.assets.find(
        (a: { kind: string }) => a.kind === "product",
      ).id;
      await pg.query(
        "INSERT INTO theme_studio_messages(id,project_id,kind,body) VALUES($1,$2,'images','Deadline verification')",
        [timeoutMessage, id],
      );
      await pg.query(
        "UPDATE theme_studio_projects SET status='generating' WHERE id=$1",
        [id],
      );
      await pg.query(
        "INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,base_version_id,base_package_digest,image_slot_ids,max_attempts,image_review_deferrals,created_at) VALUES($1,$2,$3,'images','fake','gemini-3.8-flash','fake','test',$4,$5,$6,$7,3,2,'1900-01-01')",
        [
          timeoutRun,
          id,
          timeoutMessage,
          `deadline_${timeoutRun}`,
          timeoutBase.id,
          timeoutBase.package_digest,
          [timeoutSlot],
        ],
      );
      let deadlineCallback: (() => void) | undefined;
      const realTimeout = globalThis.setTimeout;
      const clock = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        handler: (...args: unknown[]) => void,
        delay?: number,
        ...args: unknown[]
      ) => {
        if (delay === 19 * 60 * 1000) deadlineCallback = () => handler(...args);
        return realTimeout(handler, delay, ...args);
      }) as typeof setTimeout);
      review.mockImplementationOnce(async () => {
        if (!deadlineCallback) throw new Error("No run deadline");
        deadlineCallback();
        return { kind: "error", code: "cancelled", usage: ZERO_USAGE };
      });
      try {
        expect(
          await runThemeStudioWorker({ ...options, providers: ["fake"] }),
        ).toMatchObject({ claimed: 1, succeeded: 1, requeued: 0, failed: 0 });
      } finally {
        clock.mockRestore();
      }
      const timeoutResult = (
        await pg.query(
          "SELECT image_review_deferrals,outcome_detail,usage FROM theme_studio_runs WHERE id=$1",
          [timeoutRun],
        )
      ).rows[0];
      expect(timeoutResult.image_review_deferrals).toBe(2);
      expect(timeoutResult.outcome_detail.outcomes[0].review).toBe(
        "unreviewed",
      );
      expect(timeoutResult.usage.totals.inputTokens).toBe(11);
      expect(
        (
          await pg.query(
            "SELECT count(*)::int AS n FROM theme_studio_versions WHERE run_id=$1",
            [timeoutRun],
          )
        ).rows[0].n,
      ).toBe(1);
      // Cancel after a completed draw: bytes/spend survive, no version appears.
      const [cancelBase] = (
        await pg.query(
          "SELECT id, package_digest, package_json FROM theme_studio_versions WHERE project_id=$1 ORDER BY version_number DESC LIMIT 1",
          [id],
        )
      ).rows;
      const cancelRun = randomUUID();
      const cancelMessage = randomUUID();
      const cancelledSlot = cancelBase.package_json.assets.find(
        (a: { kind: string }) => a.kind === "product",
      ).id;
      await pg.query(
        "INSERT INTO theme_studio_messages (id,project_id,kind,body) VALUES ($1,$2,'images','Cancel verification')",
        [cancelMessage, id],
      );
      await pg.query(
        "UPDATE theme_studio_projects SET status='generating' WHERE id=$1",
        [id],
      );
      await pg.query(
        `INSERT INTO theme_studio_runs (id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,base_version_id,base_package_digest,image_slot_ids,max_attempts,created_at)
        VALUES ($1,$2,$3,'images','fake','gemini-3.8-flash','fake','test',$4,$5,$6,$7,3,'1900-01-01')`,
        [
          cancelRun,
          id,
          cancelMessage,
          `cancel_${cancelRun}`,
          cancelBase.id,
          cancelBase.package_digest,
          [cancelledSlot],
        ],
      );
      review.mockImplementationOnce(async () => {
        await pg.query(
          "UPDATE theme_studio_runs SET cancel_requested_at=now() WHERE id=$1",
          [cancelRun],
        );
        return {
          kind: "ok",
          value: { problems: [], note: "" },
          usage: { ...ZERO_USAGE, inputTokens: 5, outputTokens: 3 },
        };
      });
      expect(
        await runThemeStudioWorker({ ...options, providers: ["fake"] }),
      ).toMatchObject({ claimed: 1, cancelled: 1 });
      expect(
        (
          await pg.query("SELECT usage FROM theme_studio_runs WHERE id=$1", [
            cancelRun,
          ])
        ).rows[0].usage.totals.inputTokens,
      ).toBe(11);
      expect(
        (
          await pg.query(
            "SELECT count(*)::int AS n FROM theme_studio_versions WHERE run_id=$1",
            [cancelRun],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await pg.query(
            "SELECT count(*)::int AS n FROM theme_studio_image_checkpoints WHERE run_id=$1 AND image_bytes IS NOT NULL",
            [cancelRun],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await pg.query(
            "SELECT has_table_privilege('app_user','theme_studio_image_checkpoints','SELECT') AS read, has_table_privilege('app_service','theme_studio_image_checkpoints','INSERT') AS write, has_table_privilege('app_service','theme_studio_image_checkpoints','UPDATE') AS update, has_table_privilege('app_service','theme_studio_image_checkpoints','DELETE') AS delete",
          )
        ).rows[0],
      ).toEqual({ read: false, write: true, update: false, delete: false });
      // Invalid checkpoint kinds (including JSON null) and a fifth recovery
      // must fail at the database boundary, not merely in application code.
      for (const statement of [
        {
          sql: "UPDATE theme_studio_runs SET rate_limit_deferrals=5 WHERE id=$1",
          values: [runId],
        },
        {
          sql: "UPDATE theme_studio_runs SET image_review_deferrals=3 WHERE id=$1",
          values: [cancelRun],
        },
        {
          sql: "INSERT INTO theme_studio_image_checkpoints (run_id,request_digest,response_json) VALUES ($1,$2,$3)",
          values: [
            cancelRun,
            "f".repeat(64),
            JSON.stringify({
              stage: "draw",
              response: { kind: "ok", mediaType: "image/png", usage: {} },
              call: {},
            }),
          ],
        },
        {
          sql: "INSERT INTO theme_studio_generation_responses (run_id,request_digest,response_json) VALUES ($1,$2,$3)",
          values: [
            runId,
            "a".repeat(64),
            JSON.stringify({ kind: null, usage: {} }),
          ],
        },
      ]) {
        await pg.query("SAVEPOINT invalid_recovery");
        await expect(
          pg.query(statement.sql, statement.values),
        ).rejects.toMatchObject({ code: "23514" });
        await pg.query("ROLLBACK TO SAVEPOINT invalid_recovery");
      }
    } finally {
      await pg.query("ROLLBACK");
      await pg.end();
    }
  },
  30_000,
);
