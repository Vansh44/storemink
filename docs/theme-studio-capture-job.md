# Theme Studio capture job (Track 3.6)

> **Deployment status (2026-09-29):** deployed and scheduled in dev and
> production. `storemink-theme-studio-capture-dev` targets
> `https://dev.storemink.com`; `storemink-theme-studio-capture` targets
> `https://storemink.com`. Both schedules run every five minutes, both web
> services have capture and automatic QA enabled, and empty-queue executions
> completed successfully after migration `20260927_0144` was applied.

Publication needs a theme's catalog card and two screenshots, and an image
model cannot draw them: they are pictures of the storefront itself. The
capture job opens a version's private preview store in headless Chromium,
photographs its home page at the card, desktop and phone sizes, and posts the
pictures back to the web app, which saves them as a new version.

An operator can start a capture from a version's **Images** page ("Capture
catalog pictures"). Track 5 also queues the same job automatically after its
hidden image-generation step. In either case, this job does the browser work.

The button and server action remain fail-closed until the web service has
`THEME_STUDIO_CAPTURE_ENABLED=true`. Deploy the job and scheduler first, then
set the corresponding `_THEME_STUDIO_CAPTURE_ENABLED` Cloud Build substitution
to `true` for that environment and deploy the web service. Never enable the
flag while either worker component is absent.

Automatic pre-review is a second, stricter gate. Set
`THEME_STUDIO_AUTO_QA_ENABLED=true` (Cloud Build substitution
`_THEME_STUDIO_AUTO_QA_ENABLED`) only after capture is enabled and the long
Theme Studio model worker is deployed. The runtime treats auto QA as disabled
unless capture is enabled too.

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
- A manual capture holds the current version. An automatic capture is bound to
  an internal version and keeps the project generating until visual QA settles.
- A reported error is retried once (with a fresh browser after browser failure); a lease that
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
  --service-account storemink-run@storemink-prod.iam.gserviceaccount.com \
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

For an automatic claim the same execution also visits every available home,
shop, product, cart, content and not-found surface at 360, 390, 768, 1024 and
1440 px. It returns raw layout/accessibility/performance measurements and a
compressed full-page screenshot for each pair. The web app validates and
stores that evidence; the browser job never decides pass or fail.

The expected response is 200 except for the deliberate `not_found` surface,
which must return 404. The job waits up to 20 seconds for the hydrated QA
probe and 45 seconds per measurement. The probe handles SVG icons without
calling HTML-only text APIs. It waits for fonts/images itself, so automatic
QA does not also pay a 15-second network-idle wait on every sample.

Capture work is bounded to seven minutes or the execution's remaining budget,
with a minute reserved for result reporting. Claim/finish HTTP calls each have
60-second timeouts. No new claim starts in the last two minutes of the default
eight-minute budget. Browser launch failures are reported against the lease;
failed/timed-out browsers are closed before a subsequent capture. A rejected
finish request fails the execution so it is visible in job monitoring; the
existing lease expiry/retry path recovers it.

**Deploy the capture image separately from the web service.** Web-only deploys
do not update this job's 404/readiness/timeout behavior. Regression evidence and
the Crave/Luxe incident are in `docs/theme-studio-reliability.md`.

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
- Automatic runs additionally write `theme_studio_visual_qa_runs` and events
  `auto_qa_browser_finished`, then `auto_qa_passed`,
  `auto_qa_revision_queued` or `auto_qa_failed`.
