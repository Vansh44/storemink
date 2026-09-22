#!/usr/bin/env node

/**
 * Keeps the published Help Centre free of text a merchant cannot act on.
 *
 * WHY THIS EXISTS. AGENTS.md used to require that every change update the Help
 * Centre. The cheapest way to satisfy that was to append one more <h2> to the
 * nearest guide, so 85 of the first 98 migrations wrote to help_articles and
 * `use-mink-ai-in-your-dashboard` became a 69 KB, 36-section changelog ordered
 * by engineering phase. It published a switch only StoreMink staff can see,
 * runtime environment-variable names, a local-development `gcloud` command,
 * Cloud Run and worker-lease internals, and a "this alpha is read only"
 * paragraph that the sections beneath it contradicted.
 *
 * None of that is a Help Centre article. A merchant cannot act on any of it,
 * and every sentence of it costs the reader the time it takes to work out that
 * it is not for them. This linter blocks the vocabulary in the pull request,
 * where the cost is a comment, instead of in the published guide, where the
 * cost is a merchant's trust in the documentation.
 *
 * IT ALSO BLOCKS THE OTHER HALF OF THE PROBLEM: help copy asserted inside a
 * migration's DURABLE `verify` block. That block is re-checked for every
 * applied migration on every status run in every environment, and it is part
 * of the migration's checksum -- so once it ships, the wording it names can
 * never be edited or removed. Seven migrations did this before the rule
 * existed, which is why "Phase 7B adds an immutable, private custom-code
 * proposal" is frozen in a merchant guide to this day (20260910_0093 keeps it
 * in a stripped HTML comment; docs/help-centre.md explains). Exact published
 * wording belongs in `applyVerify`, which runs once, at apply time.
 *
 * WHAT IT READS. Only the string literals of migrations that write to
 * help_articles or help_categories -- the text that actually becomes published
 * content -- never the surrounding SQL or its comments, so explaining an
 * internal detail in a comment above the statement stays free.
 *
 * TEXT YOU ARE DELETING MUST BE TAGGED `$old$`. A migration that removes bad
 * wording necessarily contains it, and flagging that would make the linter
 * useless on exactly the changes that fix things. Dollar-quote the search
 * argument of a replace() as `$old$...$old$` and the linter skips it.
 *
 * AN ESCAPE HATCH THAT DOCUMENTS ITSELF, the migration-lint convention:
 *
 *   -- help-lint: allow infrastructure — merchants on self-hosted GCS need the bucket name
 *
 * The reason is REQUIRED and lands in the diff beside the statement it
 * excuses. Adding a marker changes the file's checksum, so it can only be done
 * to a migration that has not been applied anywhere -- the right constraint,
 * and the runner enforces it.
 *
 * Run with `npm run help:lint`. `npm run help:audit` is the companion that
 * checks already-published rows in a real database, which CI has no
 * credentials for.
 */

import path from "node:path";
import process from "node:process";
import { loadManifest } from "./db-migrations-core.mjs";

/**
 * Violations that predate this linter. Their SQL cannot be edited -- every one
 * of these migrations is applied, and editing an applied migration rewrites
 * its checksum and makes the runner refuse -- so they are recorded here with
 * what they published. 20260910_0093 removed the text itself from the database;
 * these entries only stop the linter failing on the historical SQL.
 */
