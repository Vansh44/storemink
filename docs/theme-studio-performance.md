# Theme Studio generation performance

## Vanta diagnosis, 2 October 2026

Read-only production records showed approximately 82 minutes from the initial
queue to final automatic QA failure. The operator reported roughly 100 minutes
including waiting and inspection. Twelve immutable snapshots represented four
text designs, four image saves and four catalogue captures, rather than twelve
independent creative requests.

| Work                                        | Observed duration / result                                        |
| ------------------------------------------- | ----------------------------------------------------------------- |
| Initial text generation                     | 5m 42s                                                            |
| Initial artwork                             | 19m deadline; 14 of 18 slots completed                            |
| Missing-artwork fill                        | 5m 12s; remaining slots completed                                 |
| Three text revisions                        | 7m 45s, 6m 10s, 3m 47s                                            |
| Artwork after revisions                     | 4m 05s and 1m 16s; new anchors and changed slot identities/shapes |
| Four browser captures and acceptance rounds | Roughly 3–4 minutes each, plus scheduler waits                    |
| Two visual reviews                          | 6m 36s and 1m 23s                                                 |

The first two QA rounds failed required image-crop checks. Later browser
acceptance passed, but visual review found product-title wrapping and weak
commerce composition. Repair briefs asked for CSS and preload changes that a
theme package cannot express. The generated change notes claimed fixes while
the shared renderer still exhibited the issue. Two image slots also retained
style mismatches after redraws. Scheduler frequencies were already one minute;
changing cron frequency alone would not address this workload.

## Changes

- Automatic QA repairs edit bounded native settings in the existing package.
  They skip reference analysis and catalogue regeneration, keep every asset and
  stop unsupported renderer work. One validation correction is allowed, with
  no fallback to a complete rewrite. Manual redesigns still use both stages.
  New runs record `theme-studio-v19`; older queued runs keep their original
  call sequence so saved paid stages remain reusable. New initial drafts match
  hero height to source framing rather than demanding screen-height artwork.
- All patches pass package, publish-mode section and content-floor checks.
  Protected paths and ineffective normalised values are rejected. The same
  provider model remains selected; only the focused repair uses LOW effort and
  an 8,192-token allowance. Initial design and visual review retain their
  existing reasoning configuration.
- Partial image runs reuse the established style anchor. Anchor styling governs
  general imagery; the passed SET reference governs product staging.
  Shared image permits cover active requests rather than provider cooldowns.
- Browser screenshots preserve the measured viewport without CSS zoom. Vision
  receives complete semantic JSON, supported settings, capability gaps and
  explicit contact-sheet page ordering. Advisory performance timing alone is
  not a reason to regenerate a theme. Required gates, score thresholds,
  rejection rules and human publication approval remain unchanged.
- Shared editorial product pages use a larger portrait gallery, a wider title
  column and bounded title sizing. Default commerce newsletter copy inherits
  the theme's homepage voice; merchant copy and switches retain precedence.
- Failed visual findings appear directly in the operator workspace, alongside
  browser acceptance status. Hidden intermediate parent numbers resolve.

## Verification and limits

Regression coverage exercises protected paths, supported enums, registry
normalisation, copy limits, optional settings, no-ops, unsupported renderer
work, one-call repairs, preserved artwork/catalogue data, image permit fairness,
semantic QA evidence, newsletter precedence and operator failure display.

A local Chrome check uses the production stylesheet at 360, 390, 768, 1024 and
1440 pixels with the largest supported heading scale. Three representative
footwear names retain intact words and do not overflow. Hyphenated names may
wrap naturally at the hyphen. This is a renderer fixture, not a full storefront
or provider quality benchmark.

Provider quotas, initial artwork throughput and visual judgement still vary.
These changes remove unnecessary work; they do not establish a guaranteed
end-to-end generation time or prove that every theme clears visual review.
Measure a fresh complete run after deployment before making latency claims.
Existing failed themes are not automatically rewritten by deploying this code.

## Aurelle follow-up, 2 October 2026

Read-only production records confirmed the focused repair pipeline was active:
one repair took about 10 seconds and the next stopped in about 3 seconds.
The initial text draft took 5m 26s; artwork took about 18 minutes plus a 2-minute
fill after two rate-limited slots. The theme still failed required acceptance
because shared carousel dots had 9–11px click areas and a portrait content hero
retained only 24% of its source at tablet width. The model correctly identified
the remaining fixes as renderer work; another settings revision cannot enlarge
buttons or alter the stacked media frame.

