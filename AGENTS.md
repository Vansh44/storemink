<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# Codebase map — read first, keep updated

@CODEBASE.md

Before making ANY change, consult `CODEBASE.md` (imported above) — it describes the product (StoreMink multi-tenant SaaS), the host-based tenancy architecture, the directory structure, and the project conventions. After any change that adds/removes/moves routes, server actions, lib modules, or SQL files — or changes the architecture — update `CODEBASE.md` in the same commit so it never goes stale.

# Living docs — update in the SAME commit

These docs are only useful if they are never behind the code. Treat updating
them as part of the change, not as follow-up work — but read the Help Centre
gate before writing a guide: that doc is the one where writing something
unnecessary does active harm.

| Doc                           | Update it when                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CODEBASE.md`                 | routes, actions, lib modules, SQL files or architecture change (rule above)                                                                                                           |
| `docs/roadmap.md`             | a step finishes, splits, is reordered, or a new one appears — it is the single ordered plan for POS/locations/fulfilment                                                              |
| `docs/pos-acceptance.md`      | any POS, locations, inventory, fulfilment or pickup behaviour changes — **a phase is not done until its user stories are in here**, and a fixed gap must leave the "Known gaps" table |
| Help Centre (a new migration) | a **merchant-visible** flow changes — and never for an operator-only or internal change. See the gate below; `npm run help:lint` enforces it                                          |

A roadmap or test doc that lags the code is worse than none: it gets read once,
found wrong, and then quietly ignored — after which nobody can tell what is
built without reading every file.

# Product changes must update the codebase map, and the Help Centre only when a merchant's own work changes

Every implementation that adds a capability or changes an existing user flow is
incomplete until `CODEBASE.md` describes the new or changed behaviour — even
when the change adds, removes or moves no route, server action, library module
or SQL file. Do not defer that to follow-up work. If a change is strictly
internal, say so explicitly in the implementation handoff; `CODEBASE.md` must
still be reviewed whenever the internal architecture or the codebase map moves.

**The Help Centre is a different question, and it is not "every change".** An
earlier version of this rule said every implementation must also update a
guide. The cheapest way to satisfy that was to append one more `<h2>` to the
nearest article, so **85 of the first 98 migrations wrote to `help_articles`**
and `use-mink-ai-in-your-dashboard` became a 69 KB, 36-section changelog
ordered by engineering phase. It published a switch only StoreMink staff can
see, runtime environment-variable names, a local-development `gcloud` command,
Cloud Run and worker-lease internals, and a "this alpha is read only"
paragraph that the sections beneath it contradicted. A guide nobody can act on
is worse than a missing guide, because it is read once, found useless, and then
never trusted again. `20260910_0093` cleaned it up.

## The gate: would a merchant do something differently?

Update the Help Centre when, and only when, the change alters **what a
merchant, their staff, or a shopper does** in a dashboard, storefront, POS or
email they can actually reach. If the answer is no, write nothing: say
"no merchant-visible change, no Help Centre update" in the handoff and stop.

**Never publish to the Help Centre:**

| Do not publish                                                          | Because                                       | Where it belongs                          |
| ----------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------- |
| Platform-operator switches, gates and console pages                     | Only StoreMink staff can see them             | `docs/operator-console.md`, `CODEBASE.md` |
| Environment variables and runtime flags                                 | A merchant has no environment to set          | `CODEBASE.md` §7                          |
| Cloud Run, Cloud Scheduler, `gcloud`, `psql`, cron, service accounts    | Not reachable from a store dashboard          | `docs/cron-jobs.md`, `docs/gcp-ci-cd.md`  |
| Leases, checkpoints, idempotency keys, RLS, jsonb, tsvector, migrations | The mechanism, not the guarantee              | `CODEBASE.md`                             |
| `Phase 5C`, `Phase 7B` and similar                                      | A guide describes the product now             | `docs/roadmap.md`                         |
| Release-checklist status and internal test plans                        | The reader has no test team                   | `docs/*-acceptance.md`                    |
| Release-note voice — "now", "instead of", "superseded by"               | A guide has no readers who remember last week | the pull request                          |

State the guarantee a merchant gets, never the mechanism behind it: "pressing
Refund twice cannot send the money twice", not "uses an idempotency reference".

## Edit the section that is wrong; do not append a new one

Published Help content is database-backed, so changes go through a new
forward-only migration in `drizzle/migrations/sql/` — never an edit to an
applied one. Within that migration, **`replace()` the paragraph that is now
inaccurate.** Appending or prepending a section is what produced the 36-section
guide, and it leaves the old, wrong section in place directly above the new
one. Dollar-quote the text you are removing as `$old$…$old$` so the lint knows
it is being deleted rather than published.

If a guide passes roughly 25,000 characters or 14 `<h2>` sections, it has
stopped being a guide: split it by task instead of adding to it.

## Never assert published wording in a durable `verify` block

A migration's durable `verify` is re-checked for every applied migration on
every status run in every environment, and it is part of that migration's
checksum — so wording it names can never afterwards be edited or removed
without making the runner refuse every later migration. Seven migrations did
this before the rule existed, which is why `Phase 7B adds an immutable,
private custom-code proposal` is still in a merchant guide today, kept in an
HTML comment so it does not render. Put exact copy in `applyVerify`, which
runs once at apply time, and keep `verify` to tables, columns, constraints and
indexes.

## Checks

- `npm run help:lint` (in CI) reads migration SQL and blocks the vocabulary
  above and durable-verify copy assertions. It carries an escape hatch that
  documents itself: `-- help-lint: allow <rule> — <why a merchant needs this>`.
- `npm run help:audit:local` (or `:staging` / `:prod`) reads the rows a
  database is really serving, so it also catches operator edits made in the
  Help console and guides that have grown too long. It needs credentials, so
  it is not in CI.

Full contract, including what a good guide looks like: **`docs/help-centre.md`**.
