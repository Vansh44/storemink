import "server-only";

import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  minkActionAudit,
  minkActionToolAccess,
  minkRuns,
  minkDrafts,
  minkFeedback,
  minkStoreAccess,
  minkToolCalls,
  minkUsageLedger,
  stores,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { MINK_CREDIT_BANDS, MINK_OUTPUT_WEIGHT } from "@/lib/mink/metering";

export const MINK_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type MinkRunStatus = (typeof MINK_RUN_STATUSES)[number];

export interface MinkRunFilters {
  days: 1 | 7 | 30;
  status: MinkRunStatus | "all";
  q: string;
  actor: string;
}

export interface PlatformMinkRuns {
  summary: {
    totalRuns: number;
    succeededRuns: number;
    successRate: number | null;
    p95LatencyMs: number | null;
    retryCount: number;
    totalTokens: number;
    /** Prompt tokens a provider cache served, summed across runs. */
    cachedTokens: number;
    knownCostMicrousd: number;
    unknownOrPartialCostRuns: number;
    timedOutRuns: number;
    helpfulRuns: number;
    unhelpfulRuns: number;
    shadowCredits: number;
    /** Runs per shadow band — the calibration signal for the boundaries. */
    lightRuns: number;
    standardRuns: number;
    heavyRuns: number;
    chargedCredits: number;
    invitedStores: number;
    draftingStores: number;
    proposedDrafts: number;
    savedDrafts: number;
    actionEnabledStores: number;
    executedActions: number;
    refusedActions: number;
  };
  runs: Array<{
    id: string;
    requestId: string;
    storeId: string;
    storeName: string;
    storeSlug: string;
    requestedBy: string;
    status: string;
    model: string;
    inputTokens: number;
    cachedTokens: number | null;
    outputTokens: number;
    thoughtTokens: number;
    totalTokens: number;
    stepCount: number;
    toolCallCount: number;
    retryCount: number;
    latencyMs: number | null;
    errorCode: string | null;
    startedAt: string;
    completedAt: string | null;
    usageStatus: string | null;
    estimatedCostMicrousd: number | null;
    pricingVersion: string | null;
    shadowCredits: number | null;
    costCohort: string | null;
    currentPath: string | null;
    selectedResourceType: string | null;
    feedbackRating: string | null;
    feedbackIssueCategory: string | null;
    feedbackDetailsRedacted: string | null;
    toolNames: string[];
  }>;
}

export function normalizeMinkRunFilters(input: {
  days?: string | string[];
  status?: string | string[];
  q?: string | string[];
  actor?: string | string[];
}): MinkRunFilters {
  const daysValue = first(input.days);
  const statusValue = first(input.status);
  return {
    days: daysValue === "1" ? 1 : daysValue === "30" ? 30 : 7,
    status: MINK_RUN_STATUSES.includes(statusValue as MinkRunStatus)
      ? (statusValue as MinkRunStatus)
      : "all",
    q: (first(input.q) ?? "").trim().slice(0, 100),
    actor: (first(input.actor) ?? "").trim().slice(0, 128),
  };
}

/**
 * Count runs whose measured size falls in shadow band `index`.
 *
 * The weighted expression mirrors `weightedMinkUnits` exactly — input plus
 * five output-equivalents — with the weight and boundaries interpolated from
 * lib/mink/metering.ts, so the console can never band a run differently from
 * the meter. Rows whose usage was never usable are excluded by COHORT rather
 * than by shadow_credits, because that column carries a pre-band placeholder
 * on historical rows while the cohort has always been accurate.
 */
function bandRuns(index: number): SQL<number> {
  const weighted = sql`(${minkUsageLedger.inputTokens} + ${MINK_OUTPUT_WEIGHT} * (${minkUsageLedger.outputTokens} + ${minkUsageLedger.thoughtTokens}))`;
  const floor = index === 0 ? null : MINK_CREDIT_BANDS[index - 1].maxUnits;
  const ceiling = MINK_CREDIT_BANDS[index].maxUnits;
  const lower = floor === null ? sql`true` : sql`${weighted} > ${floor}`;
  const upper = ceiling === null ? sql`true` : sql`${weighted} <= ${ceiling}`;
  return sql<number>`count(*) filter (
    where ${minkUsageLedger.runId} is not null
      and ${minkUsageLedger.costCohort} not in ('read_failed', 'read_unknown')
      and ${lower} and ${upper}
  )::int`;
}