Carousel buttons now keep a 32px click area around the small visual dot, expose
the current slide and show keyboard focus. Banner/split media stacks in a 4:3
frame below 860px rather than a shallow fixed-height strip. Section height
presets retain their desktop behavior and no longer distort stacked media.
The image is still cropped with `cover`; the acceptance crop threshold is
unchanged. No artwork is regenerated by these corrections.

Run `node scripts/theme-studio-renderer-check.mjs` with the capture job's
dependencies and local Chrome (or `CHROME_EXECUTABLE_PATH`). It checks production
CSS with synthetic source images, all five QA widths, stacked height presets,
eight dot controls and focus visibility without network/provider/database work.
This fixture does not prove the full Aurelle storefront passes every gate.
After deploying the renderer fixes, use **Images → Retry automatic QA** on the
existing theme to obtain fresh build-bound evidence. Initial artwork latency
and provider quotas remain separate limits; these corrections do not establish
a guaranteed theme completion time.

These are operator workflow and renderer fixes; no merchant action changes, no
Help Centre update. No SQL migration is needed.

## Image execution optimisation and validation

Image draws and reviews now use independent pools capped at three each, with
at most six active slot tasks. A slow HIGH-effort review no longer holds an
image draw lane. Anchor validation and the first passed product reference
remain dependencies, preserving one coherent product set. Provider 429s pause
queued requests together; recovery starts with one request and restores one
permit after three successful responses. This process-local smoothing follows
[Google's guidance to smooth traffic and use jittered backoff](https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429).
It cannot reserve provider capacity or coordinate separate server instances.

Retakes keep the candidate with the fewest applicable nonblocking findings.
Flagged or unreviewed generated images cannot establish the SET for a reviewed
run; resumed fills verify passed reviews against exact asset hashes. Uploads
retain their owner's choice. Product briefs specify readable, unfolded garments
and plain first-shot staging; a validated SET takes precedence over anchor
props and conflicting staging. Model, output size, safety settings, HIGH review
effort and ULTRA_HIGH media resolution remain unchanged. Generation and review
agree that SET governs product staging while ANCHOR supplies complementary
palette, lighting and mood. Timings now distinguish provider attempts, capacity
waits, reviews and total run time, with safe review failure codes.

The check command uses synthetic apparel only, on the configured Vertex project:

```sh
TSX_TSCONFIG_PATH=tsconfig.scripts.json node --import tsx scripts/theme-studio-image-check.ts --live --yes --apparel --review --out=/tmp/image-check
```

It makes at most three image calls and three review calls under a nine-minute
deadline. Raw images, stored crops and `report.json` remain local; the command
does not write production state. `--retake-from=/tmp/image-check` reuses that
synthetic check's anchor and validated leggings shot to check one tank retake.
`--review-from=/tmp/image-check` checks the saved synthetic tank without drawing
another image. Both saved-image modes require passed anchor and leggings
reviews in the prior report.
The command exits unsuccessfully on a failed crop, unavailable review or quality
finding, rather than treating image delivery alone as validation.

The first staging check on 2 October drew images in 28.7–33.2 seconds each,
without 429s, and completed its three draws/reviews in 152.5 seconds (about
$0.44 estimated). The reviewer passed the anchor and leggings but identified
the tank's different backdrop. Inspection confirmed it. This led to the explicit
SET-over-anchor staging rule and a focused retake check; the initial check is
retained as a failed result rather than counted as an all-pass benchmark.
The focused retake passed review: 30.0 seconds to draw and 57.9 seconds to review,
88.5 seconds overall, about $0.15 estimated, with one provider attempt and no
capacity wait. The review latency reinforces the need for separate draw and
review pools rather than allowing reviews to occupy draw lanes.
The fresh final-prompt check drew all three images in 28.1–30.5 seconds each
with one attempt per image and no 429s. Anchor and leggings passed, but the tank
review hit its 180-second timeout, making the whole check incomplete (307.5
seconds overall, about $0.42 estimated from returned usage). Inspection showed
consistent plain staging; visual inspection does not substitute for the failed
model review. A separate saved-image review checks that candidate without
buying another draw: it passed in 9.0 seconds, about $0.007 estimated. All final
synthetic images therefore have passed review evidence, but the original
timeout remains recorded and the uninterrupted three-image check remains
incomplete. Provider review timeouts remain a material limit.
These small staging checks do not establish full-theme production throughput.
