import { THEME_ASSET_PREFIX, productSlotBrief } from "./compiler";
import {
  validateThemePackageV2,
  type ThemeIntent,
  type ThemePackageV2,
} from "./contracts";
import {
  THEME_IMAGE_ASPECT_RATIOS,
  aspectValue,
  type ThemeImageAspectRatio,
  type ThemeImagePurpose,
} from "./image-provider";
import type { ThemeImageBrief, ThemeImageDirection } from "./image-prompt";
import { THEME_ANCHOR_REDRAWS, THEME_IMAGE_REDRAWS } from "./image-review";
import type { ThemeProductSeed } from "@/lib/themes/types";
import {
  describeSlots,
  slotByteLimit,
  slotTargetSize,
  type SlotDescriptor,
} from "./slot-images-core";

// ---------------------------------------------------------------------------
// Which slots an image run fills, and how the finished images enter the next
// version's package. Pure: the worker does the provider calls and the storage.
//
// ★ ONLY PLACEHOLDERS, ONLY ART. A slot an operator already filled is theirs
// and is never regenerated; the catalog card and the two catalog screenshots
// are pictures of the storefront itself, which an image model cannot draw.
//
// ★ THE BRIEF COMES FROM THE VERSION'S INTENT. The package keeps only a slot's
// id, kind, shape and alt text; the subject and art direction the Stage A
// model wrote live in the intent. A slot with no brief (a hand-edited package)
// still gets an image, described by its alt text.
//
// ★ A PRODUCT'S SLOT IS DESCRIBED BY THE PRODUCT (Track 3.3). Its subject is
// that product's own name and description; the range brief it was made from
// supplies the staging, so the image shows THIS product, shot the way every
// product in the theme is shot.
// ---------------------------------------------------------------------------

/** How many images one run may make, the anchor included: Stage A's own brief
 *  ceiling, so a run can always fill everything a theme asked for. */
export const MAX_IMAGES_PER_RUN = 41;

const GENERATABLE_KINDS: ReadonlySet<SlotDescriptor["kind"]> = new Set([
  "hero",
  "product",
  "category",
  "content",
]);

export const GENERATED_LICENSE_NOTE =
  "Generated for this theme by StoreMink Theme Studio with an AI image model.";

export interface GeneratableSlot {
  slotId: string;
  purpose: Exclude<ThemeImagePurpose, "anchor">;
  /** What to ask the model for. */
  brief: ThemeImageBrief;
  /** The crop the stored image must end at. */
  target: { width: number; height: number; aspect: number };
  byteLimit: number;
}

/** The accepted ratio closest to a slot's own shape, by log distance so 2:1
 *  and 1:2 are treated alike. */
export function nearestImageRatio(aspect: number): ThemeImageAspectRatio {
  let best: ThemeImageAspectRatio = "1:1";
  let distance = Number.POSITIVE_INFINITY;
  for (const ratio of THEME_IMAGE_ASPECT_RATIOS) {
    const d = Math.abs(Math.log(aspectValue(ratio) / aspect));
    if (d < distance) {
      distance = d;
      best = ratio;
    }
  }
  return best;
}

/**
 * Whether an image run may draw this slot when an operator asks for it by
 * name (Track 3.5): an art slot (not the catalog card or a screenshot) whose
 * current image is a placeholder or one Theme Studio generated. Placeholders
 * are compiled with source "generated", so the source alone decides — an
 * operator's own upload ("operator-owned" or "licensed") is never redrawn.
 */
export function isRedrawableSlot(slot: SlotDescriptor): boolean {
  return (
    GENERATABLE_KINDS.has(slot.kind) &&
    !slot.catalogPreview &&
    !slot.catalogScreenshot &&
    slot.source === "generated"
  );
}

/** The ids of every slot an operator may ask to redraw, in package order. */
export function redrawableSlotIds(pkg: ThemePackageV2): string[] {
  return describeSlots(pkg)
    .filter(isRedrawableSlot)
    .map((slot) => slot.id);
}

