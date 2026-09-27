# Theme Studio capture job (Track 3.6)

Publication needs a theme's catalog card and two screenshots, and an image
model cannot draw them: they are pictures of the storefront itself. The
capture job opens a version's private preview store in headless Chromium,
photographs its home page at the card, desktop and phone sizes, and posts the
pictures back to the web app, which saves them as a new version.

An operator starts a capture from a version's **Images** page ("Capture
catalog pictures"). That only queues it. This job does the work.

## How it fits together

```
operator ── queue ──▶ web app (theme_studio_captures, project → generating)
                         ▲            │
            claim / finish (CRON_SECRET, /api/internal/theme-studio/captures)
                         │            ▼
                 capture job (Cloud Run job, headless Chromium)
                         │
                         └── opens https://studio-preview-….<domain>/ with a
                             capture cookie good only while THAT capture runs
```

- The web app owns every decision: which capture runs next, the preview store,
  the shots and sizes, and whether the pictures are usable. The job knows only
  a capture id, a lease token, an origin, a cookie and the shots to take.
- The capture cookie (`sm_studio_capture`) is signed like the preview grant
  and accepted by the preview gate only while its capture is `running` with an
  unexpired lease, for exactly that version (`lib/theme-studio/preview-access.ts`).
- A capture holds the project like a run: one at a time, and it refuses to
  finish if another version became current meanwhile.
- A reported error is retried once (a cold preview can time out); a lease that
  lapses is claimed again, up to two attempts; after that the capture fails and
  the project returns to `ready`.

## Build

The image is Node 24 with Debian's Chromium and the Noto fonts
(`jobs/theme-studio-capture/Dockerfile`). Build from its own folder:

```bash
gcloud builds submit jobs/theme-studio-capture \
  --project storemink-prod \
  --tag asia-south1-docker.pkg.dev/storemink-prod/storemink/theme-studio-capture:latest
```

## Deploy the job

```bash
gcloud run jobs deploy storemink-theme-studio-capture \
  --project storemink-prod --region asia-south1 \
  --image asia-south1-docker.pkg.dev/storemink-prod/storemink/theme-studio-capture:latest \
  --memory 2Gi --cpu 2 --task-timeout 600 --max-retries 0 \
  --set-env-vars APP_ORIGIN=https://storemink.com \
  --set-secrets CRON_SECRET=CRON_SECRET:latest
```

- `APP_ORIGIN` is the web app the job claims from; the preview origin comes
  back in each claim, so the job needs no other address. For the dev
  environment, point it at the dev service's origin and dev's `CRON_SECRET`.
- `--max-retries 0`: a failed execution is simply the next scheduled one.
- 2 GiB: Chromium rendering a 3× phone page needs more than the default.

## Schedule it

```bash
gcloud scheduler jobs create http storemink-theme-studio-capture \
  --project storemink-prod --location asia-south1 \
  --schedule "*/5 * * * *" --time-zone Etc/UTC \
  --uri "https://asia-south1-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/storemink-prod/jobs/storemink-theme-studio-capture:run" \
  --http-method POST \
  --oauth-service-account-email <scheduler-invoker>@storemink-prod.iam.gserviceaccount.com
```

The invoker needs `roles/run.invoker` on the job. An execution with nothing
queued exits in a few seconds.

## Run it locally

With the dev server running on port 3000 and the local database:

```bash
cd jobs/theme-studio-capture && npm install && cd ../..
```

```bash
APP_ORIGIN=http://localhost:3000 CAPTURE_CHROME_CHANNEL=chrome CRON_SECRET=<from .env> npm run theme-studio:capture
```

`CAPTURE_CHROME_CHANNEL=chrome` drives the machine's installed Chrome, so no
browser download is needed. Local captures hide Next's development badge.

## Checking it worked

- The version's Images page shows the capture and links to the version it made.
- The project's events include `capture_requested` then `capture_succeeded`
  (or `capture_failed` with a code; the Images page words each one).
- `theme_studio_captures` holds the record; a finished row cannot change.
