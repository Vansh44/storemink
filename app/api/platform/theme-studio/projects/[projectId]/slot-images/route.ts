import { NextResponse } from "next/server";
import { readMinkBoundedBytes } from "@/lib/mink/bounded-json";
import { MinkRequestError } from "@/lib/mink/errors";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { logError } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import { THEME_STUDIO_LIMITS } from "@/lib/theme-studio/contracts";
import { SLOT_IMAGE_ROUTE_PREFIX } from "@/lib/theme-studio/preview";
import { isUuid, ThemeStudioError } from "@/lib/theme-studio/repository";
import {
  SLOT_IMAGE_REJECTION_MESSAGES,
  prepareSlotImage,
  slotUploadTarget,
  storeThemeStudioSlotImage,
} from "@/lib/theme-studio/slot-images";

// Upload ONE image for one slot of a Theme Studio version:
// POST ?versionId=<uuid>&slot=<slot id>, body = the raw image bytes.
//
// ★ A route handler for the reference route's reason: a server action's body
// is capped at 6 MB and a phone photo is often larger. Nothing about the
// upload is trusted — no filename, no Content-Type; the bytes are decoded,
// cropped to the slot's shape and re-encoded (lib/theme-studio/slot-images.ts).
//
// ★ Uploading changes no version. It stores an `image` asset and returns its
// id; the operator stages several and saves them as one new version through
// replaceThemeStudioSlotImagesAction.
//
// ★ /api is outside proxy.ts, so this route is its own gate: superadmin
// session, same-origin browser POST, a rate limit, and a streamed byte cap.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const SLOT_ID_RE = /^[a-z][a-z0-9-]{0,79}$/; // contracts.ts ASSET_ID_RE

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const foreign = rejectForeignMinkOrigin(request);
  if (foreign) return foreign;
  const actor = await getThemeStudioActor();
  if (!actor) {
    return json(
      { error: "Only a platform superadmin can use Theme Studio." },
      403,
    );
  }
  const { projectId } = await params;
  const url = new URL(request.url);
  const versionId = url.searchParams.get("versionId") ?? "";
  const slotId = url.searchParams.get("slot") ?? "";
  if (!isUuid(projectId) || !isUuid(versionId) || !SLOT_ID_RE.test(slotId)) {
    return json({ error: "Unknown slot." }, 404);
  }

  const { allowed } = await rateLimit(`theme-studio-upload:${actor.id}`, {
    max: 30,
    windowSeconds: 60,
  });
  if (!allowed) {
    return json({ error: "Too many uploads. Try again in a minute." }, 429);
  }

  const declared = Number(request.headers.get("content-length"));
  if (
    Number.isFinite(declared) &&
    declared > THEME_STUDIO_LIMITS.slotImageBytes
  ) {
    return json({ error: SLOT_IMAGE_REJECTION_MESSAGES.too_large }, 413);
  }

  const target = await slotUploadTarget(projectId, versionId, slotId);
  if (!target) return json({ error: "Unknown slot." }, 404);

  let bytes: Buffer;
  try {
    bytes = await readMinkBoundedBytes(
      request,
      THEME_STUDIO_LIMITS.slotImageBytes,
      request.signal,
    );
  } catch (error) {
    if (error instanceof MinkRequestError && error.status === 413) {
      return json({ error: SLOT_IMAGE_REJECTION_MESSAGES.too_large }, 413);
    }
    return json({ error: SLOT_IMAGE_REJECTION_MESSAGES.empty }, 400);
  }

  const prepared = await prepareSlotImage(
    bytes,
    target.target,
    target.byteLimit,
  );
  if (!prepared.ok) {
    return json(
      {
        error: SLOT_IMAGE_REJECTION_MESSAGES[prepared.code],
        code: prepared.code,
      },
      prepared.code === "processor_unavailable" ? 503 : 400,
    );
  }

  try {
    const stored = await storeThemeStudioSlotImage(actor, {
      projectId,
      slotId,
      image: prepared.value,
    });
    return json(
      {
        id: stored.id,
        duplicate: stored.duplicate,
        url: `${SLOT_IMAGE_ROUTE_PREFIX}${stored.id}`,
        width: prepared.value.width,
        height: prepared.value.height,
        bytes: prepared.value.bytes.byteLength,
      },
      stored.duplicate ? 200 : 201,
    );
  } catch (error) {
    if (error instanceof ThemeStudioError) {
      return json(
        { error: error.message },
        error.code === "not_found" ? 404 : 409,
      );
    }
    logError("theme studio: slot image upload failed", error, { projectId });
    return json({ error: "The image couldn't be saved." }, 500);
  }
}
