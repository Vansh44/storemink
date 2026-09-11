"use server";

// POS Phase 2 — the sell path. `placePosSale` is the register's trust boundary
// and mirrors placeOrder (checkout-actions.ts, CODEBASE §12) exactly:
//
//   * the OPERATOR is resolved server-side (device-bound; never from the client)
//   * prices are RE-READ from the DB, store-scoped — the client's are ignored
//   * discounts are re-derived and capped, with manager approval above the cap
//   * tax is recomputed with computeTax + the GST place-of-supply split
//   * stock is reserved atomically AT THE REGISTER'S LOCATION
//   * writes run under the service role AFTER all of the above
//   * every failure unwinds the steps that already succeeded, in reverse
//
// There is no cross-statement transaction over the pool, hence the manual
// rollback chain — the same discipline placeOrder uses.

import {
  and,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { after } from "next/server";
import {
  sendPosReceipt,
  shouldSendDirectReceipt,
} from "@/lib/email/pos-receipt";
import { TENDER_LABEL } from "@/lib/pos/receipt";
import {
  getCreditBalance,
  getCreditBalances,
  issueCredit,
  spendCredit,
} from "@/lib/credit/store-credit";
import { withService } from "@/lib/db/client";
import { dbErrorMessage, isUniqueViolation } from "@/lib/db/errors";
import {
  DEFAULT_PHONE_DIAL,
  phoneLengthHint,
  resolveEnteredPhone,
  storedPhoneVariants,
} from "@/lib/phone";
import {
  newPosCustomerId,
  splitName,
  validatePosCheckoutDetails,
  validatePosCustomer,
  type PosCustomerInput,
} from "@/lib/pos/customer-claim";
import {
  inventoryLevels,
  customerCreditBalances,
  orderItems,
  orderPayments,
  orderReturns,
  orders,
  posShifts,
  productVariants,
  products,
  storeBillingSettings,
  storeLocations,
  taxClasses,
  users,
} from "@/drizzle/schema";
import type { OrderInsert } from "@/drizzle/schema";
import { resolvePosOperator } from "@/lib/pos/operator";
import { likePattern } from "@/lib/pos/search";
import { personLabel } from "@/lib/pos/person";
import { emitEvent } from "@/lib/notifications/record";
import { reportStockChanges } from "@/lib/inventory/alerts";
import { shortLinesAt } from "@/lib/inventory/reservations";
import { summariseItems } from "@/lib/notifications/format";
import { posCan, type PosActorRole } from "@/lib/pos/permissions";
import { posAudit } from "@/lib/pos/audit";
import { verifyPin } from "@/lib/pos/pin";
import {
  type ApprovableSale,
  saleFingerprint,
  signApprovalToken,
  verifyApprovalToken,
} from "@/lib/pos/approval";
import {
  posSessionConfigured,
  POS_SECRET_MISSING_ERROR,
} from "@/lib/pos/session";
import { posStaff, posStaffLocations } from "@/drizzle/schema";
import { posTotals } from "@/lib/pos/totals";
import { loadFirstOrderState } from "@/lib/offers/resolve";
import {
  bonusOffersToReserve,
  loadExhaustedOfferIds,
  loadOffersForRegister,
  recordOfferRedemptions,
  releaseOfferUses,
  reserveOfferUses,
  resolveOffersForCart,
  type ReservedOffer,
} from "@/lib/offers/cart";
import type { Offer, OnSalePriceMode } from "@/lib/offers/types";
import type { AppliedOffer } from "@/lib/offers/apply";
import { toPaise } from "@/lib/money/allocate";
import { variantEffectiveSelling } from "@/lib/pricing";
import { isPosDateRangeKey, posDateRange } from "@/lib/pos/date-range";
import {
  accountTenderTotal,
  settleTenders,
  validateTenderShape,
  type PosTender,
} from "@/lib/pos/tenders";
import {
  counterGatewayKeyId,
  startCounterPayment,
  verifyCounterPayment,
  verifyGatewayTenders,
} from "@/lib/payments/pos-gateway";
import { isIntraState, isValidGstinFormat, splitGst } from "@/lib/billing/gst";
import { rowToBillingSettings, rowToTaxClass } from "@/lib/billing/types";
import { getStoreSettings } from "@/lib/settings/resolve";
import { rateLimit } from "@/lib/rate-limit";
import { buildReceiptModel, type ReceiptModel } from "@/lib/pos/receipt";
import { getStoreBrandById } from "@/lib/store/brand";
import { logError } from "@/lib/observability/logger";

// Bounds on client-supplied cart data (mirrors checkout-actions).
const MAX_LINE_ITEMS = 200;
const MAX_QTY_PER_LINE = 1000;

export interface PosCartLine {
  productId: string;
  variantId: string | null;
  quantity: number;
  /** Cashier's per-line discount in rupees (validated against the cap). */
  lineDiscount?: number;
  /** Cashier-entered price override in rupees (gated by pos.allowPriceOverride). */
  priceOverride?: number | null;
}

// The tender vocabulary, the allowlist and the coverage math moved to
// lib/pos/tenders.ts when the collection counter became a second place money is
// taken (§23). Re-exported so importers are unchanged — types are erased, so a
// type re-export from a "use server" file is not an endpoint.
export type { PosTender, PosTenderMethod } from "@/lib/pos/tenders";

export interface PosSaleResult {
  success?: boolean;
  error?: string;
  /** Set when the action needs a manager PIN to proceed. */
  needsApproval?: boolean;
  orderId?: string;
  receiptNo?: string;
  orderRef?: string;
  changeDue?: number;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Aliased select preserving the snake_case shape rowToBillingSettings expects.
const BILLING_COLS = {
  store_id: storeBillingSettings.storeId,
  tax_enabled: storeBillingSettings.taxEnabled,
  prices_include_tax: storeBillingSettings.pricesIncludeTax,
  default_tax_class_id: storeBillingSettings.defaultTaxClassId,
  business_name: storeBillingSettings.businessName,
  business_address: storeBillingSettings.businessAddress,
  tax_id: storeBillingSettings.taxId,
  contact_email: storeBillingSettings.contactEmail,
  contact_phone: storeBillingSettings.contactPhone,
  logo_url: storeBillingSettings.logoUrl,
  invoice_prefix: storeBillingSettings.invoicePrefix,
  accent_color: storeBillingSettings.accentColor,
  footer_note: storeBillingSettings.footerNote,
  terms: storeBillingSettings.terms,
  template: storeBillingSettings.template,
};

// ---- Register config -------------------------------------------------------

export interface RegisterConfig {
  /** Scope the client-side catalog cache — one cached catalog per register,
   *  since stock is per-location and a browser can be shared between stores. */
  storeId: string;
  locationId: string;
  locationName: string;
  operatorName: string;
  role: PosActorRole;
  taxEnabled: boolean;
  gstEnabled: boolean;
  pricesIncludeTax: boolean;
  /** Tax-class id → rate (%). Sent once at register open so the sell screen can
   *  quote the SAME total placePosSale will charge. Rates live here rather than
   *  baked into the cached catalog because the catalog persists in IndexedDB —
   *  a rate change would otherwise stay stale until the next background sync. */
  taxRates: Record<string, number>;
  /** Applied to products with no tax class of their own. */
  defaultTaxClassId: string | null;
  currency: string;
  /** Whether to render the discount fields at all. The SERVER still refuses a
   *  discount from anyone else — this only keeps a control off the screen that
   *  the cashier would be told off for using. It replaces the cap/approval
   *  numbers that used to ride here unread: the client must not hold the
   *  discount policy, only the answer. */
  canDiscount: boolean;
  /** Same, for a line's price. Replaces the raw `allowPriceOverride` setting:
   *  the merchant's on/off switch is only half the answer, and shipping half an
   *  answer to the client is how a UI ends up offering what the server refuses.
   *  (No override control exists on the register yet — this is what one would
   *  ask.) */
  canOverridePrice: boolean;
  /** Whether the till may take a VERIFIED gateway payment (Step 12). The same
   *  `canDiscount` rule: the client gets the ANSWER, never the policy, and a
   *  control that would always fail in front of a customer never renders. */
  onlinePayments: boolean;
  /** Public Razorpay key id — needed by checkout.js, and safe to ship. */
  gatewayKeyId: string | null;
  /** Header for the payment modal, so the customer sees who they are paying. */
  storeName: string;
  /**
   * The store's live offers and the policy to price them under.
   *
   * ★ SHIPPED TO THE CLIENT FOR THE SAME REASON `taxRates` IS: the sell screen
   * must quote what `placePosSale` will charge, and the register's design goal
   * is to price without waiting on the network. The screen runs the same pure
   * engine (`lib/offers/apply.ts`); the server re-resolves authoritatively.
   *
   * ★ HERE AND NOT IN THE CACHED CATALOGUE, which persists in IndexedDB — an
   * ended offer or a spent budget would otherwise keep being quoted to
   * customers until the next background sync.
   *
   * ⚠ No customer is attached when a register opens, so per-customer caps are
   * not resolved in this list. `resolvePosCustomerByPhone` returns the ids that
   * customer has used up so the screen can re-price at Charge, and
   * `reserve_offer_use` refuses atomically at completion either way.
   */
  offers: Offer[];
  offerPolicy: {
    onSalePrice: OnSalePriceMode;
    maxTotalDiscountPercent: number;
    autoApply: boolean;
  };
}

export async function getRegisterConfig(): Promise<
  RegisterConfig | { error: string }
> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };

  const [
    billingRows,
    locRows,
    settings,
    classRows,
    gatewayKeyId,
    brand,
    offerBundle,
  ] = await Promise.all([
    withService((db) =>
      db
        .select({
          tax_enabled: storeBillingSettings.taxEnabled,
          prices_include_tax: storeBillingSettings.pricesIncludeTax,
          gst_enabled: storeBillingSettings.gstEnabled,
          default_tax_class_id: storeBillingSettings.defaultTaxClassId,
        })
        .from(storeBillingSettings)
        .where(eq(storeBillingSettings.storeId, op.storeId))
        .limit(1),
    ).catch(() => []),
    withService((db) =>
      db
        .select({ name: storeLocations.name })
        .from(storeLocations)
        .where(eq(storeLocations.id, op.locationId))
        .limit(1),
    ).catch(() => []),
    getStoreSettings(),
    withService((db) =>
      db
        .select({ id: taxClasses.id, rate: taxClasses.rate })
        .from(taxClasses)
        .where(eq(taxClasses.storeId, op.storeId)),
    ).catch(() => []),
    // Losing this costs the online tender, never the till: a register that
    // cannot open because the gateway lookup blipped is far worse than one
    // that quietly offers cash, card and UPI for a minute.
    counterGatewayKeyId(op.storeId).catch(() => null),
    getStoreBrandById(op.storeId).catch(() => null),
    // Fails open to no offers on its own — a register that cannot open is a
    // shop that cannot trade, while a register with no offers is a shop
    // selling at full price. Joins this concurrent batch rather than adding a
    // serial read, because statements inside one `withService` share a client
    // and run one after another (Step 20).
    loadOffersForRegister(op.storeId),
  ]);

  const taxRates: Record<string, number> = {};
  for (const c of classRows) {
    if (c.id) taxRates[c.id] = Number(c.rate) || 0;
  }

  return {
    storeId: op.storeId,
    locationId: op.locationId,
    locationName: locRows[0]?.name ?? "Location",
    operatorName: op.name,
    role: op.role,
    taxEnabled: !!billingRows[0]?.tax_enabled,
    gstEnabled: !!billingRows[0]?.gst_enabled,
    pricesIncludeTax: !!billingRows[0]?.prices_include_tax,
    taxRates,
    defaultTaxClassId: billingRows[0]?.default_tax_class_id ?? null,
    currency: "INR",
    canDiscount:
      settings["pos.ownerOnlyDiscounts"] === false ||
      posCan(op.role, "discount"),
    canOverridePrice:
      settings["pos.allowPriceOverride"] !== false &&
      (settings["pos.ownerOnlyDiscounts"] === false ||
        posCan(op.role, "price_override")),
    onlinePayments: !!gatewayKeyId,
    gatewayKeyId,
    storeName: brand?.name ?? "Store",
    offers: offerBundle.offers,
    offerPolicy: offerBundle.policy,
  };
}

// ---- Gateway payments at the counter (Step 12) -----------------------------
//
// TWO actions, because the cashier must know the money landed BEFORE the sale
// completes. `placePosSale` re-verifies anyway — it is independently reachable
// and cannot assume either of these ran — but discovering a failed payment at
// "Complete sale", with the customer already walking away, is not a counter
// flow anyone should ship.

/**
 * Open a gateway payment for one leg of a sale.
 *
 * The amount is the CASHIER's — see `startCounterPayment` for why it is not
 * re-priced from the cart. Nothing is recorded here: an abandoned modal must
 * leave no trace, and a Razorpay order that is never paid simply lapses.
 */
