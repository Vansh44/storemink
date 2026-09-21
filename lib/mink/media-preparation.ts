import "server-only";

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Sharp } from "sharp";
import { can } from "@/app/dashboard/lib/permissions";
import { mediaAssets } from "@/drizzle/schema";
import { withService } from "@/lib/db/client";
import { logError, logWarn } from "@/lib/observability/logger";
import {
  gcsDeletePaths,
  gcsDownloadObject,
  gcsPathFromUrl,
  gcsPublicUrl,
  gcsUploadObject,
} from "@/lib/storage/gcs";
import { MinkToolInputError } from "./errors";
import { readOwnedStorefrontImageUrls } from "./storefront-media-read";
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

/**
 * How much of the source a destination-shaped crop may discard before a padded
 * canvas is worth making.
 *
 * ★★ THE QUESTION IS "WHAT WOULD BE LOST", NOT "IS THE RATIO EXACT". This was
 *    a 0.002 tolerance on the ratio itself, which is far tighter than anything
 *    a generated image can be relied on to hit: CODEBASE records the image
 *    model rounding a requested 21:9 to 3168x1344 (2.357 against 2.333),
 *    because the request is honoured and the arithmetic is not. Under an exact
 *    test a 16:9 cover that came back at, say, 1.80 would be pushed through
 *    the blurred-letterbox treatment and downscaled from 2K - so the DEFAULT
 *    path, a freshly generated cover, would be the one degraded.
 *
 * ★ Six percent is chosen so a crop nobody can see costs nothing (1.80 against
 *   16:9 loses 1.2%) while the cases preparation exists for still qualify: a
 *   21:9 banner used as a cover loses 25%, and a portrait photograph on a
 *   square card loses 33% - straight through its subject.
 */
const MAX_TOLERATED_CROP = 0.06;
const PREPARATION_VERSION = 1;
const DESTINATIONS: Record<
  MinkPreparedImageDestination,
  { width: number; height: number; label: string }
> = {
  product_photo: { width: 1_200, height: 1_200, label: "Product photo" },
  blog_cover: { width: 1_600, height: 900, label: "Blog cover" },
};

/** The fraction of the source a centre crop to `targetRatio` would discard. */
function croppedAwayFraction(sourceRatio: number, targetRatio: number): number {
  if (!(sourceRatio > 0) || !(targetRatio > 0)) return 1;
  return sourceRatio > targetRatio
    ? 1 - targetRatio / sourceRatio
    : 1 - sourceRatio / targetRatio;
}

type SharpFactory = (input: Uint8Array | Buffer) => Sharp;
let sharpFactory: SharpFactory | null = null;

async function loadSharp(): Promise<SharpFactory> {
  if (sharpFactory) return sharpFactory;
  const mod = await import("sharp");
  sharpFactory = mod.default as unknown as SharpFactory;
  return sharpFactory;
}

export interface MinkPreparedImageResult {
  /** The URL the proposal should cite: a prepared copy, or the source. */
  url: string;
  /** True when `url` is a destination-shaped derivative rather than the source. */
  prepared: boolean;
  /**
   * The in-bucket path THIS call created, or null.
   *
   * ★ IT IS THE COMPENSATION HANDLE, and it is null on a cache hit as well as
   *   on a pass-through: a caller that fails afterwards must undo only what it
   *   caused, never a copy an earlier run made and a later one will reuse.
   */
  createdPath: string | null;
}

function unprepared(url: string): MinkPreparedImageResult {
  return { url, prepared: false, createdPath: null };
}

/**
 * Resolve one exact current-store image and make a destination-shaped copy
 * when the source would otherwise be cropped through its subject.
 *
 * ★★ PREPARATION IS BEST-EFFORT; OWNERSHIP IS NOT. The ONLY refusal here is an
 *    image the store does not own, because that is the one the caller can act
 *    on. Everything else - a legacy object outside our bucket, a format sharp
 *    will not decode, a download or upload that failed, an admin without Media
 *    manage - falls back to the source URL unchanged, which is exactly what
 *    every one of these calls did before preparation existed. Turning any of
 *    them into a hard failure would lose a whole blog or product proposal, and
 *    the credits already spent on its generated image, over a picture that
 *    merely renders in the wrong shape.
 *
 * ★★ AND OWNERSHIP ASKS THE SAME QUESTION THE APPROVAL LATER ASKS.
 *    `readOwnedStorefrontImageUrls` is what `assertOwnedCover` re-checks
 *    inside the publication transaction, so a cover accepted here cannot be
 *    refused there. Resolving it through the image-model reference path
 *    instead was strictly narrower - it additionally demanded a per-collection
 *    View permission, a PNG/JPEG/WebP content type and an object inside our
 *    GCS bucket - so a store still serving legacy Supabase-hosted media, or a
 *    GIF the Media Library deliberately stores pass-through, could no longer
 *    use its own catalogue photograph as a cover at all.
 */
