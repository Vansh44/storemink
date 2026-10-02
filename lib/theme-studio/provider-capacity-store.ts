import "server-only";
import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import {
  coordinatedProviderCapacity,
  providerCapacityKey,
  type CapacityStore,
} from "./provider-capacity";

/** Each statement runs in a short service transaction. The capacity row lock
 * serializes admission across Cloud Run instances, not the provider call. */
export const postgresCapacityStore: CapacityStore = {
  async claim(key, id) {
    return withService(async (db) => {
      await db.execute(sql`set local statement_timeout = '5s'`);
      await db.execute(sql`select public.theme_studio_capacity_lock(${key})`);
      // now() is fixed at transaction start. A claimant that waited for a newly
      // created row can otherwise see its initial pause_until as in the future.
      // Admission and lease expiry must use the clock after the lock wait.
      await db.execute(
        sql`delete from public.theme_studio_provider_leases where scope_key=${key} and expires_at<=clock_timestamp()`,
      );
      const result = await db.execute<{ id: string; epoch: number }>(sql`
        insert into public.theme_studio_provider_leases(scope_key,id,epoch,expires_at)
        select c.scope_key, ${id}::uuid, c.epoch, clock_timestamp()+interval '11 minutes'
        from public.theme_studio_provider_capacity c
        where c.scope_key=${key} and c.pause_until<=clock_timestamp()
          and (select count(*) from public.theme_studio_provider_leases l where l.scope_key=c.scope_key)<c.capacity
        returning id, epoch`);
      return result.rows[0] ?? null;
    });
  },
  async renew(key, lease) {
    return withService(async (db) => {
      await db.execute(sql`set local statement_timeout = '5s'`);
      const result =
        await db.execute(sql`update public.theme_studio_provider_leases
        set expires_at=clock_timestamp()+interval '11 minutes'
        where scope_key=${key} and id=${lease.id}::uuid and expires_at>clock_timestamp() returning id`);
      return result.rows.length === 1;
    });
  },
  async release(key, lease, succeeded) {
    await withService(async (db) => {
      await db.execute(sql`set local statement_timeout = '5s'`);
      await db.execute(sql`select public.theme_studio_capacity_lock(${key})`);
      const removed =
        await db.execute(sql`delete from public.theme_studio_provider_leases
        where scope_key=${key} and id=${lease.id}::uuid and expires_at>clock_timestamp() returning id`);
      if (succeeded && removed.rows.length)
        await db.execute(sql`
        update public.theme_studio_provider_capacity
        set capacity=least(3,capacity+case when successes>=2 then 1 else 0 end),
            successes=case when successes>=2 then 0 else successes+1 end, updated_at=now()
        where scope_key=${key} and epoch=${lease.epoch} and capacity<3 and pause_until<=clock_timestamp()`);
    });
  },
  async pause(key, delayMs) {
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 120_000)
      throw new Error("Invalid provider cooldown");
    await withService(async (db) => {
      await db.execute(sql`set local statement_timeout = '5s'`);
      await db.execute(sql`select public.theme_studio_capacity_lock(${key})`);
      await db.execute(sql`update public.theme_studio_provider_capacity
        set capacity=1, successes=0, epoch=epoch+1,
            pause_until=greatest(pause_until,clock_timestamp()+${delayMs}*interval '1 millisecond'), updated_at=now()
        where scope_key=${key}`);
    });
  },
};

export function sharedProviderCapacity(
  project: string,
  location: string,
  model: string,
) {
  return coordinatedProviderCapacity(
    postgresCapacityStore,
    providerCapacityKey(project, location, model),
    {
      onCleanupError: (error) =>
        logError("theme studio provider permit cleanup failed", error),
    },
  );
}
