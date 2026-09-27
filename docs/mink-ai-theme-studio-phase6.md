# Mink AI Theme Studio — Phase 6 approval, publication and rollback

Phase 6 turns a candidate into a theme merchants can install:

1. two people review it against the release scorecard;
2. a superadmin approves it;
3. publishing stores an immutable release, then seeds and checks its demo
   store, then exposes it in the catalog and signup;
4. hide, show and restore change what **new** stores can pick. A store that
   already installed the theme keeps its exact version.

It is operator-only: nothing a merchant, their staff or a shopper does
changes, so there is no Help Centre migration. A published theme simply
appears in the existing catalog and signup picker, which are already
documented. Plan: `docs/mink-ai-theme-studio-plan.md` §3.4, §7.3, §8 and §10.

## 1. What changes for an operator

A candidate, approved or published project has a **Review and release** link
in its Versions section. The screen is `…/studio/[projectId]/release` and has
five parts:

- **Evidence.** The passing acceptance run the reviews bind to. It also lists
  anything that would stop publication: a placeholder image, or a finding
  from the production theme validator.
- **Reviews.** The scorecards given on the current evidence, with each
  reviewer marked as _author_ or _independent_. Reviews of older evidence
  are collapsed underneath.
- **Add your review.** Choose a chair: _Product / design_ or _Commerce / QA_.
  Then score the eight rows 1–5, tick any automatic-rejection condition, and
  either approve or reject.
  - Approve is disabled until the scores clear the bar.
  - Reject needs a note of 10+ characters saying what must change.
  - A review is final once saved.
- **Approve.** Enabled when both chairs approved the same evidence, at least
  one of the two reviewers did not author the theme, nobody rejected, and
  nothing blocks publication.
- **Publish.** Type the theme id to confirm, then publish. If anything fails,
  the reasons are listed, nothing becomes public, and **Publish** can be
  pressed again.
- **Catalog.** After publication: hide from new installs or show again, and
  restore an earlier published release when there is more than one. Every
  change needs a reason and is written to the catalog audit, which is listed
  here with the publication attempts.

## 2. The scorecard (theme-acceptance §5)

| Rule                       | Where it is enforced                                                         |
| -------------------------- | ---------------------------------------------------------------------------- |
| Eight rows, each 1–5       | `validateScorecard`; a CHECK on the row                                      |
| Approve: every row ≥ 4     | `scorecardClearsBar`; CHECK `theme_studio_reviews_approve_bar_check`         |
| Approve: average ≥ 4.2     | a total ≥ 34 over eight whole-number rows; the same CHECK                    |
| Approve: no rejection      | the six §5 conditions; the same CHECK                                        |
| Reject: says why           | a note of 10+ characters; CHECK `…_reject_reason_check`                      |
| One review per chair       | UNIQUE `(acceptance_run_id, reviewer_role)`                                  |
| One chair per person       | UNIQUE `(acceptance_run_id, created_by_email)`                               |
| One reviewer not an author | `approvalReadiness`; the project guard on entering `approved`                |
| Reviews bind to evidence   | BEFORE INSERT trigger: a PASSED run over this version's exact package digest |
| Reviews are final          | `theme_studio_forbid_mutation`: no edit, no delete                           |

★ **The scores are columns, not jsonb, so the bar is a CHECK on the row.** A
client cannot store an approving verdict over failing scores, however the
request is built.

★ **Authors are derived from the project's history**, never from the browser.
An author is anyone who created the project, queued a run, answered a
clarifying question, asked for a revision or replaced images
(`AUTHORING_EVENTS`). Reviewing your own work is allowed: only the _second_
chair has to be independent. So the plan's rule is "at least one non-author",
not "no authors".

★ **New evidence needs new reviews.** Reviews name their acceptance run. A new
passing run — after a revision, an image edit or a re-run of the checks — makes
earlier reviews history, and approval then needs two reviews on the new run.
The database reads the _latest_ passing run exactly as the application does,
so reviews on superseded evidence cannot approve anything.

★ **A rejection is final for that evidence.** The theme is revised, and the
next version is reviewed afresh.

## 3. Approval

`approveThemeStudioCandidate` locks the project and checks four things:

