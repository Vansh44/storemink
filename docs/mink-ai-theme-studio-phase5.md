# Mink AI Theme Studio — Phase 5 automated acceptance

Phase 5 adds the automated gates a generated version must pass before it can
be presented for human approval. It is operator-only: nothing a merchant,
their staff or a shopper does changes, so there is no Help Centre migration.
Plan: `docs/mink-ai-theme-studio-plan.md` §7.2 and §10.

## 1. What changes for an operator

Every version row in a Studio project now has a **Checks** link. The checks
screen (`…/studio/[projectId]/versions/[versionId]/acceptance`) runs the gates
on the project's **current** version and shows the evidence: every gate, its
findings, and the exact inputs the run judged.

- **Run acceptance checks.** The server stage runs inside that request. It
  checks the package, builds (or reuses) the preview store, and fetches its
  rendered pages. The browser stage then runs in the operator's own page. Each
  review surface loads in a visible frame at laptop (1440×900), iPad
  (768×1024) and mobile (390×844) size, and is measured there.
- **Passing makes a candidate.** When every required gate passes, the project
  moves from `ready` to `candidate`, and the workspace says so.
- **Failing stays out of review.** A quality failure leaves the project
  `ready`, and demotes a candidate back to `ready`; a revision fixes it. A
  security failure moves the project to `blocked`.
- **Evidence goes stale.** A pass is bound to the build that rendered it. After
  a deploy, the checks screen says the candidate's evidence is no longer
  current and the checks must be run again.

## 2. The gates

| Gate                       | Stage   | Required     | What fails it                                                                                                                                               |
| -------------------------- | ------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package contract           | server  | yes          | `validateThemePackageV2` under today's rules                                                                                                                |
| Pages, catalogue and links | server  | yes          | the extracted theme-acceptance floors (TA-2.1–2.5), dead links, a blocking capability gap                                                                   |
| Design system and contrast | server  | yes          | an incomplete or invalid palette, fonts or shape; WCAG AA on six rendered colour pairs                                                                      |
| Security scan              | server  | yes, blocks  | script/iframe/style tags, inline handlers, `javascript:`/`data:` URLs, off-site media or links, CSS escapes in tokens, custom code, undeclared capabilities |
| Asset integrity            | server  | yes          | an asset with no matching stored bytes, the wrong purpose, format or dimensions, production sizing                                                          |
| Asset provenance           | server  | yes          | any StoreMink placeholder image, missing alt text, bundled legacy imagery, a missing licence note                                                           |
| Demo materialization       | server  | yes          | the preview store could not be seeded with zero errors                                                                                                      |
| Storefront routes          | server  | yes          | the five surfaces not returning a themed 200, the missing page not a themed 404, a page without noindex                                                     |
| Navigation links           | server  | yes          | a link on the home or shop page returning 4xx/5xx                                                                                                           |
| Rendered markup            | server  | yes          | a resource loaded from another origin, an image with no alt attribute, a page with no language                                                              |
| Browser coverage           | browser | yes          | a surface not measured at every viewport, or measured at the wrong width                                                                                    |
| Responsive layout          | browser | yes          | horizontal overflow                                                                                                                                         |
| Accessibility (axe)        | browser | yes          | a serious or critical axe-core WCAG 2.1 A/AA violation (lower impacts are listed, not failed)                                                               |
| Media loading              | browser | yes          | an image that failed to load, confirmed by requesting it again                                                                                              |
| Performance                | browser | **advisory** | LCP over 2.5 s or CLS of 0.1 or more                                                                                                                        |

**★ A skipped required gate is a failure.** "We could not check" is never a
pass. **★ Performance is the one advisory gate.** It is measured on whatever
machine the operator uses, not the production-build Lighthouse run the plan's
thresholds were written for, and LCP is not reported inside frames at all.

## 3. Package validation moved into production code

