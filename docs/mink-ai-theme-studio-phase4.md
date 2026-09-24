# Mink AI Theme Studio — Phase 4 preview and iterative revision

> **Status:** Implemented 2026-09-24. Operator-only: no merchant, staff or
> shopper flow changes, so there is **no Help Centre migration**. Revisions run
> on the same providers as generation — the offline provider by default, and
> Gemini only where Phase 3's rollout steps have been completed.

## 1. What changes for an operator

A project with a version now supports the whole review loop in the Studio:

- **Preview.** Every version with a theme has a _Preview_ page. It opens a
  private store built from that version and rendered by the live storefront,
  in a laptop (1440×900), iPad (768×1024) or mobile (390×844) frame, scaled
  to fit. The page strip covers Home, Shop, a product page, Cart, the first
  content page and the "not found" page, and links inside the store work as
  they would in a live shop. _Open full page_ pops the preview out into its
  own tab.
- **Revise.** "Revise version N" takes a description of what to change. It
  creates a new version and leaves the one it revised untouched. Revising a
  version that is not the current one **starts a branch**: the new version's
  parent is the version you revised.
- **Answer questions inside a revision.** If a revision asks for details, the
  answer continues that same revision. It does not start a fresh generation.
- **Changes / vs current.** A compare page lists what moved between two
  versions: design tokens with before and after values (colour swatches
  included), pages added, removed or changed with their section order, sample
  catalogue and navigation changes, and capability gaps added or cleared.
- **Make current.** Any earlier version can be made current again. Nothing
  is copied or deleted, so the version you move away from stays one click away.

A preview takes no orders, is hidden from search, and is removed a day after
it was last opened. Each project keeps at most three open previews; opening a
fourth closes the one used least recently.

## 2. Revisions

`reviseThemeStudioVersion` is bound to three things, and a mismatch on any of
them refuses the request with nothing written:

- the project `revision` the browser last saw (optimistic lock);
- the target version, which must belong to the project and have a package;
- the target's **package digest as shown on screen**. Versions are immutable,
  so this only fails when the browser is looking at a different version from
  the one on the server — the case where an operator would be revising
  something they have not seen.

The run is `kind = 'revise'` and records `base_version_id`,
`base_package_digest` and `context_message_ids`: the ordered list of messages
it reads, which is the revision request followed by any answers. So two
branches from the same version never read each other's text. The worker
re-reads the base version, **recomputes** its digest, and re-validates its
intent and package before calling a model. If any of those fails, the run
fails with `base_missing`, `base_changed` or `base_invalid`.

In the pipeline:

- **Stage A** receives the base intent as trusted, validated data, and the
  request in an `<operator_revision>` block. It returns the complete revised
  intent rather than a list of changes.
- **Stage B** additionally receives the base theme's tokens, pages, navigation
  and catalogue in a `<current_theme>` block, and is told to keep whatever the
  revised intent does not change.
- Provenance, the asset manifest and release metadata are never sent. The
  server still owns them.
- Both new blocks are covered by the untrusted-data rule in the system
  prompts, which is why the prompt version moved to `theme-studio-v2`.

Other behaviour:

- **Retry.** Retrying a failed revision revises the same version with the same
  messages.
- **Restore.** `restoreThemeStudioVersion` only moves `current_version_id`,
  and only from `ready` or `blocked`. From `blocked` it sets any pending
  questions aside.

## 3. Previews

### 3.1 A real store, marked two ways

`openThemeStudioPreview` materializes one store per version:

- **Slug:** `studio-preview-<12 hex>`. The prefix is reserved at signup.
- **Settings:** `settings.demo = true` and
  `settings.studioPreview = {projectId, versionId}`.
- **Seeding:** pages, navigation and a **published** sample catalogue are
  seeded by `applyThemeDefinition`, the same code signup and demo stores use,
  which `applyTheme` now delegates to.
- **Design:** read at render time from the version row.
  `readThemeSelection` carries `studioVersionId` only when both markers are
  present. For such a selection, `resolveInstalled` loads that exact version,
  checks its digest, validates it, and **never falls back** to a release or a
  bundled theme.

`demo: true` already makes checkout refuse an order before any write, keeps
the store noindex and out of sitemaps and search reconciliation, and admits
applyTheme's reset. `studioPreview` adds the one thing a demo store lacks: a
gate. Preview stores are also excluded from the operator store list and from
the overview counts, so they are never reported as signups.

### 3.2 The gate

A preview store is an ordinary active store row, so without a gate the host
lookup would serve it to anyone who learned its address. The gate sits in the
store resolver (`getCurrentStoreOrNull`), after the cached host lookup, and is
imported dynamically so other stores pay only for the marker check. That
resolver is how every storefront page, action and route finds its store, so a
refused request sees exactly what an unclaimed subdomain shows: a 404 page,
and actions fall back as they do for any unknown host.

A request is admitted only when all of these hold:

1. It carries a `sm_studio_preview` grant cookie, HMAC-signed for **this
   store and this version**, and unexpired (one hour).
2. The superadmin who minted the grant is **still** a superadmin. This is
   re-read from `platform_admins` on every request, so revoking someone ends
   their access at once.
3. Wherever the session cookie is shared with the preview host (every
   `*.storemink.com` environment), the session belongs to that same
   superadmin.

