# Scheduled jobs (Cloud Scheduler)

**`vercel.json` does not drive anything.** Production runs on Cloud Run, where
Vercel's `crons` block is inert. It is kept only as a record of the intended
schedules. The real driver is **Cloud Scheduler in `storemink-prod`,
`asia-south1`**.

## The gap this documents

Between the Cloud Run cutover and **2026-07-30**, `storemink-prod` had **zero**
Cloud Scheduler jobs in **any** region — verified by sweeping every location.
`docs/gcp-migration-cutover-checklist.md` listed `Crons → Cloud Scheduler` and
the box was never ticked. So for the whole period after the cutover, none of the
three scheduled jobs ran.

It happened a second time, quietly: the 2026-07-30 fix created the three jobs it
knew about, `seo-refresh` was documented in this file as still to be created, and
it then sat uncreated until **2026-08-06** — with its two required Google APIs
never enabled either. A doc that says "must be created" is not a reminder anybody
receives. If you add a job here, create it in the same sitting and record the
verification below.

**Measured blast radius at the time of fixing (prod, read-only queries): 2
stores, 0 orders, 0 lapsed plans, 0 pending razorpay orders, 0 campaign
recipients.** Nothing was lost, because production has no real traffic yet — but
each job is a landmine the moment it does:

| Job                       | What its absence would have cost under real traffic                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `send-emails`             | Coupon email campaigns never send; Phase 5E scheduled campaigns also miss their reviewed delivery time.                                                                                                                                                |
| `plan-expiry`             | A lapsed timed plan keeps its paid features **forever** — the durable half of the plan gate (`lib/plans.ts` `effectivePlan` covers reads only).                                                                                                        |
| `expire-pending-payments` | Unpaid Razorpay orders are never reaped, so their stock reservations and coupon uses are held **permanently** — and it also carries the PICKUP sweeps, so expired collections never lapse and no collection reminder is ever sent.                     |
| `domain-reconcile`        | A merchant's custom domain **never goes live** unless they happen to keep the settings tab open for the whole of Google's issuance window.                                                                                                             |
| `import-worker`           | A CSV import whose worker chain broke mid-file (a deploy, an OOM, a kick that never landed) **never resumes** — it sits half-applied until someone notices.                                                                                            |
| `seo-refresh`             | No sitemap is ever submitted to Google, so nothing on the platform, the help centre or any launched store gets discovered.                                                                                                                             |
| `billing`                 | **No merchant is ever charged.** No renewal invoice is issued, no cycle advances, no grace window opens and no unpaid plan is downgraded — the entire subscription business stops silently, looking exactly like nobody has renewed yet.               |
| `help-embeddings`         | Existing published guides never receive semantic chunks after the initial migration, and a failed article-save refresh is never retried. Mink AI still falls back to lexical/category search, but paraphrase and multilingual recall silently degrade. |
| `mink-publications`       | Approved scheduled Mink blogs remain private drafts forever. No data is lost, but the merchant's reviewed publication time is silently missed until the worker runs.                                                                                   |

> ⚠ **STALE as of 2026-09-08 — see the measured note under "The jobs" below.**
> Production DOES have the notification system: `notification_email_queue`,
> `email_campaigns`, `email_campaign_recipients` and a schedule-aware
> `claim_email_batch` all exist in the `storemink` database, and mail is flowing
> through it. The paragraph below is kept for the history of the decision.
>
> Note: production currently runs `main`, which has **no notification system** —
> `lib/notifications/` and the `notification_email_queue` table do not exist
> there. `send-emails` on prod drives only the coupon-campaign worker. Once
> `staging` merges, the same job also drains notification email. Phase 5E makes
> its one-minute heartbeat load-bearing for scheduled campaign resolution.

## Schema-drift check (NOT an /api/cron route)

`storemink-schema-drift` is the odd one out: a **Cloud Scheduler job that runs a
Cloud Build trigger**, not an HTTPS call to `/api/cron/*` with a CRON_SECRET
bearer. Everything else in this file follows that pattern; this one cannot.

| Piece     | Value                                                                                                    |
| --------- | -------------------------------------------------------------------------------------------------------- |
| Scheduler | `storemink-schema-drift`, `0 4 * * *` UTC, region `asia-south1`                                          |
| Target    | `POST .../v1/projects/storemink-prod/locations/global/triggers/c10f45a2-bbc3-4e42-a069-3767e6057c48:run` |
| Auth      | OAuth as `705863961054-compute@developer.gserviceaccount.com`                                            |
| Trigger   | `storemink-schema-drift` (manual), `gitFileSource` → `cloudbuild-drift.yaml` on `refs/heads/main`        |
| Build     | `cloudbuild-drift.yaml` → `db-migrate drift --environment production`                                    |

★★ **Why not an `/api/cron` route.** The check needs BOTH signals — the schema
fingerprint and a digest of which migration ids are recorded — because
`schemaFingerprint()` excludes `schema_migrations`, and that exclusion is what
separates "a migration ran" from "somebody ran DDL by hand". Reading the ledger
needs the postgres SUPERUSER login: migration 0018 revoked the app login's
grants on `schema_migrations`, and a durable verify contract asserts they stay
revoked. Putting that credential in the internet-facing Cloud Run runtime would
be a downgrade. Cloud Build is not internet-facing, already holds
`roles/run.admin` (so it can already deploy code that reaches the database), and
runs the SAME code path a human runs rather than a second implementation.

