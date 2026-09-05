import { revalidatePath, revalidateTag } from "next/cache";
import { after, NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkRequestError } from "@/lib/mink/errors";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import {
  executeMinkStorefrontPublication,
  previewMinkStorefrontPublication,
  previewMinkStorefrontPublicationRollback,
} from "@/lib/mink/storefront-publication-actions";
import { emitEvent } from "@/lib/notifications/record";
import { logError, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import { notifyStoreContentPublished } from "@/lib/seo/store-indexing";
import { TAGS } from "@/lib/storefront/tags";

export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 24 * 1024;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ draftId: string }> },
) {
  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;
  const { draftId } = await params;
  if (!UUID_PATTERN.test(draftId)) {
    return privateJson({ error: "Invalid Mink AI storefront proposal." }, 400);
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return privateJson(
      { error: "Mink publication request is too large." },
      413,
    );
  }
  let mutation: PublicationMutation;
  try {
    mutation = readMutation(await readBoundedJson(request));
  } catch (error) {
    return privateJson(
      {
        error:
          error instanceof BodyTooLargeError
            ? "Mink publication request is too large."
            : error instanceof Error
              ? error.message
              : "Invalid storefront publication request.",
      },
      error instanceof BodyTooLargeError ? 413 : 400,
    );
  }
  const config = getMinkConfig();
  if (!config.enabled) {
    return privateJson({ error: "Mink AI is not enabled." }, 404);
  }
  const requestId = crypto.randomUUID();
  try {
    const actor = await getMinkActorContext(requestId, {
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(
      `mink-storefront-publication:${actor.storeId}:${actor.adminId}`,
      { max: 6, windowSeconds: 60 },
    );
    if (!limited.allowed) {
      return privateJson(
        {
          error: "Mink storefront publication is receiving too many requests.",
        },
        429,
      );
    }
    if (mutation.action === "preview_publish") {
      const approval = await previewMinkStorefrontPublication({
        actor,
        draftId,
        sourceApprovalId: mutation.sourceApprovalId,
        idempotencyKey: mutation.idempotencyKey,
        browserValidation: mutation.browserValidation,
      });
      return privateJson({ approval });
    }
    if (mutation.action === "preview_rollback") {
      const approval = await previewMinkStorefrontPublicationRollback({
        actor,
        draftId,
        sourceApprovalId: mutation.sourceApprovalId,
        idempotencyKey: mutation.idempotencyKey,
      });
      return privateJson({ approval });
    }
    const result = await executeMinkStorefrontPublication({
      actor,
      draftId,
      approvalId: mutation.approvalId,
    });
    const path = result.approval.resource.publicPath;
    revalidatePath("/dashboard/builder");
    revalidatePath(result.approval.resource.dashboardPath);
    revalidatePath(path);
    revalidateTag(TAGS.pages, "max");
    if (result.approval.after.page_status === "published") {
      after(() =>
        notifyStoreContentPublished({
          storeId: actor.storeId,
          paths: path === "/" ? ["/"] : [path, "/"],
        }),
      );
    }
    if (!result.repeated && result.approval.operation === "apply") {
      emitEvent({
        type: "page.published",
        storeId: actor.storeId,
        actor: { type: "admin", id: actor.adminId, label: actor.email },
        subject: {
          type: "page",
          id: result.approval.resource.id,
          label: result.approval.before.page_title,
        },
        payload: {
          source: "mink_ai",
          approvalId: result.approval.id,
          page: result.approval.before.page_title,
          url: path,
        },
      });
    }
    return privateJson({ result });
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.storefront_publication: request rejected", {
        requestId,
        draftId,
        action: mutation.action,
        code: error.code,
        status: error.status,
      });
      return privateJson(
        { error: error.message, code: error.code },
        error.status,
      );
    }
    logError("mink.storefront_publication: request failed", error, {
      requestId,
      draftId,
      action: mutation.action,
    });
    return privateJson(
      { error: "Mink AI couldn't complete that storefront publication." },
      503,
    );
  }
}

type PublicationMutation =
  | {
      action: "preview_publish";
      sourceApprovalId: string;
      idempotencyKey: string;
      browserValidation: unknown;
    }
  | {
      action: "preview_rollback";
      sourceApprovalId: string;
      idempotencyKey: string;
    }
  | { action: "execute"; approvalId: string };

function readMutation(value: unknown): PublicationMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("Mink storefront publication must be a JSON object.");
  }
  const row = value as Record<string, unknown>;
  if (row.action === "preview_publish") {
    assertOnlyKeys(row, [
      "action",
      "sourceApprovalId",
      "idempotencyKey",
      "browserValidation",
    ]);
    if (!row.browserValidation || typeof row.browserValidation !== "object") {
      throw new SyntaxError("Run desktop and mobile publication checks first.");
    }
    return {
      action: "preview_publish",
      sourceApprovalId: readUuid(row.sourceApprovalId, "sourceApprovalId"),
      idempotencyKey: readUuid(row.idempotencyKey, "idempotencyKey"),
      browserValidation: row.browserValidation,
    };
  }
  if (row.action === "preview_rollback") {
    assertOnlyKeys(row, ["action", "sourceApprovalId", "idempotencyKey"]);
    return {
      action: "preview_rollback",
      sourceApprovalId: readUuid(row.sourceApprovalId, "sourceApprovalId"),
      idempotencyKey: readUuid(row.idempotencyKey, "idempotencyKey"),
    };
  }
  if (row.action === "execute") {
    assertOnlyKeys(row, ["action", "approvalId"]);
    return {
      action: "execute",
      approvalId: readUuid(row.approvalId, "approvalId"),
    };
  }
  throw new SyntaxError("Choose a storefront publication action.");
}

class BodyTooLargeError extends Error {}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body)
    throw new SyntaxError("Mink publication request is empty.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  return JSON.parse(body);
}

function readUuid(value: unknown, field: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new SyntaxError(`${field} must be a UUID.`);
  }
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new SyntaxError("Mink publication request has unsupported fields.");
  }
}

function privateJson(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store, private",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
