# CI/CD — Cloud Build → Cloud Run (per environment)

> ⚠ **THE STAGING DEPLOYMENT WAS REMOVED ON 2026-09-08.** There is no `staging`
> branch, no `storemink-web-staging` build trigger, no `storemink-web` Cloud Run
> service and no `staging.storemink.com`. **dev is the only pre-production
> environment.** The staging recipes further down are kept for the history of how
> the environment was built and would be the starting point if it is ever
> recreated — do not follow them expecting a live environment.
>
> ★ What did NOT go away: the **`storemink_staging` DATABASE** and the
> `storemink-staging` Identity Platform project. dev uses both, so every
> "dev and staging share this" note below still holds — with one consumer now
> instead of two. `npm run db:migrate:staging` and `npm run db:drift:staging`
> still target a live database despite the name; that database is dev's.

Push-to-deploy for all three environments, driven by
[`cloudbuild.yaml`](../cloudbuild.yaml):

| Branch    | Builds & deploys to         | Firebase / DB / bucket                                        |
| --------- | --------------------------- | ------------------------------------------------------------- |
| `dev`     | `storemink-web-dev` (dev)   | `storemink-staging` / `storemink_staging` / `storemink-media` |
| `staging` | `storemink-web` (staging)   | `storemink-staging` / `storemink_staging` / `storemink-media` |
| `main`    | `storemink-web-prod` (prod) | `storemink-prod` / `storemink` / `storemink-media-prod`       |

Flow going forward: feature branch → merge to `dev` (auto-deploys
`dev.storemink.com`) → merge to `staging` (auto-deploys staging, verify) →
merge `staging` to `main` (auto-deploys prod).

> ### ⚠ dev is NOT an isolated environment
>
> **`dev` shares staging's database (`storemink_staging`), its Identity
> Platform project (`storemink-staging`), its media bucket
> (`storemink-media`) and every one of its per-env secrets.** It is a second
> Cloud Run service and hostname in front of staging's data — chosen
> deliberately (owner, 2026-08-29) for speed of setup, not by oversight.
>
> The consequences, so nobody discovers them the hard way:
>
> - A migration applied while testing on dev **is applied to staging**. There
>   is no separate database to roll back.
> - Destructive test data created on dev shows up on staging, and vice versa.
> - The `sm_session` cookie is scoped to `.storemink.com`, so a login on
>   staging is already a login on dev. That is a convenience, not a bug — but
>   it also means the two cannot be tested as separate tenancies.
> - Every POS device authorised on staging is authorised on dev (`pos_devices`
>   is one shared table, and `POS_SESSION_SECRET` is deliberately the same).
> - **The shared secrets are not laziness.** `PAYMENT_CRED_KEY` decrypts the
>   BYO-gateway credentials stored in that one shared database, so a
>   dev-specific key physically could not read rows staging wrote. If dev is
>   ever split onto its own database, that key must be split in the same
>   change — and the existing encrypted rows are not portable between them.
>
> Splitting dev onto its own `storemink_dev` database later is a contained
> change: create the database, run the migration ledger against it, and flip
> `_DB_NAME` on the dev trigger. Splitting the **Firebase project** is not
> contained — `admins.id` / `users.id` ARE the Firebase uid, so a new project
> means every existing row in that database references uids the new project
> has never heard of (CODEBASE §7). Split the database first, the project only
> with a user-import plan.

## Release gate: schema before application

Cloud Build deploys application images; it does **not** own database DDL. A
`staging` → `main` promotion is allowed only after the checksummed runner in
[`drizzle/manual/README.md`](../drizzle/manual/README.md) is green.

For a release containing migrations:

1. On staging, run `baseline` once, then `apply` and `verify`. Exercise the
   changed path against the deployed staging revision.
2. Record the staging `schema_sha256` and the exact staging commit.
3. Confirm an automated Cloud SQL backup and PITR are healthy. Run `status`
   against production before taking the migration lock.
4. Apply the same manifest to production **before** merging to `main`; the
   runner requires `--environment production --confirm-production storemink`.
