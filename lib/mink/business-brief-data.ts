import "server-only";

import { and, eq, gte, lt, sql } from "drizzle-orm";
import {
  getSalesAnalytics,
  locationCondition,
} from "@/app/dashboard/analytics/data";
import { orders, orderReturns } from "@/drizzle/schema";
import { withService, type UserIdentity } from "@/lib/db/client";
import { readMinkCatalogHealthByLocation } from "./catalog-health-read";
import {
  businessBriefRange,
  type BusinessBriefInput,
  type BusinessBriefSnapshot,
} from "./business-brief-types";
import type { WorkflowExecutionScope } from "./workflow-template-data";

/** Called only after the worker rechecks the requesting admin and captured scope. */
export async function collectBusinessBriefSnapshot(
  storeId: string,
  identity: UserIdentity,
  input: BusinessBriefInput,
  scope: WorkflowExecutionScope,
): Promise<BusinessBriefSnapshot> {
  const range = businessBriefRange(input);
  if (!range.compare || !range.comparisonLabel)
    throw new Error("brief_comparison_missing");
  const comparison = range.compare;
  const location = {
    locationIds: scope.locationIds,
    selectedId: null,
    includeUnassigned: input.includeUnassigned,
  };
  // Two concurrent analytics queries at a time; no query per location or SKU.
  const [current, previous] = await Promise.all([
    getSalesAnalytics(
      storeId,
      location,
      { ...range, compare: null, comparison: "none" },
      "all",
    ),
    getSalesAnalytics(
      storeId,
      location,
      {
        ...range,
        current: comparison,
        compare: null,
        comparison: "none",
        label: range.comparisonLabel,
      },
      "all",
    ),
  ]);
  const inventory = await readMinkCatalogHealthByLocation({
    storeId,
    identity,
    locationIds: scope.locationIds,
    defaultThreshold: input.defaultLowStockThreshold,
  });
  if (inventory.locations.length !== scope.locationIds.length)
    throw new Error("brief_location_scope_changed");
  const activity = await withService(async (db) => {
    const [payment] = await db
      .select({
        created: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where ${orders.paymentStatus} = 'failed')::int`,
      })
      .from(orders)
      .where(
        and(
          eq(orders.storeId, storeId),
          locationCondition(location),
          gte(orders.createdAt, range.current.from.toISOString()),
          lt(orders.createdAt, range.current.to.toISOString()),
        ),
      );
    const [returns] = await db
      .select({
        current: sql<number>`count(*) filter (where ${orderReturns.createdAt} >= ${range.current.from.toISOString()} and ${orderReturns.createdAt} < ${range.current.to.toISOString()})::int`,
        previous: sql<number>`count(*) filter (where ${orderReturns.createdAt} >= ${comparison.from.toISOString()} and ${orderReturns.createdAt} < ${comparison.to.toISOString()})::int`,
      })
      .from(orderReturns)
      .innerJoin(
        orders,
        and(eq(orders.id, orderReturns.orderId), eq(orders.storeId, storeId)),
      )
      .where(
        and(
          eq(orderReturns.storeId, storeId),
          locationCondition(location),
          sql`${orderReturns.status} not in ('rejected', 'cancelled')`,
          gte(orderReturns.createdAt, comparison.from.toISOString()),
          lt(orderReturns.createdAt, range.current.to.toISOString()),
        ),
      );
    if (!payment || !returns) throw new Error("brief_activity_unavailable");
    return { payment, returns };
  });
  // All sources must succeed. No catch-to-zero or fabricated healthy summary.
  return {
    period: input.period,
    rangeLabel: range.label,
    comparisonLabel: range.comparisonLabel,
    fromInclusive: range.current.from.toISOString(),
    toExclusive: range.current.to.toISOString(),
    timeZone: range.timeZone,
    currency: input.currency,
    locationLabel: scope.locationLabel,
    netSales: current.totalSales.value,
    previousNetSales: previous.totalSales.value,
    orders: current.orders.value,
    previousOrders: previous.orders.value,
    returns: Number(activity.returns.current),
    previousReturns: Number(activity.returns.previous),
    createdOrders: Number(activity.payment.created),
    failedPaymentOrders: Number(activity.payment.failed),
    locations: inventory.locations.map(
      ({ id, name, trackedItems, lowStock, outOfStock }) => ({
        id,
        name,
        trackedItems,
        lowStock,
        outOfStock,
      }),
    ),
    dataAsOf: new Date().toISOString(),
  };
}