export async function startPosGatewayPayment(
  amountPaise: number,
  /**
   * The cart, so the shelf can be checked BEFORE the customer pays.
   *
   * ★★ THIS IS THE WHOLE POINT OF PASSING IT. Stock is reserved when the sale
   * COMPLETES, so without this a cashier takes ₹500 and only then learns the
   * shelf is empty — captured money against a sale that cannot finish, needing
   * a dashboard refund. The check costs one read and refuses while refusing is
   * still free.
   *
   * ⚠ IT IS A COURTESY, NOT A GUARANTEE. Nothing is held; `reserve_stock_at`
   * at completion remains the only thing that can promise stock. Optional, so
   * a caller that has no cart to offer still works.
   */
  lines?: PosCartLine[],
): Promise<
  { rzpOrderId: string; keyId: string; amountPaise: number } | { error: string }
> {
  const op = await resolvePosOperator();
  if (!op) return { error: "You're signed out. Please sign in again." };
  if (!posCan(op.role, "sell")) {
    return { error: "You don't have permission to take payments." };
  }
  // Opening gateway orders is cheap for us and noisy on the merchant's
  // account; a stuck button must not be able to mint hundreds of them.
  const rl = await rateLimit(`pos-gw:${op.staffId ?? op.storeId}`, {
    max: 60,
    windowSeconds: 60,
  });
  if (!rl.allowed)
    return { error: "Too many payment attempts. Wait a moment." };

  // ★ BEFORE the gateway order, so a short shelf costs nothing at all — not
  // even an abandoned Razorpay order on the merchant's account.
  if (Array.isArray(lines) && lines.length > 0) {
    const short = await shortLinesAt(
      op.storeId,
      op.locationId,
      lines.map((l) => ({
        productId: l.productId,
        variantId: l.variantId ?? null,
        quantity: l.quantity,
      })),
    );
    if (short.length > 0) {
      const first = short[0];
      return {
        error:
          first.available > 0
            ? `Only ${first.available} left of one item at this location. Adjust the cart before taking payment.`
            : "One of these items has just sold out at this location. Adjust the cart before taking payment.",
      };
    }
  }

  const res = await startCounterPayment(op.storeId, {
    amountPaise,
    locationId: op.locationId,
  });
  return res.ok ? res.data : { error: res.error };
}

/**
 * Did that payment actually land? Server-verified, never the modal's word.
 *
 * ★ THE CLIENT'S CALLBACK IS AN INPUT, NOT AN ANSWER. It supplies the ids and a
 * signature; what settles the question is Razorpay's own record of a CAPTURED
 * INR payment for the exact amount. §34 states the same rule for every
 * on-session StoreMink payment.
 */
export async function confirmPosGatewayPayment(input: {
  rzpOrderId: string;
  paymentId: string;
  signature: string;
  amountPaise: number;
}): Promise<{ paymentId: string; amountPaise: number } | { error: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "You're signed out. Please sign in again." };
  if (!posCan(op.role, "sell")) {
    return { error: "You don't have permission to take payments." };
  }
  const res = await verifyCounterPayment(op.storeId, {
    paymentId: input?.paymentId,
    rzpOrderId: input?.rzpOrderId,
    signature: input?.signature,
    expectedPaise: input?.amountPaise,
  });
  return res.ok ? res.data : { error: res.error };
}

// ---- Catalog lookup (search + barcode) -------------------------------------

export interface PosCatalogItem {
  productId: string;
  variantId: string | null;
  name: string;
  variantName: string | null;
  sku: string | null;
  barcode: string | null;
  price: number;
  image: string | null;
  /** Live stock at THIS register's location (null = untracked). */
  stock: number | null;
  trackInventory: boolean;
  allowBackorder: boolean;
  /** The product's tax class, resolved to a RATE on the client via
   *  RegisterConfig.taxRates. Carried so the sell screen can quote the
   *  tax-inclusive total without a round trip (see lib/pos/totals.ts). */
  taxClassId: string | null;
  /**
   * The product's category, for offer scoping.
   *
   * ★ CARRIED EVEN THOUGH PHASE A SHIPS NO UI FOR A CATEGORY-SCOPED OFFER.
   * The engine and `placePosSale` both honour `offer_products` already, so a
   * client that cannot see the category would quote a DIFFERENT total from the
   * one charged the moment such an offer exists — by any route, including a
   * direct insert. The catalogue cache key carries a SCHEMA_VERSION precisely
   * so adding a field the register depends on forces a re-sync rather than
   * serving a stale shape.
   */
  categoryId: string | null;
}

// The sellable-catalog projection, shared by the interactive lookup and the
// full snapshot the client caches, so the two can never disagree about what a
// SKU costs or how much of it is on hand.
const CATALOG_COLS = {
  product_id: products.id,
  variant_id: productVariants.id,
  name: products.name,
  variant_name: productVariants.name,
  p_sku: products.sku,
  v_sku: productVariants.sku,
  p_barcode: products.barcode,
  v_barcode: productVariants.barcode,
  p_price: products.sellingPrice,
  v_price: productVariants.sellingPrice,
  v_special: productVariants.specialPrice,
  p_image: products.imageUrl,
  v_image: productVariants.imageUrl,
  p_track: products.trackInventory,
  v_track: productVariants.trackInventory,
  p_backorder: products.allowBackorder,
  v_backorder: productVariants.allowBackorder,
  p_stock: products.stock,
  v_stock: productVariants.stock,
  // Stock AT THIS REGISTER'S LOCATION. products.stock is the aggregate across
  // every location, so a two-location store would otherwise show (and let a
  // cashier ring up) stock sitting in the other shop.
  loc_stock: inventoryLevels.onHand,
  p_tax_class: products.taxClassId,
  p_category: products.categoryId,
};

/** Mirrors CATALOG_COLS. Written out rather than inferred so a schema change
 *  that alters a column's nullability fails HERE, at the mapper, instead of
 *  silently producing a NaN price or a null name on the register. */
interface CatalogRow {
  product_id: string;
  variant_id: string | null;
  name: string;
  variant_name: string | null;
  p_sku: string | null;
  v_sku: string | null;
  p_barcode: string | null;
  v_barcode: string | null;
  p_price: number | null;
  v_price: number | null;
  v_special: number | null;
  p_image: string | null;
  v_image: string | null;
  p_track: boolean | null;
  v_track: boolean | null;
  p_backorder: boolean | null;
  v_backorder: boolean | null;
  p_stock: number | null;
  v_stock: number | null;
  loc_stock: number | null;
  p_tax_class: string | null;
  p_category: string | null;
}

function mapCatalogRow(r: CatalogRow): PosCatalogItem {
  const isVariant = !!r.variant_id;
  // Only variants carry a special price; a product's selling price is final.
  const special = isVariant ? r.v_special : null;
  const base = (isVariant ? r.v_price : r.p_price) ?? 0;
  return {
    productId: r.product_id,
    variantId: r.variant_id,
    name: r.name,
    variantName: r.variant_name,
    sku: (isVariant ? r.v_sku : r.p_sku) ?? null,
    barcode: (isVariant ? r.v_barcode : r.p_barcode) ?? null,
    price: special && special > 0 ? special : base,
    // A variant with no image of its own falls back to the product's.
    image: (isVariant ? r.v_image : r.p_image) ?? r.p_image ?? null,
    stock: r.loc_stock ?? (isVariant ? (r.v_stock ?? 0) : (r.p_stock ?? 0)),
    trackInventory: isVariant ? !!r.v_track : !!r.p_track,
    allowBackorder: isVariant ? !!r.v_backorder : !!r.p_backorder,
    taxClassId: r.p_tax_class ?? null,
    categoryId: r.p_category ?? null,
  };
}

/** Join every sellable SKU to its on-hand level at the operator's location. */
const locationStockJoin = (locationId: string) =>
  and(
    eq(inventoryLevels.productId, products.id),
    eq(inventoryLevels.locationId, locationId),
    sql`${inventoryLevels.variantId} is not distinct from ${productVariants.id}`,
  );

/**
 * Search the catalog for the register: an exact barcode/SKU hit first (a scan),
 * otherwise a name match. Returns MULTIPLE rows when one barcode maps to
 * several variants so the register can disambiguate rather than guessing —
 * mislabelled supplier barcodes are common in retail.
 *
 * This is the FALLBACK path once the client-side catalog cache is warm
 * (lib/pos/use-catalog.ts) — it still runs for cache misses, which is what
 * lets a product added since the last sync be sold immediately.
 */
export async function lookupProducts(
  query: string,
  limit = 24,
): Promise<{ items: PosCatalogItem[]; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { items: [], error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { items: [], error: "Not allowed." };

  const q = typeof query === "string" ? query.trim().slice(0, 100) : "";
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 24, 1), 100);

  try {
    const rows = await withService(async (db) => {
      const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      // One query over the variant-aware catalog: every sellable SKU is either
      // a variant row or a variant-less product row.
      return db
        .select(CATALOG_COLS)
        .from(products)
        .leftJoin(productVariants, eq(productVariants.productId, products.id))
        .leftJoin(inventoryLevels, locationStockJoin(op.locationId))
        .where(
          and(
            eq(products.storeId, op.storeId),
            eq(products.status, "published"),
            q
              ? or(
                  eq(products.barcode, q),
                  eq(productVariants.barcode, q),
                  eq(products.sku, q),
                  eq(productVariants.sku, q),
                  ilike(products.name, pattern),
                )
              : undefined,
          ),
        )
        .limit(safeLimit);
    });

    const items: PosCatalogItem[] = rows.map(mapCatalogRow);

    // An exact barcode/SKU scan should win over fuzzy name matches.
    if (q) {
      const exact = items.filter((i) => i.barcode === q || i.sku === q);
      if (exact.length > 0) return { items: exact };
    }
    return { items };
  } catch (err) {
    return { items: [], error: dbErrorMessage(err, "Couldn't load products.") };
  }
}

// ---- Catalog snapshot (client-side cache) ----------------------------------

/** Products per page. Paged so a large catalog streams in the background
 *  instead of arriving as one payload that stalls the register's first paint. */
const CATALOG_PAGE_PRODUCTS = 300;

export interface CatalogPage {
  items: PosCatalogItem[];
  /** Pass back to continue; null when the catalog is fully drained. */
  nextCursor: string | null;
  /**
   * Products that have LEFT the catalogue since `since` (roadmap Step 19).
   *
   * ★★ A DELTA THAT ONLY SENDS CHANGES IS WRONG. The query filters on
   * `status = 'published'`, so an unpublished product simply stops matching —
   * the register would keep selling something the merchant withdrew. These are
   * the ids to drop. Empty on a full sync, where the item list IS the truth.
   */
  removedProductIds?: string[];
  /**
   * The server clock to pass as `since` next time. Server-issued, never the
   * browser's: a till whose clock is minutes fast would skip everything
   * changed in between, permanently.
   */
  watermark?: string;
  error?: string;
}

/**
 * Overlap re-sent on every delta.
 *
 * ★ A row written DURING the sync would otherwise fall in the gap between the
 * watermark and the next `since`, and never be sent again. Re-sending a few
 * seconds of changes is free — the merge is an upsert — while missing one is
 * a stale price at a counter forever.
 */
const DELTA_OVERLAP_SECONDS = 10;

/**
 * A page of the FULL sellable catalog for the operator's location, for the
 * client-side cache (lib/pos/use-catalog.ts) that makes search and scan
 * resolve locally with no network — docs/pos-plan.md §10.
 *
 * Paging is keyset over `products.id` (not OFFSET), so pages stay stable and
 * cheap while the catalog is being edited underneath the sync. Whole products
 * are fetched per page — the page size counts products, not joined rows, so a
 * product with 40 variants can never be split across a page boundary and lose
 * variants at the seam.
 */
