// Shared image ingest for uploads (the media library action + /api/upload).
// Validates type/size, then optimizes to WebP with sharp (small stored files,
// EXIF-rotated, metadata stripped). SVG is rasterized, never stored raw (a
// crafted SVG can carry <script> that runs on the storage origin). Server-only.

import type { Sharp } from "sharp";
import { logError } from "@/lib/observability/logger";

/**
 * Load sharp on first use rather than at module load.
 *
 * ★★ WHY LAZILY. `import sharp from "sharp"` at the top of this file made a
 * missing native library a MODULE-LOAD failure, which no try/catch in the
 * route could reach: /api/upload answered a bare framework "Internal Server
 * Error" with no JSON body and no useful log, in 6 ms, and the same fault took
 * out the OG-image proxy and Mink's image input with it. Observed on
 * production 2026-09-10:
 *
 *   Could not load the "sharp" module using the linux-x64 runtime
 *   ERR_DLOPEN_FAILED: libvips-cpp.so.8.18.3: cannot open shared object file
 *
 * sharp's `.node` binding dlopens `libvips-cpp.so` from a SIBLING package
 * (@img/sharp-libvips-linux-x64) at runtime, so Next's file tracing cannot see
 * it and left it out of `.next/standalone`. The packaging fix is in the
 * Dockerfile and next.config.ts; this makes the failure legible if it ever
 * recurs on a host nobody has thought about.
 */
type SharpFactory = (input: Uint8Array) => Sharp;

let sharpFactory: SharpFactory | null = null;
let sharpUnavailable: unknown = null;

async function loadSharp(): Promise<SharpFactory | null> {
  if (sharpFactory) return sharpFactory;
  if (sharpUnavailable) return null;
  try {
    const mod = await import("sharp");
    sharpFactory = mod.default as unknown as SharpFactory;
    return sharpFactory;
  } catch (err) {
    sharpUnavailable = err;
    return null;
  }
}

export const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/svg+xml",
];
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB (input cap)

// Re-encode to WebP at a sane width so a multi-MB upload stores as <200 KB.
const MAX_WIDTH = 1600;
const WEBP_QUALITY = 80;
// Already-efficient / animation-bearing formats are passed through untouched
// (re-encoding a GIF would drop the animation).
const PASS_THROUGH_TYPES = ["image/gif", "image/avif"];

export interface ProcessedImage {
  bytes: Uint8Array;
  contentType: string;
  ext: string;
}

export type ProcessImageResult =
  | { ok: true; data: ProcessedImage }
  | { ok: false; error: string; status: number };

/** Validate + optimize an uploaded image. Never throws — returns a typed result. */
export async function processImageUpload(
  file: File,
): Promise<ProcessImageResult> {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    return {
      ok: false,
      error: `Unsupported file type: ${file.type || "unknown"}.`,
      status: 400,
    };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 5 MB.`,
      status: 400,
    };
  }

  const original = new Uint8Array(await file.arrayBuffer());

  let bytes: Uint8Array = original;
  let contentType = file.type;
  let ext =
    file.name
      .split(".")
      .pop()
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, "") || "bin";

  if (!PASS_THROUGH_TYPES.includes(file.type)) {
    const sharpLib = await loadSharp();
    // ★★ A MISSING IMAGE PROCESSOR FAILS CLOSED, and is NOT the same failure as
    // "this one image would not optimize" below. That fallback stores the
    // original, which is right for one awkward file and wrong for a broken
    // install: every upload would keep its EXIF (a photo carries GPS) and skip
    // the SVG rasterisation this module exists to enforce, silently, for as
    // long as nobody noticed. Refusing with a message somebody can act on is
    // the safe direction.
    if (!sharpLib) {
      logError("image processing unavailable", sharpUnavailable, {
        type: file.type,
      });
      return {
        ok: false,
        error:
          "Image processing is unavailable on the server. Please contact support.",
        status: 503,
      };
    }
    try {
      const optimized = await sharpLib(original)
        .rotate() // honor EXIF orientation before stripping metadata
        .resize(MAX_WIDTH, undefined, { withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
      bytes = new Uint8Array(optimized);
      contentType = "image/webp";
      ext = "webp";
    } catch (e) {
      // An SVG sharp couldn't rasterize must NEVER be stored raw — that's the
      // payload we're guarding against.
      if (file.type === "image/svg+xml") {
        return {
          ok: false,
          error: "Could not process this SVG. Please upload a PNG or JPG.",
          status: 400,
        };
      }
      // One awkward file, not a broken install: keep the upload working and
      // say so loudly enough to be found in Error Reporting.
      logError("image optimization failed, storing original", e, {
        type: file.type,
      });
    }
  }

  return { ok: true, data: { bytes, contentType, ext } };
}
