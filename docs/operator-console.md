# Operator console — the StoreMink admin at `storemink.com/dashboard`

> The console an operator uses to run the platform, as opposed to the dashboard
> a merchant uses to run their store. Served on the platform host only
> (`proxy.ts` rewrites `/dashboard/*` → `/platform/dashboard/*`), gated on
> `platform_admins`.

## Why this exists

The console grew one panel at a time and they all landed on the **home page**:
the store table, the pricing editor and the theme seeder were stacked on a
single scroll, under a metric row. Three consequences, all of them real:

- **"Reprice the Pro plan" was one mis-click from "look at a store".** Those are
  not the same kind of act and should not share a screen.
- **A store had no page of its own.** Everything an operator knew about a
  merchant came from one table row plus a history drawer, so answering "why is
  this merchant complaining?" meant opening their dashboard as them, or writing
  SQL against production.
- **The page grew whenever the platform did.** Every new capability had one
  obvious home, and it was the bottom of `page.tsx`.

## The information architecture

| Group              | Entry          | Path                       | What it answers                         |
| ------------------ | -------------- | -------------------------- | --------------------------------------- |
| **OPERATIONS**     | Overview       | `/dashboard`               | What needs someone right now?           |
|                    | Stores         | `/dashboard/stores`        | The merchant estate                     |
|                    | ↳ store detail | `/dashboard/stores/[id]`   | Everything about ONE merchant           |
|                    | People         | `/dashboard/people`        | Who can sign in to which store          |
|                    | Announcements  | `/dashboard/announcements` | Tell merchants something _(phase 4)_    |
|                    | Logs           | `/dashboard/logs`          | What happened, what broke _(phase 3)_   |
|                    | Mink AI        | `/dashboard/mink`          | Are agent runs reliable and affordable? |
| **ADMINISTRATION** | Help Centre    | `/dashboard/help`          | Platform docs                           |
|                    | Themes         | `/dashboard/themes`        | The catalog + demo stores               |
|                    | ↳ Theme Studio | `/dashboard/themes/studio` | Draft new themes _(superadmin only)_    |
|                    | Pricing        | `/dashboard/pricing`       | What StoreMink charges                  |
|                    | Analytics      | `/dashboard/analytics`     | Platform Analytics availability         |
|                    | Operators      | `/dashboard/operators`     | Who runs the platform                   |
|                    | Billing & tax  | `/dashboard/billing`       | StoreMink's own GST identity            |

**The split is by job**, the rule `app/dashboard/lib/permissions.ts` already
applies to the merchant nav. Operations is what an operator watches and acts on
daily; Administration is configured once and left alone. **Logs is deliberately
in Operations** — it is the first place anyone looks when something is wrong,
not a setting.

## Rules this console follows

### ★ The gate lives where the read is

`requireOperator()` (`app/platform/dashboard/(console)/require-operator.ts`) is
called by **every page**, not just the layout. A Next layout and its pages
render **concurrently**: a layout `redirect()` does not abort a page already
fetching — the same property that forces every storefront page to call
`requireStorefrontStore()` for itself (CODEBASE §3). These pages read every
store on the platform under `withService`, which **bypasses RLS**, so the gate
is the whole of the access control.

**⚠ The home page does NOT use it.** `requireOperator` redirects a non-operator
to `/dashboard`, which _is_ the home page — a signed-in non-operator would loop
forever. Home keeps its own "not authorized" branch with a way out.

### ★ Reads live in `lib/platform/`, not `app/actions/`

Every export of a `"use server"` file is a publicly reachable endpoint.
`loadStoreDetail` / `loadStorePeople` / `getPlatformInsights` are reads called
by server components that have already resolved the viewer, so exporting them
as actions would add public endpoints returning cross-tenant data for no
benefit. Same resolution as `lib/domains/reconcile.ts` (§30) and
`lib/retention/prune.ts` (§32): **core in `lib/`, gate at the entry point.**

### ★ One round trip, not fifteen

