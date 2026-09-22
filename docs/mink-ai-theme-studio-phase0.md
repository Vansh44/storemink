# Mink AI Theme Studio — Phase 0 contracts and threat model

> **Status:** Implemented in code on 2026-09-23. This phase creates no route,
> worker, database table, provider traffic, preview, or publication capability.
> It defines the boundary later phases must implement.

## 1. Decisions locked by Phase 0

1. Theme Studio is a StoreMink **platform** tool, never a merchant Mink tool.
2. Only a platform superadmin may create, generate, inspect, approve, publish,
   hide, restore, archive, or delete Studio data.
3. Anthropic model selection is a closed server registry. A browser sends a
   stable key; it never sends a provider model id.
4. The model produces declarative StoreMink data. It receives no shell,
   repository, SQL, database, generic HTTP, URL-fetch, or publication tool.
5. Reference-image text is untrusted content. It cannot become an instruction.
6. A capability outside registered sections, variants, tokens, assets, or
   interactions becomes an explicit blocking gap. It is not implemented with
   custom code or silently omitted.
7. Every model result is an immutable version. Publication is a later,
   deterministic human action tied to exact digests.
8. Existing published themes must fit the new package without changing their
   definitions. The compatibility test round-trips Basket, Studio, Ritual and
   Vitrine exactly.

## 2. Executable contracts

`lib/theme-studio/contracts.ts` is the authoritative Phase 0 contract.

### Stage A — `ThemeIntent`

The reference-analysis result is deliberately smaller than a theme package. It
can hold:

- summary, audiences, industries and commercial goals;
- bounded visual direction;
- known StoreMink section types per surface;
- separate desktop, tablet and mobile composition decisions;
- asset briefs, assumptions and capability gaps.

It cannot hold source code, instructions, tools, credentials, arbitrary
fields, external actions, or invented section names. The parser rejects rather
than silently normalizes those values. `THEME_INTENT_JSON_SCHEMA` is the
provider-facing structural schema; `validateThemeIntent` remains authoritative
for cross-field and registry rules.

### Stage B — `ThemePackageV2`

The package wraps the existing `ThemeDefinition` without changing it and adds:

- schema and minimum renderer versions;
- fixed acceptance viewports;
- declared StoreMink features and surfaces;
- a complete immutable asset manifest;
- origin, model, prompt and reference-digest provenance; and
- explicit capability gaps.

The parser reuses strict page-section publication validation, refuses
`custom_code`, refuses undeclared assets and unknown models, and requires every
generated asset to have a SHA-256 digest. Generated packages cannot claim the
`legacy-bundled` provenance reserved for the current source-controlled themes.

### Capability gaps

The only allowed codes are:

| Code                      | Meaning                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `missing_section`         | No registered section can express the requested block.            |
| `missing_layout_variant`  | The renderer lacks the requested shared composition.              |
| `missing_design_token`    | The design system cannot represent the requested visual property. |
| `unsupported_interaction` | The request needs product behavior, not theme data.               |
| `unsupported_asset`       | The safe asset pipeline cannot accept or produce the asset.       |
| `requires_custom_code`    | Meeting the request would require executable code.                |

A blocking gap prevents Candidate status. The suggested platform capability is
advice to engineers, not permission for the model to add it.

## 3. Roles and authority

| Action                                    | Platform member |        Superadmin |             Worker service account |                     Model |
| ----------------------------------------- | --------------: | ----------------: | ---------------------------------: | ------------------------: |
| See public theme metadata                 |             Yes |               Yes |                                 No |                        No |
| Read Studio prompts/references/candidates |              No |               Yes |             Exact claimed run only | Supplied run context only |
| Create project/upload references          |              No |               Yes |                                 No |                        No |
| Select allowlisted model                  |              No |               Yes |               Resolved server-side |                        No |
| Generate or revise candidate              |              No |           Request |                 Execute queued run | Produce structured output |
| Run deterministic validation              |              No |      Request/view |                                Yes |                        No |
| Human review                              |              No |               Yes |                                 No |                        No |
| Publish/hide/restore                      |              No |               Yes | Execute deterministic service only |                     Never |
| Access merchant Mink conversations        |              No | No through Studio |                                 No |                        No |

