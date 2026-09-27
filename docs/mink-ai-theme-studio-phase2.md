# Mink AI Theme Studio — Phase 2 Studio shell and secure intake

> **Status:** Implemented 2026-09-23. Operator-only. No merchant, staff or
> shopper flow changes, so there is **no Help Centre migration**. No model is
> called: this phase ships an offline test provider so the durable pipeline can
> be exercised before Phase 3 wires in Gemini on Vertex AI.

## 1. What an operator can do now

At `storemink.com/dashboard/themes` a superadmin gets an **AI Theme Studio**
action. Studio has three screens:

| Route                                  | Purpose                                                       |
| -------------------------------------- | ------------------------------------------------------------- |
| `/dashboard/themes/studio`             | Project list: status, active run, versions, model, creator    |
| `/dashboard/themes/studio/new`         | Intake: name, permanent theme id, brief, vocabularies, model  |
| `/dashboard/themes/studio/[projectId]` | Workspace: brief, references, runs, versions and activity log |

The workflow is: create a draft project, add up to ten reference screenshots,
then **Queue generation**. Queuing snapshots the brief and every current
reference into an immutable message and queues one run against it. The run
produces an immutable version, or fails with a safe error code. A failed or
cancelled run can be retried. A queued run cancels immediately; a running run
records a cancellation request that is honoured when it next settles. A project
can be archived when nothing is running.

**Exit criterion met:** an operator can create a project and queue a fake
provider run; a platform member, a signed-out browser or a forged direct
request can neither read nor mutate it.

## 2. Authorization

`lib/theme-studio/access.ts` `getThemeStudioActor()` is the one check. It reads
the verified session email, looks up `platform_admins`, and admits **only a
superadmin**, returning the row's uuid id. It fails closed on a read error.

- Every page calls `requireOperator()` (layout redirects do not abort a
  concurrently rendering page) and then `getThemeStudioActor()`. A member sees a
  "limited to superadmins" notice and no project data.
- Every server action in `app/actions/theme-studio-actions.ts` re-derives the
  actor before any repository call. `theme-studio-actions.test.ts` asserts each
  one refuses a non-superadmin without touching data, and was mutation-checked.
- Both route handlers under `app/api/platform/theme-studio/` gate themselves
  (`/api` is outside `proxy.ts`). The read route answers **404** to a
  non-superadmin rather than confirming an asset exists.
- No caller can supply an actor id, a provider model id, a file path or a
  run's inputs. The browser sends a project/run id, a model **key**, a revision
  number and an idempotency key.

## 3. References are private, sanitized and never published

The media GCS bucket is public (`allUsers:objectViewer`, uniform access), so
the plan's "private GCS prefix" does not exist in it. References are therefore
stored as bytes in the service-only `theme_studio_assets` table — the same
decision `data_job_payloads` made for CSV imports. Provisioning a private bucket
can replace this later without changing the contract.

`lib/theme-studio/references.ts` `sanitizeReferenceImage`:

- decides the format from **magic bytes** (JPEG, PNG, WebP, AVIF), never from
  Content-Type or a filename, then requires the decoder to agree;
- refuses SVG/HTML, animated images (including AVIF image sequences), empty and
  over-10 MiB input, and anything over 40 million pixels;
- decodes and **re-encodes to WebP** capped at 2048 px, which strips EXIF/GPS
  and any trailing payload. The original bytes are never stored;
- fails closed when the image processor is unavailable.

The upload route takes the raw image as the request body (a server action's
6 MB cap is below the 10 MiB limit), checks same-origin, rate-limits per
operator (30/minute), and reads the stream with a hard byte cap. Per project:
at most 10 references and 40 MiB of original uploads; an identical image is
deduplicated by SHA-256.

The read route serves the WebP with `private, no-store`, `nosniff`, a
`default-src 'none'; sandbox` CSP, `same-origin` resource policy and
`noindex`. There is no public URL for a reference.

A reference cited by a submitted message is kept with that history and can no
longer be removed. References can change only while no run is active.

## 4. Persistence — migration `20260923_0128_theme_studio_intake`

Six service-only tables, RLS enabled, no `app_user` privilege:

| Table                   | Holds                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| `theme_studio_projects` | identity, lifecycle status, editable draft brief, model key, revision |
| `theme_studio_assets`   | sanitized reference bytes, dimensions, SHA-256, original type/size    |
| `theme_studio_messages` | the submitted brief and the exact reference ids it cited — immutable  |
| `theme_studio_runs`     | provider, model key, lease, attempts, cancel request, safe error code |
| `theme_studio_versions` | parent-linked intent (and later package) with digests — append-only   |
| `theme_studio_events`   | who did what, ids/counts/digests/codes only — append-only             |