The package rules lived only in `lib/themes/themes.test.ts`, so they guarded
the four bundled themes in CI and nothing created at runtime.
`lib/themes/validation.ts` now holds them as pure functions that return
findings: catalog metadata, pages, homepage floor, sample data, links, design
and image sizing. `themes.test.ts` asserts every bundled theme returns none.
The Studio gates call the same functions. Three rules are new:

- **Rendered contrast pairs.** Body, card, muted and ink-surface text, plus
  button labels at 3:1, header text, and muted labels on sand.
- **Dead page links.** A single-segment link must reach a seeded page or a
  storefront route. `STOREFRONT_CODE_ROUTES` is pinned against
  `app/(storefront)/(pages)`. The menus are read as the storefront reads them
  (`normalizeMenus`), so an empty legal row's fallback links count too.
- **Policy pages are exempt.** Terms, refund, shipping, privacy and cookie
  policy are written by the merchant, never a theme
  (`MERCHANT_AUTHORED_SLUGS`, from the store-policy registry).

## 4. How a run is bound

`theme_studio_acceptance_runs` (migration `0131`) records one run per start:

- **Inputs.** The version, its package digest, an assets digest over every
  asset paired with the stored row that backs it, and the build id
  (`K_REVISION` on Cloud Run, or `THEME_STUDIO_BUILD_ID`).
- **Evidence digest.** A finished run's digest covers those inputs and every
  gate, and the row can no longer be edited or deleted.
- **One active run per version**, enforced by a partial unique index. A new
  start expires an unfinished browser stage and errors a server stage
  abandoned for 15 minutes.
- **★ The database guards the candidate state.** The project guard refuses
  `candidate` unless the current version has a passed run over its exact
  package digest. It also refuses a candidate changing its version in place.
  `candidate → ready` is the one new transition, mirrored in the TypeScript
  contract. A test parses the guard's SQL and compares every state pair.
- **Approval must re-verify.** `verifyThemeStudioCandidateEvidence`
  re-derives the passing run, its package digest, the current build and a
  freshly computed assets digest. Phase 6 approval must call it; the candidate
  state alone is not enough.

## 5. The server stage fetches itself

`acceptance-http.ts` requests preview pages over loopback
(`127.0.0.1:$PORT`, or `THEME_STUDIO_ACCEPTANCE_ORIGIN`) with the preview
store's Host header. Four things make that dependable:

- **`node:http`, not fetch.** The Fetch standard forbids setting Host, and
  `*.localhost` does not resolve in Node.
- **A grant cookie for the run.** The request carries a fresh 15-minute grant
  cookie, plus the operator's own session where the preview gate requires it
  (every `*.storemink.com` environment).
- **A fresh connection per request.** A pooled keep-alive socket the server has
  just closed fails as "socket hang up".
- **One retry for a transport failure only.** An HTTP status is an answer and
  is never retried.

**The 404 surface in development.** A storefront not-found page arrives as
Next's minimal `__next_error__` document, with the themed tree in the RSC
payload. Ordinary demo stores behave the same. So the themed check matches
the root class list in either form, and the lang rule skips that document; the
browser stage's axe run checks the rendered page.

## 6. The browser stage

`app/(storefront)/components/studio-acceptance-probe.tsx` renders only on a
preview store. It answers a `postMessage` only from its parent, only from a
platform-host origin, and replies only to that origin. For each page it:

- waits for load and fonts;
- scrolls the page so lazy images load;
- measures overflow and names the elements causing it;
- confirms broken images by requesting each one again;
- runs axe-core, imported on demand (now a runtime dependency).

It then posts raw measurements. The runner
(`acceptance-runner.tsx`) submits them, and the server applies every
threshold. There is no "passed" field anywhere, and the surfaces a report
must cover come from the server's own record of the run.

**★ A probe that has measured stays silent.** When the frame moves to the next
page, the previous page is still alive for a moment and receives the next
request. If it acknowledged that request, the new page would never be asked.
The first live run hung on exactly this. Every request, acknowledgement and
result now carries a per-page sample number.

