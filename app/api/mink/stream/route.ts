import { NextResponse } from "next/server";
import { getMinkActorContext } from "@/lib/mink/actor-context";
import { getMinkConfig } from "@/lib/mink/config";
import { MinkAgentError, MinkRequestError } from "@/lib/mink/errors";
import { runMinkAgent } from "@/lib/mink/orchestrator";
import {
  completeMinkRun,
  completeMinkToolCall,
  failMinkRun,
  startMinkRun,
  startMinkToolCall,
} from "@/lib/mink/persistence";
import { minkReadToolRegistry } from "@/lib/mink/tools/read-tools";
import { createVertexMinkSession } from "@/lib/mink/vertex-client";
import { logError, logInfo, logWarn } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import { rejectForeignMinkOrigin } from "@/lib/mink/request-origin";
import { normalizeMinkPageContext } from "@/lib/mink/page-context";
import type { MinkRunProgress } from "@/lib/mink/types";
import { selectMinkThinkingLevel } from "@/lib/mink/thinking";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 16_384;
const MAX_MESSAGE_LENGTH = 4_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMPTY_PROGRESS: MinkRunProgress = {
  steps: 0,
  toolCalls: 0,
  retryCount: 0,
  usage: {
    promptTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    totalTokens: 0,
  },
};

export async function POST(request: Request) {
  const config = getMinkConfig();
  if (!config.enabled) {
    return NextResponse.json(
      { error: "Mink AI is not enabled." },
      { status: 404 },
    );
  }

  const originError = rejectForeignMinkOrigin(request);
  if (originError) return originError;

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: "Request is too large." },
      { status: 413 },
    );
  }

  const requestId = crypto.randomUUID();
  try {
    const { message, conversationId, pageContext } = await readRequest(request);
    const actor = await getMinkActorContext(requestId, {
      pageContext,
      betaRequireInvite: config.betaRequireInvite,
    });
    const limited = await rateLimit(`mink:${actor.storeId}:${actor.adminId}`, {
      max: 20,
      windowSeconds: 60,
    });
    if (!limited.allowed) {
      return NextResponse.json(
        { error: "Mink AI is receiving too many requests. Try again shortly." },
        { status: 429 },
      );
    }

    const declarations = minkReadToolRegistry.declarationsFor(actor);
    const thinkingLevel = selectMinkThinkingLevel(message, declarations);
    const started = await startMinkRun({
      actor,
      conversationId,
      message,
      model: config.model,
      thinkingLevel,
    });
    const runActor = { ...actor, runId: started.runId };
    const abortController = new AbortController();
    const abortFromRequest = () => abortController.abort();
    if (request.signal.aborted) abortController.abort();
    else
      request.signal.addEventListener("abort", abortFromRequest, {
        once: true,
      });

    let progress: MinkRunProgress = EMPTY_PROGRESS;
    let session;
    try {
      session = createVertexMinkSession(config, runActor, declarations, {
        history: started.history,
        abortSignal: abortController.signal,
        thinkingLevel,
      });
    } catch (error) {
      await failMinkRun({
        actor,
        started,
        status: "failed",
        errorCode:
          error instanceof MinkAgentError ? error.code : "session_setup_failed",
        latencyMs: 0,
        model: config.model,
        pricingLocation: config.location,
        progress,
        usageStatus: "unavailable",
      });
      request.signal.removeEventListener("abort", abortFromRequest);
      throw error;
    }
    const encoder = new TextEncoder();
    const startedAt = Date.now();
    let consumerCancelled = false;
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, config.runTimeoutMs);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: Record<string, unknown>) => {
          if (consumerCancelled) return;
          controller.enqueue(
            encoder.encode(
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
            ),
          );
        };

        send("status", {
          state: "thinking",
          requestId,
          conversationId: started.conversationId,
          runId: started.runId,
        });
        try {
          const result = await runMinkAgent({
            actor: runActor,
            message,
            config,
            registry: minkReadToolRegistry,
            session,
            onProgress(next) {
              progress = next;
            },
            async onEvent(event) {
              if (event.type === "tool_call") {
                await startMinkToolCall({
                  actor,
                  started,
                  sequence: event.sequence,
                  call: event.call,
                });
                send("tool", {
                  state: "running",
                  name: event.call.name,
                  sequence: event.sequence,
                });
              } else {
                await completeMinkToolCall({
                  actor,
                  started,
                  sequence: event.sequence,
                  ok: event.ok,
                  errorCode: event.errorCode,
                });
                send("tool", {
                  state: event.ok ? "completed" : "failed",
                  name: event.name,
                  sequence: event.sequence,
                  ...(event.errorCode ? { errorCode: event.errorCode } : {}),
                });
              }
            },
          });
          await completeMinkRun({
            actor,
            started,
            result,
            latencyMs: Date.now() - startedAt,
            pricingLocation: config.location,
          });
          send("message", {
            role: "assistant",
            text: result.text,
            runId: started.runId,
            artifacts: result.artifacts,
          });
          send("usage", {
            model: result.model,
            thinkingLevel,
            steps: result.steps,
            toolCalls: result.toolCalls,
            retryCount: result.retryCount,
            ...result.usage,
          });
          send("done", {
            requestId,
            conversationId: started.conversationId,
            runId: started.runId,
          });
          logInfo("mink.run: ok", {
            requestId,
            storeId: actor.storeId,
            adminId: actor.adminId,
            model: result.model,
            steps: result.steps,
            toolCalls: result.toolCalls,
            retryCount: result.retryCount,
            totalTokens: result.usage.totalTokens,
            ms: Date.now() - startedAt,
          });
        } catch (error) {
          const cancelled =
            !timedOut &&
            (abortController.signal.aborted || isAbortError(error));
          const failedProgress = {
            ...progress,
            retryCount: Math.max(
              progress.retryCount,
              error instanceof MinkAgentError ? error.retryCount : 0,
            ),
          };
          const errorCode = timedOut
            ? "run_timeout"
            : cancelled
              ? "cancelled"
              : error instanceof MinkAgentError
                ? error.code
                : "mink_failed";
          await failMinkRun({
            actor,
            started,
            status: cancelled ? "cancelled" : "failed",
            errorCode,
            latencyMs: Date.now() - startedAt,
            model: config.model,
            pricingLocation: config.location,
            progress: failedProgress,
            usageStatus: failureUsageStatus({
              error,
              timedOut,
              cancelled,
              progress: failedProgress,
            }),
          }).catch((persistenceError) =>
            logError("mink.run: failure record failed", persistenceError, {
              requestId,
              storeId: actor.storeId,
              runId: started.runId,
            }),
          );
          const logContext = {
            requestId,
            storeId: actor.storeId,
            adminId: actor.adminId,
            model: config.model,
            ms: Date.now() - startedAt,
          };
          if (cancelled) logInfo("mink.run: cancelled", logContext);
          else if (timedOut) logWarn("mink.run: timed out", logContext);
          else logError("mink.run: failed", error, logContext);
          send("error", {
            code: errorCode,
            message: timedOut
              ? "Mink AI took too long to finish. Try a narrower question."
              : cancelled
                ? "Mink AI stopped this request."
                : error instanceof MinkAgentError
                  ? error.message
                  : "Mink AI couldn't complete that request.",
          });
          send("done", {
            requestId,
            conversationId: started.conversationId,
            runId: started.runId,
          });
        } finally {
          clearTimeout(timeoutId);
          request.signal.removeEventListener("abort", abortFromRequest);
          if (!consumerCancelled) controller.close();
        }
      },
      cancel() {
        consumerCancelled = true;
        abortController.abort();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, private",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
        "X-Mink-Request-Id": requestId,
      },
    });
  } catch (error) {
    if (error instanceof MinkRequestError) {
      logWarn("mink.run: request rejected", {
        requestId,
        code: error.code,
        status: error.status,
      });
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    logError("mink.run: setup failed", error, { requestId });
    return NextResponse.json(
      { error: "Mink AI couldn't start this request." },
      { status: 503 },
    );
  }
}