export const GRANDFATHERED = new Map([
  [
    "20260820_0008_analytics_help_documents:infrastructure",
    "published development server",
  ],
  ["20260826_0022_payments_tax_help:internals", "published idempotenc"],
  [
    "20260826_0023_orders_shipping_help:operator-only",
    "published release checklist",
  ],
  [
    "20260826_0024_marketing_communications_help:operator-only",
    "published the test team",
  ],
  [
    "20260829_0033_pos_customer_sales_returns_help:internals",
    "published migration",
  ],
  ["20260829_0038_mink_phase_1b:phase-label", "published Phase 1B"],
  ["20260829_0039_mink_phase_2:phase-label", "published Phase 2"],
  ["20260830_0040_mink_phase_3:phase-label", "published Phase 3"],
  [
    "20260830_0042_mink_phase_4a_product_actions:phase-label",
    "published Phase 4A",
  ],
  ["20260830_0043_mink_phase_4b_4d_actions:phase-label", "published Phase 4B"],
  [
    "20260831_0046_mink_phase_5a_inventory_actions:phase-label",
    "published Phase 5A",
  ],
  [
    "20260831_0047_mink_phase_5b_bulk_inventory:phase-label",
    "published Phase 5B",
  ],
  [
    "20260901_0051_mink_phase_5c_order_status:phase-label",
    "published Phase 5C",
  ],
  [
    "20260901_0052_mink_phase_5d_blog_publication:phase-label",
    "published Phase 5D",
  ],
  ["20260901_0053_mink_phase_5e_campaigns:internals", "published SKIP LOCKED"],
  ["20260901_0053_mink_phase_5e_campaigns:phase-label", "published Phase 5E"],
  ["20260901_0054_mink_phase_5f_bulk_prices:phase-label", "published Phase 5F"],
  [
    "20260902_0058_mink_phase_6a_durable_workflows:infrastructure",
    "published Cloud Run",
  ],
  [
    "20260902_0058_mink_phase_6a_durable_workflows:internals",
    "published Gemini token",
  ],
  [
    "20260902_0058_mink_phase_6a_durable_workflows:phase-label",
    "published Phase 6A",
  ],
  ["20260903_0063_offers_phase_d:internals", "published JSONB"],
  ["20260903_0065_offers_phase_e:internals", "published JSONB"],
  ["20260903_0072_mink_phase_6bc_workflows:phase-label", "published Phase 6B"],
  [
    "20260903_0073_mink_phase_6d_slow_inventory:phase-label",
    "published Phase 6D",
  ],
  [
    "20260903_0074_mink_phase_6e_delayed_pickups:phase-label",
    "published Phase 6E",
  ],
  [
    "20260904_0076_mink_phase_7a_builder_context_help:phase-label",
    "published Phase 7A",
  ],
  [
    "20260904_0077_mink_phase_7b_storefront_code_preview:phase-label",
    "published Phase 7B",
  ],
  [
    "20260904_0078_mink_phase_7c_builder_draft_save:operator-only",
    "published operator gate",
  ],
  [
    "20260904_0078_mink_phase_7c_builder_draft_save:phase-label",
    "published Phase 7C",
  ],
  [
    "20260904_0079_mink_phase_7d_storefront_publication:operator-only",
    "published operator gate",
  ],
  [
    "20260904_0079_mink_phase_7d_storefront_publication:phase-label",
    "published Phase 7D",
  ],
  [
    "20260905_0081_mink_phase_8a_business_briefs:phase-label",
    "published Phase 8A",
  ],
  ["20260905_0082_mink_phase_8b_watches:phase-label", "published Phase 8B"],
  ["20260906_0083_mink_phase_8c_responses:phase-label", "published Phase 8C"],
  ["20260907_0084_mink_phase_8d_memories:internals", "published Vertex"],
  ["20260907_0084_mink_phase_8d_memories:phase-label", "published Phase 8D"],
  [
    "20260909_0090_mink_phase_8e_inputs:env-flag",
    "published MINK_MULTIMODAL_ENABLED",
  ],
  ["20260909_0090_mink_phase_8e_inputs:internals", "published Vertex"],
  ["20260909_0090_mink_phase_8e_inputs:phase-label", "published Phase 8E"],
  [
    "20260909_0091_mink_unified_access_composer:changelog-voice",
    "published now use one",
  ],
  [
    "20260909_0091_mink_unified_access_composer:env-flag",
    "published MINK_AI_ENABLED",
  ],
  ["20260909_0091_mink_unified_access_composer:internals", "published Vertex"],
  [
    "20260909_0091_mink_unified_access_composer:operator-only",
    "published Platform superadmin",
  ],
  ["20260910_0092_mink_live_dictation_help:infrastructure", "published gcloud"],
  ["20260910_0092_mink_live_dictation_help:internals", "published Vertex"],
]);