export async function getCatalogSnapshot(
  cursor?: string | null,
  /**
   * Only what changed after this instant (roadmap Step 19). Omit for a full
   * pull — which stays the recovery path and the only thing that can notice a
   * HARD-deleted product, since a deleted row cannot appear in any delta.
   *
   * ★ MUST BE A WATERMARK THIS SERVER ISSUED. Accepting a browser clock would
   * let a fast till skip everything changed in between, permanently.
   */
  since?: string | null,
): Promise<CatalogPage> {
  const op = await resolvePosOperator();
  if (!op) return { items: [], nextCursor: null, error: "Not signed in." };
  if (!posCan(op.role, "sell"))
    return { items: [], nextCursor: null, error: "Not allowed." };

  const after = typeof cursor === "string" && cursor ? cursor : null;
  // An unparseable `since` degrades to a FULL sync rather than an empty delta.
  // Sending nothing would look like "no changes" and leave the till stale.
  const sinceAt =
    typeof since === "string" && since && !Number.isNaN(Date.parse(since))
      ? new Date(since)
      : null;
  // Capture once, before page 1 reads. The client keeps this first/earliest
  // watermark across the whole paged run, so writes during a long sync are
  // guaranteed to appear in the next delta.
  const syncWatermark = new Date(
    Date.now() - DELTA_OVERLAP_SECONDS * 1000,
  ).toISOString();

  try {
    const result = await withService(async (db) => {
      // A delta pages over ALL changed product rows, not just published ones.
      // That makes withdrawals first-class page members rather than a second,
      // unpaginated query that could silently cap at 300 removals.
      const page = await db
        .select({ id: products.id, status: products.status })
        .from(products)
        .where(
          and(
            eq(products.storeId, op.storeId),
            sinceAt ? undefined : eq(products.status, "published"),
            after ? gt(products.id, after) : undefined,
            // ★ `products.updated_at` is bumped by a BEFORE UPDATE trigger
            // (`update_catalog_updated_at`) on EVERY write to the row, so it
            // covers content edits AND stock: the inventory aggregate trigger
            // updates products.stock, which fires it too. Verified against the
            // live schema 2026-08-21.
            //
            // ⚠ `product_variants` has NO `updated_at` column, so variants are
            // covered only INDIRECTLY — a variant's stock moves through the
            // same aggregate, and the product editor writes the product row on
            // save. A future variant-only write path that skips the product row
            // would go unnoticed by this delta. Pinned by a test.
            sinceAt ? gt(products.updatedAt, sinceAt.toISOString()) : undefined,
          ),
        )
        .orderBy(products.id)
        .limit(CATALOG_PAGE_PRODUCTS);
      if (page.length === 0) return { page, rows: [] };

      const publishedIds = page
        .filter((product) => product.status === "published")
        .map((product) => product.id);
      if (publishedIds.length === 0) return { page, rows: [] };

      // Then every sellable SKU for the published members of this page.
      const rows = await db
        .select(CATALOG_COLS)
        .from(products)
        .leftJoin(productVariants, eq(productVariants.productId, products.id))
        .leftJoin(inventoryLevels, locationStockJoin(op.locationId))
        .where(inArray(products.id, publishedIds))
        .orderBy(products.id);
      return { page, rows };
    });

    const items = result.rows.map(mapCatalogRow);
    // A short page means the catalog is drained. Cursor is the last product id
    // of the page, which the ORDER BY guarantees is its maximum.
    const nextCursor =
      result.page.length < CATALOG_PAGE_PRODUCTS
        ? null
        : (result.page[result.page.length - 1]?.id ?? null);

    const removedProductIds = sinceAt
      ? result.page
          .filter((product) => product.status !== "published")
          .map((product) => product.id)
      : undefined;

    // Full pulls issue a watermark too; without it the client can never enter
    // delta mode. A hard-deleted product still requires the periodic full
    // reconcile because no remaining row can name it.
    return {
      items,
      nextCursor,
      ...(removedProductIds ? { removedProductIds } : {}),
      watermark: syncWatermark,
    };
  } catch (err) {
    return {
      items: [],
      nextCursor: null,
      error: dbErrorMessage(err, "Couldn't load the catalog."),
    };
  }
}

// ---- Customer attach -------------------------------------------------------

export interface PosCustomer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  /** Store-credit balance (§29). Rides along with the customer so attaching one
   *  brings their balance without a second round trip at the counter. */
  storeCredit: number;
}

/**
 * The one message for a number that cannot be stored.
 *
 * ★ IT NAMES A LENGTH, NOT A COUNTRY. It used to read "Enter a valid 10-digit
 * Indian mobile number" for every failure, which is wrong as soon as the
 * register accepts another country's code — and it was also what a cashier saw
 * for a perfectly well-formed placeholder number that only the courier cared
 * about.
 */
function numberLengthError(dial: string): string {
  const hint = phoneLengthHint(dial);
  return hint
    ? `Enter the ${hint}-digit number for ${dial}.`
    : "Choose a country code and enter the number.";
}

/** The extras a resolved customer carries, so the quote matches the charge. */
type PosCustomerContext = {
  exhaustedOfferIds?: string[];
  isFirstOrder?: boolean;
};

/**
 * Read the offer caps and first-order state a resolved customer needs.
 *
 * ★ RIDES ALONG WITH THE LOOKUP RATHER THAN TAKING ITS OWN ROUND TRIP. A
 * register opens with nobody attached, so a per-customer offer cap and a
 * first-order discount cannot be resolved then — and without these the till
 * would quote an offer the server refuses at completion, or a total WITHOUT
 * the new-customer discount while `placePosSale` charges WITH it. That is the
 * divergence `lib/pos/totals.ts` exists to prevent (CODEBASE §22).
 *
 * Both halves fail silently to the closed direction: the atomic reservation
 * still refuses at completion, and neither may ever block attaching a
 * customer to a sale.
 */
async function posCustomerContext(
  storeId: string,
  customerId: string,
): Promise<PosCustomerContext> {
  const [exhaustedOfferIds, firstOrder] = await Promise.all([
    loadExhaustedOfferIds(storeId, customerId),
    withService((db) => loadFirstOrderState(db, storeId, customerId)).catch(
      () => false,
    ),
  ]);
  return { exhaustedOfferIds, isFirstOrder: firstOrder === true };
}

const posCustomerColumns = {
  id: users.id,
  phone: users.phone,
  email: users.email,
  first_name: users.firstName,
  last_name: users.lastName,
  store_credit: customerCreditBalances.balance,
};

function posCustomerFrom(row: {
  id: string;
  phone: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  store_credit: unknown;
}): PosCustomer {
  return {
    id: row.id,
    name:
      [row.first_name, row.last_name].filter(Boolean).join(" ").trim() ||
      row.phone,
    phone: row.phone,
    email: row.email,
    storeCredit: Number(row.store_credit) || 0,
  };
}

/**
 * Look up the exact mobile entered at Checkout. Deliberately submit-only:
 * typing in the till never runs a query.
 *
 * ★★ IT NO LONGER CREATES ANYTHING. It used to insert a phone-only customer
 * the moment a number did not match, which is why a shop ended up with
 * "Customer / no email" rows beside the same person's real account: the
 * lookup could not see an account stored in the other phone shape (see
 * `storedPhoneVariants`), so it invented a duplicate instead of finding them.
 * Creation now belongs to `createPosCheckoutCustomer`, after the cashier has
 * had the chance to put a name to the number.
 *
 * @returns the customer when the number is known, or `notFound` so the caller
 * can collect their details. `notFound` is NOT an error: a number nobody has
 * bought with before is the ordinary case for a new shopper.
 */
export async function resolvePosCustomerByPhone(
  mobile: string,
  dial: string = DEFAULT_PHONE_DIAL,
): Promise<
  {
    customer?: PosCustomer;
    /** True when no customer of this store has this number yet. */
    notFound?: boolean;
    error?: string;
  } & PosCustomerContext
> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { error: "Not allowed." };

  // Composed here so the lookup asks for the same canonical value a create
  // would write. Nothing rejects placeholder digits: that is the carrier's
  // rule (see normalizeIndianMobile), not this counter's.
  const composed = resolveEnteredPhone(dial, mobile);
  const phones = composed ? storedPhoneVariants(composed) : [];
  if (phones.length === 0) {
    return { error: numberLengthError(dial) };
  }

  const limited = await rateLimit(
    `pos-customer-resolve:${op.storeId}:${op.staffId ?? op.locationId}`,
    { max: 120, windowSeconds: 60 },
  );
  if (!limited.allowed) {
    return { error: "Too many customer lookups. Wait a moment and retry." };
  }

  try {
    const rows = await withService((db) =>
      db
        .select(posCustomerColumns)
        .from(users)
        .leftJoin(
          customerCreditBalances,
          and(
            eq(customerCreditBalances.storeId, users.storeId),
            eq(customerCreditBalances.customerId, users.id),
          ),
        )
        .where(and(eq(users.storeId, op.storeId), inArray(users.phone, phones)))
        // ★ A STORE MAY HOLD BOTH SHAPES FOR ONE PERSON, from before the shape
        // was canonicalised. Prefer their real account over the till-invented
        // row: it is the one carrying their name, email and online history,
        // and it is the row a later signup has already claimed. Without an
        // explicit order the winner would be whatever the planner returned
        // first, so the same number could attach to a different row on two
        // consecutive sales.
        .orderBy(
          sql`(${users.id} like 'pos\\_%') asc`,
          sql`(${users.phone} = ${phones[0]}) desc`,
        )
        .limit(1),
    );

    const row = rows[0];
    if (!row) return { notFound: true };
    return {
      customer: posCustomerFrom(row),
      ...(await posCustomerContext(op.storeId, row.id)),
    };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't resolve that customer.") };
  }
}

/**
 * Record a customer the till has just met, at Checkout.
 *
 * ★★ A FIRST NAME IS REQUIRED, AND THIS REFUSES WITHOUT ONE (owner's decision,
 * 2026-09-11). It shipped skippable on roadmap invariant 6 — "a walk-in who
 * will not give their name is still a sale" — and the owner reversed that for
 * the register after seeing the screen: a phone-only row is what filled
 * customer lists with anonymous `Customer` entries, so the counter should
 * always ask. ⚠ The consequence is intended: a number the till has not met
 * cannot be charged until it has a name.
 *
 * ★ THE REFUSAL IS HERE, not only in the disabled button. A server action is
 * reachable without its UI, so `validatePosCheckoutDetails` is the boundary.
 * The last name stays optional (`users.last_name` is nullable and plenty of
 * customers give one name); the email stays optional but is validated when
 * given, because a typo there is silent — nothing bounces back while the
 * customer is still in the shop.
 *
 * ★ A MISTYPED NUMBER IS NOT A REASON TO RECORD A BLANK. The counter's escape
 * is `Change number` on the details step, which hands the digits back for
 * correction (CODEBASE §36) — not a skip that writes a nameless row.
 *
 * ★ THE ROW GETS A `pos_…` ID, which is what makes it adoptable: it matches no
 * Identity Platform uid, so it is invisible to every customer session until
 * that person signs up with this number and `claimPosCustomer` rewrites the id
 * to theirs (CODEBASE §36).
 */
export async function createPosCheckoutCustomer(input: {
  mobile: string;
  dial?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}): Promise<
  {
    customer?: PosCustomer;
    created?: boolean;
    error?: string;
  } & PosCustomerContext
> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { error: "Not allowed." };

  const dial = input.dial ?? DEFAULT_PHONE_DIAL;
  const composed = resolveEnteredPhone(dial, input.mobile);
  const phones = composed ? storedPhoneVariants(composed) : [];
  if (!composed || phones.length === 0) {
    return { error: numberLengthError(dial) };
  }
  // ★ THE CANONICAL FORM IS WHAT GETS WRITTEN. Legacy shapes are matched on
  // the way in (above) but never created, so the column stops diverging.
  const phone = composed;

  const details = validatePosCheckoutDetails(input);
  if (!details.ok) return { error: details.error };

  const limited = await rateLimit(
    `pos-customer-create:${op.storeId}:${op.staffId ?? op.locationId}`,
    { max: 60, windowSeconds: 60 },
  );
  if (!limited.allowed) {
    return { error: "Too many customer lookups. Wait a moment and retry." };
  }

  const id = newPosCustomerId(() => crypto.randomUUID());
  try {
    const result = await withService(async (db) => {
      const inserted = await db
        .insert(users)
        .values({
          id,
          storeId: op.storeId,
          phone,
          firstName: details.firstName,
          lastName: details.lastName,
          email: details.email,
        } as typeof users.$inferInsert)
        .onConflictDoNothing()
        .returning({ id: users.id });
      if (inserted[0]) return { createdId: inserted[0].id, row: null };

      // Another till recorded the same number between the lookup and here, or
      // this number already existed in the other phone shape. The unique key
      // is the arbiter: read its winner rather than showing a duplicate error.
      const raced = await db
        .select(posCustomerColumns)
        .from(users)
        .leftJoin(
          customerCreditBalances,
          and(
            eq(customerCreditBalances.storeId, users.storeId),
            eq(customerCreditBalances.customerId, users.id),
          ),
        )
        .where(and(eq(users.storeId, op.storeId), inArray(users.phone, phones)))
        .orderBy(sql`(${users.id} like 'pos\\_%') asc`)
        .limit(1);
      return { createdId: null, row: raced[0] ?? null };
    });

    if (result.createdId) {
      return {
        created: true,
        customer: {
          id: result.createdId,
          name:
            [details.firstName, details.lastName]
              .filter(Boolean)
              .join(" ")
              .trim() || phone,
          phone,
          email: details.email,
          storeCredit: 0,
        },
        // Someone recorded seconds ago has redeemed nothing and ordered
        // nothing, so neither of these needs a read at all.
        exhaustedOfferIds: [],
        isFirstOrder: true,
      };
    }
    if (!result.row)
      return { error: "Couldn't save that customer. Try again." };
    return {
      customer: posCustomerFrom(result.row),
      ...(await posCustomerContext(op.storeId, result.row.id)),
    };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't save that customer.") };
  }
}

/**
 * Find an existing customer of THIS store to attach to a sale — by phone, name
 * or email. Store-scoped, so one store's register can never surface another
 * store's customer list.
 *
 * The register CAN also create one — see `createPosCustomer` below. That was
 * blocked until pos_13 gave the claim story it needed: a till-invented row now
 * carries a `pos_…` id and is ADOPTED by that person's later online signup
 * rather than colliding with it.
 */
