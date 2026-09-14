import Link from "next/link";
import {
  getPlatformMinkRuns,
  MINK_RUN_STATUSES,
  normalizeMinkRunFilters,
} from "@/lib/platform/mink-runs";
import { getMinkVoiceProvider } from "@/lib/mink/voice-settings";
import { canManage, requireOperator } from "../require-operator";
import { VoiceProviderSwitch } from "./voice-provider-switch";

export const metadata = { title: "Mink AI runs — StoreMink Admin" };
export const dynamic = "force-dynamic";

export default async function PlatformMinkRunsPage({
  searchParams,
}: {
  searchParams: Promise<{
    days?: string | string[];
    status?: string | string[];
    q?: string | string[];
    actor?: string | string[];
  }>;
}) {
  // The layout and page render concurrently. Gate this cross-tenant service
  // read at the page boundary before querying any merchant's telemetry.
  const viewer = await requireOperator();
  const filters = normalizeMinkRunFilters(await searchParams);
  const [data, voiceProvider] = await Promise.all([
    getPlatformMinkRuns(filters),
    getMinkVoiceProvider(),
  ]);

  return (
    <div className="w-full max-w-[96rem] space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
          Mink AI runs
        </h1>
        <p className="mt-1 max-w-4xl text-sm text-slate-500">
          Redacted operational telemetry across stores. Prompts, answers, tool
          arguments, tool results, and model reasoning are never shown here.
        </p>
      </header>

      <VoiceProviderSwitch
        initialProvider={voiceProvider}
        canManage={canManage(viewer)}
      />

      <form className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-2 xl:grid-cols-[1fr_14rem_12rem_10rem_auto]">
        <label className="text-xs font-medium text-slate-600">
          Store, run, or request
          <input
            name="q"
            defaultValue={filters.q}
            maxLength={100}
            placeholder="Search telemetry"
            className="mt-1 block h-10 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-900 outline-none focus:border-slate-400"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Actor UID
          <input
            name="actor"
            defaultValue={filters.actor}
            maxLength={128}
            placeholder="Exact signed-in admin"
            className="mt-1 block h-10 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-900 outline-none focus:border-slate-400"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Status
          <select
            name="status"
            defaultValue={filters.status}
            className="mt-1 block h-10 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-900"
          >
            <option value="all">All statuses</option>
            {MINK_RUN_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-slate-600">
          Window
          <select
            name="days"
            defaultValue={String(filters.days)}
            className="mt-1 block h-10 w-full rounded-lg border border-slate-200 px-3 text-sm text-slate-900"
          >
            <option value="1">24 hours</option>
            <option value="7">7 days</option>
            <option value="30">30 days</option>
          </select>
        </label>
        <button className="mt-auto h-10 rounded-lg bg-slate-950 px-4 text-sm font-medium text-white">
          Apply
        </button>
      </form>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <Metric label="Runs" value={formatNumber(data.summary.totalRuns)} />
        <Metric
          label="Success rate"
          value={
            data.summary.successRate === null
              ? "—"
              : `${data.summary.successRate}%`
          }
        />
        <Metric
          label="Merchant feedback"
          value={`${formatNumber(data.summary.helpfulRuns)} / ${formatNumber(data.summary.unhelpfulRuns)}`}
          note="helpful / unhelpful"
        />
        <Metric
          label="Shadow credits"
          value={formatNumber(data.summary.shadowCredits)}
          note={`no customer debit · ${formatNumber(data.summary.lightRuns)} light / ${formatNumber(data.summary.standardRuns)} standard / ${formatNumber(data.summary.heavyRuns)} heavy`}
        />
        <Metric
          label="Invited stores"
          value={formatNumber(data.summary.invitedStores)}
        />
        <Metric
          label="Drafting stores"
          value={formatNumber(data.summary.draftingStores)}
        />
        <Metric
          label="Private drafts"
          value={`${formatNumber(data.summary.savedDrafts)} / ${formatNumber(data.summary.proposedDrafts)}`}
          note="saved / proposed in window"
        />
        <Metric
          label="Charged credits"
          value={formatNumber(data.summary.chargedCredits)}
          note="proposal tools"
        />
        <Metric
          label="Action-enabled stores"
          value={formatNumber(data.summary.actionEnabledStores)}
          note="at least one product-text tool"
        />
        <Metric
          label="Executed actions"
          value={formatNumber(data.summary.executedActions)}
          note="approved in window"
        />
        <Metric
          label="Refused actions"
          value={formatNumber(data.summary.refusedActions)}
          note="conflicted / expired"
        />
        <Metric
          label="P95 latency"
          value={formatDuration(data.summary.p95LatencyMs)}
        />
        <Metric label="Retries" value={formatNumber(data.summary.retryCount)} />
        <Metric label="Tokens" value={formatNumber(data.summary.totalTokens)} />
        <Metric
          label="Cache hit"
          value={
            data.summary.totalTokens > 0
              ? `${Math.round((data.summary.cachedTokens / data.summary.totalTokens) * 100)}%`
              : "—"
          }
          note={`${formatNumber(data.summary.cachedTokens)} prompt tokens served from cache`}
        />
        <Metric
          label="Known model cost"
          value={formatCost(data.summary.knownCostMicrousd)}
        />
        <Metric
          label="Unknown / partial cost"
          value={formatNumber(data.summary.unknownOrPartialCostRuns)}
          note={`${data.summary.timedOutRuns} timed out`}
        />
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-[1100px] w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Started</th>
                <th className="px-4 py-3">Store</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Tools</th>
                <th className="px-4 py-3">Steps / tools</th>
                <th className="px-4 py-3">Latency</th>
                <th className="px-4 py-3">Retries</th>
                <th className="px-4 py-3">Tokens</th>
                <th className="px-4 py-3">Cost</th>
                <th className="px-4 py-3">Context / cohort</th>
                <th className="px-4 py-3">Feedback</th>
                <th className="px-4 py-3">Run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.runs.map((run) => (
                <tr key={run.id} className="align-top text-slate-700">
                  <td className="whitespace-nowrap px-4 py-3">
                    {formatDate(run.startedAt)}
                  </td>
                  <td className="max-w-56 px-4 py-3 text-xs">
                    <div>
                      {run.costCohort ?? "—"} · {run.shadowCredits ?? 0} shadow
                    </div>
                    <div
                      className="truncate text-slate-400"
                      title={run.currentPath ?? undefined}
                    >
                      {run.currentPath ?? "No page context"}
                    </div>
                    {run.selectedResourceType ? (
                      <div className="text-slate-400">
                        selected {run.selectedResourceType}
                      </div>
                    ) : null}
                  </td>
                  <td className="max-w-64 px-4 py-3 text-xs">
                    <div className="font-medium text-slate-700">
                      {run.feedbackRating ?? "—"}
                    </div>
                    {run.feedbackIssueCategory ? (
                      <div className="text-amber-700">
                        {run.feedbackIssueCategory.replaceAll("_", " ")}
                      </div>
                    ) : null}
                    {run.feedbackDetailsRedacted ? (
                      <div
                        className="mt-1 line-clamp-2 text-slate-400"
                        title={run.feedbackDetailsRedacted}
                      >
                        {run.feedbackDetailsRedacted}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/dashboard/stores/${run.storeId}`}
                      className="font-medium text-slate-950 hover:underline"
                    >
                      {run.storeName}
                    </Link>
                    <div className="text-xs text-slate-400">
                      {run.storeSlug}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <span className={statusClass(run.status)}>
                      {run.status}
                    </span>
                    {run.errorCode ? (
                      <div className="mt-1 text-xs text-rose-600">
                        {run.errorCode}
                      </div>
                    ) : null}
                  </td>
                  <td className="max-w-64 px-4 py-3 text-xs">
                    {run.toolNames.length ? run.toolNames.join(", ") : "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {run.stepCount} / {run.toolCallCount}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    {formatDuration(run.latencyMs)}
                  </td>
                  <td className="px-4 py-3">{run.retryCount}</td>
                  <td className="px-4 py-3">
                    {formatNumber(run.totalTokens)}
                    {run.cachedTokens ? (
                      <div className="text-xs text-slate-500">
                        {formatNumber(run.cachedTokens)} cached
                      </div>
                    ) : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <div title={run.pricingVersion ?? undefined}>
                      {run.estimatedCostMicrousd === null
                        ? "Unknown"
                        : formatCost(run.estimatedCostMicrousd)}
                    </div>
                    {run.usageStatus && run.usageStatus !== "reported" ? (
                      <div className="text-xs text-amber-600">
                        {run.usageStatus}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">
                    {run.id.slice(0, 8)}
                    <div>req {run.requestId.slice(0, 8)}</div>
                    <div title={run.model}>{run.model}</div>
                    <div title={run.requestedBy}>
                      actor {run.requestedBy.slice(0, 8)}
                    </div>
                  </td>
                </tr>
              ))}
              {data.runs.length === 0 ? (
                <tr>
                  <td
                    colSpan={12}
                    className="px-4 py-12 text-center text-sm text-slate-500"
                  >
                    No Mink runs match these filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {data.runs.length === 100 ? (
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-400">
            Showing the 100 most recent matching runs. Narrow the filters for a
            smaller operational slice.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function Metric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-slate-950">{value}</div>
      {note ? <div className="mt-1 text-xs text-slate-400">{note}</div> : null}
    </div>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-IN").format(value);
}

function formatCost(microusd: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  }).format(microusd / 1_000_000);
}

function formatDuration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(new Date(value));
}

function statusClass(status: string): string {
  const color =
    status === "succeeded"
      ? "bg-emerald-50 text-emerald-700"
      : status === "failed"
        ? "bg-rose-50 text-rose-700"
        : status === "cancelled"
          ? "bg-amber-50 text-amber-700"
          : "bg-blue-50 text-blue-700";
  return `inline-flex rounded-full px-2 py-1 text-xs font-medium ${color}`;
}
