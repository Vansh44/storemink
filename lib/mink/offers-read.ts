import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  categories,
  offerProducts,
  offers,
  products,
  productVariants,
  stores,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import {
  describeReward,
  describeTrigger,
  rewardDescriptor,
} from "@/lib/offers/describe";
import { decodeReward, decodeTrigger } from "@/lib/offers/types";
import { resolveStoreSettings } from "@/lib/settings/registry";
import type { MinkActorContext } from "./types";

const MAX_SCOPE_ROWS = 400;

export type MinkOfferAvailability =
  | "running"
  | "disabled"
  | "scheduled"
  | "ended"
  | "redemption_limit_reached"
  | "budget_exhausted"
  | "automatic_offers_disabled";

export async function readMinkCurrentOffers(
  actor: MinkActorContext,
  input: { limit: number; now?: Date },
) {
  const now = input.now ?? new Date();
  const result = await withService(async (db) => {
    const [rows, storeRows] = await Promise.all([
      db
        .select({
          id: offers.id,
          name: offers.name,
          status: offers.status,
          delivery: offers.delivery,
          code: offers.code,
          priority: offers.priority,
          triggerType: offers.triggerType,
          triggerConfig: offers.triggerConfig,
          rewardType: offers.rewardType,
          rewardConfig: offers.rewardConfig,
          channels: offers.channels,
          validFrom: offers.validFrom,
          validUntil: offers.validUntil,
          maxRedemptions: offers.maxRedemptions,
          redemptionCount: offers.redemptionCount,
          budgetPaise: offers.budgetPaise,
          spentPaise: offers.spentPaise,
        })
        .from(offers)
        .where(eq(offers.storeId, actor.storeId))
        .orderBy(
          sql`case when ${offers.status} = 'active' then 0 else 1 end`,
          desc(offers.priority),
          desc(offers.createdAt),
          desc(offers.id),
        )
        .limit(input.limit + 1),
      db
        .select({ settings: stores.settings })
        .from(stores)
        .where(eq(stores.id, actor.storeId))
        .limit(1),
    ]);
    const offerIds = rows.slice(0, input.limit).map((row) => row.id);
    const scopeRows = offerIds.length
      ? await db
          .select({
            offerId: offerProducts.offerId,
            productId: offerProducts.productId,
            productName: products.name,
            variantId: offerProducts.variantId,
            variantName: productVariants.name,
            variantSku: productVariants.sku,
            categoryId: offerProducts.categoryId,
            categoryName: categories.name,
          })
          .from(offerProducts)
          .leftJoin(
            products,
            and(
              eq(offerProducts.productId, products.id),
              eq(products.storeId, actor.storeId),
            ),
          )
          .leftJoin(
            productVariants,
            and(
              eq(offerProducts.variantId, productVariants.id),
              eq(productVariants.storeId, actor.storeId),
            ),
          )
          .leftJoin(
            categories,
            and(
              eq(offerProducts.categoryId, categories.id),
              eq(categories.storeId, actor.storeId),
            ),
          )
          .where(
            and(
              eq(offerProducts.storeId, actor.storeId),
              inArray(offerProducts.offerId, offerIds),
            ),
          )
          .limit(MAX_SCOPE_ROWS + 1)
      : [];
    return { rows, scopeRows, settings: storeRows[0]?.settings };
  });

  const settings = resolveStoreSettings(
    (result.settings as Record<string, unknown> | null) ?? {},
    actor.effectivePlan,
  );
  const automaticOffersEnabled = settings["offers.autoApply"] === true;
  const bounded = result.rows.slice(0, input.limit);
  const scopeDataTruncated = result.scopeRows.length > MAX_SCOPE_ROWS;
  const scopes = offerScopes(
    result.scopeRows.slice(0, MAX_SCOPE_ROWS),
    scopeDataTruncated,
  );
  const current = bounded.map((row) => {
    const trigger = decodeTrigger(row.triggerType, row.triggerConfig);
    const reward = decodeReward(row.rewardType, row.rewardConfig);
    const availability = offerAvailability({
      status: row.status,
      delivery: row.delivery,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      maxRedemptions: row.maxRedemptions,
      redemptionCount: row.redemptionCount,
      budgetPaise: row.budgetPaise,
      spentPaise: row.spentPaise,
      automaticOffersEnabled,
      now: now.getTime(),
    });
    const appliesTo =
      scopes.get(row.id) ??
      (scopeDataTruncated ? incompleteScope() : allProductsScope());
    const scopeCount =
      appliesTo.products.length +
      appliesTo.variants.length +
      appliesTo.categories.length;
    return {
      name: row.name,
      availability,
      delivery:
        row.delivery === "code" || row.delivery === "link"
          ? row.delivery
          : "automatic",
      ...(row.delivery === "code" && row.code ? { code: row.code } : {}),
      reward: describeReward(rewardDescriptor(reward), { scopeCount }),
      trigger: describeTrigger(trigger.type, trigger.minSubtotal),
      // The order trigger and the discounted-item scope are independent. Keep
      // both in the model payload so "on any order" can never be mistaken for
      // "all products" when the reward is scoped to Almond shake.
      appliesTo,
      channels:
        Array.isArray(row.channels) && row.channels.length
          ? row.channels.slice(0, 2)
          : ["storefront", "pos"],
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      redemptions: row.redemptionCount,
      maxRedemptions: row.maxRedemptions,
      remainingBudget:
        row.budgetPaise === null
          ? null
          : Math.max(0, (row.budgetPaise - (row.spentPaise ?? 0)) / 100),
    };
  });

  return {
    runningCount: current.filter((offer) => offer.availability === "running")
      .length,
    automaticOffersEnabled,
    offers: current,
    truncated: result.rows.length > input.limit,
    dataAsOf: now.toISOString(),
    dashboardPath: "/dashboard/offers",
  };
}

