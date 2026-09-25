import { NextResponse } from "next/server";
import { readMinkBoundedBytes } from "@/lib/mink/bounded-json";
import { MinkRequestError } from "@/lib/mink/errors";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { logError } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import { THEME_STUDIO_LIMITS } from "@/lib/theme-studio/contracts";
import {
  REFERENCE_REJECTION_MESSAGES,
  sanitizeReferenceImage,
} from "@/lib/theme-studio/references";
import {
  addThemeStudioReference,
  isUuid,
  ThemeStudioError,
} from "@/lib/theme-studio/repository";

// Upload ONE reference image for a Theme Studio project.
//
// ★ A route handler, not a server action, because a server action's body is
// capped at 6 MB (next.config.ts) and a reference may be 10 MiB before it is
// sanitized. The body is the raw image bytes — no multipart, no filename, no
// claimed type is trusted: sanitizeReferenceImage decides the format from
// magic bytes and re-encodes it.
//
// ★ /api is outside proxy.ts, so this route is its own gate: superadmin
// session, same-origin browser POST, a rate limit, and a streamed byte cap
// that stops reading at the limit rather than trusting Content-Length.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

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
  if (!isUuid(projectId)) return json({ error: "Unknown project." }, 404);

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
    declared > THEME_STUDIO_LIMITS.referenceImageBytes
  ) {
    return json({ error: REFERENCE_REJECTION_MESSAGES.too_large }, 413);
  }

  let bytes: Buffer;
  try {
    bytes = await readMinkBoundedBytes(
      request,
      THEME_STUDIO_LIMITS.referenceImageBytes,
      request.signal,
    );
  } catch (error) {
    if (error instanceof MinkRequestError && error.status === 413) {
      return json({ error: REFERENCE_REJECTION_MESSAGES.too_large }, 413);
    }
    return json({ error: REFERENCE_REJECTION_MESSAGES.empty }, 400);
  }

  const sanitized = await sanitizeReferenceImage(bytes);
  if (!sanitized.ok) {
    return json(
      {
        error: REFERENCE_REJECTION_MESSAGES[sanitized.code],
        code: sanitized.code,
      },
      sanitized.code === "processor_unavailable" ? 503 : 400,
    );
  }

  try {
    const stored = await addThemeStudioReference(
      actor,
      projectId,
      sanitized.value,
    );
    return json(
      {
        id: stored.id,
        duplicate: stored.duplicate,
        width: sanitized.value.width,
        height: sanitized.value.height,
      },
      stored.duplicate ? 200 : 201,
    );
  } catch (error) {
    if (error instanceof ThemeStudioError) {
      const status =
        error.code === "not_found" ? 404 : error.code === "limit" ? 409 : 409;
      return json({ error: error.message }, status);
    }
    logError("theme studio: reference upload failed", error, { projectId });
    return json({ error: "The reference couldn't be saved." }, 500);
  }
}
