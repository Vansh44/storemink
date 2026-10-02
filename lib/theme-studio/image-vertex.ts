import "server-only";

import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  Modality,
  ProminentPeople,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Part,
} from "@google/genai";
import { logWarn } from "@/lib/observability/logger";
import { classifyProviderError } from "./gemini-vertex";
import { abortable } from "./abortable";
import { imageRequestPool } from "./image-request-pool";
import type { ThemeStudioImageConfig } from "./image-models";
import {
  ZERO_IMAGE_USAGE,
  assertThemeImageRequest,
  type ImageUsage,
  type ThemeImageRequest,
  type ThemeImageResult,
  type ThemeStudioImageClient,
} from "./image-provider";
import {
  RATE_LIMIT_BACKOFF,
  rateLimitDelayMs,
  sleepUnlessAborted,
} from "./rate-limit-backoff";

// ---------------------------------------------------------------------------
// Gemini image generation on Vertex AI, for Theme Studio ONLY.
//
// ★ ONE PAID ATTEMPT PER IMAGE. A timeout or a 5xx may come after the model ran
// and billed, so the SDK does not retry (merchant Mink's rule). Only a 429 is
// retried, through the same slow backoff the text client uses: Vertex refuses
// a rate-limited request before running the model, so waiting it out cannot
// charge twice.
//
// ★ THE SAFETY SETTINGS ARE FIXED HERE, NOT PASSED IN, and match Mink's
// verified call exactly: four harm filters at BLOCK_LOW_AND_ABOVE, no people at
// all, prominent people blocked, one candidate, 2K JPEG. A theme's demo images
// must meet the same bar as a merchant's, and no request can weaken it.
// Gemini-generated images carry SynthID by default on Vertex.
//
// ★ A REFUSAL IS A NORMAL OUTCOME, NOT AN ERROR, and there is no fallback to
// another model (the registry rule). Its reason goes back to the caller; the
// provider's own error text goes only to the log, never into a stored result.
//
// References are sent INLINE (Theme Studio's assets are rows in Postgres, not
// objects in a bucket), each after a text label naming its role.
// ---------------------------------------------------------------------------

const SAFETY_CATEGORIES = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
] as const;

/** A 2K Pro image with one reference measured 26 s; a request carrying up to
 *  three references on a busy shared project is given generous room, since a
 *  timed-out image may still have been billed. */
export const IMAGE_REQUEST_TIMEOUT_MS = 180_000;

/** The fixed provider configuration for one image. Exported so a test can pin
 *  every safety value rather than trust a comment. */
export function themeImageConfig(
  request: ThemeImageRequest,
): GenerateContentConfig {
  return {
    // Gemini image models require TEXT together with IMAGE; only the image
    // part is kept.
    responseModalities: [Modality.TEXT, Modality.IMAGE],
    candidateCount: 1,
    safetySettings: SAFETY_CATEGORIES.map((category) => ({
      category,
      threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE,
    })),
    imageConfig: {
      aspectRatio: request.aspectRatio,
      imageSize: "2K",
      personGeneration: "ALLOW_NONE",
      prominentPeople: ProminentPeople.BLOCK_PROMINENT_PEOPLE,
      outputMimeType: "image/jpeg",
      outputCompressionQuality: 95,
    },
  };
}

/** The request's parts: the prompt, then each reference after its label. */
export function themeImageParts(request: ThemeImageRequest): Part[] {
  return [
    { text: request.prompt },
    ...request.references.flatMap((reference) => [
      { text: reference.role === "anchor" ? "ANCHOR:" : "SET:" },
      {
        inlineData: { mimeType: reference.mediaType, data: reference.base64 },
      },
    ]),
  ];
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
}

export function imageUsageOf(
  response: GenerateContentResponse | null | undefined,
): ImageUsage {
  const usage = response?.usageMetadata;
  if (!usage) return ZERO_IMAGE_USAGE;
  return {
    inputTokens: count(usage.promptTokenCount),
    outputTokens: count(usage.candidatesTokenCount),
  };
}

const OUTPUT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Reads one response into a result: the first inline image, a refusal with
 *  its reason, or an unexplained empty answer. */
export function parseThemeImageResponse(
  response: GenerateContentResponse,
): ThemeImageResult {
  const usage = imageUsageOf(response);
  const blocked = response.promptFeedback?.blockReason;
  if (blocked) {
    return {
      kind: "refused",
      reason:
        response.promptFeedback?.blockReasonMessage?.trim() || String(blocked),
      usage,
    };
  }
  const candidate = response.candidates?.[0];
  const inline = candidate?.content?.parts?.find((part) =>
    Boolean(part.inlineData?.data),
  )?.inlineData;
  const finish = candidate?.finishReason
    ? String(candidate.finishReason)
    : null;
  if (inline?.data) {
    const mediaType = (inline.mimeType || "image/jpeg").toLowerCase();
    if (!OUTPUT_TYPES.has(mediaType)) {
      return { kind: "error", code: "provider_rejected", usage };
    }
    return {
      kind: "ok",
      bytes: new Uint8Array(Buffer.from(inline.data, "base64")),
      mediaType: mediaType as "image/jpeg" | "image/png" | "image/webp",
      usage,
    };
  }
  // No image. A named stop is the provider withholding it; nothing at all is
  // an unexplained failure, never an empty success.
  if (finish && finish !== "STOP") {
    return {
      kind: "refused",
      reason: candidate?.finishMessage?.trim() || finish,
      usage,
    };
  }
  return { kind: "error", code: "provider_unavailable", usage };
}

