#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import nextEnv from "@next/env";
import pg from "pg";
import {
  MIGRATION_LOCK_NAME,
  activeVerifyQuerySupersessions,
  acquireMigrationLock,
  effectiveVerifyContract,
  lockTimeoutMs,
  classifyDrift,
  loadManifest,
  migrationPlan,
  parseCli,
  sha256,
  validateEnvironment,
} from "./db-migrations-core.mjs";

const { loadEnvConfig } = nextEnv;
loadEnvConfig(process.cwd());

const { Client } = pg;
const LEDGER = "public.schema_migrations";

function connectionConfig() {
  const adminUser = process.env.DB_ADMIN_USER;
  if (!adminUser) {
    throw new Error(
      "DB_ADMIN_USER is required; the migration runner never falls back to the application login",
    );
  }
  const host = process.env.DB_HOST;
  const isSocket = host?.startsWith("/");
  return {
    host,
    port: isSocket ? undefined : Number(process.env.DB_PORT ?? 5432),
    user: adminUser,
    password: process.env.DB_ADMIN_PASSWORD,
    database: process.env.DB_NAME,
    ssl: false,
    application_name: "storemink-db-migrate",
  };
}

async function ledgerExists(client) {
  const result = await client.query(
    "select to_regclass('public.schema_migrations') is not null as exists",
  );
  return result.rows[0].exists;
}

async function createLedger(client) {
  await client.query(`
    create table if not exists ${LEDGER} (
      id             text primary key,
      checksum       text not null check (checksum ~ '^[0-9a-f]{64}$'),
      source          text not null,
      environment     text not null check (environment in ('local', 'staging', 'production')),
      app_commit      text,
      applied_by      text not null default current_user,
      execution_ms    integer not null default 0 check (execution_ms >= 0),
      applied_at      timestamptz not null default clock_timestamp()
    )
  `);
  await client.query(
    `revoke all on ${LEDGER} from public, app_user, app_service`,
  );
}

async function appliedRows(client) {
  if (!(await ledgerExists(client))) return [];
  const result = await client.query(
    `select id, checksum, source, environment, app_commit, applied_by,
            execution_ms, applied_at
       from ${LEDGER}
      order by applied_at, id`,
  );
  return result.rows;
}

async function verifyContract(client, verify, context) {
  const missing = [];
  for (const table of verify.tables ?? []) {
    const result = await client.query("select to_regclass($1) as object", [
      `public.${table}`,
    ]);
    if (!result.rows[0].object) missing.push(`table public.${table}`);
  }
  for (const value of verify.columns ?? []) {
    const [table, column] = value.split(".");
    const result = await client.query(
      `select 1
         from information_schema.columns
        where table_schema = 'public' and table_name = $1 and column_name = $2`,
      [table, column],
    );
    if (result.rowCount === 0) missing.push(`column public.${value}`);
  }
  for (const constraint of verify.constraints ?? []) {
    const result = await client.query(
      `select 1
         from pg_constraint c
         join pg_namespace n on n.oid = c.connamespace
        where n.nspname = 'public' and c.conname = $1`,
      [constraint],
    );
    if (result.rowCount === 0) missing.push(`constraint ${constraint}`);
  }
  for (const table of verify.rlsTables ?? []) {
    const result = await client.query(
      `select c.relrowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1`,
      [table],
    );
    if (!result.rows[0]?.relrowsecurity) missing.push(`RLS on public.${table}`);
  }
  for (const fn of verify.functions ?? []) {
    const result = await client.query("select to_regprocedure($1) as object", [
      `public.${fn}`,
    ]);
    if (!result.rows[0].object) missing.push(`function public.${fn}`);
  }
  for (const check of verify.queries ?? []) {
    const result = await client.query(check.sql);
    const actual = result.rows[0]?.[Object.keys(result.rows[0] ?? {})[0]];
    if (actual !== check.equals) {
      missing.push(
        `check ${check.name} (expected ${JSON.stringify(check.equals)}, got ${JSON.stringify(actual)})`,
      );
    }
  }
  if (missing.length) {
    throw new Error(
      `${context} verification failed:\n- ${missing.join("\n- ")}`,
    );
  }
}

async function verifyMigration(client, migration, mode, context) {
  await verifyContract(client, migration.verify, `${context} durable contract`);
  const oneTimeContract =
    mode === "apply" ? migration.applyVerify : migration.adoptVerify;
  if (oneTimeContract) {
    await verifyContract(
      client,
      oneTimeContract,
      `${context} ${mode} contract`,
    );
  }
}

