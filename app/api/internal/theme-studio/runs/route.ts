import { NextResponse } from "next/server";
import { logError } from "@/lib/observability/logger";
import { runThemeStudioWorker } from "@/lib/theme-studio/worker";

// The dedicated Theme Studio model worker.
//
// ★ A model run can take many minutes, so it must not execute on the shared
// per-minute Mink heartbeat (whose Scheduler deadline is 300s and whose
// merchant workflows would wait behind it) or in an `after()` callback (Cloud
// Run throttles CPU once the response is sent). It runs here, inside its own
// long-lived request, one run per invocation. Overlapping invocations are safe:
// claims use SKIP LOCKED and finishes are fenced on the lease owner.
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
    const result = await runThemeStudioWorker({
      maxRuns: 1,
      budgetMs: 5_000,
      providers: ["vertex-gemini", "fake"],
    });
    return NextResponse.json({ ok: true, ...result });
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
