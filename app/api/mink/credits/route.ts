import { NextResponse } from "next/server";
import { getAiUsage } from "@/lib/ai/quota";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import { logError } from "@/lib/observability/logger";

export const runtime = "nodejs";

export async function GET() {
  const requestId = crypto.randomUUID();
  try {
    const config = getMinkConfig();
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const usage = await getAiUsage(actor.storeId);
    return NextResponse.json(usage, {
      headers: { "Cache-Control": "no-store, private" },
    });
  } catch (error) {
    if (error instanceof MinkRequestError) {
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