A store detail wants ~15 counts. Issued separately that is 15 × the ~46 ms round
trip to Cloud SQL in Mumbai (`docs/local-dev-performance.md`) — most of a second
before React starts. They are scalar subqueries in one statement, the shape
`getPlatformOverview` already used.

### ★ Never a secret, only a state

Channel cards show `connected / paused / not connected`. Gateway, carrier and
SMS credentials are encrypted at rest and write-only by design (§18, §35, §37);
an operator console is not a reason to widen that. `loadStorePeople` likewise
never returns `pin_hash`, `invite_token` or `reset_token` — each is a live
credential, and none of them answers an operator's question.

### ★ Effective plan, never the stored one

The gates read `effectivePlan(store)`, so the console must too. A lapsed timed
grant is stored as `pro` and **is free today**; showing only the stored plan is
how a support conversation starts wrong. The store detail shows both when they
disagree, and the SQL predicates behind the overview's plan mix mirror
`effectivePlan` exactly — if this screen counted stored plans while the gates
read effective ones, the console would report revenue the product is not
delivering.

### ★ Zero is rendered, never hidden

The overview's **Needs attention** block is six queues, each of which is zero on
a good day and each of which stays on screen at zero, greyed out. A row that
disappears when clear teaches nobody what is being watched. Only a non-zero row
takes colour and becomes a link. This is §22's sidebar-badge rule — a hardcoded
"12" on Orders taught people to ignore the badges that moved.

### ★ A read failure says so

`getPlatformInsights` never throws; it returns `ok: false` and zeroes. This is
the screen someone opens when something is wrong, so a 500 is the worst
available behaviour — but **rendering zeroes as though they were the answer is
the second worst**, hence the banner.

### ★ Mink traces are useful without exposing conversations

`/dashboard/mink` reads cross-store run telemetry through
`lib/platform/mink-runs.ts` only after the page calls `requireOperator()`. It
shows status, store, model, tool names, steps, latency, retry count, token usage,
shadow credits/cost cohort, answer rating, redacted issue category and safe
error codes. It deliberately does **not** select or render prompts, answers,
tool arguments, tool results, provider state, thought signatures or model
reasoning. Free-form feedback is bounded and privacy-redacted before storage.
An operational inspector is not permission to read merchant conversations.

Unknown and interrupted usage is labelled `partial` or `unavailable`; a null
estimate is rendered as **Unknown**, never `$0`. Filters are URL-owned and the
table is capped at the 100 newest matching runs. The aggregate cards still use
the complete filtered interval, so narrowing by store, status or window changes
both the table and the operating picture. The cards also show the number of
currently invited stores and feedback totals, so support can correlate a poor
rating to a safe run ID without opening the merchant's conversation.

The same page has one superadmin-only global voice-model switch between Google
Chirp 3 and Sarvam Saaras v4. It writes the service-only
`mink_voice_settings` singleton, and every store's `/api/mink/voice` request
reads that row before transcription. There is no per-store override. A failed
settings read fails the request rather than silently using a different model.

The store detail screen owns one superadmin-only Mink control. **Enable Mink
AI** atomically enables the store, private drafting and all implemented action
capabilities; **Disable Mink AI** shuts those gates together. The actor is
recorded in the access rows. Staff permissions, credits, plan limits and each
exact human action approval still apply. This store switch is independent of
`MINK_AI_ENABLED`, which remains the deployment-wide emergency shutdown.

### ★ Theme Studio is superadmin data, not a superadmin write

`/dashboard/themes/studio` (`lib/theme-studio/`) is the one console area a
platform **member** cannot even read. Studio prompts, reference screenshots and
generated drafts are superadmin-only, so every page shows a member a notice
instead of data, and every action and route re-derives a superadmin actor from
the session (`getThemeStudioActor`) before touching anything. Reference images
are stored sanitized in Postgres and served only through a gated, no-store
route. Full record: `docs/mink-ai-theme-studio-phase2.md`.

