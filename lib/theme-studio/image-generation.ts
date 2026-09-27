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
  type ThemeStudioImageClient,
} from "./image-provider";
import {
  THEME_IMAGE_PROBLEM_TEXT,
  THEME_IMAGE_REDRAWS,
  THEME_IMAGE_REVIEW_MODEL_KEY,
  THEME_IMAGE_REVIEW_PROMPT_VERSION,
  isBlocking,
  reviewThemeImage,
  type ThemeImageProblem,
} from "./image-review";
import type { ThemeStudioModelClient } from "./provider";
import { THEME_IMAGE_RULES } from "@/lib/themes/validation";
import { prepareSlotImage, type PreparedSlotImage } from "./slot-images";

// ---------------------------------------------------------------------------
// One image run: the anchor, then every placeholder slot matched to it, each
// cropped and compressed to its slot. No database: the worker stores the
// results and writes the version.
//
// ★ THE ANCHOR GATES THE RUN. Every later image is asked to match it, so if it
// is refused, fails or is rejected by the reviewer, nothing else is attempted
// — twenty images drawn without a shared look are twenty images that do not
// belong together, and each one is paid for.
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
// it does not set a camera. So the first product shot that comes back becomes
// a second reference, SET, and every later product is matched to both: same
// backdrop, camera height, framing and scale, a different product. Products
// are drawn one at a time until that first one lands (a refused, unusable or
// rejected leader is not a reference), while the other slots, which need no
// set shot, start at once alongside it.
//
// ★ EVERY IMAGE IS REVIEWED, AND A REJECTED ONE IS REDRAWN ONCE (Track 3.4,
// image-review.ts). The reviewer sees the image as it will be cropped for its
// slot, and a redraw carries the problems it found. A provider refusal or
// error is NOT redrawn: it is not a quality finding, and the one-paid-attempt
// rule for provider failures stands. After the last attempt a blocking
// problem keeps the placeholder, while a minor one keeps the best image with
// the problem noted.
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
  /** Test seam; production crops with sharp. */
  prepare?: typeof prepareSlotImage;
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
  const calls: ImageCall[] = [];
  const reviews: ReviewCall[] = [];
  const record = (request: ThemeImageRequest, usage: ImageUsage) => {
    calls.push({
      purpose: request.purpose,
      briefId: request.briefId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostMicroUsd: estimateImageCostMicroUsd(usage),
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
  }): Promise<DrawResult> => {
    // The best image so far with no blocking problem, and why an earlier
    // attempt was turned down.
    let fallback: Kept | null = null;
    let lastRejection: { problems: ThemeImageProblem[]; note: string } | null =
      null;
    // A redraw that did not come back falls back to the earlier attempt: a
    // minor-problem image is kept, a blocking one stays rejected.
    const settle = (attempts: number, failure: DrawResult): DrawResult => {
      if (fallback) return { ...fallback, attempts };
      if (lastRejection) {
        return { status: "rejected", attempts, ...lastRejection };
      }
      return failure;
    };
    let retake: ThemeImageRetake | undefined;
    for (let attempt = 1; ; attempt++) {
      if (signal.aborted) return settle(attempt - 1, { status: "skipped" });
      const request = args.request(retake);
      const result = await client.generateImage(request, signal);
      record(request, result.usage);
      if (result.kind === "refused") {
        return settle(attempt, {
          status: "refused",
          attempts: attempt,
          reason: result.reason,
        });
      }
      if (result.kind === "error") {
        return settle(attempt, {
          status: "failed",
          attempts: attempt,
          code: result.code,
        });
      }
      const prepared = await prepare(result.bytes, args.target, args.byteLimit);
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
      if (!input.reviewer || !drawn.prepared) return kept("unreviewed");

      const review = await reviewThemeImage(
        input.reviewer.client,
        input.reviewer.providerModel,
        {
          purpose: args.purpose,
          brief: args.brief,
          candidate: base64(drawn.prepared.bytes),
          anchor: args.reviewAnchor,
          set: args.reviewSet,
          attempt,
        },
        signal,
      );
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
      });
      // A reviewer outage keeps the image: this is a quality check, and the
      // image model's own safety filters have already run.
      if (review.kind === "unavailable") return kept("unreviewed");
      if (review.problems.length === 0) return kept("passed");

      if (isBlocking(review.problems)) {
        lastRejection = { problems: review.problems, note: review.note };
      } else {
        fallback = kept("flagged", review.problems, review.note);
      }
      if (attempt > THEME_IMAGE_REDRAWS) {
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
  // is drawn at once; otherwise the first product that lands becomes it.
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
        while (!setRef && waiting.length > 0 && !signal.aborted) {
          const kept = await drawOne(waiting.shift()!, [anchorRef], null);
          if (kept) {
            setRef = {
              role: "set",
              mediaType: kept.mediaType,
              base64: base64(kept.bytes),
            };
            setForReview = kept.prepared ? base64(kept.prepared.bytes) : null;
          }
        }
      } finally {
        const refs = setRef ? [anchorRef, setRef] : [anchorRef];
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
      const task = queue.shift();
      if (task) {
        await task();
      } else if (!leaderSettled) {
        await leaderDone;
      } else {
        return;
      }
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.max(
          1,
          Math.min(options.concurrency ?? IMAGE_CONCURRENCY, slots.length),
        ),
      },
      worker,
    ),
  );

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
