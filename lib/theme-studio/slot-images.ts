import "server-only";

import { createHash } from "node:crypto";
import { and, count, eq, inArray, max, sql } from "drizzle-orm";
import {
  themeStudioAssets,
  themeStudioProjects,
  themeStudioVersions,
} from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import type { ThemeStudioActor } from "./access";
import {
  THEME_STUDIO_LIMITS,
  validateThemePackageV2,
  type ThemePackageV2,
} from "./contracts";
import {
  REFERENCE_MAX_INPUT_PIXELS,
  REFERENCE_REJECTION_MESSAGES,
  loadSharp,
  openUntrustedImage,
  rejectionFor,
  type ReferenceMediaType,
  type ReferenceRejection,
  type SharpWithOptions,
} from "./references";
import {
  SLOT_IMAGE_MIN_WIDTH,
  applySlotReplacements,
  describeSlots,
  slotByteLimit,
  slotTargetSize,
  validateSlotReplacements,
  type SlotDescriptor,
  type SlotImageRow,
} from "./slot-images-core";
import {
  digestThemeStudioJson,
  isUuid,
  recordThemeStudioEvent,
  ThemeStudioError,
} from "./repository";
import { slotUrls } from "./preview";

// ---------------------------------------------------------------------------
// Operator images per slot — the server half. The pure rules are in
// slot-images-core.ts.
//
// An upload is untrusted exactly like a reference (openUntrustedImage): the
// format is decided by magic bytes, one frame only, a pixel ceiling, and the
// stored bytes are ALWAYS a re-encode. It is then cropped to its slot's aspect
// ratio (centred), sized to the slot's target, and compressed until it fits
// the storefront limits (TA-2.6: WebP, ≥800px wide, ≤500 KiB; the catalog card
// ≤250 KiB). An upload too small for the slot is refused, never upscaled: a
// blurry image passes every automated check and fails every human one.
// ---------------------------------------------------------------------------

const QUALITIES = [86, 80, 74, 68, 62, 56, 50];
/** Each extra pass shrinks the image this much, down to the minimum width. */
const SHRINK = 0.88;

export type SlotImageRejection =
  | ReferenceRejection
  | "too_small"
  | "too_detailed";

export const SLOT_IMAGE_REJECTION_MESSAGES: Record<SlotImageRejection, string> =
  {
    ...REFERENCE_REJECTION_MESSAGES,
    too_large: `Each image must be at most ${THEME_STUDIO_LIMITS.slotImageBytes / 1024 / 1024} MB.`,
    animated: "Animated images aren't accepted. Upload a still image.",
    too_small: `The image is too small for this slot. After cropping to the slot's shape it must be at least ${SLOT_IMAGE_MIN_WIDTH}px wide.`,
    too_detailed:
      "The image couldn't be compressed to the storefront's size limit. Try a simpler or smaller image.",
  };

export interface PreparedSlotImage {
  bytes: Buffer;
  mediaType: "image/webp";
  width: number;
  height: number;
  sha256: string;
  originalMediaType: ReferenceMediaType;
  originalByteSize: number;
}

/** Crop, size and compress one upload for a slot. */
export async function prepareSlotImage(
  input: Uint8Array,
  target: { width: number; height: number; aspect: number },
  byteLimit: number,
  loader: () => Promise<SharpWithOptions | null> = loadSharp,
): Promise<
  | { ok: true; value: PreparedSlotImage }
  | { ok: false; code: SlotImageRejection }