Since Phase 3 a run can call a paid Gemini model on Vertex AI. Each run shows
its tokens and estimated cost, and a per-operator ceiling on estimated spend in
any 24 hours refuses new runs once reached. A model that asks for details
leaves the project **blocked** until the operator answers in the workspace.
Every image in a generated version is a marked placeholder, so a version is a
draft to review, never something to publish. Record:
`docs/mink-ai-theme-studio-phase3.md`.

Since Phase 4 each version has a **Preview**: a private store built from that
version and rendered by the live storefront, in laptop, iPad and mobile
frames, with a pop-out. It takes no orders, is hidden from search and from the
Stores list and overview counts, and is removed a day after it was last opened.
A version can be **revised** (revising an older one starts a branch),
**compared** with its parent or the current version, and **made current**
again. Record: `docs/mink-ai-theme-studio-phase4.md`.

Since Phase 5 each version has **Checks**: automated acceptance gates for the
current version. The server checks the package and the preview's rendered
pages; this browser then measures layout, accessibility and images at laptop,
iPad and mobile sizes. Passing makes the project a **candidate**. A quality
failure keeps it `ready`, a security failure blocks it, and a deploy makes a
candidate's evidence stale until the checks run again. Placeholder images
fail the checks until an operator replaces them under **Images**. Record:
`docs/mink-ai-theme-studio-phase5.md`.