5. Run production `verify`; its schema hash must equal staging's. Only then
   merge the already-tested staging commit to `main`.
6. Watch the `storemink-web-prod` Cloud Build to success, confirm the Cloud Run
   revision carries that commit, and smoke-test the apex plus one tenant host.

`audit`/`adopt` are one-time ledger-recovery commands for schema that was
already applied manually; they are not substitutes for `apply`. Their
fail-closed workflow is read-only audit followed by one exact, first-pending
migration at a time, with repeated ID/checksum/database confirmations. It is
documented in
[`drizzle/manual/README.md`](../drizzle/manual/README.md).

Application rollback is a Cloud Run revision rollback. Database migrations are
forward-only by default: never drop the newly-added objects during an app
rollback. A destructive migration needs its own reviewed restore/forward-fix
runbook and a fresh backup immediately before execution.

---

## Why the first CI build failed

Cloud Run's built-in "Deploy from repository" created a trigger with **no build
config** — it did a bare Dockerfile build with **zero `--build-arg`s**. So
`NEXT_PUBLIC_ROOT_DOMAIN` was empty at build time, and `next build` crashed:

```
Failed to collect page data for /_not-found
TypeError: Invalid URL, input: 'https:'
```

`NEXT_PUBLIC_*` are **baked into the client bundle at build time**, so they must
be passed as Docker build args (only `cloudbuild.yaml` does this). The empty
`ROOT_DOMAIN` produced `PLATFORM_URL = "https:"` → `new URL("https:")` throws.

Two-part fix (both in this commit):

1. **Code safety net** — `lib/store/host.ts` now uses `|| "storemink.com"` (not
   `??`), so an empty env degrades to the apex instead of crashing. Belt-and-
   suspenders; the trigger must still pass the real values.
2. **`cloudbuild.yaml` is now a full build → deploy pipeline** with per-env
   substitutions (below). Replace the built-in trigger with two that use it.
   The build step runs `docker buildx` with registry-backed layer caching: it
   pushes the image itself (no separate push step) and also writes a per-env
   `web:buildcache-<tag>` cache image to the same Artifact Registry repo, so the
   first build after this change is a cold cache and later builds skip an
   unchanged `npm ci`. No new IAM/substitution — the cache tag is derived from
   `_IMAGE` and reuses the SA's existing Artifact Registry write access.

---

## One-time IAM (Cloud Build service account)

Both triggers run as the Compute Engine default SA
`705863961054-compute@developer.gserviceaccount.com`. It already has
build/push/log perms; grant it deploy perms (idempotent):