/** Cross-tenant, redacted Mink operational telemetry for authorized operators. */
export async function getPlatformMinkRuns(
  filters: MinkRunFilters,
): Promise<PlatformMinkRuns> {
  const since = new Date(Date.now() - filters.days * 86_400_000).toISOString();
  const conditions: SQL[] = [gte(minkRuns.startedAt, since)];
  if (filters.status !== "all") {
    conditions.push(eq(minkRuns.status, filters.status));
  }
  if (filters.actor) conditions.push(eq(minkRuns.requestedBy, filters.actor));
  if (filters.q) {
    const pattern = `%${escapeLike(filters.q)}%`;
    conditions.push(
      or(
        ilike(stores.name, pattern),
        ilike(stores.slug, pattern),
        sql`${minkRuns.id}::text ilike ${pattern}`,
        sql`${minkRuns.requestId}::text ilike ${pattern}`,
      ) as SQL,
    );
  }
  const where = and(...conditions);

  return withService(async (db) => {
    const summaryRows = await db
      .select({
        totalRuns: sql<number>`count(*)::int`,
        succeededRuns: sql<number>`count(*) filter (where ${minkRuns.status} = 'succeeded')::int`,
        p95LatencyMs: sql<
          number | null
        >`(percentile_cont(0.95) within group (order by ${minkRuns.latencyMs}) filter (where ${minkRuns.latencyMs} is not null))::float8`,
        retryCount: sql<number>`coalesce(sum(${minkRuns.retryCount}), 0)::float8`,
        totalTokens: sql<number>`coalesce(sum(${minkRuns.totalTokens}), 0)::float8`,
        // Read from the LEDGER, not from mink_runs: only the ledger records
        // what a cache served, and it is the number that says whether the
        // deterministic system+tools prefix is being re-billed on every step.
        cachedTokens: sql<number>`coalesce(sum(${minkUsageLedger.cachedTokens}), 0)::float8`,
        knownCostMicrousd: sql<number>`coalesce(sum(${minkUsageLedger.estimatedCostMicrousd}), 0)::float8`,
        unknownOrPartialCostRuns: sql<number>`count(*) filter (where ${minkUsageLedger.runId} is null or ${minkUsageLedger.usageStatus} <> 'reported' or ${minkUsageLedger.estimatedCostMicrousd} is null)::int`,
        timedOutRuns: sql<number>`count(*) filter (where ${minkRuns.errorCode} = 'run_timeout')::int`,
        helpfulRuns: sql<number>`count(*) filter (where ${minkFeedback.rating} = 'helpful')::int`,
        unhelpfulRuns: sql<number>`count(*) filter (where ${minkFeedback.rating} = 'unhelpful')::int`,
        shadowCredits: sql<number>`coalesce(sum(${minkUsageLedger.shadowCredits}), 0)::float8`,
        // Band mix — the calibration signal the shadow period exists to produce.
        // ★ DERIVED FROM THE STORED TOKEN COUNTS, NOT FROM shadow_credits.
        // Every row written before the meter was banded holds a hardcoded 3,
        // so reading the column back would report the entire existing history
        // as "standard" — a wrong number presented as evidence, on the one
        // screen the boundaries will be tuned from. Re-deriving costs nothing
        // and is correct for every row whenever it was written, which is also
        // why no backfill migration is needed. ⚠ These need NOT sum to
        // totalRuns: a run with no usable usage is in none of them.
        lightRuns: bandRuns(0),
        standardRuns: bandRuns(1),
        heavyRuns: bandRuns(2),
        chargedCredits: sql<number>`coalesce(sum(${minkUsageLedger.chargedCredits}), 0)::float8`,
        invitedStores: sql<number>`(select count(*)::int from ${minkStoreAccess} where ${minkStoreAccess.enabled})`,
        draftingStores: sql<number>`(select count(*)::int from ${minkStoreAccess} where ${minkStoreAccess.enabled} and ${minkStoreAccess.draftingEnabled})`,
        proposedDrafts: sql<number>`(select count(*)::int from ${minkDrafts} where ${minkDrafts.createdAt} >= ${since} and ${minkDrafts.status} = 'proposed')`,
        savedDrafts: sql<number>`(select count(*)::int from ${minkDrafts} where ${minkDrafts.createdAt} >= ${since} and ${minkDrafts.status} = 'draft')`,
        actionEnabledStores: sql<number>`(select count(distinct ${minkActionToolAccess.storeId})::int from ${minkActionToolAccess} where ${minkActionToolAccess.enabled})`,
        executedActions: sql<number>`(select count(*)::int from ${minkActionAudit} where ${minkActionAudit.createdAt} >= ${since} and ${minkActionAudit.outcome} = 'executed')`,
        refusedActions: sql<number>`(select count(*)::int from ${minkActionAudit} where ${minkActionAudit.createdAt} >= ${since} and ${minkActionAudit.outcome} in ('conflicted', 'expired'))`,
      })
      .from(minkRuns)
      .innerJoin(stores, eq(stores.id, minkRuns.storeId))
      .leftJoin(minkUsageLedger, eq(minkUsageLedger.runId, minkRuns.id))
      .leftJoin(minkFeedback, eq(minkFeedback.runId, minkRuns.id))
      .where(where);
    const runRows = await db
      .select({
        id: minkRuns.id,
        requestId: minkRuns.requestId,
        storeId: minkRuns.storeId,
        storeName: stores.name,
        storeSlug: stores.slug,
        requestedBy: minkRuns.requestedBy,
        status: minkRuns.status,
        model: minkRuns.model,
        inputTokens: minkRuns.inputTokens,
        cachedTokens: minkUsageLedger.cachedTokens,
        outputTokens: minkRuns.outputTokens,
        thoughtTokens: minkRuns.thoughtTokens,
        totalTokens: minkRuns.totalTokens,
        stepCount: minkRuns.stepCount,
        toolCallCount: minkRuns.toolCallCount,
        retryCount: minkRuns.retryCount,
        latencyMs: minkRuns.latencyMs,
        errorCode: minkRuns.errorCode,
        startedAt: minkRuns.startedAt,
        completedAt: minkRuns.completedAt,
        usageStatus: minkUsageLedger.usageStatus,
        estimatedCostMicrousd: minkUsageLedger.estimatedCostMicrousd,
        pricingVersion: minkUsageLedger.pricingVersion,
        shadowCredits: minkUsageLedger.shadowCredits,
        costCohort: minkUsageLedger.costCohort,
        currentPath: minkRuns.currentPath,
        selectedResourceType: minkRuns.selectedResourceType,
        feedbackRating: minkFeedback.rating,
        feedbackIssueCategory: minkFeedback.issueCategory,
        feedbackDetailsRedacted: minkFeedback.detailsRedacted,
      })
      .from(minkRuns)
      .innerJoin(stores, eq(stores.id, minkRuns.storeId))
      .leftJoin(minkUsageLedger, eq(minkUsageLedger.runId, minkRuns.id))
      .leftJoin(minkFeedback, eq(minkFeedback.runId, minkRuns.id))
      .where(where)
      .orderBy(desc(minkRuns.startedAt))
      .limit(100);

    const ids = runRows.map((run) => run.id);
    const toolRows = ids.length
      ? await db
          .select({ runId: minkToolCalls.runId, name: minkToolCalls.toolName })
          .from(minkToolCalls)
          .where(inArray(minkToolCalls.runId, ids))
          .orderBy(minkToolCalls.runId, minkToolCalls.sequence)
      : [];
    const namesByRun = new Map<string, string[]>();
    for (const tool of toolRows) {
      const names = namesByRun.get(tool.runId) ?? [];
      if (!names.includes(tool.name)) names.push(tool.name);
      namesByRun.set(tool.runId, names);
    }
    const summary = summaryRows[0];
    const totalRuns = Number(summary?.totalRuns ?? 0);
    const succeededRuns = Number(summary?.succeededRuns ?? 0);
    return {
      summary: {
        totalRuns,
        succeededRuns,
        successRate:
          totalRuns > 0
            ? Math.round((succeededRuns / totalRuns) * 10_000) / 100
            : null,
        p95LatencyMs:
          summary?.p95LatencyMs == null
            ? null
            : Math.round(Number(summary.p95LatencyMs)),
        retryCount: Number(summary?.retryCount ?? 0),
        totalTokens: Number(summary?.totalTokens ?? 0),
        cachedTokens: Number(summary?.cachedTokens ?? 0),
        knownCostMicrousd: Number(summary?.knownCostMicrousd ?? 0),
        unknownOrPartialCostRuns: Number(
          summary?.unknownOrPartialCostRuns ?? 0,
        ),
        timedOutRuns: Number(summary?.timedOutRuns ?? 0),
        helpfulRuns: Number(summary?.helpfulRuns ?? 0),
        unhelpfulRuns: Number(summary?.unhelpfulRuns ?? 0),
        shadowCredits: Number(summary?.shadowCredits ?? 0),
        lightRuns: Number(summary?.lightRuns ?? 0),
        standardRuns: Number(summary?.standardRuns ?? 0),
        heavyRuns: Number(summary?.heavyRuns ?? 0),
        chargedCredits: Number(summary?.chargedCredits ?? 0),
        invitedStores: Number(summary?.invitedStores ?? 0),
        draftingStores: Number(summary?.draftingStores ?? 0),
        proposedDrafts: Number(summary?.proposedDrafts ?? 0),
        savedDrafts: Number(summary?.savedDrafts ?? 0),
        actionEnabledStores: Number(summary?.actionEnabledStores ?? 0),
        executedActions: Number(summary?.executedActions ?? 0),
        refusedActions: Number(summary?.refusedActions ?? 0),
      },
      runs: runRows.map((run) => ({
        ...run,
        inputTokens: Number(run.inputTokens),
        outputTokens: Number(run.outputTokens),
        thoughtTokens: Number(run.thoughtTokens),
        totalTokens: Number(run.totalTokens),
        stepCount: Number(run.stepCount),
        toolCallCount: Number(run.toolCallCount),
        retryCount: Number(run.retryCount),
        latencyMs: run.latencyMs == null ? null : Number(run.latencyMs),
        estimatedCostMicrousd:
          run.estimatedCostMicrousd == null
            ? null
            : Number(run.estimatedCostMicrousd),
        shadowCredits:
          run.shadowCredits == null ? null : Number(run.shadowCredits),
        toolNames: namesByRun.get(run.id) ?? [],
      })),
    };
  });
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
