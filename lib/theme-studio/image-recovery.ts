import { createHash } from "node:crypto";
import { canonicalJson } from "./contracts";
import {
  estimateImageCostMicroUsd,
  THEME_STUDIO_IMAGE_PRICING_VERSION,
  THEME_STUDIO_PRICING_VERSION,
} from "./cost";
import type {
  ImageCall,
  ImageRunOptions,
  ReviewCall,
} from "./image-generation";
import type {
  ThemeImageResult,
  ThemeStudioImageClient,
} from "./image-provider";
import {
  reviewThemeImage,
  THEME_IMAGE_REVIEW_MODEL_KEY,
  THEME_IMAGE_REVIEW_PROMPT_VERSION,
  type ThemeImageReview,
} from "./image-review";

/** Separate from crash attempts: two delayed retries of the same photographs. */
export const IMAGE_REVIEW_DEFERRALS = 2;
export const IMAGE_CRASH_ATTEMPTS = 3;
export function imageReviewRecoveryDelayMs(deferrals: number): number | null {
  return deferrals < IMAGE_REVIEW_DEFERRALS ? 60_000 * 2 ** deferrals : null;
}

export type ImageCheckpoint =
  | {
      stage: "draw";
      response: ThemeImageResult;
      call: ImageCall;
    }
  | { stage: "review"; response: ThemeImageReview; call: ReviewCall };

export interface ImageCheckpointStore {
  read(digest: string): Promise<ImageCheckpoint | null>;
  write(digest: string, checkpoint: ImageCheckpoint): Promise<void>;
}

/** A storage/lease failure must stop settlement, not become a missing slot. */
export class ImageCheckpointError extends Error {
  constructor() {
    super("Image checkpoint unavailable.");
  }
}

const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Only known free admission failures may be retried. An unknown-usage timeout
 * or cancellation after transport starts can still have incurred spend. */
function retryableUnbilledDraw(response: ThemeImageResult): boolean {
  return (
    response.kind === "error" &&
    response.usage.inputTokens + response.usage.outputTokens === 0 &&
    (response.code === "rate_limited" ||
      response.timing?.providerAttempts === 0)
  );
}

/** Exact requests, including all reference bytes. Slot-local ordinals keep
 * parallel completion order from changing keys, and distinguish paid retakes. */
export function resumableImageClient(
  client: ThemeStudioImageClient,
  providerModel: string,
  promptVersion: string,
  store: ImageCheckpointStore,
): ThemeStudioImageClient {
  const ordinals = new Map<string, number>();
  return {
    provider: client.provider,
    async generateImage(request, signal) {
      signal.throwIfAborted();
      const slot = `${request.purpose}:${request.briefId}`;
      const ordinal = ordinals.get(slot) ?? 0;
      ordinals.set(slot, ordinal + 1);
      let key = digest({
        stage: "draw",
        provider: client.provider,
        providerModel,
        promptVersion,
        ordinal,
        request,
      });
      let saved = await store.read(key);
      // Old deployments journalled free 429s. Preserve their immutable rows,
      // but use a separate deterministic key for the first billable replacement.
      if (
        !saved ||
        (saved.stage === "draw" && retryableUnbilledDraw(saved.response))
      ) {
        const replacementKey = digest({
          retryOf: key,
          unbilledAdmission: true,
        });
        const replacement = await store.read(replacementKey);
        // Retry ancestry excludes free errors but may contain their paid
        // replacement. Probe that key even when the original read is empty.
        if (saved || replacement) {
          key = replacementKey;
          saved = replacement;
        }
      }
      signal.throwIfAborted();
      if (saved?.stage === "draw") return saved.response;
      const started = Date.now();
      const response = await client.generateImage(request, signal);
      if (retryableUnbilledDraw(response)) return response;
      // Commit the original bytes BEFORE processing or review. Even a late
      // cancel retains incurred spend, while final settlement writes no version.
      await store.write(key, {
        stage: "draw",
        response,
        call: {
          briefId: request.briefId,
          purpose: request.purpose,
          ...response.usage,
          estimatedCostMicroUsd: estimateImageCostMicroUsd(response.usage),
          durationMs: Date.now() - started,
          referenceRoles: request.references.map((r) => r.role),
          ...(response.timing
            ? {
                capacityWaitMs: response.timing.capacityWaitMs,
                providerAttempts: response.timing.providerAttempts,
              }
            : {}),
        },
      });
      return response;
    },
  };
}

