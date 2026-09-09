# Database migrations — how they work and how to add one

> **The one rule that matters:** a migration must be safe to apply while the
> **previous** version of the app is still running. Everything else in this
> document follows from that.

## 1. Why that rule exists

Cloud Run does a rolling deploy. For a minute or two on every release, the old
container and the new container are both serving traffic **against one
database**. So a migration that removes, renames or narrows something the old
revision still uses takes the site down for that window — and nothing reports
an error, because the migration and the deploy each did exactly what they were
told.

A migration is therefore allowed to run _ahead_ of the code that needs it, and
must never _require_ that code to already be live.

## 2. Who applies migrations

**Cloud Build does. Never a person.**

Pushing to `dev` or `main` runs [cloudbuild.yaml](../cloudbuild.yaml), which does
four things in order:

1. `build-push` — build the container image.
2. `tip-check` — is this still the newest commit on the branch? If a newer
   commit has landed while the image was building, this build writes a marker
   and steps 3 and 4 do nothing. The newer build owns the release.
3. `migrate` — apply pending migrations to that environment's database. **If
   this fails, the build fails and the deploy does not happen.**
4. `deploy` — roll out the new revision to Cloud Run.

Consequences worth knowing:

- **Nobody needs the production database password.** The build service account
  reads it from Secret Manager. Do not run `npm run db:migrate:prod apply` from
  a laptop; it still works, and it is now the emergency path, not the routine.
- **The schema is never behind the code**, and is deliberately allowed to be
  ahead of it (§1).
- **A superseded build finishes green having changed nothing.** That is
  intentional — a routinely red pipeline is one people stop reading.

## 3. Adding a migration

### Write the SQL

One new file in `drizzle/migrations/sql/`, named `YYYYMMDD_NNNN_short_name.sql`.

> **The next free sequence number is `0091`, not `0090`.** `0090` is claimed by
> `20260909_0090_mink_phase_8e_inputs`, which is not in this branch's manifest
> but **is already recorded in the local database's ledger** — in-flight work on
> the `minkai` branch. So the manifest alone does not tell you which numbers are
> taken. Before picking one, check both:
>
> ```bash
> npm run db:migrate:local status   # `unknown` lists ids other branches applied
> git log --all -S"_0091_" -- drizzle/migrations
> ```
>
> Numbers 0076–0089 contain nine
> duplicated pairs, left over from a branch merge that concatenated two
> independently numbered series. **Do not renumber them** — renaming an applied
> migration orphans its ledger row on every environment that has it, and the
> runner then refuses to apply, adopt or verify anything until the ledger is
> repaired by hand. `db-migrations-core.test.mjs` freezes those nine pairs, so
> reusing an existing number fails CI.

Make it **additive**. A rename or removal is a sequence across several releases,
never one migration:

| Release | Migration                    | Code                                 |
| ------- | ---------------------------- | ------------------------------------ |
| 1       | add the new column, nullable | ignores it                           |
| 2       | —                            | writes to **both** columns           |
| 3       | —                            | backfills old rows in the background |
| 4       | —                            | reads from the new column            |
| 5       | drop the old column          | —                                    |

This is called **expand/contract**. It is why ordering stops being frightening:
at every step, both the old and the new revision work against the database as it
then stands.

`npm run db:lint` blocks the mechanical half of this rule — dropped, renamed or
retyped columns, `NOT NULL` added without a default, `SET NOT NULL` on an
existing column, `TRUNCATE`. CI runs it on every pull request. If a dangerous
change is genuinely correct, say so **in the SQL file**:

```sql
-- migration-lint: allow drop-column — cart_legacy_total unused since 0071
```

The reason is required, and it lands in the diff next to the statement it
excuses.

### Enroll it in the manifest

Add an entry to [`drizzle/migrations/manifest.json`](../drizzle/migrations/manifest.json):

```json
{
  "id": "20260910_0091_orders_channel",
  "description": "Adds orders.channel for the omnichannel report",
  "file": "sql/20260910_0091_orders_channel.sql",
  "transaction": true,
  "requires": ["20260909_0089_pos_cart_refresh_help"],
  "verify": { "columns": ["orders.channel"] },
  "applyVerify": { "queries": [] }
}
```