**Trust.** The runner is a superadmin's own browser, as in Mink Phase 7D. A
superadmin could forge the numbers. Human approval is the next gate in any
case, and a nonce binds the report to its run (stored as a hash, 30 minutes
long, single use).

## 7. Fixed in passing

- **A live storefront accessibility defect.** The header's "Deliver to" label
  (`delivery-location.module.css`) used the faint ink token on the sand drawer
  trigger. It failed WCAG AA at iPad and mobile widths in all four live themes
  (2.25–4.22:1). It now uses the muted ink token, which clears 4.5:1 in each.
  The new gate found it on every page of every candidate, so no theme could
  have passed without the fix. This changes a shopper-visible colour slightly,
  but no merchant task, so there is no Help Centre update.
- **Removing a platform operator was blocked by Theme Studio history.**
  `created_by` is `ON DELETE SET NULL`, and assets, messages and acceptance
  runs are immutable by trigger. So the delete failed for any operator who had
  ever uploaded a reference image. Migration `0132` admits exactly that one
  change, `created_by` becoming NULL with every other column unchanged.

## 8. Schema

- **`0131_theme_studio_acceptance`** adds:
  - `theme_studio_acceptance_runs` with digest, lifecycle and status CHECKs;
  - the one-active partial index;
  - the append-only evidence trigger;
  - the replaced project guard;
  - four event types: `acceptance_started`, `_passed`, `_failed` and `_blocked`.
- **`0132_theme_studio_operator_removal`** replaces the two guard functions.

Both are additive for the revision being replaced. Applied locally, and the
local drift baseline is refreshed.

## 9. Known limits

- **★ Every model-made version fails asset provenance today.** Images are
  placeholders until an image path exists, so no generated version can become
  a candidate yet. The gate is right; what is missing is either operator image
  upload per slot (a new version from the current one) or Phase 7's image
  generation. That is the next blocker before Phase 6 can run end to end.
- **Not built:**
  - screenshot capture and screenshot-diffing;
  - the plan's interaction tests (search, variants, add-to-cart);
  - a reduced-motion pass;
  - Lighthouse against a production build.
- **The dev server can interrupt a run.** In development on a machine with 12
  GB or less, the dev server keeps two pages alive (`onDemandEntries`). The
  frame visiting six storefront pages can evict the Studio page, and the dev
  client then reloads it mid-run. This does not happen in production.

## 10. Verified, and not

**Verified against the local database and dev server:**

- **The server stage against a real generated version.** It correctly failed
  the offline provider's thin package and its placeholders, and all the route
  gates passed. It took 16 s cold and about 2 s warm.
- **The browser stage in a real Chromium.** The platform page framed the
  preview through the enter route, which also confirms the partitioned cookie
  works in a cross-site `localhost` frame (Phase 4 had left that open). All 18
  samples were measured. They found the delivery-pill contrast defect, which
  was fixed and re-measured clean.
- **Submission.** A wrong nonce and a replay are refused, the verdict is
  computed server-side, and the events are recorded.
- **The pass path.** A clean package (a bundled theme backed by real stored
  WebP images) passed every server gate and became a **candidate**. A
  simulated deploy made its evidence stale. A failing re-run demoted it, and
  restoring an older version dropped it to `ready`.
- **The database guards.** Eight adversarial statements in a rolled-back
  transaction all behaved as designed, including candidate without evidence,
  evidence over the wrong digest, editing or deleting a finished run, two
  active runs, and a candidate changing its version. The `0132` probes
  showed that operator deletion now succeeds and that any other change on an
  immutable row is still refused.

**Not verified:**

- **The Studio checks screen itself.** It is behind a superadmin login, which
  was not entered. The runner's protocol was exercised by driving the same
  messages from a platform-host page.
- **A production-build run.**