export interface ImageClientOptions {
  /** Test seams; production uses real timers and Math.random. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<boolean>;
  random?: () => number;
  pool?: ReturnType<typeof imageRequestPool>;
  /** Test seam for the SDK call. */
  send?: (
    request: ThemeImageRequest,
    signal: AbortSignal,
  ) => Promise<GenerateContentResponse>;
}

export function createVertexImageClient(
  config: ThemeStudioImageConfig,
  options: ImageClientOptions = {},
): ThemeStudioImageClient {
  const sleep = options.sleep ?? sleepUnlessAborted;
  const random = options.random ?? Math.random;
  const pool =
    options.pool ??
    imageRequestPool(config.projectId, config.location, config.providerModel);
  let ai: GoogleGenAI | null = null;
  const send =
    options.send ??
    ((request: ThemeImageRequest, signal: AbortSignal) => {
      ai ??= new GoogleGenAI({
        enterprise: true,
        project: config.projectId,
        location: config.location,
        apiVersion: "v1",
        // One attempt: see the header.
        httpOptions: {
          timeout: IMAGE_REQUEST_TIMEOUT_MS,
          retryOptions: { attempts: 1 },
        },
      });
      return ai.models.generateContent({
        model: config.providerModel,
        contents: [{ role: "user", parts: themeImageParts(request) }],
        config: { ...themeImageConfig(request), abortSignal: signal },
      });
    });

  return {
    provider: "vertex-gemini",
    async generateImage(request, outer) {
      assertThemeImageRequest(request);
      try {
        return await generate(request, outer);
      } catch {
        return {
          kind: "error",
          code: outer.aborted ? "cancelled" : "provider_unavailable",
          usage: ZERO_IMAGE_USAGE,
        };
      }
    },
  };

  async function generate(
    request: ThemeImageRequest,
    outer: AbortSignal,
  ): Promise<ThemeImageResult> {
    let waitedMs = 0;
    const started = Date.now();
    let capacityWaitMs = 0;
    let providerAttempts = 0;
    const timed = (result: ThemeImageResult): ThemeImageResult => ({
      ...result,
      timing: {
        durationMs: Date.now() - started,
        capacityWaitMs,
        providerAttempts,
      },
    });
    for (let retry = 0; ; retry++) {
      let signal = outer;
      let pendingWait: Promise<boolean> | null = null;
      let retryDelay: number | null = null;
      const queuedAt = Date.now();
      try {
        return timed(
          await pool.run(async (epoch) => {
            capacityWaitMs += Date.now() - queuedAt;
            // The attempt clock starts when a permit is acquired. Waiting behind
            // another theme is bounded by the run signal, not provider latency.
            signal = AbortSignal.any([
              outer,
              AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
            ]);
            // Cooldowns consume no active permit; admission waits until the
            // shared pause settles, then resumes at the reduced probe limit.
            providerAttempts++;
            try {
              const result = parseThemeImageResponse(
                await abortable(() => send(request, signal), signal),
              );
              pool.recovered(epoch);
              return result;
            } catch (error) {
              // Register the shared pause BEFORE releasing this permit, so
              // queued slots cannot surge into the same exhausted capacity.
              if (
                !signal.aborted &&
                classifyProviderError(error) === "rate_limited"
              ) {
                const delay = rateLimitDelayMs(retry, random);
                if (
                  retry < RATE_LIMIT_BACKOFF.retries &&
                  waitedMs + delay <= RATE_LIMIT_BACKOFF.totalMs
                ) {
                  retryDelay = delay;
                  pendingWait = sleep(delay, outer);
                }
                pool.coolDown(pendingWait ?? Promise.resolve());
              }
              throw error;
            }
          }, outer),
        );
      } catch (error) {
        const code = outer.aborted
          ? "cancelled"
          : signal.aborted
            ? "provider_timeout"
            : classifyProviderError(error);
        const delay =
          code === "rate_limited" && retry < RATE_LIMIT_BACKOFF.retries
            ? retryDelay
            : null;
        if (delay === null || waitedMs + delay > RATE_LIMIT_BACKOFF.totalMs) {
          return timed({ kind: "error", code, usage: ZERO_IMAGE_USAGE });
        }
        // Purpose and brief id only: never the prompt or the references.
        logWarn("theme_studio.image_rate_limited_retry", {
          purpose: request.purpose,
          brief: request.briefId,
          retry: retry + 1,
          waitMs: delay,
        });
        const waitStarted = Date.now();
        if (!(await pendingWait)) {
          capacityWaitMs += Date.now() - waitStarted;
          return timed({
            kind: "error",
            code: "cancelled",
            usage: ZERO_IMAGE_USAGE,
          });
        }
        capacityWaitMs += Date.now() - waitStarted;
        waitedMs += delay;
      }
    }
  }
}
