import "server-only";

import type { ThemeIntent, ThemePackageV2 } from "./contracts";
import {
  THEME_STUDIO_IMAGE_PRICING_VERSION,
  THEME_STUDIO_PRICING_VERSION,
  estimateImageCostMicroUsd,
} from "./cost";
import {
  directionFromPackage,
  generatableSlots,
  type GeneratableSlot,
} from "./image-generation-core";
import {
  buildAnchorRequest,
  buildAssetRequest,
  type ThemeImageBrief,
  type ThemeImageRetake,
} from "./image-prompt";
import {
  ZERO_IMAGE_USAGE,
  type ImageUsage,
  type ThemeImagePurpose,
  type ThemeImageReference,
  type ThemeImageRequest,
  type ThemeImageResult,
  type ThemeStudioImageClient,
} from "./image-provider";
import {
  THEME_ANCHOR_REDRAWS,
  THEME_IMAGE_PROBLEM_TEXT,
  THEME_IMAGE_REDRAWS,
  THEME_IMAGE_REVIEW_MODEL_KEY,
  THEME_IMAGE_REVIEW_PROMPT_VERSION,
  isBlocking,
  refusalRetakeText,
  reviewThemeImage,
  type ThemeImageProblem,
  type ThemeImageReview,
  type ThemeImageReviewInput,
} from "./image-review";
import { ImageCheckpointError } from "./image-recovery";
import { ZERO_USAGE, type ThemeStudioModelClient } from "./provider";
import { THEME_IMAGE_RULES } from "@/lib/themes/validation";
import { prepareSlotImage, type PreparedSlotImage } from "./slot-images";
import { ImageRequestPool } from "./image-request-pool";

// ---------------------------------------------------------------------------
// One image run: the anchor, then every placeholder slot matched to it, each
// cropped and compressed to its slot. The worker's injected clients checkpoint
// original draws and reviews immediately; final settlement writes one version.
//
// ★ THE ANCHOR GATES THE RUN. Every later image is asked to match it, so if it
// is refused, fails or is rejected by the reviewer, nothing else is attempted
// — twenty images drawn without a shared look are twenty images that do not
// belong together, and each one is paid for. Because it gates everything and
// is never shown in the store, it gets two redraws and only a person or the
// wrong subject can reject it (image-review.ts, THEME_ANCHOR_REDRAWS).
//
// ★ A FAILED SLOT KEEPS ITS PLACEHOLDER. A refusal, an error, an image the
// crop cannot use or one the reviewer rejects is recorded per slot and the run
// carries on; the version is honest about which slots are still placeholders,
// and acceptance refuses them as it always has.
//
// ★ EVERY CALL'S USAGE IS RECORDED, refused and failed ones included: the
// provider may have billed them, and the daily spend cap must count what was
// spent, not only what was kept. The reviewer's calls are counted too.
//
// ★ ONE STAGING ACROSS PRODUCTS (Track 3.3). The anchor sets the theme's look;
// it does not set a camera. So the first product shot that passes review becomes
// a second reference, SET, and every later product is matched to both: same
// backdrop, camera height, framing and scale, a different product. Products
// are drawn one at a time until that first one lands (a refused, unusable or
// flagged or unreviewed leader is not a reference), while the other slots, which need no
// set shot, start at once alongside it.
//
// ★ EVERY IMAGE IS REVIEWED, AND A REJECTED ONE IS REDRAWN (Track 3.4,
// image-review.ts). The reviewer sees the image as it will be cropped for its
// slot, and a redraw carries the problems it found. A provider REFUSAL is
// redrawn too, with the reason it was blocked: the provider does not bill a
// blocked image. A provider ERROR is not redrawn inside the run — a timeout
// may have been billed — and is left to the fill run the worker queues for
// every slot still missing (worker.ts, IMAGE_FILL_ROUNDS). After the last
// attempt a blocking problem keeps the placeholder, while a minor one keeps
// the best image with the problem noted.
// ---------------------------------------------------------------------------

/** Images drawn at once. Enough to finish a dozen slots in a couple of minutes
 *  inside the run's wall time, few enough not to trip the provider's rate
 *  limit on a shared project. */
export const IMAGE_CONCURRENCY = 3;

const ANCHOR_TARGET = { width: 1600, height: 1200, aspect: 4 / 3 };

/** How the kept image fared with the reviewer. */
export type ImageReviewState = "passed" | "flagged" | "unreviewed";