- the expected revision;
- `verifyCandidateEvidenceWithDb`: the evidence still matches the current
  package digest, asset bytes and build;
- the review rule;
- `publicationBlockers`: no placeholder, and every production validator rule
  passes.

It then moves `candidate → approved`. The database repeats the review rule
when a project enters `approved`, and an approved project can no longer change
its current version in place.

★ **Approving means "publish this".** A version the publisher would refuse is
therefore not approvable. Otherwise a problem would surface only at the last
step, after two people had signed it off.

## 4. Publication

`publishThemeStudioProject` follows plan §8, in this order:

1. **Lock and re-read.** Lock the project and the theme id. Refuse unless the
   project is `approved`, the revision matches and the typed confirmation is
   the theme id. Re-verify the evidence — the build binding is skipped, see
   §6 — and the reviews. Re-run the blockers.
2. **Write the attempt.** Insert a `theme_studio_publications` row
   (`publishing`), and allocate the version with `nextReleaseVersion`: 1.0.0
   first, then the next minor, never reusing one. A failed attempt of the
   same version that already stored a release is **resumed**: the release row
   is immutable, and rebuilding it on another day would change its release
   date, its digest, and collide with itself. An attempt still `publishing`
   after 15 minutes is treated as abandoned.
3. **Build the release** (`buildPublishedPackage`, pure):
   - every `theme-asset://<slot>` path becomes that slot's public object;
   - the release is `published` and dated in India time, noting the source
     version;
   - the catalog entry is `public` and the demo `healthy`;
   - it must pass the package contract and the production validator.
4. **Promote images.** Each image is read from the project's stored `image`
   asset and its bytes re-hashed against the package's digest. It must be
   WebP. It is then uploaded to
   `theme-releases/<theme>/<version>/<slot>-<sha16>.webp` with a one-year
   immutable cache header.
5. **Store the release** in `theme_releases` (`source = 'theme-studio'`)
   through the registry's own validated insert, and record it on the attempt.
6. **Seed the demo.** Create or reset `demo-<theme>`, seed it from the exact
   release (zero seeding errors), and render `/`, `/shop`, one product and
   `/cart` over loopback — the same technique acceptance uses. Each must be a
   themed 200.
7. **Expose it.** In one transaction:
   - upsert the catalog entry (public, this release);
   - write the `publish` audit row;
   - mark the attempt `published`;
   - move the project to `published` (the guard requires that publication);
   - record `theme_published`.
8. **Invalidate caches** with immediate expiry: the registry, stores, pages,
   products, categories and chrome.

★ **Exposure is the last step.** A release row nobody points at is invisible
to signup and the public catalog. So a failed demo leaves nothing a merchant
can see, and the retry resumes the same release. `visibility: public` and
`demo: healthy` are written into the immutable package before the demo is
seeded. That is safe because the catalog **pointer** is what decides exposure,
and it is written only after the demo renders.

★ **A refusal before the attempt row is a thrown error. A failure after it is
recorded.** The attempt row stores the reasons (at most 20). The project stays
`approved`, and the action returns the reasons to the screen.

## 5. Rollback

`changeThemeStudioCatalog` takes one of three changes, each with a reason:

- `hide` — visibility becomes `hidden`;
- `show` — visibility becomes `public`, only for a published release whose
  demo is healthy;
- `select_release` — points the catalog at another **published** release of
  the same theme.

Each change writes an audit row and a project event, and expires the caches.

★ **No action here touches an installed store.** Every store pins its theme
id and exact version in `stores.settings.theme`, and an exact pin keeps
resolving while its release is published. Hiding a theme stops new installs;
it does not re-skin anybody. Forcing existing stores onto another release is
out of scope (plan §8), because it could overwrite merchant-edited content.

A Studio project publishes one release line (`published → archived` is its
only exit), so `select_release` matters once a theme has several releases. It
is built now so rollback does not wait for that.

## 6. Decisions worth knowing

- **Images live in the media bucket, under their own root.** The package
  contract admits exactly one kind of https path:
  `https://storage.googleapis.com/<bucket>/theme-releases/<theme>/<version>/<slot>-<sha16>.webp`.
  The theme id must be the package's, the version the release's, the slot the
  asset's, and the digest prefix the asset's own. An arbitrary URL, or
  another theme's object, is refused by the contract rather than by a caller
  remembering to check.