- **`requires`** must name a migration enrolled _earlier_ in the array. A
  forward reference can never be satisfied, so that migration becomes
  permanently unappliable.
- **`transaction` must be `true`.** The runner always wraps a migration in one
  and does not read this field; the loader refuses anything else rather than
  letting you believe otherwise. This means **`CREATE INDEX CONCURRENTLY` is not
  available** — it cannot run inside a transaction block.
- **The whole entry is checksummed** together with the SQL, so `requires`,
  `verify` and `description` are as immutable as the SQL once applied. The
  `file` path is the one field excluded, so a file can be _moved_ without
  breaking an applied entry, as long as its bytes are identical.

### The three postcondition contracts

| Field         | Runs                                                         | Put here                                                                     |
| ------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `verify`      | on **every** later status/verify/drift run, forever          | only what stays true: tables, columns, constraints, indexes, RLS, privileges |
| `applyVerify` | once, immediately after this migration's SQL                 | exact evidence, including content — e.g. a Help article's wording            |
| `adoptVerify` | once, during recovery `audit`/`adopt` on an evolved database | evidence that survives later phases                                          |

Two mistakes here have each jammed the whole queue before:

1. **A function name needs its argument types.** `verify.functions` uses
   `to_regprocedure`, which requires them: `to_regprocedure('public.foo')` is
   always `NULL`, so such a check can never pass. Write
   `sm_pad(integer,integer)`, not `sm_pad`.
2. **`verify` must not assert transitional wording or preconditions.** It is
   re-checked for every applied migration on every run, so a phrase a later
   phase legitimately removes ("remains preview-only") becomes a permanent
   failure in every environment. There is no "before" hook, so a precondition
   has no home at all.

### Test it locally

```bash
npm run db:local:start
npm run db:local:sync          # rebuild local from the dev/staging database
npm run db:migrate:local apply
npm run db:lint
npm run test
```

### Open the pull request

CI runs lint, typecheck, **migration lint**, tests, shuffled tests, prettier and
build. Merging to `dev` applies the migration to the dev/staging database and
deploys; merging to `main` does the same for production.

## 4. Things you must not do

- **Never edit a migration that has been applied anywhere.** The checksum
  covers the SQL and the manifest entry; the runner refuses a mismatch, and
  every environment then refuses to apply, verify or adopt anything. Fix a
  mistake with a **new** migration. This is a forward-only system.
- **Never rename or delete an enrolled migration id** (see §3).
- **Never run DDL with `psql` against staging or production.** That is what the
  daily drift check exists to catch, and it once left 78 of 96 migrations
  unrecorded.
- **Never add a column by editing an existing `CREATE TABLE IF NOT EXISTS`
  file.** Re-running it is a silent no-op, so the column never arrives while
  the code assumes it does.

## 5. Safety rails already in place

| Rail                                                              | What it stops                                                                               |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Checksummed ledger (`public.schema_migrations`)                   | an edited or unknown migration being applied                                                |
| Advisory lock, bounded wait (`MIGRATION_LOCK_WAIT_SECONDS`, 300s) | two runners applying at once; an unbounded wait inside a build                              |
| Primary key + one transaction per migration                       | double-apply, independently of the lock — a race loser's DDL rolls back with its ledger row |
| `SET LOCAL lock_timeout` (`MIGRATION_LOCK_TIMEOUT_MS`, 5000ms)    | a migration queueing behind a live query and freezing the site                              |
| Environment ↔ database name guard                                 | `--environment staging` running against `storemink`                                         |
| `--confirm-production <db>`                                       | an unintended production mutation                                                           |
| `tip-check`                                                       | a stale image deploying over a newer one; a build seeing a ledger ahead of its own checkout |
| Postcondition contracts                                           | a migration that ran but did not do what it claimed                                         |
| Daily drift check (`cloudbuild-drift.yaml`)                       | DDL that reached the database outside the runner                                            |

## 6. When something goes wrong