async function schemaFingerprint(client) {
  const result = await client.query(`
    with objects as (
      select 'relation' as kind, c.relname as name,
             concat_ws('|', c.relkind, c.relrowsecurity, c.relforcerowsecurity) as definition
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind in ('r', 'p', 'v', 'm', 'S')
         and c.relname <> 'schema_migrations'
      union all
      select 'column', c.relname || '.' || a.attname,
             concat_ws('|', pg_catalog.format_type(a.atttypid, a.atttypmod),
                       a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), ''),
                       a.attidentity, a.attgenerated)
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where n.nspname = 'public' and a.attnum > 0 and not a.attisdropped
         and c.relname <> 'schema_migrations'
      union all
      select 'constraint', c.conname,
             rel.relname || '|' || pg_get_constraintdef(c.oid, true)
        from pg_constraint c
        join pg_namespace n on n.oid = c.connamespace
        left join pg_class rel on rel.oid = c.conrelid
       where n.nspname = 'public' and coalesce(rel.relname, '') <> 'schema_migrations'
      union all
      select 'index', indexname, tablename || '|' || indexdef
        from pg_indexes
       where schemaname = 'public' and tablename <> 'schema_migrations'
      union all
      select 'policy', tablename || '.' || policyname,
             concat_ws('|', permissive, roles::text, cmd, coalesce(qual, ''), coalesce(with_check, ''))
        from pg_policies where schemaname = 'public'
      union all
      select 'trigger', event_object_table || '.' || trigger_name,
             concat_ws('|', event_manipulation, action_timing, action_orientation, action_statement)
        from information_schema.triggers where trigger_schema = 'public'
      union all
      select 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
             case
               -- pg_get_functiondef() rejects aggregates (pgvector installs
               -- avg(vector) and sum(vector) in public) and window routines.
               -- Keep those objects in the fingerprint using stable catalogue
               -- metadata instead of silently omitting extension-owned schema.
               when p.prokind in ('f', 'p') then pg_get_functiondef(p.oid)
               else concat_ws('|',
                      concat('kind=', p.prokind),
                      concat('result=', pg_get_function_result(p.oid)),
                      concat('language=', l.lanname),
                      concat('source=', p.prosrc),
                      concat('volatility=', p.provolatile),
                      concat('parallel=', p.proparallel),
                      concat('strict=', p.proisstrict),
                      concat('security_definer=', p.prosecdef))
             end
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_language l on l.oid = p.prolang
       where n.nspname = 'public'
    )
    select kind, name, definition from objects order by kind, name, definition
  `);
  return sha256(JSON.stringify(result.rows));
}

const FINGERPRINT_FILE = path.resolve(
  import.meta.dirname,
  "../drizzle/migrations/schema-fingerprint.json",
);

// A digest of WHICH migrations are recorded, not how many — a swap of one id for
// another keeps the count and must still register as a ledger change.
function ledgerDigest(rows) {
  const ids = rows.map((row) => row.id).sort();
  return { count: ids.length, digest: sha256(JSON.stringify(ids)) };
}