```bash
# Deploy to Cloud Run
gcloud projects add-iam-policy-binding storemink-prod \
  --member="serviceAccount:705863961054-compute@developer.gserviceaccount.com" \
  --role="roles/run.admin"

# Act AS the runtime SA (the deploy sets the service to run as storemink-run)
gcloud iam service-accounts add-iam-policy-binding \
  storemink-run@storemink-prod.iam.gserviceaccount.com \
  --project=storemink-prod \
  --member="serviceAccount:705863961054-compute@developer.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

---

## Create the three triggers

The repo uses a 1st-gen GitHub App connection (`Vansh44/storemink`), so plain
`gcloud builds triggers create github` works.

> **`<STAGING_WEB_API_KEY>` / `<PROD_WEB_API_KEY>`** — the Firebase **web**
> apiKey. It's PUBLIC (it ships in the client bundle), so it's fine in a trigger
> config, but it's kept OUT of the tracked repo to avoid GitHub secret-scanning
> alerts. Fetch each from its project:
>
> ```bash
> gcloud auth application-default set-quota-project storemink-prod  # once
> curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
>   -H "X-Goog-User-Project: <PROJECT>" \
>   "https://firebase.googleapis.com/v1beta1/projects/<PROJECT>/webApps/-/config"
> ```
>
> (`<PROJECT>` = `storemink-staging` or `storemink-prod`) — or Firebase console →
> Project settings → Your apps → Web app → SDK config.
>
> **Real hardening (do this once per key):** in Google Cloud console →
> APIs & Services → Credentials → the "Browser key", set **Application
> restrictions** = HTTP referrers (your domains) and **API restrictions** =
> Identity Toolkit + Token Service + the Firebase APIs you use. That, not
> secrecy, is what protects a public web key.

### Dev (`dev` → `storemink-web-dev`)

Every value here is staging's **except** the four that define the environment:
service name, image tag, root domain, and the two capacity dials. It inherits
all six per-env secret NAMES from the `cloudbuild.yaml` defaults, which target
staging — that is correct for dev and is the one place dev deliberately does
_not_ follow the "override every secret" rule the prod trigger must.

```bash
gcloud builds triggers create github \
  --project=storemink-prod --region=global \
  --name=storemink-web-dev \
  --repo-owner=Vansh44 --repo-name=storemink \
  --branch-pattern='^dev$' \
  --build-config=cloudbuild.yaml \
  --service-account=projects/storemink-prod/serviceAccounts/705863961054-compute@developer.gserviceaccount.com \
  --substitutions='_IMAGE=asia-south1-docker.pkg.dev/storemink-prod/storemink/web:dev,_SERVICE=storemink-web-dev,_MIN_INSTANCES=0,_MAX_INSTANCES=2,_DB_POOL_MAX=3,_DB_CONN=storemink-prod:asia-south1:storemink-prod-db,_DB_NAME=storemink_staging,_DB_PASSWORD_SECRET=CLOUDSQL_PROD_APP_PW,_GCS_BUCKET=storemink-media,_FIREBASE_PROJECT_ID=storemink-staging,_FIREBASE_SA_ID=firebase-adminsdk-fbsvc@storemink-staging.iam.gserviceaccount.com,_NEXT_PUBLIC_FIREBASE_API_KEY=<STAGING_WEB_API_KEY>,_NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=storemink-staging.firebaseapp.com,_NEXT_PUBLIC_FIREBASE_PROJECT_ID=storemink-staging,_NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=storemink-staging.firebasestorage.app,_NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=68037646295,_NEXT_PUBLIC_FIREBASE_APP_ID=1:68037646295:web:388ef47d32e39c822b1d92,_NEXT_PUBLIC_ROOT_DOMAIN=dev.storemink.com,_NEXT_PUBLIC_APP_URL=https://dev.storemink.com,_MINK_AI_ENABLED=true'
```

Mink AI is globally enabled by default in every environment. The model,
location and run limits come from `cloudbuild.yaml`; store access is controlled
only by the single operator Mink AI button. Staff permissions and exact-action
approvals remain independent. For an already-created trigger, keep the global
runtime substitution explicit:

```bash
gcloud builds triggers update github storemink-web-dev \
  --project=storemink-prod --region=global \
  --update-substitutions=_MINK_AI_ENABLED=true
```

Apply the same update to the existing staging and production triggers before
their next deployment:

```bash
gcloud builds triggers update github storemink-web-staging \
  --project=storemink-prod --region=global \
  --update-substitutions=_MINK_AI_ENABLED=true

gcloud builds triggers update github storemink-web-prod \
  --project=storemink-prod --region=global \
  --update-substitutions=_MINK_AI_ENABLED=true
```

### ⚠ `_MINK_BETA_REQUIRE_INVITE` is retired — clear it from the triggers

The invitation flag is gone from the application (`lib/mink/config.ts` pins it
to true; the store switch is the only access boundary). All three triggers were
told to set it, and **`--update-substitutions` cannot remove a key** — it only
writes the ones you name. Clear it explicitly:

```bash
for t in storemink-web-dev storemink-web storemink-web-prod; do
  gcloud builds triggers update github "$t" \
    --project=storemink-prod --region=global \
    --remove-substitutions=_MINK_BETA_REQUIRE_INVITE
