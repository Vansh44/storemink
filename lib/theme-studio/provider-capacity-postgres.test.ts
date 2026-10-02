// Opt-in local integration: actual concurrent transactions, no provider calls.
import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnvConfig } from "@next/env";

const scoped = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withService: scoped.run }));
import { postgresCapacityStore } from "./provider-capacity-store";
import { providerCapacityKey, type CapacityLease } from "./provider-capacity";

function requireLease(
  value: Awaited<ReturnType<typeof postgresCapacityStore.claim>>,
): CapacityLease {
  if (!value || !("id" in value)) throw new Error("Expected a provider permit");
  return value;
}

it.skipIf(process.env.THEME_STUDIO_CAPACITY_DB_TEST !== "1")(
  "coordinates concurrent instances, cooldown recovery, expiry and service-only grants",
  async () => {
    loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
    const pool = new Pool({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: "postgres",
      password: process.env.DB_ADMIN_PASSWORD,
      max: 8,
      connectionTimeoutMillis: 5000,
    });
    const key = providerCapacityKey(randomUUID(), "local", "test");
    const clockKey = providerCapacityKey(randomUUID(), "local", "clock");
    scoped.run.mockImplementation(async (work) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local role app_service");
        const result = await work(drizzle(client));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    });
    try {
      // The capacity row can be committed after a claim transaction begins.
      // Its initial pause is already over in wall time; transaction-start now()
      // must not incorrectly deny admission. Force that ordering explicitly.
      scoped.run.mockImplementationOnce(async (work) => {
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query("set local role app_service");
          await pool.query("select pg_sleep(0.02)");
          await pool.query(
            "insert into theme_studio_provider_capacity(scope_key) values($1)",
            [clockKey],
          );
          const result = await work(drizzle(client));
          await client.query("commit");
          return result;
        } catch (error) {
          await client.query("rollback");
          throw error;
        } finally {
          client.release();
        }
      });
      const first = await postgresCapacityStore.claim(clockKey, randomUUID());
      expect(first).not.toBeNull();
      await postgresCapacityStore.release(clockKey, requireLease(first), false);
      const claimed = await Promise.all(
        Array.from({ length: 8 }, () =>
          postgresCapacityStore.claim(key, randomUUID()),
        ),
      );
      const leases = claimed.filter(
        (v): v is CapacityLease => v !== null && "id" in v,
      );
      expect(leases).toHaveLength(3);
      expect(
        (
          await pool.query(
            "select count(*)::int as n from theme_studio_provider_leases where scope_key=$1",
            [key],
          )
        ).rows[0].n,
      ).toBe(3);
      await postgresCapacityStore.pause(key, 15000);
      await Promise.all(
        leases.map((lease) => postgresCapacityStore.release(key, lease, true)),
      );
      const paused = await postgresCapacityStore.claim(key, randomUUID());
      expect(paused).toHaveProperty("retryAfterMs");
      expect(
        paused && "retryAfterMs" in paused && paused.retryAfterMs,
      ).toBeGreaterThan(10_000);
      expect(
        (
          await pool.query(
            "select capacity,successes from theme_studio_provider_capacity where scope_key=$1",
            [key],
          )
        ).rows[0],
      ).toEqual({ capacity: 1, successes: 0 });
      await pool.query(
        "update theme_studio_provider_capacity set pause_until=now() where scope_key=$1",
        [key],
      );
      for (let i = 0; i < 3; i++) {
        const lease = await postgresCapacityStore.claim(key, randomUUID());
        expect(lease).not.toBeNull();
        expect(await postgresCapacityStore.claim(key, randomUUID())).toBeNull();
        await postgresCapacityStore.release(key, requireLease(lease), true);
        // Duplicate or stale release cannot count another success.
        await postgresCapacityStore.release(key, requireLease(lease), true);
      }
      expect(
        (
          await pool.query(
            "select capacity,successes from theme_studio_provider_capacity where scope_key=$1",
            [key],
          )
        ).rows[0],
      ).toEqual({ capacity: 2, successes: 0 });
      const expired = requireLease(
        await postgresCapacityStore.claim(key, randomUUID()),
      );
      const ttl = (
        await pool.query(
          "select extract(epoch from (expires_at-clock_timestamp())) as seconds from theme_studio_provider_leases where id=$1",
          [expired.id],
        )
      ).rows[0].seconds;
      expect(Number(ttl)).toBeGreaterThan(110);
      expect(Number(ttl)).toBeLessThanOrEqual(120);
      await pool.query(
        "update theme_studio_provider_leases set expires_at=now()-interval '1 second' where id=$1",
        [expired.id],
      );
      expect(await postgresCapacityStore.renew(key, expired)).toBe(false);
      const replacement = requireLease(
        await postgresCapacityStore.claim(key, randomUUID()),
      );
      expect(replacement).not.toBeNull();
      await postgresCapacityStore.release(key, expired, true);
      expect(await postgresCapacityStore.renew(key, replacement!)).toBe(true);
      const permissions = (
        await pool.query(
          "select has_table_privilege('app_user','theme_studio_provider_leases','SELECT') as readable, has_function_privilege('app_user','theme_studio_capacity_lock(text)','EXECUTE') as callable",
        )
      ).rows[0];
      expect(permissions).toEqual({ readable: false, callable: false });
    } finally {
      await pool.query(
        "delete from theme_studio_provider_capacity where scope_key=any($1::text[])",
        [[key, clockKey]],
      );
      await pool.end();
    }
  },
  20000,
);
