import "server-only";

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Sharp } from "sharp";
import { can } from "@/app/dashboard/lib/permissions";
import { mediaAssets } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError } from "@/lib/observability/logger";
import {
  gcsDeletePaths,
  gcsDownloadObject,
  gcsPathFromUrl,
  gcsUploadObject,
} from "@/lib/storage/gcs";
import { MinkRequestError, MinkToolInputError } from "./errors";
import { resolveMinkMediaReferenceImages } from "./media-reference-images";
import type { MinkActorContext } from "./types";

// ---------------------------------------------------------------------------
// Destination-safe derivatives for authentic merchant images.
//
// ★ THIS IS NOT GENERATION. A product photo supplied by the merchant must stay
// the same photograph. The preparation step only auto-orients it and places the
// complete source inside a destination-shaped canvas. It never crops through a
// product, invents pixels with a model, adds words, or overwrites the original.
// ---------------------------------------------------------------------------

export type MinkPreparedImageDestination = "product_photo" | "blog_cover";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const PREPARATION_VERSION = 1;
const DESTINATIONS: Record<
  MinkPreparedImageDestination,
  { width: number; height: number; label: string }
> = {
  product_photo: { width: 1_200, height: 1_200, label: "Product photo" },
  blog_cover: { width: 1_600, height: 900, label: "Blog cover" },
};

type SharpFactory = (input: Uint8Array | Buffer) => Sharp;
let sharpFactory: SharpFactory | null = null;

async function loadSharp(): Promise<SharpFactory> {
  if (sharpFactory) return sharpFactory;
  try {
    const mod = await import("sharp");
    sharpFactory = mod.default as unknown as SharpFactory;
    return sharpFactory;
  } catch (error) {
    logError("mink image preparation unavailable", error);
    throw new MinkRequestError(
      "image_preparation_unavailable",
      "Image preparation is unavailable on the server. Try again later.",
      503,
    );
  }
}

export interface MinkPreparedImageResult {
  url: string;
  prepared: boolean;
  aspectRatio: "1:1" | "16:9";
}

/**
 * Resolve one exact current-store image and make a reusable derivative only
 * when its orientation-corrected dimensions do not already match the target.
 */
export async function prepareMinkImageForDestination(
  actor: MinkActorContext,
  sourceUrl: string,
  destination: MinkPreparedImageDestination,
): Promise<MinkPreparedImageResult> {
  const [reference] = await resolveMinkMediaReferenceImages(actor, [sourceUrl]);
  if (!reference) {
    throw new MinkToolInputError(
      "The image is not an accessible current-store Media, product, or category image.",
    );
  }
  const sourcePath = gcsPathFromUrl(reference.url);
  if (!sourcePath) {
    throw new MinkToolInputError(
      "The selected image is not a supported StoreMink image.",
    );
  }

  const spec = DESTINATIONS[destination];
  const digest = createHash("sha256")
    .update(
      `${PREPARATION_VERSION}\n${actor.storeId}\n${destination}\n${sourceUrl}`,
    )
    .digest("hex");
  const path = `stores/${actor.storeId}/media/mink-prepared/${destination}-${digest}.webp`;
  const existing = await withService((db) =>
    db
      .select({ url: mediaAssets.url })
      .from(mediaAssets)
      .where(
        and(eq(mediaAssets.storeId, actor.storeId), eq(mediaAssets.path, path)),
      )
      .limit(1),
  );
  if (existing[0]?.url) {
    return {
      url: existing[0].url,
      prepared: true,
      aspectRatio: destination === "product_photo" ? "1:1" : "16:9",
    };
  }

  let source: Uint8Array;
  try {
    source = await gcsDownloadObject(sourcePath, MAX_SOURCE_BYTES);
  } catch (error) {
    logError("mink source image download failed", error, {
      destination,
      sourcePath,
      storeId: actor.storeId,
    });
    throw new MinkRequestError(
      "image_preparation_source_failed",
      "The selected image could not be prepared. Choose another image and try again.",
      422,
    );
  }

  const rendered = await renderMinkImageForDestination(source, destination);
  if (!rendered) {
    return {
      url: sourceUrl,
      prepared: false,
      aspectRatio: destination === "product_photo" ? "1:1" : "16:9",
    };
  }

  if (!can(actor.permissions, "media", "manage", actor.isSuperadmin)) {
    throw new MinkToolInputError(
      `The selected image needs ${spec.label.toLowerCase()} preparation. Media manage permission is required to save the correctly shaped copy.`,
    );
  }

  let url: string;
  try {
    url = await gcsUploadObject(path, rendered, "image/webp");
  } catch (error) {
    logError("mink prepared image upload failed", error, {
      destination,
      path,
      storeId: actor.storeId,
    });
    throw new MinkRequestError(
      "image_preparation_storage_failed",
      "The image was prepared but could not be stored. Try again.",
      503,
    );
  }

  try {
    await withService((db) =>
      db.insert(mediaAssets).values({
        storeId: actor.storeId,
        url,
        path,
        filename: `${destination}-${digest.slice(0, 12)}.webp`,
        contentType: "image/webp",
        sizeBytes: rendered.length,
        createdBy: actor.adminId,
      }),
    );
  } catch (error) {
    await gcsDeletePaths([path]).catch(() => []);
    logError("mink prepared image media save failed", error, {
      destination,
      path,
      storeId: actor.storeId,
    });
    throw new MinkRequestError(
      "image_preparation_media_save_failed",
      "The correctly shaped image could not be saved to Media. Try again.",
      503,
    );
  }

  return {
    url,
    prepared: true,
    aspectRatio: destination === "product_photo" ? "1:1" : "16:9",
  };
}

/**
 * Return null when the source already has the exact destination ratio.
 * Otherwise return a WebP canvas that keeps every source pixel visible.
 */
export async function renderMinkImageForDestination(
  source: Uint8Array,
  destination: MinkPreparedImageDestination,
): Promise<Uint8Array | null> {
  const sharp = await loadSharp();
  let oriented: Buffer;
  let width: number;
  let height: number;
  try {
    const normalized = await sharp(source)
      .rotate()
      .toBuffer({ resolveWithObject: true });
    oriented = normalized.data;
    width = normalized.info.width;
    height = normalized.info.height;
  } catch (error) {
    throw new MinkToolInputError(
      `The selected image could not be decoded: ${error instanceof Error ? error.message : "invalid image"}.`,
    );
  }
  if (!width || !height) {
    throw new MinkToolInputError(
      "The selected image has no usable dimensions.",
    );
  }

  const spec = DESTINATIONS[destination];
  const currentRatio = width / height;
  const targetRatio = spec.width / spec.height;
  if (Math.abs(currentRatio - targetRatio) <= 0.002) return null;

  if (destination === "product_photo") {
    const output = await sharp(oriented)
      .resize(spec.width, spec.height, {
        fit: "contain",
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .flatten({ background: "#ffffff" })
      .webp({ quality: 92, effort: 5 })
      .toBuffer();
    return new Uint8Array(output);
  }

  const background = await sharp(oriented)
    .resize(spec.width, spec.height, { fit: "cover" })
    .blur(28)
    .modulate({ brightness: 0.72, saturation: 0.9 })
    .toBuffer();
  const foreground = await sharp(oriented)
    .resize(Math.round(spec.width * 0.9), Math.round(spec.height * 0.9), {
      fit: "inside",
    })
    .toBuffer();
  const output = await sharp(background)
    .composite([{ input: foreground, gravity: "centre" }])
    .webp({ quality: 92, effort: 5 })
    .toBuffer();
  return new Uint8Array(output);
}