Each version also has **Images**: every picture slot with its current image
and where it appears. An operator uploads an image per slot (cropped to the
slot's shape and compressed to storefront limits), says whether it is theirs
or licensed, and saves the staged images as one new version. Revisions keep
those images. Record: `docs/mink-ai-theme-studio-slot-images.md`.

A candidate has **Review and release** (Phase 6). Two superadmins score it on
the theme-acceptance scorecard — one for design, one for commerce — and at
least one of them must not have worked on the theme. Once both approve, a
superadmin approves it for publication and publishes it by typing its id.
Publishing:

1. copies its images to permanent public storage;
2. stores an immutable release;
3. seeds and renders its demo store;
4. only then adds it to the public catalog and signup.

A failed publication stays hidden and can be retried. Afterwards the same
screen hides it from new stores, shows it again, or restores an earlier
release. Each change is written to an audit, and a store that already
installed the theme keeps its exact version. Record:
`docs/mink-ai-theme-studio-phase6.md`.

## Phases

- **Phase 1 — IA, stores, themes, pricing ✅**
  New nav; `StoresConsole` moved to `/dashboard/stores`; store detail page
  (`lib/platform/store-detail.ts`); `ThemesPanel` → `/dashboard/themes` and
  `PricingPanel` → `/dashboard/pricing`, both superadmin-only; home rebuilt as a
  real overview (`lib/platform/overview.ts`) with a 12-week signup chart, plan
  mix, six attention queues and latest signups.
  The list's **History drawer was removed** rather than left alongside the
  detail page — two paths to the same data is the mess this revamp is undoing.
- **Phase 2 — People ✅**
  `/dashboard/people` (`lib/platform/people.ts`) unions `admins` and `pos_staff`
  across every store, searchable by name/email/store, filterable by access kind,
  and deep-linkable to one store (`?store=`) from the store detail page.
  - **★ `kind` IS NEVER COLLAPSED.** A dashboard login and a till PIN are
    different access with different reach; a flattened list would make revoking
    the wrong one look identical to revoking the right one.
  - **★ THE SAME PERSON MAY APPEAR TWICE, AND THAT IS CORRECT.** A shop owner
    who also rings the till has both rows — two credentials, revoked
    separately. Deduplicating by email would hide one.
  - **★ THE CHIP COUNTS IGNORE THE KIND FILTER.** Counted under the search and
    store filters alone, so selecting "Till" still reports how many dashboard
    admins the same search returns. Counting them under the full filter makes
    every unselected chip read zero, which is a dead end rather than a filter.
  - **★ `peopleHref` IS ONE TESTED BUILDER** (`lib/platform/people-links.ts`).
    A "next page" link that forgets `?q=` turns a filtered list into an
    unfiltered one that still looks filtered, and the only symptom is rows
    nobody asked for. Switching a chip resets paging for the mirror reason: a
    term matching four people has no page 4, and an empty screen reads as "no
    results".
- **Phase 3 — Logs hub ✅**
  Email logs, SMS logs and the cross-store failure feed behind one entry at
  `/dashboard/logs`, with 307s from the old `/dashboard/email-logs` and
  `/dashboard/failures`.
  - **★ `LogsRail` TAKES ITS REGISTRY AS A PROP.** Both consoles share
    `DashboardSidebar`, and their logs are NOT the same set — an operator has no
    import/export jobs and no per-store activity feed, a merchant has no
    cross-store failure view. Hardcoding `LOG_TYPES` would have put three rail
    entries in front of routes the platform does not have. It defaults to the
    merchant registry, so every existing call site is unchanged.
  - **★ A LANDING, NOT A REDIRECT TO THE FIRST LOG.** The merchant hub can
    default to its Activity feed; the platform has no cross-store equivalent, so
    "Logs" would silently mean "Email logs" and hide that the other two exist.
  - **★ `getSmsLogs` GAINED HOST-DERIVED SCOPE**, mirroring `getEmailLogs`. It
    used `getActingStoreId()`, whose never-null fallback resolves the WholeSip
    store — so on the operator console it would have served one merchant's SMS
    log as though it were the platform's. The platform scope re-checks operator
    membership inside the action, because a server action is an independently
    reachable POST endpoint.
  - **★ `log-types.test.ts` IS A DRIFT GUARD IN BOTH DIRECTIONS**: `fs.readdir`
    asserts every rail entry has a page, and every page has a rail entry. It
    also fails if the platform registry ever acquires the merchant-only keys —
    the guard against "tidying up" by pointing the platform sidebar at
    `LOG_TYPES`.
  - **⚠ The platform SMS log is EMPTY today**, and honestly so: nothing writes
    a `store_id IS NULL` row because there is no platform Twilio account. The
    page exists because adding it at the moment the first message goes out is
    how a send with no log ships.
- **Phase 4 — Announcements ✅**
  `/dashboard/announcements` — draft, check the reach, test-send, send, and a
  per-recipient log. Schema: `supabase/announcements_01_schema.sql` (⚠ **not
  applied** — run it as `postgres` before deploying).
  - **★ RECIPIENTS ARE MATERIALISED AT SEND, NOT RESOLVED AT DELIVERY.** The
    audience is a query over a moving target — stores sign up, staff leave,
    plans lapse. Writing a row per person makes the send idempotent (a retried
    worker claims rows rather than re-running a query that now returns
    different people), resumable across the 60s request ceiling, and
    **auditable**: "who was told, and when?" is answerable months later, which
    for a pricing or policy notice is the only thing that matters.
  - **★★ `category` DECIDES WHETHER CONSENT APPLIES, so it is a stored column
    and not a checkbox.** `feature` is marketing and honours
    `admins.marketing_opt_in`; `operational` is service correspondence about an
    account somebody already has and does not. Somebody has to be able to answer
    "why did this person get this after opting out?", and "it was a billing
    deadline" only holds if the category was recorded at the time.
  - **★ TILL STAFF ARE NEVER MARKETED TO.** `pos_staff` has no
    `marketing_opt_in` column — nobody ever asked them — and an absent
    preference is not consent. They still receive operational notices.
  - **★ EVERY SKIP CARRIES A REASON.** "38 skipped" tells an operator nothing
    about whether their audience is wrong or their list is dirty; "31 not opted
    in, 7 suppressed" does.
  - **★ THE PREVIEW RUNS THE SAME CODE AS THE SEND**, and the send button
    requires one — "send to everyone" should not be reachable without having
    looked at who everyone is. The confirm quotes the number back.
  - **★ THE TEST-SEND TAKES NO RECIPIENT.** It mails the session's own address.
    A recipient parameter would be an open relay: any operator could mail
    arbitrary HTML to any address from StoreMink's verified sending domain.
  - **★ EVERY MESSAGE LEAVES THROUGH `sendEmail`**, so it lands in `email_logs`
    under the `announcement` mailer and `send-coverage.test.ts` keeps it there.
    The worker rides `/api/cron/send-emails` rather than taking a new Cloud
    Scheduler entry — `docs/cron-jobs.md` records a documented-but-never-created
    job three times.
  - **★ A SENT ANNOUNCEMENT IS IMMUTABLE**, enforced as a predicate on the
    UPDATE rather than a read-then-write. Editing copy already in inboxes makes
    the log a record of what we currently _say_ we sent.
  - **★ `partial` IS A REAL OUTCOME.** Some bounced and the rest were told;
    calling that "failed" invites an operator to send the whole thing again.
  - **⚠ SMS is built and gated** — see below. Sending refuses with its reason
    and writes no recipient rows.
- **Phase 5 — Mink AI run and cost inspector ✅**
  `/dashboard/mink` adds a redacted, read-only view of the last 1, 7 or 30 days
  of agent runs. Summary cards expose success rate, p95 latency, retries,
  tokens, known provider cost, shadow credits/cohorts, feedback,
  unknown/partial cost and timeouts; the run table exposes only safe trace
  metadata and distinct tool names. Store detail pages also control invited
  beta membership. The pricing schedule is stored on each usage row so a future
  model price change does not rewrite historical estimates.

## ⚠ Announcement SMS cannot send yet, and that is not a code problem

Decided 2026-08-15. Building it gated rather than omitting it, so the audience,
composer and log are designed for two channels from the start.

### ⚠ "But signup already sends an SMS OTP"

It does, and it is not a counterexample. That message comes from
`PhoneAuthProvider.verifyPhoneNumber` (§19) — the **Firebase Web SDK, in the
browser**. Google sends it from its own infrastructure, on its own carrier
relationships and its own DLT registration; the "StoreMink" in the body is the
Firebase project's display name inside Google's fixed template.

Three consequences worth knowing:

- **No StoreMink code is in that path.** It never touches `lib/sms/`, so it
  leaves no row in `sms_logs` and appears in no operator log.
- **It cannot carry your own copy.** It is a fixed-purpose verification API:
  the only variable is a Google-generated code.
- **It is transactional auth**, a different regulatory category from a
  promotional announcement regardless of who sends it.

So StoreMink genuinely has no sender of its own for arbitrary SMS.

### The three blockers

Three things are missing, and only the first is ours:

1. **StoreMink has no Twilio account of its own.** SMS is BYO-per-store (§37) —
   `store_sms_providers` holds a merchant's credentials, and there is no
   platform-level equivalent. Sending _to_ merchants needs one.
2. **DLT registration.** Every commercial SMS to an Indian number needs a
   registered Principal Entity, a 6-character sender header, and an **approved
   template per message body**. A body that does not match is dropped at the
   carrier — silently, with no bounce. 7–21 business days.
3. **A feature announcement is PROMOTIONAL, not transactional.** That is a
   different and heavier compliance surface than the transactional templates
   §37 already models: numeric sender headers, DND/NDNC scrubbing, and time-of-day
   restrictions.

Until all three exist, the SMS channel must **refuse with a stated reason**
rather than queue messages every carrier will drop. This is `available: false`
in `lib/notifications/channels.ts` applied one level up, and §23's rule that a
control which always fails is worse than no control.

## Testing

There is no cross-browser or authenticated-console E2E infrastructure (CODEBASE
§2), and the console sits behind an email-OTP login. What is checked:

- **Typecheck, lint, build and the full vitest suite**, all green.
- **Column audit**: every table and column named in the raw SQL of
  `lib/platform/*.ts` verified against `drizzle/schema.ts`, which is introspected
  from the live database and is therefore authoritative on names.
- **⚠ The SQL has not been executed.** The local Cloud SQL Auth Proxy resets
  every connection when its ADC token has expired (§6), which is the state this
  was written in. **Run `gcloud auth application-default login`, restart
  `npm run db:proxy`, then load `/dashboard` and one store detail before
  merging** — a raw-SQL mistake that typecheck cannot see would surface exactly
  as the empty/`ok: false` state, which is also what a dead proxy looks like.