Database-enforced, not merely application-checked:

- the Phase 0 project state machine (a trigger mirrors
  `canTransitionThemeStudioProject`), and immutable project identity;
- one active (queued/running) run per project, by a partial unique index;
- a lease exists exactly while a run is running; a terminal run has a finish
  time; a failed run has a closed-vocabulary `error_code`;
- one version per run, unique version numbers, and a project's current version
  must belong to that project (composite foreign keys);
- messages and assets cannot be edited; versions and events cannot be edited or
  deleted;
- one active project per theme id, so an archived project releases its id.

27 adversarial inserts and updates were run against a real PostgreSQL before
the code was written; every one behaved as intended.

## 5. Queue, worker and limits

`lib/theme-studio/repository.ts` owns every write, under row locks and
per-operator advisory locks. It is not a `"use server"` file. Idempotency keys
make a double-submitted queue or retry return the same run; a stale revision is
refused. Creating a project refuses an id that belongs to a bundled theme, a
runtime release or catalog entry, or another active project. Limits from
`THEME_STUDIO_LIMITS` are enforced at intake: 20 new projects per operator per
day and 2 concurrent runs per operator.

`lib/theme-studio/worker.ts` claims runs with `FOR UPDATE SKIP LOCKED` and a
20-minute lease (the Phase 0 wall-time ceiling), executes outside any
transaction, and records the outcome only while it still holds the lease. An
expired lease with attempts left is reclaimed; one out of attempts is failed as
`lease_expired`; one whose cancellation was requested is cancelled **without
being re-executed**, so a Phase 3 provider call is never paid for only to be
thrown away. Up to three attempts (one plus two provider retries).

The worker runs in-process after a queue/retry (`after()`), and the existing
per-minute `/api/cron/mink-workflows` heartbeat runs it as an isolated backstop:
a Studio failure is logged and never fails merchant Mink workflows. Both paths
run offline-provider runs only; Phase 3 model runs need a dedicated worker job
(`docs/mink-ai-theme-studio-phase3.md` §6).

Logs carry run id, provider, model key, attempt and outcome — never the brief,
a reference, or provider output.

## 6. The test provider

`lib/theme-studio/fake-provider.ts` builds a deterministic Stage A
`ThemeIntent` from the project's vocabularies and the brief, and passes it
through the real `validateThemeIntent`. It makes no network call and does not
read reference pixels. Its first assumption states that no model was called, and
the Studio UI labels runs and versions accordingly.

A brief containing `[[fake:invalid_output]]` makes the test provider return
invalid output, so the failure and retry paths can be drilled on staging.

## 7. Configuration

| Variable                          | Default | Effect                                                    |
| --------------------------------- | ------- | --------------------------------------------------------- |
| `THEME_STUDIO_PROVIDER`           | `fake`  | Provider for new runs. `vertex-gemini` arrives in Phase 3 |
| `THEME_STUDIO_GENERATION_ENABLED` | on      | `false` is the Studio emergency stop for new runs         |

Both are independent of merchant Mink's `MINK_AI_ENABLED`. With generation off,
projects and references still work and cancel/archive still work.

## 8. Verification

- Unit tests: sanitizer against real sharp (formats, EXIF stripping, resize,
  SVG/HTML, forged headers, animated WebP, AVIF sequences, size, processor
  failure); fake provider; config; actor gate; intake validation; every action's
  gate; both routes; the heartbeat pass and its isolation.
- End to end against the local PostgreSQL: create, duplicate-id refusals,
  reference dedupe and bytea round trip, stale revision, a **concurrent
  double-submit producing exactly one run**, reference locking, worker success
  with exactly one version, no-op re-run, audit trail, invalid output → failed →
  linked retry, immediate cancel, the two-run concurrency cap, archive, lease
  reclaim, lease reaping, and cancel-during-run reaped without re-execution.
- Production build, typecheck, lint, migration lint, Help lint and the full test
  suite.

Not yet exercised: the rendered pages while signed in as a superadmin (the
signed-out redirect and both API refusals were checked in a browser), and a
deployed environment.

## 9. Deliberately left for later phases

- Real generation, prompts, repair loop, usage/cost telemetry and per-model
  health checks (Phase 3).
- Revision requests against an existing version, diffs and previews (Phase 4).
- Automated acceptance gates, approvals and publication (Phases 5–6).
- The retention sweep that deletes references 30 days after the last candidate
  and prompt text after archive (the Phase 0 retention table). Messages and
  assets allow DELETE for that reason; versions and events do not.
- Editing the draft brief after creation.
