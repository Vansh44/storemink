import "server-only";

import { createHash } from "node:crypto";

// Server-generated placeholder imagery for a candidate's image slots.
//
// ★ Why these exist at all: a generated ThemePackageV2 must declare a SHA-256
// for every image it references (Phase 0), and the catalog preview and
// screenshots are required fields — but the models write text, and review
// screenshots don't exist until the acceptance phase. A plain colour field with
// a real digest lets a candidate be complete and honest about what it lacks.
//
// ★ They are never publishable. Each is stored with purpose `placeholder`, and
// its package entry carries PLACEHOLDER_LICENSE_NOTE (compiler.ts);
// publication must refuse any package still carrying one.

export interface PlaceholderImage {
  bytes: Buffer;
  sha256: string;
  width: number;
  height: number;
}

const RATIO_RE = /^(\d{1,3}):(\d{1,3})$/;
const LONG_EDGE = 1600;

/** Dimensions for an aspect ratio such as "16:9", long edge 1600 px. */
export function placeholderSize(aspectRatio: string): {
  width: number;
  height: number;
} {
  const match = RATIO_RE.exec(aspectRatio);
  const w = match ? Number(match[1]) : 4;
  const h = match ? Number(match[2]) : 3;
  if (!(w > 0) || !(h > 0)) return { width: 1600, height: 1200 };
  return w >= h
    ? { width: LONG_EDGE, height: Math.max(1, Math.round((LONG_EDGE * h) / w)) }
    : {
        width: Math.max(1, Math.round((LONG_EDGE * w) / h)),
        height: LONG_EDGE,
      };
}

const HEX6_RE = /^#([0-9a-f]{6})$/i;

export async function renderPlaceholder(
  size: { width: number; height: number },
  color: string,
): Promise<PlaceholderImage> {
  const sharp = (await import("sharp")).default;
  const fill = HEX6_RE.test(color) ? color : "#d9d4cc";
  const bytes = await sharp({
    create: {
      width: size.width,
      height: size.height,
      channels: 3,
      background: fill,
    },
  })
    .webp({ quality: 80 })
    .toBuffer();
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: size.width,
    height: size.height,
  };
}