done
```

**Why it is worth doing rather than leaving.** `cloudbuild.yaml` sets no
`substitution_option: ALLOW_LOOSE`, so Cloud Build rejects a build whose
substitution data carries a key the template never references, with
`key in the substitution data is not matched in the template`.
A trigger still setting this against a file that had dropped it would fail
every build on that branch, so production would stop deploying until somebody
remembered this step. That is the failure `docs/cron-jobs.md` keeps recording,
so it is not left to memory: `cloudbuild.yaml` declares the key empty and reads
it in a shim at the top of `build-push`, which keeps the merge safe on its own
and prints a warning naming this section for as long as a trigger still sets
it. **Once the loop above has run for all three triggers, delete the shim and
the `_MINK_BETA_REQUIRE_INVITE: ""` default** — the warning is the reminder,
and a shim nobody removes is a substitution nobody can explain a year later.

For local Mink development, the Vertex-only agent uses Application Default
Credentials. If chat or image/PDF processing reports an expired local login and
the server log contains `invalid_grant`, `invalid_rapt` or reauthentication,
renew ADC and restart the development server:

```bash
gcloud auth application-default login
npm run dev
```

This is only a laptop-development recovery. Cloud Run must use the configured
runtime service account with `roles/aiplatform.user`; do not add an interactive
user credential or key file to production.

**`_MAX_INSTANCES=2` and `_DB_POOL_MAX=3` are not arbitrary.** The Cloud SQL
instance is `db-f1-micro` with `max_connections` ≈ 25, and all three services
share it. At staging's 4 × 5 a third environment would add another 20
connections to a ceiling already exceeded on paper; 2 × 3 = 6 adds far less.
dev is a proving ground with one or two people on it, so the capacity it gives
up costs nothing.

**dev needs no Cloud Scheduler jobs.** Every job in
[`cron-jobs.md`](cron-jobs.md) targets `https://storemink.com`; staging has
none either, and pointing a scheduler at dev would run billing, plan-expiry and
the log-retention sweep against the **staging database** dev shares. If you
need to exercise a cron on dev, invoke its endpoint by hand with the
`CRON_SECRET` bearer token, and know what it will touch first.

**dev is never indexed and never provisions certificates**, with nothing to
configure: `SEARCH_INDEXABLE` and `IS_PRODUCTION_PLATFORM`
(`lib/store/host.ts`) both test `ROOT_DOMAIN === "storemink.com"`, so
`dev.storemink.com` gets `Disallow: /`, an empty sitemap, no IndexNow ping, and
`reconcileDomainForStore` refuses to touch Certificate Manager. That last gate
is what keeps a third environment from writing entries into the shared
`prod-cert-map` (CODEBASE §30) — `_DOMAIN_ENV` is therefore left at its `stg`
default, since `domainEnv()` normalises anything non-prod to `stg` anyway and
dev can never reach the code that reads it.

### Staging (`staging` → `storemink-web`)

Only the 6 Firebase values differ from the `cloudbuild.yaml` defaults, but we
pass the full set so the trigger is self-documenting:

```bash
gcloud builds triggers create github \
  --project=storemink-prod --region=global \
  --name=storemink-web-staging \
  --repo-owner=Vansh44 --repo-name=storemink \
  --branch-pattern='^staging$' \
  --build-config=cloudbuild.yaml \
  --service-account=projects/storemink-prod/serviceAccounts/705863961054-compute@developer.gserviceaccount.com \
  --substitutions='_IMAGE=asia-south1-docker.pkg.dev/storemink-prod/storemink/web:staging,_SERVICE=storemink-web,_MIN_INSTANCES=0,_DB_CONN=storemink-prod:asia-south1:storemink-prod-db,_DB_NAME=storemink_staging,_DB_PASSWORD_SECRET=CLOUDSQL_PROD_APP_PW,_GCS_BUCKET=storemink-media,_FIREBASE_PROJECT_ID=storemink-staging,_FIREBASE_SA_ID=firebase-adminsdk-fbsvc@storemink-staging.iam.gserviceaccount.com,_NEXT_PUBLIC_FIREBASE_API_KEY=<STAGING_WEB_API_KEY>,_NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=storemink-staging.firebaseapp.com,_NEXT_PUBLIC_FIREBASE_PROJECT_ID=storemink-staging,_NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=storemink-staging.firebasestorage.app,_NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=68037646295,_NEXT_PUBLIC_FIREBASE_APP_ID=1:68037646295:web:388ef47d32e39c822b1d92,_NEXT_PUBLIC_ROOT_DOMAIN=staging.storemink.com,_NEXT_PUBLIC_APP_URL=https://staging.storemink.com,_MINK_AI_ENABLED=true'
```