⚠ **Condition 3 cannot hold in local development.** A `localhost` session
is host-only and never reaches `studio-preview-….localhost`, so there the
grant plus condition 2 is the whole gate. This is a deliberate, stated
relaxation of the plan's "token plus an active superadmin session".

### 3.3 Tokens

`lib/theme-studio/preview-token.ts` has two token types from one signer:

- **Entry token** (10 minutes). Minted by the superadmin-gated preview
  action on the platform host.
- **Grant** (one hour). What `/api/theme-studio/preview/enter` exchanges the
  entry token for, on the preview host.

The enter route re-proves everything:

- the token's signature and expiry;
- that the token names this host's store and that store's current version;
- the actor, using conditions 2 and 3 above.

It sets a host-only, httpOnly cookie and redirects with a **relative**
`Location`. Behind a proxy, `nextUrl.origin` is the server's own address, not
the preview's; the first version redirected to the platform host for exactly
that reason. A protocol-relative or backslash path falls back to `/`.

The signing key is `THEME_STUDIO_PREVIEW_SECRET` when set. Otherwise it is
derived from `CRON_SECRET` with a purpose label, so a preview token can never
be replayed against anything `CRON_SECRET` protects.

**Framing.** The Studio shows the preview in an iframe:

- Where the platform and the preview are the same site (every
  `*.storemink.com` environment), an ordinary cookie works in the frame.
- Where they are not (for example `localhost` and a store subdomain of it),
  only a cookie marked `Partitioned; SameSite=None; Secure` survives. A
  request with `Sec-Fetch-Dest: iframe` gets that kind; a top-level visit
  (the pop-out) gets an ordinary `Lax` cookie.
- The frame also navigates through the enter route with a fresh entry token
  on every page switch, so a frame load does not depend on a cookie a browser
  may refuse.

### 3.4 Images

`theme-asset://<slot>` is rewritten to `/api/theme-studio/placeholders/<id>`
before seeding. That route is **public**, because next/image's optimizer
fetches local images without the viewer's cookies, so a gated route would
break every picture. A placeholder is a solid-colour WebP the server drew
itself, holding no operator text, reference pixels or model output. The
lookup is restricted to `purpose = 'placeholder'`, and the reference route
now filters to `purpose = 'reference'`, so a reference id finds nothing on
the public route. A slot with no stored image becomes `""`, which every image
field accepts, rather than a URL that 404s inside the page.

### 3.5 Retention

- **Removal.** Deleting a preview store cascades everything it seeded,
  including its `theme_studio_previews` row. The DELETE's WHERE requires both
  markers, so it cannot remove a real store whatever id it is given.
- **The sweep.** `sweepThemeStudioPreviews` runs on the existing per-minute
  `/api/cron/mink-workflows` heartbeat, isolated like the Studio worker pass,
  so no new Scheduler job is needed. It removes up to ten previews per pass:
  previews idle past 24 hours, materializations abandoned for more than 15
  minutes, and every preview of an archived project.
- **Archiving.** Archiving a project also discards its previews after the
  response.
- **Limits.** 3 previews per project, evicting the least recently opened, and
  50 across the platform.

## 4. Schema — migration `20260924_0130_theme_studio_preview_revision`

Additive only:

- **Runs:** adds `base_version_id` (FK to the version in the same project),
  `base_package_digest` and `context_message_ids`. One CHECK ties them to
  `kind = 'revise'` and bounds the list at 20. Every operand is NOT NULL or
  tested with IS NULL, so the CHECK cannot pass by evaluating to NULL.
- **Previews:** a new `theme_studio_previews` table: one row per version,
  one per store, `store_id` ON DELETE CASCADE, with status and expiry. It is
  service-only with RLS on.
- **Events:** the vocabulary gains `revision_requested`, `version_restored`,
  `preview_created`, `preview_failed` and `preview_expired`.

The previous revision writes only `generate` runs, so nothing it writes is
refused during a rollout.

## 5. Fixed in passing

`applyTheme`'s product upsert wrote `status: "published"` unconditionally on
conflict. Re-applying a theme to a merchant store would therefore have put its
draft sample products live. The conflict branch now follows
`publishSampleProducts` exactly as the insert does. This is pinned by a test.

## 6. Verified, and not

**Verified:**

- An end-to-end run against the local database covered generate, revise,
  a stale-digest refusal, a branch from an older version, restore, a
  clarification inside a revision continuing that revision, preview
  materialization, asset rewriting, version-exact design resolution,
  placeholder-versus-reference serving, reopen reuse, three-per-project
  eviction, expiry sweep and archive.
- In a browser on the preview host:
  - no grant gives a 404;
  - entering renders the themed storefront with placeholder images loaded
    through next/image;
  - the product and not-found pages render.
- With curl:
  - a framed entry sets `Partitioned; SameSite=None; Secure`;
  - a forged token gives 403;
  - a `//evil.example` path is refused;
  - no cookie gives a 404.

**Not verified:**

- The Studio's own preview, compare and revise screens in a browser. They
  are behind a superadmin login, which was not entered.
- That a browser accepts the partitioned cookie inside a cross-site
  `localhost` frame. The pane cannot screenshot a cross-origin frame.
- A revision against a live model.

The pop-out works either way, because it is a top-level visit.