⚠ **It required two IAM grants** on the Cloud Build service account, which did
NOT already have them: `secretmanager.secretAccessor` scoped to
`CLOUDSQL_PROD_POSTGRES_PW` alone, and project-level `cloudsql.client` (Cloud SQL
has no instance-level binding). The scheduler SA needed nothing new —
`roles/cloudbuild.builds.builder` already includes `cloudbuild.builds.create`.

⚠ **CREATED PAUSED (2026-09-08), and it must stay paused until
`cloudbuild-drift.yaml` reaches `main`.** It lives on `minkai` today, so a run
fails with `NOT_FOUND - File cloudbuild-drift.yaml not found`. Enabling it before
the merge means a failure every morning, which is how a real alarm becomes noise.
After merging:

```bash
gcloud scheduler jobs resume storemink-schema-drift --project storemink-prod --location asia-south1
gcloud scheduler jobs run    storemink-schema-drift --project storemink-prod --location asia-south1
```

★ **The trigger could not be created by `gcloud` or the API.** Five shapes
(`manual` with two URL forms, a raw `sourceToBuild` body, a `github` block
mirroring the working deploy trigger, and `webhook`) all returned a bare
`INVALID_ARGUMENT` with no field detail — this project has a 1st-gen GitHub App
connection and no 2nd-gen connection, and manual triggers appear to need one. It
was created through the Cloud Console instead. Expect the same if it is ever
recreated.

**Verified as far as the merge allows (2026-09-08):** the build itself ran
against production (`cc4d4eda`, 3m8s) and logged `database=storemink`
`environment=production` `drift=clean`; `GET` on the Scheduler's exact trigger
URL returns 200, so the URL and OAuth are right; and `:run` fails with exactly
one message, the missing file. What is NOT yet verified is a green scheduled run
end to end — do that after the merge.

Until then the same check runs by hand from any checkout:

```bash
gcloud builds submit --project storemink-prod --region global --config=cloudbuild-drift.yaml --ignore-file=.gitignore .
```

## The jobs

| Job                                 | Schedule (UTC) | Endpoint                                                 |
| ----------------------------------- | -------------- | -------------------------------------------------------- |
| `storemink-send-emails`             | `* * * * *`    | `https://storemink.com/api/cron/send-emails`             |
| `storemink-plan-expiry`             | `15 0 * * *`   | `https://storemink.com/api/cron/plan-expiry`             |
| `storemink-expire-pending-payments` | `30 * * * *`   | `https://storemink.com/api/cron/expire-pending-payments` |
| `storemink-seo-refresh`             | `0 2 * * *`    | `https://storemink.com/api/cron/seo-refresh`             |
| `storemink-search-metrics`          | `30 2 * * *`   | `https://storemink.com/api/cron/search-metrics`          |
| `storemink-domain-reconcile`        | `10 * * * *`   | `https://storemink.com/api/cron/domain-reconcile`        |
| `storemink-prune-logs`              | `0 3 * * *`    | `https://storemink.com/api/cron/prune-logs`              |
| `storemink-analytics-rollup`        | `40 * * * *`   | `https://storemink.com/api/cron/analytics-rollup`        |
| `storemink-import-worker`           | `*/10 * * * *` | `https://storemink.com/api/cron/import-worker`           |
| `storemink-billing`                 | `20 * * * *`   | `https://storemink.com/api/cron/billing`                 |
| `storemink-help-embeddings`         | `50 * * * *`   | `https://storemink.com/api/cron/help-embeddings`         |
| `storemink-mink-publications`       | `* * * * *`    | `https://storemink.com/api/cron/mink-publications`       |
| `storemink-mink-workflows`          | `* * * * *`    | `https://storemink.com/api/cron/mink-workflows`          |
| `storemink-theme-studio-runs`       | `* * * * *`    | `https://storemink.com/api/internal/theme-studio/runs`   |

