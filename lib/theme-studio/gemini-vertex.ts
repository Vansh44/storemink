import "server-only";

import {
  GoogleGenAI,
  ThinkingLevel,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import { THEME_STUDIO_LIMITS } from "./contracts";
import {
  ZERO_USAGE,
  type ProviderUsage,
  type StructuredRequest,
  type StructuredResult,
  type ThemeStudioModelClient,
} from "./provider";

// ---------------------------------------------------------------------------
// Gemini models on Vertex AI, for Theme Studio ONLY.
//
// ★ A dedicated client, deliberately not shared with merchant Mink even though
// both use @google/genai: Mink's session carries tools, memories and a chat
// history, and a generation stage here must carry none of them. Nothing
// outside lib/theme-studio constructs this client, so "these models exist only
// for this task" is a property of the code rather than of a dropdown.
//
// ★ Credentials are Application Default Credentials; there is no API key. The
// project and region come from server environment only.
//
// ★ No tools are declared. The request has a system instruction, one user
// turn, and a response JSON schema — so the model can return JSON and nothing
// else, and nothing it writes is ever executed.
//
// ★ A safety block is a normal outcome, not an exception, and there is no
// fallback to another model: silently substituting one would be the
// substitution the Phase 0 registry forbids.
// ---------------------------------------------------------------------------

export interface VertexConfig {
  projectId: string;
  region: string;
}

export function getVertexConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): VertexConfig | null {
  const projectId =
    env.THEME_STUDIO_GCP_PROJECT_ID?.trim() || env.GCP_PROJECT_ID?.trim();
  if (!projectId) return null;
  return {
    projectId,
    region: env.THEME_STUDIO_VERTEX_LOCATION?.trim() || "global",
  };
}

/** Per-request ceiling. The run's own deadline (the Phase 0 wall time) is the
 * outer bound; this keeps one hung stage from consuming all of it. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

// Finish reasons that mean the provider withheld the answer on policy grounds.
// Anything else that is not STOP or MAX_TOKENS is an unexplained stop and is
// treated as a provider failure, never as a usable answer.
const REFUSAL_FINISH_REASONS = new Set([
  "SAFETY",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "RECITATION",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
]);

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

export function usageOf(
  response: GenerateContentResponse | null | undefined,
): ProviderUsage {
  const usage = response?.usageMetadata;
  if (!usage) return ZERO_USAGE;
  const input = count(usage.promptTokenCount);
  return {
    inputTokens: input,
    // A SUBSET of the prompt count, clamped so a provider quirk can never make
    // the estimate bill cached tokens twice or go negative.
    cachedTokens: Math.min(count(usage.cachedContentTokenCount), input),
    outputTokens: count(usage.candidatesTokenCount),
    thinkingTokens: count(usage.thoughtsTokenCount),
  };
}

function status(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /\babort/i.test(error.message))
  );
}

function isCredentialError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "object"
          ? (current as { message?: unknown }).message
          : undefined;
    if (
      typeof message === "string" &&
      /invalid_(?:grant|rapt)|reauth|credential/i.test(message)
    ) {
      return true;
    }
    current =
      typeof current === "object" ? (current as { cause?: unknown }).cause : 0;
  }
  return false;
}

/** The closed-vocabulary code for an SDK failure. Most specific first. */
export function classifyProviderError(
  error: unknown,
  signal?: AbortSignal,
): Extract<StructuredResult, { kind: "error" }>["code"] {
  if (signal?.aborted || isAbort(error)) return "cancelled";
  const code = status(error);
  if (code === 429) return "rate_limited";
  if (code === 401 || code === 403 || isCredentialError(error))
    return "provider_auth";
  if (code === 408 || code === 504) return "provider_timeout";
  if (code === 400 || code === 404 || code === 422) return "provider_rejected";
  return "provider_unavailable";
}

function toParts(request: StructuredRequest): Part[] {
  return request.content.map((block) =>
    block.type === "text"
      ? { text: block.text }
      : { inlineData: { mimeType: block.mediaType, data: block.base64 } },
  );
}

export function createVertexModelClient(
  config: VertexConfig,
): ThemeStudioModelClient {
  const ai = new GoogleGenAI({
    enterprise: true,
    project: config.projectId,
    location: config.region,
    apiVersion: "v1",
    httpOptions: {
      timeout: REQUEST_TIMEOUT_MS,
      // The SDK retries transient failures; the first attempt plus the Phase 0
      // retry budget. A refusal or a schema miss is never retried here.
      retryOptions: { attempts: THEME_STUDIO_LIMITS.modelRetries + 1 },
    },
  });

  return {
    provider: "vertex-gemini",
    async generate(request, signal) {
      let response: GenerateContentResponse;
      try {
        response = await ai.models.generateContent({
          model: request.providerModel,
          contents: [{ role: "user", parts: toParts(request) }],
          config: {
            abortSignal: signal,
            systemInstruction: request.system,
            maxOutputTokens: request.maxTokens,
            responseMimeType: "application/json",
            responseJsonSchema: request.schema,
            thinkingConfig: {
              thinkingLevel:
                request.effort === "high"
                  ? ThinkingLevel.HIGH
                  : ThinkingLevel.LOW,
            },
          },
        });
      } catch (error) {
        return {
          kind: "error",
          code: classifyProviderError(error, signal),
          usage: ZERO_USAGE,
        };
      }

      const usage = usageOf(response);
      const blocked = response.promptFeedback?.blockReason;
      if (blocked) {
        return { kind: "refused", category: String(blocked), usage };
      }
      const candidate = response.candidates?.[0];
      const finish = candidate?.finishReason
        ? String(candidate.finishReason)
        : null;
      if (finish && REFUSAL_FINISH_REASONS.has(finish)) {
        const rating = candidate?.safetyRatings?.find((r) => r.blocked);
        return {
          kind: "refused",
          category: rating?.category ? String(rating.category) : finish,
          usage,
        };
      }
      if (finish === "MAX_TOKENS") return { kind: "truncated", usage };
      if (finish !== "STOP") {
        return { kind: "error", code: "provider_unavailable", usage };
      }

      const text = (candidate?.content?.parts ?? [])
        .filter((part) => !part.thought)
        .map((part) => part.text ?? "")
        .join("");
      try {
        return { kind: "ok", value: JSON.parse(text) as unknown, usage };
      } catch {
        return { kind: "invalid_json", usage };
      }
    },
  };
}
