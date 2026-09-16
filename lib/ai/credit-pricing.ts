import "server-only";

import { eq } from "drizzle-orm";
import { minkCreditPackPrices } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import { DEFAULT_MINK_CREDIT_PACKS, type CreditPack } from "@/lib/ai/credits";

type PriceRow = { pack_id: string; price_inr: number };

export function resolveMinkCreditPacks(
  rows: readonly PriceRow[],
): CreditPack[] {
  const prices = new Map(rows.map((row) => [row.pack_id, row.price_inr]));
  return DEFAULT_MINK_CREDIT_PACKS.map((pack) => ({
    ...pack,
    priceInr: prices.get(pack.id) ?? pack.priceInr,
  }));
}

async function queryPrices(): Promise<PriceRow[]> {
  return withService((db) =>
    db
      .select({
        pack_id: minkCreditPackPrices.packId,
        price_inr: minkCreditPackPrices.priceInr,
      })
      .from(minkCreditPackPrices),
  );
}

/** Live because this value is displayed immediately before a payment. */
export async function getMinkCreditPacksLive(): Promise<CreditPack[]> {
  try {
    return resolveMinkCreditPacks(await queryPrices());
  } catch (error) {
    // An absent/unreadable override is equivalent to no override. Falling back
    // keeps checkout available while still using one known, safe catalog.
    logError("Mink credit pricing: read failed, using defaults", error);
    return DEFAULT_MINK_CREDIT_PACKS.map((pack) => ({ ...pack }));
  }
}

export async function getMinkCreditPackLive(
  packId: unknown,
): Promise<CreditPack | null> {
  if (typeof packId !== "string") return null;
  const base = DEFAULT_MINK_CREDIT_PACKS.find((pack) => pack.id === packId);
  if (!base) return null;
  try {
    const [row] = await withService((db) =>
      db
        .select({ priceInr: minkCreditPackPrices.priceInr })
        .from(minkCreditPackPrices)
        .where(eq(minkCreditPackPrices.packId, packId))
        .limit(1),
    );
    return { ...base, priceInr: row?.priceInr ?? base.priceInr };
  } catch (error) {
    logError("Mink credit pricing: pack read failed, using default", error, {
      packId,
    });
    return { ...base };
  }
}
