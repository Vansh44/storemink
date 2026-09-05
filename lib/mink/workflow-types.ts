import type { BusinessBriefResult } from "./business-brief-types";

export const MINK_WORKFLOW_TEMPLATES = [
  "business_brief",
  "weekly_trading_report",
  "revenue_decline_investigation",
  "product_launch_preparation",
  "slow_inventory_promotion",
  "delayed_pickup_review",
] as const;
export type MinkWorkflowTemplate = (typeof MINK_WORKFLOW_TEMPLATES)[number];

export const MINK_WORKFLOW_STATUSES = [
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
] as const;
export type MinkWorkflowStatus = (typeof MINK_WORKFLOW_STATUSES)[number];

export const MINK_REVENUE_PERIODS = ["7d", "30d", "90d"] as const;
export type MinkRevenuePeriod = (typeof MINK_REVENUE_PERIODS)[number];

export const MINK_SLOW_INVENTORY_PERIODS = ["30d", "90d"] as const;
export type MinkSlowInventoryPeriod =
  (typeof MINK_SLOW_INVENTORY_PERIODS)[number];

export interface MinkWorkflowAuthorityInput {
  timeZone: string;
  currency: string;
  locationIds: string[];
  /** True when locationIds came from an explicit admin-location restriction. */
  restrictedLocationScope: boolean;
  includeUnassigned: boolean;
  locationLabel: string;
  /** Used only to re-check platform-operator access when a worker executes. */
  requesterEmail: string | null;
  requestedAt: string;
}

/**
 * Keep durable work inside both its captured ceiling and the actor's current
 * location authority. `currentBindingIds = null` means a current trusted
 * superadmin/platform bypass; an empty array is deliberately distinct because
 * removing every binding from a previously restricted actor must fail closed.
 */
export function narrowMinkWorkflowLocationIds(
  input: Pick<
    MinkWorkflowAuthorityInput,
    "locationIds" | "restrictedLocationScope"
  >,
  activeLocationIds: readonly string[],
  currentBindingIds: readonly string[] | null,
): string[] | null {
  const active = new Set(activeLocationIds);
  const capturedActive = input.locationIds.filter((id) => active.has(id));
  if (currentBindingIds === null) return capturedActive;
  if (currentBindingIds.length === 0) {
    return input.restrictedLocationScope ? null : capturedActive;
  }
  const currentlyAllowed = new Set(currentBindingIds);
  const narrowed = capturedActive.filter((id) => currentlyAllowed.has(id));
  return narrowed.length > 0 ? narrowed : null;
}

export type WeeklyTradingReportInput = MinkWorkflowAuthorityInput;

export interface WeeklyTradingReportSnapshot {
  rangeLabel: string;
  comparisonLabel: string | null;
  fromInclusive: string;
  toExclusive: string;
  timeZone: string;
  currency: string;
  locationLabel: string;
  netSales: number;
  netSalesTrendPercent: number | null;
  orders: number;
  ordersTrendPercent: number | null;
  averageOrderValue: number;
  averageOrderValueTrendPercent: number | null;
  unitsSold: number;
  unitsSoldTrendPercent: number | null;
  topProducts: Array<{
    id: string;
    name: string;
    units: number;
    amount: number;
    dashboardPath: string;
  }>;
  channels: Array<{
    key: string;
    name: string;
    amount: number;
    orders: number;
    share: number;
  }>;
  dataAsOf: string;
}

export interface WeeklyTradingReportResult extends WeeklyTradingReportSnapshot {
  highlights: string[];
  analyticsPath: string;
}

export interface RevenueDeclineInvestigationInput extends MinkWorkflowAuthorityInput {
  period: MinkRevenuePeriod;
}

export interface RevenueMetricSet {
  netSales: number;
  orders: number;
  averageOrderValue: number;
  unitsSold: number;
}

export interface RevenueBreakdownPoint {
  key: string;
  name: string;
  amount: number;
  orders: number;
  share: number;
  dashboardPath?: string;
}

export interface RevenueProductPoint {
  id: string;
  name: string;
  units: number;
  amount: number;
  dashboardPath: string;
}

