#!/usr/bin/env node

/**
 * Mechanical review of migration SQL for changes that break the code that is
 * already running.
 *
 * ★★ WHY THIS EXISTS AT ALL. Cloud Run serves the old and the new container
 * side by side for the length of a rollout, so for a minute or two BOTH
 * versions of the app talk to ONE database. A migration that removes or
 * narrows something the old revision still uses takes the site down for that
 * window — and the deploy reports success, because the migration and the
 * container both did exactly what they were told.
 *
 * The rule the whole system rests on is therefore: **a migration must be
 * backward-compatible with the revision it is replacing.** Renames and
 * removals happen over several releases (expand/contract — see
 * docs/migrations.md), never in one step.
 *
 * That rule cannot be fully checked by a machine. Its mechanical half can be,
 * and that half is what a new teammate gets wrong: dropping a column, renaming
 * one, retyping one, or adding a NOT NULL column with no default. This catches
 * those in the pull request, where the cost is a comment, instead of in a
 * deploy, where the cost is an outage.
 *
 * ★ IT LINTS EVERY ENROLLED MIGRATION, NOT A DIFF. A git-diff-scoped linter
 * needs branch context, behaves differently locally and in CI, and quietly
 * checks nothing when the base ref is missing. Linting the whole manifest is
 * deterministic and identical everywhere — affordable only because the
 * existing 98 migrations already pass, with one recorded exception below.
 *
 * ★ AN ESCAPE HATCH THAT DOCUMENTS ITSELF. A genuinely necessary dangerous
 * change is allowed with a marker inside the SQL:
 *
 *   -- migration-lint: allow drop-column — cart_legacy_total unused since 0071
 *
 * The reason is REQUIRED, and it lands in the diff next to the statement it
 * excuses. ⚠ Adding a marker changes the file's checksum, so it can only be
 * done to a migration that has not been applied anywhere — which is exactly
 * the right constraint, and the runner enforces it.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest } from "./db-migrations-core.mjs";

/**
 * ⚠ NOT AN EXEMPTION MECHANISM FOR NEW WORK — use an in-SQL marker for that.
 * These are migrations that were already applied to staging and production
 * before this linter existed. Their SQL cannot be edited to carry a marker,
 * because editing an applied file changes its checksum and the runner refuses
 * it (correctly). So the record of "we know, and it is already live" has to
 * live here instead.
 */
const GRANDFATHERED = new Map([
  [
    "20260826_0018_help_embedding_hardening:set-not-null",
    "Applied before this linter existed; the column was populated in the same migration.",
  ],
]);

/**
 * Each rule matches a STATEMENT SHAPE, deliberately not a parse tree: there is
 * no SQL parser in this repo, and a regex that occasionally asks a human to
 * confirm a deliberate change is worth far more than no check at all. Every
 * rule below currently has zero hits across the enrolled migrations, so a hit
 * is genuinely new.
 */
export const MIGRATION_LINT_RULES = [
  {
    name: "drop-column",
    // `drop constraint` / `drop default` / `drop not null` are all safe and
    // must not match, hence the negative lookahead.
    pattern:
      /\balter\s+table\s+[^;]*?\bdrop\s+(?:column\b|(?!constraint\b|default\b|not\s+null\b)[\w"])/i,
    message:
      "drops a column — the running revision may still select or insert it. Stop writing to it, ship, then drop it in a later migration.",
  },
  {
    name: "rename",
    pattern: /\balter\s+table\s+[^;]*?\brename\b/i,
    message:
      "renames a table or column — the running revision still uses the old name. Add the new name, write to both, backfill, read from the new one, then drop the old one.",
  },
  {
    name: "drop-table",
    pattern: /\bdrop\s+table\b/i,
    message:
      "drops a table — the running revision may still query it. Stop using it, ship, then drop it in a later migration.",
  },
  {
    name: "add-not-null-no-default",
    pattern:
      /\badd\s+column\s+(?:if\s+not\s+exists\s+)?[\w".]+\s+[^,;]*?\bnot\s+null\b(?![^,;]*\bdefault\b)/i,
    message:
      "adds a NOT NULL column with no default — every insert from the running revision fails, and on an existing table the statement itself cannot succeed. Add it nullable or with a default.",
  },
  {
    name: "alter-type",
    pattern: /\balter\s+column\s+[\w"]+\s+(?:set\s+data\s+)?type\b/i,
    message:
      "changes a column's type — this rewrites the table under a lock and can break the running revision's reads. Add a new column and migrate onto it.",
  },
  {
    name: "set-not-null",
    pattern: /\balter\s+column\s+[\w"]+\s+set\s+not\s+null/i,
    message:
      "makes an existing column NOT NULL — this scans the whole table under a lock and rejects the running revision's inserts. Add a NOT VALID check constraint, backfill, validate it, then set NOT NULL in a later migration.",
  },
  {
    name: "truncate",
    pattern: /\btruncate\b/i,
    message: "truncates a table — this is data loss, not a schema change.",
  },
];

const MARKER =
  /--\s*migration-lint:\s*allow\s+([a-z-]+)\s*(?:—|-{1,2})\s*(\S.*)$/gim;

/** Comments and string literals must not be searched for statement shapes. */
function stripNoise(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$\$[\s\S]*?\$\$/g, " ");
}

export function parseAllowMarkers(sql) {
  const allowed = new Map();
  for (const match of sql.matchAll(MARKER)) {
    allowed.set(match[1].toLowerCase(), match[2].trim());
  }
  return allowed;
}

/**
 * @returns {{rule: string, message: string}[]} one finding per broken rule.
 */
export function lintMigrationSql(
  sql,
  { id = "", rules = MIGRATION_LINT_RULES } = {},
) {
  const body = stripNoise(sql);
  const allowed = parseAllowMarkers(sql);
  const findings = [];
  for (const rule of rules) {
    if (!rule.pattern.test(body)) continue;
    if (allowed.has(rule.name)) continue;
    if (GRANDFATHERED.has(`${id}:${rule.name}`)) continue;
    findings.push({ rule: rule.name, message: rule.message });
  }
  return findings;
}

export async function lintManifest(manifestPath) {
  const manifest = await loadManifest(manifestPath);
  const failures = [];
  for (const migration of manifest.migrations) {
    for (const finding of lintMigrationSql(migration.sql, {
      id: migration.id,
    })) {
      failures.push({ id: migration.id, file: migration.file, ...finding });
    }
  }
  return { checked: manifest.migrations.length, failures };
}

async function main() {
  const { checked, failures } = await lintManifest();
  if (failures.length === 0) {
    console.log(`Migration lint passed: ${checked} migrations checked.`);
    return;
  }
  console.error(`Migration lint failed on ${failures.length} statement(s):\n`);
  for (const failure of failures) {
    console.error(`  ${failure.id}`);
    console.error(`    [${failure.rule}] ${failure.message}`);
    console.error(`    file: ${failure.file}`);
    console.error(
      `    if this is deliberate, add to that file:\n` +
        `      -- migration-lint: allow ${failure.rule} — <why this is safe here>\n`,
    );
  }
  console.error(
    "Backward-compatible migrations are what let a deploy and a migration land in either order.\n" +
      "See docs/migrations.md.",
  );
  process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
