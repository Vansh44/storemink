import "server-only";

import { createHash } from "node:crypto";
import type { Sharp, SharpOptions } from "sharp";
import { THEME_STUDIO_LIMITS } from "./contracts";

// ---------------------------------------------------------------------------
// Reference-image sanitization. A reference is untrusted: it may be a
// decompression bomb, an SVG/HTML polyglot, an animated file, or a photo
// carrying GPS in its EXIF. So nothing about the upload is trusted — not the
// Content-Type, not a filename — and the bytes that are STORED are never the
// bytes that were sent: every accepted image is decoded and re-encoded, which
// strips metadata and any trailing payload.
//
// ★ The format is decided by MAGIC BYTES and then cross-checked against what
// the decoder says it decoded. A PNG header on a JPEG body, or an AVIF image
// SEQUENCE (animated) under an AVIF brand, is refused rather than coerced.
// ---------------------------------------------------------------------------

export const REFERENCE_MAX_INPUT_PIXELS = 40_000_000;
export const REFERENCE_OUTPUT_MAX_EDGE = 2048;
const REFERENCE_WEBP_QUALITY = 85;

export type ReferenceMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/avif";

export type ReferenceRejection =
  | "empty"
  | "too_large"
  | "unsupported_format"
  | "format_mismatch"
  | "animated"
  | "too_many_pixels"
  | "decode_failed"
  | "processor_unavailable";

export const REFERENCE_REJECTION_MESSAGES: Record<ReferenceRejection, string> =
  {
    empty: "The file is empty.",
    too_large: `Each reference must be at most ${THEME_STUDIO_LIMITS.referenceImageBytes / 1024 / 1024} MB.`,
    unsupported_format: "Use a JPEG, PNG, WebP or AVIF image.",
    format_mismatch: "The file's contents don't match an allowed image format.",
    animated: "Animated images aren't accepted. Upload a still screenshot.",
    too_many_pixels: "The image is too large to process. Resize it first.",
    decode_failed: "The image couldn't be read. It may be damaged.",
    processor_unavailable:
      "Image processing is unavailable on the server. Try again later.",
  };

export interface SanitizedReference {
  bytes: Buffer;
  mediaType: "image/webp";
  width: number;
  height: number;
  sha256: string;
  originalMediaType: ReferenceMediaType;
  originalByteSize: number;
}

export type SanitizeReferenceResult =
  | { ok: true; value: SanitizedReference }
  | { ok: false; code: ReferenceRejection };

/** Identify an allowed raster format from its leading bytes only. */
export function sniffReferenceFormat(
  bytes: Uint8Array,
): ReferenceMediaType | "avif_sequence" | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    b.length >= 8 &&
    b
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "image/png";
  }
  if (
    b.length >= 12 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp") {
    const brand = b.toString("ascii", 8, 12);
    if (brand === "avif") return "image/avif";
    if (brand === "avis") return "avif_sequence";
  }
  return null;
}

// What sharp's metadata().format reports for each accepted input.
const DECODED_FORMAT: Record<ReferenceMediaType, string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "heif",
};

export type SharpWithOptions = (input: Buffer, options?: SharpOptions) => Sharp;
let sharpFactory: SharpWithOptions | null = null;

// Lazy for lib/storage/process-image.ts's reason: a missing native library must
// be a legible refusal, not a module-load failure no route can catch.
export async function loadSharp(): Promise<SharpWithOptions | null> {
  if (sharpFactory) return sharpFactory;
  try {
    const mod = await import("sharp");
    sharpFactory = mod.default as unknown as SharpWithOptions;
    return sharpFactory;
  } catch {
    return null;
  }
}

export type OpenedImage =
  | {
      ok: true;
      /** Decoded, NOT yet rotated or re-encoded. */
      source: Sharp;
      /** Dimensions as displayed, after EXIF orientation. */
      width: number;
      height: number;
      originalMediaType: ReferenceMediaType;
    }
  | { ok: false; code: ReferenceRejection };

/**
 * Decode an untrusted upload safely: size cap, format by magic bytes checked
 * against what the decoder decoded, one frame only, and a pixel ceiling. The
 * caller decides how to re-encode it — nothing it returns is ever stored as
 * sent. Shared by references and operator slot images.
 */
export async function openUntrustedImage(
  input: Uint8Array,
  maxBytes: number,
  loader: () => Promise<SharpWithOptions | null> = loadSharp,
): Promise<OpenedImage> {
  if (input.byteLength === 0) return { ok: false, code: "empty" };
  if (input.byteLength > maxBytes) return { ok: false, code: "too_large" };
  const sniffed = sniffReferenceFormat(input);
  if (sniffed === "avif_sequence") return { ok: false, code: "animated" };
  if (!sniffed) return { ok: false, code: "unsupported_format" };

  const sharp = await loader();
  if (!sharp) return { ok: false, code: "processor_unavailable" };

  const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  try {
    const source = sharp(buffer, {
      limitInputPixels: REFERENCE_MAX_INPUT_PIXELS,
      failOn: "error",
      animated: false,
    }).timeout({ seconds: 10 });
    const meta = await source.metadata();
    if (meta.format !== DECODED_FORMAT[sniffed]) {
      return { ok: false, code: "format_mismatch" };
    }
    if ((meta.pages ?? 1) !== 1) return { ok: false, code: "animated" };
    if (
      !meta.width ||
      !meta.height ||
      meta.width * meta.height > REFERENCE_MAX_INPUT_PIXELS
    ) {
      return { ok: false, code: "too_many_pixels" };
    }
    // EXIF orientations 5–8 rotate a quarter turn, swapping the axes.
    const swapped = (meta.orientation ?? 1) >= 5;
    return {
      ok: true,
      source,
      width: swapped ? meta.height : meta.width,
      height: swapped ? meta.width : meta.height,
      originalMediaType: sniffed,
    };
  } catch (error) {
    return { ok: false, code: rejectionFor(error) };
  }
}

/** Map a sharp failure to a refusal an operator can act on. */
export function rejectionFor(error: unknown): ReferenceRejection {
  const message = error instanceof Error ? error.message : "";
  return /pixel limit|exceeds pixel/i.test(message)
    ? "too_many_pixels"
    : "decode_failed";
}

export async function sanitizeReferenceImage(
  input: Uint8Array,
  loader: () => Promise<SharpWithOptions | null> = loadSharp,
): Promise<SanitizeReferenceResult> {
  const opened = await openUntrustedImage(
    input,
    THEME_STUDIO_LIMITS.referenceImageBytes,
    loader,
  );
  if (!opened.ok) return opened;
  try {
    const { data, info } = await opened.source
      .rotate()
      .resize(REFERENCE_OUTPUT_MAX_EDGE, REFERENCE_OUTPUT_MAX_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: REFERENCE_WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });

    return {
      ok: true,
      value: {
        bytes: data,
        mediaType: "image/webp",
        width: info.width,
        height: info.height,
        sha256: createHash("sha256").update(data).digest("hex"),
        originalMediaType: opened.originalMediaType,
        originalByteSize: input.byteLength,
      },
    };
  } catch (error) {
    return { ok: false, code: rejectionFor(error) };
  }
}