export interface RevenueDeclineSnapshot {
  period: MinkRevenuePeriod;
  rangeLabel: string;
  comparisonLabel: string;
  fromInclusive: string;
  toExclusive: string;
  comparisonFromInclusive: string;
  comparisonToExclusive: string;
  timeZone: string;
  currency: string;
  locationLabel: string;
  current: RevenueMetricSet;
  previous: RevenueMetricSet;
  currentChannels: RevenueBreakdownPoint[];
  previousChannels: RevenueBreakdownPoint[];
  currentLocations: RevenueBreakdownPoint[];
  previousLocations: RevenueBreakdownPoint[];
  currentProducts: RevenueProductPoint[];
  previousProducts: RevenueProductPoint[];
  dataAsOf: string;
}

export interface RevenueMetricComparison {
  key: keyof RevenueMetricSet;
  label: string;
  current: number;
  previous: number;
  delta: number;
  deltaPercent: number | null;
  format: "currency" | "number";
}

export interface RevenueMovement {
  key: string;
  name: string;
  currentAmount: number;
  previousAmount: number;
  delta: number;
  deltaPercent: number | null;
  dashboardPath?: string;
}

export interface RevenueDeclineInvestigationResult extends RevenueDeclineSnapshot {
  metrics: RevenueMetricComparison[];
  findings: string[];
  channelMovements: RevenueMovement[];
  locationMovements: RevenueMovement[];
  productMovements: RevenueMovement[];
  caveats: string[];
  analyticsPath: string;
}

export interface ProductLaunchPreparationInput extends MinkWorkflowAuthorityInput {
  productId: string;
  variantId: string | null;
  requestedSku: string;
  defaultLowStockThreshold: number;
}

export interface ProductLaunchSkuSnapshot {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  sku: string;
  basePrice: number;
  sellingPrice: number;
  specialPrice: number | null;
  trackInventory: boolean;
  lowStockThreshold: number;
  totalStock: number;
  locationStocks: Array<{
    locationId: string;
    locationName: string;
    stock: number;
  }>;
  requiresShipping: boolean;
  shippingMeasurementsComplete: boolean;
  dashboardPath: string;
}

export interface ProductLaunchLocationStock {
  id: string;
  name: string;
  type: string;
  stock: number;
  dashboardPath: string;
}

export interface ProductLaunchSnapshot {
  storeName: string;
  productId: string;
  productName: string;
  requestedSku: string;
  requestedVariantName: string | null;
  status: string;
  categoryName: string | null;
  featured: boolean;
  descriptionLength: number;
  seoTitleLength: number;
  seoDescriptionLength: number;
  imageCount: number;
  variantsTruncated: boolean;
  locationLabel: string;
  timeZone: string;
  currency: string;
  skus: ProductLaunchSkuSnapshot[];
  locationStock: ProductLaunchLocationStock[];
  dataAsOf: string;
  productDashboardPath: string;
  inventoryDashboardPath: string;
}

export type ProductLaunchCheckStatus = "ready" | "action" | "blocker";

export interface ProductLaunchReadinessCheck {
  key: string;
  label: string;
  status: ProductLaunchCheckStatus;
  detail: string;
}

export interface ProductLaunchPreparationResult extends ProductLaunchSnapshot {
  readinessScore: number;
  readinessLabel: "ready" | "needs_attention" | "blocked";
  checks: ProductLaunchReadinessCheck[];
  blockers: string[];
  warnings: string[];
  checklist: string[];
  suggestedCopy: {
    headline: string;
    subheading: string;
    callToAction: string;
  };
}

export interface SlowInventoryPromotionInput extends MinkWorkflowAuthorityInput {
  period: MinkSlowInventoryPeriod;
}

export interface SlowInventoryShelfSnapshot {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  sku: string;
  locationId: string;
  locationName: string;
  stock: number;
  unitsSold: number;
  salesAmount: number;
  effectivePrice: number;
  unitCost: number | null;
  productDashboardPath: string;
  inventoryDashboardPath: string;
}

export interface SlowInventorySnapshot {
  storeName: string;
  period: MinkSlowInventoryPeriod;
  periodDays: number;
  rangeLabel: string;
  fromInclusive: string;
  toExclusive: string;
  timeZone: string;
  currency: string;
  locationLabel: string;
  locationCount: number;
  candidateShelves: SlowInventoryShelfSnapshot[];
  totalCandidateShelves: number;
  truncated: boolean;
  storeDiscountCeilingPercent: number;
  dataAsOf: string;
}