type ScopeRow = {
  offerId: string;
  productId: string | null;
  productName: string | null;
  variantId: string | null;
  variantName: string | null;
  variantSku: string | null;
  categoryId: string | null;
  categoryName: string | null;
};

type NamedOfferScope = {
  allProducts: boolean;
  products: string[];
  variants: string[];
  categories: string[];
  summary: string;
  truncated: boolean;
};

function allProductsScope(): NamedOfferScope {
  return {
    allProducts: true,
    products: [],
    variants: [],
    categories: [],
    summary: "all products",
    truncated: false,
  };
}

function incompleteScope(): NamedOfferScope {
  return {
    allProducts: false,
    products: [],
    variants: [],
    categories: [],
    summary: "scope incomplete in this bounded read",
    truncated: true,
  };
}

function offerScopes(
  rows: ScopeRow[],
  truncated: boolean,
): Map<string, NamedOfferScope> {
  const grouped = new Map<
    string,
    {
      products: Map<string, string>;
      variants: Map<string, string>;
      categories: Map<string, string>;
    }
  >();
  for (const row of rows) {
    const group = grouped.get(row.offerId) ?? {
      products: new Map(),
      variants: new Map(),
      categories: new Map(),
    };
    if (row.productId) {
      group.products.set(row.productId, row.productName ?? "Unnamed product");
    }
    if (row.variantId) {
      const suffix = row.variantSku ? ` (SKU ${row.variantSku})` : "";
      group.variants.set(
        row.variantId,
        `${row.variantName ?? "Unnamed variant"}${suffix}`,
      );
    }
    if (row.categoryId) {
      group.categories.set(
        row.categoryId,
        row.categoryName ?? "Unnamed category",
      );
    }
    grouped.set(row.offerId, group);
  }

  return new Map(
    [...grouped].map(([offerId, group]) => {
      const productNames = [...group.products.values()];
      const variantNames = [...group.variants.values()];
      const categoryNames = [...group.categories.values()];
      const parts = [
        ...productNames,
        ...variantNames.map((name) => `variant ${name}`),
        ...categoryNames.map((name) => `all products in ${name}`),
      ];
      return [
        offerId,
        {
          allProducts: false,
          products: productNames,
          variants: variantNames,
          categories: categoryNames,
          summary: parts.join("; ") || "selected products",
          truncated,
        },
      ];
    }),
  );
}

function offerAvailability(input: {
  status: string;
  delivery: string;
  validFrom: string | null;
  validUntil: string | null;
  maxRedemptions: number | null;
  redemptionCount: number;
  budgetPaise: number | null;
  spentPaise: number;
  automaticOffersEnabled: boolean;
  now: number;
}): MinkOfferAvailability {
  if (input.status !== "active") return "disabled";
  if (
    input.maxRedemptions !== null &&
    input.redemptionCount >= input.maxRedemptions
  ) {
    return "redemption_limit_reached";
  }
  if (input.budgetPaise !== null && input.spentPaise >= input.budgetPaise) {
    return "budget_exhausted";
  }
  if (input.validFrom && input.now < Date.parse(input.validFrom)) {
    return "scheduled";
  }
  if (input.validUntil && input.now > Date.parse(input.validUntil)) {
    return "ended";
  }
  if (input.delivery === "automatic" && !input.automaticOffersEnabled) {
    return "automatic_offers_disabled";
  }
  return "running";
}
