# GCP Migration — Phase 4: Vercel → Cloud Run

> Hosting migration runbook. The **code** (containerization) is done and
> committed; the rest is infrastructure you provision with `gcloud`. Do it in
> parallel with Vercel and cut DNS over only once proven — fully reversible.
>
> **Targets the post-Phase-5/6 stack** (Cloud SQL + Identity Platform) — env is
> updated accordingly, no `SUPABASE_*`. Project `storemink-prod`, region
> `asia-south1` (Mumbai) assumed throughout; the Identity Platform project is
> separate (per-env — CODEBASE.md §7).

## What's already in the repo (Phase 4 code)

- `next.config.ts` → `output: "standalone"` (self-contained server bundle; ignored by Vercel).
- `Dockerfile` — multi-stage, Debian-slim, non-root, listens on `$PORT` (8080). Bakes `NEXT_PUBLIC_*` at build; server secrets stay runtime-only.
- `.dockerignore` — small context; **keeps `brand/tasks/*.md`** (read at runtime by the AI actions).
- `cloudbuild.yaml` — builds `linux/amd64` in-cloud and pushes to Artifact Registry.

Verified: `npm run build` produces `.next/standalone/server.js` with
`brand/tasks`, `docs/mink-ai-system-prompt.md` and `sharp` traced in.

> **⚠ Architecture:** Cloud Run runs `linux/amd64`. Build with Cloud Build (below)
> or, if using local Docker on an Apple-Silicon Mac, you MUST pass
> `docker build --platform linux/amd64` or the `sharp` binary won't run.

## Runtime env split (post Phase 5/6 — Cloud SQL + Identity Platform)

> **⚠ Updated for the migrated stack.** Data is on **Cloud SQL** (`lib/db`,
> Drizzle) and auth on **Identity Platform** (`lib/auth`, Firebase) — there are
> **no `SUPABASE_*` vars** anymore. Key subtlety: the Identity Platform project
> is a **different GCP project** from the infra project (per-env pairing —
> CODEBASE.md §7), and the Cloud Run runtime SA can't cross projects, so give
> Firebase **explicit `FIREBASE_*` service-account creds** and point
> `GCP_PROJECT_ID` at the infra project (Cloud SQL / GCS / Vertex).

- **Build args** (public, inlined into the client bundle): the six
  `NEXT_PUBLIC_FIREBASE_*` (`_API_KEY`, `_AUTH_DOMAIN`, `_PROJECT_ID`,
  `_STORAGE_BUCKET`, `_MESSAGING_SENDER_ID`, `_APP_ID`), `NEXT_PUBLIC_ROOT_DOMAIN`,
  `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_NOINDEX` (optional). — see `Dockerfile` /
  `cloudbuild.yaml`.
- **Runtime plain env** (non-secret): `GCP_PROJECT_ID` (the INFRA project —
  Vertex / GCS), `GCP_LOCATION`, `GCS_BUCKET`; the Cloud SQL connection
  `DB_HOST=/cloudsql/<connection-name>` (unix socket), `DB_USER`, `DB_NAME` (no
  `DB_PORT` for the socket); Firebase `FIREBASE_PROJECT_ID` (the AUTH project) +
  `FIREBASE_CLIENT_EMAIL` + `FIREBASE_API_KEY` (web key, read server-side for the
  change-password re-verify); `GEMINI_MODEL` (opt), `RESEND_FROM_DOMAIN`; plus the
  `NEXT_PUBLIC_*` again (some run server-side, e.g. `ROOT_DOMAIN` in
  `lib/store/host.ts`).
- **Runtime secrets** (Secret Manager): `DB_PASSWORD`, `FIREBASE_PRIVATE_KEY` (SA
  key, `\n`-escaped), `PAYMENT_CRED_KEY`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
  `RAZORPAY_WEBHOOK_SECRET`, `RESEND_API_KEY`, `CRON_SECRET`,
  `GOOGLE_SEARCH_CONSOLE_CREDENTIALS` (opt), `INDEXNOW_KEY` (opt).
- **No longer needed on Cloud Run**: `SUPABASE_SERVICE_ROLE_KEY` +
  `NEXT_PUBLIC_SUPABASE_*` (Supabase is out of the request path); `GEMINI_API_KEY`
  (→ Vertex via ADC); `GCP_SA_KEY` (→ default SA signs GCS video URLs via IAM).
  `VERCEL_URL` is Vercel-only.