> ⚠ **The table above is the INTENDED state. Measured live 2026-09-08 with
> `gcloud scheduler jobs list --project storemink-prod --location asia-south1`,
> production does not match it.** This is the exact gap the section above
> describes, so it is recorded rather than quietly corrected:
>
> | Job                           | Table says   | Actually              |
> | ----------------------------- | ------------ | --------------------- |
> | `storemink-send-emails`       | `* * * * *`  | ✅ fixed 2026-09-08   |
> | `storemink-search-metrics`    | `30 2 * * *` | **PAUSED**            |
> | `storemink-analytics-rollup`  | `40 * * * *` | **PAUSED**            |
> | `storemink-help-embeddings`   | `50 * * * *` | **absent**            |
> | `storemink-mink-publications` | `* * * * *`  | **absent**            |
> | `storemink-mink-workflows`    | `* * * * *`  | ✅ created 2026-09-08 |
>
> ⚠ **An earlier version of this note called the `send-emails` schedule a LIVE
> cost. That was wrong, and the correction is the useful part.** Measured on
> production 2026-09-08: the queue was completely healthy — 12 rows, every one
> `status=sent`, `max_attempts=1`, **zero pending**, newest sent that morning —
> and the endpoint reported `remaining: 0` across campaigns, notifications, SMS
> and announcements. Nothing was being delayed.
>
> ★ The reason is the WORKER KICK. `triggerEmailWorker` is called from eight
> production sites (`lib/notifications/record.ts`, `coupon-email-actions`,
> `announcement-actions`, the Mink campaign route, `lib/import-export/trigger.ts`
> among them), so a queued email is drained by the very request that queued it.
> **The cron is a backstop, not the delivery path** — which is what the
> `triggerEmailWorker` note in CODEBASE.md §24 already said.
>
> The daily schedule was therefore a LATENT gap, in two narrow cases:
>
> 1. **Phase 5E scheduled campaigns.** `campaign-worker.ts` claims campaigns
>    where `status='scheduled' AND scheduled_for <= now`. A due campaign has no
>    request to kick it, so one scheduled for 14:00 would not have sent until
>    00:00 UTC the next day. Zero campaigns were scheduled at the time, so nobody
>    had hit it — but the feature was effectively broken whenever used.
> 2. **Retries.** A failed send backs off 5/15/45 minutes and needs a worker run
>    at that moment. `max_attempts=1` across the whole table means this had never
>    actually occurred.
>
> ✅ **Fixed 2026-09-08: the schedule is now `* * * * *`.** Verified by three
> consecutive firings one minute apart (13:41:02, 13:42:06, 13:43:09), all HTTP
> 200, the job's own status code empty, and the queue still `pending 0 /
failed 0`. Overlapping runs are safe because the endpoint is idempotent and
> claim-based (`FOR UPDATE SKIP LOCKED`); it returned in 0.52s, far inside the
> 300s attempt deadline. The cost is ~1,440 mostly no-op requests a day against a
> `min-instances=0` service.
>
> ★ This also makes the note further up STALE: production is NOT missing the
> notification system. `notification_email_queue`, `email_campaigns`,
> `email_campaign_recipients` and a schedule-aware `claim_email_batch` all exist
> in the production database.
>
> The three absent jobs remain the documented-but-never-created failure this file
> was written about, and `search-metrics`/`analytics-rollup` remain PAUSED.
> **None of those were changed:** each needs its own decision about whether its
> migrations and routes are actually deployed first.

⚠ **`storemink-theme-studio-runs` does NOT exist yet, and it is the one job
here with a different deadline.** It executes one Theme Studio model run per
call, and a run can take up to 20 minutes, so it needs an attempt deadline of
**1,200 s** (Cloud Scheduler allows up to 1,800 s for HTTP targets), **no
retries** (the next minute's call claims whatever is next, and retrying a
20-minute request only stacks work), and a Cloud Run service request timeout of
at least 1,200 s — without that, Cloud Run kills the request mid-generation, the
lease expires 20 minutes later, and an attempt is spent for nothing. It is only
needed once an environment sets `THEME_STUDIO_PROVIDER=vertex-gemini`: the
offline provider runs in `after()` and on `mink-workflows`. Until then, model
runs queue and wait; nothing is lost. The path is under `/api/internal/`, not
`/api/cron/`, because it is a worker rather than a heartbeat. Full rollout list:
`docs/mink-ai-theme-studio-phase3.md` §6.

⚠ **`billing` must stay HOURLY.** The cycle boundary and the 48-hour grace
deadline are wall-clock instants, so the interval IS the resolution of the whole
system: on a daily schedule some merchants would get nearly a day of unearned
service and others nearly a day less notice than the 48 hours they are promised.
It runs at :20 to stay clear of the on-the-hour `domain-reconcile`.

**The pre-existing jobs exist** (verified against `gcloud scheduler jobs list`,
2026-08-21), but ⚠ **`storemink-help-embeddings` is new in the 2026-08-25
working tree and does not exist in Cloud Scheduler yet. Create it only after the
route and migrations `20260825_0017_help_article_embeddings` plus
`20260826_0018_help_embedding_hardening` reach the target environment; until
then it would 404 or query an incomplete table.** Also,
**`storemink-mink-publications` is new in Phase 5D and must stay absent/paused
until migration `20260901_0052_mink_phase_5d_blog_publication` and the matching
route are deployed. Create it with the same CRON_SECRET bearer contract only
after both application and database verification pass.** Also,
✅ **`storemink-mink-workflows` EXISTS as of 2026-09-08** (`* * * * *`, 300s
deadline, retryCount 3, same CRON_SECRET bearer contract), created only after
every precondition below was checked against production rather than assumed:
`mink_workflow_runs`, `mink_workflow_steps` and `mink_workflow_events` all
EXIST; the route answers **HTTP 200 on an empty queue** across three calls
(0.25-0.45s) with `claims:0`, which is the specific thing to verify — CODEBASE.md
§20a records a version where `parseClaimedWorkflow` threw on an empty claim, so
the minute cron answered **500 on every idle tick** and the completion fan-out
below it was unreachable; unauthenticated requests get 401; the queue was empty
(0 runs) so nothing was stranded; and 2 stores have Mink enabled, so the feature
is live and did need a worker. Verified after creation by three consecutive
firings a minute apart (13:49:09, 13:50:05, 13:51:05), all HTTP 200, the job's
own status code empty, no app-side errors, tables still clean.

★★ **IT ALSO CARRIES THE MINK CREDIT RECONCILER (2026-09-21), and that is
deliberately not a job of its own.** `settleMinkRunCredits` runs after the run
row commits and never throws, because a billing failure must not roll back a
reply the merchant is already reading — so a crash-shaped miss leaves a
`mink_usage_ledger` row with a NULL `credit_source`: answer delivered, credits
never taken, nothing retrying. `reconcileMinkRunCredits` is that retry, added
as one more independent pass here rather than as a new Cloud Scheduler entry,
because this file records **three** jobs that were documented and never
created, and this route is already per-minute, already Mink-scoped and already
authorised. The response gained `creditsSettled`.
⚠ **It is fenced off from the backlog.** Every run older than
`CHARGING_STARTED_AT` was free when it was made, so sweeping "everything
unsettled" would retroactively bill merchants for questions that cost nothing
at the time. Measured against a staging copy: **43 rows** would have been
billed without that fence, and **0** with it. It also has a 24-hour lookback
(settling a run from a previous cycle spends THIS cycle's allowance on last
cycle's work) and a 10-minute minimum age so it cannot race the live path.
⚠ It picks up a second, structural fault too: nothing calls
`settleMinkRunCredits` for a run that FAILED, so every failed run's row is NULL
for ever. Settling those charges nothing — a failed run's band is 0 and
`minkRunCreditCharge` returns only the untaken part — but records the fact,
which is what stops the sweep re-reading them every minute.
★ **IT ALSO DRAINS THEME STUDIO RUNS (2026-09-23)**, again as an independent
pass rather than a new job. Queuing a Studio run kicks the worker in-process, so
this is the backstop that reclaims expired leases and finishes work a recycled
instance left behind. It is isolated in the other direction too: a Studio
failure is logged and never fails the merchant Mink heartbeat. The response
gained `themeStudio`. See `docs/mink-ai-theme-studio-phase2.md`.
⚠ Each execution logs TWO Cloud Scheduler entries — one carrying
`httpRequest.status: 200` and one with the field absent — so a filter of
`httpRequest.status!=200` looks like failures and is not. Judge by the job's
`status.code` (blank = success).

The original caveat, kept because it still applies to any environment where this
has not been done: it **must stay absent/paused until migration
`20260902_0058_mink_phase_6a_durable_workflows`
and the matching route are deployed. Phase 6B/6C additionally requires
`20260903_0072_mink_phase_6bc_workflows` before the matching application deploy.
Create or resume it with the shared CRON_SECRET bearer contract only after the
workflow tables, template constraint and service-only grants verify. A missing
heartbeat leaves workflows queued safely; it must never be worked around by
opening the worker to unauthenticated traffic.** Also,
**the `storemink-send-emails` change from daily to once per minute belongs to
Phase 5E. Apply it only after migration
`20260901_0053_mink_phase_5e_campaigns` and the matching application are live;
before that deployment, the older claim function is not schedule-aware.** Also,
**`storemink-search-metrics` and `storemink-analytics-rollup`
are PAUSED**: their routes are on `staging` and NOT YET on `main`, and prod
deploys from `main` — so both 404 against `https://storemink.com`
(`analytics-rollup`'s first run returned NOT_FOUND at 11:40Z). **Resume both
once the routes reach prod**:

```bash
gcloud scheduler jobs resume storemink-analytics-rollup \
  --project=storemink-prod --location=asia-south1
gcloud scheduler jobs resume storemink-search-metrics \
  --project=storemink-prod --location=asia-south1
```

★★ **THE FLEET DIFF MUST BE AGAINST WHAT IS DEPLOYED, NOT THE WORKING TREE.**
This gate has two halves — a route needs a job, and the job needs a route
_live on the target host_ — and checking `app/api/cron/` against
`gcloud scheduler jobs list` only ever proves the first. Both jobs were created
off a branch where the routes exist; on prod they do not. Diff against
`origin/main` (or curl the endpoint) before creating a job, or the fleet looks
complete while two of its members 404 every hour.

Their ledger migrations ARE applied in BOTH `storemink` and `storemink_staging`
(`store_search_metrics` / `store_search_sources` / `store_search_sync_jobs` /
`store_search_rate_limits`, and `storefront_events` / `storefront_daily` /
`storefront_order_attribution`).

⚠ **`analytics-rollup` HAD TO BE CREATED BEFORE THE FIRST EVENT ARRIVES, NOT
AFTER.** It is what turns raw `storefront_events` into the durable
`storefront_daily` totals — and `prune-logs` deletes both `storefront_events`
and `storefront_order_attribution` at **14 days** (§32). With the rollup absent,
raw conversion data would be collected, never aggregated, and then permanently
deleted, silently. It was caught while both tables were still empty, so nothing
was lost; had a Pro merchant enabled the module first, the loss would have been
invisible until someone asked why the funnel was blank.

★ **THE FLEET DIFF IS THE ONLY THING THAT HAS EVER CAUGHT THIS.** Compare the
`app/api/cron/` directory against `gcloud scheduler jobs list` after ANY deploy
that adds a cron route. A job documented here but absent from Scheduler fails
completely silently — nothing errors, the work simply never happens. That has
now happened four times.

Each job is `GET`, `Etc/UTC`, 300s
attempt deadline, 3 retries, and an `Authorization: Bearer <CRON_SECRET>` header
— the same secret the routes check (`CRON_SECRET` is in Secret Manager and
already wired to the prod service).

## Rotating `CRON_SECRET`

The secret is the ONLY thing in front of every cron endpoint — `prune-logs`
deletes the audit trail, `billing` charges merchants, `expire-pending-payments`
cancels orders and restocks. Treat a leak as urgent. Rotated 2026-08-21 after
the value was pasted into a chat transcript by `jobs describe` (see the trap
below).

The app reads ONE value (`process.env.CRON_SECRET`, compared per route), so
there is no dual-secret window: this is a coordinated flip.

```bash
# 1. New version in Secret Manager (console, or:)
printf '%s' "$(openssl rand -hex 16)" | \
  gcloud secrets versions add CRON_SECRET --project=storemink-prod --data-file=-

# 2. Roll a revision so instances re-read it. The service pins
#    CRON_SECRET=CRON_SECRET:latest, so NO code deploy is needed.
gcloud run services update storemink-web-prod --project=storemink-prod \
  --region=asia-south1 \
  --update-secrets=CRON_SECRET=CRON_SECRET:latest

# 3. Take the value FROM Secret Manager — never retype it (trap 1).
CRON_SECRET_VALUE=$(gcloud secrets versions access latest \
  --secret=CRON_SECRET --project=storemink-prod)

# 4. Every job, so none is left behind.
for J in $(gcloud scheduler jobs list --project=storemink-prod \
             --location=asia-south1 --format="value(name.basename())"); do
  gcloud scheduler jobs update http "$J" --project=storemink-prod \
    --location=asia-south1 \
    --update-headers="Authorization=Bearer ${CRON_SECRET_VALUE}"
done
unset CRON_SECRET_VALUE
```

⚠ **`--update-secrets`, NEVER `--set-secrets`** in step 2. `--set-secrets`
REPLACES the whole set (the warning at the top of `cloudbuild.yaml`), so it
would strip `DB_PASSWORD`, `PAYMENT_CRED_KEY`, both Razorpay secrets and
`POS_SESSION_SECRET` — a total prod outage from a rotation command.

Between step 2 and step 4 the jobs 401. That is unavoidable with one secret and
harmless: every cron is an idempotent heartbeat that re-reads the same rows on
its next run, and each retries 3×. Keep the gap to minutes.

### Three traps, all of which bit on 2026-08-21

**★ 1. NEVER RETYPE THE SECRET INTO A SHELL VARIABLE.** A rotation done by
pasting into `export SECRET='<the new value>'` left the literal `<` on the
front, and all ten jobs were updated with a 33-character value against a
32-character secret. Everything _looked_ right — ten jobs, ten identical
hashes, no errors — because they were consistently wrong. Step 3 above reads
the value from Secret Manager so the jobs match BY CONSTRUCTION.

**★★ 2. `jobs describe` PRINTS THE SECRET.** The full `Authorization` header is
in its default output, which is how the value reached a chat log in the first
place. Always pass `--format="value(...)"` naming only the fields wanted.

**★★ 3. NORMALISE BOTH SIDES WHEN COMPARING HASHES.** `--format='value(...)'`
appends a newline; `$(...)` command substitution strips one. Hashing one side
through a pipe and the other through a variable compares 33 bytes against 32
and reports a MISMATCH on a perfectly good rotation — which then looks exactly
like a real outage. Verify with both sides normalised:

```bash
SM=$(gcloud secrets versions access latest --secret=CRON_SECRET \
       --project=storemink-prod)
h(){ printf '%s' "$1" | shasum -a 256 | cut -c1-12; }
for J in $(gcloud scheduler jobs list --project=storemink-prod \
             --location=asia-south1 --format="value(name.basename())"); do
  V=$(gcloud scheduler jobs describe "$J" --project=storemink-prod \
        --location=asia-south1 \
        --format='value(httpTarget.headers.Authorization)' | sed 's/^Bearer //')
  [ "$(h "$V")" = "$(h "$SM")" ] && echo "✅ $J" || echo "❌ $J"
done
unset SM V
```

**A hash check is not proof it works** — it proves the jobs agree with Secret
Manager, not that the running revision does. Confirm with a real run:
`import-worker` fires every 10 minutes, so it is the fastest signal. An empty
`status.code` is success. ⚠ Check `userUpdateTime` against `lastAttemptTime`
first: an attempt from BEFORE the header change says nothing about the new
secret, and reading a stale success as a pass is how a broken rotation gets
declared finished.

Only after a real run passes, **Disable** (not Destroy — disable is reversible)
the previous secret version.

`seo-refresh` registers the platform/help/themes sitemaps, retries sitemap
coverage for every launched store, and automatically verifies Search Console URL-prefix
properties for connected custom domains. It returns **503 on any partial
failure**, so Scheduler retries are part of its reliability contract. Enable
the Google Search Console + Site Verification APIs and configure the runtime
service account first; see `docs/seo-indexing.md`.

> **⚠ `Search Console rejected sitemap (403)` usually means the APIs are not
> enabled — not a property-permission problem.** The message reads like the
> service account lacks access to the property, which sends you into the Search
> Console UI looking for a grant that is already there. On 2026-08-06 every root
> and every store failed with this, and the entire cause was that
> `searchconsole.googleapis.com` and `siteverification.googleapis.com` had never
> been enabled in `storemink-prod` — a step `CODEBASE.md` §7 lists and that was
> simply skipped. Check this FIRST:
>
> ```bash
> gcloud services list --enabled --project=storemink-prod | grep -E "searchconsole|siteverification"
> ```
>
> Enabling both turned the same request into `200 {"ok":true}` with no other
> change. They are free; there is no reason for either to be off.

> **⚠ `send-emails` must stay once per minute after Phase 5E rollout.** Daily
> digests still become eligible at `DAILY_DIGEST_HOUR_UTC` (23:00 UTC), and the
> next minute heartbeat drains them. Future campaign rows are excluded from the
> worker's remaining count, so this cadence does not self-chain while waiting.

> **⚠ Timezone is `Etc/UTC`, not IST.** The cron expressions were lifted verbatim
> from `vercel.json`, where they were always UTC. Re-creating them in
> `Asia/Kolkata` would shift every job by 5h30m.

## Recreating them

The secret is read straight from Secret Manager so it never lands in a shell
history or a repo file:

```bash
CRON_SECRET_VALUE=$(gcloud secrets versions access latest \
  --secret=CRON_SECRET --project=storemink-prod)
gcloud scheduler jobs create http storemink-plan-expiry \
  --project=storemink-prod --location=asia-south1 \
  --schedule="15 0 * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/plan-expiry" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

Create the SEO job with the same secret/header contract:

```bash
gcloud scheduler jobs create http storemink-seo-refresh \
  --project=storemink-prod --location=asia-south1 \
  --schedule="0 2 * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/seo-refresh" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

Only after the Cloud Run request timeout is at least 1,200 s, create the
Theme Studio model worker (long deadline, no retries — see above):

```bash
gcloud scheduler jobs create http storemink-theme-studio-runs \
  --project=storemink-prod --location=asia-south1 \
  --schedule="* * * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/internal/theme-studio/runs" \
  --http-method=POST --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=1200s --max-retry-attempts=0
```

After the pgvector migration and route deploy are verified, create the Help
embedding reconciliation heartbeat:

```bash
gcloud scheduler jobs create http storemink-help-embeddings \
  --project=storemink-prod --location=asia-south1 \
  --schedule="50 * * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/help-embeddings" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

Its source of truth is the published article revision plus the active embedding
model, chunker version, and complete expected chunk count—not a lossy in-memory
queue. The worker rebuilds missing, partial, stale, or old-version sets. A `503`
means provider/indexing work failed and should be retried; a `200` with
`remaining:true` means a one-row lookahead proved more work exists and schedules
a bounded authenticated POST continuation.

After the search-metrics migration and deploy are verified, create its separate
worker heartbeat. The route's GET reconciles the five-day PT correction window;
the internal POST chain only drains its leased buckets:

```bash
gcloud scheduler jobs create http storemink-search-metrics \
  --project=storemink-prod --location=asia-south1 \
  --schedule="30 2 * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/search-metrics" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

This is intentionally not part of `seo-refresh`: a Search Analytics outage must
not make sitemap reconciliation report red, and its durable
`(source_id, PT date, dimension)` cursor can resume independently.

After migration `20260820_0011_storefront_conversion` and the matching deploy,
create the hourly conversion rollup. It rebuilds the still-correctable 14-day
raw window, so retries and delayed purchase events remain deterministic:

```bash
gcloud scheduler jobs create http storemink-analytics-rollup \
  --project=storemink-prod --location=asia-south1 \
  --schedule="40 * * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/analytics-rollup" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

The domain backstop is the one **hourly** job. Google's managed certificate takes
up to ~30 minutes after the challenge CNAME resolves, and merchants edit DNS on
their own schedule, so a daily sweep would leave a domain connected at 09:05
waiting a full day to serve:

```bash
gcloud scheduler jobs create http storemink-domain-reconcile \
  --project=storemink-prod --location=asia-south1 \
  --schedule="10 * * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/domain-reconcile" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

Unlike `seo-refresh` it answers **200 even while domains are still waiting** — the
common case is a merchant who hasn't added their records yet, which a retry
within the hour cannot help, and a permanently-red job is one nobody reads. Its
response body lists `waiting[]` with the reason per store.

Log retention runs last, at 03:00, after every other job has written whatever it
was going to write:

```bash
gcloud scheduler jobs create http storemink-prune-logs \
  --project=storemink-prod --location=asia-south1 \
  --schedule="0 3 * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/prune-logs" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

### `import-worker` is a BACKSTOP, not the normal path

Uploading a file kicks the worker directly (`triggerImportWorker`), so an import
starts within a second and self-chains until the file is done — the schedule
exists for the chain that BREAKS. Ten minutes because a stalled import is a
merchant watching a half-finished progress bar, and the sweep costs one query
when there is nothing to do.

```bash
gcloud scheduler jobs create http storemink-import-worker \
  --project=storemink-prod --location=asia-south1 \
  --schedule="*/10 * * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/import-worker" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
```

It answers **200 even when an import failed** — a failed import is a recorded
outcome on the job that the merchant reads in the log, not an outage, and a 5xx
would make Scheduler retry a job that has already given up.

### `billing` — the subscription heartbeat

```bash
gcloud scheduler jobs create http storemink-billing \
  --project=storemink-prod --location=asia-south1 \
  --schedule="20 * * * *" --time-zone="Etc/UTC" \
  --uri="https://storemink.com/api/cron/billing" \
  --http-method=GET --headers="Authorization=Bearer ${CRON_SECRET_VALUE}" \
  --attempt-deadline=300s --max-retry-attempts=3
unset CRON_SECRET_VALUE
```

Runs the three renewal passes **in one request, in order** — collect at T−4d,
evaluate at the cycle turn, downgrade after the 48-hour grace. Splitting them
across jobs would leave each pass a full interval behind the one before it, so a
merchant's buffer would quietly become 48 hours plus two intervals.

**Its status contract, which differs from the others in one important way:**

| Situation                             | Status  | Why                                                                                                                            |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A merchant's payment was **declined** | **200** | Not an outage. That merchant has not paid, which the grace window already handles; a 5xx would make Scheduler retry a decline. |
| A merchant was **downgraded**         | **200** | The system working as designed.                                                                                                |
| Collection is **unconfigured**        | **200** | See below — it is a known state, not a failure.                                                                                |
| A pass threw, or a store errored      | **503** | Money was not collected or a plan was not applied. Worth retrying.                                                             |

⚠ **`collectionSkipped` in the response body means AUTOPAY is off, not that
billing is idle.** While the Razorpay subsequent-charge endpoint is unverified
(`lib/billing/gateway.ts`), pass 1 still runs and still **issues** each renewal
invoice — it just does not charge it. The merchant pays it by hand on
`/dashboard/plans`, which is a complete billing path on its own. What is skipped
is only the automatic debit; a stub that always failed would create payment
attempts that can never settle, and because an unreachable provider is an
_unknown_ outcome rather than a decline, each would sit in reconciliation
forever.

★★ **Issuing was coupled to charging until 2026-08-13, and that was a silent
revenue hole.** The whole pass was skipped when the gateway was unavailable, so
no invoice was ever written — pass 2 then found nothing and recorded `waiting`,
grace never opened, nobody was ever downgraded, and every subscriber received
free service past their cycle end. The manual payment surface listed nothing,
because there was nothing to list. The job reported green throughout.

### What `prune-logs` closes

Three tables grew without bound because their retention policy was written down
and never wired to anything:

| Table                  | Window   | Why                                                                                                  |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `notifications`        | 90 days  | A read inbox row is history.                                                                         |
| `activity_events`      | 365 days | The audit trail, so it gets the longest life.                                                        |
| `email_logs`           | 90 days  | Holds rendered message BODIES, so it is much the heaviest of the three and gets the shortest window. |
| `store_search_metrics` | 488 days | Matches the source product's roughly 16-month Search Console history window.                         |

`supabase/email_logs.sql` documented the 90-day intent and even carries an
`email_logs_created_idx` built "for retention sweeps". `pruneNotifications` had
the right windows and a docstring saying it was "called by the daily cron".
**Nothing called it** — a grep returned the definition and nothing else. So
every one of these tables had grown unbounded since the day it was created.

That function has been deleted, not wired up, because it was also a live
security hole: it sat in `app/actions/notification-actions.ts`, a `"use server"`
file where **every export is a publicly reachable endpoint**, with no gate of
any kind, running under `withService` (which bypasses RLS), taking its retention
windows as _parameters_. An unauthenticated caller passing zeroes would have
deleted every notification, every email log and the whole of `activity_events`
— the append-only audit trail — for every store on the platform. The windows and
the sweep now live in `lib/retention/prune.ts`, which is not a `"use server"`
file, and the cron route is the gate (CODEBASE.md §30 applies the same rule to
`lib/domains/reconcile.ts`).

Behaviour worth knowing before you read a response:

- **It deletes in batches of 1000, each its own transaction**, so it never holds
  one enormous lock and a run that dies half way is resumable — the committed
  batches stay deleted and the next night carries on.
- **It stops itself** at 50,000 rows per table or 240 seconds, whichever comes
  first, and reports `stop` per table (`drained` / `cap` / `budget` / `error`).
  A first sweep over a long backlog will legitimately report `cap` for a few
  nights; `incomplete: true` in the body says so.
- **`incomplete` is a 200, a failed table is a 503.** A draining backlog is
  normal and must not turn the job permanently red (the `domain-reconcile`
  lesson); an actual failure should engage Scheduler's retries (the
  `seo-refresh` contract). One table failing never stops the next.
- Pruning `activity_events` cascades to any surviving `notifications`
  (`notifications.event_id` is `ON DELETE CASCADE`), which is why notifications
  are swept first and at the shorter window. **Financial records — orders,
  refunds, credit notes — live in their own tables and are never touched.**

> **⚠ `data_jobs` and `data_job_issues` are NOT yet swept, and they belong
> here.** They have the same shape and the same unbounded growth — `ISSUE_CAP`
> bounds issues per job, but nothing bounds the number of jobs. The sweep was
> written on `main`, where those tables do not exist; on this branch they do, so
> the blocker is gone. Adding them is two entries in `RETENTION_POLICIES`
> (`lib/retention/prune.ts`), **issues before jobs** — `data_job_issues.job_id`
> is `ON DELETE CASCADE` from `data_jobs`, the same shape as
> notifications→events.
>
> ⚠ Both tables carry only `(store_id, created_at)` composite indexes. A
> retention sweep filters on `created_at` **alone**, which cannot use a
> composite whose leading column is `store_id`, so each also wants a plain
> `created_at` index in `supabase/import_export_01_jobs.sql` — added as a
> separate `CREATE INDEX IF NOT EXISTS` so re-running the file stays idempotent.
> Without it the sweep works but seq-scans, which is precisely the cost that
> matters once the table is big enough to need pruning.

## Verifying

Trigger one by hand and confirm Cloud Run answered 200 — a job can be `ENABLED`
and still be failing every night, so check the _response_, not just the state:

```bash
gcloud scheduler jobs run storemink-plan-expiry --project=storemink-prod --location=asia-south1
```

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND httpRequest.requestUrl=~"/api/cron/"' --project=storemink-prod --limit=10 --format="value(httpRequest.status,httpRequest.requestUrl)"
```

The original three were verified this way on 2026-07-30.

`storemink-seo-refresh` was created and verified on **2026-08-06** — it had never
existed, so sitemap submission had never run on a schedule. Verified by calling
the endpoint directly (`200 {"ok":true}`, the then-configured platform/help
roots registered, both eligible stores ready) after enabling the two APIs above.
The themes catalog joined that same retry-backed root registration in Phase 4;
the response names each root so a rejected themes sitemap is visible rather
than an ambiguous array position.

### ★★ The fleet diff — run this, do not read the table

Three times a job has been documented here and absent from Cloud Scheduler, and
every time it was found by DIFFING, never by re-reading this file. So the diff
is a command rather than an instruction:

```bash
diff <(grep -oE 'storemink-[a-z-]+' docs/cron-jobs.md | grep -v storemink-prod | sort -u) <(gcloud scheduler jobs list --project=storemink-prod --location=asia-south1 --format='value(name.basename())' | sort -u)
```

Lines with `<` are **documented and do not exist** — the failure this file keeps
recording. Lines with `>` exist and are undocumented, which is the same drift
pointed the other way.

⚠ It needs interactive `gcloud auth login`; Application Default Credentials
(what the Cloud SQL proxy uses) are NOT enough, so this cannot be automated into
CI as it stands.

Schedules drift too, and the diff above only compares NAMES. To compare cadence:

```bash
gcloud scheduler jobs list --project=storemink-prod --location=asia-south1 \
  --format='table(name.basename(),schedule)'
```

`storemink-domain-reconcile` was created on **2026-08-06** alongside the fix it
backs. Its route ships in the same change, so verify its **response** once that
reaches production — the job authenticates (its baked-in header matches the
current `CRON_SECRET`) but will 404 until the deploy lands.

`storemink-prune-logs` and `storemink-import-worker` were created on
**2026-08-11**. Both had been listed in this file as though they existed and were
absent from Cloud Scheduler in **every** region — the failure this file records,
for the **third** time. Found by diffing the documented list against
`gcloud scheduler jobs list` rather than by reading the file, which is the only
method that has ever caught it.

Verified by triggering `storemink-import-worker` by hand: Cloud Run answered
**200** to `Google-Cloud-Scheduler`, which also proves the baked-in header
matches the current `CRON_SECRET` — and since all jobs share that secret, it
clears the auth path for every one of them. `import-worker` was chosen for the
probe deliberately: with no queued import it is a no-op, whereas triggering
`prune-logs` deletes rows.

⚠ `prune-logs` has NOT been triggered by hand — its first run is its scheduled
03:00 UTC one. Expect `{"ok":true,...}` with a large first `deleted` count and
possibly `"incomplete":true` for a few nights while the backlog drains, since
retention has never run.

`storemink-billing` was created and verified on **2026-08-13**. Triggered by
hand: Cloud Run answered **200** to `Google-Cloud-Scheduler`, which also
re-confirms the shared `CRON_SECRET`. Safe to probe because
`billing_subscriptions` was empty, so all three passes were no-ops.

It was deliberately withheld until then, on the reasoning that it "would report
green hourly while charging nobody" — true while the whole collection pass was
skipped for a missing gateway. Since the issuance/charging split it always
**issues** each renewal invoice, which the merchant can pay by hand, so it does
real work independently of autopay. Automatic collection was enabled for
verification on 2026-08-16; the same job now attempts eligible mandate debits
when platform credentials exist.

⚠ **Watch its first real run**, which is the first hour after a merchant
subscribes — that is when pass 1 stops being a no-op. For an eligible active
mandate expect an automatic attempt; otherwise expect `collect.manualRequired`
and a renewal email. `collectionSkipped` should appear only when credentials or
the charge function are unavailable.

## Staging

Staging has no scheduled jobs, deliberately — `SEARCH_INDEXABLE` keeps it out of
search, and a staging cron sending real email or cancelling real orders is a
liability, not a test. Exercise a cron route on staging by curling it with that
environment's `CRON_SECRET`.

## If you rotate `CRON_SECRET`

The header is baked into each job at creation. Rotating the secret without
updating the jobs makes every configured job start returning 401 — silently,
because a failing cron looks identical to one that had nothing to do. Use the
coordinated rotation procedure above, then re-verify with the logging query.