The worker identity is not an operator. Its future API accepts an internally
authenticated run id, claims the corresponding row, and derives every other
input from service-owned storage.

## 4. Lifecycle contract

Allowed transitions are executable in `canTransitionThemeStudioProject`:

| State        | Meaning                                                    |
| ------------ | ---------------------------------------------------------- |
| `draft`      | Intake exists; nothing is running.                         |
| `generating` | One leased generation/revision is active.                  |
| `ready`      | A parsed immutable version exists for operator inspection. |
| `candidate`  | Required deterministic gates passed for the exact version. |
| `approved`   | Required human approvals exist for the exact digests.      |
| `published`  | An immutable catalog release was created.                  |
| `failed`     | Provider/infrastructure work ended safely and may retry.   |
| `blocked`    | A capability or required gate prevents progression.        |
| `archived`   | Operator removed the project from active work. Terminal.   |

There is deliberately no `ready -> published`, `failed -> published`, or
`published -> generating` transition. A published change starts a new release
line; it never edits the release in place.

## 5. Intake and run ceilings

The initial ceilings are code constants so tests and later endpoints share one
answer:

| Limit                      |             Value | Reason                                                                  |
| -------------------------- | ----------------: | ----------------------------------------------------------------------- |
| Prompt                     | 12,000 characters | Enough for a deep brief without accepting a document dump.              |
| Reference images           |                10 | Supports multi-page/multi-device references while bounding vision cost. |
| One reference              |            10 MiB | Pre-sanitization upload ceiling.                                        |
| All references             |            40 MiB | Bounds one project submission.                                          |
| New projects/operator/day  |                20 | Initial misuse and cost ceiling.                                        |
| Concurrent runs/operator   |                 2 | Prevents accidental model fan-out.                                      |
| Run wall time              |        20 minutes | Long-horizon work still needs a terminal outcome.                       |
| Provider retries           |                 2 | Avoids retry multiplication.                                            |
| Structured repair attempts |                 2 | A persistently invalid result becomes a failure.                        |
| Package                    |        2 MiB JSON | Theme data must stay reviewable and cacheable.                          |
| Pages                      |                20 | Bounded release and preview surface.                                    |
| Asset briefs               |                40 | Enough for catalog fixtures without an unbounded media job.             |

These are safety ceilings, not model instructions. Server intake, the queue,
and the worker must each enforce the applicable limit independently.

## 6. Retention decision

Phase 0 sets the product policy later storage work must encode:

| Data                                  | Active-project retention       | After archive/rejection                                | Published release                                    |
| ------------------------------------- | ------------------------------ | ------------------------------------------------------ | ---------------------------------------------------- |
| Original reference upload             | Until last candidate + 30 days | Delete within 30 days                                  | Never publish; delete within 30 days                 |
| Sanitized reference used by model     | Until last candidate + 30 days | Delete within 30 days                                  | Never publish; delete within 30 days                 |
| Operator prompt and revision feedback | Project lifetime               | 90 days, then delete text and keep safe audit metadata | 1 year, then delete text and keep release provenance |
| Raw provider response                 | Do not persist after parsing   | N/A                                                    | N/A                                                  |
| Validated intent/package versions     | Project lifetime               | 1 year                                                 | Indefinite for release reproducibility               |
| Candidate preview assets/screenshots  | Project lifetime               | Delete within 30 days                                  | Only approved release assets/evidence persist        |
| Usage, latency, safe errors, digests  | 1 year                         | 1 year                                                 | Indefinite publication audit                         |

Google/Anthropic provider-side abuse-monitoring retention is outside
StoreMink's deletion control and must be disclosed in the Studio before the
first real call. Production enablement is blocked until the applicable terms
and logging/data-sharing configuration are recorded for each model/location.

## 7. Threat model