/** Durable `verify` help-copy assertions that shipped before the rule. */
export const GRANDFATHERED_VERIFY = new Set([
  "20260904_0076_mink_phase_7a_builder_context_help",
  "20260904_0077_mink_phase_7b_storefront_code_preview",
  "20260905_0080_mink_builder_chat_help",
  "20260905_0081_mink_phase_8a_business_briefs",
  "20260905_0082_mink_phase_8b_watches",
  "20260906_0083_mink_phase_8c_responses",
  "20260907_0084_mink_phase_8d_memories",
]);

export const HELP_LINT_RULES = [
  {
    name: "operator-only",
    // Surfaces and actors that exist only inside StoreMink. A merchant cannot
    // see a platform switch, and telling them about one invites a support
    // ticket asking where it is.
    pattern:
      /platform superadmin|store management page|operator console|the test team|release checklist|platform admin|operator gate/i,
    message:
      "describes a StoreMink-only surface, actor or gate. A merchant cannot see or use it. Document it in CODEBASE.md or docs/operator-console.md instead.",
  },
  {
    name: "env-flag",
    // Runtime configuration names. A merchant has no environment to set.
    pattern: /\b[A-Z][A-Z0-9]*_[A-Z0-9]+(?:_[A-Z0-9]+)*\b/,
    message:
      "names a runtime environment variable or internal constant. A merchant cannot read or change one; say what they should check in their own dashboard.",
  },
  {
    name: "infrastructure",
    pattern:
      /\bCloud Run\b|\bCloud Scheduler\b|\bgcloud\b|\bpsql\b|\bcron\b|application-default|service account|\bBYPASSRLS\b|advisory lock|development server/i,
    message:
      "names hosting or developer tooling. It cannot be acted on from a store dashboard.",
  },
  {
    name: "internals",
    pattern:
      /idempotenc|worker lease|step checkpoint|SKIP LOCKED|\btsvector\b|\bjsonb\b|\bpgvector\b|\bRLS\b|\bDDL\b|\bmigration\b|\bVertex\b|Gemini token/i,
    message:
      'exposes an implementation detail. State the guarantee a merchant gets, not the mechanism that provides it ("pressing Refund twice cannot send the money twice", not "uses an idempotency reference").',
  },
  {
    name: "phase-label",
    pattern: /\bPhase\s?\d+[A-Z]?\b/,
    message:
      "labels content with an engineering phase. A guide describes what the product does now; a merchant has no idea what Phase 5C is.",
  },
  {
    name: "changelog-voice",
    // The habit that produced a 36-section guide: each change announced itself
    // instead of editing the section it changed.
    pattern:
      /\bnow use one\b|\bis now\b[^.]{0,40}\binstead of\b|superseded by|Older instructions below|instructions below are superseded|no longer required\b/i,
    message:
      "is written as a release note. A guide has no readers who remember last week's version: edit the section that is wrong rather than announcing a change beside it.",
  },
];

// The separator must be surrounded by whitespace. Without that, `[a-z-]+`
// backtracks and splits a hyphenated rule name: "allow phase-label" with no
// reason at all parses as rule "phase" plus reason "label", which defeats the
// point of requiring a reason.
const MARKER =
  /--\s*help-lint:\s*allow\s+([a-z][a-z-]*)\s+(?:—|--?)\s+(\S.*)$/gim;

/** Removal arguments are tagged so a cleanup migration is not flagged. */
const DELETION_TAGS = new Set(["old", "from", "search", "was"]);

const MIN_LITERAL = 30;

export function parseAllowMarkers(sql) {
  const allowed = new Map();
  for (const m of sql.matchAll(MARKER))
    allowed.set(m[1].toLowerCase(), m[2].trim());
  return allowed;
}

export function touchesHelpContent(sql) {
  return /\bhelp_articles\b|\bhelp_categories\b/i.test(sql);
}