### Production (`main` → `storemink-web-prod`)

```bash
gcloud builds triggers create github \
  --project=storemink-prod --region=global \
  --name=storemink-web-prod \
  --repo-owner=Vansh44 --repo-name=storemink \
  --branch-pattern='^main$' \
  --build-config=cloudbuild.yaml \
  --service-account=projects/storemink-prod/serviceAccounts/705863961054-compute@developer.gserviceaccount.com \
  --substitutions='_IMAGE=asia-south1-docker.pkg.dev/storemink-prod/storemink/web:prod,_SERVICE=storemink-web-prod,_MIN_INSTANCES=0,_DB_CONN=storemink-prod:asia-south1:storemink-prod-db,_DB_NAME=storemink,_DB_PASSWORD_SECRET=CLOUDSQL_PROD_APP_PW,_GCS_BUCKET=storemink-media-prod,_FIREBASE_PROJECT_ID=storemink-prod,_FIREBASE_SA_ID=firebase-adminsdk-fbsvc@storemink-prod.iam.gserviceaccount.com,_NEXT_PUBLIC_FIREBASE_API_KEY=<PROD_WEB_API_KEY>,_NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=storemink-prod.firebaseapp.com,_NEXT_PUBLIC_FIREBASE_PROJECT_ID=storemink-prod,_NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=storemink-prod.firebasestorage.app,_NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=705863961054,_NEXT_PUBLIC_FIREBASE_APP_ID=1:705863961054:web:e326046a5f9f7b7de9f54f,_NEXT_PUBLIC_ROOT_DOMAIN=storemink.com,_NEXT_PUBLIC_APP_URL=https://storemink.com,_GOOGLE_SEARCH_CONSOLE_PROPERTY=sc-domain:storemink.com,_POS_SESSION_SECRET_SECRET=POS_SESSION_SECRET_PROD,_PAYMENT_CRED_KEY_SECRET=PAYMENT_CRED_KEY_PROD,_RAZORPAY_KEY_ID_SECRET=RAZORPAY_KEY_ID_PROD,_RAZORPAY_KEY_SECRET_SECRET=RAZORPAY_KEY_SECRET_PROD,_RAZORPAY_WEBHOOK_SECRET_SECRET=RAZORPAY_WEBHOOK_SECRET_PROD,_RESEND_WEBHOOK_SECRET_SECRET=RESEND_WEBHOOK_SECRET_PROD,_DOMAIN_ENV=prod,_MINK_AI_ENABLED=true'
```

> **⚠ The prod trigger must override every per-env secret NAME.** The
> `cloudbuild.yaml` defaults all target STAGING, so anything the prod trigger
> omits silently inherits a staging secret — prod would run on Razorpay TEST
> keys, and a `PAYMENT_CRED_KEY` mismatch cannot decrypt prod-stored gateway
> creds. The `*_SECRET` substitutions above were absent from this command
> until 2026-07-27 (and `_RESEND_WEBHOOK_SECRET_SECRET` until 2026-08-01);
> verify the live trigger actually carries them:
>
> ```bash
> gcloud builds triggers describe storemink-web-prod \
>   --project=storemink-prod --region=global \
>   --format='value(substitutions)'
> ```

---

## Delete the broken built-in trigger

```bash
gcloud builds triggers delete rmgpgab-storemink-web-asia-south1-Vansh44-storemink--stagiufd \
  --project=storemink-prod --region=global
```

---

## Substitution reference (dev vs staging vs prod)

Anything not listed as differing is **identical across all three** — dev
inherits staging's database, Firebase project, bucket and every secret name.
**←** marks a value dev sets for itself.