export async function searchPosCustomers(
  query: string,
): Promise<{ customers: PosCustomer[]; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { customers: [], error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { customers: [], error: "Not allowed." };

  const q = typeof query === "string" ? query.trim().slice(0, 60) : "";
  // Two characters is the floor: a one-character search would stream a large
  // slice of the customer list to the till for nothing.
  if (q.length < 2) return { customers: [] };

  try {
    const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const rows = await withService((db) =>
      db
        .select({
          id: users.id,
          phone: users.phone,
          email: users.email,
          first_name: users.firstName,
          last_name: users.lastName,
        })
        .from(users)
        .where(
          and(
            eq(users.storeId, op.storeId),
            or(
              ilike(users.phone, pattern),
              ilike(users.firstName, pattern),
              ilike(users.lastName, pattern),
              ilike(users.email, pattern),
            ),
          ),
        )
        .limit(10),
    );

    // ★ ONE query for every balance, not one per row. A search returns up to
    // ten customers and runs on each keystroke burst at a counter.
    const balances = await getCreditBalances(
      op.storeId,
      rows.map((r) => r.id),
    );

    return {
      customers: rows.map((r) => ({
        id: r.id,
        name:
          [r.first_name, r.last_name].filter(Boolean).join(" ").trim() ||
          r.phone,
        phone: r.phone,
        email: r.email,
        storeCredit: balances.get(r.id) ?? 0,
      })),
    };
  } catch (err) {
    return {
      customers: [],
      error: dbErrorMessage(err, "Couldn't search customers."),
    };
  }
}

/**
 * Record a customer the till has never seen before (legacy named-customer
 * endpoint; phone-first checkout uses resolvePosCustomerByPhone).
 *
 * ── ★ THE ID IS `pos_<uuid>`, AND THAT IS THE WHOLE MECHANISM ──────────────
 * `users.id` IS the Firebase uid, so a row invented here has no natural key. A
 * synthetic `pos_` id is one the shopper's later signup can ADOPT (see
 * lib/pos/claim-customer.ts), and — because customer RLS matches `auth.uid()`
 * against `users.id` — it is also a row no session can ever read. Invisible and
 * claimable, with no policy written for either.
 *
 * ── ★ A DUPLICATE PHONE ATTACHES, IT DOES NOT FAIL ────────────────────────
 * `(store_id, phone)` is UNIQUE, and the commonest way to reach this action is
 * a cashier who searched, mistyped, and typed the number in by hand. Answering
 * "that customer already exists" and stopping would leave them re-searching
 * with a queue behind them; returning the existing customer is what they meant.
 * It leaks nothing — it is the same row `searchPosCustomers` would have found
 * for the number they just typed.
 *
 * ★ MANAGER-ONLY? NO — `sell`. Recording who bought something is part of
 * ringing up a sale, and gating it above the person at the counter means it
 * never gets done.
 */
export async function createPosCustomer(
  input: PosCustomerInput,
): Promise<{ customer?: PosCustomer; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { error: "Not allowed." };

  const valid = validatePosCustomer(input);
  if (!valid.ok) return { error: valid.error };

  const { first, last } = splitName(valid.name);
  const id = newPosCustomerId(() => crypto.randomUUID());
  // ⚠ The unique key is on the phone STRING, and a number already on file may
  // be stored in the E.164 shape written by website signup. Inserting the
  // national form would NOT conflict with it, so without checking every shape
  // first this creates the very duplicate the conflict path exists to avoid.
  const phones = storedPhoneVariants(valid.phone);

  try {
    const already = await withService((db) =>
      db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.storeId, op.storeId), inArray(users.phone, phones)))
        .limit(1),
    );
    const rows = already[0]
      ? []
      : await withService((db) =>
          db
            .insert(users)
            .values({
              id,
              storeId: op.storeId,
              phone: valid.phone,
              email: valid.email,
              firstName: first,
              lastName: last,
            } as typeof users.$inferInsert)
            // The phone is the identity here, so a conflict on it is "this person
            // is already on file" — not an error to report.
            .onConflictDoNothing()
            .returning({ id: users.id }),
        );

    if (rows[0]) {
      return {
        customer: {
          id: rows[0].id,
          name: valid.name,
          phone: valid.phone,
          email: valid.email,
          // A row created this second cannot have a balance.
          storeCredit: 0,
        },
      };
    }

    // Conflict: hand back whoever already holds that number for this store.
    const existing = await withService((db) =>
      db
        .select({
          id: users.id,
          phone: users.phone,
          email: users.email,
          first_name: users.firstName,
          last_name: users.lastName,
        })
        .from(users)
        .where(and(eq(users.storeId, op.storeId), inArray(users.phone, phones)))
        .orderBy(sql`(${users.id} like 'pos\\_%') asc`)
        .limit(1),
    );
    const row = existing[0];
    if (!row) return { error: "Couldn't save that customer." };
    return {
      customer: {
        id: row.id,
        name:
          [row.first_name, row.last_name].filter(Boolean).join(" ").trim() ||
          row.phone,
        phone: row.phone,
        email: row.email,
        // This is an EXISTING customer (the phone was already on file), so
        // they may well have one.
        storeCredit: await getCreditBalance(op.storeId, row.id),
      },
    };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't save that customer.") };
  }
}

// ---- Manager approval ------------------------------------------------------

/**
 * Verify a manager's PIN for an override (discount over the cap, price
 * override) and mint a signed approval for THAT sale.
 *
 * The token — not a boolean — is what `placePosSale` accepts. Returning
 * `{approved: true}` and letting the client tell the sale so was the whole
 * gate: a cashier could call placePosSale directly with `managerApproved:
 * true` and never touch the keypad. See lib/pos/approval.ts for what the
 * token is bound to.
 *
 * No session is minted, so approving does not switch the operator.
 */
export async function verifyManagerPin(
  pin: string,
  sale: ApprovableSale,
): Promise<{ approved?: boolean; token?: string; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  // Minting can't degrade the way verification does — say so plainly rather
  // than throwing a 500 at a cashier mid-sale.
  if (!posSessionConfigured()) return { error: POS_SECRET_MISSING_ERROR };

  const rl = await rateLimit(`pos-approve:${op.storeId}:${op.locationId}`, {
    max: 10,
    windowSeconds: 60,
  });
  if (!rl.allowed) return { error: "Too many attempts. Please wait." };
  if (typeof pin !== "string" || !/^\d{8}$/.test(pin)) {
    return { error: "Enter the manager's 8-digit PIN." };
  }

  try {
    const rows = await withService((db) =>
      db
        .select({ id: posStaff.id, pin_hash: posStaff.pinHash })
        .from(posStaff)
        .innerJoin(
          posStaffLocations,
          and(
            eq(posStaffLocations.staffId, posStaff.id),
            eq(posStaffLocations.locationId, op.locationId),
          ),
        )
        .where(
          and(
            eq(posStaff.storeId, op.storeId),
            eq(posStaff.role, "manager"),
            eq(posStaff.active, true),
            eq(posStaff.status, "active"),
          ),
        )
        .limit(50),
    );
    const approver = rows.find((r) => verifyPin(pin, r.pin_hash));
    if (!approver) return { error: "Incorrect manager PIN." };

    return {
      approved: true,
      token: signApprovalToken({
        storeId: op.storeId,
        locationId: op.locationId,
        operatorId: op.staffId,
        approverId: approver.id,
        // The cart as the client will submit it — the manager is approving
        // THIS sale, not this cashier for the next three minutes.
        fingerprint: saleFingerprint(sale ?? { lines: [] }),
      }),
    };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't verify.") };
  }
}

// ---- The sale --------------------------------------------------------------

interface PricedLine {
  product_id: string;
  variant_id: string | null;
  name: string;
  variant_name: string | null;
  hsn_code: string | null;
  unit_price: number;
  unit_cost: number | null;
  quantity: number;
  /** unit_price * qty, minus the line discount. */
  amount: number;
  line_discount: number;
  tax_rate: number;
  tax_class_name: string | null;
  category_id: string | null;
  /** The non-sale price, when `unit_price` is a variant's special price.
   *  Equal to `unit_price` otherwise. Feeds `offers.onSalePrice` (plan §14). */
  listed_price: number;
}