export type SlotOutcome =
  | {
      slotId: string;
      status: "generated";
      attempts: number;
      review: ImageReviewState;
      /** Minor problems the kept image still has (review "flagged"). */
      problems?: ThemeImageProblem[];
      note?: string;
    }
  | {
      slotId: string;
      status: "rejected";
      attempts: number;
      problems: ThemeImageProblem[];
      note: string;
    }
  | {
      slotId: string;
      status: "refused";
      attempts: number;
      reason: string | null;
    }
  | { slotId: string; status: "failed"; attempts: number; code: string }
  | { slotId: string; status: "unusable"; attempts: number; code: string }
  | { slotId: string; status: "skipped" };

export interface ImageCall {
  purpose: ThemeImageRequest["purpose"];
  briefId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicroUsd: number;
  durationMs?: number;
  capacityWaitMs?: number;
  providerAttempts?: number;
  referenceRoles?: ThemeImageReference["role"][];
}

export interface ReviewCall {
  briefId: string;
  attempt: number;
  outcome: "passed" | "problems" | "unavailable";
  problems: ThemeImageProblem[];
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  estimatedCostMicroUsd: number;
  durationMs?: number;
  errorCode?: string;
}

export interface ThemeImageRunResult {
  /** Why nothing was drawn, when the anchor itself did not come back. */
  anchorFailure:
    | { kind: "refused"; reason: string | null }
    | { kind: "failed"; code: string }
    | { kind: "rejected"; problems: ThemeImageProblem[]; note: string }
    | null;
  /** The anchor, cropped and compressed for storage; null if unusable. */
  anchor: PreparedSlotImage | null;
  images: { slotId: string; image: PreparedSlotImage }[];
  outcomes: SlotOutcome[];
  telemetry: {
    calls: ImageCall[];
    reviews: ReviewCall[];
    totals: ImageUsage;
    /** Images and reviews together: what the daily spend cap reads. */
    estimatedCostMicroUsd: number;
    reviewCostMicroUsd: number;
    pricingVersion: string;
    reviewPricingVersion: string;
    reviewPromptVersion: string;
    reviewModelKey: string;
    durationMs?: number;
  };
}

/** An image already stored for this theme, reused as a reference. */
export interface StoredReference {
  bytes: Uint8Array;
  mediaType: ThemeImageReference["mediaType"];
}

/** The vision reviewer. Null runs without review (every image "unreviewed"). */
export interface ThemeImageReviewer {
  client: ThemeStudioModelClient;
  providerModel: string;
}

export interface ImageRunOptions {
  concurrency?: number;
  reviewConcurrency?: number;
  /** Test seam; production crops with sharp. */
  prepare?: typeof prepareSlotImage;
  /** Production journals review evidence separately from paid draws. */
  review?: (
    reviewer: ThemeImageReviewer,
    input: ThemeImageReviewInput,
    signal: AbortSignal,
    briefId: string,
  ) => Promise<ThemeImageReview>;
  /** Pause the run on reviewer outages; never let them trigger paid redraws. */
  deferUnavailableReviews?: boolean;
}

interface Drawn {
  bytes: Uint8Array;
  mediaType: ThemeImageReference["mediaType"];
  prepared: PreparedSlotImage | null;
}

type Kept = {
  status: "kept";
  drawn: Drawn;
  attempts: number;
  review: ImageReviewState;
  problems: ThemeImageProblem[];
  note: string;
};