| Substitution                                | Dev                                                                 | Staging                                                             | Production                                                       |
| ------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `_SERVICE`                                  | `storemink-web-dev` **←**                                           | `storemink-web`                                                     | `storemink-web-prod`                                             |
| `_IMAGE` (tag)                              | `…/storemink/web:dev` **←**                                         | `…/storemink/web:staging`                                           | `…/storemink/web:prod`                                           |
| `_MIN_INSTANCES`                            | `0`                                                                 | `0`                                                                 | `0` (was `1` — see below)                                        |
| `_MAX_INSTANCES`                            | `2` **←**                                                           | `4`                                                                 | `4`                                                              |
| `_DB_POOL_MAX`                              | `3` **←**                                                           | `5`                                                                 | `5`                                                              |
| `_DB_CONN`                                  | `storemink-prod:asia-south1:storemink-prod-db`                      | `storemink-prod:asia-south1:storemink-prod-db`                      | `storemink-prod:asia-south1:storemink-prod-db`                   |
| `_DB_NAME`                                  | `storemink_staging`                                                 | `storemink_staging`                                                 | `storemink`                                                      |
| `_DB_PASSWORD_SECRET`                       | `CLOUDSQL_PROD_APP_PW`                                              | `CLOUDSQL_PROD_APP_PW`                                              | `CLOUDSQL_PROD_APP_PW`                                           |
| `_GCS_BUCKET`                               | `storemink-media`                                                   | `storemink-media`                                                   | `storemink-media-prod`                                           |
| `_FIREBASE_PROJECT_ID`                      | `storemink-staging`                                                 | `storemink-staging`                                                 | `storemink-prod`                                                 |
| `_FIREBASE_SA_ID` (custom-token signer)     | `firebase-adminsdk-fbsvc@storemink-staging.iam.gserviceaccount.com` | `firebase-adminsdk-fbsvc@storemink-staging.iam.gserviceaccount.com` | `firebase-adminsdk-fbsvc@storemink-prod.iam.gserviceaccount.com` |
| `_NEXT_PUBLIC_FIREBASE_API_KEY`             | `<STAGING_WEB_API_KEY>`                                             | `<STAGING_WEB_API_KEY>`                                             | `<PROD_WEB_API_KEY>`                                             |
| `_NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`         | `storemink-staging.firebaseapp.com`                                 | `storemink-staging.firebaseapp.com`                                 | `storemink-prod.firebaseapp.com`                                 |
| `_NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`      | `storemink-staging.firebasestorage.app`                             | `storemink-staging.firebasestorage.app`                             | `storemink-prod.firebasestorage.app`                             |
| `_NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID` | `68037646295`                                                       | `68037646295`                                                       | `705863961054`                                                   |
| `_NEXT_PUBLIC_FIREBASE_APP_ID`              | `1:68037646295:web:388ef47d32e39c822b1d92`                          | `1:68037646295:web:388ef47d32e39c822b1d92`                          | `1:705863961054:web:e326046a5f9f7b7de9f54f`                      |
| `_NEXT_PUBLIC_ROOT_DOMAIN`                  | `dev.storemink.com` **←**                                           | `staging.storemink.com`                                             | `storemink.com`                                                  |
| `_DOMAIN_ENV`                               | `stg` (default)                                                     | `stg` (default)                                                     | **`prod` — must be set explicitly**                              |
| `_DOMAIN_CERT_MAP`                          | `prod-cert-map`                                                     | `prod-cert-map`                                                     | `prod-cert-map`                                                  |
| `_DOMAIN_LB_IP`                             | `136.69.75.127`                                                     | `136.69.75.127`                                                     | `136.69.75.127`                                                  |
| `_NEXT_PUBLIC_APP_URL`                      | `https://dev.storemink.com` **←**                                   | `https://staging.storemink.com`                                     | `https://storemink.com`                                          |
| `_GOOGLE_SEARCH_CONSOLE_PROPERTY`           | _(empty — never indexed)_                                           | _(empty — never indexed)_                                           | `sc-domain:storemink.com`                                        |
| `_POS_SESSION_SECRET_SECRET`                | `POS_SESSION_SECRET_STAGING`                                        | `POS_SESSION_SECRET_STAGING`                                        | `POS_SESSION_SECRET_PROD`                                        |
| `_RESEND_WEBHOOK_SECRET_SECRET`             | `RESEND_WEBHOOK_SECRET_STAGING`                                     | `RESEND_WEBHOOK_SECRET_STAGING`                                     | `RESEND_WEBHOOK_SECRET_PROD`                                     |
| `_MINK_AI_ENABLED`                          | `true` **←**                                                        | `true`                                                              | `true`                                                           |
| `_MINK_VERTEX_MODEL`                        | `gemini-3.7-flash`                                                  | `gemini-3.7-flash`                                                  | `gemini-3.7-flash`                                               |
| `_MINK_VERTEX_LOCATION`                     | `global`                                                            | `global`                                                            | `global`                                                         |
| `_MINK_MAX_STEPS_PER_RUN`                   | `8`                                                                 | `8`                                                                 | `8`                                                              |
| `_MINK_MAX_TOOL_CALLS_PER_RUN`              | `16`                                                                | `16`                                                                | `16`                                                             |
| `_MINK_MAX_PARALLEL_READ_TOOLS`             | `4`                                                                 | `4`                                                                 | `4`                                                              |
| `_MINK_MAX_OUTPUT_TOKENS`                   | `2048`                                                              | `2048`                                                              | `2048`                                                           |
| `_MINK_MAX_MODEL_RETRIES`                   | `1`                                                                 | `1`                                                                 | `1`                                                              |
| `_MINK_RUN_TIMEOUT_SECONDS`                 | `120`                                                               | `120`                                                               | `120`                                                            |