/**
 * The slots an image run draws, in package order. By default every
 * placeholder art slot. With `only`, exactly the named slots that may be
 * redrawn (isRedrawableSlot) — a generated image included, an upload never.
 */
export function generatableSlots(
  pkg: ThemePackageV2,
  intent: ThemeIntent,
  only?: readonly string[],
): GeneratableSlot[] {
  const chosen = only ? new Set(only) : null;
  const briefs = new Map(intent.assetBriefs.map((b) => [b.id, b]));
  // Only a slot exactly one product uses is described by that product: a
  // version made before products had their own slots shares one among many,
  // and naming one of them would draw the wrong picture for the rest.
  const productsByPath = new Map<string, ThemeProductSeed[]>();
  for (const p of pkg.definition.preset.sampleData?.products ?? []) {
    productsByPath.set(p.image_url, [
      ...(productsByPath.get(p.image_url) ?? []),
      p,
    ]);
  }
  const out: GeneratableSlot[] = [];
  for (const slot of describeSlots(pkg)) {
    if (chosen) {
      if (!chosen.has(slot.id) || !isRedrawableSlot(slot)) continue;
    } else if (
      !slot.placeholder ||
      !GENERATABLE_KINDS.has(slot.kind) ||
      slot.catalogPreview ||
      slot.catalogScreenshot
    ) {
      continue;
    }
    const target = slotTargetSize(slot);
    if (!target) continue;
    // A slot's shape came from its brief's ratio, which is one the model
    // accepts, so the nearest accepted ratio IS that ratio; for a slot of any
    // other shape it is the closest the crop can then finish.
    const ratio = nearestImageRatio(target.aspect);
    const users = productsByPath.get(slot.path) ?? [];
    const product =
      slot.kind === "product" && users.length === 1 ? users[0] : undefined;
    const rangeId = product ? productSlotBrief(slot.id, briefs.keys()) : null;
    const range = rangeId ? briefs.get(rangeId) : undefined;
    const brief = product ? undefined : briefs.get(slot.id);
    out.push({
      slotId: slot.id,
      purpose: slot.kind as GeneratableSlot["purpose"],
      brief: product
        ? {
            id: slot.id,
            purpose: range?.purpose ?? "",
            subject: [product.name, product.description]
              .map((part) => part.trim())
              .filter(Boolean)
              .join(". "),
            artDirection: [
              range?.subject ? `Range staging: ${range.subject}.` : "",
              range?.artDirection ?? "",
            ]
              .filter(Boolean)
              .join(" "),
            aspectRatio: ratio,
          }
        : {
            id: slot.id,
            purpose: brief?.purpose ?? "",
            subject: brief?.subject || slot.alt,
            artDirection: brief?.artDirection ?? "",
            aspectRatio: ratio,
          },
      target,
      byteLimit: slotByteLimit(slot),
    });
  }
  return out.slice(0, MAX_IMAGES_PER_RUN - 1);
}

/**
 * What the Stage A model saw about the PHOTOGRAPHY in the operator's reference
 * screenshots (intent.referenceAnalysis[].imagery), de-duplicated and bounded.
 * The screenshots themselves never reach the image model — they are another
 * storefront, whose photographs are not ours to reproduce — so this is how the
 * look the operator pointed at reaches every image.
 */