async function readBaselineFile() {
  try {
    return JSON.parse(await readFile(FINGERPRINT_FILE, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { environments: {} };
    throw error;
  }
}

async function runDrift(client, environment, rows, fingerprint, update) {
  const actual = { fingerprint, ledger: ledgerDigest(rows) };
  const file = await readBaselineFile();
  const expected = file.environments?.[environment] ?? null;
  const result = classifyDrift(expected, actual);

  console.log(`drift=${result.verdict}`);
  console.log(`  ${result.detail}`);
  console.log(
    `  schema   expected=${expected?.fingerprint?.slice(0, 16) ?? "<none>"} actual=${actual.fingerprint.slice(0, 16)}`,
  );
  console.log(
    `  ledger   expected=${expected?.ledger?.count ?? "<none>"} rows actual=${actual.ledger.count} rows`,
  );

  if (update) {
    file.environments = file.environments ?? {};
    file.environments[environment] = actual;
    file.$comment =
      "Committed schema baseline per environment. Refresh with `db-migrate drift --update-baseline` " +
      "immediately after applying migrations, and commit it in the same change. A `drift=out_of_band` " +
      "verdict means DDL reached the database without the runner.";
    const ordered = {
      $comment: file.$comment,
      environments: Object.fromEntries(
        Object.entries(file.environments).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
    };
    await writeFile(FINGERPRINT_FILE, `${JSON.stringify(ordered, null, 2)}\n`);
    console.log(
      `  baseline updated for ${environment}; commit schema-fingerprint.json`,
    );
    return;
  }

  if (!result.ok) {
    throw new Error(
      result.verdict === "out_of_band"
        ? "Schema drift: DDL was applied outside db:migrate. Reconcile it into a migration, then refresh the baseline."
        : `Schema baseline is stale (${result.verdict}). Re-run with --update-baseline and commit the result.`,
    );
  }
  console.log("No schema drift.");
}

function assertHealthyPlan(plan, allowPending = false) {
  if (plan.unknown.length) {
    throw new Error(
      `Ledger contains unknown migrations: ${plan.unknown.map((row) => row.id).join(", ")}`,
    );
  }
  if (plan.drifted.length) {
    throw new Error(
      `Applied migration checksum drift: ${plan.drifted.map((row) => row.id).join(", ")}`,
    );
  }
  if (plan.outOfOrder.length) {
    throw new Error(
      `Ledger contains out-of-order migrations: ${plan.outOfOrder.map((row) => row.id).join(", ")}`,
    );
  }
  if (!allowPending && plan.pending.length) {
    throw new Error(
      `Pending migrations: ${plan.pending.map((migration) => migration.id).join(", ")}`,
    );
  }
}

function pendingMigrationsThrough(manifest, plan, through) {
  if (!through) return plan.pending;
  const targetIndex = manifest.migrations.findIndex(
    (migration) => migration.id === through,
  );
  if (targetIndex === -1) {
    throw new Error(`Unknown migration target: ${through}`);
  }
  const indexes = new Map(
    manifest.migrations.map((migration, index) => [migration.id, index]),
  );
  return plan.pending.filter(
    (migration) => indexes.get(migration.id) <= targetIndex,
  );
}

function assertMigrationRequirements(migration, available) {
  const missing = migration.requires.filter((id) => !available.has(id));
  if (missing.length) {
    throw new Error(`${migration.id} requires ${missing.join(", ")}`);
  }
}

async function auditPendingMigrations(client, manifest, rows, plan, through) {
  if (!plan.baselineApplied) {
    throw new Error("Baseline is missing; run the baseline command first");
  }
  const candidates = pendingMigrationsThrough(manifest, plan, through);
  if (!candidates.length) {
    console.log(
      through
        ? `No pending migrations through ${through}.`
        : "No pending migrations to audit.",
    );
    return;
  }

  console.log("ADOPTION AUDIT — migration SQL and ledger writes are disabled.");
  await client.query("begin isolation level repeatable read read only");
  try {
    const available = new Set(rows.map((row) => row.id));
    for (const migration of candidates) {
      assertMigrationRequirements(migration, available);
      try {
        await verifyContract(
          client,
          migration.verify,
          `adoption audit ${migration.id} durable contract`,
        );
        if (migration.adoptVerify) {
          await verifyContract(
            client,
            migration.adoptVerify,
            `adoption audit ${migration.id} adoption contract`,
          );
        }
      } catch (error) {
        console.log(`  blocked ${migration.id}`);
        throw error;
      }
      console.log(
        `  adoptable ${migration.id} checksum=${migration.checksum} file=${migration.file}`,
      );
      available.add(migration.id);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  console.log(`Adoption audit passed for ${candidates.length} migration(s).`);
  console.log("Migration SQL executed: no. Ledger writes: no.");
}

async function adoptPendingMigrations(
  client,
  manifest,
  migrationId,
  confirmedChecksum,
  environment,
  commit,
  user,
) {
  const migration = manifest.migrations.find(
    (candidate) => candidate.id === migrationId,
  );
  if (!migration) {
    throw new Error(`Unknown migration target: ${migrationId}`);
  }
  if (confirmedChecksum !== migration.checksum) {
    throw new Error(
      `Adoption checksum confirmation does not match ${migration.id}: expected ${migration.checksum}`,
    );
  }

  console.log(
    `ADOPTION — recording verified existing migration ${migration.id}; migration SQL will not execute.`,
  );
  await client.query("begin isolation level serializable");
  try {
    await client.query(`lock table ${LEDGER} in share row exclusive mode`);
    const lockedRows = await appliedRows(client);
    const lockedPlan = migrationPlan(manifest, lockedRows);
    assertHealthyPlan(lockedPlan, true);
    if (!lockedPlan.baselineApplied) {
      throw new Error("Baseline is missing; run the baseline command first");
    }
    const firstPending = lockedPlan.pending[0];
    if (!firstPending) {
      throw new Error("No pending migration is available to adopt");
    }
    if (firstPending.id !== migration.id) {
      throw new Error(
        `Adoption target must be the first pending migration: ${firstPending.id}`,
      );
    }
    const available = new Set(lockedRows.map((row) => row.id));
    assertMigrationRequirements(migration, available);
    const adoptionSupersessions = activeVerifyQuerySupersessions(
      manifest,
      new Set([...available, migration.id]),
    );
    await verifyContract(client, manifest.baseline.verify, "adoption baseline");
    for (const recorded of manifest.migrations) {
      if (!available.has(recorded.id)) break;
      await verifyContract(
        client,
        effectiveVerifyContract(recorded, adoptionSupersessions),
        `adoption prerequisite ${recorded.id}`,
      );
    }
    await verifyMigration(
      client,
      migration,
      "adopt",
      `adoption ${migration.id}`,
    );
    const source = `adopt:${migration.file}`;
    await client.query(
      `insert into ${LEDGER}
           (id, checksum, source, environment, app_commit, applied_by, execution_ms)
         values ($1, $2, $3, $4, $5, $6, $7)`,
      [migration.id, migration.checksum, source, environment, commit, user, 0],
    );
    const recorded = await client.query(
      `select id, checksum, source, environment, app_commit, applied_by, execution_ms
         from ${LEDGER}
        where id = $1`,
      [migration.id],
    );
    const row = recorded.rows[0];
    if (
      recorded.rowCount !== 1 ||
      row.id !== migration.id ||
      row.checksum !== migration.checksum ||
      row.source !== source ||
      row.environment !== environment ||
      row.app_commit !== commit ||
      row.applied_by !== user ||
      row.execution_ms !== 0
    ) {
      throw new Error(`Adoption ledger read-back failed for ${migration.id}`);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }

  console.log(`Adopted verified existing migration ${migration.id}.`);
  console.log("Migration SQL executed: no.");
}

function printStatus(database, environment, manifest, rows, plan, fingerprint) {
  console.log(`database=${database}`);
  console.log(`environment=${environment}`);
  console.log(`baseline=${plan.baselineApplied ? "applied" : "missing"}`);
  console.log(`applied=${rows.length}`);
  console.log(`pending=${plan.pending.length}`);
  for (const migration of plan.pending)
    console.log(`  pending ${migration.id}`);
  console.log(`checksum_drift=${plan.drifted.length}`);
  for (const drift of plan.drifted) console.log(`  drift ${drift.id}`);
  console.log(`unknown=${plan.unknown.length}`);
  for (const row of plan.unknown) console.log(`  unknown ${row.id}`);
  console.log(`out_of_order=${plan.outOfOrder.length}`);
  for (const row of plan.outOfOrder) console.log(`  out_of_order ${row.id}`);
  console.log(`schema_sha256=${fingerprint}`);
  console.log(`manifest=${manifest.path}`);
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const manifest = await loadManifest(options.manifest);
  const mutating =
    options.command === "baseline" ||
    options.command === "apply" ||
    options.command === "adopt";
  const client = new Client(connectionConfig());
  await client.connect();
  try {
    const identity = await client.query(
      "select current_database() as database, current_user as user",
    );
    const { database, user } = identity.rows[0];
    if (user !== process.env.DB_ADMIN_USER) {
      throw new Error(
        `Migration admin guard refused ${user}; expected ${process.env.DB_ADMIN_USER}`,
      );
    }
    const guard = validateEnvironment(options.environment, database, mutating);
    if (
      guard.needsProductionConfirmation &&
      options["confirm-production"] !== database
    ) {
      throw new Error(
        `Production mutation requires --confirm-production ${database}`,
      );
    }
    if (
      options.command === "adopt" &&
      options["confirm-database"] !== database
    ) {
      throw new Error(
        `Migration adoption requires --confirm-database ${database}`,
      );
    }

    if (mutating) {
      await acquireMigrationLock(client);
      if (options.command === "adopt") {
        if (!(await ledgerExists(client))) {
          throw new Error("Migration adoption requires an existing ledger");
        }
      } else {
        await createLedger(client);
      }
    }

    if (options.command === "baseline") {
      await verifyContract(client, manifest.baseline.verify, "baseline");
      const existing = await appliedRows(client);
      const plan = migrationPlan(manifest, existing);
      if (plan.baselineApplied) {
        assertHealthyPlan(plan, true);
        console.log(`Baseline already recorded on ${database}.`);
      } else {
        await client.query("begin");
        try {
          await client.query(
            `insert into ${LEDGER}
               (id, checksum, source, environment, app_commit, applied_by)
             values ($1, $2, $3, $4, $5, $6)`,
            [
              manifest.baseline.id,
              manifest.baseline.checksum,
              "manifest:baseline",
              options.environment,
              options.commit ?? process.env.GIT_COMMIT ?? null,
              user,
            ],
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
        console.log(`Recorded verified baseline on ${database}.`);
      }
    }

    if (options.command === "apply") {
      let rows = await appliedRows(client);
      let plan = migrationPlan(manifest, rows);
      assertHealthyPlan(plan, true);
      if (!plan.baselineApplied) {
        throw new Error("Baseline is missing; run the baseline command first");
      }
      for (const migration of plan.pending) {
        for (const required of migration.requires) {
          if (!rows.some((row) => row.id === required)) {
            throw new Error(`${migration.id} requires ${required}`);
          }
        }
        const started = performance.now();
        await client.query("begin");
        try {
          // Bounded integer from lockTimeoutMs(), never the raw env string:
          // SET takes no bind parameters.
          await client.query(`set local lock_timeout = ${lockTimeoutMs()}`);
          await client.query(migration.sql);
          await verifyMigration(
            client,
            migration,
            "apply",
            `migration ${migration.id}`,
          );
          await client.query(
            `insert into ${LEDGER}
               (id, checksum, source, environment, app_commit, applied_by, execution_ms)
             values ($1, $2, $3, $4, $5, $6, $7)`,
            [
              migration.id,
              migration.checksum,
              migration.file,
              options.environment,
              options.commit ?? process.env.GIT_COMMIT ?? null,
              user,
              Math.max(0, Math.round(performance.now() - started)),
            ],
          );
          await client.query("commit");
          console.log(`Applied ${migration.id}.`);
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
        rows = await appliedRows(client);
        plan = migrationPlan(manifest, rows);
        assertHealthyPlan(plan, true);
      }
    }

    if (options.command === "audit") {
      const rows = await appliedRows(client);
      const plan = migrationPlan(manifest, rows);
      assertHealthyPlan(plan, true);
      await auditPendingMigrations(
        client,
        manifest,
        rows,
        plan,
        options.through,
      );
    }

    if (options.command === "adopt") {
      const rows = await appliedRows(client);
      const plan = migrationPlan(manifest, rows);
      assertHealthyPlan(plan, true);
      await adoptPendingMigrations(
        client,
        manifest,
        options.migration,
        options["confirm-checksum"],
        options.environment,
        options.commit ?? process.env.GIT_COMMIT ?? null,
        user,
      );
    }

    const rows = await appliedRows(client);
    const plan = migrationPlan(manifest, rows);
    if (options.command === "status") {
      // Status is Cloud Build's read-only preflight immediately before apply.
      // A pending, checksummed supersession must be able to retire an obsolete
      // historical query here; otherwise that query prevents the migration
      // which retires it from ever running. Apply re-verifies after the new
      // ledger row exists, so no mutating path trusts a merely pending marker.
      assertHealthyPlan(plan, true);
    }
    const verificationIds = new Set(rows.map((row) => row.id));
    if (options.command === "status") {
      for (const migration of plan.pending) {
        verificationIds.add(migration.id);
      }
    }
    const verifySupersessions = activeVerifyQuerySupersessions(
      manifest,
      verificationIds,
    );
    if (plan.baselineApplied) {
      await verifyContract(client, manifest.baseline.verify, "baseline");
    }
    for (const migration of manifest.migrations) {
      if (rows.some((row) => row.id === migration.id)) {
        await verifyContract(
          client,
          effectiveVerifyContract(migration, verifySupersessions),
          `migration ${migration.id}`,
        );
      }
    }
    const fingerprint = await schemaFingerprint(client);
    printStatus(
      database,
      options.environment,
      manifest,
      rows,
      plan,
      fingerprint,
    );
    if (options.command === "drift") {
      await runDrift(
        client,
        options.environment,
        rows,
        fingerprint,
        Boolean(options["update-baseline"]),
      );
    } else if (options.command === "verify") {
      if (!plan.baselineApplied) throw new Error("Baseline is missing");
      assertHealthyPlan(plan);
      console.log("Migration verification passed.");
    } else if (options.command === "status") {
      assertHealthyPlan(plan, true);
    }
  } finally {
    if (mutating) {
      await client
        .query("select pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK_NAME])
        .catch(() => {});
    }
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
