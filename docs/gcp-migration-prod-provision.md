# Prod provisioning — command sequence

> Copy-paste `gcloud` sequence to provision the **prod** GCP resources for the
> cutover. Companion to [`gcp-migration-cutover-checklist.md`](gcp-migration-cutover-checklist.md)
> (§1 Prep) and [`gcp-migration-phase4-cloud-run.md`](gcp-migration-phase4-cloud-run.md)
> (build + deploy). **Run these only when you're ready to cut over** — a Cloud SQL
> instance bills continuously once created.
>
> Assumes the infra project `storemink-prod` already has (from Phase 4): the
> Artifact Registry repo `storemink`, the runtime SA `storemink-run@…`, and the
> APIs from that phase. This adds the **prod-only** resources alongside staging.

## Topology (recommended — change here if you disagree)

| Resource          | Prod                                 | Why                                                                                                                                                                           |
| ----------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity Platform | **enable on `storemink-prod`**       | IP is one-config-per-project; staging keeps `storemink-staging` → test users stay isolated. Runtime SA is in the same project, so **no cross-project Firebase creds needed**. |
| Cloud SQL         | **new instance** in `storemink-prod` | separate instance from staging = data isolation                                                                                                                               |
| Media bucket      | **new** `storemink-media-prod`       | separate from staging's `storemink-media`                                                                                                                                     |
| Cloud Run         | **new service** `storemink-web-prod` | runs alongside staging's `storemink-web`                                                                                                                                      |

_Alternative: a fully separate prod GCP project (max isolation, but more setup +
explicit cross-project `FIREBASE_\*` creds). Not recommended at this scale.\_

## 0. Variables — edit, then paste the rest of a section

```bash
export PROJECT=storemink-prod                 # infra + prod Identity Platform
export REGION=asia-south1
export DB_INSTANCE=storemink-prod-db          # NEW prod Cloud SQL instance
export DB_CONN=$PROJECT:$REGION:$DB_INSTANCE  # its connection name
export MEDIA_BUCKET=storemink-media-prod
export RUN_SVC=storemink-web-prod
export SA=storemink-run@$PROJECT.iam.gserviceaccount.com   # reuse the Phase-4 runtime SA
gcloud config set project $PROJECT
```

## 1. Enable APIs (prod-only additions)

```bash
gcloud services enable \
  sqladmin.googleapis.com \
  identitytoolkit.googleapis.com \
  recaptchaenterprise.googleapis.com \
  speech.googleapis.com
# run / artifactregistry / cloudbuild / secretmanager / cloudscheduler /
# certificatemanager / compute / aiplatform were enabled in Phase 4.
```

⚠ **`speech.googleapis.com` IS PER PROJECT, AND IT WAS ENABLED ON PROD ONLY.**
Mink dictation on the Chirp 3 provider calls Cloud Speech-to-Text V2 with the
runtime credentials of whichever project it is running in, so the staging
project — which local development also authenticates against — answered every
dictation with `403 PERMISSION_DENIED / SERVICE_DISABLED` while production
worked. Verify both rather than assuming, since the symptom in the browser is
the generic "Voice transcription is unavailable or timed out":

```bash
for p in storemink-staging storemink-prod; do
  printf '%s ' "$p"
  gcloud services list --enabled --project="$p" --format='value(config.name)' \
    | grep -qx speech.googleapis.com && echo enabled || echo MISSING
done
```

## 2. Prod Cloud SQL instance

```bash
gcloud sql instances create $DB_INSTANCE \
  --database-version=POSTGRES_17 --tier=db-g1-small \
  --region=$REGION --storage-auto-increase \
  --database-flags=cloudsql.iam_authentication=on \
  --availability-type=zonal          # --availability-type=regional for HA later

gcloud sql databases create storemink --instance=$DB_INSTANCE

# Passwords: set interactively so they never land in shell history / this file.
gcloud sql users set-password postgres --instance=$DB_INSTANCE --prompt-for-password
gcloud sql users create app          --instance=$DB_INSTANCE --prompt-for-password
```

⚠ **The live instance is `db-f1-micro`, not the `db-g1-small` this creates.** It
was downgraded on 2026-08-10 to cut ~₹1,700/month off a ~₹6,400/month GCP bill
(the Cloud SQL line alone was ~₹2,500). Shared-core tiers are **outside the Cloud
SQL SLA**, and `f1-micro`'s default `max_connections` is ~25 rather than ~50 —
which is why `_DB_POOL_MAX` exists in `cloudbuild.yaml`. Bump the tier back for
real prod load; see the cost note in [`gcp-ci-cd.md`](gcp-ci-cd.md) for the
revert command and the reasoning.

⚠ **This command has no `--backup` flag, so it creates the instance with
automated backups OFF** — and prod ran that way, unnoticed, with paying merchants
on it, until 2026-08-10. Add it here if you ever provision again:

```bash
  --backup-start-time=20:30 --retained-backups-count=7   # 20:30 UTC = 02:00 IST
```

Prod was patched to exactly that, plus `--enable-point-in-time-recovery`, so
**PITR is ON with 7 days of transaction logs** — a restore targets a moment
rather than losing everything since the nightly snapshot. If you provision again,
enable PITR at create time; turning it on later restarts the instance, because it
switches on WAL archiving.

