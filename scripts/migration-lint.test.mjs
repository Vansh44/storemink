import { describe, expect, it } from "vitest";
import {
  lintManifest,
  lintMigrationSql,
  MIGRATION_LINT_RULES,
  parseAllowMarkers,
} from "./migration-lint.mjs";

function rules(sql) {
  return lintMigrationSql(sql).map((finding) => finding.rule);
}

describe("migration lint", () => {
  it("passes the enrolled manifest", async () => {
    // ★ THIS IS WHAT MAKES LINTING EVERY MIGRATION AFFORDABLE. If a rule ever
    // starts flagging already-applied SQL, CI goes permanently red and the
    // check stops being read — so the rule set is chosen to have zero hits on
    // history, and this test is the thing that keeps it that way.
    const { checked, failures } = await lintManifest();
    expect(failures).toEqual([]);
    expect(checked).toBeGreaterThan(90);
  });

  it("catches the four changes that break a running revision", () => {
    expect(rules("alter table orders drop column legacy_total;")).toEqual([
      "drop-column",
    ]);
    expect(rules("alter table orders rename column total to amount;")).toEqual([
      "rename",
    ]);
    expect(rules("drop table stale_reports;")).toEqual(["drop-table"]);
    expect(
      rules("alter table orders add column channel text not null;"),
    ).toEqual(["add-not-null-no-default"]);
  });

  it("catches the three changes that lock or rewrite a table", () => {
    expect(
      rules("alter table orders alter column total type numeric(12,2);"),
    ).toEqual(["alter-type"]);
    expect(
      rules("alter table orders alter column channel set not null;"),
    ).toEqual(["set-not-null"]);
    expect(rules("truncate table stock_movements;")).toEqual(["truncate"]);
  });

  it("leaves the safe forms of the same statements alone", () => {
    // ★★ THE FALSE-POSITIVE SET IS THE POINT. A linter that flags ordinary
    // additive migrations is one somebody disables, and then it protects
    // nothing at all.
    expect(rules("alter table orders add column channel text;")).toEqual([]);
    expect(
      rules(
        "alter table orders add column channel text not null default 'website';",
      ),
    ).toEqual([]);
    expect(
      rules("alter table orders drop constraint orders_total_check;"),
    ).toEqual([]);
    expect(
      rules("alter table orders alter column total drop default;"),
    ).toEqual([]);
    expect(
      rules("alter table orders alter column total drop not null;"),
    ).toEqual([]);
    expect(
      rules("create index orders_store_idx on orders (store_id);"),
    ).toEqual([]);
    expect(rules("insert into help_articles (slug) values ('a');")).toEqual([]);
  });

  it("ignores dangerous words inside comments and string literals", () => {
    expect(rules("-- we will drop table orders one day\nselect 1;")).toEqual(
      [],
    );
    expect(rules("/* drop column total */ select 1;")).toEqual([]);
    expect(
      rules(
        "insert into help_articles (body) values ('how to drop table safely');",
      ),
    ).toEqual([]);
  });

  it("accepts a marker only when it carries a reason", () => {
    const withReason = `-- migration-lint: allow drop-column — unused since 0071
alter table orders drop column legacy_total;`;
    expect(rules(withReason)).toEqual([]);

    const bare = `-- migration-lint: allow drop-column
alter table orders drop column legacy_total;`;
    expect(rules(bare)).toEqual(["drop-column"]);
  });

  it("scopes a marker to the rule it names", () => {
    const sql = `-- migration-lint: allow drop-column — deliberate
alter table orders drop column legacy_total;
alter table orders rename column total to amount;`;
    expect(rules(sql)).toEqual(["rename"]);
  });

  it("records a reason for every grandfathered exception", async () => {
    // A silent exception list is how a linter becomes decorative.
    const { failures } = await lintManifest();
    expect(failures).toEqual([]);
    const markers = parseAllowMarkers(
      "-- migration-lint: allow rename -- because",
    );
    expect(markers.get("rename")).toBe("because");
  });

  it("gives every rule a name and an instruction, not just a refusal", () => {
    for (const rule of MIGRATION_LINT_RULES) {
      expect(rule.name).toMatch(/^[a-z][a-z-]*$/);
      // The message has to say what to do instead; "not allowed" leaves the
      // developer with a blocked PR and no next step.
      expect(rule.message.length).toBeGreaterThan(40);
    }
  });
});