export async function placePosSale(
  lines: PosCartLine[],
  tenders: PosTender[],
  opts: {
    customerId?: string | null;
    /** Where to email a copy of the receipt. Optional — a phone-only customer
     *  may want paper only, and asking must never gate a sale. */
    receiptEmail?: string | null;
    customerGstin?: string | null;
    orderDiscount?: number;
    /** A manager's approval, as minted by `verifyManagerPin` for THIS cart.
     *  Never a boolean: a flag from the client is a flag the client can set. */
    approvalToken?: string | null;
    note?: string | null;
    /** Completed counter return this replacement sale closes out. */
    exchangeReturnId?: string | null;
  } = {},
): Promise<PosSaleResult> {
  // 1. Operator — server-resolved, device-bound, DB-revalidated.
  const op = await resolvePosOperator();
  if (!op) return { error: "You're signed out. Please sign in again." };
  if (!posCan(op.role, "sell")) {
    return { error: "You don't have permission to sell." };
  }

  const rl = await rateLimit(`pos-sale:${op.staffId ?? op.storeId}`, {
    max: 120,
    windowSeconds: 60,
  });
  if (!rl.allowed) return { error: "Too many sales too quickly. Try again." };

  // 2. Shape validation before any DB work.
  if (!Array.isArray(lines) || lines.length === 0) {
    return { error: "The cart is empty." };
  }
  if (lines.length > MAX_LINE_ITEMS) return { error: "Too many items." };
  for (const l of lines) {
    if (typeof l?.productId !== "string" || !l.productId) {
      return { error: "The cart contains an invalid item." };
    }
    if (
      !Number.isInteger(l.quantity) ||
      l.quantity < 1 ||
      l.quantity > MAX_QTY_PER_LINE
    ) {
      return { error: "Invalid quantity." };
    }
  }
  const badTender = validateTenderShape(
    tenders,
    "Take a payment to complete the sale.",
  );
  if (badTender) return { error: badTender };

  // A GSTIN prints on the customer's invoice, so it is validated rather than
  // trusted: normalised, format-checked, and length-capped.
  let customerGstin: string | null = null;
  if (typeof opts.customerGstin === "string" && opts.customerGstin.trim()) {
    customerGstin = opts.customerGstin.trim().toUpperCase().slice(0, 15);
    if (!isValidGstinFormat(customerGstin)) {
      return { error: "That GSTIN doesn't look valid." };
    }
  }

  // ── 3. THE READ WAVE (roadmap Step 20) ────────────────────────────────────
  // ★★ STATEMENTS INSIDE ONE `withService` RUN SERIALLY — they share a single
  // pg client — so grouping independent reads into one transaction, which reads
  // like an optimisation, is the SLOWEST arrangement available. Separate
  // `withService` calls each take their own pool client, so these four batches
  // genuinely overlap and the wall clock is the LONGEST batch, not their sum.
  //
  // Serial before: shift · products · variants? · billing · tax · location ·
  // prefix · customer? = 6–8 round trips. Now: max(1, 2, 2, 2) = 2. Against
  // Mumbai Cloud SQL at ~46ms that is ~320ms saved on the one path whose whole
  // design goal is "least checkout time".
  //
  // ★ BATCHED, NOT ONE PROMISE PER QUERY, AND BALANCED. The wall clock is the
  // longest batch, so a batch of four would have made three of them wait on it
  // — the first cut of this had exactly that shape and bought half as much.
  // The pool is `DB_POOL_MAX` (10) per container, so four concurrent reads per
  // sale means three simultaneous tills briefly queue. That is acceptable
  // because each read is short and the total connection-TIME went down; going
  // wider trades a real pool ceiling for nothing.
  //
  // ★★ EVERY BATCH CATCHES ITS OWN FAILURE AND RETURNS IT. Letting them throw
  // into Promise.all would lose WHICH read failed — and "Couldn't price the
  // sale." vs "Couldn't read tax settings." is the difference between a cashier
  // knowing to re-ring and knowing to call someone. It also avoids an unhandled
  // rejection when one batch fails while the others are still in flight.
  const wantedCustomerId =
    typeof opts.customerId === "string" && opts.customerId.trim()
      ? opts.customerId.trim()
      : null;
  // A POS order without an owner cannot later be found by mobile, verified for
  // a pickup/return, or receive store credit. Checkout resolves (and, for a
  // new number, creates) the customer in one explicit submit; keep the same
  // invariant at the trust boundary so a stale client or alternate caller
  // cannot re-introduce anonymous "Walk-in" sales.
  if (!wantedCustomerId) {
    return { error: "Add the customer's mobile number before taking payment." };
  }
  const exchangeReturnId =
    typeof opts.exchangeReturnId === "string" && opts.exchangeReturnId.trim()
      ? opts.exchangeReturnId.trim()
      : null;

  const productIds = Array.from(new Set(lines.map((l) => l.productId)));
  const variantIds = Array.from(
    new Set(lines.map((l) => l.variantId).filter(Boolean)),
  ) as string[];

  type Batch<T> = { ok: true; value: T } | { ok: false; error: string };
  const batch = async <T>(
    fallback: string,
    run: () => Promise<T>,
  ): Promise<Batch<T>> => {
    try {
      return { ok: true, value: await run() };
    } catch (err) {
      return { ok: false, error: dbErrorMessage(err, fallback) };
    }
  };

  const [counterRead, catalogueRead, taxRead, tillRead, settings] =
    await Promise.all([
      // The counter: who is being served, and which drawer this belongs to.
      batch("Couldn't verify the customer.", () =>
        withService(async (db) => {
          const owner = wantedCustomerId
            ? await db
                .select({ id: users.id, email: users.email })
                .from(users)
                .where(
                  and(
                    eq(users.id, wantedCustomerId),
                    eq(users.storeId, op.storeId),
                  ),
                )
                .limit(1)
            : [];
          const exchange = exchangeReturnId
            ? await db
                .select({
                  id: orderReturns.id,
                  exchange_order_id: orderReturns.exchangeOrderId,
                  original_customer_id: orders.customerId,
                  original_order_ref: orders.orderRef,
                })
                .from(orderReturns)
                .innerJoin(orders, eq(orders.id, orderReturns.orderId))
                .where(
                  and(
                    eq(orderReturns.id, exchangeReturnId),
                    eq(orderReturns.storeId, op.storeId),
                    eq(orderReturns.locationId, op.locationId),
                    eq(orderReturns.status, "completed"),
                  ),
                )
                .limit(1)
            : [];
          return { owner, exchange };
        }),
      ),
      // The catalogue: prices are RE-READ here — the client's are a display hint.
      batch("Couldn't price the sale.", () =>
        withService(async (db) => {
          const p = await db
            .select({
              id: products.id,
              name: products.name,
              selling_price: products.sellingPrice,
              cost_price: products.costPrice,
              tax_class_id: products.taxClassId,
              hsn_code: products.hsnCode,
              // Offer scoping (docs/offers-plan.md). In this select rather
              // than a second read: the catalogue batch is already positioned
              // to return it, and a sale must not pay another round trip.
              category_id: products.categoryId,
            })
            .from(products)
            .where(
              and(
                inArray(products.id, productIds),
                eq(products.storeId, op.storeId),
              ),
            );
          const v = variantIds.length
            ? await db
                .select({
                  id: productVariants.id,
                  name: productVariants.name,
                  selling_price: productVariants.sellingPrice,
                  special_price: productVariants.specialPrice,
                  cost_price: productVariants.costPrice,
                })
                .from(productVariants)
                .where(
                  and(
                    inArray(productVariants.id, variantIds),
                    eq(productVariants.storeId, op.storeId),
                  ),
                )
            : [];
          return { p, v };
        }),
      ),
      // Tax config (uncached — a sale must reflect the config at the moment it is
      // rung, never a stale copy).
      batch("Couldn't read tax settings.", () =>
        withService(async (db) => {
          const b = await db
            .select({
              ...BILLING_COLS,
              gst_enabled: storeBillingSettings.gstEnabled,
            })
            .from(storeBillingSettings)
            .where(eq(storeBillingSettings.storeId, op.storeId))
            .limit(1);
          const t = await db
            .select({
              id: taxClasses.id,
              name: taxClasses.name,
              rate: taxClasses.rate,
              sort_order: taxClasses.sortOrder,
            })
            .from(taxClasses)
            .where(eq(taxClasses.storeId, op.storeId));
          return { b: b[0] ?? null, t };
        }),
      ),
      // This till: where it is, and which drawer is open.
      batch("Couldn't read this till's settings.", () =>
        withService(async (db) => {
          // ★ THE RECEIPT PREFIX RIDES ALONG WITH THE STATE CODE — same row. It
          // was being fetched by its own `withService` further down: a whole
          // round trip, on the sell path, for a column already in flight.
          const loc = await db
            .select({
              state_code: storeLocations.stateCode,
              receipt_prefix: storeLocations.receiptPrefix,
            })
            .from(storeLocations)
            .where(eq(storeLocations.id, op.locationId))
            .limit(1);
          // Which cash drawer this sale belongs to (Phase 3). Stamped on the
          // order so reconciliation never infers it from a timestamp.
          const shift = await db
            .select({ id: posShifts.id })
            .from(posShifts)
            .where(
              and(
                eq(posShifts.locationId, op.locationId),
                eq(posShifts.status, "open"),
                isNull(posShifts.closedAt),
              ),
            )
            .limit(1);
          return { loc: loc[0] ?? null, shift };
        }),
      ),
      getStoreSettings(),
    ]);

  // ★ RESULTS ARE CHECKED IN THE ORDER THEY USED TO RUN IN — customer, shift,
  // prices, tax — so which error a cashier sees for a sale with two problems
  // is unchanged. Reading them in the order the BATCHES happen to be declared
  // would quietly reshuffle that, which is the kind of change nobody notices
  // until someone at a counter is told the wrong thing is wrong.
  if (!counterRead.ok) return { error: counterRead.error };
  let customerId: string | null = null;
  let customerEmail: string | null = null;
  if (wantedCustomerId) {
    const owned = counterRead.value.owner;
    if (owned.length === 0)
      return { error: "That customer isn't in this store." };
    customerId = owned[0].id;
    customerEmail = owned[0].email ?? null;
  }
  const exchangeRow = counterRead.value.exchange[0] ?? null;
  if (exchangeReturnId) {
    if (!exchangeRow || exchangeRow.exchange_order_id) {
      return { error: "That exchange is no longer available." };
    }
    if (exchangeRow.original_customer_id !== customerId) {
      return { error: "The replacement must stay with the original customer." };
    }
    if (
      settings["returns.enabled"] !== true ||
      settings["returns.allowExchanges"] !== true
    ) {
      return { error: "Exchanges are switched off for this store." };
    }
  }

  if (!tillRead.ok) return { error: tillRead.error };
  const supplierState = tillRead.value.loc?.state_code ?? null;
  const receiptPrefix = tillRead.value.loc?.receipt_prefix || "POS";
  const shiftId = tillRead.value.shift[0]?.id ?? null;

  const allowOverride = settings["pos.allowPriceOverride"] !== false;
  const requireApproval = settings["pos.requireManagerForDiscount"] === true;
  // ★ A DELIBERATE 0 MUST SURVIVE. `|| 10` read as a NaN guard, but the setting
  // declares `min: 0` and 0 is MEANINGFUL — "a cashier needs approval for ANY
  // discount" — so the merchant who locked this down hardest silently got the
  // 10% default instead, handing cashiers exactly the authority they withheld.
  // resolveStoreSettings already guarantees a number clamped to [min, max], so
  // the fallback is only for a structurally impossible value. Same rule
  // `products.return_window_days` follows: a real 0 is not an absent value.
  const rawMaxDiscount = settings["pos.maxDiscountPercent"];
  const maxDiscountPct =
    typeof rawMaxDiscount === "number" ? rawMaxDiscount : 10;
  // Default TRUE: discounting belongs to the owner unless a merchant hands it
  // out deliberately.
  const ownerOnlyDiscounts = settings["pos.ownerOnlyDiscounts"] !== false;
  const mayDiscount = posCan(op.role, "discount");

  // ★ THE SHIFT GATE STAYS AFTER THE READS, NOT INSIDE THEM. A store may
  // require an open shift before selling; that is OFF by default because
  // turning it on can stop a till, so it stays the merchant's decision.
  // ⚠ A failed till read already returned above, so — unlike the old
  // `currentShiftIdFor`, which swallowed its own errors and returned null — a
  // DB blip can no longer read as "no drawer open" and refuse the sale under
  // `pos.requireOpenShift`. It reads as the outage it is.
  if (!shiftId && settings["pos.requireOpenShift"] === true) {
    return { error: "Open a shift before selling." };
  }

  if (!catalogueRead.ok) return { error: catalogueRead.error };
  const pMap = new Map(catalogueRead.value.p.map((p) => [p.id, p]));
  const vMap = new Map(catalogueRead.value.v.map((v) => [v.id, v]));

  if (!taxRead.ok) return { error: taxRead.error };
  const billing = rowToBillingSettings(
    taxRead.value.b as Record<string, unknown> | null,
  );
  const gstEnabled = !!(taxRead.value.b as { gst_enabled?: boolean } | null)
    ?.gst_enabled;
  const taxClassList = taxRead.value.t.map((r) =>
    rowToTaxClass(r as Record<string, unknown>),
  );

  // A manager's approval is a SIGNED grant for this exact cart at this exact
  // till, minted by verifyManagerPin. An unverifiable, stale, tampered or
  // absent token all land in the same place — unapproved — so a caller that
  // skips the PIN pad entirely gets nowhere.
  // ★★ THE CLAIMS ARE KEPT, NOT COERCED. This was `!!verifyApprovalToken(...)`,
  // which threw away `approverId` — the manager who keyed their PIN. Everything
  // else about a discount is reconstructible from the order; who authorised it
  // is not, once the sale commits. The module's own comment has said "returns
  // the claims (so the approver can be recorded)" since it was written.
  const approval = verifyApprovalToken(opts.approvalToken, {
    storeId: op.storeId,
    locationId: op.locationId,
    operatorId: op.staffId,
    fingerprint: saleFingerprint({
      lines,
      orderDiscount: opts.orderDiscount,
    }),
  });
  const managerApproved = !!approval;

  const classById = new Map(taxClassList.map((c) => [c.id, c]));

  // 5. Price each line + validate discounts/overrides.
  const priced: PricedLine[] = [];
  // Accumulated for the money audit (Step 14): how much repricing gave away,
  // across how many lines.
  let overrideLines = 0;
  let overrideGivenAway = 0;
  let needsApproval = false;

  for (const l of lines) {
    const p = pMap.get(l.productId);
    if (!p) return { error: "A product in the cart is no longer available." };
    const v = l.variantId ? vMap.get(l.variantId) : null;
    if (l.variantId && !v) {
      return { error: "A variant in the cart is no longer available." };
    }

    const special = v ? v.special_price : null;
    const listed = v ? v.selling_price : p.selling_price;
    let unit = special && special > 0 ? special : listed;
    // What the catalogue said, before any override. The audit records the
    // DELTA rather than the new price: "we charged ₹1" means nothing without
    // yesterday's price, and that price moves.
    const catalogueUnit = unit;

    // A price override is an authorised deviation, never a client claim.
    if (
      l.priceOverride !== undefined &&
      l.priceOverride !== null &&
      Number.isFinite(l.priceOverride)
    ) {
      if (!allowOverride) return { error: "Price overrides are turned off." };
      if (l.priceOverride < 0) return { error: "Invalid price." };
      // ★ Repricing a line to ₹1 IS a discount, so it answers to the same rule
      // (`pos.ownerOnlyDiscounts`) and the same capability table. Without this,
      // the discount gate below would be decorative — a manager would simply
      // mark the price down instead.
      if (ownerOnlyDiscounts && !posCan(op.role, "price_override")) {
        return {
          error:
            "Only the owner can change a price on a sale. Ask them to ring it, or turn off owner-only discounts in POS settings.",
        };
      }
      // Legacy path (owner-only discounts switched off): a cashier needs a
      // manager's PIN, a manager and above don't. `discount_over_cap` is that
      // set, named — it used to be an inline `role === "cashier"`.
      if (!managerApproved && !posCan(op.role, "discount_over_cap")) {
        needsApproval = true;
      }
      unit = l.priceOverride;
      overrideLines += 1;
      overrideGivenAway += (catalogueUnit - unit) * l.quantity;
    }

    const gross = unit * l.quantity;
    const lineDisc =
      Number.isFinite(l.lineDiscount) && (l.lineDiscount ?? 0) > 0
        ? Math.min(Math.round(l.lineDiscount!), gross)
        : 0;

    const cls = p.tax_class_id
      ? classById.get(p.tax_class_id)
      : billing.defaultTaxClassId
        ? classById.get(billing.defaultTaxClassId)
        : null;

    priced.push({
      product_id: l.productId,
      variant_id: l.variantId ?? null,
      name: p.name,
      variant_name: v?.name ?? null,
      hsn_code: p.hsn_code ?? null,
      unit_price: unit,
      unit_cost: v?.cost_price ?? p.cost_price,
      quantity: l.quantity,
      amount: gross - lineDisc,
      line_discount: lineDisc,
      tax_rate: billing.taxEnabled ? (cls?.rate ?? 0) : 0,
      tax_class_name: cls?.name ?? null,
      category_id: p.category_id ?? null,
      listed_price: listed,
    });
  }

  // Offers, resolved AUTHORITATIVELY here. The sell screen quotes with the same
  // pure engine over the offer list in `RegisterConfig`, but the client is not
  // trusted: a stale config, a spent budget or a customer's own usage can all
  // have moved since the register opened.
  //
  // ★ THE REGISTER'S OWN LOCATION, never a client-supplied one. Every till
  // session is bound to one location by `resolvePosOperator`, and that is the
  // value a location-scoped offer is measured against.
  let offerResult = await resolveOffersForCart({
    storeId: op.storeId,
    channel: "pos",
    locationId: op.locationId,
    customerId: customerId ?? null,
    lines: priced.map((l, idx) => ({
      id: String(idx),
      productId: l.product_id,
      variantId: l.variant_id,
      categoryId: l.category_id ?? null,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      // ★ The price this line is on sale FROM, so `offers.onSalePrice` can
      // tell a discounted line from a full-price one. `placeOrder` passes the
      // same pair online now that it charges `special_price` too, so the two
      // counters price a basket identically.
      regularUnitPrice: l.listed_price,
      lineDiscount: l.line_discount,
    })),
  });
  // ★★ A GIFT BECOMES A REAL ₹0 LINE AT THE TILL TOO, appended before totals,
  // stock and the insert so each handles it with no special case (plan §12).
  // The register's own location reserves it, exactly as it reserves a paid
  // line — a gift is stock leaving the shelf, and nothing else told inventory
  // those units went out of the door.
  //
  // ★ APPENDED BEFORE `offerDiscounts` is built, so the index alignment those
  // arrays rely on still holds; the gift's own offer discount is zero, which
  // is true — it was added, not discounted.
  // The gift's worth, for its offer's budget cap only.
  let giftValuePaise = 0;
  let giftLineIndex = -1;
  if (offerResult?.gift) {
    const wanted = offerResult.gift;
    let giftUnitPrice = 0;
    const giftLine = await (async () => {
      const rows = await withService((db) =>
        db
          .select({
            id: products.id,
            name: products.name,
            // What the customer would OTHERWISE have paid — what the gift
            // costs the offer's budget. The LINE stays ₹0.
            sellingPrice: products.sellingPrice,
            taxClassId: products.taxClassId,
            categoryId: products.categoryId,
            hsnCode: products.hsnCode,
          })
          .from(products)
          .where(
            and(
              eq(products.id, wanted.productId),
              eq(products.storeId, op.storeId),
            ),
          )
          .limit(1),
      );
      const row = rows[0];
      if (!row) return null;

      let variantName: string | null = null;
      if (wanted.variantId) {
        const vRows = await withService((db) =>
          db
            .select({
              name: productVariants.name,
              selling_price: productVariants.sellingPrice,
              special_price: productVariants.specialPrice,
            })
            .from(productVariants)
            .where(
              and(
                eq(productVariants.id, wanted.variantId as string),
                eq(productVariants.productId, wanted.productId),
              ),
            )
            .limit(1),
        );
        if (!vRows[0]) return null;
        variantName = vRows[0].name;
        giftUnitPrice = variantEffectiveSelling(vRows[0]);
      }

      if (!wanted.variantId) giftUnitPrice = row.sellingPrice;
      const giftCls = row.taxClassId
        ? classById.get(row.taxClassId)
        : billing.defaultTaxClassId
          ? classById.get(billing.defaultTaxClassId)
          : null;

      return {
        product_id: row.id,
        variant_id: wanted.variantId,
        name: row.name,
        variant_name: variantName,
        hsn_code: row.hsnCode ?? null,
        unit_price: 0,
        // Null, not zero: a gift's cost is a marketing expense, and recording
        // it against a ₹0 sale would report a loss on the line (§20).
        unit_cost: null,
        quantity: wanted.quantity,
        amount: 0,
        line_discount: 0,
        // ★ The gift's OWN tax class is recorded even though tax on a zero
        // taxable value is zero — see the note in `checkout-actions.ts`. ⚠ The
        // GST treatment of a free good is NOT professionally reviewed.
        tax_rate: billing.taxEnabled ? (giftCls?.rate ?? 0) : 0,
        tax_class_name: giftCls?.name ?? null,
        category_id: row.categoryId ?? null,
        listed_price: 0,
      };
    })();

    if (giftLine) {
      giftLineIndex = priced.length;
      priced.push(giftLine);
      giftValuePaise = toPaise(giftUnitPrice * giftLine.quantity);
    } else {
      // Gone between resolution and here. A sale must never fail over a free
      // extra, so the gift is dropped and the sale completes.
      offerResult = { ...offerResult, gift: null };
    }
  }

  const offerDiscounts = priced.map((_, idx) =>
    offerResult ? (offerResult.lines[idx]?.offerDiscount ?? 0) : 0,
  );

  // Totals come from the SHARED pure helper the sell screen also uses, so the
  // amount quoted to the customer and the amount charged cannot diverge.
  const totals = posTotals({
    lines: priced.map((l, idx) => ({
      gross: l.unit_price * l.quantity,
      lineDiscount: l.line_discount,
      offerDiscount: offerDiscounts[idx],
      rate: l.tax_rate,
      label: l.tax_class_name ?? undefined,
    })),
    requestedOrderDiscount:
      Number.isFinite(opts.orderDiscount) && (opts.orderDiscount ?? 0) > 0
        ? Math.round(opts.orderDiscount!)
        : 0,
    pricesIncludeTax: billing.pricesIncludeTax,
    taxEnabled: billing.taxEnabled,
  });
  const { subtotal, discount } = totals;

  // ★ WHO MAY DISCOUNT AT ALL. Under `pos.ownerOnlyDiscounts` (the default) a
  // discount from staff is REFUSED, not queued for approval — a manager's PIN
  // must not open this door, because the manager is one of the people being
  // kept out of it. Returning `needsApproval` here would hand them the key.
  //
  // Both kinds count: an order discount and a per-line markdown are the same
  // act with different arithmetic, and allowing "Less ₹50" per line while
  // blocking "Discount ₹50" would be a rule in name only.
  if (discount > 0 && ownerOnlyDiscounts && !mayDiscount) {
    return {
      error:
        "Only the owner can apply a discount. Ask them to ring this sale, or turn off owner-only discounts in POS settings.",
    };
  }

  // The cap, for a merchant who has handed discounting to their staff. A
  // cashier needs a manager's PIN above it; `discount_over_cap` is what exempts
  // a manager, rather than an inline role check that could disagree with the
  // capability table.
  if (
    requireApproval &&
    subtotal > 0 &&
    discount > 0 &&
    !posCan(op.role, "discount_over_cap")
  ) {
    const pct = (discount / subtotal) * 100;
    if (pct > maxDiscountPct && !managerApproved) needsApproval = true;
  }
  if (needsApproval) {
    return {
      needsApproval: true,
      error: `A manager's PIN is needed to approve this (over ${maxDiscountPct}%).`,
    };
  }

  // 6. Tax + GST split.
  const tax = totals.tax;

  // An in-person sale's place of supply is the selling location's state.
  const placeOfSupply = supplierState;
  const intra = isIntraState(supplierState, placeOfSupply);

  const total = totals.total;

  // 7. Tenders must cover the total. Change is derived server-side.
  const settled = settleTenders(tenders, total);
  if ("error" in settled) return { error: settled.error };
  const changeDue = settled.change;

  // ── Store credit (§29) ────────────────────────────────────────────────────
  // ★ A BALANCE BELONGS TO SOMEBODY. Without an attached customer there is no
  // account to draw on, so this is refused rather than silently ignored — the
  // cashier needs to know the sale is short, not discover it at the drawer.
  const creditAsked = accountTenderTotal(tenders, "store_credit");
  if (creditAsked > 0 && !customerId) {
    return { error: "Attach a customer before paying with store credit." };
  }
  if (creditAsked > 0 && customerId) {
    // A PRE-check, purely so the cashier gets a useful message with the real
    // balance in it. It is NOT the guarantee — `spendCredit` below is a single
    // conditional UPDATE, so the balance is re-proved atomically at the moment
    // it moves and two tills cannot overdraw the same account between here and
    // there.
    const balance = await getCreditBalance(op.storeId, customerId);
    if (balance + 0.0001 < creditAsked) {
      return {
        error: `That customer has ₹${balance.toLocaleString("en-IN")} in store credit, which doesn't cover ₹${creditAsked.toLocaleString("en-IN")}.`,
      };
    }
  }

  // ── Gateway tenders (§18 Step 12) ─────────────────────────────────────────
  // ★★ VERIFIED HERE, NOT JUST AT confirmPosGatewayPayment. This action is
  // independently reachable — the register's own JavaScript is not its only
  // caller, which is exactly how the `managerApproved` boolean was bypassable —
  // so a `razorpay` tender arriving with any reference at all would otherwise
  // settle a sale against money nobody took.
  //
  // ★ BEFORE the order insert and the stock reserve, deliberately. A refused
  // payment then costs nothing and unwinds nothing; verifying after would mean
  // rolling back an order and released stock for what is usually a typo.
  //
  // The rule itself lives in lib/payments/pos-gateway.ts because the collection
  // counter asks the identical question (§23) — one implementation, two
  // counters.
  const hasGatewayTender = tenders.some((t) => t.method === "razorpay");
  if (hasGatewayTender) {
    const badGateway = await verifyGatewayTenders(op.storeId, tenders);
    if (badGateway) return { error: badGateway };
  }

  // 8. Allocate a per-location receipt number.
  let receiptNo: string | null = null;
  try {
    const res = await withService((db) =>
      db.execute(sql`select next_pos_receipt_no(${op.locationId}) as seq`),
    );
    const seq = Number((res.rows[0] as { seq?: number } | undefined)?.seq ?? 0);
    // The prefix came back with the read wave — it is a column on the same
    // location row as the state code, so fetching it here was a whole round
    // trip on the sell path for something already in hand.
    receiptNo = `${receiptPrefix}-${String(seq).padStart(6, "0")}`;
  } catch (err) {
    // A receipt number is cosmetic — never lose a sale over it.
    console.error("next_pos_receipt_no:", errMsg(err));
  }

  // 8b. Claim every applied offer's caps atomically, BEFORE anything is
  //     written — the same position as the shelf check and the gateway
  //     verification, so a refusal still costs nothing to unwind.
  //
  // ★ A CAP REFUSAL STOPS THE SALE; A BLIP DOES NOT. The cashier is standing
  // in front of a customer, so being told "that offer just ran out" is a real
  // answer they can act on, while an unreachable database must never stop the
  // till taking money (invariant 6).
  let reservedOffers: ReservedOffer[] = [];
  // Exactly what was claimed, carried to the ledger so the two agree.
  const redeemedOffers: AppliedOffer[] = [];
  if (offerResult && offerResult.applied.length > 0) {
    const claim = await reserveOfferUses(
      op.storeId,
      offerResult.applied,
      customerId ?? null,
    );
    reservedOffers = claim.reserved;
    if (!claim.ok) {
      await releaseOfferUses(op.storeId, reservedOffers);
      return { error: claim.error ?? "That offer is no longer available." };
    }
    redeemedOffers.push(...offerResult.applied);
  }

  // ★★ A GIFT OR CASHBACK CAP DROPS THE EXTRA, NEVER THE SALE. These caps are
  // meant to be reached, so refusing at the till would stop the shop selling
  // with a customer standing at the counter — the same reason the gift block
  // above drops a vanished gift instead of failing. The gift is already a ₹0
  // line, so removing it changes no total the cashier has quoted.
  const bonuses = offerResult
    ? bonusOffersToReserve(offerResult, giftValuePaise)
    : [];
  for (const bonus of bonuses) {
    const claim = await reserveOfferUses(
      op.storeId,
      [bonus],
      customerId ?? null,
    );
    reservedOffers = [...reservedOffers, ...claim.reserved];
    if (claim.ok) {
      redeemedOffers.push(bonus);
      continue;
    }
    if (bonus.level === "gift") {
      // ★ THE EXACT INDEX RECORDED WHEN THE LINE WAS APPENDED, never a
      // search. Matching on "this product at ₹0" would also match a genuinely
      // free paid line, and removing the wrong element would silently shift
      // `offerDiscounts` out of step with its lines.
      if (giftLineIndex >= 0) {
        priced.splice(giftLineIndex, 1);
        offerDiscounts.splice(giftLineIndex, 1);
      }
      offerResult = offerResult ? { ...offerResult, gift: null } : offerResult;
    } else {
      offerResult = offerResult
        ? { ...offerResult, credit: null }
        : offerResult;
    }
  }
  const releaseOffers = async () => {
    if (reservedOffers.length === 0) return;
    await releaseOfferUses(op.storeId, reservedOffers);
    reservedOffers = [];
  };

  // 9. Write: order → stock → items → payments, unwinding in reverse on failure.
  const orderId = crypto.randomUUID();
  // ★ ITEM IDS UP FRONT, not read back from RETURNING. `order_item_offers`
  // must know which persisted row each engine line became, and a multi-row
  // INSERT returning rows in VALUES order is not something SQL guarantees.
  const orderItemIds = priced.map(() => crypto.randomUUID());
  let orderRef = "";
  try {
    const rows = await withService((db) =>
      db
        .insert(orders)
        // order_no / order_ref are filled by the BEFORE-INSERT trigger
        // (identifiers_04_triggers.sql), so the insert type is asserted past them.
        .values({
          id: orderId,
          storeId: op.storeId,
          customerId,
          status: "completed",
          paymentMethod: tenders.length === 1 ? tenders[0].method : "split",
          paymentStatus: "paid",
          shippingAddress: null,
          billingAddress: null,
          subtotal,
          tax,
          taxInclusive: billing.pricesIncludeTax,
          shipping: 0,
          discount,
          total,
          currency: "INR",
          notes:
            opts.note ??
            (exchangeRow
              ? `Exchange replacement for ${exchangeRow.original_order_ref}`
              : null),
          // ★ CREDIT IS A PAYMENT, NOT A DISCOUNT (§29). `total` stays the full
          // goods value and this records what was settled from the balance —
          // netting it off would understate the sale on the receipt, compute
          // GST on the wrong base, and make a later credit note reverse the
          // wrong amount.
          //
          // ★★ ZERO, NEVER NULL, AND THAT IS NOT A STYLE CHOICE. The column is
          // `NOT NULL DEFAULT 0`, and an explicit NULL does not fall back to a
          // DEFAULT — it violates the constraint. Writing null here took EVERY
          // till on the platform down the moment it deployed: a sale that used
          // no credit (i.e. almost all of them) failed on insert, and the
          // cashier saw only "Couldn't record the sale. Please try again."
          // Nothing about the message pointed at store credit, which the sale
          // never touched. Use the default's own value; to genuinely defer to a
          // DEFAULT the key has to be OMITTED, which Drizzle's typed insert
          // makes awkward here.
          storeCreditUsed: creditAsked > 0 ? creditAsked : 0,
          stockStatus: "reserved",
          salesChannel: "pos",
          shiftId,
          locationId: op.locationId,
          cashierId: op.staffId,
          cashierName: op.name,
          receiptNo,
          supplierState,
          placeOfSupplyState: placeOfSupply,
          customerGstin,
        } satisfies OrderInsert as typeof orders.$inferInsert)
        .returning({ id: orders.id, order_ref: orders.orderRef }),
    );
    orderRef = (rows[0] as { order_ref?: string })?.order_ref ?? "";
  } catch (err) {
    console.error("placePosSale (order):", errMsg(err));
    return { error: "Couldn't record the sale. Please try again." };
  }

  const reserved: Array<{ p: string; v: string | null; q: number }> = [];
  const releaseStock = async () => {
    for (const r of reserved) {
      await withService((db) =>
        db.execute(
          sql`select release_stock_at(p_store => ${op.storeId}, p_location => ${op.locationId}, p_product => ${r.p}, p_variant => ${r.v}, p_qty => ${r.q}, p_order => ${orderId}, p_reason => ${"pos_sale_failed"})`,
        ),
      ).catch((e) => console.error("release_stock_at:", errMsg(e)));
    }
  };
  const deleteOrder = async () => {
    await withService((db) =>
      db.delete(orders).where(eq(orders.id, orderId)),
    ).catch((e) => console.error("pos order rollback:", errMsg(e)));
  };

  for (const l of priced) {
    let ok: boolean | undefined;
    try {
      const res = await withService((db) =>
        db.execute(
          sql`select reserve_stock_at(p_store => ${op.storeId}, p_location => ${op.locationId}, p_product => ${l.product_id}, p_variant => ${l.variant_id}, p_qty => ${l.quantity}, p_order => ${orderId}) as reserved`,
        ),
      );
      ok =
        (res.rows[0] as { reserved?: boolean } | undefined)?.reserved ?? false;
    } catch (err) {
      console.error("reserve_stock_at:", errMsg(err));
      ok = false;
    }
    if (!ok) {
      await releaseOffers();
      await releaseStock();
      await deleteOrder();
      const label = l.variant_name ? `${l.name} (${l.variant_name})` : l.name;
      return { error: `Not enough stock for ${label} at this location.` };
    }
    reserved.push({ p: l.product_id, v: l.variant_id, q: l.quantity });
  }

  // ★★ SPENT AFTER THE ORDER EXISTS, because the ledger row references the
  // order — the same ordering constraint reserve_stock_at has. And spent BEFORE
  // the items are written, so the only rollback needed on failure is the two
  // steps already above it.
  //
  // ⚠ This is the ONE place a POS sale can fail for a reason the cashier could
  // not have predicted: the pre-check above passed, and the balance moved
  // underneath us (the customer spent it at another till in the interim). That
  // is rare and it is not an error — it is refused with the real reason, and
  // the sale can be re-rung against a different tender.
  if (creditAsked > 0 && customerId) {
    const spent = await spendCredit({
      storeId: op.storeId,
      customerId,
      amount: creditAsked,
      orderId,
      note: `In-store sale ${orderRef}`,
    });
    if (!spent) {
      await releaseOffers();
      await releaseStock();
      await deleteOrder();
      return {
        error:
          "That store credit was just used elsewhere. Check the balance and take payment another way.",
      };
    }
  }

  try {
    await withService((db) =>
      db.insert(orderItems).values(
        priced.map((l, i) => {
          const lineTax = totals.taxLines[i]?.tax ?? 0;
          const g = splitGst(gstEnabled ? lineTax : 0, intra);
          return {
            id: orderItemIds[i],
            orderId,
            productId: l.product_id,
            variantId: l.variant_id,
            name: l.name,
            variantName: l.variant_name,
            price: l.unit_price,
            unitCost: l.unit_cost,
            quantity: l.quantity,
            total: l.amount,
            lineDiscount: l.line_discount,
            // §8: the offer's share of THIS line. `total` stays gross of it,
            // exactly as it is of the order discount, so `refundBreakdown`
            // subtracts it directly rather than re-allocating it — which is
            // what stops a returned free line refunding full price.
            offerDiscount: offerDiscounts[i],
            taxRate: l.tax_rate,
            taxAmount: lineTax,
            taxClassName: l.tax_class_name,
            taxCgst: g.cgst,
            taxSgst: g.sgst,
            taxIgst: g.igst,
            hsnCode: l.hsn_code,
          };
        }),
      ),
    );
  } catch (err) {
    console.error("placePosSale (items):", errMsg(err));
    await releaseOffers();
    await releaseStock();
    await deleteOrder();
    return { error: "Couldn't save the sale's items. Please try again." };
  }

  try {
    await withService((db) =>
      db.insert(orderPayments).values(
        tenders.map((t) => ({
          orderId,
          storeId: op.storeId,
          shiftId,
          method: t.method,
          amount: t.amount,
          tendered: t.method === "cash" ? (t.tendered ?? t.amount) : null,
          changeDue: t.method === "cash" ? changeDue : null,
          reference: t.reference?.slice(0, 120) ?? null,
        })),
      ),
    );
  } catch (err) {
    console.error("placePosSale (payments):", errMsg(err));
    // ★★ ONE FAILURE HERE IS NOT LIKE THE OTHERS. A unique violation on a sale
    // carrying a gateway tender is `order_payments_gateway_ref_key` firing:
    // that payment already settled a different sale, so the app-level check
    // above lost a race. Swallowing it would leave a sale marked `paid` with NO
    // payment rows at all — invisible to shift reconciliation, and claiming
    // money that belongs to another order. Unwind instead.
    if (hasGatewayTender && isUniqueViolation(err)) {
      await releaseOffers();
      await releaseStock();
      await deleteOrder();
      return {
        error: "That online payment has already been used on another sale.",
      };
    }
    // Everything else keeps the original rule: the sale IS recorded and the
    // stock is taken, so losing the tender BREAKDOWN must not void a completed
    // transaction. Logged loudly for reconciliation.
  }

  if (exchangeReturnId) {
    await withService((db) =>
      db
        .update(orderReturns)
        .set({ exchangeOrderId: orderId })
        .where(
          and(
            eq(orderReturns.id, exchangeReturnId),
            eq(orderReturns.storeId, op.storeId),
            isNull(orderReturns.exchangeOrderId),
          ),
        ),
    ).catch((error) =>
      // The sale and payment are already real. Losing the relationship must
      // not void them; the return and replacement remain recoverable by refs.
      logError("pos.exchange_link", error, { exchangeReturnId, orderId }),
    );
  }

  // ── The money audit (Step 14) ─────────────────────────────────────────────
  // ★ AFTER THE SALE IS RECORDED, deliberately. A refused sale gave nothing
  // away, so auditing earlier would log discounts that never happened — and
  // this action returns early in a dozen places before the order exists.
  //
  // ★ ONE ROW PER ACT, not per sale. A discount and a price override on the
  // same basket are two different decisions by (possibly) two different people.
  //
  // Best-effort and deferred, the posAudit rule: a logging failure must never
  // reach a cashier standing in front of a customer.
  const givenAway = discount + priced.reduce((n, l) => n + l.line_discount, 0);
  if (givenAway > 0) {
    after(() =>
      posAudit({
        storeId: op.storeId,
        event: "sale_discount",
        locationId: op.locationId,
        staffId: op.staffId,
        actor: op.name,
        approver: approval?.approverId ?? null,
        amount: givenAway,
        orderId,
        detail: `${orderRef || orderId.slice(0, 8)} · ₹${givenAway.toLocaleString("en-IN")} off${
          discount > 0 && priced.some((l) => l.line_discount > 0)
            ? " (order + lines)"
            : discount > 0
              ? " (order)"
              : " (lines)"
        }`,
      }),
    );
  }
  if (overrideLines > 0 && overrideGivenAway !== 0) {
    after(() =>
      posAudit({
        storeId: op.storeId,
        event: "price_override",
        locationId: op.locationId,
        staffId: op.staffId,
        actor: op.name,
        approver: approval?.approverId ?? null,
        // Negative is possible and is NOT an error: repricing UP happens, and
        // recording it as a give-away would misstate the shop's exposure.
        amount: overrideGivenAway,
        orderId,
        detail: `${orderRef || orderId.slice(0, 8)} · ${overrideLines} line${overrideLines === 1 ? "" : "s"} repriced`,
      }),
    );
  }

  // An in-store sale is a sale. Without this it existed only in the orders
  // table: absent from /dashboard/logs, absent from the team's "new order"
  // alert, and — because reserve_stock_at bypassed the checkout path — it could
  // empty a shelf without ever tripping the low-stock warning. The register was
  // the one channel the store couldn't see happening.
  emitEvent({
    type: "order.placed",
    storeId: op.storeId,
    // The register this was rung at, so a store can route in-store alerts to
    // the staff who actually work there (routing scope "event_location").
    locationId: op.locationId,
    actor: { type: "admin", id: op.staffId ?? null, label: op.name },
    subject: { type: "order", id: orderId, label: orderRef },
    // New POS sales always carry this customer. The schema remains nullable
    // for historical anonymous rows and other order channels.
    customerId,
    payload: {
      total,
      currency: "INR",
      items: summariseItems(
        priced.map((l) => ({
          name: l.name,
          variantName: l.variant_name,
          quantity: l.quantity,
        })),
      ),
      paymentMethod: "pos",
      channel: "In-store",
    },
    // Same order summary the thermal receipt prints, so an attached customer's
    // emailed copy and the paper in their hand agree line for line.
    email: {
      currency: "INR",
      items: priced.map((l) => ({
        name: l.name,
        variant: l.variant_name,
        quantity: l.quantity,
        total: l.amount,
      })),
      subtotal: totals.subtotal,
      discount: totals.discount,
      tax: totals.tax,
      total: totals.total,
    },
  });

  // Which offer discounted which line, and who redeemed what. AFTER the sale is
  // fully committed and best-effort: losing it is a reporting gap, while
  // failing here would have taken the customer's money and then told the
  // cashier the sale did not go through.
  if (
    offerResult &&
    (offerResult.allocations.length > 0 || redeemedOffers.length > 0)
  ) {
    await recordOfferRedemptions({
      storeId: op.storeId,
      orderId,
      customerId: customerId ?? null,
      result: offerResult,
      redeemed: redeemedOffers,
      orderItemIdByLine: new Map(
        priced.map((_, idx) => [String(idx), orderItemIds[idx]]),
      ),
    });
  }

  // ★★ CASHBACK, AFTER THE SALE COMMITS. Same rule as online: a liability, not
  // a discount, so it changes nothing the customer paid and must never fail a
  // sale whose money is already in the drawer.
  //
  // ★ IT NEEDS A CUSTOMER, and at this counter there always is one — Charge
  // requires an attached customer before any pricing or payment write. A
  // balance has to belong to somebody; issuing it to nobody would be a
  // liability the shop could never honour.
  if (offerResult?.credit && offerResult.credit.amount > 0 && customerId) {
    await issueCredit({
      storeId: op.storeId,
      customerId,
      amount: offerResult.credit.amount,
      kind: "cashback",
      ref: orderId,
      note: offerResult.credit.offerName,
    }).catch((err: unknown) =>
      logError("pos.cashback_failed", err, { storeId: op.storeId, orderId }),
    );
  }

  reportStockChanges(
    op.storeId,
    lines.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      delta: -l.quantity,
    })),
  );

  // ★ A COPY IN THEIR INBOX, WHEN NOTHING ELSE WILL SEND ONE.
  // Deferred like emitEvent: a Resend round-trip has no business sitting on the
  // path between a customer paying and the till showing the change due. It
  // never throws, so a mail failure cannot cost a sale that has already taken
  // money and moved stock.
  const receiptTo = normalizeReceiptEmail(opts.receiptEmail);
  if (
    shouldSendDirectReceipt({
      receiptEmail: receiptTo,
      customerId,
      customerEmail,
    })
  ) {
    after(() =>
      sendPosReceipt({
        storeId: op.storeId,
        to: receiptTo as string,
        orderRef,
        // The shop is deliberately absent: `op` carries a locationId, not a
        // name, and a query for one line of copy is not worth a round trip on
        // the sale path.
        summary: {
          currency: "INR",
          items: priced.map((l) => ({
            name: l.name,
            variant: l.variant_name,
            quantity: l.quantity,
            total: l.amount,
          })),
          subtotal: totals.subtotal,
          discount: totals.discount,
          tax: totals.tax,
          total: totals.total,
        },
        // The SAME map the thermal receipt prints from, so the paper in their
        // hand and the copy in their inbox use identical words.
        tenderLabels: tenders.map((t) => TENDER_LABEL[t.method] ?? t.method),
        changeDue,
      }),
    );
  }

  revalidatePath("/dashboard/orders");
  return {
    success: true,
    orderId,
    orderRef,
    receiptNo: receiptNo ?? orderRef,
    changeDue,
  };
}

