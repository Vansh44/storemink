import "server-only";
import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { MinkRequestError } from "./errors";
import type { MinkActorContext } from "./types";
/** Fail closed before decoding or calling Vertex; shared across Cloud Run instances. */
export async function reserveMinkInput(
  actor: MinkActorContext,
  requestKey: string,
) {
  const limits: [string, number, number][] = [
    [`mink-input-owner:${actor.storeId}:${actor.adminId}`, 5, 60],
    [`mink-input-store:${actor.storeId}`, 30, 3600],
    [`mink-input-day:${actor.storeId}`, 100, 86400],
    ["mink-input-global", 500, 3600],
    // Check fixed-cardinality quotas first so a caller over quota cannot create
    // unbounded replay-key rows by supplying fresh request UUIDs.
    [
      `mink-input-replay:${actor.storeId}:${actor.adminId}:${requestKey}`,
      1,
      3600,
    ],
  ];
  for (const [key, max, seconds] of limits) {
    const allowed = await withService(async (db) => {
      const result = await db.execute(
        sql`select check_rate_limit(p_key => ${key}, p_max => ${max}, p_window_seconds => ${seconds}) as allowed`,
      );
      return (
        (result.rows[0] as { allowed?: boolean } | undefined)?.allowed === true
      );
    });
    if (!allowed)
      throw new MinkRequestError(
        "input_rate_limit",
        "This processing request was already used, or the input limit was reached. Wait before explicitly trying again.",
        429,
      );
  }
}