/**
 * The text a migration PUBLISHES: dollar-quoted blocks and long single-quoted
 * literals, minus anything tagged as a deletion. Line comments are stripped
 * first so explaining an internal detail above a statement stays free.
 */
export function publishedText(sql) {
  const withoutComments = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
  const out = [];
  const dollar = /\$([a-zA-Z_]*)\$([\s\S]*?)\$\1\$/g;
  let stripped = withoutComments;
  for (const m of withoutComments.matchAll(dollar)) {
    if (!DELETION_TAGS.has(m[1].toLowerCase())) out.push(m[2]);
    stripped = stripped.replace(m[0], " ");
  }
  for (const m of stripped.matchAll(/'((?:[^']|'')*)'/g)) {
    if (m[1].length >= MIN_LITERAL) out.push(m[1]);
  }
  return out.join("\n\n");
}

/** @returns {{rule: string, message: string, sample: string}[]} */
export function lintHelpSql(sql, { id = "", rules = HELP_LINT_RULES } = {}) {
  if (!touchesHelpContent(sql)) return [];
  const text = publishedText(sql);
  const allowed = parseAllowMarkers(sql);
  const findings = [];
  for (const rule of rules) {
    const hit = text.match(rule.pattern);
    if (!hit) continue;
    if (allowed.has(rule.name)) continue;
    if (GRANDFATHERED.has(`${id}:${rule.name}`)) continue;
    findings.push({
      rule: rule.name,
      message: rule.message,
      sample: hit[0].trim(),
    });
  }
  return findings;
}

/** Durable `verify` must assert structure, never published wording. */
export function lintVerifyContract(entry) {
  if (GRANDFATHERED_VERIFY.has(entry.id)) return [];
  const queries = entry.verify?.queries ?? [];
  const offending = queries.filter(
    (q) => /help_articles/i.test(q.sql ?? "") && /\blike\b/i.test(q.sql ?? ""),
  );
  if (offending.length === 0) return [];
  return [
    {
      rule: "durable-verify-copy",
      message:
        "asserts published Help wording in the DURABLE `verify` block. That block is re-checked on every status run in every environment and is part of this migration's checksum, so the wording it names could never be edited again. Move the copy assertion to `applyVerify`, which runs once at apply time, and keep `verify` to tables, columns, constraints and indexes.",
      sample: offending[0].name ?? offending[0].sql?.slice(0, 60) ?? "",
    },
  ];
}

/**
 * ★★ A `replace()` WHOSE SEARCH TEXT NO LONGER EXISTS IS A SILENT NO-OP.
 *
 * Published Help content is edited forward-only, so a migration that changes a
 * guide quotes the text it is replacing. `replace()` returns the string
 * UNCHANGED when it finds no match: the UPDATE succeeds, rows are reported
 * updated, nothing errors -- and the edit simply did not happen. The only
 * thing that notices is the migration's own `applyVerify`, which runs at apply
 * time against a real database. CI has no database, so the failure lands in
 * the deploy pipeline instead of the pull request.
 *
 * 20260922_0124 is the case this was written for. It quoted a whole paragraph
 * as 20260920_0120 published it, but 20260921_0121 had already rewritten that
 * paragraph's closing sentence in place. The quote was stale before it shipped,
 * and the production migrate step refused the release.
 *
 * ★ IT IS DETECTABLE WITHOUT A DATABASE, because the migrations ARE the edit
 * history. Replay them in manifest order over the text they publish: a search
 * argument that is absent from the CURRENT replayed text but present in text a
 * migration ORIGINALLY published is, precisely, a quote some earlier edit
 * invalidated.
 *
 * ⚠ A quote it has never seen published at all is SKIPPED, not flagged. Those
 * name text from the article's original insert, which predates the fragments
 * this can reconstruct, and flagging them would make the check noise -- which
 * is how a linter gets switched off (scripts/migration-lint.mjs makes the same
 * trade). It therefore under-reports and never over-reports.
 */
const REPLACE_PAIR =
  /\$(old|from|search|was)\$([\s\S]*?)\$\1\$\s*,\s*\$([a-zA-Z_]*)\$([\s\S]*?)\$\3\$/g;

