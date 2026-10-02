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
- Partial image runs reuse the established style anchor. Anchor styling takes
  precedence over conflicting staging details in individual asset briefs.
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

These are operator workflow and renderer fixes; no merchant action changes, no
Help Centre update. No SQL migration is needed.
