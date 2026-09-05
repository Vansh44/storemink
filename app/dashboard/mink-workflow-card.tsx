"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MinkBusinessBrief } from "./mink-business-brief";
import type { BusinessBriefResult } from "@/lib/mink/business-brief-types";
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  BellRing,
  CheckCircle2,
  CircleAlert,
  Clock3,
  LoaderCircle,
  Play,
  RotateCcw,
} from "lucide-react";
import type { MinkArtifact } from "@/lib/mink/types";
import type {
  DelayedPickupReviewResult,
  MinkWorkflowResult,
  MinkWorkflowTemplate,
  MinkWorkflowView,
  ProductLaunchPreparationResult,
  RevenueDeclineInvestigationResult,
  SlowInventoryPromotionResult,
  WeeklyTradingReportResult,
} from "@/lib/mink/workflow-types";

type WorkflowArtifact = Extract<MinkArtifact, { type: "workflow" }>;

export function MinkWorkflowCard({ artifact }: { artifact: WorkflowArtifact }) {
  const [workflow, setWorkflow] = useState<MinkWorkflowView>(() =>
    initialWorkflow(artifact),
  );
  const [error, setError] = useState<string | null>(null);
  const [mutating, setMutating] = useState(false);
  const active = workflow.status === "queued" || workflow.status === "running";

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(`/api/mink/workflows/${artifact.runId}`, {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      const body = (await response.json().catch(() => ({}))) as {
        workflow?: MinkWorkflowView;
        error?: string;
      };
      if (!response.ok || !body.workflow) {
        throw new Error(body.error ?? "Mink couldn't refresh this workflow.");
      }
      setWorkflow(body.workflow);
      setError(null);
    },
    [artifact.runId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((nextError) => {
      if (controller.signal.aborted) return;
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Mink couldn't refresh this workflow.",
      );
    });
    if (!active) return () => controller.abort();
    const timer = window.setInterval(() => {
      void refresh(controller.signal).catch((nextError) => {
        if (!controller.signal.aborted) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Mink couldn't refresh this workflow.",
          );
        }
      });
    }, 3_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [active, refresh]);

  const mutate = useCallback(
    async (action: "cancel" | "resume") => {
      setMutating(true);
      setError(null);
      try {
        const response = await fetch(`/api/mink/workflows/${artifact.runId}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          workflow?: MinkWorkflowView;
          error?: string;
        };
        if (!response.ok || !body.workflow) {
          throw new Error(body.error ?? "Mink couldn't update this workflow.");
        }
        setWorkflow(body.workflow);
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Mink couldn't update this workflow.",
        );
      } finally {
        setMutating(false);
      }
    },
    [artifact.runId],
  );

  const progress = useMemo(
    () =>
      workflow.totalSteps > 0
        ? Math.min(
            100,
            Math.round((workflow.currentStep / workflow.totalSteps) * 100),
          )
        : 0,
    [workflow.currentStep, workflow.totalSteps],
  );

  return (
    <section className="overflow-hidden rounded-2xl border border-[#ded8f4] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      <div className="flex items-start justify-between gap-3 border-b border-[#ece9f2] bg-[#faf8ff] px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-[#352666]">
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            {artifact.title}
          </div>
          <p className="mt-0.5 text-[10px] leading-4 text-[#716c7a]">
            {artifact.description}
          </p>
        </div>
        <StatusBadge status={workflow.status} />
      </div>

      <div className="p-3">
        {active ? (
          <div aria-live="polite">
            <div className="flex items-center justify-between gap-3 text-[10px] text-[#66616e]">
              <span className="inline-flex items-center gap-1.5">
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                {workflow.cancelRequested
                  ? "Stopping safely after the current read"
                  : workflow.status === "queued"
                    ? "Queued for background processing"
                    : "Building your workflow result"}
              </span>
              <span className="tabular-nums">
                {workflow.currentStep}/{workflow.totalSteps} steps
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#eeeaf7]">
              <div
                className="h-full rounded-full bg-[#7652e8] transition-[width] duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        ) : null}

        {workflow.result ? (
          <WorkflowResult
            template={workflow.template}
            result={workflow.result}
          />
        ) : null}

        {workflow.status === "failed" ? (
          <p className="rounded-xl bg-[#fff7ed] px-3 py-2 text-[10px] leading-4 text-[#8a4a08]">
            {workflow.errorDetail ??
              "Mink could not finish this report after safe retries."}
          </p>
        ) : null}
        {workflow.status === "cancelled" ? (
          <p className="rounded-xl bg-[#f5f5f5] px-3 py-2 text-[10px] leading-4 text-[#66616e]">
            This workflow was cancelled. Cancelled workflows cannot resume or
            continue changing state.
          </p>
        ) : null}
        {error ? (
          <p className="mt-2 text-[10px] leading-4 text-[#b42318]" role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-2 flex items-center justify-end gap-2">
          {active && !workflow.cancelRequested ? (
            <button
              type="button"
              disabled={mutating}
              onClick={() => void mutate("cancel")}
              className="inline-flex items-center gap-1 rounded-lg border border-[#e3dfe9] px-2.5 py-1.5 text-[10px] font-medium text-[#5d5864] hover:bg-[#f7f6f8] disabled:opacity-50"
            >
              <Ban className="h-3 w-3" /> Stop
            </button>
          ) : null}
          {workflow.status === "waiting_approval" ? (
            <button
              type="button"
              disabled={mutating}
              onClick={() => void mutate("resume")}
              className="inline-flex items-center gap-1 rounded-lg bg-[#6f4ce6] px-2.5 py-1.5 text-[10px] font-semibold text-white disabled:opacity-50"
            >
              <RotateCcw className="h-3 w-3" /> Resume
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function WorkflowResult({
  template,
  result,
}: {
  template: MinkWorkflowTemplate;
  result: MinkWorkflowResult;
}) {
  if (template === "business_brief")
    return <MinkBusinessBrief result={result as BusinessBriefResult} />;
  if (template === "revenue_decline_investigation") {
    return (
      <RevenueInvestigation
        result={result as RevenueDeclineInvestigationResult}
      />
    );
  }
  if (template === "product_launch_preparation") {
    return (
      <ProductLaunchPackage result={result as ProductLaunchPreparationResult} />
    );
  }
  if (template === "slow_inventory_promotion") {
    return (
      <SlowInventoryPromotion result={result as SlowInventoryPromotionResult} />
    );
  }
  if (template === "delayed_pickup_review") {
    return <DelayedPickupReview result={result as DelayedPickupReviewResult} />;
  }
  return <WeeklyReport result={result as WeeklyTradingReportResult} />;
}

function WeeklyReport({ result }: { result: WeeklyTradingReportResult }) {
  const metrics = [
    [
      "Net sales",
      money(result.netSales, result.currency),
      result.netSalesTrendPercent,
    ],
    [
      "Orders",
      result.orders.toLocaleString("en-IN"),
      result.ordersTrendPercent,
    ],
    [
      "Average order value",
      money(result.averageOrderValue, result.currency),
      result.averageOrderValueTrendPercent,
    ],
    [
      "Units sold",
      result.unitsSold.toLocaleString("en-IN"),
      result.unitsSoldTrendPercent,
    ],
  ] as const;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-xl bg-[#f4fff9] px-3 py-2 text-[10px] text-[#176b49]">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          Completed for {result.rangeLabel} · {result.locationLabel} ·{" "}
          {result.timeZone}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {metrics.map(([label, value, trend]) => (
          <div
            key={label}
            className="rounded-xl border border-[#efedf2] bg-[#fafafa] px-2.5 py-2"
          >
            <div className="text-[9px] font-medium text-[#77727d]">{label}</div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums text-[#18181b]">
              {value}
            </div>
            <div className="text-[9px] text-[#77727d]">{trendLabel(trend)}</div>
          </div>
        ))}
      </div>
      {result.highlights.length ? (
        <div>
          <h4 className="text-[10px] font-semibold text-[#302c35]">
            Highlights
          </h4>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-[10px] leading-4 text-[#5f5a66]">
            {result.highlights.map((highlight) => (
              <li key={highlight}>{highlight}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.topProducts.length ? (
        <div>
          <h4 className="text-[10px] font-semibold text-[#302c35]">
            Top products by units
          </h4>
          <div className="mt-1 divide-y divide-[#efedf2] rounded-xl border border-[#efedf2]">
            {result.topProducts.map((product) => (
              <a
                key={product.id}
                href={safeDashboardPath(product.dashboardPath)}
                className="flex items-center justify-between gap-3 px-2.5 py-2 text-[10px] hover:bg-[#faf8ff]"
              >
                <span className="truncate font-medium text-[#302c35]">
                  {product.name}
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 tabular-nums text-[#6f4ce6]">
                  {product.units.toLocaleString("en-IN")} units{" "}
                  <ArrowUpRight className="h-3 w-3" />
                </span>
              </a>
            ))}
          </div>
        </div>
      ) : null}
      <a
        href={safeDashboardPath(result.analyticsPath)}
        className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#6841d9] hover:underline"
      >
        Open Analytics <ArrowUpRight className="h-3 w-3" />
      </a>
      <p className="text-[9px] text-[#8a858e]">
        Data as of {formatDate(result.dataAsOf)}. Top-product sales are
        merchandise line totals; headline net sales include completed refunds.
      </p>
    </div>
  );
}

function RevenueInvestigation({
  result,
}: {
  result: RevenueDeclineInvestigationResult;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-[#f4fff9] px-3 py-2 text-[10px] text-[#176b49]">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Investigation complete for {result.rangeLabel} ·{" "}
            {result.locationLabel} · {result.timeZone}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {result.metrics.slice(0, 4).map((metric) => (
          <div
            key={metric.key}
            className="rounded-xl border border-[#efedf2] bg-[#fafafa] px-2.5 py-2"
          >
            <div className="text-[9px] font-medium text-[#77727d]">
              {metric.label}
            </div>
            <div className="mt-0.5 text-sm font-semibold tabular-nums text-[#18181b]">
              {metric.format === "currency"
                ? money(metric.current, result.currency)
                : metric.current.toLocaleString("en-IN")}
            </div>
            <div
              className={`text-[9px] ${metric.delta < 0 ? "text-[#b42318]" : "text-[#08784f]"}`}
            >
              {comparisonDelta(
                metric.delta,
                metric.deltaPercent,
                metric.format,
                result.currency,
              )}
            </div>
          </div>
        ))}
      </div>
      <ResultList title="Evidence summary" items={result.findings} />
      <MovementList
        title="Channel movement"
        rows={result.channelMovements}
        currency={result.currency}
      />
      <MovementList
        title="Location movement"
        rows={result.locationMovements}
        currency={result.currency}
      />
      <MovementList
        title="Product movement"
        rows={result.productMovements}
        currency={result.currency}
      />
      <div className="rounded-xl border border-[#f2e5bd] bg-[#fffaf0] px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[#805b16]">
          <AlertTriangle className="h-3.5 w-3.5" /> Interpretation limits
        </div>
        <ul className="mt-1 list-disc space-y-1 pl-4 text-[9px] leading-4 text-[#78663f]">
          {result.caveats.slice(0, 4).map((caveat) => (
            <li key={caveat}>{caveat}</li>
          ))}
        </ul>
      </div>
      <a
        href={safeDashboardPath(result.analyticsPath)}
        className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#6841d9] hover:underline"
      >
        Verify in Analytics <ArrowUpRight className="h-3 w-3" />
      </a>
      <p className="text-[9px] text-[#8a858e]">
        Data as of {formatDate(result.dataAsOf)}. Compared with{" "}
        {result.comparisonLabel}.
      </p>
    </div>
  );
}

function MovementList({
  title,
  rows,
  currency,
}: {
  title: string;
  rows: RevenueDeclineInvestigationResult["channelMovements"];
  currency: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h4 className="text-[10px] font-semibold text-[#302c35]">{title}</h4>
      <div className="mt-1 divide-y divide-[#efedf2] overflow-hidden rounded-xl border border-[#efedf2]">
        {rows.slice(0, 6).map((row) => {
          const content = (
            <>
              <span className="min-w-0 truncate font-medium text-[#302c35]">
                {row.name}
              </span>
              <span
                className={`shrink-0 tabular-nums ${row.delta < 0 ? "text-[#b42318]" : "text-[#08784f]"}`}
              >
                {signedMoney(row.delta, currency)}
                {row.dashboardPath ? (
                  <ArrowUpRight className="ml-1 inline h-3 w-3" />
                ) : null}
              </span>
            </>
          );
          return row.dashboardPath ? (
            <a
              key={row.key}
              href={safeDashboardPath(row.dashboardPath)}
              className="flex items-center justify-between gap-3 px-2.5 py-2 text-[10px] hover:bg-[#faf8ff]"
            >
              {content}
            </a>
          ) : (
            <div
              key={row.key}
              className="flex items-center justify-between gap-3 px-2.5 py-2 text-[10px]"
            >
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProductLaunchPackage({
  result,
}: {
  result: ProductLaunchPreparationResult;
}) {
  const tone =
    result.readinessLabel === "ready"
      ? "bg-[#f4fff9] text-[#176b49]"
      : result.readinessLabel === "blocked"
        ? "bg-[#fff3f1] text-[#a52a20]"
        : "bg-[#fffaf0] text-[#805b16]";
  return (
    <div className="space-y-3">
      <div className={`rounded-xl px-3 py-2 ${tone}`}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-semibold">
            Launch readiness · {result.readinessLabel.replaceAll("_", " ")}
          </span>
          <span className="text-sm font-semibold tabular-nums">
            {result.readinessScore}%
          </span>
        </div>
        <p className="mt-0.5 text-[9px]">
          {result.productName}
          {result.requestedVariantName
            ? ` · ${result.requestedVariantName}`
            : ""}{" "}
          · {result.requestedSku}
        </p>
      </div>
      <div className="divide-y divide-[#efedf2] overflow-hidden rounded-xl border border-[#efedf2]">
        {result.checks.slice(0, 10).map((item) => (
          <div key={item.key} className="flex items-start gap-2 px-2.5 py-2">
            {item.status === "ready" ? (
              <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#08784f]" />
            ) : item.status === "blocker" ? (
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#b42318]" />
            ) : (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#9a6700]" />
            )}
            <div className="min-w-0">
              <div className="text-[10px] font-semibold text-[#302c35]">
                {item.label}
              </div>
              <div className="text-[9px] leading-4 text-[#716c7a]">
                {item.detail}
              </div>
            </div>
          </div>
        ))}
      </div>
      {result.skus.length ? (
        <div>
          <h4 className="text-[10px] font-semibold text-[#302c35]">
            Inspected sellable SKUs
          </h4>
          <div className="mt-1 divide-y divide-[#efedf2] overflow-hidden rounded-xl border border-[#efedf2]">
            {result.skus.slice(0, 20).map((sku) => (
              <a
                key={sku.variantId ?? sku.productId}
                href={safeDashboardPath(sku.dashboardPath)}
                className="flex items-center justify-between gap-3 px-2.5 py-2 text-[10px] hover:bg-[#faf8ff]"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-[#302c35]">
                    {sku.variantName ?? sku.productName}
                  </span>
                  <span className="block truncate text-[9px] text-[#817c86]">
                    {sku.sku} ·{" "}
                    {money(
                      sku.specialPrice ?? sku.sellingPrice,
                      result.currency,
                    )}
                  </span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1 tabular-nums text-[#6841d9]">
                  {sku.trackInventory
                    ? `${sku.totalStock} stock`
                    : "Not tracked"}
                  <ArrowUpRight className="h-3 w-3" />
                </span>
              </a>
            ))}
          </div>
        </div>
      ) : null}
      {result.locationStock.length ? (
        <div>
          <h4 className="text-[10px] font-semibold text-[#302c35]">
            Captured stock by location
          </h4>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {result.locationStock.slice(0, 50).map((location) => (
              <a
                key={location.id}
                href={safeDashboardPath(location.dashboardPath)}
                className="rounded-lg border border-[#e8e3f5] bg-[#faf8ff] px-2 py-1 text-[9px] text-[#51466b] hover:border-[#cfc2f5]"
              >
                {location.name}: {location.stock.toLocaleString("en-IN")}
              </a>
            ))}
          </div>
        </div>
      ) : null}
      <ResultList title="Launch checklist" items={result.checklist} ordered />
      <div className="rounded-xl border border-[#e8e3f5] bg-[#faf8ff] px-3 py-2">
        <div className="text-[10px] font-semibold text-[#40365c]">
          Grounded starter copy
        </div>
        <div className="mt-1 text-[10px] font-semibold text-[#27232e]">
          {result.suggestedCopy.headline}
        </div>
        <p className="text-[9px] leading-4 text-[#686170]">
          {result.suggestedCopy.subheading}
        </p>
        <div className="mt-1 text-[9px] font-medium text-[#6841d9]">
          CTA: {result.suggestedCopy.callToAction}
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <a
          href={safeDashboardPath(result.productDashboardPath)}
          className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#6841d9] hover:underline"
        >
          Open product <ArrowUpRight className="h-3 w-3" />
        </a>
        <a
          href={safeDashboardPath(result.inventoryDashboardPath)}
          className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#6841d9] hover:underline"
        >
          Open inventory <ArrowUpRight className="h-3 w-3" />
        </a>
      </div>
      <p className="text-[9px] text-[#8a858e]">
        Private preparation only · {result.locationLabel} · data as of{" "}
        {formatDate(result.dataAsOf)}. Nothing was published, repriced,
        generated or sent.
      </p>
    </div>
  );
}

function SlowInventoryPromotion({
  result,
}: {
  result: SlowInventoryPromotionResult;
}) {
  const proposal = result.promotionProposal;
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-[#f4fff9] px-3 py-2 text-[10px] text-[#176b49]">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Slow-stock analysis complete for {result.rangeLabel} ·{" "}
            {result.locationLabel} · {result.timeZone}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <MetricTile
          label="Candidate shelves"
          value={result.totalCandidateShelves}
        />
        <MetricTile label="Locations" value={result.locationCount} />
        <MetricTile label="Lookback" value={`${result.periodDays} days`} />
      </div>

      {result.candidates.length ? (
        <div>
          <h4 className="text-[10px] font-semibold text-[#302c35]">
            Slow inventory by shelf
          </h4>
          <div className="mt-1 divide-y divide-[#efedf2] overflow-hidden rounded-xl border border-[#efedf2]">
            {result.candidates.slice(0, 20).map((candidate) => (
              <div
                key={`${candidate.locationId}:${candidate.variantId ?? candidate.productId}`}
                className="px-2.5 py-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <a
                    href={safeDashboardPath(candidate.productDashboardPath)}
                    className="min-w-0 text-[10px] font-semibold text-[#3f3370] hover:underline"
                  >
                    <span className="block truncate">
                      {candidate.productName}
                      {candidate.variantName
                        ? ` · ${candidate.variantName}`
                        : ""}
                    </span>
                    <span className="block truncate text-[9px] font-normal text-[#817c86]">
                      {candidate.sku}
                    </span>
                  </a>
                  <a
                    href={safeDashboardPath(candidate.inventoryDashboardPath)}
                    className="shrink-0 text-right text-[9px] text-[#6841d9] hover:underline"
                  >
                    {candidate.locationName}{" "}
                    <ArrowUpRight className="inline h-3 w-3" />
                  </a>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-[#625c68]">
                  <span>{candidate.stock.toLocaleString("en-IN")} on hand</span>
                  <span>
                    {candidate.unitsSold.toLocaleString("en-IN")} sold
                  </span>
                  <span>
                    {money(candidate.salesAmount, result.currency)} sales
                  </span>
                  <span>
                    {candidate.daysOfCover == null
                      ? "No recognized location sales"
                      : `${candidate.daysOfCover.toLocaleString("en-IN")} days of cover`}
                  </span>
                  <span>
                    {candidate.sellThroughPercent.toLocaleString("en-IN")}%
                    sell-through
                  </span>
                </div>
              </div>
            ))}
          </div>
          {result.truncated ? (
            <p className="mt-1 text-[9px] text-[#8a5c10]">
              Showing the 20 highest-priority shelves out of{" "}
              {result.totalCandidateShelves.toLocaleString("en-IN")} matches.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="rounded-xl border border-[#e6e3e9] bg-[#fafafa] px-3 py-2 text-[10px] text-[#625c68]">
          No eligible slow-moving positive-stock shelf was found in this scope.
        </p>
      )}

      <div className="rounded-xl border border-[#ded8f4] bg-[#faf8ff] px-3 py-2">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10px] font-semibold text-[#40365c]">
            Private promotion recommendation
          </div>
          <span className="rounded-full bg-white px-2 py-1 text-[9px] font-semibold text-[#6f4ce6]">
            {proposal.status === "no_candidates"
              ? "No candidates"
              : "Review required"}
          </span>
        </div>
        <p className="mt-1 text-[10px] font-semibold text-[#27232e]">
          {proposal.name}
        </p>
        <p className="text-[9px] leading-4 text-[#686170]">
          {proposal.objective}
        </p>
        {proposal.targetSkus.length ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {proposal.targetSkus.map((sku) => (
              <span
                key={sku}
                className="rounded-full border border-[#ddd5f6] bg-white px-2 py-1 font-mono text-[9px] text-[#51466b]"
              >
                {sku}
              </span>
            ))}
          </div>
        ) : null}
        {proposal.targetSkus.length ? (
          <div className="mt-2 grid grid-cols-2 gap-1.5 text-[9px]">
            <div className="rounded-lg bg-white px-2 py-1.5 text-[#625c68]">
              Suggested test: {proposal.durationDays} days
            </div>
            <div className="rounded-lg bg-white px-2 py-1.5 text-[#625c68]">
              Discount:{" "}
              {proposal.suggestedDiscountPercent ?? "Review margin first"}
              {proposal.suggestedDiscountPercent == null ? "" : "%"}
            </div>
          </div>
        ) : null}
        <p className="mt-2 text-[9px] leading-4 text-[#6d6282]">
          {proposal.note}
        </p>
      </div>

      <div className="rounded-xl border border-[#f2e5bd] bg-[#fffaf0] px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[#805b16]">
          <AlertTriangle className="h-3.5 w-3.5" /> Approval boundary
        </div>
        <ul className="mt-1 list-disc space-y-1 pl-4 text-[9px] leading-4 text-[#78663f]">
          {result.approvalBoundary.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      <ResultList title="How to interpret this" items={result.caveats} />
      <div className="flex flex-wrap gap-3">
        <a
          href={safeDashboardPath(result.inventoryDashboardPath)}
          className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#6841d9] hover:underline"
        >
          Verify inventory <ArrowUpRight className="h-3 w-3" />
        </a>
        <a
          href={safeDashboardPath(result.offersDashboardPath)}
          className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#6841d9] hover:underline"
        >
          Open Offers manually <ArrowUpRight className="h-3 w-3" />
        </a>
      </div>
      <p className="text-[9px] text-[#8a858e]">
        Private recommendation only · data as of {formatDate(result.dataAsOf)}.
        No offer, price, inventory, campaign or customer record was changed.
      </p>
    </div>
  );
}

function DelayedPickupReview({
  result,
}: {
  result: DelayedPickupReviewResult;
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-[#f4fff9] px-3 py-2 text-[10px] text-[#176b49]">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Pickup review complete · {result.locationLabel} · {result.timeZone}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <MetricTile
          label="Action required"
          value={result.totalActionableOrders}
        />
        <MetricTile
          label="Preparation overdue"
          value={result.preparationOverdueCount}
        />
        <MetricTile
          label="Unprepared, at risk"
          value={result.preparationAtRiskCount}
        />
        <MetricTile
          label="Ready, collection due"
          value={result.collectionDueCount}
        />
      </div>

      {result.pickups.length ? (
        <div>
          <h4 className="text-[10px] font-semibold text-[#302c35]">
            Action queue
          </h4>
          <div className="mt-1 divide-y divide-[#efedf2] overflow-hidden rounded-xl border border-[#efedf2]">
            {result.pickups.slice(0, 25).map((pickup) => (
              <a
                key={`${pickup.orderRef}:${pickup.locationName}`}
                href={safeDashboardPath(pickup.orderDashboardPath)}
                className="block px-2.5 py-2 hover:bg-[#faf8ff]"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 truncate text-[10px] font-semibold text-[#3f3370]">
                    {pickup.orderRef}
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-[9px] text-[#6841d9]">
                    {pickup.locationName} <ArrowUpRight className="h-3 w-3" />
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-[#625c68]">
                  <span className="inline-flex items-center gap-1">
                    <Clock3 className="h-3 w-3" />{" "}
                    {pickupIssueLabel(pickup.issue)}
                  </span>
                  <span>{pickup.hoursUntilExpiry}h until expiry</span>
                  {pickup.hoursPastPromise != null ? (
                    <span>{pickup.hoursPastPromise}h past ready promise</span>
                  ) : null}
                  <span className="inline-flex items-center gap-1">
                    <BellRing className="h-3 w-3" />
                    {pickupReminderLabel(pickup.reminderState)}
                  </span>
                </div>
              </a>
            ))}
          </div>
          {result.truncated ? (
            <p className="mt-1 text-[9px] text-[#8a5c10]">
              Showing 25 highest-priority orders out of{" "}
              {result.totalActionableOrders.toLocaleString("en-IN")} matches.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="rounded-xl border border-[#e6e3e9] bg-[#fafafa] px-3 py-2 text-[10px] text-[#625c68]">
          No live pickup is overdue for preparation or inside the 48-hour
          collection-risk window in this scope.
        </p>
      )}

      {result.communications.length ? (
        <div>
          <h4 className="text-[10px] font-semibold text-[#302c35]">
            Communication guidance
          </h4>
          <div className="mt-1 space-y-1.5">
            {result.communications.map((communication) => (
              <div
                key={`${communication.kind}:${communication.status}`}
                className="rounded-xl border border-[#e8e3f5] bg-[#faf8ff] px-3 py-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[10px] font-semibold text-[#40365c]">
                    {communication.title}
                  </span>
                  <span className="rounded-full bg-white px-2 py-1 text-[8px] font-semibold text-[#6f4ce6]">
                    {communicationStatusLabel(communication.status)}
                  </span>
                </div>
                <p className="mt-1 text-[9px] leading-4 text-[#6d6282]">
                  Orders: {communication.orderReferences.join(", ")}
                </p>
                {communication.subject && communication.body ? (
                  <div className="mt-2 rounded-lg bg-white px-2.5 py-2 text-[9px] leading-4 text-[#4f4957]">
                    <div className="font-semibold">{communication.subject}</div>
                    <p className="mt-1 whitespace-pre-wrap">
                      {communication.body}
                    </p>
                  </div>
                ) : null}
                <p className="mt-1 text-[9px] leading-4 text-[#6d6282]">
                  {communication.note}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="rounded-xl border border-[#f2e5bd] bg-[#fffaf0] px-3 py-2">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[#805b16]">
          <AlertTriangle className="h-3.5 w-3.5" /> Safety boundary
        </div>
        <ul className="mt-1 list-disc space-y-1 pl-4 text-[9px] leading-4 text-[#78663f]">
          {result.safetyNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>

      <a
        href={safeDashboardPath(result.ordersDashboardPath)}
        className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#6841d9] hover:underline"
      >
        Verify live orders <ArrowUpRight className="h-3 w-3" />
      </a>
      <p className="text-[9px] text-[#8a858e]">
        Private preparation only · data as of {formatDate(result.dataAsOf)}. No
        message, reminder, order, deadline or stock record was changed.
      </p>
    </div>
  );
}

function pickupIssueLabel(
  issue: DelayedPickupReviewResult["pickups"][number]["issue"],
): string {
  if (issue === "preparation_overdue") return "Preparation overdue";
  if (issue === "preparation_at_risk") return "Unprepared, expires soon";
  return "Ready, collection due";
}

function pickupReminderLabel(
  state: DelayedPickupReviewResult["pickups"][number]["reminderState"],
): string {
  if (state === "already_recorded") return "Reminder already recorded";
  if (state === "automatic_pending") return "Automatic reminder pending";
  return "Reminder not due";
}

function communicationStatusLabel(
  status: DelayedPickupReviewResult["communications"][number]["status"],
): string {
  if (status === "prepared_for_review") return "Review copy";
  if (status === "automatic_reminder_pending") return "Automatic reminder";
  return "Duplicate withheld";
}

function MetricTile({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-xl border border-[#efedf2] bg-[#fafafa] px-2.5 py-2">
      <div className="text-[9px] font-medium text-[#77727d]">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums text-[#18181b]">
        {typeof value === "number" ? value.toLocaleString("en-IN") : value}
      </div>
    </div>
  );
}

function ResultList({
  title,
  items,
  ordered = false,
}: {
  title: string;
  items: string[];
  ordered?: boolean;
}) {
  if (items.length === 0) return null;
  const List = ordered ? "ol" : "ul";
  return (
    <div>
      <h4 className="text-[10px] font-semibold text-[#302c35]">{title}</h4>
      <List
        className={`mt-1 space-y-1 pl-4 text-[10px] leading-4 text-[#5f5a66] ${ordered ? "list-decimal" : "list-disc"}`}
      >
        {items.slice(0, 10).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </List>
    </div>
  );
}

function StatusBadge({ status }: { status: MinkWorkflowView["status"] }) {
  const label = status.replaceAll("_", " ");
  const tone =
    status === "completed"
      ? "bg-[#eafaf2] text-[#08784f]"
      : status === "failed"
        ? "bg-[#fff0ed] text-[#b42318]"
        : status === "cancelled"
          ? "bg-[#f0f0f0] text-[#68636d]"
          : "bg-[#eee8ff] text-[#613bc7]";
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-1 text-[9px] font-semibold capitalize ${tone}`}
    >
      {label}
    </span>
  );
}

function initialWorkflow(artifact: WorkflowArtifact): MinkWorkflowView {
  const now = new Date().toISOString();
  return {
    id: artifact.runId,
    template: artifact.template,
    status: artifact.status,
    currentStep: artifact.currentStep,
    totalSteps: artifact.totalSteps,
    attemptCount: 0,
    errorCode: null,
    errorDetail: null,
    cancelRequested: false,
    result: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }
}

function trendLabel(value: number | null): string {
  if (value == null) return "No comparison baseline";
  return `${value > 0 ? "+" : ""}${value.toLocaleString("en-IN", { maximumFractionDigits: 1 })}% vs previous`;
}

function comparisonDelta(
  delta: number,
  deltaPercent: number | null,
  format: "currency" | "number",
  currency: string,
): string {
  const value =
    format === "currency"
      ? signedMoney(delta, currency)
      : `${delta > 0 ? "+" : ""}${delta.toLocaleString("en-IN")}`;
  return deltaPercent == null
    ? `${value} · no percentage baseline`
    : `${value} · ${deltaPercent > 0 ? "+" : ""}${deltaPercent.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;
}

function signedMoney(value: number, currency: string): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${money(Math.abs(value), currency)}`;
}

function safeDashboardPath(value: string): string {
  return /^\/dashboard(?:[/?#]|$)/.test(value) ? value : "/dashboard";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "the latest completed step"
    : new Intl.DateTimeFormat("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}