type DrawResult =
  | Kept
  | {
      status: "rejected";
      attempts: number;
      problems: ThemeImageProblem[];
      note: string;
    }
  | { status: "refused"; attempts: number; reason: string | null }
  | { status: "failed"; attempts: number; code: string }
  | { status: "unusable"; attempts: number; code: string }
  | { status: "skipped" };

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export async function runThemeImageGeneration(
  client: ThemeStudioImageClient,
  input: {
    pkg: ThemePackageV2;
    intent: ThemeIntent;
    /** Required, so every caller decides whether images are reviewed. */
    reviewer: ThemeImageReviewer | null;
    /** Track 3.5: redraw exactly these slots (see generatableSlots). */
    only?: readonly string[];
    /**
     * Track 3.5: references to reuse instead of drawing them. A redraw of a
     * few slots matches the theme's existing art-direction image (so the
     * redraw belongs to the set it joins) and, for products, an existing
     * product photo. Both are the stored WebP.
     */
    seed?: { anchor: StoredReference; set: StoredReference | null } | null;
  },
  signal: AbortSignal,
  options: ImageRunOptions = {},
): Promise<ThemeImageRunResult> {
  const prepare = options.prepare ?? prepareSlotImage;
  const slots = generatableSlots(input.pkg, input.intent, input.only);
  const direction = directionFromPackage(input.pkg, input.intent);
  const started = Date.now();
  const drawConcurrency = Math.max(
    1,
    Math.min(IMAGE_CONCURRENCY, options.concurrency ?? IMAGE_CONCURRENCY),
  );
  const reviewConcurrency = Math.max(
    1,
    Math.min(IMAGE_CONCURRENCY, options.reviewConcurrency ?? IMAGE_CONCURRENCY),
  );
  const drawPool = new ImageRequestPool(drawConcurrency);
  const reviewPool = new ImageRequestPool(reviewConcurrency);
  let laneFailed = false;
  const calls: ImageCall[] = [];
  const reviews: ReviewCall[] = [];
  const record = (
    request: ThemeImageRequest,
    usage: ImageUsage,
    durationMs: number,
    timing?: ThemeImageResult["timing"],
  ) => {
    calls.push({
      purpose: request.purpose,
      briefId: request.briefId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostMicroUsd: estimateImageCostMicroUsd(usage),
      referenceRoles: request.references.map((r) => r.role),
      durationMs,
      ...(timing
        ? {
            capacityWaitMs: timing.capacityWaitMs,
            providerAttempts: timing.providerAttempts,
          }
        : {}),
    });
  };
  const finish = (
    partial: Omit<ThemeImageRunResult, "telemetry">,
  ): ThemeImageRunResult => {
    const totals = calls.reduce(
      (sum, c) => ({
        inputTokens: sum.inputTokens + c.inputTokens,
        outputTokens: sum.outputTokens + c.outputTokens,
      }),
      ZERO_IMAGE_USAGE,
    );
    const imageCost = calls.reduce((s, c) => s + c.estimatedCostMicroUsd, 0);
    const reviewCost = reviews.reduce((s, r) => s + r.estimatedCostMicroUsd, 0);
    return {
      ...partial,
      telemetry: {
        calls,
        reviews,
        totals,
        estimatedCostMicroUsd: imageCost + reviewCost,
        reviewCostMicroUsd: reviewCost,
        pricingVersion: THEME_STUDIO_IMAGE_PRICING_VERSION,
        reviewPricingVersion: THEME_STUDIO_PRICING_VERSION,
        reviewPromptVersion: THEME_IMAGE_REVIEW_PROMPT_VERSION,
        reviewModelKey: THEME_IMAGE_REVIEW_MODEL_KEY,
        durationMs: Date.now() - started,
      },
    };
  };

  /**
   * Draw one image, review it, and redraw it once if the reviewer found a
   * problem. `allowUnprepared` is the anchor's rule: an anchor the crop cannot
   * store is still used as a reference, unreviewed.
   */
  const drawReviewed = async (args: {
    briefId: string;
    purpose: ThemeImagePurpose;
    brief: Pick<ThemeImageBrief, "subject" | "artDirection" | "aspectRatio">;
    request: (retake?: ThemeImageRetake) => ThemeImageRequest;
    target: { width: number; height: number; aspect: number };
    byteLimit: number;
    reviewAnchor: string | null;
    reviewSet: string | null;
    allowUnprepared?: boolean;
    /** Redraws after the first attempt; THEME_IMAGE_REDRAWS by default. */
    redraws?: number;
  }): Promise<DrawResult> => {
    const redraws = args.redraws ?? THEME_IMAGE_REDRAWS;
    // The best image so far with no blocking problem, and why an earlier
    // attempt was turned down.
    let fallback: Kept | null = null;
    let lastRejection: { problems: ThemeImageProblem[]; note: string } | null =
      null;
    let lastRefusal: { reason: string | null } | null = null;
    // A redraw that did not come back falls back to the earlier attempt: a
    // minor-problem image is kept, a blocking one stays rejected.
    const settle = (attempts: number, failure: DrawResult): DrawResult => {
      if (fallback) return { ...fallback, attempts };
      if (lastRejection) {
        return { status: "rejected", attempts, ...lastRejection };
      }
      if (lastRefusal && failure.status === "skipped") {
        return { status: "refused", attempts, reason: lastRefusal.reason };
      }
      return failure;
    };
    let retake: ThemeImageRetake | undefined;
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted || laneFailed)
        return settle(attempt - 1, { status: "skipped" });
      const request = args.request(retake);
      const drawStarted = Date.now();
      let result;
      try {
        result = await drawPool.run(
          () => client.generateImage(request, signal),
          signal,
        );
      } catch (error) {
        if (error instanceof ImageCheckpointError) throw error;
        // One unexpected SDK failure must not reject Promise.all and discard
        // all paid images from the other lanes. Fill runs retry just this slot.
        return settle(attempt, {
          status: "failed",
          attempts: attempt,
          code: signal.aborted ? "cancelled" : "provider_unavailable",
        });
      }
      record(request, result.usage, Date.now() - drawStarted, result.timing);
      if (result.kind === "refused") {
        // A refusal is not billed, so it is redrawn with the reason it was
        // blocked rather than abandoned.
        if (attempt > redraws) {
          return settle(attempt, {
            status: "refused",
            attempts: attempt,
            reason: result.reason,
          });
        }
        lastRefusal = { reason: result.reason };
        retake = { problems: [refusalRetakeText(result.reason)], note: "" };
        continue;
      }
      if (result.kind === "error") {
        return settle(attempt, {
          status: "failed",
          attempts: attempt,
          code: result.code,
        });
      }
      let prepared;
      try {
        prepared = await prepare(result.bytes, args.target, args.byteLimit);
      } catch {
        return settle(attempt, {
          status: "unusable",
          attempts: attempt,
          code: "image_processing_failed",
        });
      }
      if (!prepared.ok && !args.allowUnprepared) {
        return settle(attempt, {
          status: "unusable",
          attempts: attempt,
          code: prepared.code,
        });
      }
      const drawn: Drawn = {
        bytes: result.bytes,
        mediaType: result.mediaType,
        prepared: prepared.ok ? prepared.value : null,
      };
      const kept = (
        review: ImageReviewState,
        problems: ThemeImageProblem[] = [],
        note = "",
      ): Kept => ({
        status: "kept",
        drawn,
        attempts: attempt,
        review,
        problems,
        note,
      });
      const reviewer = input.reviewer;
      const candidate = drawn.prepared;
      if (!reviewer || !candidate) return kept("unreviewed");

      const reviewStarted = Date.now();
      const review = await reviewPool
        .run(
          () =>
            (
              options.review ??
              ((reviewer, input, signal) =>
                reviewThemeImage(
                  reviewer.client,
                  reviewer.providerModel,
                  input,
                  signal,
                ))
            )(
              reviewer,
              {
                purpose: args.purpose,
                brief: args.brief,
                candidate: base64(candidate.bytes),
                anchor: args.reviewAnchor,
                set: args.reviewSet,
                attempt,
              },
              signal,
              args.briefId,
            ),
          signal,
        )
        .catch((error) => {
          if (error instanceof ImageCheckpointError) throw error;
          return {
            kind: "unavailable" as const,
            code: signal.aborted ? "cancelled" : "provider_unavailable",
            usage: ZERO_USAGE,
            estimatedCostMicroUsd: 0,
          };
        });
      reviews.push({
        briefId: args.briefId,
        attempt,
        outcome:
          review.kind === "unavailable"
            ? "unavailable"
            : review.problems.length === 0
              ? "passed"
              : "problems",
        problems: review.kind === "reviewed" ? review.problems : [],
        inputTokens: review.usage.inputTokens,
        outputTokens: review.usage.outputTokens,
        thinkingTokens: review.usage.thinkingTokens,
        estimatedCostMicroUsd: review.estimatedCostMicroUsd,
        durationMs: Date.now() - reviewStarted,
        ...(review.kind === "unavailable" ? { errorCode: review.code } : {}),
      });
      // A reviewer outage keeps the image: this is a quality check, and the
      // image model's own safety filters have already run.
      if (review.kind === "unavailable") {
        if (options.deferUnavailableReviews)
          return {
            status: "failed",
            attempts: attempt,
            code: "image_review_pending",
          };
        return kept("unreviewed");
      }
      if (review.problems.length === 0) return kept("passed");

      if (isBlocking(review.problems, args.purpose)) {
        lastRejection = { problems: review.problems, note: review.note };
      } else {
        // Keep the least flawed paid candidate. A later redraw with more
        // problems must not overwrite a better earlier photograph.
        if (!fallback || review.problems.length < fallback.problems.length)
          fallback = kept("flagged", review.problems, review.note);
      }
      if (attempt > redraws) {
        return settle(attempt, {
          status: "rejected",
          attempts: attempt,
          problems: review.problems,
          note: review.note,
        });
      }
      retake = {
        problems: review.problems.map((p) => THEME_IMAGE_PROBLEM_TEXT[p]),
        note: review.note,
      };
    }
  };

  if (slots.length === 0) {
    return finish({
      anchorFailure: null,
      anchor: null,
      images: [],
      outcomes: [],
    });
  }

  // 1. The anchor: reused when the caller has one (a redraw), else drawn.
  const seed = input.seed ?? null;
  const anchorResult: DrawResult = seed
    ? {
        status: "kept",
        drawn: {
          bytes: seed.anchor.bytes,
          mediaType: seed.anchor.mediaType,
          prepared: null,
        },
        attempts: 0,
        review: "unreviewed",
        problems: [],
        note: "",
      }
    : await drawReviewed({
        briefId: "anchor",
        purpose: "anchor",
        brief: {
          subject: `A signature still life that sets the look for ${direction.themeName}.`,
          artDirection: "",
          aspectRatio: "4:3",
        },
        request: (retake) => buildAnchorRequest(direction, undefined, retake),
        target: ANCHOR_TARGET,
        byteLimit: THEME_IMAGE_RULES.maxBytes,
        reviewAnchor: null,
        reviewSet: null,
        allowUnprepared: true,
        redraws: THEME_ANCHOR_REDRAWS,
      });
  if (anchorResult.status !== "kept") {
    return finish({
      anchorFailure:
        anchorResult.status === "refused"
          ? { kind: "refused", reason: anchorResult.reason }
          : anchorResult.status === "rejected"
            ? {
                kind: "rejected",
                problems: anchorResult.problems,
                note: anchorResult.note,
              }
            : {
                kind: "failed",
                code:
                  anchorResult.status === "failed" ||
                  anchorResult.status === "unusable"
                    ? anchorResult.code
                    : "cancelled",
              },
      anchor: null,
      images: [],
      outcomes: slots.map((s) => ({ slotId: s.slotId, status: "skipped" })),
    });
  }
  // The reference is the provider's own full-quality image, not the stored
  // WebP: every later image is matched to it. The reviewer sees the stored
  // WebP, which is what the storefront shows.
  const anchorRef: ThemeImageReference = {
    role: "anchor",
    mediaType: anchorResult.drawn.mediaType,
    base64: base64(anchorResult.drawn.bytes),
  };
  // A reused anchor is already the stored WebP the reviewer should see.
  const anchorForReview = seed
    ? base64(seed.anchor.bytes)
    : anchorResult.drawn.prepared
      ? base64(anchorResult.drawn.prepared.bytes)
      : null;

  // 2. Every slot, a few at a time: the product leader first, the rest of
  // the products once it is known, everything else from the start.
  const outcomes = new Map<string, SlotOutcome>();
  const images: { slotId: string; image: PreparedSlotImage }[] = [];
  /** Draws one slot; returns the provider's image when it was kept. */
  const drawOne = async (
    slot: GeneratableSlot,
    references: ThemeImageReference[],
    reviewSet: string | null,
  ): Promise<Drawn | null> => {
    const result = await drawReviewed({
      briefId: slot.slotId,
      purpose: slot.purpose,
      brief: slot.brief,
      request: (retake) =>
        buildAssetRequest(
          direction,
          slot.purpose,
          slot.brief,
          references,
          undefined,
          retake,
        ),
      target: slot.target,
      byteLimit: slot.byteLimit,
      reviewAnchor: anchorForReview,
      reviewSet,
    });
    const slotId = slot.slotId;
    switch (result.status) {
      case "kept":
        images.push({ slotId, image: result.drawn.prepared! });
        outcomes.set(slotId, {
          slotId,
          status: "generated",
          attempts: result.attempts,
          review: result.review,
          ...(result.problems.length
            ? { problems: result.problems, note: result.note }
            : {}),
        });
        return result.drawn;
      case "rejected":
        outcomes.set(slotId, {
          slotId,
          status: "rejected",
          attempts: result.attempts,
          problems: result.problems,
          note: result.note,
        });
        return null;
      case "refused":
        outcomes.set(slotId, {
          slotId,
          status: "refused",
          attempts: result.attempts,
          reason: result.reason,
        });
        return null;
      case "failed":
      case "unusable":
        outcomes.set(slotId, {
          slotId,
          status: result.status,
          attempts: result.attempts,
          code: result.code,
        });
        return null;
      case "skipped":
        outcomes.set(slotId, { slotId, status: "skipped" });
        return null;
    }
  };

  const products = slots.filter((s) => s.purpose === "product");
  const others = slots.filter((s) => s.purpose !== "product");
  const queue: (() => Promise<unknown>)[] = [];
  // A reused product photo is the set shot from the start, so every product
  // is drawn at once; otherwise the first product that passes review becomes it.
  let setRef: ThemeImageReference | null = seed?.set
    ? {
        role: "set",
        mediaType: seed.set.mediaType,
        base64: base64(seed.set.bytes),
      }
    : null;
  let setForReview: string | null = seed?.set ? base64(seed.set.bytes) : null;
  let leaderSettled = products.length === 0 || setRef !== null;
  let releaseLeader: () => void = () => {};
  const leaderDone = new Promise<void>((resolve) => {
    releaseLeader = resolve;
  });
  if (products.length > 0 && setRef) {
    const refs = [anchorRef, setRef];
    for (const slot of products) {
      queue.push(() => drawOne(slot, refs, setForReview));
    }
  } else if (products.length > 0) {
    queue.push(async () => {
      const waiting = [...products];
      try {
        while (
          !setRef &&
          waiting.length > 0 &&
          !signal.aborted &&
          !laneFailed
        ) {
          const slot = waiting.shift()!;
          const kept = await drawOne(slot, [anchorRef], null);
          const leader = outcomes.get(slot.slotId);
          // Establish SET only after the leader's saved photograph is reviewed.
          // Drawing followers now would change their requests on recovery.
          if (
            leader?.status === "failed" &&
            leader.code === "image_review_pending"
          )
            break;
          if (
            kept &&
            (input.reviewer === null ||
              (leader?.status === "generated" && leader.review === "passed"))
          ) {
            setRef = {
              role: "set",
              mediaType: kept.mediaType,
              base64: base64(kept.bytes),
            };
            setForReview = kept.prepared ? base64(kept.prepared.bytes) : null;
          }
        }
      } catch (error) {
        laneFailed = true;
        throw error;
      } finally {
        const refs = setRef ? [anchorRef, setRef] : [anchorRef];
        if (
          !laneFailed &&
          !products.some((s) => {
            const outcome = outcomes.get(s.slotId);
            return (
              outcome?.status === "failed" &&
              outcome.code === "image_review_pending"
            );
          })
        )
          for (const slot of waiting) {
            queue.push(() => drawOne(slot, refs, setForReview));
          }
        leaderSettled = true;
        releaseLeader();
      }
    });
  }
  for (const slot of others) {
    queue.push(() => drawOne(slot, [anchorRef], null));
  }

  const worker = async () => {
    for (;;) {
      if (laneFailed) return;
      const task = queue.shift();
      if (task) {
        try {
          await task();
        } catch (error) {
          laneFailed = true;
          throw error;
        }
      } else if (!leaderSettled) {
        await leaderDone;
      } else {
        return;
      }
    }
  };
  const settled = await Promise.allSettled(
    Array.from(
      {
        length: Math.max(
          1,
          Math.min(
            input.reviewer
              ? drawConcurrency + reviewConcurrency
              : drawConcurrency,
            slots.length,
          ),
        ),
      },
      worker,
    ),
  );
  // Drain all lanes before releasing the lease, even when storage fails.
  const rejected = settled.find((r) => r.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;

  // Package order, not completion order: the version's release note and the
  // stored asset order stay stable run to run.
  const order = new Map(slots.map((s, i) => [s.slotId, i]));
  images.sort((a, b) => order.get(a.slotId)! - order.get(b.slotId)!);
  return finish({
    anchorFailure: null,
    // A reused anchor is already stored; only a newly drawn one is returned.
    anchor: seed ? null : anchorResult.drawn.prepared,
    images,
    outcomes: slots.map(
      (s) => outcomes.get(s.slotId) ?? { slotId: s.slotId, status: "skipped" },
    ),
  });
}
