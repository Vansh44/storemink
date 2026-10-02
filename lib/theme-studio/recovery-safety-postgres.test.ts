// Local-only, rollback-only integration: real trigger, retention and grants.
import { expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadEnvConfig } from "@next/env";
import { guardLegacyImageRetries } from "../../scripts/db-migration-guards.mjs";

it.skipIf(process.env.THEME_STUDIO_RECOVERY_DB_TEST !== "1")(
  "fences legacy claims, protects active retry ancestry, prunes settled originals and detects missing privileges",
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
      await pg.query("begin");
      await pg.query("set local lock_timeout='5s'");
      const project = randomUUID();
      const message = randomUUID();
      await pg.query(
        "insert into theme_studio_projects(id,theme_id,name,status,industries,catalog_sizes,model_key,draft_brief,created_by_email) values($1,$2,'Safety test','generating','{home}','{small}','gemini-3.8-flash','Ceramics','test@example.com')",
        [project, `safety-${project}`],
      );
      await pg.query(
        "insert into theme_studio_messages(id,project_id,kind,body) values($1,$2,'images','Safety test')",
        [message, project],
      );
      const baseRun = randomUUID();
      const baseVersion = randomUUID();
      await pg.query(
        "insert into theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,status,finished_at) values($1,$2,$3,'generate','fake','gemini-3.8-flash','fake','test',$4,'succeeded',now())",
        [baseRun, project, message, `base-${baseRun}`],
      );
      await pg.query(
        "insert into theme_studio_versions(id,project_id,run_id,version_number,intent_json,intent_digest,package_json,package_digest) values($1,$2,$3,1,'{}',$4,'{}',$4)",
        [baseVersion, project, baseRun, "b".repeat(64)],
      );
      const addRun = async (
        status: string,
        age: number,
        parent: string | null = null,
      ) => {
        const id = randomUUID();
        await pg.query(
          "insert into theme_studio_runs(id,project_id,message_id,kind,provider,model_key,provider_model,prompt_version,idempotency_key,max_attempts,status,retry_of_run_id,created_at,finished_at,usage,base_version_id,base_package_digest,lease_owner,lease_expires_at,error_code) values($1,$2,$3,'images','fake','gemini-3.8-flash','fake','test',$4,3,$5,$6,now()-$7*interval '1 day',case when $5 in ('queued','running') then null else now()-$7*interval '1 day' end,'{\"totals\":{\"inputTokens\":10,\"outputTokens\":20}}',$8,$9,case when $5='running' then $1::uuid else null end,case when $5='running' then now()+interval '20 minutes' else null end,case when $5='failed' then 'fixture_failed' else null end)",
          [
            id,
            project,
            message,
            `safety-${id}`,
            status,
            parent,
            age,
            baseVersion,
            "b".repeat(64),
          ],
        );
        return id;
      };
      const addCheckpoint = async (run: string, age: number) => {
        const payload = {
          stage: "draw",
          response: {
            kind: "ok",
            mediaType: "image/png",
            usage: { inputTokens: 10, outputTokens: 20 },
          },
          call: {
            briefId: "cup",
            purpose: "product",
            inputTokens: 10,
            outputTokens: 20,
            estimatedCostMicroUsd: 1,
            referenceRoles: [],
          },
        };
        await pg.query(
          "insert into theme_studio_image_checkpoints(run_id,request_digest,response_json,image_bytes,created_at) values($1,$2,$3,$4,now()-$5*interval '1 day')",
          [run, "a".repeat(64), payload, Buffer.from([1, 2, 3]), age],
        );
      };

      const queued = await addRun("queued", 0);
      await pg.query(
        "select set_config('app.theme_studio_image_recovery','',true)",
      );
      const legacyClaim = await pg.query(
        "update theme_studio_runs set status='running',attempt_count=attempt_count+1,lease_owner=$2,lease_expires_at=now()+interval '20 minutes' where id=$1 returning id",
        [queued, randomUUID()],
      );
      expect(legacyClaim.rowCount).toBe(0);
      await expect(
        guardLegacyImageRetries(
          pg,
          "20261002_0147_theme_studio_image_checkpoints",
        ),
      ).rejects.toThrow("Checkpoint upgrade refused");
      await pg.query(
        "select set_config('app.theme_studio_image_recovery','v1',true)",
      );
      const modernClaim = await pg.query(
        "update theme_studio_runs set status='running',attempt_count=attempt_count+1,lease_owner=$2,lease_expires_at=now()+interval '20 minutes' where id=$1 returning id",
        [queued, randomUUID()],
      );
      expect(modernClaim.rowCount).toBe(1);
      await pg.query(
        "update theme_studio_runs set attempt_count=2 where id=$1",
        [queued],
      );
      await expect(
        guardLegacyImageRetries(
          pg,
          "20261002_0150_theme_studio_recovery_safety",
        ),
      ).rejects.toThrow("multiple claims and no checkpoints");
      await pg.query(
        "update theme_studio_runs set status='succeeded',finished_at=now(),lease_owner=null,lease_expires_at=null where id=$1",
        [queued],
      );

      const settled = await addRun("succeeded", 40);
      const parent = await addRun("failed", 40);
      const intermediate = await addRun("failed", 35, parent);
      const active = await addRun("queued", 40, intermediate); // Protect transitive ancestry, too.
      await pg.query(
        "update theme_studio_runs set status='running',lease_owner=$2,lease_expires_at=now()+interval '20 minutes' where id=$1",
        [active, randomUUID()],
      );
      const recent = await addRun("succeeded", 2);
      for (const [id, age] of [
        [settled, 40],
        [parent, 40],
        [intermediate, 35],
        [active, 40],
        [recent, 2],
      ] as const)
        await addCheckpoint(id, age);
      await pg.query("set local role app_service");
      const pruned = await pg.query(
        "select theme_studio_prune_image_checkpoints(now(),1) as n",
      );
      await pg.query("reset role");
      expect(pruned.rows[0].n).toBe(1);
      const survivors = await pg.query(
        "select run_id from theme_studio_image_checkpoints where run_id=any($1::uuid[])",
        [[settled, parent, intermediate, active, recent]],
      );
      expect(survivors.rows.map((r) => r.run_id).sort()).toEqual(
        [parent, intermediate, active, recent].sort(),
      );
      expect(
        (
          await pg.query("select usage from theme_studio_runs where id=$1", [
            settled,
          ])
        ).rows[0].usage.totals.inputTokens,
      ).toBe(10);
      await pg.query(
        "update theme_studio_runs set status='queued',lease_owner=null,lease_expires_at=null where id=$1",
        [active],
      );
      await pg.query("set local role app_service");
      expect(
        (
          await pg.query(
            "select theme_studio_prune_image_checkpoints(now(),50) as n",
          )
        ).rows[0].n,
      ).toBe(0);
      await pg.query("reset role");

      const manifest = JSON.parse(
        await readFile("drizzle/migrations/manifest.json", "utf8"),
      );
      const corrected = manifest.migrations.find(
        (m: { id: string }) =>
          m.id === "20261002_0150_theme_studio_recovery_safety",
      ).verify.queries;
      for (const check of corrected)
        expect(Object.values((await pg.query(check.sql)).rows[0])).toEqual([
          "true",
        ]);
      await pg.query(
        "revoke insert on theme_studio_image_checkpoints from app_service",
      );
      expect((await pg.query(corrected[0].sql)).rows[0]).toEqual({
        text: "false",
      });
      expect(
        (
          await pg.query(
            "select has_table_privilege('app_service','theme_studio_image_checkpoints','SELECT,INSERT') as old_check",
          )
        ).rows[0].old_check,
      ).toBe(true);
      await pg.query(
        "revoke update on theme_studio_provider_leases from app_service",
      );
      expect((await pg.query(corrected[1].sql)).rows[0]).toEqual({
        text: "false",
      });
      expect(
        (
          await pg.query(
            "select has_table_privilege('app_service','theme_studio_provider_leases','SELECT,INSERT,UPDATE,DELETE') as old_check",
          )
        ).rows[0].old_check,
      ).toBe(true);
      expect(
        (
          await pg.query(
            "select has_function_privilege('app_user','theme_studio_prune_image_checkpoints(timestamptz,integer)','EXECUTE') as callable",
          )
        ).rows[0].callable,
      ).toBe(false);
    } finally {
      await pg.query("rollback");
      await pg.end();
    }
  },
  20000,
);
