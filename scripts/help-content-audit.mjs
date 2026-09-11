#!/usr/bin/env node

/**
 * Audits the Help Centre rows a database is actually serving.
 *
 * `help:lint` reads migration SQL and runs in CI. It cannot see two things:
 * content an operator edited in the Help console, and the assembled result of
 * many migrations appending to one guide -- which is how
 * `use-mink-ai-in-your-dashboard` reached 69 KB and 36 sections without any
 * single migration looking unreasonable.
 *
 * This reads the published rows and reports the same banned vocabulary, plus
 * the two shape numbers that flag a guide turning back into a changelog:
 * length and section count.
 *
 * NOT IN CI, for the reason `db:drift` is not: it needs database credentials,
 * and a pull request cannot cause published-content drift. Run it after a
 * Help migration and when reviewing the Help Centre:
 *
 *   npm run help:audit:local     (or :staging / :prod)
 *
 * Exit 1 on any banned vocabulary. Oversized guides are reported as warnings,
 * because length is a judgement rather than a defect -- one long guide with a
 * good reason should not fail a release.
 */

import process from "node:process";
import pg from "pg";
import { HELP_LINT_RULES } from "./help-content-lint.mjs";

const { Client } = pg;

/** A guide past these has usually become a changelog rather than a guide. */
const MAX_CHARS = 25_000;
const MAX_SECTIONS = 14;

/**
 * Comments are stripped before rendering, search indexing and AI retrieval, so
 * they are not published text. 20260910_0093 uses one to satisfy a durable
 * postcondition that can no longer be edited; docs/help-centre.md explains.
 */
function renderedText(body) {
  return (body ?? "").replace(/<!--[\s\S]*?-->/g, " ");
}

function config() {
  const adminUser = process.env.DB_ADMIN_USER;
  if (!adminUser) throw new Error("DB_ADMIN_USER is required");
  const host = process.env.DB_HOST;
  const isSocket = host?.startsWith("/");
  return {
    host,
    port: isSocket ? undefined : Number(process.env.DB_PORT ?? 5432),
    user: adminUser,
    password: process.env.DB_ADMIN_PASSWORD,
    database: process.env.DB_NAME,
    ssl: false,
    application_name: "storemink-help-audit",
  };
}

async function main() {
  const client = new Client(config());
  await client.connect();
  let rows;
  try {
    ({ rows } = await client.query(
      `select a.slug, a.title, a.excerpt, a.body, c.title as category
         from public.help_articles a
         left join public.help_categories c on c.id = a.category_id
        where a.status = 'published'
        order by a.slug`,
    ));
  } finally {
    await client.end();
  }

  const failures = [];
  const warnings = [];
  for (const row of rows) {
    const text = renderedText(
      `${row.title}\n${row.excerpt ?? ""}\n${row.body ?? ""}`,
    );
    for (const rule of HELP_LINT_RULES) {
      const hit = text.match(rule.pattern);
      if (hit)
        failures.push({
          slug: row.slug,
          rule: rule.name,
          sample: hit[0].trim(),
        });
    }
    const chars = (row.body ?? "").length;
    const sections = (row.body ?? "").split("<h2>").length - 1;
    if (chars > MAX_CHARS || sections > MAX_SECTIONS) {
      warnings.push({ slug: row.slug, chars, sections });
    }
  }

  console.log(
    `Audited ${rows.length} published guides in ${process.env.DB_NAME}.`,
  );
  if (warnings.length) {
    console.log(`\n${warnings.length} oversized guide(s) — split by task:`);
    for (const w of warnings.sort((a, b) => b.chars - a.chars)) {
      console.log(
        `  ${w.slug}: ${w.chars.toLocaleString()} chars, ${w.sections} sections` +
          ` (guide limits ${MAX_CHARS.toLocaleString()} / ${MAX_SECTIONS})`,
      );
    }
  }
  if (failures.length === 0) {
    console.log(
      "\nNo operator-only or internal vocabulary in published content.",
    );
    return;
  }
  console.error(
    `\n${failures.length} published guide(s) contain content a merchant cannot act on:`,
  );
  const byRule = new Map();
  for (const f of failures) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f);
  }
  for (const [rule, list] of byRule) {
    const def = HELP_LINT_RULES.find((r) => r.name === rule);
    console.error(`\n  [${rule}] ${def.message}`);
    for (const f of list)
      console.error(`      ${f.slug} — found ${JSON.stringify(f.sample)}`);
  }
  console.error(
    "\nFix with a forward-only migration in drizzle/migrations/sql/. See docs/help-centre.md.",
  );
  process.exitCode = 1;
}

await main();