> {
  const opened = await openUntrustedImage(
    input,
    THEME_STUDIO_LIMITS.slotImageBytes,
    loader,
  );
  if (!opened.ok) return opened;

  // The largest centred region with the slot's ratio.
  const sourceAspect = opened.width / opened.height;
  const cropWidth =
    sourceAspect > target.aspect
      ? Math.floor(opened.height * target.aspect)
      : opened.width;
  if (cropWidth < SLOT_IMAGE_MIN_WIDTH) return { ok: false, code: "too_small" };

  let width = Math.min(target.width, cropWidth);
  const sharp = await loader();
  if (!sharp) return { ok: false, code: "processor_unavailable" };
  // Every pass decodes the ORIGINAL upload, so the image is compressed once,
  // never re-compressed from an earlier attempt.
  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const encode = async (w: number, quality: number) => {
    const { data, info } = await sharp(buffer, {
      limitInputPixels: REFERENCE_MAX_INPUT_PIXELS,
      failOn: "error",
      animated: false,
    })
      .timeout({ seconds: 10 })
      .rotate()
      .resize(w, Math.max(1, Math.round(w / target.aspect)), {
        fit: "cover",
        position: "centre",
      })
      .webp({ quality })
      .toBuffer({ resolveWithObject: true });
    return data.byteLength <= byteLimit ? { data, info } : null;
  };
  const floor = QUALITIES[QUALITIES.length - 1];
  try {
    for (;;) {
      // The lowest quality first: if even that is too big, this size cannot
      // fit and the image shrinks straight away instead of trying six more.
      const lowest = await encode(width, floor);
      if (lowest) {
        let best = lowest;
        for (const quality of QUALITIES.slice(0, -1)) {
          const attempt = await encode(width, quality);
          if (attempt) {
            best = attempt;
            break;
          }
        }
        return {
          ok: true,
          value: {
            bytes: best.data,
            mediaType: "image/webp",
            width: best.info.width,
            height: best.info.height,
            sha256: createHash("sha256").update(best.data).digest("hex"),
            originalMediaType: opened.originalMediaType,
            originalByteSize: input.byteLength,
          },
        };
      }
      if (width === SLOT_IMAGE_MIN_WIDTH) {
        return { ok: false, code: "too_detailed" };
      }
      width = Math.max(SLOT_IMAGE_MIN_WIDTH, Math.floor(width * SHRINK));
    }
  } catch (error) {
    return { ok: false, code: rejectionFor(error) };
  }
}

async function loadVersion(projectId: string, versionId: string) {
  if (!isUuid(projectId) || !isUuid(versionId)) return null;
  const [row] = await withService((db) =>
    db
      .select({
        id: themeStudioVersions.id,
        versionNumber: themeStudioVersions.versionNumber,
        packageJson: themeStudioVersions.packageJson,
        packageDigest: themeStudioVersions.packageDigest,
      })
      .from(themeStudioVersions)
      .where(
        and(
          eq(themeStudioVersions.id, versionId),
          eq(themeStudioVersions.projectId, projectId),
        ),
      )
      .limit(1),
  );
  if (!row?.packageJson || !row.packageDigest) return null;
  const parsed = validateThemePackageV2(row.packageJson);
  return parsed.ok
    ? {
        id: row.id,
        versionNumber: row.versionNumber,
        packageDigest: row.packageDigest,
        pkg: parsed.value,
      }
    : null;
}

/** What an upload for one slot must become. */
export async function slotUploadTarget(
  projectId: string,
  versionId: string,
  slotId: string,
): Promise<{
  slot: SlotDescriptor;
  target: { width: number; height: number; aspect: number };
  byteLimit: number;
} | null> {
  const version = await loadVersion(projectId, versionId);
  if (!version) return null;
  const slot = describeSlots(version.pkg).find((s) => s.id === slotId);
  const target = slot ? slotTargetSize(slot) : null;
  if (!slot || !target) return null;
  return { slot, target, byteLimit: slotByteLimit(slot) };
}

const EDITABLE_STATES: readonly string[] = ["ready", "candidate"];