**Then load the schema** (do it through the Auth Proxy as `postgres`, as on
staging), in order:

```bash
# with a proxy running to $DB_CONN and psql as postgres:
#   drizzle/manual/0000_compat_setup.sql   (pg_trgm + auth shim + app_user/app_service roles + grants)
#   drizzle/manual/0001_schema.sql         (38 functions, 43 tables, 99 policies, 21 triggers)
#   drizzle/manual/0002_postflight.sql     (drop auth.users FKs + regrant)
#   supabase/phase6_01_uid_columns_to_text.sql   (uid columns -> text)
# then give the login role its RLS memberships:
#   gcloud sql users assign-roles app --instance=$DB_INSTANCE --type=BUILT_IN \
#     --database-roles=app_user,app_service --revoke-existing-roles
```

The role replacement is security-critical: Cloud SQL grants
`cloudsqlsuperuser` automatically to a built-in user created without explicit
database roles. Replacing the memberships preserves StoreMink's scoped
`app_user`/`app_service` model while removing schema-administrator privileges
from the application login.

## 3. Prod media bucket

```bash
gcloud storage buckets create gs://$MEDIA_BUCKET \
  --location=$REGION --uniform-bucket-level-access

# public read (matches the media serving model)
gcloud storage buckets add-iam-policy-binding gs://$MEDIA_BUCKET \
  --member=allUsers --role=roles/storage.objectViewer

# CORS so the browser can PUT videos directly
cat > /tmp/cors.json <<'JSON'
[{ "origin": ["https://storemink.com", "https://*.storemink.com"],
   "method": ["PUT", "GET"], "responseHeader": ["Content-Type"], "maxAgeSeconds": 3600 }]
JSON
gcloud storage buckets update gs://$MEDIA_BUCKET --cors-file=/tmp/cors.json
```

## 4. Grant the runtime SA prod access

```bash
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" --role=roles/cloudsql.client
gcloud storage buckets add-iam-policy-binding gs://$MEDIA_BUCKET \
  --member="serviceAccount:$SA" --role=roles/storage.objectAdmin
# aiplatform.user / secretmanager.secretAccessor / iam.serviceAccountTokenCreator
# were granted to $SA in Phase 4.
```

## 5. Prod Identity Platform

Enabled by the API in step 1; the rest is **console** work on `storemink-prod`
(Identity Platform):

- **Providers:** Email/Password, Email link (passwordless), Google, Phone.
- **Phone:** reCAPTCHA; set the **SMS region allowlist** (`allowedRegions:["IN"]`,
  NOT the default empty `{}` which blocks all SMS).
- **Authorized domains:** `storemink.com`, `*.storemink.com`.
- **Google:** create an OAuth **Web** client, put its id/secret on the Google provider.
- **Web config:** copy the 6 values into the prod `NEXT_PUBLIC_FIREBASE_*` (used as
  build args in step 6-build below).

Because prod IP lives in `storemink-prod`, `firebase-admin` can use the runtime
SA via ADC — set **`FIREBASE_PROJECT_ID=storemink-prod`** and you do **not** need
`FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY`. (Grant the runtime SA the Firebase
Admin role once: `roles/firebaseauth.admin`.)

```bash
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" --role=roles/firebaseauth.admin
```

## 6. Prod secrets → Secret Manager

Prod and staging share this project's Secret Manager, so give prod secrets
**distinct names** (staging already holds e.g. `CRON_SECRET`). Set each
interactively — never paste values into this file or chat:

```bash
for s in DB_PASSWORD_PROD PAYMENT_CRED_KEY_PROD \
         RAZORPAY_KEY_ID_PROD RAZORPAY_KEY_SECRET_PROD RAZORPAY_WEBHOOK_SECRET_PROD \
         RESEND_API_KEY_PROD CRON_SECRET_PROD; do
  read -rs -p "value for $s: " V; echo
  printf %s "$V" | gcloud secrets create "$s" --data-file=- --replication-policy=automatic
  unset V
done
# DB_PASSWORD_PROD = the `app` user password you set in step 2.
```

## 7. Artifact Registry — reuse

Already provisioned in Phase 4 (`storemink` repo). No action.

---

## Next (build → deploy → edge) — see the phase-4 runbook

- **Build** the image with the prod `_NEXT_PUBLIC_FIREBASE_*` substitutions
  (`cloudbuild.yaml`, now Firebase args).
- **Deploy** `gcloud run deploy $RUN_SVC … --add-cloudsql-instances=$DB_CONN`
  with the decoupled env (`GCP_PROJECT_ID=$PROJECT`, `FIREBASE_PROJECT_ID=$PROJECT`,
  `DB_HOST=/cloudsql/$DB_CONN`) and `--set-secrets=…=<name>_PROD:latest`
  (see [phase-4 §6](gcp-migration-phase4-cloud-run.md)).
- **Wildcard LB + cert**, then flip DNS, then crons → Cloud Scheduler.

Then follow the **Cutover window** + **After** sections of the checklist.

```

```