> **⚠ COST CUTS OF 2026-08-10 — three values here are now tuned for spend, not
> for headroom.** Monthly GCP was tracking to ~₹6,400 and had to come down.
>
> - **`_MIN_INSTANCES` on prod went `1` → `0`.** The always-warm instance cost
>   ~₹700/month. Prod now scales to zero; a measured cold start is ~1.2 s
>   (`https://storemink.com`, first hit after idle). The original reason for
>   pinning it to 1 was Firebase session-cookie verification latency
>   ([phase-4 §126](gcp-migration-phase4-cloud-run.md)) — that cost is now paid
>   on the first request after an idle period instead of never. Put it back to
>   `1` the moment real traffic makes the cold start visible to shoppers.
> - **The Cloud SQL instance went `db-g1-small` → `db-f1-micro`** (~₹1,700/month).
>   0.6 GB RAM, shared core, **not covered by the Cloud SQL SLA** — Google
>   positions shared-core tiers as dev/test. This is the first thing to revert
>   if the database misbehaves under load:
>   `gcloud sql instances patch storemink-prod-db --tier=db-g1-small` (restarts
>   the instance; the downgrade itself took ~12 minutes).
> - **`_DB_POOL_MAX` is new, and it exists BECAUSE of that tier.** `f1-micro`'s
>   default `max_connections` is ~25, down from ~50 on `g1-small`, and staging
>   and prod share the one instance. See the comment in `cloudbuild.yaml` for
>   the arithmetic. `lib/db/client.ts` defaults to 10, so leaving this unset
>   doubles the exposure — always pass it.
>
> **Backups were OFF on `storemink-prod-db` until 2026-08-10** — the instance was
> created without `--backup` and nobody had noticed, with paying merchants on it.
> Now: **daily automated backups at 20:30 UTC (02:00 IST), 7 retained.**
> **Point-in-time recovery is ON** as of 2026-08-10, with 7 days of transaction
> logs, so a restore can target a moment rather than losing up to 24 hours of
> writes back to the nightly snapshot. It was enabled the same day the
> cancellation, refund and returns paths went live against real Razorpay keys —
> a daily-snapshot-only window is not something to run a payments path on.
> Enabling it archives WAL and therefore costs some storage; that was accepted
> deliberately, against a cut that had already saved ~₹3,100/month.

