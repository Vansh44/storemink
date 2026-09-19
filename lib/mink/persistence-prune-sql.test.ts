import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { minkConversationPrunePredicate } from "./persistence";

// ---------------------------------------------------------------------------
// ★★ DRIZZLE'S `notExists` DOES NOT PARENTHESISE A RAW `sql` FRAGMENT.
//
// Its whole body is `sql`not exists ${subquery}``. That is correct for a
// subquery BUILDER, which renders its own parentheses, and produces
//
//   not exists select 1 from "mink_runs" ...
//
// for a raw `sql` chunk -- a plain syntax error, which PostgreSQL reports as
// `syntax error at or near "select"`.
//
// ⚠ THE BUG ONLY FIRED ABOVE TEN CONVERSATIONS, because startMinkRun skips the
// prune when there is no overflow. So it shipped green, worked for every new
// store, and then broke EVERY Mink run for the heaviest users -- inside
// startMinkRun, BEFORE any run row exists, so it left no `mink_runs` telemetry
// and surfaced only as "Mink AI couldn't start this request."
//
// ⚠ AND NO ORDINARY TEST CAN CATCH IT: the db mock never parses SQL, so an
// invalid string is indistinguishable from a valid one. This asserts the
// COMPILED query text instead -- the rule sql-array-binding.test.ts follows.
// ---------------------------------------------------------------------------

const compile = () =>
  new PgDialect().sqlToQuery(
    minkConversationPrunePredicate({ storeId: "store-1", adminId: "admin-1" }, [
      "conversation-1",
    ]),
  ).sql;

describe("mink conversation prune predicate", () => {
  it("parenthesises every not-exists subquery", () => {
    const text = compile();
    const openers = text.match(/not exists\s*\(/g) ?? [];
    expect(openers).toHaveLength(2);
    // The failing shape, stated literally so a regression names itself.
    expect(text).not.toMatch(/not exists\s+select/i);
  });

  it("still guards both kinds of retained evidence", () => {
    const text = compile();
    expect(text).toContain("mink_blog_publications");
    expect(text).toContain("mink_action_audit");
  });

  it("stays scoped to the acting store and admin", () => {
    const text = compile();
    expect(text).toContain('"mink_conversations"."store_id"');
    expect(text).toContain('"mink_conversations"."admin_id"');
  });
});