export interface SlowInventoryCandidate extends SlowInventoryShelfSnapshot {
  daysOfCover: number | null;
  sellThroughPercent: number;
  grossMarginPercent: number | null;
  reason: "no_location_sales" | "excess_cover";
}

export interface SlowInventoryPromotionResult extends Omit<
  SlowInventorySnapshot,
  "candidateShelves"
> {
  candidates: SlowInventoryCandidate[];
  promotionProposal: {
    status: "no_candidates" | "needs_terms";
    name: string;
    objective: string;
    targetSkus: string[];
    suggestedDiscountPercent: number | null;
    durationDays: 7;
    budgetRequired: true;
    activationRequiresSeparateApproval: true;
    note: string;
  };
  approvalBoundary: string[];
  caveats: string[];
  inventoryDashboardPath: string;
  offersDashboardPath: string;
}

export type DelayedPickupReviewInput = MinkWorkflowAuthorityInput;

export interface DelayedPickupSnapshotItem {
  orderRef: string;
  locationName: string;
  pickupStatus: "awaiting" | "ready";
  createdAt: string;
  promisedReadyAt: string | null;
  preparedAt: string | null;
  expiresAt: string;
  warnedAt: string | null;
  orderDashboardPath: string;
}

export interface DelayedPickupSnapshot {
  locationLabel: string;
  locationCount: number;
  timeZone: string;
  reviewedAt: string;
  riskWindowHours: 48;
  pickups: DelayedPickupSnapshotItem[];
  totalActionableOrders: number;
  preparationOverdueCount: number;
  preparationAtRiskCount: number;
  collectionDueCount: number;
  truncated: boolean;
  dataAsOf: string;
}

export type DelayedPickupIssue =
  | "preparation_overdue"
  | "preparation_at_risk"
  | "collection_due";

export type DelayedPickupReminderState =
  | "already_recorded"
  | "automatic_pending"
  | "not_due";

export interface DelayedPickupReviewItem extends DelayedPickupSnapshotItem {
  issue: DelayedPickupIssue;
  hoursUntilExpiry: number;
  hoursPastPromise: number | null;
  reminderState: DelayedPickupReminderState;
}

export interface DelayedPickupCommunication {
  kind: "preparation_delay" | "automatic_collection_reminder";
  title: string;
  status:
    | "prepared_for_review"
    | "automatic_reminder_pending"
    | "automatic_reminder_already_recorded";
  orderReferences: string[];
  subject: string | null;
  body: string | null;
  note: string;
}

export interface DelayedPickupReviewResult extends Omit<
  DelayedPickupSnapshot,
  "pickups"
> {
  pickups: DelayedPickupReviewItem[];
  communications: DelayedPickupCommunication[];
  safetyNotes: string[];
  ordersDashboardPath: string;
}

export type MinkWorkflowResult =
  | BusinessBriefResult
  | WeeklyTradingReportResult
  | RevenueDeclineInvestigationResult
  | ProductLaunchPreparationResult
  | SlowInventoryPromotionResult
  | DelayedPickupReviewResult;