> **POS_SESSION_SECRET is required for the register to work at all.** It signs
> the `pos_device` / `pos_operator` cookies (`lib/pos/session.ts`). Verification
> degrades quietly without it, but MINTING does not — so with the secret absent,
> "Authorize this device" and cashier PIN login both fail. It was missing from
> this file until 2026-07-27, which is exactly how staging shipped a POS that
> 500'd on every authorize attempt. Per-env, like `PAYMENT_CRED_KEY`: this key
> mints register credentials, so a leaked staging value must not forge a device
> cookie against prod. Create each once:
>
> ```bash
> printf '%s' "$(openssl rand -base64 32)" | gcloud secrets create POS_SESSION_SECRET_STAGING \
>   --project=storemink-prod --data-file=-
> ```

> **⚠ RESEND_WEBHOOK_SECRET must exist BEFORE this config deploys.** Cloud Run
> fails a revision outright when `--set-secrets` names a secret that isn't in
> Secret Manager, so creating both entries is a PREREQUISITE of merging the
> `cloudbuild.yaml` change, not a follow-up. Unlike `POS_SESSION_SECRET` there
> is nothing to generate — the value is Resend's, minted when you register the
> endpoint, so the order is: add the endpoint in Resend → copy its `whsec_…` →
> create the secret → merge.
>
> Per **endpoint**, hence per env (`RESEND_API_KEY` is one account-wide key and
> stays unsubstituted). In the Resend dashboard → Webhooks, add one endpoint per
> environment subscribed to `email.bounced` + `email.complained`:
>
> | env     | endpoint                                            | secret                          |
> | ------- | --------------------------------------------------- | ------------------------------- |
> | staging | `https://staging.storemink.com/api/webhooks/resend` | `RESEND_WEBHOOK_SECRET_STAGING` |
> | prod    | `https://storemink.com/api/webhooks/resend`         | `RESEND_WEBHOOK_SECRET_PROD`    |
>
> ```bash
> printf '%s' 'whsec_…' | gcloud secrets create RESEND_WEBHOOK_SECRET_PROD \
>   --project=storemink-prod --data-file=-
> ```
>
> Why it matters: this endpoint is how the app learns an address is dead
> (`email_suppressions`, CODEBASE §24). Unset, the route logs a warning and
> drops every event — so nothing is ever suppressed and dead addresses are
> mailed forever on a sending domain whose reputation is shared by every store.
> It fails silently in exactly the direction you don't notice.

Staging is never indexed (its `ROOT_DOMAIN` isn't the prod apex), so it needs no
Search Console property. On prod, the runtime SA `_RUN_SA` authenticates to
Search Console via ADC — grant it access to the property once (see
`docs/seo-indexing.md`); there is no key/secret to store.

> **⚠ Shared database instance.** Staging and prod share ONE Cloud SQL instance
> (`storemink-prod-db`); staging is the `storemink_staging` database, prod is
> `storemink`. Both triggers point `_DB_CONN` at the same instance, so the ONLY
> thing separating them is `_DB_NAME`. **Both triggers must set `_DB_NAME`
> explicitly** — if prod ever omitted it and fell back to the `cloudbuild.yaml`
> default (`storemink_staging`), prod would silently run against the staging
> database. There is one cluster-wide `app` role, so both use
> `CLOUDSQL_PROD_APP_PW`; staging credentials can therefore reach the prod
> database if `_DB_NAME` is wrong. Before onboarding real customers, either
> split staging back onto its own instance or add a restricted `app_staging`
> role (own secret + a `_DB_USER` substitution) so this is impossible.

The Firebase `apiKey` and app id are public (they ship in the client bundle) —
not secrets. Real secrets (`DB_PASSWORD`, `CRON_SECRET`) come from Secret Manager
at deploy time via `--set-secrets`; add `RESEND_API_KEY`, `PAYMENT_CRED_KEY`,
`RAZORPAY_*` there when those features go live.