export async function prepareMinkImageForDestination(
  actor: MinkActorContext,
  sourceUrl: string,
  destination: MinkPreparedImageDestination,
): Promise<MinkPreparedImageResult> {
  const owned = await readOwnedStorefrontImageUrls(actor.storeId, [sourceUrl]);
  if (!owned.has(sourceUrl)) {
    throw new MinkToolInputError(
      "That image is not one of this store's own Media Library, catalogue or category images.",
    );
  }

  // A legacy or externally hosted object cannot be read back, so there is
  // nothing to prepare from. The source is still the merchant's own image.
  const sourcePath = gcsPathFromUrl(sourceUrl);
  if (!sourcePath) return unprepared(sourceUrl);

  // ★ CHECKED BEFORE THE DOWNLOAD, because it needs no image data and the
  //   render costs real CPU. It is a pass-through rather than a refusal: an
  //   admin who may write a product but not manage Media asked for a product,
  //   not for a second Media Library row.
  if (!can(actor.permissions, "media", "manage", actor.isSuperadmin)) {
    return unprepared(sourceUrl);
  }

  const digest = createHash("sha256")
    .update(
      `${PREPARATION_VERSION}\n${actor.storeId}\n${destination}\n${sourceUrl}`,
    )
    .digest("hex");
  const path = `stores/${actor.storeId}/media/mink-prepared/${destination}-${digest}.webp`;

  const cached = await readPreparedImage(actor.storeId, path);
  if (cached) return { url: cached, prepared: true, createdPath: null };

  let source: Uint8Array;
  try {
    source = await gcsDownloadObject(sourcePath, MAX_SOURCE_BYTES);
  } catch (error) {
    logWarn("mink source image could not be read for preparation", {
      destination,
      storeId: actor.storeId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return unprepared(sourceUrl);
  }

  let rendered: Uint8Array | null;
  try {
    rendered = await renderMinkImageForDestination(source, destination);
  } catch (error) {
    // An undecodable or unsupported source (an animated GIF, an AVIF the
    // Media Library stores pass-through, a corrupt upload) is not a reason to
    // lose the proposal.
    logWarn("mink image could not be prepared", {
      destination,
      storeId: actor.storeId,
      error: error instanceof Error ? error.message : "unknown",
    });
    return unprepared(sourceUrl);
  }
  // Already close enough that the destination would crop only a sliver.
  if (!rendered) return unprepared(sourceUrl);

  try {
    await gcsUploadObject(path, rendered, "image/webp");
  } catch (error) {
    logError("mink prepared image upload failed", error, {
      destination,
      path,
      storeId: actor.storeId,
    });
    return unprepared(sourceUrl);
  }

  try {
    const saved = await recordPreparedImage(actor, {
      path,
      destination,
      digest,
      sizeBytes: rendered.length,
    });
    return saved;
  } catch (error) {
    await gcsDeletePaths([path]).catch(() => []);
    logError("mink prepared image media save failed", error, {
      destination,
      path,
      storeId: actor.storeId,
    });
    return unprepared(sourceUrl);
  }
}

function readPreparedImage(
  storeId: string,
  path: string,
): Promise<string | null> {
  return withService(async (db) => {
    const rows = await db
      .select({ url: mediaAssets.url })
      .from(mediaAssets)
      .where(and(eq(mediaAssets.storeId, storeId), eq(mediaAssets.path, path)))
      .limit(1);
    return rows[0]?.url ?? null;
  });
}

/**
 * Claim the one Media row for this derivative.
 *
 * ★★ THE ADVISORY LOCK IS WHAT MAKES IT EXACTLY ONE. `media_assets` has no
 *    unique index on (store_id, path), so a plain check-then-insert lets two
 *    concurrent runs both miss the cache and both write a row for the SAME
 *    object - and deleting either one afterwards removes the shared GCS file
 *    and leaves the other row rendering a broken image. Locking on the digest
 *    is cheaper than an index migration and needs no backfill of whatever
 *    duplicates already exist.
 *
 * ⚠ THE UPLOAD STAYS OUTSIDE IT. Holding a pooled connection open across a
 *   storage round-trip is the hazard `dunning.ts` and the layout readers both
 *   call out; the object path is deterministic, so a duplicated upload simply
 *   overwrites identical bytes.
 */
function recordPreparedImage(
  actor: MinkActorContext,
  input: {
    path: string;
    destination: MinkPreparedImageDestination;
    digest: string;
    sizeBytes: number;
  },
): Promise<MinkPreparedImageResult> {
  return withService(async (db) => {
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`mink-prepared-image:${actor.storeId}:${input.digest}`}, 0))`,
    );
    const existing = await db
      .select({ url: mediaAssets.url })
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.storeId, actor.storeId),
          eq(mediaAssets.path, input.path),
        ),
      )
      .limit(1);
    if (existing[0]?.url) {
      // Another run won the race and owns the row; this call created nothing
      // it may later undo.
      return { url: existing[0].url, prepared: true, createdPath: null };
    }
    const [inserted] = await db
      .insert(mediaAssets)
      .values({
        storeId: actor.storeId,
        url: gcsPublicUrl(input.path),
        path: input.path,
        filename: `${input.destination}-${input.digest.slice(0, 12)}.webp`,
        contentType: "image/webp",
        sizeBytes: input.sizeBytes,
        createdBy: actor.adminId,
      })
      .returning({ url: mediaAssets.url });
    return { url: inserted.url, prepared: true, createdPath: input.path };
  });
}

/**
 * Undo a derivative this run created after its caller failed.
 *
 * ★ ONLY WHAT THIS CALL MADE. `createdPath` is null for a cache hit and for a
 *   pass-through, so a failed proposal can never delete the merchant's own
 *   source image or a copy another run is still using.
 *
 * ⚠ BEST-EFFORT AND NEVER THROWS: it runs on a path that is already failing,
 *   and replacing that failure with a cleanup error would hide the real one.
 */
export async function discardPreparedMinkImage(
  actor: MinkActorContext,
  prepared: MinkPreparedImageResult,
): Promise<void> {
  const path = prepared.createdPath;
  if (!path) return;
  try {
    await withService((db) =>
      db
        .delete(mediaAssets)
        .where(
          and(
            eq(mediaAssets.storeId, actor.storeId),
            eq(mediaAssets.path, path),
          ),
        ),
    );
    await gcsDeletePaths([path]);
  } catch (error) {
    logWarn("mink prepared image could not be discarded", {
      path,
      storeId: actor.storeId,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

/**
 * Return null when the destination would crop only a sliver off the source.
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
  if (
    croppedAwayFraction(width / height, spec.width / spec.height) <=
    MAX_TOLERATED_CROP
  ) {
    return null;
  }

  if (destination === "product_photo") {
    const output = await sharp(oriented)
      .resize(spec.width, spec.height, {
        fit: "contain",
        // ★ The canvas is still the full destination size (verified against
        //   sharp): only the PHOTOGRAPH is left at its native scale, so a
        //   small authentic image is centred rather than interpolated up to
        //   three times its size and returned softer than it arrived.
        withoutEnlargement: true,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .flatten({ background: "#ffffff" })
      .webp({ quality: 92, effort: 5 })
      .toBuffer();
    return new Uint8Array(output);
  }

  const background = await sharp(oriented)
    // ⚠ This one still enlarges, deliberately: it is a blurred, darkened
    //   backdrop whose only job is to fill the canvas, and a gap would be
    //   worse than the softness nobody can see through a 28px blur.
    .resize(spec.width, spec.height, { fit: "cover" })
    .blur(28)
    .modulate({ brightness: 0.72, saturation: 0.9 })
    .toBuffer();
  const foreground = await sharp(oriented)
    .resize(Math.round(spec.width * 0.9), Math.round(spec.height * 0.9), {
      fit: "inside",
      withoutEnlargement: true,
    })
    .toBuffer();
  const output = await sharp(background)
    .composite([{ input: foreground, gravity: "centre" }])
    .webp({ quality: 92, effort: 5 })
    .toBuffer();
  return new Uint8Array(output);
}