// ---- Receipt ---------------------------------------------------------------

/**
 * Load a completed sale as a printable receipt. Operator-gated and scoped to
 * the operator's store AND location, so a register can only reprint sales rung
 * at its own counter. Everything is read from the order's snapshot.
 */
export async function getPosReceipt(orderId: string): Promise<{
  receipt?: ReceiptModel;
  detail?: {
    kind: "register" | "pickup";
    status: string;
    paymentStatus: string;
    customerName: string | null;
    customerPhone: string | null;
    customerEmail: string | null;
    completedAt: string;
  };
  error?: string;
}> {
  const op = await resolvePosOperator();
  if (!op) return { error: "Not signed in." };
  if (typeof orderId !== "string" || !orderId)
    return { error: "Invalid sale." };

  try {
    const data = await withService(async (db) => {
      const orderRows = await db
        .select({
          receipt_no: orders.receiptNo,
          order_ref: orders.orderRef,
          created_at: orders.createdAt,
          cashier_name: orders.cashierName,
          subtotal: orders.subtotal,
          discount: orders.discount,
          tax: orders.tax,
          tax_inclusive: orders.taxInclusive,
          total: orders.total,
          customer_gstin: orders.customerGstin,
          supplier_state: orders.supplierState,
          place_of_supply_state: orders.placeOfSupplyState,
          location_id: orders.locationId,
          pickup_location_id: orders.pickupLocationId,
          fulfilment_type: orders.fulfilmentType,
          pickup_status: orders.pickupStatus,
          collected_at: orders.collectedAt,
          collected_by: orders.collectedBy,
          status: orders.status,
          payment_method: orders.paymentMethod,
          payment_status: orders.paymentStatus,
          shipping_address: orders.shippingAddress,
          customer_first_name: users.firstName,
          customer_last_name: users.lastName,
          customer_phone: users.phone,
          customer_email: users.email,
        })
        .from(orders)
        .leftJoin(
          users,
          and(eq(users.id, orders.customerId), eq(users.storeId, op.storeId)),
        )
        .where(
          and(
            eq(orders.id, orderId),
            eq(orders.storeId, op.storeId),
            or(
              and(
                eq(orders.locationId, op.locationId),
                isNotNull(orders.receiptNo),
              ),
              and(
                eq(orders.fulfilmentType, "pickup"),
                eq(orders.pickupLocationId, op.locationId),
                eq(orders.pickupStatus, "collected"),
              ),
            ),
          ),
        )
        .limit(1);
      const order = orderRows[0];
      if (!order) return null;

      const items = await db
        .select({
          name: orderItems.name,
          variant_name: orderItems.variantName,
          hsn_code: orderItems.hsnCode,
          quantity: orderItems.quantity,
          price: orderItems.price,
          total: orderItems.total,
          line_discount: orderItems.lineDiscount,
          tax_rate: orderItems.taxRate,
          tax_class_name: orderItems.taxClassName,
          tax_amount: orderItems.taxAmount,
          tax_cgst: orderItems.taxCgst,
          tax_sgst: orderItems.taxSgst,
          tax_igst: orderItems.taxIgst,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));

      const payments = await db
        .select({
          method: orderPayments.method,
          amount: orderPayments.amount,
          tendered: orderPayments.tendered,
          change_due: orderPayments.changeDue,
          reference: orderPayments.reference,
        })
        .from(orderPayments)
        .where(eq(orderPayments.orderId, orderId));

      const loc = await db
        .select({
          name: storeLocations.name,
          address: storeLocations.address,
          gstin: storeLocations.gstin,
        })
        .from(storeLocations)
        .where(eq(storeLocations.id, op.locationId))
        .limit(1);

      const billing = await db
        .select({
          gst_enabled: storeBillingSettings.gstEnabled,
          legal_name: storeBillingSettings.legalName,
          business_name: storeBillingSettings.businessName,
          contact_phone: storeBillingSettings.contactPhone,
          footer_note: storeBillingSettings.footerNote,
        })
        .from(storeBillingSettings)
        .where(eq(storeBillingSettings.storeId, op.storeId))
        .limit(1);

      return {
        order,
        items,
        payments,
        loc: loc[0] ?? null,
        b: billing[0] ?? null,
      };
    });

    if (!data) return { error: "That sale isn't available on this register." };

    const brand = await getStoreBrandById(op.storeId).catch(() => null);
    const payments =
      data.payments.length > 0
        ? data.payments
        : data.order.payment_status === "paid"
          ? [
              {
                method: data.order.payment_method,
                amount: Number(data.order.total) || 0,
                tendered: null,
                change_due: null,
                reference: null,
              },
            ]
          : [];
    const addr = (data.order.shipping_address ?? {}) as Record<string, unknown>;
    const customerName =
      [data.order.customer_first_name, data.order.customer_last_name]
        .filter(Boolean)
        .join(" ")
        .trim() ||
      [addr.firstName, addr.lastName].filter(Boolean).join(" ").trim() ||
      null;
    const kind =
      data.order.fulfilment_type === "pickup" &&
      data.order.pickup_status === "collected"
        ? "pickup"
        : "register";

    return {
      receipt: buildReceiptModel({
        store: {
          name: data.b?.business_name || brand?.name || "Store",
          legalName: data.b?.legal_name ?? null,
          phone: data.b?.contact_phone ?? null,
        },
        location: data.loc,
        order: data.order,
        items: data.items,
        payments,
        gstEnabled: !!data.b?.gst_enabled,
        footerNote: data.b?.footer_note ?? null,
      }),
      detail: {
        kind,
        status: data.order.status,
        paymentStatus: data.order.payment_status,
        customerName,
        customerPhone:
          data.order.customer_phone ??
          (typeof addr.phone === "string" ? addr.phone : null),
        customerEmail:
          data.order.customer_email ??
          (typeof addr.email === "string" ? addr.email : null),
        completedAt:
          kind === "pickup"
            ? (data.order.collected_at ?? data.order.created_at)
            : data.order.created_at,
      },
    };
  } catch (err) {
    return { error: dbErrorMessage(err, "Couldn't load the receipt.") };
  }
}

