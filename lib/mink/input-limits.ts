import "server-only";
import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { MinkRequestError } from "./errors";
import { MINK_INPUT_FILES } from "./input-policy";
import type { MinkActorContext } from "./types";

/**
 * ★★ EVERY BUCKET HERE COUNTS FILES, AND ONE MESSAGE NOW CARRIES UP TO
 * `MINK_INPUT_FILES` OF THEM. These numbers were written when a message meant
 * exactly one provider call, so the owner bucket (5) became EQUAL to the
 * per-message file cap the moment multi-file attachments shipped: a single
 * five-file send spent the whole minute. And `submit()` re-extracts every
 * attachment on a retry — it rebuilds the message from scratch — so the first
 * retry after any mid-batch failure was refused with "the input limit was
 * reached", leaving the merchant unable to send that message, or any other
 * attachment, for up to a minute.
 *
 * ★ SO THE OWNER BUDGET IS DERIVED FROM `MINK_INPUT_FILES`, not restated
 * beside it. A literal 15 here is the same defect waiting for the next time
 * the file cap moves; expressing it as whole sends makes the relationship the
 * thing that is maintained. Three, not two, so a full send plus a full retry
 * still leaves a spare attempt.
 *
 * ⚠ THE STORE AND GLOBAL CEILINGS ARE DELIBERATELY UNCHANGED, and they are a
 * real tightening in MESSAGE terms: 30 files an hour was 30 attachment
 * messages and is now six five-file ones. That is a spend decision rather than
 * a defect — no single legal action can exhaust them, so a retry always fits —
 * and raising them multiplies the worst-case provider bill per store by five.
 * Raise `STORE_FILES_PER_HOUR` / `STORE_FILES_PER_DAY` if the ceiling, not the
 * average, turns out to bite.
 */
const OWNER_SENDS_PER_MINUTE = 3;
const OWNER_FILES_PER_MINUTE = OWNER_SENDS_PER_MINUTE * MINK_INPUT_FILES;
const STORE_FILES_PER_HOUR = 30;
const STORE_FILES_PER_DAY = 100;
const GLOBAL_FILES_PER_HOUR = 500;

/** Fail closed before decoding or calling Vertex; shared across Cloud Run instances. */
export async function reserveMinkInput(
  actor: MinkActorContext,
  requestKey: string,
) {
  const limits: [string, number, number][] = [
    [
      `mink-input-owner:${actor.storeId}:${actor.adminId}`,
      OWNER_FILES_PER_MINUTE,
      60,
    ],
    [`mink-input-store:${actor.storeId}`, STORE_FILES_PER_HOUR, 3600],
    [`mink-input-day:${actor.storeId}`, STORE_FILES_PER_DAY, 86400],
    ["mink-input-global", GLOBAL_FILES_PER_HOUR, 3600],
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
