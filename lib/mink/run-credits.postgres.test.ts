// @vitest-environment node
/**
 * Opt-in fixture only. Requires an EMPTY mink_credits_verify database on a
 * task-owned temporary socket. Bring one up, run it, throw it away:
 *
 *   PG=/opt/homebrew/Cellar/postgresql@17/17.10/bin
 *   SOCK=/tmp/mink-credits-pg.$(openssl rand -hex 4)
 *   DATA=$(mktemp -d /tmp/mink-credits-data.XXXXXX); mkdir -p "$SOCK"
 *   LC_ALL=C $PG/initdb -D "$DATA" -U postgres --auth=trust
 *   LC_ALL=C $PG/pg_ctl -D "$DATA" \
 *     -o "-k $SOCK -p 55485 -c listen_addresses=''" -l "$DATA/log" start
 *   $PG/createdb -h "$SOCK" -p 55485 -U postgres mink_credits_verify
 *   MINK_RUN_CREDIT_TEST_SOCKET="$SOCK" PGUSER=postgres npx vitest run \
 *     lib/mink/run-credits.postgres.test.ts --coverage=false
 *   $PG/pg_ctl -D "$DATA" stop -m fast; rm -rf "$DATA" "$SOCK"
 *
 * ⚠ `LC_ALL=C` is not decoration — without it the Homebrew postmaster dies
 * "became multithreaded during startup" (scripts/db-local-ctl.sh hit the same
 * thing). Port 55485 keeps it clear of the 55483/55484 the sibling fixtures
 * use, and re-running needs a DROP + CREATE because the fixture refuses a
 * database that already has a `stores` table.
 *
 * ★★ WHY THIS EXISTS. run-credits.test.ts mocks the database, so it proves the
 * TypeScript decisions (the fold, the gating, failing open) and NOTHING about
 * `consume_mink_run_credits` itself — which is where the money actually moves.
 * Once MINK_CHARGE_CREDITS is switched on, a regression in the clamp would
 * refuse a merchant a run they had already been answered for, and one in the
 * idempotency key would charge them twice. Both are silent.
 *
 * It never reads application database credentials and is skipped in ordinary
 * runs, following memories.postgres.test.ts and proactive-responses.postgres.test.ts.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { postgresStringTimestampTypes } from "@/lib/db/pg-types";

const h = vi.hoisted(() => ({ pool: null as Pool | null }));
vi.mock("@/lib/db/client", () => ({
  withService: async (fn: (db: unknown) => unknown) => {
    const c = await h.pool!.connect();
    try {
      await c.query("BEGIN; SET LOCAL ROLE app_service");
      const result = await fn(drizzle(c));
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  },
}));
vi.mock("@/lib/ai/quota", () => ({
  currentPeriod: () => PERIOD,
  getAiUsage: vi.fn(),
}));

import { settleMinkRunCredits } from "./run-credits";
import type { MinkActorContext, MinkUsage } from "./types";

const socket = process.env.MINK_RUN_CREDIT_TEST_SOCKET;
const STORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0100";
const OTHER_STORE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0100";
const RUN = "cccccccc-cccc-4ccc-8ccc-cccccccc0100";
const ADMIN = "owner";
const PERIOD = "2099-01";

/** Call the function exactly as the application does. */
async function spend(over: Partial<Record<string, unknown>> = {}) {
  const args = {
    store: STORE,
    admin: ADMIN,
    run: RUN,
    period: PERIOD,
    cap: 20 as number | null,
    credits: 3,
    ...over,
  };
  const result = await h.pool!.query(
    `select public.consume_mink_run_credits($1::uuid,$2,$3::uuid,$4,$5,$6) as source`,
    [args.store, args.admin, args.run, args.period, args.cap, args.credits],
  );
  return result.rows[0].source as string;
}

const state = async () => {
  const ledger = await h.pool!.query(
    `select charged_credits, plan_credits, balance_credits, credit_source
     from mink_usage_ledger where run_id = $1`,
    [RUN],
  );
  const used = await h.pool!.query(
    `select used from ai_usage where store_id = $1 and period = $2`,
    [STORE, PERIOD],
  );
  const balance = await h.pool!.query(
    `select balance from ai_credit_balances where store_id = $1`,
    [STORE],
  );
  return {
    ...ledger.rows[0],
    used: used.rows[0]?.used ?? null,
    balance: balance.rows[0]?.balance ?? null,
  };
};