## Steps

### 1. Enable APIs

```bash
gcloud services enable \
  run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
  secretmanager.googleapis.com cloudscheduler.googleapis.com \
  certificatemanager.googleapis.com compute.googleapis.com
```

### 2. Artifact Registry repo

```bash
gcloud artifacts repositories create storemink \
  --repository-format=docker --location=asia-south1
```

### 3. Runtime service account (this is what replaces the API keys)

```bash
gcloud iam service-accounts create storemink-run --display-name="StoreMink Cloud Run"
SA=storemink-run@storemink-prod.iam.gserviceaccount.com
for role in roles/aiplatform.user roles/speech.client roles/secretmanager.secretAccessor \
            roles/iam.serviceAccountTokenCreator roles/cloudsql.client; do
  gcloud projects add-iam-policy-binding storemink-prod \
    --member="serviceAccount:$SA" --role="$role"
done
# Storage: write to the media bucket + sign video URLs (tokenCreator above)
gcloud storage buckets add-iam-policy-binding gs://storemink-media \
  --member="serviceAccount:$SA" --role=roles/storage.objectAdmin
```

`aiplatform.user` → Vertex works with no API key. `speech.client` → Chirp 3
can make Speech-to-Text recognition requests. `objectAdmin` + `tokenCreator` →
GCS uploads AND signed video URLs work with no `GCP_SA_KEY`. `cloudsql.client`
→ open the `/cloudsql/<connection>` socket. (Firebase uses explicit
`FIREBASE_*` creds, so the runtime SA needs **no** Identity Platform role.)

### 4. Secrets → Secret Manager

```bash
# one per secret; repeat for each name in the "Runtime secrets" list
printf %s "$VALUE" | gcloud secrets create SUPABASE_SERVICE_ROLE_KEY --data-file=-
# accessor role already granted to the SA in step 3
```

### 5. Build & push the image (Cloud Build — amd64, no local Docker)

```bash
gcloud builds submit --config cloudbuild.yaml --substitutions=\
_NEXT_PUBLIC_FIREBASE_API_KEY=<key>,_NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<proj>.firebaseapp.com,\
_NEXT_PUBLIC_FIREBASE_PROJECT_ID=<proj>,_NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=<proj>.firebasestorage.app,\
_NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=<id>,_NEXT_PUBLIC_FIREBASE_APP_ID=<appid>,\
_NEXT_PUBLIC_ROOT_DOMAIN=storemink.com,_NEXT_PUBLIC_APP_URL=https://storemink.com
```

### 6. Deploy to Cloud Run

```bash
# <conn> = the prod Cloud SQL connection name, e.g. storemink-prod:asia-south1:<prod-instance>
# <auth-project> = the prod Identity Platform project (separate from storemink-prod)
gcloud run deploy storemink-web \
  --image=asia-south1-docker.pkg.dev/storemink-prod/storemink/web:latest \
  --region=asia-south1 --service-account=$SA \
  --allow-unauthenticated --port=8080 \
  --cpu=1 --memory=1Gi --min-instances=1 --max-instances=10 \
  --add-cloudsql-instances=<conn> \
  --set-env-vars=GCP_PROJECT_ID=storemink-prod,GCP_LOCATION=global,GCS_BUCKET=storemink-media,DB_HOST=/cloudsql/<conn>,DB_USER=app,DB_NAME=storemink,FIREBASE_PROJECT_ID=<auth-project>,FIREBASE_CLIENT_EMAIL=<sa>@<auth-project>.iam.gserviceaccount.com,FIREBASE_API_KEY=<web-key>,NEXT_PUBLIC_ROOT_DOMAIN=storemink.com,NEXT_PUBLIC_APP_URL=https://storemink.com,RESEND_FROM_DOMAIN=<domain> \
  --set-secrets=DB_PASSWORD=DB_PASSWORD:latest,FIREBASE_PRIVATE_KEY=FIREBASE_PRIVATE_KEY:latest,PAYMENT_CRED_KEY=PAYMENT_CRED_KEY:latest,RAZORPAY_KEY_ID=RAZORPAY_KEY_ID:latest,RAZORPAY_KEY_SECRET=RAZORPAY_KEY_SECRET:latest,RAZORPAY_WEBHOOK_SECRET=RAZORPAY_WEBHOOK_SECRET:latest,RESEND_API_KEY=RESEND_API_KEY:latest,CRON_SECRET=CRON_SECRET:latest
```