/** The `replace(body, $old$X$old$, $new$Y$new$)` pairs of one migration. */
export function extractReplacements(sql) {
  const withoutComments = sql.replace(/--[^\n]*/g, " ");
  return [...withoutComments.matchAll(REPLACE_PAIR)].map((m) => ({
    search: m[2],
    replacement: m[4],
  }));
}

/**
 * Split SQL without treating semicolons inside strings, comments or
 * dollar-quoted Help copy as statement boundaries. This is deliberately a
 * small lexical splitter, not a SQL parser; its only job is to keep an UPDATE's
 * WHERE clause attached to that UPDATE's replace() calls.
 */
function sqlStatements(sql) {
  const statements = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      const newline = sql.indexOf("\n", i + 2);
      i = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (sql[i] === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] !== "'") {
          i += 1;
          continue;
        }
        if (sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      continue;
    }
    if (sql[i] === '"') {
      i += 1;
      while (i < sql.length) {
        if (sql[i] !== '"') {
          i += 1;
          continue;
        }
        if (sql[i + 1] === '"') {
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      continue;
    }
    if (sql[i] === "$") {
      const tag = sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }
    if (sql[i] === ";") {
      statements.push(sql.slice(start, i + 1));
      start = i + 1;
    }
    i += 1;
  }
  if (sql.slice(start).trim()) statements.push(sql.slice(start));
  return statements;
}

function withoutSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** The one article an UPDATE targets, or null when it cannot be proven. */
function helpArticleSlug(statement) {
  const withoutComments = withoutSqlComments(statement);
  if (!/^\s*UPDATE\s+(?:public\.)?help_articles\b/i.test(withoutComments))
    return null;
  // Help copy can itself contain SQL-looking words. Remove dollar-quoted
  // payloads before reading the statement's actual WHERE clause.
  const sqlOnly = withoutComments.replace(
    /\$([a-zA-Z_][a-zA-Z0-9_]*|)\$[\s\S]*?\$\1\$/g,
    " ",
  );
  const match = sqlOnly.match(
    /\bwhere\b[\s\S]*?\b(?:[a-zA-Z_][a-zA-Z0-9_]*\.)?slug\s*=\s*'((?:[^']|'')+)'/i,
  );
  return match ? match[1].split("''").join("'") : null;
}

function scopedReplacements(sql) {
  return sqlStatements(sql).flatMap((statement) => {
    const slug = helpArticleSlug(statement);
    return extractReplacements(statement).map((pair) => ({ ...pair, slug }));
  });
}

/** Dollar-quoted blocks a migration publishes, long enough to be real copy. */
function publishedLiterals(sql) {
  const withoutComments = sql.replace(/--[^\n]*/g, " ");
  const out = [];
  for (const m of withoutComments.matchAll(
    /\$([a-zA-Z_]*)\$([\s\S]*?)\$\1\$/g,
  )) {
    if (DELETION_TAGS.has(m[1].toLowerCase())) continue;
    if (m[2].length < MIN_LITERAL) continue;
    out.push(m[2]);
  }
  return out;
}

/**
 * Published copy with its article identity. Unknown insert shapes are skipped:
 * under-reporting is safer than letting one guide's wording mutate another in
 * the replay.
 */
function publishedFragments(sql) {
  const fragments = [];
  for (const statement of sqlStatements(sql)) {
    const slug = helpArticleSlug(statement);
    if (slug) {
      for (const text of publishedLiterals(statement))
        fragments.push({ slug, text });
      continue;
    }

    const withoutComments = withoutSqlComments(statement);
    if (
      !/\binsert\s+into\s+(?:public\.)?help_articles\b/i.test(withoutComments)
    )
      continue;
    // All enrolled Help inserts put slug, title, excerpt and body next to each
    // other in this order, whether they use SELECT literals or a VALUES table.
    const article =
      /'((?:[^']|'')+)'\s*,\s*'(?:[^']|'')*'\s*,\s*'(?:[^']|'')*'\s*,\s*\$([a-zA-Z_][a-zA-Z0-9_]*|)\$([\s\S]*?)\$\2\$/g;
    for (const match of statement.matchAll(article)) {
      if (match[3].length < MIN_LITERAL) continue;
      fragments.push({
        slug: match[1].split("''").join("'"),
        text: match[3],
      });
    }
  }
  return fragments;
}