// NOTE: do not re-export types from this file. In a "use server" module every
// export becomes a server-action entry, so `export type { … }` fails the
// production build ("Export X doesn't exist in target module") even though dev
// and unit tests pass. Import PosOperator from @/lib/pos/operator instead.

// ---- Sale lookup (reprint / "what did I just ring?") ----------------------

export interface PosSaleRow {
  id: string;
  receiptNo: string;
  orderRef: string;
  total: number;
  createdAt: string;
  cashierName: string | null;
  customerName: string | null;
  itemCount: number;
  paymentMethod: string;
  /** The sale was undone outright. */
  cancelled: boolean;
  /**
   * How much of the money has gone back.
   *
   * ★ DERIVED FROM `payment_status`, NOT `orders.status`. It used to read
   * `status === "refunded"`, which only ever became true because the till
   * WROTE it — and once counter refunds moved onto the shared money core that
   * write went away, leaving a fully refunded sale looking untouched in this
   * list. `syncOrderRefundState` is the designed mechanism: it recomputes
   * payment_status from refunds that actually SETTLED, so a refund that later
   * fails moves the sale back off "refunded" (§26). Re-introducing a manual
   * status write would be a flag that cannot move back.
   *
   * ★ AND IT IS THREE-STATE, because a partial refund still has goods on it.
   * Collapsing it to a boolean would hide the "Return items" link on a sale
   * the customer can still bring the rest of back.
   */
  refund: "none" | "partial" | "full";
  kind: "register" | "pickup";
}