/** Store one prepared upload as an `image` asset of the project. */
export async function storeThemeStudioSlotImage(
  actor: ThemeStudioActor,
  input: { projectId: string; slotId: string; image: PreparedSlotImage },
): Promise<{ id: string; duplicate: boolean }> {
  return withService(async (db) => {
    const [project] = await db
      .select({
        id: themeStudioProjects.id,
        status: themeStudioProjects.status,
      })
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, input.projectId))
      .for("update")
      .limit(1);
    if (!project) {
      throw new ThemeStudioError("not_found", "That project no longer exists.");
    }
    if (!EDITABLE_STATES.includes(project.status)) {
      throw new ThemeStudioError(
        "illegal_state",
        "Images can be changed only while the project is ready or a candidate.",
      );
    }
    const [existing] = await db
      .select({ id: themeStudioAssets.id, purpose: themeStudioAssets.purpose })
      .from(themeStudioAssets)
      .where(
        and(
          eq(themeStudioAssets.projectId, project.id),
          eq(themeStudioAssets.sha256, input.image.sha256),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.purpose !== "image") {
        throw new ThemeStudioError(
          "invalid_input",
          "That image is already stored for another purpose.",
        );
      }
      return { id: existing.id, duplicate: true };
    }
    const [{ n }] = await db
      .select({ n: count() })
      .from(themeStudioAssets)
      .where(
        and(
          eq(themeStudioAssets.projectId, project.id),
          eq(themeStudioAssets.purpose, "image"),
        ),
      );
    if (Number(n) >= THEME_STUDIO_LIMITS.slotImagesPerProject) {
      throw new ThemeStudioError(
        "limit",
        `A project can hold at most ${THEME_STUDIO_LIMITS.slotImagesPerProject} uploaded images.`,
      );
    }
    const [asset] = await db
      .insert(themeStudioAssets)
      .values({
        projectId: project.id,
        purpose: "image",
        mediaType: input.image.mediaType,
        bytes: input.image.bytes,
        byteSize: input.image.bytes.byteLength,
        width: input.image.width,
        height: input.image.height,
        sha256: input.image.sha256,
        originalMediaType: input.image.originalMediaType,
        originalByteSize: input.image.originalByteSize,
        createdBy: actor.id,
      })
      .returning({ id: themeStudioAssets.id });
    await recordThemeStudioEvent(db, {
      projectId: project.id,
      actor,
      eventType: "slot_image_uploaded",
      detail: {
        assetId: asset.id,
        slotId: input.slotId,
        width: input.image.width,
        height: input.image.height,
        bytes: input.image.bytes.byteLength,
      },
    });
    return { id: asset.id, duplicate: false };
  });
}

/**
 * Save staged replacements as ONE new version whose parent is the version
 * edited. The new version becomes current; a candidate returns to `ready`
 * because its acceptance evidence covered different images.
 */
