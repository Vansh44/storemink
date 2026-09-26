import type { ThemeStudioAcceptanceRunView } from "@/lib/theme-studio/acceptance";
import type { GateResult } from "@/lib/theme-studio/acceptance-gates";
import { studioDate } from "../../../../studio-ui";

// The evidence viewer: one acceptance run, every gate, and the exact inputs it
// judged. Server-safe and hook-free, so the page renders it directly. Types
// only from the acceptance modules — they are server code.

const RUN_TONE: Record<ThemeStudioAcceptanceRunView["status"], string> = {
  running: "bg-sky-50 text-sky-700",
  awaiting_browser: "bg-sky-50 text-sky-700",
  passed: "bg-emerald-50 text-emerald-700",
  failed: "bg-red-50 text-red-700",
  blocked: "bg-amber-50 text-amber-800",
  error: "bg-slate-100 text-slate-600",
  expired: "bg-slate-100 text-slate-500",
};

const RUN_LABEL: Record<ThemeStudioAcceptanceRunView["status"], string> = {
  running: "Running",
  awaiting_browser: "Waiting for browser checks",
  passed: "Passed",
  failed: "Failed",
  blocked: "Blocked",
  error: "Did not finish",
  expired: "Expired",
};

const GATE_TONE: Record<GateResult["status"], string> = {
  pass: "text-emerald-700",
  fail: "text-red-700",
  advisory: "text-amber-700",
  skipped: "text-slate-500",
};

const GATE_MARK: Record<GateResult["status"], string> = {
  pass: "Pass",
  fail: "Fail",
  advisory: "Advisory",
  skipped: "Not run",
};

export function AcceptanceRunBadge({
  status,
}: {
  status: ThemeStudioAcceptanceRunView["status"];
}) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${RUN_TONE[status]}`}
    >
      {RUN_LABEL[status]}
    </span>
  );
}

function short(digest: string | null): string {
  return digest ? `${digest.slice(0, 12)}…` : "—";
}

function metricText(metrics: GateResult["metrics"]): string | null {
  if (!metrics) return null;
  const parts = Object.entries(metrics)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}: ${value}`);
  return parts.length ? parts.join(" · ") : null;
}

export function AcceptanceEvidence({
  run,
}: {
  run: ThemeStudioAcceptanceRunView;
}) {
  const failed = run.gates.filter((g) => g.required && g.status !== "pass");
  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900">
            Acceptance run
          </h2>
          <AcceptanceRunBadge status={run.status} />
          {!run.currentBuild ? (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
              earlier build
            </span>
          ) : null}
        </div>
        <p className="text-xs text-slate-500">
          {run.createdByEmail} · {studioDate(run.createdAt)}
          {run.completedAt ? ` → ${studioDate(run.completedAt)}` : ""}
        </p>
      </div>

      {run.status === "failed" && failed.length ? (
        <p className="text-sm text-red-800">
          {failed.length} required gate{failed.length === 1 ? "" : "s"} did not
          pass. This version stays out of review until a revision fixes them.
        </p>
      ) : null}
      {run.status === "blocked" ? (
        <p className="text-sm text-amber-900">
          The security scan failed, so the project is blocked. Revise it, or
          make an earlier version current.
        </p>
      ) : null}
      {run.status === "passed" && !run.currentBuild ? (
        <p className="text-sm text-amber-900">
          This evidence was rendered by an earlier build of StoreMink. Run the
          checks again before this version is reviewed.
        </p>
      ) : null}

      <dl className="grid gap-x-6 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-slate-400">Package</dt>
          <dd className="font-mono" title={run.packageDigest}>
            {short(run.packageDigest)}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-400">Assets</dt>
          <dd className="font-mono" title={run.assetsDigest}>
            {short(run.assetsDigest)}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-400">Build</dt>
          <dd className="font-mono">{run.buildId}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-slate-400">Evidence</dt>
          <dd className="font-mono" title={run.evidenceDigest ?? undefined}>
            {short(run.evidenceDigest)}
          </dd>
        </div>
        {run.userAgent ? (
          <div className="flex gap-2 sm:col-span-2">
            <dt className="text-slate-400">Browser</dt>
            <dd className="truncate" title={run.userAgent}>
              {run.userAgent}
            </dd>
          </div>
        ) : null}
      </dl>

      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {run.gates.map((result) => {
          const metrics = metricText(result.metrics);
          return (
            <li key={result.id} className="px-4 py-3">
              <details open={result.status === "fail"}>
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-slate-900">
                    {result.label}
                    {!result.required ? (
                      <span className="ml-2 text-xs font-normal text-slate-400">
                        not required
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={`text-xs font-semibold ${GATE_TONE[result.status]}`}
                  >
                    {GATE_MARK[result.status]}
                    {result.findings.length && result.status !== "skipped"
                      ? ` · ${result.findings.length}`
                      : ""}
                  </span>
                </summary>
                {metrics ? (
                  <p className="mt-1 text-xs text-slate-500">{metrics}</p>
                ) : null}
                {result.findings.length ? (
                  <ul className="mt-2 space-y-1">
                    {result.findings.map((finding, index) => (
                      <li
                        key={`${finding.code}-${index}`}
                        className="text-xs text-slate-700"
                      >
                        {finding.where ? (
                          <span className="mr-1.5 font-mono text-slate-400">
                            {finding.where}
                          </span>
                        ) : null}
                        {finding.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
