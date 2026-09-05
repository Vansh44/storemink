import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import { getMinkStorefrontCodePreview } from "@/lib/mink/storefront-code-proposals";
import { getLatestMinkStorefrontCodeAction } from "@/lib/mink/storefront-code-actions";
import { getLatestMinkStorefrontPublication } from "@/lib/mink/storefront-publication-actions";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ draftId: string }> },
) {
  const config = getMinkConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Mink AI is not enabled." },
      { status: 404 },
    );
  }
  const { draftId } = await params;
  if (!UUID_PATTERN.test(draftId)) {
    return NextResponse.json(
      { error: "Invalid Mink AI storefront preview." },
      { status: 400 },
    );
  }

  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-storefront-preview:${actor.storeId}:${actor.adminId}`,
      { max: 30, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink AI previews are receiving too many requests." },
        { status: 429 },
      );
    }
    const [preview, lastAction, lastPublication] = await Promise.all([
      getMinkStorefrontCodePreview(actor, draftId),
      getLatestMinkStorefrontCodeAction(actor, draftId),
      getLatestMinkStorefrontPublication(actor, draftId),
    ]);
    return NextResponse.json(
      { preview, lastAction, lastPublication },
      {
        headers: {
          "Cache-Control": "no-store, private",
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.storefront_preview: request rejected", {
        requestId,
        draftId,
        code: error.code,
        status: error.status,
      });
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    logError("mink.storefront_preview: request failed", error, {
      requestId,
      draftId,
    });
    return NextResponse.json(
      { error: "Mink AI couldn't open that private storefront preview." },
      { status: 503 },
    );
  }
}
