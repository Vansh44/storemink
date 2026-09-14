import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MINK_ACTION_TOOLS } from "./product-action-types";

/**
 * The DATABASE's tool vocabulary and the APPLICATION's registry must agree.
 *
 * ★★ THEY DID NOT, AND THE CONSEQUENCE WAS SILENT. `MINK_ACTION_TOOLS` is what
 * `app/actions/mink-operator-actions.ts` upserts when an operator presses
 * Enable Mink AI, and Phase 9B added `apply_storefront_layout` to four database
 * allowlists and to nothing here. So a store enabled AFTER that migration got
 * no `apply_storefront_layout` row at all and every layout save was refused,
 * and a store disabled and re-enabled lost the gate permanently — Disable
 * clears every row for the store, Enable only re-writes the registry's.
 * Neither failure raises anything: `assertToolEnabled` simply reports that
 * support has not enabled the feature, which is indistinguishable from an
 * operator decision.
 *
 * ⚠ `unified-access.postgres.test.ts` already asserts this against a real
 * database — and is OPT-IN, so it is skipped in every ordinary run. This is the
 * same assertion with no credentials, which is why it catches the omission.
 */
const SQL_DIR = join(process.cwd(), "drizzle", "migrations", "sql");
const CONSTRAINT = "mink_action_tool_access_name_check";

function latestAllowlist(): string[] {
  const files = readdirSync(SQL_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  let latest: string[] | null = null;
  for (const name of files) {
    const sql = readFileSync(join(SQL_DIR, name), "utf8");
    const at = sql.lastIndexOf(`ADD CONSTRAINT ${CONSTRAINT}`);
    if (at === -1) continue;
    const open = sql.indexOf("ARRAY[", at);
    const close = sql.indexOf("]", open);
    if (open === -1 || close === -1) continue;
    latest = [...sql.slice(open, close).matchAll(/'([a-z_]+)'/g)].map(
      (match) => match[1],
    );
  }
  if (!latest) throw new Error(`No migration defines ${CONSTRAINT}`);
  return latest;
}

describe("Mink action-tool registry", () => {
  it("matches the database's own tool allowlist exactly", () => {
    // Set-equal in BOTH directions: a tool in the database and not here is a
    // gate the operator switch can never turn on, and one here and not in the
    // database is an approval insert the database will refuse at runtime.
    expect([...MINK_ACTION_TOOLS].sort()).toEqual(latestAllowlist().sort());
  });
});