/** @returns {{id: string, rule: string, message: string, sample: string}[]} */
export function lintStaleQuotes(migrations) {
  /** Published text, keyed by article and kept current by later replacements. */
  let current = [];
  /** The same text as first published, so an invalidated quote is knowable. */
  const originally = [];
  const failures = [];

  for (const migration of migrations) {
    for (const { search, replacement, slug } of scopedReplacements(
      migration.sql,
    )) {
      // If the statement does not identify one article, there is no safe replay
      // scope. Skip it rather than borrowing identical wording from a sibling.
      if (!slug) continue;
      const matches = current.some(
        (fragment) => fragment.slug === slug && fragment.text.includes(search),
      );
      if (matches) {
        current = current.map((fragment) =>
          fragment.slug === slug && fragment.text.includes(search)
            ? {
                ...fragment,
                text: fragment.text.split(search).join(replacement),
              }
            : fragment,
        );
        continue;
      }
      if (
        !originally.some(
          (fragment) =>
            fragment.slug === slug && fragment.text.includes(search),
        )
      )
        continue;
      failures.push({
        id: migration.id,
        file: migration.file,
        rule: "stale-quote",
        message:
          "replaces text that an earlier migration has already edited, so replace() will match nothing and the edit will silently not happen. Quote only the sentence you are changing -- a paragraph quote expires the moment any sibling migration edits any part of it.",
        sample: search.slice(0, 120),
      });
    }
    for (const fragment of publishedFragments(migration.sql)) {
      current.push(fragment);
      originally.push(fragment);
    }
  }
  return failures;
}

/**
 * Migrations whose `replace()` edits shipped with no postcondition that could
 * tell an applied edit from a silent no-op. Their SQL and manifest entries are
 * applied everywhere, so neither can be changed -- editing either rewrites a
 * recorded checksum and the runner refuses every later migration.
 */
export const GRANDFATHERED_WITNESS = new Set([
  "20260826_0023_orders_shipping_help",
  "20260826_0026_plan_entitlements_help",
  "20260827_0031_pos_checkout_clarity_help",
  "20260828_0032_pos_phone_checkout_and_verification_help",
  "20260830_0042_mink_phase_4a_product_actions",
  "20260910_0093_help_centre_operator_content_removal",
  "20260911_0094_pos_customer_lookup_help",
  "20260911_0095_canonical_customer_phone",
  "20260914_0112_mink_global_voice_provider",
  "20260915_0113_mink_conversation_voice_catalog_images",
  "20260916_0114_mink_credits_cycle_pricing",
  "20260920_0120_mink_automatic_attachments",
  "20260921_0121_mink_multi_attachments_campaign_art",
]);

/** The `%…%` arguments of every LIKE in an applyVerify query. */
function likePatterns(sql) {
  return [...String(sql ?? "").matchAll(/like\s+'%(.*?)%'/gi)].map((m) =>
    m[1].split("''").join("'"),
  );
}

/**
 * ★★ EVERY `replace()` NEEDS A POSTCONDITION THAT COULD FAIL.
 *
 * `applyVerify` is the only thing standing between a silent no-op and a
 * published guide that quietly still says the wrong thing -- but only if one
 * of its queries can actually TELL the two apart. A check that passes against
 * the unedited body proves nothing; a replace with no check at all proves
 * less.
 *
 * 20260922_0124 is the migration that made this concrete twice over. Its stale
 * paragraph quote was caught only because one of its two checks happened to
 * name text unique to the replacement -- and its third edit, added while
 * fixing that, had no check at all until this rule asked for one.
 *
 * ★ A query WITNESSES an edit when a pattern it requires appears in the
 *   replacement and NOT in the text being replaced (or, for an `equals: "0"`
 *   check, the reverse: text that is present before and absent after). Either
 *   way the assertion changes value when the edit lands, which is the whole
 *   property.
 *
 * ⚠ It cannot prove the check is SUFFICIENT -- a pattern may also appear
 *   elsewhere in the article, where it would pass without this edit. That
 *   needs the real body, which `npm run help:audit:*` reads and CI cannot.
 */
