import { NextResponse } from "next/server";
import { logError } from "@/lib/observability/logger";
import { runThemeStudioWorker } from "@/lib/theme-studio/worker";
import { runThemeStudioVisualQaWorker } from "@/lib/theme-studio/visual-qa";

// The dedicated Theme Studio model worker.
//
// ★ A model run can take many minutes, so it must not execute on the shared
// per-minute Mink heartbeat (whose Scheduler deadline is 300s and whose
// merchant workflows would wait behind it) or in an `after()` callback (Cloud
// Run throttles CPU once the response is sent). It runs here, inside its own
// long-lived request, two run lanes and a separate visual-QA lane. Overlapping
// invocations are safe: claims use SKIP LOCKED and finishes are lease-fenced.
//
// ★ Rollout needs two things this file cannot provide (docs/cron-jobs.md):
// a Cloud Scheduler job calling this route every minute with an attempt
// deadline above the run wall time, and a Cloud Run request timeout at least as
// long. Until both exist, queued model runs wait; nothing is lost.
//
// ★ It accepts no run id or other input from the caller. The worker claims the
// next eligible row and derives everything else from service-owned storage.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 1200;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return (
    typeof secret === "string" &&
    secret.length > 0 &&
    request.headers.get("authorization") === `Bearer ${secret}`
  );
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    // Cloud Scheduler does not overlap executions of the same schedule. A
    // single long run used to leave the second theme queued behind it, and
    // the 5s claim budget meant visual QA ran only when the run queue emptied.
    // Await every lane even on failure: no paid work is detached from HTTP.
    const providers = ["vertex-gemini", "fake"] as const;
    const runLane = () =>
      runThemeStudioWorker({
        maxRuns: 1,
        budgetMs: 5_000,
        providers,
        skipVisualQa: true,
      });
    const lanes = await Promise.allSettled([
      runLane(),
      runLane(),
      runThemeStudioVisualQaWorker({ providers }),
    ]);
    const failure = lanes.find((lane) => lane.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const runs = [lanes[0], lanes[1]].flatMap((lane) =>
      lane.status === "fulfilled" ? [lane.value] : [],
    );
    // Preserve the endpoint's aggregate counters for operational consumers.
    const totals = {
      claimed: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      requeued: 0,
      reaped: 0,
    };
    for (const run of runs) {
      for (const key of Object.keys(totals) as (keyof typeof totals)[])
        totals[key] += run[key];
    }
    return NextResponse.json({
      ok: true,
      ...totals,
      runs,
      qa: lanes[2].status === "fulfilled" ? lanes[2].value : null,
    });
  } catch (error) {
    logError("theme studio worker route failed", error);
    return NextResponse.json(
      { ok: false, error: "Theme Studio worker failed." },
      { status: 503 },
    );
  }
}

export const GET = handle;
export const POST = handle;