- **No store's clean-up may delete a published image.** Seeding copies the
  URL into a merchant's product and page rows. Every orphan sweep would
  otherwise read "a URL in our bucket this store no longer uses" and delete
  an object the theme, and every other store on it, still renders.
  `deleteStorageUrls` therefore skips any `theme-releases/` path
  unconditionally — even with no tenant scope, even in the platform store
  purge — and counts it as `shared`.
- **The build binding is skipped at publication.** Approval requires evidence
  rendered by the current build. A deploy between approval and publication
  must not strand an approved theme, and the published demo is rendered and
  checked again anyway.
- **The demo store is recorded, not referenced.** `demo_store_id` is not a
  foreign key. Every store foreign key cascades (migration 0014), and a
  cascade would delete an append-only audit row along with the store.
- **Generated pages always get an SEO description.** The draft schema lets a
  model leave one null, and the production validator needs 20+ characters on
  every page. So a generated theme could pass everything else and fail
  acceptance for a sentence it was never asked for. The compiler now fills a
  missing description from text the draft already has: the page title, the
  theme name and the theme's description. It never invents copy.

## 7. Schema — migration `20260925_0134_theme_studio_publication`

- **`theme_studio_reviews`**: one scorecard per chair per acceptance run,
  bound by trigger to passing evidence, and immutable.
- **`theme_studio_publications`**: one row per attempt.
  - One attempt `publishing` at a time, and one `published` ever, per project.
  - A lifecycle CHECK: completion matches status, a published row names its
    release, and the release and its digest arrive together.
  - A guard: final rows are immutable apart from the operator-removal
    `created_by → NULL`; the release may be set once; no deletes.
- **`theme_catalog_audit`**: append-only, one row per publish, hide, show or
  release selection.
- **Project guard** (replaced):
  - entering `approved` needs the latest passing run to carry an approving
    design review, an approving commerce review, one of them independent, and
    no rejection;
  - an approved project cannot change its version in place;
  - entering `published` needs a published publication of that version.
- **Events**: `review_submitted`, `project_approved`, `publication_started`,
  `publication_failed`, `theme_published`, `catalog_visibility_changed`,
  `catalog_release_selected`.

All three tables are service-only (RLS on; `app_user` holds nothing), and
`app_service` cannot update a review or the audit.

The migration is additive for the revision being replaced, which never moves
a project into `approved` or `published`. It is applied locally, and the
local drift baseline is refreshed.

## 8. Code map

| File                                             | Role                                                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `lib/theme-studio/scorecard.ts`                  | the rows, chairs, rejection conditions and bar; no imports, client-safe                                            |
| `lib/theme-studio/publication-core.ts`           | pure: scorecard validation, approval readiness, blockers, versions, the published-package builder, catalog changes |
| `lib/theme-studio/publication.ts`                | server-only: review, approve, publish, catalog changes, read model; publication I/O injectable (`PublicationDeps`) |
| `lib/theme-studio/acceptance.ts`                 | `verifyCandidateEvidenceWithDb` (transaction-aware; status and build options)                                      |
| `lib/themes/runtime-registry.ts`                 | `insertThemeReleaseWithDb` and `loadExactReleaseWithDb` now exported                                               |
| `lib/theme-studio/contracts.ts`                  | published release image paths, pinned three ways                                                                   |
| `lib/storage/paths.ts`, `lib/storage/cleanup.ts` | `THEME_RELEASE_OBJECT_ROOT`; sweeps never delete one                                                               |
| `app/actions/theme-studio-actions.ts`            | four superadmin-gated adapters                                                                                     |
| `…/studio/[projectId]/release/`                  | the screen                                                                                                         |

## 9. Production runbook

Before the first production publication:

1. **Apply migration 0134.** The pipeline applies it before deploy.
2. **Confirm `GCS_BUCKET` is set** on the service. Without it, publication
   refuses with "Media storage is not configured". Confirm the runtime service
   account can write objects under `theme-releases/`. The bucket is already
   public-read, as all media is.