export function referenceImagery(intent: ThemeIntent): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const reading of intent.referenceAnalysis ?? []) {
    for (const line of reading.imagery ?? []) {
      const text = line
        .replace(/[{}]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 200);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

/** The theme-wide direction for an image run, from the version itself. */
export function directionFromPackage(
  pkg: ThemePackageV2,
  intent: ThemeIntent,
): ThemeImageDirection {
  const preset = pkg.definition.preset;
  const palette = preset.design.palette;
  return {
    themeName: pkg.definition.name,
    summary: intent.summary,
    industries: [...intent.industries],
    moodKeywords: [...intent.visual.moodKeywords],
    paletteDirection: intent.visual.paletteDirection,
    density: intent.visual.density,
    shape: intent.visual.shape,
    palette: {
      page: palette.cream,
      surface: palette.surface,
      ink: palette.ink,
      accent: palette.accent ?? preset.brand.primaryColor,
    },
    referenceImagery: referenceImagery(intent),
  };
}

export interface GeneratedSlotImage {
  slotId: string;
  sha256: string;
  width: number;
  height: number;
}

/**
 * The next version's package: each generated slot points at its stored image,
 * marked generated with a note that is not the placeholder's (the only signal
 * acceptance and publication use to spot a placeholder). Alt text is kept —
 * it was written from the same brief the image was drawn from. The release
 * version follows the new version number, and the result must pass the full
 * package contract.
 */
export function applyGeneratedImages(
  pkg: ThemePackageV2,
  images: readonly GeneratedSlotImage[],
  versionNumber: number,
  modelLabel: string,
): { ok: true; value: ThemePackageV2 } | { ok: false; error: string } {
  if (images.length === 0) {
    return { ok: false, error: "No images were generated." };
  }
  const next: ThemePackageV2 = structuredClone(pkg);
  for (const image of images) {
    const index = next.assets.findIndex((a) => a.id === image.slotId);
    const asset = next.assets[index];
    if (!asset || !asset.path.startsWith(THEME_ASSET_PREFIX)) {
      return { ok: false, error: `This version has no slot ${image.slotId}.` };
    }
    if (asset.width && asset.height) {
      const expected = asset.width / asset.height;
      if (Math.abs(image.width / image.height / expected - 1) > 0.01) {
        return {
          ok: false,
          error: `The image for ${image.slotId} has the wrong shape for that slot.`,
        };
      }
    }
    next.assets[index] = {
      ...asset,
      sha256: image.sha256,
      width: image.width,
      height: image.height,
      source: "generated",
      licenseNote: GENERATED_LICENSE_NOTE,
    };
  }
  next.definition.release = {
    ...next.definition.release,
    version: `0.0.${versionNumber}`,
    notes: [
      ...next.definition.release.notes.slice(-4),
      `Images generated with ${modelLabel}: ${images.map((i) => i.slotId).join(", ")}.`.slice(
        0,
        500,
      ),
    ],
  };
  const validated = validateThemePackageV2(next);
  if (!validated.ok) {
    return {
      ok: false,
      error: `The theme with generated images no longer passes its contract: ${validated.issues[0] ?? "unknown issue"}`,
    };
  }
  return { ok: true, value: validated.value };
}

/** List-price figures behind the "Generate images" cost statement: about
 *  $0.135 per 2K Pro image (cost.ts) and about a cent per review (a Flash call
 *  at high effort with up to three images read at ultra-high resolution). */
export const IMAGE_LIST_PRICE_USD = 0.135;
export const IMAGE_REVIEW_LIST_PRICE_USD = 0.01;

/**
 * What an image run for `slots` slots is expected to cost, and the most it can
 * cost: every image (the anchor included) drawn and reviewed once, and at most
 * every one of them redrawn and reviewed as often as it may be
 * (image-review.ts: THEME_IMAGE_REDRAWS, THEME_ANCHOR_REDRAWS). Stated before the click because every image is paid.
 */
export function imageRunEstimate(slots: number): {
  images: number;
  expectedUsd: number;
  mostUsd: number;
} {
  const images = slots + 1;
  const each = IMAGE_LIST_PRICE_USD + IMAGE_REVIEW_LIST_PRICE_USD;
  const once = images * each;
  const most =
    once * (1 + THEME_IMAGE_REDRAWS) +
    each * (THEME_ANCHOR_REDRAWS - THEME_IMAGE_REDRAWS);
  return {
    images,
    expectedUsd: Math.round(once * 100) / 100,
    mostUsd: Math.round(most * 100) / 100,
  };
}
