import "server-only";

// ---------------------------------------------------------------------------
// The Mink credit-pack catalogue, read from `mink_credit_packs` (migration
// 0116). A platform operator owns every field; nothing here is compiled in.
//
// ★★ THERE IS NO CODE FALLBACK, DELIBERATELY. The previous version merged
// stored prices onto a hardcoded list, which was safe only while the sizes and
// identities were also hardcoded. Now that an operator can rename, resize,
// reprice, add and remove packs, falling back to a built-in list on a read
// failure would quote a catalogue that no longer exists — and, on the purchase
// path, charge a price nobody set. An unreadable catalogue is reported as no
// catalogue: the merchant is told top-ups are unavailable, which is recoverable,
// where a wrong charge is not.
// ---------------------------------------------------------------------------

import { asc, eq } from "drizzle-orm";
import { minkCreditPacks } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import type { CreditPack } from "@/lib/ai/credits";

function toPack(row: {
  id: string;
  name: string;
  credits: number;
  priceInr: number;
  popular: boolean;
}): CreditPack {
  return {
    id: row.id,
    name: row.name,
    credits: row.credits,
    priceInr: row.priceInr,
    // Omitted rather than `false` so the serialized shape stays the one the
    // client components already render.
    ...(row.popular ? { popular: true as const } : {}),
  };
}

/**
 * The catalogue, in the operator's chosen order.
 *
 * Live rather than cached: this is displayed immediately before a payment, and
 * the merchant must be quoted the price they will be charged.
 */
export async function getMinkCreditPacksLive(): Promise<CreditPack[]> {
  try {
    const rows = await withService((db) =>
      db
        .select({
          id: minkCreditPacks.id,
          name: minkCreditPacks.name,
          credits: minkCreditPacks.credits,
          priceInr: minkCreditPacks.priceInr,
          popular: minkCreditPacks.popular,
        })
        .from(minkCreditPacks)
        .orderBy(asc(minkCreditPacks.sortOrder), asc(minkCreditPacks.id)),
    );
    return rows.map(toPack);
  } catch (error) {
    logError("Mink credit packs: read failed", error);
    return [];
  }
}

/**
 * One pack, for the purchase path.
 *
 * Returns null on a read failure as well as on an unknown id — the caller
 * refuses the purchase either way, which is the only safe answer when the
 * price cannot be established.
 */
export async function getMinkCreditPackLive(
  packId: unknown,
): Promise<CreditPack | null> {
  if (typeof packId !== "string" || !packId) return null;
  try {
    const [row] = await withService((db) =>
      db
        .select({
          id: minkCreditPacks.id,
          name: minkCreditPacks.name,
          credits: minkCreditPacks.credits,
          priceInr: minkCreditPacks.priceInr,
          popular: minkCreditPacks.popular,
        })
        .from(minkCreditPacks)
        .where(eq(minkCreditPacks.id, packId))
        .limit(1),
    );
    return row ? toPack(row) : null;
  } catch (error) {
    logError("Mink credit packs: pack read failed", error, { packId });
    return null;
  }
}
