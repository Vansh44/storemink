// @vitest-environment node
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
const socket = process.env.MINK_INPUT_TEST_SOCKET;
const suite = socket ? describe : describe.skip;
suite("Phase 8E forward-only Help migration on disposable PostgreSQL", () => {
  let pool: Pool;
  const migration = readFileSync(
    "drizzle/migrations/sql/20260909_0090_mink_phase_8e_inputs.sql",
    "utf8",
  );
  beforeAll(async () => {
    if (!socket || !/^\/private\/tmp\/mink-8e-pg\.[A-Za-z0-9]+$/.test(socket))
      throw new Error(
        "Use a dedicated temporary socket, never an application database.",
      );
    pool = new Pool({
      host: socket,
      port: 55485,
      database: "mink_8e_verify",
      user: process.env.USER,
      max: 1,
    });
    const existing = await pool.query(
      "select count(*)::int as n from pg_tables where schemaname='public'",
    );
    if (existing.rows[0].n !== 0)
      throw new Error("Fixture database must be empty.");
    await pool.query(
      "create table help_articles(slug text primary key, status text, category_id int, body text, updated_at timestamptz)",
    );
  });
  afterAll(async () => {
    await pool?.end();
  });
  it("rejects missing published guide transactionally", async () => {
    await pool.query("BEGIN");
    await expect(pool.query(migration)).rejects.toThrow(
      "Mink Phase 8E input guidance was not installed",
    );
    await pool.query("ROLLBACK");
  });
  it("installs, verifies and replays once without changing merchant text", async () => {
    await pool.query(
      "insert into help_articles values ('use-mink-ai-in-your-dashboard','published',1,'<p>Operator custom notes</p>',now())",
    );
    await pool.query(migration);
    await pool.query(migration);
    const { rows } = await pool.query("select body from help_articles");
    expect(rows[0].body).toContain("Operator custom notes");
    expect(
      rows[0].body.split(
        "<h2>Review an image, PDF or voice note with Mink AI</h2>",
      ),
    ).toHaveLength(2);
    const manifest = JSON.parse(
      readFileSync("drizzle/migrations/manifest.json", "utf8"),
    );
    const item = manifest.migrations.find(
      (m: { id: string }) => m.id === "20260909_0090_mink_phase_8e_inputs",
    );
    for (const query of item.applyVerify.queries) {
      const result = await pool.query(query.sql);
      expect(Object.values(result.rows[0])[0]).toBe(query.equals);
    }
  });
});