async function readRequest(request: Request): Promise<{
  message: string;
  conversationId?: string;
  pageContext: ReturnType<typeof normalizeMinkPageContext>;
}> {
  const body = (await request.json()) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SyntaxError("Request body must be a JSON object.");
  }
  const message = (body as Record<string, unknown>).message;
  if (typeof message !== "string") {
    throw new SyntaxError("message must be a string.");
  }
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new SyntaxError(
      `message must be between 1 and ${MAX_MESSAGE_LENGTH} characters.`,
    );
  }
  const conversationId = (body as Record<string, unknown>).conversationId;
  if (
    conversationId !== undefined &&
    (typeof conversationId !== "string" || !UUID_PATTERN.test(conversationId))
  ) {
    throw new SyntaxError("conversationId must be a UUID when provided.");
  }
  return {
    message: trimmed,
    ...(typeof conversationId === "string" ? { conversationId } : {}),
    pageContext: normalizeMinkPageContext(
      (body as Record<string, unknown>).context as
        | Record<string, unknown>
        | undefined,
    ),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function failureUsageStatus(input: {
  error: unknown;
  timedOut: boolean;
  cancelled: boolean;
  progress: MinkRunProgress;
}): "reported" | "partial" | "unavailable" {
  const hasReportedUsage = input.progress.usage.totalTokens > 0;
  if (input.timedOut || input.cancelled) {
    return hasReportedUsage ? "partial" : "unavailable";
  }
  if (
    !(input.error instanceof MinkAgentError) ||
    input.error.code === "provider_unavailable"
  ) {
    return hasReportedUsage ? "partial" : "unavailable";
  }
  return "reported";
}