`--add-cloudsql-instances` mounts the `/cloudsql/<conn>` socket that `DB_HOST`
points at. `min-instances=1` avoids cold starts (Firebase session-cookie
verification runs per request in `proxy.ts`). Tune later.

⚠ **"Tune later" happened: prod runs `min-instances=0` since 2026-08-10.** The
warm instance cost ~₹700/month against a ~₹6,400/month bill, and the measured
cold start is ~1.2 s. Deploys are driven by `cloudbuild.yaml`, not this command,
so the live value is the `_MIN_INSTANCES` substitution on the Cloud Build trigger
— changing the service with `gcloud run services update` alone is reverted by the
next deploy. Both were changed together; see the cost note in
[`gcp-ci-cd.md`](gcp-ci-cd.md).

### 7. Smoke-test BEFORE DNS (the Host-header trick)

`proxy.ts` routes by Host, and a raw `*.run.app` host is treated as an unknown
custom domain. Cloud Run's frontend 404s a foreign `Host:` header, but `proxy.ts`
reads **`x-forwarded-host` first** — so spoof the tenant with that:

```bash
URL=$(gcloud run services describe storemink-web --region=asia-south1 --format='value(status.url)')
curl -sI -H "X-Forwarded-Host: storemink.com"          $URL/       # platform landing
curl -sI -H "X-Forwarded-Host: wholesip.storemink.com" $URL/shop   # a store storefront
```

Check Cloud Logging (Phase 2's structured logs now auto-ingest here) + Error Reporting for issues.

### 8. Wildcard domain `*.storemink.com` (the involved part)

Cloud Run domain mapping has **no wildcard support**, so front it with an
External Application Load Balancer + Certificate Manager wildcard cert:

1. **Certificate Manager**: a Google-managed cert for `storemink.com` **and**
   `*.storemink.com` via **DNS authorization** (add the CNAME it gives you).
2. **Serverless NEG** → the `storemink-web` Cloud Run service.
3. **Backend service** → NEG; **URL map** → backend; **target HTTPS proxy** (attach the cert); **global forwarding rule** on port 443 (reserve a static IP).
4. **HTTP redirect frontend** on the same static IP: a redirect-only URL map
   (`httpsRedirect: true`, `PERMANENT_REDIRECT`, `stripQuery: false`), target
   HTTP proxy, and `EXTERNAL_MANAGED` global forwarding rule on port 80. This
   preserves the host, path, and query while returning 308, so a bare address
   such as `pos.storemink.com` upgrades to HTTPS before it reaches Cloud Run.
5. **DNS**: point `storemink.com` and `*.storemink.com` A/AAAA at the LB IP.

Keep Vercel live throughout; flip DNS only when curl tests pass. **Rollback = revert DNS to Vercel.**

### 9. Cron jobs → Cloud Scheduler (replaces `vercel.json` crons)

Do this at cutover (don't double-run with Vercel crons). For each of
`send-emails`, `plan-expiry`, `expire-pending-payments`:

```bash
gcloud scheduler jobs create http cron-send-emails \
  --location=asia-south1 --schedule="0 3 * * *" \
  --uri="https://storemink.com/api/cron/send-emails" \
  --http-method=GET \
  --headers="Authorization=Bearer <CRON_SECRET>"
```

Then delete the `crons` block from `vercel.json`. (Consider OIDC auth instead of
the bearer secret once stable.)

## Notes carried forward

- **Middleware runs in Node** (standalone), not an edge runtime — `firebase-admin`
  verifies the session cookie directly in `proxy.ts` (no edge/`jose` workaround).
- Cloud Run filesystem is read-only except `/tmp`; the app only writes to object
  storage, so this is fine.
- Cloud SQL connects over the built-in connector: `--add-cloudsql-instances=<conn>`
  mounts `/cloudsql/<conn>` and the app's `pg` Pool dials that socket via `DB_HOST`
  (no VPC needed). Phase 2 logging/Error Reporting is fully live once on Cloud Run.
