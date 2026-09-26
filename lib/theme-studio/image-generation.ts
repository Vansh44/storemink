import "server-only";

import type { ThemeIntent, ThemePackageV2 } from "./contracts";
import {
  THEME_STUDIO_IMAGE_PRICING_VERSION,
  estimateImageCostMicroUsd,
} from "./cost";
import {
  directionFromPackage,
  generatableSlots,
  type GeneratableSlot,
} from "./image-generation-core";
import { buildAnchorRequest, buildAssetRequest } from "./image-prompt";
import {
  ZERO_IMAGE_USAGE,
  type ImageUsage,
  type ThemeImageReference,
  type ThemeImageRequest,
  type ThemeStudioImageClient,
} from "./image-provider";
import { THEME_IMAGE_RULES } from "@/lib/themes/validation";
import { prepareSlotImage, type PreparedSlotImage } from "./slot-images";

// ---------------------------------------------------------------------------
// One image run: the anchor, then every placeholder slot matched to it, each
// cropped and compressed to its slot. No database: the worker stores the
// results and writes the version.
//
// ★ THE ANCHOR GATES THE RUN. Every later image is asked to match it, so if it
// is refused or fails, nothing else is attempted — twenty images drawn without
// a shared look are twenty images that do not belong together, and each one is
// paid for.
//
// ★ A FAILED SLOT KEEPS ITS PLACEHOLDER. A refusal, an error or an image the
// crop cannot use is recorded per slot and the run carries on; the version is
// honest about which slots are still placeholders, and acceptance refuses them
// as it always has.
//
// ★ EVERY CALL'S USAGE IS RECORDED, refused and failed ones included: the
// provider may have billed them, and the daily spend cap must count what was
// spent, not only what was kept.
// ---------------------------------------------------------------------------

/** Images drawn at once. Enough to finish a dozen slots in a couple of minutes
 *  inside the run's wall time, few enough not to trip the provider's rate
 *  limit on a shared project. */
export const IMAGE_CONCURRENCY = 3;

const ANCHOR_TARGET = { width: 1600, height: 1200, aspect: 4 / 3 };

export type SlotOutcome =
  | { slotId: string; status: "generated" }
  | { slotId: string; status: "refused"; reason: string | null }
  | { slotId: string; status: "failed"; code: string }
  | { slotId: string; status: "unusable"; code: string }
  | { slotId: string; status: "skipped" };

export interface ImageCall {
  purpose: ThemeImageRequest["purpose"];
  briefId: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostMicroUsd: number;
}

export interface ThemeImageRunResult {
  /** Why nothing was drawn, when the anchor itself did not come back. */
  anchorFailure:
    | { kind: "refused"; reason: string | null }
    | { kind: "failed"; code: string }
    | null;
  /** The anchor, cropped and compressed for storage; null if unusable. */
  anchor: PreparedSlotImage | null;
  images: { slotId: string; image: PreparedSlotImage }[];
  outcomes: SlotOutcome[];
  telemetry: {
    calls: ImageCall[];
    totals: ImageUsage;
    estimatedCostMicroUsd: number;
    pricingVersion: string;
  };
}

export interface ImageRunOptions {
  concurrency?: number;
  /** Test seam; production crops with sharp. */
  prepare?: typeof prepareSlotImage;
}

export async function runThemeImageGeneration(
  client: ThemeStudioImageClient,
  input: { pkg: ThemePackageV2; intent: ThemeIntent },
  signal: AbortSignal,
  options: ImageRunOptions = {},
): Promise<ThemeImageRunResult> {
  const prepare = options.prepare ?? prepareSlotImage;
  const slots = generatableSlots(input.pkg, input.intent);
  const direction = directionFromPackage(input.pkg, input.intent);
  const calls: ImageCall[] = [];
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
    return {
      ...partial,
      telemetry: {
        calls,
        totals,
        estimatedCostMicroUsd: calls.reduce(
          (sum, c) => sum + c.estimatedCostMicroUsd,
          0,
        ),
        pricingVersion: THEME_STUDIO_IMAGE_PRICING_VERSION,
      },
    };
  };

  if (slots.length === 0) {
    return finish({
      anchorFailure: null,
      anchor: null,
      images: [],
      outcomes: [],
    });
  }

  // 1. The anchor.
  const anchorRequest = buildAnchorRequest(direction);
  const anchorResult = await client.generateImage(anchorRequest, signal);
  record(anchorRequest, anchorResult.usage);
  if (anchorResult.kind !== "ok") {
    return finish({
      anchorFailure:
        anchorResult.kind === "refused"
          ? { kind: "refused", reason: anchorResult.reason }
          : { kind: "failed", code: anchorResult.code },
      anchor: null,
      images: [],
      outcomes: slots.map((s) => ({ slotId: s.slotId, status: "skipped" })),
    });
  }
  const preparedAnchor = await prepare(
    anchorResult.bytes,
    ANCHOR_TARGET,
    THEME_IMAGE_RULES.maxBytes,
  );
  // The reference is the provider's own full-quality image, not the stored
  // WebP: every later image is matched to it.
  const anchorRef: ThemeImageReference = {
    role: "anchor",
    mediaType: anchorResult.mediaType,
    base64: Buffer.from(anchorResult.bytes).toString("base64"),
  };

  // 2. Every slot, a few at a time.
  const outcomes = new Map<string, SlotOutcome>();
  const images: { slotId: string; image: PreparedSlotImage }[] = [];
  const queue = [...slots];
  const drawOne = async (slot: GeneratableSlot) => {
    if (signal.aborted) {
      outcomes.set(slot.slotId, { slotId: slot.slotId, status: "skipped" });
      return;
    }
    const request = buildAssetRequest(direction, slot.purpose, slot.brief, [
      anchorRef,
    ]);
    const result = await client.generateImage(request, signal);
    record(request, result.usage);
    if (result.kind === "refused") {
      outcomes.set(slot.slotId, {
        slotId: slot.slotId,
        status: "refused",
        reason: result.reason,
      });
      return;
    }
    if (result.kind === "error") {
      outcomes.set(slot.slotId, {
        slotId: slot.slotId,
        status: "failed",
        code: result.code,
      });
      return;
    }
    const prepared = await prepare(result.bytes, slot.target, slot.byteLimit);
    if (!prepared.ok) {
      outcomes.set(slot.slotId, {
        slotId: slot.slotId,
        status: "unusable",
        code: prepared.code,
      });
      return;
    }
    images.push({ slotId: slot.slotId, image: prepared.value });
    outcomes.set(slot.slotId, { slotId: slot.slotId, status: "generated" });
  };
  const workers = Array.from(
    {
      length: Math.max(
        1,
        Math.min(options.concurrency ?? IMAGE_CONCURRENCY, queue.length),
      ),
    },
    async () => {
      for (let slot = queue.shift(); slot; slot = queue.shift()) {
        await drawOne(slot);
      }
    },
  );
  await Promise.all(workers);

  // Package order, not completion order: the version's release note and the
  // stored asset order stay stable run to run.
  const order = new Map(slots.map((s, i) => [s.slotId, i]));
  images.sort((a, b) => order.get(a.slotId)! - order.get(b.slotId)!);
  return finish({
    anchorFailure: null,
    anchor: preparedAnchor.ok ? preparedAnchor.value : null,
    images,
    outcomes: slots.map(
      (s) => outcomes.get(s.slotId) ?? { slotId: s.slotId, status: "skipped" },
    ),
  });
}
