import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// ★★ A BARE ARRAY IN A DRIZZLE `sql` TEMPLATE IS NOT AN ARRAY PARAMETER.
//
// Drizzle expands `${["a","b"]}` into a comma-separated placeholder LIST, for
// `in (...)`. Written as `= any(${values}::text[])` -- which reads perfectly
// and was the idiom at thirteen call sites across five modules -- that
// compiles to `any(($1, $2)::text[])`, a ROW CONSTRUCTOR cast to an array, and
// PostgreSQL refuses it outright:
//
//   two or more values : cannot cast type record to text[]
//   exactly one value  : malformed array literal: "a"
//   no cast at all     : op ANY/ALL (array) requires array on right side
//
// So every one of those queries threw at runtime, always -- and several sit
// behind callers that swallow errors by design (the POS customer claim is
// documented as "never throws, at both layers"), which is why a broken query
// could sit there looking like a feature that simply never matched anything.
// `sql.param(values)` binds the whole array as ONE parameter and is correct.
//
// ⚠ Verified against a real PostgreSQL, not inferred: `sqlToQuery` alone shows
// the placeholder shape but not that the server rejects it.
// ---------------------------------------------------------------------------

describe("array parameters in raw SQL", () => {
  it("compiles a bare array into a row constructor, which is why the rule exists", () => {
    const bare = new PgDialect().sqlToQuery(
      sql`select 1 where 'a' = any(${["a", "b"]}::text[])`,
    );
    expect(bare.sql).toContain("any(($1, $2)::text[])");

    const bound = new PgDialect().sqlToQuery(
      sql`select 1 where 'a' = any(${sql.param(["a", "b"])}::text[])`,
    );
    expect(bound.sql).toContain("any($1::text[])");
    expect(bound.params).toEqual([["a", "b"]]);
  });

  it("has no `any(${…})` in the tree that is not wrapped in sql.param", () => {
    // grep exits 1 with no matches, which is the passing case.
    const found = execSync(
      "grep -rn 'any(\\${' lib app scripts drizzle 2>/dev/null || true",
      { cwd: process.cwd(), encoding: "utf8" },
    )
      .split("\n")
      .filter((line) => line.trim() && !line.includes("sql.param"))
      // This file quotes the broken shape on purpose, to prove it is broken.
      .filter((line) => !line.startsWith("lib/db/sql-array-binding.test.ts"));
    expect(found).toEqual([]);
  });
});
