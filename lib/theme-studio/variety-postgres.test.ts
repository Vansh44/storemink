// Opt-in local PostgreSQL check; all fixtures and writes roll back.
import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/drizzle/schema";
import * as relations from "@/drizzle/relations";
import { loadEnvConfig } from "@next/env";
import { loadVarietyContext, VarietyLeaseLostError } from "./variety-context";
import { createFakeModelClient } from "./fake-provider";
import { runThemeGeneration } from "./pipeline";
import { digestThemeStudioJson } from "./repository";
import { measureDistinctness, themeFingerprint } from "./fingerprint";

it.skipIf(process.env.THEME_STUDIO_VARIETY_DB_TEST !== "1")(
  "freezes real catalogue context across reclaims and protects version evidence during QA reveal",
  async () => {
    loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
    const pg = new Client({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: "postgres",
      password: process.env.DB_ADMIN_PASSWORD,
      connectionTimeoutMillis: 5000,
    });
    await pg.connect();
    try {
      await pg.query("BEGIN");
      await pg.query("SET LOCAL lock_timeout='5s'");
      const facts = {
        name: "Variety DB",
        themeId: "variety-db",
        industries: ["home" as const],
        catalogSizes: ["small" as const],
        requiredFeatures: [],
      };
      const outcome = await runThemeGeneration(
        createFakeModelClient({
          ...facts,
          brief: "A ceramics shop",
          referenceCount: 0,
        }),
        {
          facts: { ...facts, baseThemeName: null },
          compile: {
            ...facts,
            baseEngine: null,
            versionNumber: 1,
            modelKey: "gemini-3.8-flash",
            modelLabel: "Gemini 3.8 Flash",
            referenceDigests: [],
          },
          providerModel: "fake",
          promptVersion: "theme-studio-v21",
          messages: [{ kind: "brief", body: "A ceramics shop" }],
          references: [],
        },
        new AbortController().signal,
      );
      if (outcome.kind !== "version") throw new Error("Fixture failed");
      const seed = async (
        withVersion: boolean,
        visibility:
          | "operator/passed"
          | "operator/failed"
          | "internal/pending" = "operator/passed",
      ) => {
        const projectId = randomUUID(),
          messageId = randomUUID(),
          runId = randomUUID(),
          versionId = randomUUID(),
          themeId = `variety-${projectId}`;
        await pg.query(
          `INSERT INTO theme_studio_projects(id,theme_id,name,status,industries,catalog_sizes,model_key,draft_brief,created_by_email) VALUES($1,$2,'Variety DB','generating','{home}','{small}','gemini-3.8-flash','A ceramics shop','test@example.com')`,
          [projectId, themeId],
        );
        await pg.query(
          "INSERT INTO theme_studio_messages(id,project_id,kind,body) VALUES($1,$2,'brief','A ceramics shop')",
          [messageId, projectId],
        );
        await pg.query(
          `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key) VALUES($1,$2,$3,'generate','fake','gemini-3.8-flash','fake','theme-studio-v21',$4)`,
          [runId, projectId, messageId, `variety_${runId}`],
        );
        if (withVersion)
          await pg.query(
            `INSERT INTO theme_studio_versions(id,project_id,run_id,version_number,intent_json,intent_digest,package_json,package_digest,visibility,qa_status,distinctness_report) VALUES($1,$2,$3,1,$4,$5,$6,$7,$9,$10,$8)`,
            [
              versionId,
              projectId,
              runId,
              JSON.stringify(outcome.intent),
              digestThemeStudioJson(outcome.intent),
              JSON.stringify(outcome.package),
              digestThemeStudioJson(outcome.package),
              JSON.stringify(
                measureDistinctness(outcome.package.definition, []),
              ),
              ...visibility.split("/"),
            ],
          );
        return { projectId, runId, themeId, versionId };
      };
      const workerId = randomUUID();
      const own = await seed(true, "internal/pending"),
        other = await seed(true),
        hidden = await seed(true, "internal/pending"),
        failed = await seed(true, "operator/failed"),
        unleased = await seed(false),
        fallback = await seed(true),
        published = await seed(true);
      // A newer private version must not hide a project's latest acceptable one.
      const laterRun = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,status,finished_at) SELECT $1,project_id,message_id,'generate','fake','gemini-3.8-flash','fake','theme-studio-v21',$2,'succeeded',now() FROM theme_studio_runs WHERE id=$3`,
        [laterRun, `variety_${laterRun}`, fallback.runId],
      );
      await pg.query(
        `INSERT INTO theme_studio_versions(id,project_id,run_id,version_number,intent_json,intent_digest,package_json,package_digest,visibility,qa_status) SELECT gen_random_uuid(),project_id,$1,2,intent_json,intent_digest,package_json,package_digest,'internal','pending' FROM theme_studio_versions WHERE id=$2`,
        [laterRun, fallback.versionId],
      );
      // A published Studio release: archived, so it is absent from recent work
      // and its design direction can only come from the publication record.
      const hex = (c: string) => c.repeat(64);
      const releaseId = randomUUID(),
        acceptanceId = randomUUID();
      await pg.query(
        `INSERT INTO theme_releases(id,theme_id,version,release_status,package_json,manifest_digest) VALUES($1,$2,'1.0.0','published',$3,$4)`,
        [
          releaseId,
          published.themeId,
          JSON.stringify(outcome.package),
          hex("a"),
        ],
      );
      await pg.query(
        `INSERT INTO theme_catalog_entries(theme_id,current_release_id,visibility) VALUES($1,$2,'public')`,
        [published.themeId, releaseId],
      );
      await pg.query(
        `INSERT INTO theme_studio_acceptance_runs(id,project_id,version_id,package_digest,assets_digest,build_id,status,evidence_digest,created_by_email,completed_at) VALUES($1,$2,$3,$4,$4,'test','passed',$4,'test@example.com',now())`,
        [acceptanceId, published.projectId, published.versionId, hex("b")],
      );
      await pg.query(
        `INSERT INTO theme_studio_publications(project_id,version_id,acceptance_run_id,theme_id,release_version,release_id,manifest_digest,status,created_by_email,completed_at) VALUES($1,$2,$3,$4,'1.0.0',$5,$6,'published','test@example.com',now())`,
        [
          published.projectId,
          published.versionId,
          acceptanceId,
          published.themeId,
          releaseId,
          hex("a"),
        ],
      );
      await pg.query(
        "UPDATE theme_studio_runs SET status='succeeded',finished_at=now() WHERE id=$1",
        [published.runId],
      );
      await pg.query(
        "UPDATE theme_studio_projects SET status='ready' WHERE id=$1",
        [published.projectId],
      );
      await pg.query(
        "UPDATE theme_studio_projects SET status='archived',archived_at=now() WHERE id=$1",
        [published.projectId],
      );
      await pg.query(
        "UPDATE theme_studio_runs SET status='running',attempt_count=1,lease_owner=$2,lease_expires_at=now()+interval '5 minutes' WHERE id=$1",
        [own.runId, workerId],
      );
      await pg.query("SET LOCAL ROLE app_service");
      const db = drizzle(pg, { schema: { ...schema, ...relations } });
      // A worker that does not hold the run's lease cannot freeze its context.
      await expect(
        loadVarietyContext(
          db,
          unleased.runId,
          unleased.projectId,
          unleased.themeId,
          workerId,
        ),
      ).rejects.toBeInstanceOf(VarietyLeaseLostError);
      const frozen = await loadVarietyContext(
        db,
        own.runId,
        own.projectId,
        own.themeId,
        workerId,
      );
      expect(frozen.some((t) => t.themeId === own.themeId)).toBe(false);
      // Private intermediates and failed drafts are not designs to avoid.
      expect(frozen.some((t) => t.themeId === hidden.themeId)).toBe(false);
      expect(frozen.some((t) => t.themeId === failed.themeId)).toBe(false);
      expect(frozen.some((t) => t.themeId === fallback.themeId)).toBe(true);
      // Published releases come first and carry their Studio design direction.
      const publishedAt = frozen.findIndex(
        (t) => t.themeId === published.themeId,
      );
      expect(publishedAt).toBeGreaterThanOrEqual(0);
      expect(publishedAt).toBeLessThan(
        frozen.findIndex((t) => t.themeId === other.themeId),
      );
      expect(frozen[publishedAt].direction).toBe(
        outcome.intent.designDirection,
      );
      expect(outcome.intent.designDirection).toBeTruthy();
      expect(
        frozen.find((t) => t.themeId === other.themeId)?.fingerprint,
      ).toEqual(themeFingerprint(outcome.package.definition));
      await pg.query("RESET ROLE");
      const newer = await seed(true);
      await pg.query("SET LOCAL ROLE app_service");
      expect(
        await loadVarietyContext(
          db,
          own.runId,
          own.projectId,
          own.themeId,
          workerId,
        ),
      ).toEqual(frozen);
      expect(frozen.some((t) => t.themeId === newer.themeId)).toBe(false);
      await pg.query("SAVEPOINT immutable_context");
      await expect(
        pg.query(
          "UPDATE theme_studio_runs SET variety_context='[]' WHERE id=$1",
          [own.runId],
        ),
      ).rejects.toThrow(/immutable/);
      await pg.query("ROLLBACK TO SAVEPOINT immutable_context");
      await pg.query("RESET ROLE");
      await pg.query("SAVEPOINT immutable_evidence");
      await expect(
        pg.query(
          "UPDATE theme_studio_versions SET visibility='operator',qa_status='passed',distinctness_report='{}' WHERE id=$1",
          [own.versionId],
        ),
      ).rejects.toThrow(/immutable/);
      await pg.query("ROLLBACK TO SAVEPOINT immutable_evidence");
      await pg.query("SET LOCAL ROLE app_service");
      await pg.query(
        "UPDATE theme_studio_versions SET visibility='operator',qa_status='passed' WHERE id=$1",
        [own.versionId],
      );
      await pg.query("RESET ROLE");
      expect(
        (
          await pg.query(
            "SELECT has_column_privilege('app_user','theme_studio_runs','variety_context','SELECT') AS allowed",
          )
        ).rows[0].allowed,
      ).toBe(false);
    } finally {
      await pg.query("ROLLBACK");
      await pg.end();
    }
  },
  20000,
);