| Threat                                               | Consequence                               | Required control                                                                           | Verification                          | Owner              |
| ---------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------ |
| Non-operator opens a page while its layout redirects | Cross-platform data disclosure            | Every page performs `requireOperator`; Studio requires superadmin                          | Page/component tests                  | Platform auth      |
| Forged action or direct POST                         | Unauthorized generation/publication       | Every callable endpoint repeats superadmin authorization                                   | Route/action tests and mutation test  | Platform auth      |
| Caller submits a raw provider model id               | Access to unapproved models/cost          | Parse a stable allowlisted key; resolve provider id on server                              | `models.test.ts`                      | AI platform        |
| Studio models become available in merchant Mink      | Merchant cost/authority expansion         | Separate module, service identity and deployment config; no shared router entry            | Negative registry tests               | Mink runtime       |
| Screenshot contains prompt injection                 | Publish, secrets, or tool misuse          | Image is untrusted data; Stage A schema has no instruction/action field; no powerful tools | Golden evals + parser tests           | AI platform        |
| Operator prompt asks for code/SQL/network            | Remote execution or data access           | No such tools; package rejects custom code and unknown fields                              | Golden evals + contract tests         | Theme platform     |
| Model invents a section/variant                      | Broken preview or hidden behavior         | Registry validation and explicit capability gap                                            | Contract tests                        | Storefront         |
| Model silently drops an unsupported request          | Dishonest candidate                       | Blocking gap vocabulary; candidate cannot advance with blocking gaps                       | Evaluations + state tests             | Product/design     |
| Reference assets are copied to public release        | Copyright/privacy breach                  | References and release assets have separate ids/prefixes; references never promote         | Asset integration tests               | Media platform     |
| Third-party copy/logo/product photography is cloned  | IP infringement                           | Structure-only analysis, provenance requirement, human review rejection                    | Copyright evals + review gate         | Product/legal      |
| Malformed image/SVG/decompression bomb               | Worker compromise or resource exhaustion  | Raster allowlist, magic-byte decode, pixel/byte limits, re-encode; reject SVG              | Upload tests in Phase 2               | Media platform     |
| Generated package references remote assets           | Tracking, availability and ownership risk | Asset manifest accepts StoreMink path/reference only                                       | Contract tests                        | Theme platform     |
| Provider retries create duplicate versions           | Confusing or unreviewed artifacts         | Run idempotency, lease and unique version key                                              | Worker tests in Phase 3               | AI platform        |
| Stale tab revises or approves wrong parent           | Lost work or wrong release                | Parent/digest optimistic lock                                                              | Revision tests in Phase 4             | Theme platform     |
| Evidence belongs to older manifest/assets            | Unsafe publication                        | Validation and approval bind all digests                                                   | Publication mutation tests in Phase 6 | Release platform   |
| Model or worker publishes directly                   | Human boundary bypass                     | No publish tool/credential; deterministic publisher is separate                            | IAM review + integration test         | Release platform   |
| Partial asset promotion exposes broken release       | Broken public catalog                     | Stage assets immutably; expose catalog only after complete verification                    | Failure-injection tests               | Release platform   |
| A new release changes existing stores                | Merchant content loss                     | Installations remain version-pinned; catalog pointer affects new installs only             | Registry/rollback tests               | Storefront         |
| Prompt/reference appears in ordinary telemetry       | Internal data disclosure                  | Operational logs contain ids, usage and safe codes only                                    | Log-capture tests                     | Observability      |
| Cost fan-out                                         | Unexpected Vertex spend                   | daily/concurrency/token/retry/wall-time limits and global stop                             | Quota tests + budget alert            | AI platform/FinOps |

No high-risk item is accepted without a named later-phase verification. The
table is the launch checklist, not background reading.

## 8. Model registry and enablement probe

`lib/theme-studio/models.json` is the single registry read by both TypeScript
and the operational probe. The stable keys are `opus-5`, `opus-5.5`, and
`fable-5`. Provider ids can be changed only to a dated/versioned id in the same
model family through the model-specific server environment override, and each
run will eventually persist the resolved id. An override cannot redirect Opus
to Gemini, another Claude family, or an arbitrary publisher model.

