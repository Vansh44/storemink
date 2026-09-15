import { NextResponse } from "next/server";
import { getAiUsage } from "@/lib/ai/quota";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET() {
  // MINK_AI_ENABLED is the global emergency switch, and it has to be read HERE:
  // getMinkActorContext enforces the per-store invite and dashboard:view but
  // knows nothing about the global flag, so without this the one control that
  // is supposed to stop every Mink request would keep serving this one.
  const config = getMinkConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Mink AI is not enabled." },
      { status: 404 },
    );
  }

  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    // The composer refreshes this after every run and on every dashboard mount,
    // and resolving the actor alone costs a permissions read, a store/locations
    // read and the brand-voice read — so it is bounded like every other Mink
    // read route rather than left to however often a client chooses to poll.
    const limited = await rateLimit(
      `mink-credits:${actor.storeId}:${actor.adminId}`,
      { max: 60, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink credits are receiving too many requests." },
        { status: 429 },
      );
    }
    const usage = await getAiUsage(actor.storeId);
    // getAiUsage swallows its own read failure and reports cap: null, which is
    // indistinguishable from an unmetered plan. Serving that would have the
    // composer tell a store with nothing left that it has unlimited credits, so
    // an unreadable balance is reported as unavailable instead.
    if (!usage.available) {
      logWarn("mink.credits: usage unavailable", { requestId });
      return NextResponse.json(
        { error: "Mink credits are unavailable right now." },
        { status: 503 },
      );
    }
    return NextResponse.json(usage, {
      headers: { "Cache-Control": "no-store, private" },
    });
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.credits: request rejected", {
        requestId,
        code: error.code,
        status: error.status,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    logError("mink.credits: read failed", error, { requestId });
    return NextResponse.json(
      { error: "Mink credits are unavailable right now." },
      { status: 503 },
    );
  }
}
