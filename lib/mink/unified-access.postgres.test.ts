// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { readFileSync } from "node:fs";
const h = vi.hoisted(() => ({ service: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withService: h.service }));
vi.mock("@/app/actions/platform", () => ({
  getPlatformViewer: async () => ({
    role: "superadmin",
    email: "operator@example.test",
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));
import { setMinkBetaAccess } from "@/app/actions/mink-operator-actions";
import { MINK_ACTION_TOOLS } from "./product-action-types";
const socket = process.env.MINK_UNIFIED_TEST_SOCKET;
const suite = socket ? describe : describe.skip;
suite("unified Mink access on disposable PostgreSQL", () => {
  let pool: Pool;
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const migration = readFileSync(
    "drizzle/migrations/sql/20260909_0091_mink_unified_access_composer.sql",
    "utf8",
  );
  const liveDictationMigration = readFileSync(
    "drizzle/migrations/sql/20260910_0092_mink_live_dictation_help.sql",
    "utf8",
  );
  beforeAll(async () => {
    if (
      !socket ||
      !/^\/private\/tmp\/mink-unified-pg\.[A-Za-z0-9]+$/.test(socket)
    )
      throw new Error(
        "Use a disposable socket, never an application database.",
      );
    pool = new Pool({
      host: socket,
      port: 55486,
      database: "mink_unified_verify",
      user: process.env.USER,
      max: 4,
    });
    const existing = await pool.query(
      "select count(*)::int as n from pg_tables where schemaname='public'",
    );
    if (existing.rows[0].n !== 0)
      throw new Error("Fixture database must be empty.");
    await pool.query(`
      create table stores(id uuid primary key);
      create table mink_store_access(store_id uuid primary key references stores,
        enabled boolean not null default false, drafting_enabled boolean not null default false,
        phase text not null default 'merchant_beta', invited_by text, invited_at timestamptz, updated_at timestamptz default now(),
        check(not enabled or (invited_by is not null and invited_at is not null)),
        check(not drafting_enabled or enabled));
      create table mink_action_tool_access(store_id uuid references stores, tool_name text,
        enabled boolean not null, enabled_by text, enabled_at timestamptz, updated_at timestamptz default now(),
        primary key(store_id,tool_name), check(not enabled or (enabled_by is not null and enabled_at is not null)));
      create table help_articles(slug text primary key,status text,category_id int,body text,updated_at timestamptz);
    `);
    await pool.query("insert into stores values ($1),($2)", [first, second]);
    await pool.query(
      "insert into mink_store_access(store_id,enabled,invited_by,invited_at) values ($1,true,'test operator',now()),($2,false,null,null)",
      [first, second],
    );
    h.service.mockImplementation(async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(drizzle(client));
        await client.query("commit");
        return result;
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
    });
  });
  afterAll(async () => {
    await pool?.end();
  });
  it("rolls back the entire upgrade if Help verification fails", async () => {
    await pool.query("begin");
    await expect(pool.query(migration)).rejects.toThrow(
      "guidance was not installed",
    );
    await pool.query("rollback");
    expect(
      (
        await pool.query(
          "select drafting_enabled from mink_store_access where store_id=$1",
          [first],
        )
      ).rows[0].drafting_enabled,
    ).toBe(false);
  });
  it("backfills every capability only for enabled stores and preserves Help content", async () => {
    await pool.query(
      "insert into help_articles values('use-mink-ai-in-your-dashboard','published',1,'<p>Keep custom notes</p>',now())",
    );
    await pool.query(migration);
    await pool.query(migration);
    await pool.query(liveDictationMigration);
    await pool.query(liveDictationMigration);
    const tools = (
      await pool.query(
        "select tool_name from mink_action_tool_access where store_id=$1 and enabled order by tool_name",
        [first],
      )
    ).rows.map((r) => r.tool_name);
    expect(tools).toEqual([...MINK_ACTION_TOOLS].sort());
    expect(
      (
        await pool.query(
          "select * from mink_action_tool_access where store_id=$1 and enabled",
          [second],
        )
      ).rowCount,
    ).toBe(0);
    const body = (await pool.query("select body from help_articles")).rows[0]
      .body;
    expect(body).toContain("Keep custom notes");
    expect(
      body.split("<h2>One Mink AI switch and a simpler message box</h2>"),
    ).toHaveLength(2);
    expect(body.split("<h2>Live microphone dictation</h2>")).toHaveLength(2);
    expect(body).toContain(
      "recognised words into the message box in real time",
    );
    expect(body).toContain(
      "does not create, upload or save a microphone audio file",
    );
    expect(body).not.toContain("choose <strong>Start dictation</strong>");
    const manifest = JSON.parse(
      readFileSync("drizzle/migrations/manifest.json", "utf8"),
    );
    for (const q of manifest.migrations.find(
      (m: { id: string }) =>
        m.id === "20260909_0091_mink_unified_access_composer",
    ).applyVerify.queries)
      expect(Object.values((await pool.query(q.sql)).rows[0])[0]).toBe(
        q.equals,
      );
    for (const q of manifest.migrations.find(
      (m: { id: string }) => m.id === "20260910_0092_mink_live_dictation_help",
    ).applyVerify.queries)
      expect(Object.values((await pool.query(q.sql)).rows[0])[0]).toBe(
        q.equals,
      );
  });
  it("atomically toggles and serializes competing operator requests without crossing tenants", async () => {
    expect(await setMinkBetaAccess(first, false)).toEqual({ success: true });
    expect(
      (
        await pool.query(
          "select * from mink_action_tool_access where store_id=$1 and enabled",
          [first],
        )
      ).rowCount,
    ).toBe(0);
    const results = await Promise.all(
      [true, false, true, false].map((enabled) =>
        setMinkBetaAccess(first, enabled),
      ),
    );
    expect(results.every((r) => r.success)).toBe(true);
    const parent = (
      await pool.query(
        "select enabled,drafting_enabled from mink_store_access where store_id=$1",
        [first],
      )
    ).rows[0];
    expect(parent.enabled).toBe(parent.drafting_enabled);
    const children = (
      await pool.query(
        "select enabled from mink_action_tool_access where store_id=$1",
        [first],
      )
    ).rows;
    expect(children).toHaveLength(MINK_ACTION_TOOLS.length);
    expect(children.every((r) => r.enabled === parent.enabled)).toBe(true);
    expect(
      (
        await pool.query(
          "select enabled from mink_store_access where store_id=$1",
          [second],
        )
      ).rows[0].enabled,
    ).toBe(false);
  });
  it("rolls back parent enablement when a child update fails", async () => {
    await setMinkBetaAccess(first, false);
    await pool.query(
      "alter table mink_action_tool_access add constraint fixture_deny_enable check(not enabled)",
    );
    expect((await setMinkBetaAccess(first, true)).error).toBeTruthy();
    expect(
      (
        await pool.query(
          "select enabled from mink_store_access where store_id=$1",
          [first],
        )
      ).rows[0].enabled,
    ).toBe(false);
    await pool.query(
      "alter table mink_action_tool_access drop constraint fixture_deny_enable",
    );
  });
});
