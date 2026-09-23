import { NextResponse } from "next/server";
import { runMinkWorkflowWorker } from "@/lib/mink/workflows";
import { scheduleMinkWatches, reconcileMinkWatches } from "@/lib/mink/watches";
import { logError } from "@/lib/observability/logger";
import { purgeExpiredMinkMemories } from "@/lib/mink/memories";
import { reconcileMinkRunCredits } from "@/lib/mink/run-credit-reconcile";
import { getMinkConfig } from "@/lib/mink/config";
import { runThemeStudioWorker } from "@/lib/theme-studio/worker";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

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
    // Independent passes: a scheduler failure must not strand manual workflows.
    let passError: unknown = null;
    let watchesQueued = 0;
    try {
      watchesQueued = await scheduleMinkWatches();
    } catch (error) {
      passError = error;
    }
    let result: Awaited<ReturnType<typeof runMinkWorkflowWorker>> | null = null;
    try {
      result = await runMinkWorkflowWorker();
    } catch (error) {
      passError ??= error;
    }
    let watchAlerts = 0;
    try {
      watchAlerts = await reconcileMinkWatches();
    } catch (error) {
      passError ??= error;
    }
    try {
      await purgeExpiredMinkMemories();
    } catch (error) {
      passError ??= error;
    }
    // ★ It rides this heartbeat rather than taking a Cloud Scheduler entry of
    //   its own: docs/cron-jobs.md records three jobs that were documented and
    //   never created, and this one is already per-minute, already Mink-scoped
    //   and already authorised. ⚠ Its own errors are swallowed inside the
    //   reconciler, so a billing sweep can never fail the workflow worker.
    let creditsSettled = 0;
    try {
      ({ settled: creditsSettled } = await reconcileMinkRunCredits(
        getMinkConfig().chargeCredits,
      ));
    } catch (error) {
      passError ??= error;
    }
    // ★ Theme Studio rides this heartbeat for the same reason the credit
    //   reconciler does: it needs a per-minute authorised backstop, and a new
    //   Scheduler entry is the kind that gets documented and never created.
    //   It is a BACKSTOP — queueing kicks the worker in-process — and it is
    //   isolated: a Studio failure must never fail merchant Mink workflows,
    //   so its error is logged and deliberately not propagated.
    let themeStudio: Awaited<ReturnType<typeof runThemeStudioWorker>> | null =
      null;
    try {
      // Offline runs and lease reaping only. Model runs take minutes and have
      // their own worker route, so they never hold this heartbeat open.
      themeStudio = await runThemeStudioWorker({
        maxRuns: 5,
        budgetMs: 15_000,
        providers: ["fake"],
      });
    } catch (error) {
      logError("mink workflow cron: theme studio pass failed", error);
    }
    if (passError) throw passError;
    if (!result) throw new Error("Workflow heartbeat returned no result.");
    return NextResponse.json({
      ok: result.workflowsFailed === 0,
      ...result,
      watchesQueued,
      watchAlerts,
      creditsSettled,
      themeStudio,
    });
  } catch (error) {
    // 503, not an unhandled 500, so Cloud Scheduler's retries engage — the
    // same contract prune-logs and seo-refresh answer on a failed pass. A
    // workflow that failed its own retries is still a 200 with `ok: false`:
    // that is the queue working, not an outage.
    logError("mink workflow cron: heartbeat failed", error);
    return NextResponse.json(
      { ok: false, error: "Mink workflow heartbeat failed." },
      { status: 503 },
    );
  }
}

export const GET = handle;
export const POST = handle;