| Message                                               | What happened                                       | What to do                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Pending migrations: …`                               | the database is behind the manifest                 | expected before an apply; the build applies them                                                                                                                                                                                                                                   |
| `Applied migration checksum drift: …`                 | an applied migration's SQL or entry was edited      | revert the edit; fix forward with a new migration                                                                                                                                                                                                                                  |
| `Ledger contains unknown migrations: …`               | the database has a migration this checkout does not | **In a build:** your branch is behind — rebase on the target branch and re-run. **Locally:** another branch's migration was applied to your database; either check that branch out, or `npm run db:local:sync` to rebuild local from dev/staging. Do **not** delete the ledger row |
| `Ledger contains out-of-order migrations: …`          | an applied entry sits after an unapplied one        | move the pending block to the end of the manifest array                                                                                                                                                                                                                            |
| `Another migration has held the schema lock…`         | a concurrent run is applying                        | re-run the build once it finishes                                                                                                                                                                                                                                                  |
| `canceling statement due to lock timeout`             | the migration could not get its lock in 5s          | re-run; nothing was half-applied. If it repeats, the table is genuinely busy                                                                                                                                                                                                       |
| `drift=out_of_band`                                   | DDL reached the database without the runner         | find out what ran; `audit` then `adopt` to record it                                                                                                                                                                                                                               |
| `Production mutation requires --confirm-production …` | a manual apply without the confirmation             | check you really mean production                                                                                                                                                                                                                                                   |

Recovery commands (`audit`, `adopt`) are documented in
[`drizzle/manual/README.md`](../drizzle/manual/README.md). `adopt` records only
the **first** pending migration per run and demands four matching confirmations;
it is an expert tool, not part of any routine.

## 7. Known gaps

Stated plainly so nobody assumes coverage that is not there.

- **There is no reproducible fresh-database build.** `drizzle/manual/0001_schema.sql`
  is a 43-table snapshot from the Phase 5 Cloud SQL cutover — it has no
  `billing_*` or `store_locations` tables — while the manifest baseline
  (`baseline:cloudsql-2026-08-14`) is much later. The gap between them is
  covered only by the ~150 legacy `supabase/*.sql` files, which carry
  apply-order traps. **Consequence:** CI cannot replay every migration from
  scratch, so a migration's SQL is first _executed_ against the dev/staging
  database, not against a throwaway one.
  **The fix**, when it is worth doing: take a `pg_dump --schema-only` of the
  current database as `app_service` (see `scripts/db-local-sync.sh` for why the
  role matters), commit it as the new baseline, and add a CI job that restores
  it and applies the whole ledger.
- **`schema-fingerprint.json` is refreshed by hand** after an apply
  (`db:drift:* -- --update-baseline <env>`) and committed. Until it is, drift
  reports `migrated` and exits 1. Local currently sits three ledger rows behind
  staging and production, which is why `db:drift:local` reports `ledger_only`.
  The durable fix is §7's baseline: compare production against a schema built
  from the migrations, so there is no file to keep in step.
- **Help Centre content shares the schema queue.** Most recent migrations
  publish article text rather than changing structure. It works, but it is why
  the queue is 98 entries long and why one malformed entry can block every
  pending structural change behind it.
- **The linter matches statement shapes with regular expressions**, not a SQL
  parser. It will not catch every unsafe change, and expand/contract remains a
  human discipline.

## 8. One-time setup (already done, recorded for a new environment)

The `migrate` step needs two trigger substitutions:

| Trigger       | `_MIGRATE_ENV` | `_DB_NAME`          |
| ------------- | -------------- | ------------------- |
| `dev` branch  | `staging`      | `storemink_staging` |
| `main` branch | `production`   | `storemink`         |

`_MIGRATE_ENV` is the only new value; the production confirmation flag is
derived from `_DB_NAME` inside the step, so there is no second place for the
database name to be wrong. The runner refuses a mismatch between the two.

IAM needs nothing new: the build service account already holds `secretAccessor`
on `CLOUDSQL_PROD_POSTGRES_PW` and `roles/cloudsql.client`, both granted for
[`cloudbuild-drift.yaml`](../cloudbuild-drift.yaml).
