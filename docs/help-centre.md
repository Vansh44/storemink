# The Help Centre

Merchant-facing product documentation, served at `help.storemink.com` from the
platform-global `help_articles` / `help_categories` tables and managed by
operators at `/dashboard/help` on the platform host. Architecture is
`CODEBASE.md` §21. **This document is about what belongs in a guide**, why the
Help Centre once filled up with things that did not, and the two checks that
stop it happening again.

---

## 1. What went wrong, so it is not repeated

`AGENTS.md` required every implementation to update the Help Centre. The rule
was well meant and its incentive was wrong: the cheapest way to satisfy it was
to append one more `<h2>` to the nearest guide.

- **85 of the first 98 migrations wrote to `help_articles`.**
- `use-mink-ai-in-your-dashboard` reached **69 KB across 36 sections**, ordered
  by engineering phase — one section per rollout, newest first, because each
  migration _prepended_ its own.
- It published a switch only StoreMink staff can see ("Platform superadmins now
  use one **Enable Mink AI** button on the store management page"), the
  environment variables `MINK_AI_ENABLED` / `MINK_BETA_REQUIRE_INVITE` /
  `MINK_MULTIMODAL_ENABLED`, a local-development `gcloud auth
application-default login` command, Cloud Run restarts, worker leases,
  idempotency keys and Gemini token accounting.
- Eleven guides carried a **"Controlled live verification required:"** rubric
  addressed to a StoreMink "test team", three of them naming the release
  checklist itself, written in the third person about "the merchant".
- Worst, because it was self-contradictory: **"This alpha is read only. It
  cannot create or edit a product, change stock, inspect orders or customers,
  publish content, send a campaign…"** — directly above sections explaining how
  Mink does each of those. It also said usage "does not debit AI credits",
  which stopped being true when drafting shipped.

The lesson is not "write less". It is that **a guide a merchant cannot act on
is worse than a missing guide**: it is read once, found useless, and the
documentation is never trusted again. `20260910_0093` removed all of the above.

---

## 2. The gate

Write or edit a guide when, and only when, the change alters **what a merchant,
their staff, or a shopper does** in a dashboard, storefront, POS or email they
can reach. Otherwise write nothing and say so in the handoff.

### Never publish

| Do not publish                                                                        | Because                                       | Where it belongs                          |
| ------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------- |
| Platform-operator switches, gates, console pages                                      | Only StoreMink staff can see them             | `docs/operator-console.md`, `CODEBASE.md` |
| Environment variables, runtime flags                                                  | A merchant has no environment                 | `CODEBASE.md` §7                          |
| Cloud Run, Cloud Scheduler, `gcloud`, `psql`, cron, service accounts                  | Not reachable from a store dashboard          | `docs/cron-jobs.md`, `docs/gcp-ci-cd.md`  |
| Leases, checkpoints, idempotency keys, RLS, jsonb, tsvector, migrations, Vertex       | The mechanism, not the guarantee              | `CODEBASE.md`                             |
| `Phase 5C`, `Phase 7B`, …                                                             | A guide describes the product now             | `docs/roadmap.md`                         |
| Release-checklist status, internal test plans, "the test team"                        | The reader has no test team                   | `docs/*-acceptance.md`                    |
| Release-note voice — "now", "instead of", "superseded by", "older instructions below" | A guide has no readers who remember last week | the pull request                          |

### Write the guarantee, not the mechanism

| Instead of                                                                     | Write                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| "uses an idempotency reference so a retry cannot create a second refund"       | "pressing Refund twice cannot send the money twice"    |
| "survives Cloud Run restarts through short worker leases and step checkpoints" | "your report keeps running if you close the tab"       |
| "check the global `MINK_AI_ENABLED` runtime switch"                            | "check that Mink AI is switched on for your store"     |
| "an independent default-off operator gate"                                     | "StoreMink support must switch this on for your store" |

### Address the merchant

Write in the second person. Third-person copy about "the merchant" and "the
merchant's own account" is a sign the text was drafted for an engineer, and it
reads as though it is about somebody else.

---

## 3. How to change published content

Content is database-backed, so every change is a **new forward-only migration**
in `drizzle/migrations/sql/`. Never edit an applied migration: its checksum is
recorded and the runner refuses.

**Edit the section that is wrong. Do not append a new one.** Appending is what
produced the 36-section guide, and it leaves the old, wrong section sitting
directly above the correction.

```sql
-- Tag the text you are REMOVING as $old$ so the lint knows it is being
-- deleted rather than published.
UPDATE public.help_articles
SET body = replace(body,
      $old$<p>Set MINK_AI_ENABLED to switch this on.</p>$old$,
      $new$<p>Ask StoreMink support to switch this on for your store.</p>$new$),
    updated_at = now()
WHERE slug = 'a-guide' AND status = 'published'
  AND strpos(body, $old$<p>Set MINK_AI_ENABLED to switch this on.</p>$old$) > 0;
```

A guide past roughly **25,000 characters or 14 `<h2>` sections** has stopped
being a guide. Split it by task rather than adding to it.

Publishing requires a category, an excerpt, a substantial body, an SEO title
and an SEO description — `app/actions/help-actions.ts` refuses the transition
to `published` without them, and a published article with no category has no
canonical URL (durable check in `20260820_0009`).

---

## 4. Never assert published wording in a durable `verify` block

This is the constraint that costs the most when it is broken, because it cannot
be undone.

A migration's durable `verify` is re-checked **for every applied migration, on
every `status` / `verify` / `drift` run, in every environment**
(`scripts/db-migrate.mjs`, the loop around line 665). It is also part of that
migration's checksum, so editing it makes the runner refuse every later
migration. Together those mean: **wording named in a durable `verify` can never
be edited or removed again.**

Seven migrations did this before the rule existed:

| Migration       | Froze                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260904_0076` | `<h2>Inspect Website Builder context with Mink</h2>`                                                                                          |
| `20260904_0077` | `Phase 7B adds an immutable, private custom-code proposal`, `sandbox="allow-scripts"`, and the absence of `cannot yet create a code proposal` |
| `20260905_0080` | `<h2>Use Mink while editing your website</h2>` + 3 phrases                                                                                    |
| `20260905_0081` | `<h2>Get a daily or weekly business brief</h2>` + 2 phrases                                                                                   |
| `20260905_0082` | `<h2>Enable private recurring Mink watches</h2>` + 3 phrases                                                                                  |
| `20260906_0083` | `<h2>Review and approve a response to a watch alert</h2>` + 3 phrases                                                                         |
| `20260907_0084` | `<h2>Approve private memories and review text documents</h2>` + 2 phrases                                                                     |

**21 substrings are therefore permanent** in `use-mink-ai-in-your-dashboard`,
including six `<h2>` headings — which is also why that guide cannot simply be
split into task-shaped articles: the headings have to stay in the row with that
slug.

`Phase 7B adds an immutable, private custom-code proposal` has no meaning to a
merchant and could not be deleted. `20260910_0093` keeps it **verbatim inside an
HTML comment**, which satisfies `body LIKE` while staying invisible everywhere a
person or the assistant reads:

- the rendered page — `app/help/[category]/[slug]/page.tsx` runs
  `sanitizeBlogContent`, and `sanitize-html` strips comments by default;
- Mink's retrieval chunks — `lib/help/chunks.ts` runs `sanitizeHtml` with
  `allowedTags: []`;
- Help search — the generated `search` tsvector strips tags with
  `regexp_replace(body, '<[^>]+>', ' ', 'g')`, which consumes the whole
  comment.

⚠ A comment used this way must contain **no `>` character**, or the
tag-stripping regex ends early and the text lands in the search index.

Put exact copy in **`applyVerify`**, which runs once at apply time, and keep
`verify` to tables, columns, constraints and indexes. `adoptVerify` copy
assertions age badly too — they block a future recovery `adopt` of that
migration — so prefer structure there as well.

---

## 5. The two checks

| Check                                             | Reads                                                   | Runs                               |
| ------------------------------------------------- | ------------------------------------------------------- | ---------------------------------- |
| `npm run help:lint`                               | migration SQL — the literals that become published text | **CI**, `.github/workflows/ci.yml` |
| `npm run help:audit:local` / `:staging` / `:prod` | the rows a database is really serving                   | by hand                            |

**`help:lint`** (`scripts/help-content-lint.mjs`) only inspects migrations that
touch `help_articles` / `help_categories`, and only their string literals — SQL
comments are stripped first, so explaining an internal detail to the next
reader above a statement stays free. It skips literals tagged `$old$` (and
`from` / `search` / `was`) so a cleanup migration is not flagged for containing
the text it removes. It also runs the durable-`verify` rule in §4. Historical
violations are listed in `GRANDFATHERED`, keyed `migration-id:rule`, because
applied SQL cannot be edited; `20260910_0093` removed the text itself from the
database.

Escape hatch, and the reason is required:

```sql
-- help-lint: allow infrastructure — merchants self-hosting need the bucket name
```

**`help:audit`** exists because a lint over migration SQL cannot see two
things: content an operator edited in the Help console, and the _assembled_
result of many migrations appending to one guide — which is how a guide reached
69 KB without any single migration looking unreasonable. It reports the same
vocabulary plus length and section count. It is not in CI for the reason
`db:drift` is not: it needs database credentials, and a pull request cannot
cause published-content drift.

Both are tested in `scripts/help-content-lint.test.mjs`, in **both**
directions — the offending paragraph that prompted the linter is rejected, and
ordinary merchant guidance, including the domain vocabulary that must never
look like an environment variable (GST, COD, SMS, DLT, AWB, NDR, RTO), passes
untouched. A linter that flags ordinary work is a linter somebody disables.

---

## 6. Known gaps

- **`use-mink-ai-in-your-dashboard` is still 66 KB across 36 sections.**
  `20260910_0093` removed what a merchant cannot act on; it deliberately did
  not re-author the guide, because rewriting a 36-capability feature from
  scratch risks stating something false. Splitting it by task is the follow-up,
  and §4 constrains it: six `<h2>` headings must stay in that slug.
- **`create-and-manage-offers` is 21 KB across 21 sections** — over the section
  limit, under the character limit.
- `scripts/help-content-migrations.test.mjs` still covers only the
  `0019`–`0024` baseline batch by file, not the assembled result.
