import { NextResponse } from "next/server";
import { logError } from "@/lib/observability/logger";
import { claimThemeStudioCapture } from "@/lib/theme-studio/capture";
import { cronAuthorized } from "../auth";

// The capture job's first call (Track 3.6): claim the next catalog capture.
// The job (scripts/theme-studio-capture-job.mjs) runs on its own Cloud Run job
// with headless Chromium; this route runs in the web app, which owns the
// database, opens the version's private preview and mints a cookie good only
// while this capture runs. 204 means there is nothing to capture.
//
// ★ It takes no input: the next eligible capture is chosen here, never named
// by the caller.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const claimed = await claimThemeStudioCapture();
    if (!claimed) return new NextResponse(null, { status: 204 });
    return NextResponse.json(claimed, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    logError("theme studio capture claim failed", error);
    return NextResponse.json(
      { error: "The capture could not be claimed." },
      { status: 503 },
    );
  }
}