The browser projection from `themeStudioModelOptions()` omits provider ids.
Passing `claude-opus-5`, a Gemini id, or any other raw name to
`parseThemeStudioModelKey` returns `null`.

Probe configuration without making a paid call:

```bash
npm run theme-studio:model-check -- --dry-run
```

Probe the target project using ADC:

```bash
THEME_STUDIO_GCP_PROJECT_ID=your-project \
npm run theme-studio:model-check -- --json
```

Optional configuration:

```text
THEME_STUDIO_VERTEX_LOCATION=global
THEME_STUDIO_CLAUDE_OPUS_5_MODEL=<verified provider id>
THEME_STUDIO_CLAUDE_OPUS_55_MODEL=<verified provider id>
THEME_STUDIO_CLAUDE_FABLE_5_MODEL=<verified provider id>
```

The probe sends one minimal `rawPredict` request per selected model, prints
only model/status/latency/safe error code, and exits non-zero if any choice is
unavailable. It never silently substitutes another model. It is intentionally
manual in Phase 0: CI must not spend partner-model tokens or depend on external
quota.

## 9. Evaluation contract

`evals/theme-studio/phase0.json` contains 32 golden briefs across:

- eight distinct commerce verticals;
- responsive composition and long-content extremes;
- text and image prompt injection;
- copyright and reference ownership;
- asset safety/performance;
- explicit platform capability gaps;
- product/cart/variant commerce behavior; and
- ambiguous or contradictory briefs.

Each case has one expected outcome (`candidate`, `clarify`, `capability_gap`,
or `refuse`), positive checks, and forbidden behavior. Phase 3 will add a
provider runner and scored results; Phase 0 tests corpus shape and coverage so
the set cannot silently shrink.

## 10. Architecture decision record

### ADR-TS-001 — Dedicated worker boundary

**Decision:** generation will run in a dedicated Theme Studio worker and
service account, not the merchant Mink request path.

**Why:** model access, long deadlines, reference retention, platform-wide
theme data, and publication-adjacent risk are different from a store-scoped
assistant. A shared client or identity makes “these models are only available
for this task” a UI convention instead of a security property.

**Trade-off:** another deployable and queue must be operated. Phase 0 accepts
that cost because it shrinks credentials and failure scope.

### ADR-TS-002 — Runtime registry with bundled fallback

**Decision:** Phase 1 will add immutable database-backed releases and resolve
them before current bundled definitions. Bundled releases remain fallback.

**Why:** operator publication without an application deploy is impossible
while `THEME_DEFINITIONS` is compile-time code. Replacing it in one migration
would risk every current installation; a layered resolver provides rollback.

**Trade-off:** resolution becomes asynchronous and cached. Call sites must be
migrated deliberately and tested against pinned old versions.

### ADR-TS-003 — Declarative packages only

**Decision:** the in-app pipeline cannot generate executable theme code.

**Why:** StoreMink is one multi-tenant renderer and Website Builder edits data.
Arbitrary code would break that model, weaken commerce/accessibility guarantees
and turn publication into remote code execution.

**Trade-off:** some requested designs become capability gaps. Shared renderer
enhancements go through ordinary source review, CI and deploy before the model
may use them.

## 11. Phase 0 verification

Phase 0 is complete when these remain true:

- the three model keys are the only accepted choices and raw provider ids are
  refused;
- every bundled theme converts to `ThemePackageV2`, validates and round-trips
  with deep equality;
- intent/package parsers reject unknown instruction-shaped fields, invented
  sections, custom code, unknown models and undeclared assets;
- the state machine has no approval/publication bypass;
- the evaluation corpus contains 25–50 unique cases and every required
  category; and
- the model probe dry-run resolves all three configured provider ids without
  making network calls.

The live provider probe remains a deployment prerequisite because it needs the
target project's accepted terms, quota and ADC. A local or CI success cannot
prove those external facts.