/** Put the store at a known position: `used` of a 20 cap, `balance` purchased. */
async function position(used: number, balance: number) {
  await h.pool!.query(
    `insert into ai_usage(store_id, period, used) values($1,$2,$3)
     on conflict (store_id, period) do update set used = $3`,
    [STORE, PERIOD, used],
  );
  await h.pool!.query(
    `insert into ai_credit_balances(store_id, balance) values($1,$2)
     on conflict (store_id) do update set balance = $2`,
    [STORE, balance],
  );
}

describe.skipIf(!socket)("0100 isolated PostgreSQL run-credit contract", () => {
  beforeAll(async () => {
    if (
      !socket ||
      !/^\/(private\/)?tmp\/mink-credits-pg\.[a-zA-Z0-9]+$/.test(socket)
    ) {
      throw new Error("Use a task-owned temporary socket");
    }
    h.pool = new Pool({
      host: socket,
      port: 55485,
      database: "mink_credits_verify",
      max: 5,
      types: postgresStringTimestampTypes,
    });
    if (
      (await h.pool.query("select to_regclass('stores') as found")).rows[0]
        .found
    ) {
      throw new Error("Use a fresh empty fixture database");
    }

    // Only what 0099/0100 touch, at the shapes production actually has — the
    // ledger deliberately starts PRE-0099 so both migrations run in sequence.
    await h.pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='app_user')
          THEN CREATE ROLE app_user; END IF;
        IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='app_service')
          THEN CREATE ROLE app_service BYPASSRLS; END IF;
      END $$;
      CREATE TABLE stores(id uuid PRIMARY KEY);
      CREATE TABLE mink_runs(
        id uuid PRIMARY KEY, store_id uuid NOT NULL REFERENCES stores(id),
        requested_by text NOT NULL,
        CONSTRAINT mink_runs_id_store_key UNIQUE (id, store_id));
      CREATE TABLE mink_usage_ledger(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        admin_id text NOT NULL,
        run_id uuid NOT NULL,
        model text NOT NULL DEFAULT 'gemini-3.7-flash',
        input_tokens integer NOT NULL DEFAULT 0,
        output_tokens integer NOT NULL DEFAULT 0,
        thought_tokens integer NOT NULL DEFAULT 0,
        total_tokens integer NOT NULL DEFAULT 0,
        charged_credits integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT mink_usage_ledger_run_key UNIQUE (run_id),
        CONSTRAINT mink_usage_ledger_run_store_fkey FOREIGN KEY (run_id, store_id)
          REFERENCES mink_runs(id, store_id) ON DELETE CASCADE,
        CONSTRAINT mink_usage_ledger_counts_check CHECK (charged_credits >= 0));
      CREATE TABLE ai_usage(
        store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        period text NOT NULL, used integer NOT NULL DEFAULT 0,
        PRIMARY KEY (store_id, period));
      CREATE TABLE ai_credit_balances(
        store_id uuid PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
        balance integer NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ai_credit_balances_balance_check CHECK (balance >= 0));
      CREATE TABLE ai_credit_ledger(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id uuid NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        delta integer NOT NULL, kind text NOT NULL, ref text, note text,
        created_at timestamptz NOT NULL DEFAULT now());
    `);

    const read = (file: string) =>
      readFileSync(
        new URL(`../../drizzle/migrations/sql/${file}`, import.meta.url),
        "utf8",
      );
    // Forward-only replay: applying twice must be safe, as a re-run in a
    // recovering environment would.
    for (const file of [
      "20260911_0099_mink_cached_tokens.sql",
      "20260911_0100_mink_run_credits.sql",
    ]) {
      await h.pool.query(read(file));
      await h.pool.query(read(file));
    }

    // The migration's own recorded postconditions, run against this database.
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../drizzle/migrations/manifest.json", import.meta.url),
        "utf8",
      ),
    );
    const entry = manifest.migrations.find(
      (m: { id: string }) => m.id === "20260911_0100_mink_run_credits",
    );
    for (const q of entry.applyVerify.queries) {
      expect(
        String(Object.values((await h.pool.query(q.sql)).rows[0])[0]),
        q.name,
      ).toBe(q.equals);
    }

    await h.pool.query("INSERT INTO stores VALUES($1),($2)", [
      STORE,
      OTHER_STORE,
    ]);
    await h.pool.query(
      "INSERT INTO mink_runs(id, store_id, requested_by) VALUES($1,$2,$3)",
      [RUN, STORE, ADMIN],
    );
  });

  beforeEach(async () => {
    await h.pool!.query(
      `insert into mink_usage_ledger(store_id, admin_id, run_id, model)
       values($1,$2,$3,'gemini-3.7-flash')
       on conflict (run_id) do update set
         charged_credits = 0, plan_credits = 0, balance_credits = 0,
         credit_source = null`,
      [STORE, ADMIN, RUN],
    );
    await h.pool!.query("delete from ai_credit_ledger");
  });

  afterAll(async () => {
    await h.pool?.end();
  });

  // 1 ── the expiring resource burns before the permanent one
  it("spends the monthly allowance before purchased credits", async () => {
    await position(18, 5); // 2 of plan left, 5 bought
    expect(await spend({ credits: 3 })).toBe("mixed");
    expect(await state()).toMatchObject({
      charged_credits: 3,
      plan_credits: 2,
      balance_credits: 1,
      credit_source: "mixed",
      used: 20,
      balance: 4,
    });
    const ledger = await h.pool!.query(
      "select delta, kind, ref from ai_credit_ledger",
    );
    expect(ledger.rows).toEqual([
      { delta: -1, kind: "spend", ref: `mink-run:${RUN}` },
    ]);
  });

  it("takes only the plan allowance when it covers the whole charge", async () => {
    await position(0, 5);
    expect(await spend({ credits: 3 })).toBe("plan");
    expect(await state()).toMatchObject({ balance: 5, used: 3 });
    expect(
      (await h.pool!.query("select 1 from ai_credit_ledger")).rowCount,
    ).toBe(0);
  });

  // 2 ── the NULL credit_source is the idempotency key
  it("returns the original outcome on replay and spends nothing twice", async () => {
    await position(18, 5);
    expect(await spend({ credits: 3 })).toBe("mixed");
    const first = await state();
    expect(await spend({ credits: 3 })).toBe("mixed");
    expect(await state()).toEqual(first);
    // A replay under DIFFERENT arguments must also change nothing: settlement
    // is a property of the run, not of what the caller asks for the second time.
    expect(await spend({ credits: 8 })).toBe("mixed");
    expect(await state()).toEqual(first);
  });

  it("survives two settlements racing on the same run", async () => {
    await position(18, 5);
    const [a, b] = await Promise.all([
      spend({ credits: 3 }),
      spend({ credits: 3 }),
    ]);
    expect([a, b]).toEqual(["mixed", "mixed"]);
    expect(await state()).toMatchObject({ charged_credits: 3, balance: 4 });
  });

  // 3 ── clamp, never refuse: the answer has already been delivered
  it("charges what is left and records 'short' rather than refusing", async () => {
    await position(19, 2); // 1 of plan + 2 bought = 3 against an 8-credit run
    expect(await spend({ credits: 8 })).toBe("short");
    expect(await state()).toMatchObject({
      charged_credits: 3,
      plan_credits: 1,
      balance_credits: 2,
      credit_source: "short",
      used: 20,
      balance: 0,
    });
  });

  it("records 'short' even when the store could pay nothing at all", async () => {
    await position(20, 0);
    expect(await spend({ credits: 8 })).toBe("short");
    expect(await state()).toMatchObject({
      charged_credits: 0,
      credit_source: "short",
      balance: 0,
    });
  });

  it("never drives the purchased balance below zero", async () => {
    // ai_credit_balances has CHECK (balance >= 0); an unclamped spend would
    // abort the transaction and lose the settlement entirely.
    await position(20, 1);
    await expect(spend({ credits: 20 })).resolves.toBe("short");
    expect(await state()).toMatchObject({ balance: 0 });
  });

  // 4 ── tenancy
  it("refuses a run that is not this store's and this admin's", async () => {
    await position(0, 10);
    await expect(spend({ admin: "someone-else" })).rejects.toThrow(
      "Mink run credit scope rejected",
    );
    await expect(spend({ store: OTHER_STORE })).rejects.toThrow(
      "Mink run credit scope rejected",
    );
    // …and nothing moved.
    expect(await state()).toMatchObject({
      credit_source: null,
      used: 0,
      balance: 10,
    });
  });

  // 5 ── 'none' is a settled fact, distinct from unsettled
  it("settles a run that owed nothing as 'none', not as NULL", async () => {
    await position(0, 10);
    expect(await spend({ credits: 0 })).toBe("none");
    expect(await state()).toMatchObject({
      credit_source: "none",
      charged_credits: 0,
      used: 0,
      balance: 10,
    });
    // Settled means settled: a later attempt cannot charge it.
    expect(await spend({ credits: 8 })).toBe("none");
    expect(await state()).toMatchObject({ charged_credits: 0, balance: 10 });
  });

  // 6 ── an unlimited plan
  it("settles an unlimited plan without touching any counter", async () => {
    await h.pool!.query("delete from ai_usage where store_id = $1", [STORE]);
    await position(0, 7);
    await h.pool!.query("delete from ai_usage where store_id = $1", [STORE]);
    expect(await spend({ cap: null, credits: 8 })).toBe("plan_unlimited");
    expect(await state()).toMatchObject({
      credit_source: "plan_unlimited",
      charged_credits: 0,
      used: null,
      balance: 7,
    });
  });

  // 7 ── the schema refuses values the function should never produce
  it("rejects a split that exceeds what was charged", async () => {
    await expect(
      h.pool!.query(
        `update mink_usage_ledger set charged_credits = 2, plan_credits = 2,
         balance_credits = 1 where run_id = $1`,
        [RUN],
      ),
    ).rejects.toThrow("mink_usage_ledger_credit_split_check");
  });

  it("rejects a negative split", async () => {
    await expect(
      h.pool!.query(
        `update mink_usage_ledger set plan_credits = -1 where run_id = $1`,
        [RUN],
      ),
    ).rejects.toThrow("mink_usage_ledger_credit_split_check");
  });

  it("rejects a credit_source outside the allowlist", async () => {
    await expect(
      h.pool!.query(
        `update mink_usage_ledger set credit_source = 'free' where run_id = $1`,
        [RUN],
      ),
    ).rejects.toThrow("mink_usage_ledger_credit_source_check");
  });

  it("rejects a request outside the bounded credit range", async () => {
    await expect(spend({ credits: -1 })).rejects.toThrow(
      "invalid Mink run credit request",
    );
    await expect(spend({ credits: 21 })).rejects.toThrow(
      "invalid Mink run credit request",
    );
  });

  // 8 ── the app login cannot spend
  it("denies the application login EXECUTE on the spend function", async () => {
    const granted = await h.pool!.query(
      `select has_function_privilege('app_user',
        'public.consume_mink_run_credits(uuid,text,uuid,text,integer,integer)',
        'execute') as granted`,
    );
    expect(granted.rows[0].granted).toBe(false);
  });

  // ── the production path, not just the SQL
  it("settleMinkRunCredits folds and spends through the real code path", async () => {
    await position(19, 5);
    const usage: MinkUsage = {
      promptTokens: 100_000,
      outputTokens: 2_000,
      thoughtTokens: 0,
      totalTokens: 102_000,
      cachedTokens: 0,
      basePromptTokens: 0,
    };
    // 110,000 weighted units -> heavy -> 8 credits, less the 5 a proposal in
    // this run already reserved = 3 outstanding. 1 of plan + 2 purchased.
    const source = await settleMinkRunCredits({
      actor: {
        storeId: STORE,
        adminId: ADMIN,
        effectivePlan: "free",
      } as MinkActorContext,
      runId: RUN,
      usage,
      steps: 1,
      status: "succeeded",
      usageKnown: true,
      alreadyCharged: 5,
      chargeCredits: true,
    });
    expect(source).toBe("mixed");
    expect(await state()).toMatchObject({
      charged_credits: 3,
      plan_credits: 1,
      balance_credits: 2,
      used: 20,
      balance: 3,
    });
  });
});
