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
    ]) {
      failures.push({ id: migration.id, file: migration.file, ...finding });
    }
  }
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
    if (f.rule !== "durable-verify-copy") {
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
