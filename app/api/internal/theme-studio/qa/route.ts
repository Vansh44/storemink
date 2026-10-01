import { NextResponse } from "next/server";
import { cronAuthorized } from "../captures/auth";
import { runThemeStudioVisualQaWorker } from "@/lib/theme-studio/visual-qa";
import { logError } from "@/lib/observability/logger";

// Independent schedule: a long image/model request must not hold completed
// captures in the QA queue. Existing worker QA remains a safe fallback.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  if (!cronAuthorized(request))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const lanes = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      runThemeStudioVisualQaWorker({ providers: ["vertex-gemini", "fake"] }),
    ),
  );
  const failed = lanes.find((lane) => lane.status === "rejected");
  if (failed?.status === "rejected") {
    logError("theme studio: QA worker failed", failed.reason);
    return NextResponse.json({ ok: false }, { status: 503 });
  }
  return NextResponse.json({
    ok: true,
    lanes: lanes.flatMap((lane) =>
      lane.status === "fulfilled" ? [lane.value] : [],
    ),
  });
}