export interface MinkWorkflowEventView {
  id: string;
  type: string;
  stepKey: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface MinkWorkflowView {
  id: string;
  template: MinkWorkflowTemplate;
  status: MinkWorkflowStatus;
  currentStep: number;
  totalSteps: number;
  attemptCount: number;
  errorCode: string | null;
  errorDetail: string | null;
  cancelRequested: boolean;
  result: MinkWorkflowResult | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  events?: MinkWorkflowEventView[];
}

export function buildWeeklyTradingReportResult(
  snapshot: WeeklyTradingReportSnapshot,
): WeeklyTradingReportResult {
  const highlights: string[] = [];
  if (snapshot.orders === 0) {
    highlights.push("No recognized orders were recorded in this period.");
  } else if (snapshot.netSalesTrendPercent == null) {
    highlights.push(
      "Net-sales change is unavailable because the comparison period had no recognized sales.",
    );
  } else if (snapshot.netSalesTrendPercent <= -10) {
    highlights.push(
      `Net sales fell ${formatPercent(Math.abs(snapshot.netSalesTrendPercent))} versus the previous period.`,
    );
  } else if (snapshot.netSalesTrendPercent >= 10) {
    highlights.push(
      `Net sales grew ${formatPercent(snapshot.netSalesTrendPercent)} versus the previous period.`,
    );
  } else {
    highlights.push(
      `Net sales were broadly steady (${signedPercent(snapshot.netSalesTrendPercent)}) versus the previous period.`,
    );
  }

  const leader = snapshot.topProducts[0];
  if (leader) {
    highlights.push(
      `${leader.name} led unit sales with ${leader.units.toLocaleString("en-IN")} sold.`,
    );
  }
  const channel = snapshot.channels[0];
  if (channel && snapshot.channels.length > 1) {
    highlights.push(
      `${channel.name} was the largest sales channel at ${channel.share.toLocaleString("en-IN")}% of recognized net sales.`,
    );
  }

  return {
    ...snapshot,
    highlights: highlights.slice(0, 4),
    analyticsPath: "/dashboard/analytics?range=7d&compare=previous",
  };
}

export function buildRevenueDeclineInvestigationResult(
  snapshot: RevenueDeclineSnapshot,
): RevenueDeclineInvestigationResult {
  const metrics: RevenueMetricComparison[] = [
    metric("netSales", "Net sales", snapshot, "currency"),
    metric("orders", "Orders", snapshot, "number"),
    metric("averageOrderValue", "Average order value", snapshot, "currency"),
    metric("unitsSold", "Units sold", snapshot, "number"),
  ];
  const channelMovements = movements(
    snapshot.currentChannels,
    snapshot.previousChannels,
    6,
  );
  const locationMovements = movements(
    snapshot.currentLocations,
    snapshot.previousLocations,
    20,
  );
  const productMovements = movements(
    snapshot.currentProducts,
    snapshot.previousProducts,
    6,
  );
  const findings: string[] = [];
  const sales = metrics[0];
  if (snapshot.previous.netSales === 0) {
    findings.push(
      snapshot.current.netSales === 0
        ? "Neither period recorded recognized net sales, so there is no measurable decline to diagnose."
        : "The comparison period had no recognized net sales, so a decline percentage is not meaningful.",
    );
  } else if (sales.delta < 0) {
    findings.push(
      `Recognized net sales fell ${formatPercent(Math.abs(sales.deltaPercent ?? 0))} (${signedMoneyDelta(sales.delta, snapshot.currency)}) versus the preceding equal period.`,
    );
  } else {
    findings.push(
      `Recognized net sales did not decline; they changed ${signedPercent(sales.deltaPercent ?? 0)} (${signedMoneyDelta(sales.delta, snapshot.currency)}).`,
    );
  }
  const orders = metrics[1];
  const aov = metrics[2];
  if (orders.delta < 0) {
    findings.push(
      `Order volume decreased by ${Math.abs(orders.delta).toLocaleString("en-IN")} (${signedPercent(orders.deltaPercent ?? 0)}).`,
    );
  }
  if (aov.delta < 0) {
    findings.push(
      `Average order value decreased ${signedPercent(aov.deltaPercent ?? 0)}.`,
    );
  }
  const strongestNegative = [
    ...channelMovements.map((item) => ({ ...item, dimension: "channel" })),
    ...locationMovements.map((item) => ({ ...item, dimension: "location" })),
    ...productMovements.map((item) => ({ ...item, dimension: "product" })),
  ]
    .filter((item) => item.delta < 0)
    .sort((left, right) => left.delta - right.delta)[0];
  if (strongestNegative) {
    findings.push(
      `${strongestNegative.name} had the largest visible ${strongestNegative.dimension} decrease in the bounded breakdown (${signedMoneyDelta(strongestNegative.delta, snapshot.currency)}).`,
    );
  }

  return {
    ...snapshot,
    metrics,
    findings: findings.slice(0, 5),
    channelMovements,
    locationMovements,
    productMovements,
    caveats: [
      "These are correlations in recognized StoreMink sales data, not proof of causation.",
      "Completed refunds reduce headline net sales; product rows use merchandise line totals.",
      "External traffic, advertising spend and competitor activity are not included unless StoreMink records them.",
    ],
    analyticsPath: `/dashboard/analytics?range=${snapshot.period}&compare=previous`,
  };
}

export function buildProductLaunchPreparationResult(
  snapshot: ProductLaunchSnapshot,
): ProductLaunchPreparationResult {
  const trackedSkus = snapshot.skus.filter((sku) => sku.trackInventory);
  const invalidPrice = snapshot.skus.some(
    (sku) =>
      sku.basePrice <= 0 ||
      sku.sellingPrice <= 0 ||
      sku.sellingPrice > sku.basePrice ||
      (sku.specialPrice != null &&
        (sku.specialPrice <= 0 || sku.specialPrice > sku.sellingPrice)),
  );
  const outOfStock = trackedSkus.filter((sku) => sku.totalStock <= 0);
  const lowStock = trackedSkus.filter(
    (sku) => sku.totalStock > 0 && sku.totalStock <= sku.lowStockThreshold,
  );
  const partialLocationGaps = trackedSkus.flatMap((sku) =>
    sku.locationStocks
      .filter((location) => location.stock <= 0)
      .map((location) => `${sku.sku} at ${location.locationName}`),
  );
  const incompleteShipping = snapshot.skus.filter(
    (sku) => sku.requiresShipping && !sku.shippingMeasurementsComplete,
  );
  const checks: ProductLaunchReadinessCheck[] = [
    check(
      "publication",
      "Publication state",
      snapshot.status === "archived"
        ? "blocker"
        : snapshot.status === "published"
          ? "ready"
          : "action",
      snapshot.status === "published"
        ? "Product is published."
        : `Product is ${snapshot.status}; publication remains a separate human-approved action.`,
    ),
    check(
      "images",
      "Product media",
      snapshot.imageCount > 0 ? "ready" : "blocker",
      snapshot.imageCount > 0
        ? `${snapshot.imageCount} product ${snapshot.imageCount === 1 ? "image is" : "images are"} available.`
        : "No product image is available for launch surfaces.",
    ),
    check(
      "description",
      "Product description",
      snapshot.descriptionLength >= 80 ? "ready" : "action",
      snapshot.descriptionLength >= 80
        ? "The saved description has enough detail for review."
        : "The saved description is missing or very short; prepare and approve product copy before launch.",
    ),
    check(
      "seo",
      "Search preview",
      snapshot.seoTitleLength >= 10 && snapshot.seoDescriptionLength >= 50
        ? "ready"
        : "action",
      snapshot.seoTitleLength >= 10 && snapshot.seoDescriptionLength >= 50
        ? "SEO title and description are present."
        : "SEO title or description needs a reviewed draft.",
    ),
    check(
      "pricing",
      "Sellable pricing",
      invalidPrice ? "blocker" : "ready",
      invalidPrice
        ? "At least one SKU has a missing or invalid MRP/selling/special-price hierarchy."
        : "Every inspected SKU has a valid MRP ≥ selling price ≥ special price hierarchy.",
    ),
    check(
      "inventory",
      "Launch inventory",
      snapshot.variantsTruncated || outOfStock.length > 0
        ? "blocker"
        : lowStock.length > 0 ||
            partialLocationGaps.length > 0 ||
            trackedSkus.length === 0
          ? "action"
          : "ready",
      snapshot.variantsTruncated
        ? "The product has more than 20 sellable SKUs, so this bounded package cannot certify the complete launch."
        : outOfStock.length > 0
          ? `${outOfStock.length} tracked ${outOfStock.length === 1 ? "SKU is" : "SKUs are"} out of stock in the captured location scope.`
          : lowStock.length > 0
            ? `${lowStock.length} tracked ${lowStock.length === 1 ? "SKU is" : "SKUs are"} at or below its low-stock threshold.`
            : partialLocationGaps.length > 0
              ? `${partialLocationGaps.length} SKU-location ${partialLocationGaps.length === 1 ? "combination has" : "combinations have"} no stock (${partialLocationGaps.slice(0, 3).join(", ")}${partialLocationGaps.length > 3 ? ", and more" : ""}).`
              : trackedSkus.length === 0
                ? "Inventory tracking is off for every inspected SKU; verify availability manually."
                : "Tracked launch stock is above the configured low-stock thresholds.",
    ),
    check(
      "shipping",
      "Shipping measurements",
      incompleteShipping.length > 0 ? "action" : "ready",
      incompleteShipping.length > 0
        ? `${incompleteShipping.length} shippable ${incompleteShipping.length === 1 ? "SKU needs" : "SKUs need"} complete weight and dimensions.`
        : "Required shipping measurements are present for the inspected SKUs.",
    ),
  ];
  const blockers = checks
    .filter((item) => item.status === "blocker")
    .map((item) => item.detail);
  const warnings = checks
    .filter((item) => item.status === "action")
    .map((item) => item.detail);
  const ready = checks.filter((item) => item.status === "ready").length;
  const readinessScore = Math.round((ready / Math.max(1, checks.length)) * 100);
  const displayName = snapshot.requestedVariantName
    ? `${snapshot.productName} — ${snapshot.requestedVariantName}`
    : snapshot.productName;

  return {
    ...snapshot,
    readinessScore,
    readinessLabel:
      blockers.length > 0
        ? "blocked"
        : warnings.length > 0
          ? "needs_attention"
          : "ready",
    checks,
    blockers,
    warnings,
    checklist: [
      ...checks
        .filter((item) => item.status !== "ready")
        .map(
          (item) =>
            `Resolve ${item.label.toLocaleLowerCase("en-IN")}: ${item.detail}`,
        ),
      "Review the final product page on desktop and mobile before publishing campaign links.",
      "Choose the launch audience, channel, timing and budget; Mink does not infer or contact recipients.",
      "Use StoreMink's saved proposal and approval controls for any copy, price, publication or campaign change.",
    ].slice(0, 10),
    suggestedCopy: {
      headline: `Meet ${displayName}`,
      subheading: snapshot.categoryName
        ? `Discover ${displayName} in ${snapshot.categoryName} from ${snapshot.storeName}.`
        : `Discover ${displayName} from ${snapshot.storeName}.`,
      callToAction:
        snapshot.status === "published" ? "Shop now" : "Discover more",
    },
  };
}

export function buildSlowInventoryPromotionResult(
  snapshot: SlowInventorySnapshot,
): SlowInventoryPromotionResult {
  const { candidateShelves, ...summary } = snapshot;
  const candidates: SlowInventoryCandidate[] = candidateShelves.map((item) => {
    const daysOfCover =
      item.unitsSold > 0
        ? round((item.stock * snapshot.periodDays) / item.unitsSold, 1)
        : null;
    const grossMarginPercent =
      item.unitCost != null &&
      item.unitCost > 0 &&
      item.effectivePrice > 0 &&
      item.unitCost < item.effectivePrice
        ? round(
            ((item.effectivePrice - item.unitCost) / item.effectivePrice) * 100,
            1,
          )
        : null;
    return {
      ...item,
      daysOfCover,
      sellThroughPercent: round(
        (item.unitsSold / Math.max(1, item.unitsSold + item.stock)) * 100,
        1,
      ),
      grossMarginPercent,
      reason: item.unitsSold === 0 ? "no_location_sales" : "excess_cover",
    };
  });
  const targetSkus = Array.from(
    new Set(candidates.map((candidate) => candidate.sku)),
  ).slice(0, 5);
  const targetCandidates = targetSkus
    .map((sku) => candidates.find((candidate) => candidate.sku === sku))
    .filter((candidate): candidate is SlowInventoryCandidate =>
      Boolean(candidate),
    );
  const knownMargins = targetCandidates.map(
    (candidate) => candidate.grossMarginPercent,
  );
  const everyMarginKnown =
    targetCandidates.length > 0 &&
    knownMargins.every((margin): margin is number => margin != null);
  const marginBound = everyMarginKnown
    ? Math.floor(Math.min(...knownMargins) - 5)
    : 0;
  // ★★ A CEILING OF 0 MEANS "WITHHOLD", NOT "RECOMMEND 0%".
  // `offers.maxTotalDiscountPercent` declares `min: 0` and 0 is a real setting
  // — the merchant who switched offer discounting off entirely. Clamping with
  // Math.min alone turned that into an explicit `0` suggestion carrying a note
  // that claimed it preserved a five-point margin buffer, so the store that
  // locked discounting down hardest got the one nonsensical recommendation.
  const discountingAllowed = snapshot.storeDiscountCeilingPercent > 0;
  const suggestedDiscountPercent =
    everyMarginKnown && marginBound >= 5 && discountingAllowed
      ? Math.min(10, marginBound, snapshot.storeDiscountCeilingPercent)
      : null;
  const hasCandidates = targetSkus.length > 0;

  return {
    ...summary,
    candidates,
    promotionProposal: {
      status: hasCandidates ? "needs_terms" : "no_candidates",
      name: `Move slow stock · ${snapshot.locationLabel}`,
      objective: hasCandidates
        ? `Test demand for ${targetSkus.length} evidence-backed slow-moving ${targetSkus.length === 1 ? "SKU" : "SKUs"}.`
        : "No eligible slow-moving shelf was found in the selected scope.",
      targetSkus,
      suggestedDiscountPercent,
      durationDays: 7,
      budgetRequired: true,
      activationRequiresSeparateApproval: true,
      note: hasCandidates
        ? suggestedDiscountPercent == null
          ? discountingAllowed
            ? "Choose the discount only after checking missing or insufficient cost/margin data, and set a total budget before creating an offer."
            : "This store's maximum offer discount is set to 0%, so no discount was suggested. Raise that limit in offer settings first if you want to run a markdown."
          : `A conservative ${suggestedDiscountPercent}% test preserves at least a 5-point gross-margin buffer for the listed SKUs with known cost data; review actual basket economics before use.`
        : "No promotion terms were prepared because no eligible candidate was found.",
    },
    approvalBoundary: [
      "This is a private recommendation only; Mink did not create or activate an offer and did not change prices or inventory.",
      "A merchant must choose a total budget and verify exact product or variant scope in Offers before saving anything.",
      "The analysed location is evidence scope, not an offer-eligibility boundary; verify that the offer's channel and audience rules cannot discount healthy shelves unintentionally.",
      "Any saved offer must remain disabled for review; activation is a separate human approval and customer contact is a separate workflow.",
    ],
    caveats: [
      "Slow movement uses recognized order-item sales attributed to the same physical location; online or unassigned orders are not assigned to a shelf.",
      `Only published, inventory-tracked, positive-stock SKUs whose product predates the complete ${snapshot.periodDays}-day window are eligible; the current shelf stock may have changed during it.`,
      "Unit movement uses sold order-line quantities; later returns and completed refunds do not rewrite those historical quantities.",
      "Sales history is evidence of past movement, not a forecast; seasonality, incoming stock, traffic and advertising spend are not included.",
      "A discount suggestion is withheld when target cost data cannot support a five-point gross-margin buffer.",
    ],
    inventoryDashboardPath: "/dashboard/inventory",
    offersDashboardPath: "/dashboard/offers/new",
  };
}

export function buildDelayedPickupReviewResult(
  snapshot: DelayedPickupSnapshot,
): DelayedPickupReviewResult {
  const reviewedAt = new Date(snapshot.reviewedAt).getTime();
  const pickups: DelayedPickupReviewItem[] = snapshot.pickups.map((pickup) => {
    const expiryAt = new Date(pickup.expiresAt).getTime();
    const readyAt = pickup.promisedReadyAt
      ? new Date(pickup.promisedReadyAt).getTime()
      : null;
    const preparationOverdue =
      pickup.pickupStatus === "awaiting" &&
      readyAt != null &&
      readyAt <= reviewedAt;
    const issue: DelayedPickupIssue = preparationOverdue
      ? "preparation_overdue"
      : pickup.pickupStatus === "awaiting"
        ? "preparation_at_risk"
        : "collection_due";
    const hoursUntilExpiry = Math.max(
      0,
      Math.ceil((expiryAt - reviewedAt) / 3_600_000),
    );
    const reminderState: DelayedPickupReminderState = pickup.warnedAt
      ? "already_recorded"
      : hoursUntilExpiry <= snapshot.riskWindowHours
        ? "automatic_pending"
        : "not_due";
    return {
      ...pickup,
      issue,
      hoursUntilExpiry,
      hoursPastPromise:
        preparationOverdue && readyAt != null
          ? Math.max(0, Math.ceil((reviewedAt - readyAt) / 3_600_000))
          : null,
      reminderState,
    };
  });
  const preparationOrders = pickups.filter(
    (pickup) => pickup.pickupStatus === "awaiting",
  );
  const reminderPending = pickups.filter(
    (pickup) =>
      pickup.pickupStatus === "ready" &&
      pickup.reminderState === "automatic_pending",
  );
  const reminderRecorded = pickups.filter(
    (pickup) =>
      pickup.pickupStatus === "ready" &&
      pickup.reminderState === "already_recorded",
  );
  const communications: DelayedPickupCommunication[] = [];
  if (preparationOrders.length > 0) {
    communications.push({
      kind: "preparation_delay",
      title: "Pickup preparation delay",
      status: "prepared_for_review",
      orderReferences: preparationOrders.map((pickup) => pickup.orderRef),
      subject: "Update on pickup order [order reference]",
      body: "We’re sorry—your pickup order [order reference] at [location] is taking longer than planned. We now expect it to be ready by [confirmed revised ready time]. Please wait for the ready-to-collect notice before travelling.",
      note: "Confirm a revised ready time and verify the live order before adapting or sending this copy manually.",
    });
  }
  if (reminderPending.length > 0) {
    communications.push({
      kind: "automatic_collection_reminder",
      title: "Collection reminder",
      status: "automatic_reminder_pending",
      orderReferences: reminderPending.map((pickup) => pickup.orderRef),
      subject: null,
      body: null,
      note: "StoreMink’s one-time pickup reminder is pending in the existing 48-hour window, so Mink withheld duplicate message copy.",
    });
  }
  if (reminderRecorded.length > 0) {
    communications.push({
      kind: "automatic_collection_reminder",
      title: "Collection reminder",
      status: "automatic_reminder_already_recorded",
      orderReferences: reminderRecorded.map((pickup) => pickup.orderRef),
      subject: null,
      body: null,
      note: "StoreMink already recorded the one-time pickup reminder, so Mink withheld duplicate message copy.",
    });
  }

  return {
    ...snapshot,
    pickups,
    communications,
    safetyNotes: [
      "This private review does not send a message, claim a reminder, change an order, extend a deadline, cancel a pickup or move stock.",
      "Collected, expired, cancelled and fully refunded orders are excluded; verify the live order before any manual contact because pickup state can change after this snapshot.",
      "Customer names, email addresses, phone numbers, postal addresses and collection codes are never included in this workflow result.",
    ],
    ordersDashboardPath: "/dashboard/orders",
  };
}

export function isMinkWorkflowStatus(
  value: unknown,
): value is MinkWorkflowStatus {
  return MINK_WORKFLOW_STATUSES.includes(value as MinkWorkflowStatus);
}

export function isMinkWorkflowTemplate(
  value: unknown,
): value is MinkWorkflowTemplate {
  return MINK_WORKFLOW_TEMPLATES.includes(value as MinkWorkflowTemplate);
}

function metric(
  key: keyof RevenueMetricSet,
  label: string,
  snapshot: RevenueDeclineSnapshot,
  format: RevenueMetricComparison["format"],
): RevenueMetricComparison {
  const current = snapshot.current[key];
  const previous = snapshot.previous[key];
  return {
    key,
    label,
    current,
    previous,
    delta: current - previous,
    deltaPercent: percentageChange(current, previous),
    format,
  };
}

type MovementSource = RevenueBreakdownPoint | RevenueProductPoint;

function sourceKey(item: MovementSource): string {
  return "key" in item ? item.key : item.id;
}

function movements(
  current: MovementSource[],
  previous: MovementSource[],
  limit: number,
): RevenueMovement[] {
  const rows = new Map<string, RevenueMovement>();
  for (const item of previous) {
    const key = sourceKey(item);
    rows.set(key, {
      key,
      name: item.name,
      currentAmount: 0,
      previousAmount: item.amount,
      delta: -item.amount,
      deltaPercent: item.amount === 0 ? null : -100,
      dashboardPath: item.dashboardPath,
    });
  }
  for (const item of current) {
    const key = sourceKey(item);
    const existing = rows.get(key);
    const previousAmount = existing?.previousAmount ?? 0;
    rows.set(key, {
      key,
      name: item.name,
      currentAmount: item.amount,
      previousAmount,
      delta: item.amount - previousAmount,
      deltaPercent: percentageChange(item.amount, previousAmount),
      dashboardPath: item.dashboardPath ?? existing?.dashboardPath,
    });
  }
  return [...rows.values()]
    .sort(
      (left, right) =>
        left.delta - right.delta || left.name.localeCompare(right.name),
    )
    .slice(0, limit);
}

function check(
  key: string,
  label: string,
  status: ProductLaunchCheckStatus,
  detail: string,
): ProductLaunchReadinessCheck {
  return { key, label, status, detail };
}

function percentageChange(current: number, previous: number): number | null {
  return previous === 0 ? null : ((current - previous) / previous) * 100;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function formatPercent(value: number): string {
  return `${Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
}

function signedPercent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
}

function signedMoneyDelta(value: number, currency: string): string {
  const absolute = Math.abs(value);
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(absolute);
  } catch {
    formatted = absolute.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatted}`;
}
