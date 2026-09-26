import { THEME_ASSET_PREFIX } from "./compiler";
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

/** Every placeholder slot an image model can fill, in package order. */
export function generatableSlots(
  pkg: ThemePackageV2,
  intent: ThemeIntent,
): GeneratableSlot[] {
  const briefs = new Map(intent.assetBriefs.map((b) => [b.id, b]));
  const out: GeneratableSlot[] = [];
  for (const slot of describeSlots(pkg)) {
    if (!slot.placeholder || !GENERATABLE_KINDS.has(slot.kind)) continue;
    if (slot.catalogPreview || slot.catalogScreenshot) continue;
    const target = slotTargetSize(slot);
    if (!target) continue;
    const brief = briefs.get(slot.id);
    // A slot's shape came from its brief's ratio, which is one the model
    // accepts, so the nearest accepted ratio IS that ratio; for a slot of any
    // other shape it is the closest the crop can then finish.
    const ratio = nearestImageRatio(target.aspect);
    out.push({
      slotId: slot.id,
      purpose: slot.kind as GeneratableSlot["purpose"],
      brief: {
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