/** Successful evidence is immutable and bound to the candidate, anchor, SET,
 * brief, model and prompt. Unavailable reviews are journalled once per recovery
 * pass; reclaims never repeat them, later passes retry only the review. */
export function resumableImageReview(
  store: ImageCheckpointStore,
  recoveryPass: number,
): NonNullable<ImageRunOptions["review"]> {
  return async (reviewer, input, signal, briefId) => {
    signal.throwIfAborted();
    const binding = {
      stage: "review",
      briefId,
      provider: reviewer.client.provider,
      providerModel: reviewer.providerModel,
      modelKey: THEME_IMAGE_REVIEW_MODEL_KEY,
      promptVersion: THEME_IMAGE_REVIEW_PROMPT_VERSION,
      input,
    };
    const key = digest(binding);
    const attemptKey = digest({ ...binding, recoveryPass });
    const saved = (await store.read(key)) ?? (await store.read(attemptKey));
    signal.throwIfAborted();
    if (saved?.stage === "review") return saved.response;
    const started = Date.now();
    const response = await reviewThemeImage(
      reviewer.client,
      reviewer.providerModel,
      input,
      signal,
    );
    // Zero-usage cancellation is not evidence. Journal any returned paid usage
    // even if a cancellation arrives after the provider has answered.
    if (
      !signal.aborted ||
      response.usage.inputTokens +
        response.usage.outputTokens +
        response.usage.thinkingTokens >
        0
    ) {
      await store.write(response.kind === "reviewed" ? key : attemptKey, {
        stage: "review",
        response,
        call: {
          briefId,
          attempt: input.attempt,
          outcome:
            response.kind === "unavailable"
              ? "unavailable"
              : response.problems.length
                ? "problems"
                : "passed",
          problems: response.kind === "reviewed" ? response.problems : [],
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          thinkingTokens: response.usage.thinkingTokens,
          estimatedCostMicroUsd: response.estimatedCostMicroUsd,
          durationMs: Date.now() - started,
          ...(response.kind === "unavailable"
            ? { errorCode: response.code }
            : {}),
        },
      });
    }
    return response;
  };
}

/** Only metadata is read for accounting, never all raw photographs. Each
 * primary key contributes once, including failed reviews and rejected draws. */
export function imageCheckpointUsage(
  checkpoints: Pick<ImageCheckpoint, "stage" | "call">[],
) {
  const calls = checkpoints
    .filter((c) => c.stage === "draw")
    .map((c) => c.call as ImageCall);
  const reviews = checkpoints
    .filter((c) => c.stage === "review")
    .map((c) => c.call as ReviewCall);
  const reviewCostMicroUsd = reviews.reduce(
    (n, c) => n + c.estimatedCostMicroUsd,
    0,
  );
  return {
    calls,
    reviews,
    totals: calls.reduce(
      (sum, c) => ({
        inputTokens: sum.inputTokens + c.inputTokens,
        outputTokens: sum.outputTokens + c.outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    ),
    estimatedCostMicroUsd: calls.reduce(
      (n, c) => n + c.estimatedCostMicroUsd,
      reviewCostMicroUsd,
    ),
    reviewCostMicroUsd,
    pricingVersion: THEME_STUDIO_IMAGE_PRICING_VERSION,
    reviewPricingVersion: THEME_STUDIO_PRICING_VERSION,
    reviewPromptVersion: THEME_IMAGE_REVIEW_PROMPT_VERSION,
    reviewModelKey: THEME_IMAGE_REVIEW_MODEL_KEY,
  };
}
