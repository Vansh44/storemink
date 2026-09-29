# Theme Studio reliability — Crave and Luxe, 2026-09-29

The fixes in this change are local until the web service and separate Chromium
job are deployed. No production records were changed during diagnosis.

## Confirmed production evidence

Read through the existing Cloud SQL proxy in a read-only transaction using the
application service role, scoped to the two project IDs in the screenshots.
Times below are IST on 29 September 2026.

| Stage              | Crave                                                       | Luxe                                                        |
| ------------------ | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Initial generation | 10:05–10:11:42                                              | 10:12–10:15:53                                              |
| First image run    | 10:16–10:31:09; 5 slots rate-limited                        | 10:32–10:51:01; 5 rate-limited, 1 cancelled at run deadline |
| Missing-slot fill  | Queued 10:31, started 10:52; finished 10:59:12, all 5 drawn | Queued 10:51, started 11:00; finished 11:06:34, all 6 drawn |
| Browser capture    | Failed twice; `capture_browser_error`, 11:01:36             | Failed twice; `capture_browser_error`, 11:11:05             |
| Project state      | `ready`, current version present                            | `ready`, current version present                            |

Crave's “Generating / No version” at 11:15 was stale UI: polling stopped once
the last image run settled, even though the project was still capturing.
Luxe's three outstanding placeholders are catalog pictures produced by browser
capture. Its requested artwork completed; three retained images have minor
review flags, which is distinct from three missing images.

Cloud logging was unavailable because the saved gcloud login required
reauthentication. The database records establish terminal capture codes, not a
production browser stack trace. The SVG failure was reproduced by inspecting
and testing the actual probe: it called `.innerText.trim()` on every element,
including SVG. Independently, the job incorrectly required HTTP 200 for the
mandatory not-found surface. Both are deterministic defects.

## Changes and guarantees

- Two leased run lanes and a separate visual-QA lane start together. All settle
  before the HTTP request returns, even if one fails. Same-project concurrent
  work remains fenced by the existing database constraints and leases.
- Image requests across both lanes share three permits per provider
  project/location/model within the process. This is not a distributed quota
  controller. Provider 429 backoff and missing-slot fills remain bounded;
  external quota availability still controls throughput.
- HIGH reasoning, the selected text/image models, image resolution and output
  allowances stay unchanged. Whole-call deadlines include SDK auth and retries.
  Image review has a 180-second deadline; other structured requests ten minutes;
  image attempts 180 seconds. Run cancellation takes precedence.
- A single throwing provider call or image decoder no longer discards the
  other completed images. Cancellation unwinds queued image permits and hung
  SDK waits; late results cannot mutate a completed worker result.
- Capture handles SVGs and expected 404s, waits for probe hydration, bounds
  measurement/work/HTTP waits, reports launch failures and replaces broken
  browsers. A rejected finish response fails the job for observability.
- The workspace polls through capture and QA and refreshes on tab visibility.
  Empty-version copy explains the private pipeline; summaries distinguish
  artwork from catalog pictures. Publication gates still reject placeholders.

## Verification

- 413 targeted tests passed across 44 files (411 in the full focused run,
  plus two added provider-deadline regressions): Theme Studio libraries, worker
  routes, actions, capture job, Studio UI and browser probe.
- `tsc --noEmit --incremental false`, ESLint on changed code and
  `npm run help:lint` passed.
- Real headless Chrome 154 ran the production probe and capture function on a
  local fixture containing SVG icons, deliberately clipped text, a 200 home
  page and a 404 missing page at 360 and 1440 px. All four samples and screenshots
  completed and retained the clipping finding. This verifies browser mechanics,
  not the visual quality of the two production themes.

## Deployment and incident recovery

1. Deploy the web changes and rebuild/deploy `jobs/theme-studio-capture/` using
   `docs/theme-studio-capture-job.md`. No schema migration is needed.
2. Refresh both project tabs; the existing generated versions are preserved.
3. Capture the existing versions' catalog pictures from **Images**, then run
   **Checks** on the resulting current versions. This does not redraw artwork.
   A manual catalog capture does not itself rerun the automatic vision verdict.
4. Verify a new automatic pipeline using the deployed job: expected 404 surface,
   complete browser evidence, queued visual verdict and eventual visible version.
   Keep publication blocked until the existing acceptance and human gates pass.

No merchant-visible change, no Help Centre update. POS, inventory, locations
and fulfilment behavior are unchanged, so their roadmap/acceptance docs do not
change.