export async function replaceThemeStudioSlotImages(
  actor: ThemeStudioActor,
  input: {
    projectId: string;
    versionId: string;
    expectedRevision: number;
    expectedPackageDigest: string;
    replacements: unknown;
  },
): Promise<{ versionId: string; versionNumber: number }> {
  if (!isUuid(input.projectId) || !isUuid(input.versionId)) {
    throw new ThemeStudioError("not_found", "That version no longer exists.");
  }
  const parsed = validateSlotReplacements(input.replacements);
  if (!parsed.ok) throw new ThemeStudioError("invalid_input", parsed.error);
  const replacements = parsed.value;

  return withService(async (db) => {
    const [project] = await db
      .select()
      .from(themeStudioProjects)
      .where(eq(themeStudioProjects.id, input.projectId))
      .for("update")
      .limit(1);
    if (!project) {
      throw new ThemeStudioError("not_found", "That project no longer exists.");
    }
    if (project.revision !== input.expectedRevision) {
      throw new ThemeStudioError(
        "stale",
        "This project changed in another tab. Reload to see it.",
      );
    }
    if (!EDITABLE_STATES.includes(project.status)) {
      throw new ThemeStudioError(
        "illegal_state",
        project.status === "generating"
          ? "Wait for the active run to finish before changing images."
          : "Images can be changed only while the project is ready or a candidate.",
      );
    }
    const [base] = await db
      .select()
      .from(themeStudioVersions)
      .where(
        and(
          eq(themeStudioVersions.id, input.versionId),
          eq(themeStudioVersions.projectId, project.id),
        ),
      )
      .limit(1);
    if (!base?.packageJson || !base.packageDigest) {
      throw new ThemeStudioError("not_found", "That version has no theme.");
    }
    if (base.packageDigest !== input.expectedPackageDigest) {
      throw new ThemeStudioError(
        "stale",
        "That version is not the one you were editing. Reload to see it.",
      );
    }
    const basePkg = validateThemePackageV2(base.packageJson);
    if (!basePkg.ok) {
      throw new ThemeStudioError(
        "illegal_state",
        "That version no longer passes its contract, so it can't be edited.",
      );
    }
    const rows = await db
      .select({
        id: themeStudioAssets.id,
        purpose: themeStudioAssets.purpose,
        sha256: themeStudioAssets.sha256,
        width: themeStudioAssets.width,
        height: themeStudioAssets.height,
      })
      .from(themeStudioAssets)
      .where(
        and(
          eq(themeStudioAssets.projectId, project.id),
          inArray(
            themeStudioAssets.id,
            replacements.map((r) => r.assetId),
          ),
        ),
      );
    const [{ latest }] = await db
      .select({ latest: max(themeStudioVersions.versionNumber) })
      .from(themeStudioVersions)
      .where(eq(themeStudioVersions.projectId, project.id));
    const versionNumber = (latest ?? 0) + 1;
    const applied = applySlotReplacements(
      basePkg.value,
      replacements,
      new Map<string, SlotImageRow>(rows.map((row) => [row.id, row])),
      versionNumber,
    );
    if (!applied.ok) throw new ThemeStudioError("invalid_input", applied.error);

    const [version] = await db
      .insert(themeStudioVersions)
      .values({
        projectId: project.id,
        runId: null,
        origin: "asset_edit",
        editDetail: {
          fromVersionId: base.id,
          slots: replacements.map((r) => r.slotId),
        },
        parentVersionId: base.id,
        versionNumber,
        intentJson: base.intentJson,
        intentDigest: base.intentDigest,
        packageJson: applied.value,
        packageDigest: digestThemeStudioJson(applied.value),
      })
      .returning({ id: themeStudioVersions.id });
    await db
      .update(themeStudioProjects)
      .set({
        status: "ready",
        currentVersionId: version.id,
        revision: sql`${themeStudioProjects.revision} + 1`,
      })
      .where(eq(themeStudioProjects.id, project.id));
    await recordThemeStudioEvent(db, {
      projectId: project.id,
      actor,
      eventType: "slot_images_replaced",
      detail: {
        versionId: version.id,
        versionNumber,
        fromVersionId: base.id,
        slots: replacements.map((r) => r.slotId),
        previousStatus: project.status,
      },
    });
    return { versionId: version.id, versionNumber };
  });
}

export interface ThemeStudioSlotView extends SlotDescriptor {
  /** Where the slot's current image is served, or null if it has no bytes. */
  url: string | null;
}

/** Every slot of a version with a link to its current image. */
export async function listThemeStudioSlots(
  projectId: string,
  versionId: string,
): Promise<{
  versionNumber: number;
  packageDigest: string;
  slots: ThemeStudioSlotView[];
} | null> {
  const version = await loadVersion(projectId, versionId);
  if (!version) return null;
  const slots = describeSlots(version.pkg);
  const urls = await slotImageUrls(projectId, version.pkg);
  return {
    versionNumber: version.versionNumber,
    packageDigest: version.packageDigest,
    slots: slots.map((slot) => ({ ...slot, url: urls.get(slot.id) ?? null })),
  };
}

/** Where each slot's current bytes are served (preview.ts owns the mapping,
 * so a preview store and this screen can never disagree). */
async function slotImageUrls(
  projectId: string,
  pkg: ThemePackageV2,
): Promise<Map<string, string>> {
  return withService((db) => slotUrls(db, projectId, pkg));
}