export function lintUnwitnessedEdits(migration) {
  if (GRANDFATHERED_WITNESS.has(migration.id)) return [];
  if (!touchesHelpContent(migration.sql)) return [];
  const pairs = extractReplacements(migration.sql);
  if (pairs.length === 0) return [];

  const assertions = (migration.applyVerify?.queries ?? []).map((q) => ({
    expectsPresent: String(q.equals) === "1",
    patterns: likePatterns(q.sql),
  }));

  return pairs
    .filter(
      ({ search, replacement }) =>
        !assertions.some(({ expectsPresent, patterns }) =>
          patterns.some((pattern) =>
            expectsPresent
              ? replacement.includes(pattern) && !search.includes(pattern)
              : search.includes(pattern) && !replacement.includes(pattern),
          ),
        ),
    )
    .map(({ replacement }) => ({
      rule: "unwitnessed-edit",
      message:
        "edits published text with no applyVerify query that could tell the edit from a silent no-op. replace() succeeds either way, so without one a quote that stops matching publishes nothing and reports success. Add a query naming wording unique to the replacement.",
      sample: replacement.slice(0, 120),
    }));
}

export async function lintManifest(manifestPath) {
  const manifest = await loadManifest(manifestPath);
  const failures = [];
  let checked = 0;
  for (const migration of manifest.migrations) {
    const touches = touchesHelpContent(migration.sql);
    if (touches) checked += 1;
    for (const finding of [
      ...lintHelpSql(migration.sql, { id: migration.id }),
      ...(touches ? lintVerifyContract(migration) : []),
      ...lintUnwitnessedEdits(migration),
    ]) {
      failures.push({ id: migration.id, file: migration.file, ...finding });
    }
  }
  failures.push(...lintStaleQuotes(manifest.migrations));
  return { checked, total: manifest.migrations.length, failures };
}

async function main() {
  const { checked, total, failures } = await lintManifest();
  if (failures.length === 0) {
    console.log(
      `Help content lint passed: ${checked} of ${total} migrations write Help content.`,
    );
    return;
  }
  console.error(
    `Help content lint failed on ${failures.length} statement(s):\n`,
  );
  for (const f of failures) {
    console.error(`  ${f.id}`);
    console.error(`    [${f.rule}] ${f.message}`);
    console.error(`    found: ${JSON.stringify(f.sample)}`);
    console.error(`    file: ${f.file}`);
    if (f.rule === "unwitnessed-edit") {
      console.error(
        `    Add an applyVerify query asserting wording unique to the new text.\n` +
          `    A durable \`verify\` block is the wrong home: it is re-checked forever\n` +
          `    and would freeze the wording it names (docs/help-centre.md).\n`,
      );
    } else if (f.rule === "stale-quote") {
      // Deliberately NO escape hatch: an allow marker cannot make replace()
      // find text that is not there. The only fix is to quote what is.
      console.error(
        `    Re-read the current wording and quote only the sentence you are\n` +
          `    changing. There is no marker for this: a stale quote is not a\n` +
          `    style disagreement, it is an edit that will not happen.\n`,
      );
    } else if (f.rule !== "durable-verify-copy") {
      console.error(
        `    If it genuinely belongs in a merchant guide, add inside the SQL:\n` +
          `      -- help-lint: allow ${f.rule} — <why a merchant needs this>\n`,
      );
    } else {
      console.error("");
    }
  }
  console.error(
    "Help Centre guides are for merchants. See docs/help-centre.md for what belongs in one.",
  );
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(new URL(import.meta.url).pathname)
) {
  await main();
}