/**
 * Recent till sales at THIS shop, newest first.
 *
 * Why a cashier and not just a manager: the commonest reason to look a sale up
 * is a customer standing at the counter asking for their bill again. Making
 * that a manager's job stops the queue.
 *
 * Scoped to the operator's own location, never a location from the client.
 * A sale is either rung at this register, or an in-store pickup actually
 * handed over here. Merely routing an open online order to this shop does not
 * make it a completed counter sale.
 */
export async function listPosSales(
  query?: string,
  range?: string,
): Promise<{ sales: PosSaleRow[]; error?: string }> {
  const op = await resolvePosOperator();
  if (!op) return { sales: [], error: "Not signed in." };
  if (!posCan(op.role, "sell")) return { sales: [], error: "Not allowed." };

  const q = (query ?? "").trim().slice(0, 60);
  const like = likePattern(q);
  // The client sends a KEY, never timestamps: the window is the SHOP's calendar
  // day (Asia/Kolkata), decided here, so it cannot depend on a device clock —
  // and an unrecognised key falls back to no filter rather than an empty list,
  // because a till showing "no sales" when there are sales is the worse failure.
  const window = isPosDateRangeKey(range) ? posDateRange(range) : null;

  try {
    const rows = await withService((db) =>
      db
        .select({
          id: orders.id,
          receipt_no: orders.receiptNo,
          order_ref: orders.orderRef,
          total: orders.total,
          created_at: orders.createdAt,
          cashier_name: orders.cashierName,
          shipping_address: orders.shippingAddress,
          customer_first_name: users.firstName,
          customer_last_name: users.lastName,
          payment_method: orders.paymentMethod,
          status: orders.status,
          payment_status: orders.paymentStatus,
          fulfilment_type: orders.fulfilmentType,
          pickup_status: orders.pickupStatus,
          completed_at: sql<string>`coalesce(${orders.collectedAt}, ${orders.createdAt})`,
        })
        .from(orders)
        .leftJoin(
          users,
          and(eq(users.id, orders.customerId), eq(users.storeId, op.storeId)),
        )
        .where(
          and(
            eq(orders.storeId, op.storeId),
            or(
              and(
                eq(orders.locationId, op.locationId),
                isNotNull(orders.receiptNo),
              ),
              and(
                eq(orders.fulfilmentType, "pickup"),
                eq(orders.pickupLocationId, op.locationId),
                eq(orders.pickupStatus, "collected"),
              ),
            ),
            q
              ? or(
                  ilike(orders.receiptNo, like),
                  ilike(orders.orderRef, like),
                  sql`${orders.shippingAddress}::text ilike ${like}`,
                  ilike(users.firstName, like),
                  ilike(users.lastName, like),
                  ilike(users.phone, like),
                  ilike(users.email, like),
                )
              : undefined,
            // Half-open [from, to): `yesterday` ends exactly where `today`
            // begins, so a sale lands in one window or the other, never both.
            window
              ? gte(
                  sql`coalesce(${orders.collectedAt}, ${orders.createdAt})`,
                  window.from.toISOString(),
                )
              : undefined,
            window
              ? lt(
                  sql`coalesce(${orders.collectedAt}, ${orders.createdAt})`,
                  window.to.toISOString(),
                )
              : undefined,
          ),
        )
        .orderBy(
          desc(sql`coalesce(${orders.collectedAt}, ${orders.createdAt})`),
        )
        .limit(60),
    );

    // Item counts as their own grouped query, NOT a correlated subquery in the
    // select. Interpolating columns into sql`` renders them UNQUALIFIED —
    // `where "order_id" = "id"` — and inside the subquery both names resolve to
    // order_items, so it silently counts zero for every row. Two plain queries
    // can't be wrong that way.
    const counts = new Map<string, number>();
    if (rows.length > 0) {
      const countRows = await withService((db) =>
        db
          .select({
            order_id: orderItems.orderId,
            n: count(),
          })
          .from(orderItems)
          .where(
            inArray(
              orderItems.orderId,
              rows.map((r) => r.id),
            ),
          )
          .groupBy(orderItems.orderId),
      );
      for (const c of countRows) counts.set(c.order_id, Number(c.n) || 0);
    }

    return {
      sales: rows.map((r) => {
        const addr = (r.shipping_address ?? {}) as Record<string, unknown>;
        const name =
          [r.customer_first_name, r.customer_last_name]
            .filter(Boolean)
            .join(" ")
            .trim() ||
          [addr.firstName, addr.lastName].filter(Boolean).join(" ").trim() ||
          null;
        return {
          id: r.id,
          receiptNo: r.receipt_no ?? r.order_ref ?? "",
          orderRef: r.order_ref ?? "",
          total: Number(r.total) || 0,
          createdAt: r.completed_at ?? r.created_at,
          cashierName: personLabel(r.cashier_name),
          customerName: name,
          itemCount: counts.get(r.id) ?? 0,
          paymentMethod: r.payment_method ?? "",
          cancelled: r.status === "cancelled",
          refund:
            r.payment_status === "refunded"
              ? ("full" as const)
              : r.payment_status === "partially_refunded"
                ? ("partial" as const)
                : ("none" as const),
          kind:
            r.fulfilment_type === "pickup" && r.pickup_status === "collected"
              ? "pickup"
              : "register",
        };
      }),
    };
  } catch (err) {
    return { sales: [], error: dbErrorMessage(err, "Couldn't load sales.") };
  }
}

/**
 * A receipt address, or null.
 *
 * ★ A BAD ADDRESS IS DROPPED, NOT REFUSED. This runs AFTER the money is taken
 * and the stock is moved; failing the sale over a typo in an OPTIONAL field
 * would be the worst possible trade (roadmap invariant 6). The till validates
 * before submitting, so a rejection here would be a second opinion nobody sees.
 */
function normalizeReceiptEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase().slice(0, 160);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}