3. **Confirm the loopback render works**: acceptance's server stage uses the
   same path. If the server is not reachable at `127.0.0.1:$PORT`, set
   `THEME_STUDIO_ACCEPTANCE_ORIGIN`.
4. **Two superadmins.** The non-author rule needs a second person. A platform
   with one superadmin cannot publish a Studio theme, by design.
5. **Staging canary** (the exit criterion):
   1. on staging, generate a theme with a real model;
   2. replace every image;
   3. pass acceptance at the three viewports;
   4. have two superadmins review it, one of them not an author;
   5. approve and publish;
   6. open the demo store and confirm the theme appears in the staging
      catalog and signup;
   7. create a fresh store on it and confirm `settings.theme` pins the
      release;
   8. hide it: the fresh store still renders; signup no longer offers it;
   9. show it again;
   10. read the catalog audit.
6. **Production**: repeat with the chosen theme. If anything looks wrong
   after publication, **Hide from new installs** is immediate and harmless to
   existing stores.

To undo a publication entirely: hide it. The release row, the images and the
audit are permanent records and are never deleted.

## 10. Verified, and not

**Verified against the local database and the running dev server** (a
scratch end-to-end test, not committed):

- **Setup.** A project was generated with the offline provider. A publishable
  version was attached: a bundled theme's content as a generated package,
  with every slot an operator image stored for the project. Passing evidence
  was recorded directly; the browser stage was not driven.
- **Review rules.**
  - A below-bar approval was refused.
  - The author's design review was stored as _author_.
  - The same person was refused the second chair.
  - Approval was refused without a commerce review.
  - A commerce rejection made the theme unapprovable on that evidence.
  - New evidence cleared the old reviews.
  - Superseding evidence with no reviews was refused **by the database**,
    even though an older run carried two approving reviews.
  - Two approvals on the new evidence then approved it.
- **Publication.**
  - A wrong confirmation was refused.
  - A demo check reporting a 500 failed the attempt. No catalog entry was
    written, and the project stayed `approved`.
  - The retry resumed the same 1.0.0 release.
  - The demo store rendered `/`, `/shop`, a product and `/cart` from the dev
    server as themed 200s.
  - The project became `published`. The theme appeared in the public catalog
    at `themes.localhost` with its demo link.
- **Install and rollback.**
  - A fresh store installed it and pinned 1.0.0.
  - Hiding it removed it from the catalog while the fresh store still
    resolved 1.0.0.
  - Showing it restored it.
  - The audit read `publish, hide, show`, and the attempts read
    `failed, published`.
- **Offline provider gaps found.** The first run found two things the
  offline provider's minimal theme gets wrong: an empty homepage SEO
  description and too few homepage sections. The first is fixed in the
  compiler for every generated theme; the second is by design (see §11).
- **Database probes.** In a rolled-back transaction, each of these was
  refused by the database:
  - an approval with a 3, an approval with a rejection ticked, and a
    rejection with no reason;
  - a second review for the same chair, and a review with a forged evidence
    digest;
  - editing or deleting a review;
  - editing or deleting a finished publication, two publications in flight,
    and a published row with no release;
  - editing the audit;
  - marking a project published without a publication, and an approved
    project changing its version.

**Not verified:**

- **The release screen in a browser.** It is behind the superadmin login,
  which was not entered. It typechecks and lints; its actions are
  unit-tested.
- **A real GCS upload.** The e2e injected storage, to keep test objects out
  of the shared bucket. The upload call is the same `gcsUploadObject` media
  uploads already use.
- **The staging canary** (§9.5). It needs a real model run, which is a paid
  call and was not made, and two real superadmins.
- **A production build.**

## 11. Known limits

- **The offline provider's theme cannot be published.** It is too thin for
  the production validator (three homepage sections, "Placeholder copy from
  the test provider"). That is correct: it exists to exercise the pipeline,
  not to be a theme.
- **Only the attempt row records a failure.** An attempt that fails between
  storing the release and exposing it leaves an unexposed release row. That
  is harmless, and it is what the retry resumes.
- **No automatic retry.** A failed attempt waits for an operator.
- **Images are WebP only.** Slot uploads always produce WebP. A future AVIF
  path would need the published-path pattern widened.
