import type { ProviderErrorCode } from "./provider";

// ---------------------------------------------------------------------------
// The seam between Theme Studio and an image model. The generation step speaks
// only this interface, so the offline fake and Gemini-on-Vertex go through the
// same crop, store and quality path.
//
// Pure: no provider SDK, no fs, no database.
// ---------------------------------------------------------------------------

/** Names the prompt document and request builder an image run used, recorded
 *  on the run like a text run's prompt version. Bump it with any change to
 *  docs/theme-studio-image-prompt.md or image-prompt.ts. */
export const THEME_STUDIO_IMAGE_PROMPT_VERSION = "theme-studio-image-v1";
export const THEME_STUDIO_IMAGE_FAKE_PROMPT_VERSION =
  "theme-studio-image-fake-v1";

/** The aspect ratios the image model accepts, and so the ones a request may
 *  ask for. Every Stage A brief ratio is one of them; a slot's exact ratio is
 *  reached afterwards by cropping (slot-images.ts prepareSlotImage). */
export const THEME_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;

export type ThemeImageAspectRatio = (typeof THEME_IMAGE_ASPECT_RATIOS)[number];

/**
 * What an image is for. `anchor` is the one art-direction reference generated
 * first for a theme, which every later image is asked to match; the rest follow
 * the package's asset kinds (compiler.ts assetKind). `preview` is absent: the
 * theme catalog card and screenshots are pictures of the storefront itself,
 * not art.
 */
export const THEME_IMAGE_PURPOSES = [
  "anchor",
  "hero",
  "product",
  "category",
  "content",
] as const;

export type ThemeImagePurpose = (typeof THEME_IMAGE_PURPOSES)[number];

/**
 * An earlier image sent with the request. `anchor` asks the model to match the
 * theme's light, palette and materials; `set` asks it to match an earlier
 * product shot's staging exactly, so a catalogue reads as one shoot.
 */
export interface ThemeImageReference {
  role: "anchor" | "set";
  mediaType: "image/webp" | "image/jpeg" | "image/png";
  base64: string;
}

export interface ThemeImageRequest {
  purpose: ThemeImagePurpose;
  /** The brief this image fills; "anchor" for the anchor. For logs only. */
  briefId: string;
  aspectRatio: ThemeImageAspectRatio;
  /** The fully rendered prompt (image-prompt.ts). */
  prompt: string;
  references: ThemeImageReference[];
}

export interface ImageUsage {
  inputTokens: number;
  /** Image (and the few text) tokens returned. */
  outputTokens: number;
}

export const ZERO_IMAGE_USAGE: ImageUsage = { inputTokens: 0, outputTokens: 0 };

export type ThemeImageResult =
  | {
      kind: "ok";
      bytes: Uint8Array;
      mediaType: "image/jpeg" | "image/png" | "image/webp";
      usage: ImageUsage;
    }
  /** The provider withheld the image on policy grounds: a normal outcome. */
  | { kind: "refused"; reason: string | null; usage: ImageUsage }
  | { kind: "error"; code: ProviderErrorCode; usage: ImageUsage };

export interface ThemeStudioImageClient {
  readonly provider: "fake" | "vertex-gemini";
  generateImage(
    request: ThemeImageRequest,
    signal: AbortSignal,
  ): Promise<ThemeImageResult>;
}

/** Bounds a request must stay inside: the model accepts at most a few
 *  reference images, and a prompt this long is a bug, not a brief. */
export const THEME_IMAGE_LIMITS = {
  maxReferences: 3,
  maxPromptChars: 12_000,
} as const;

/** Throws on a request the provider must never see. The builder only produces
 *  valid ones; this guards a hand-built request. */
export function assertThemeImageRequest(request: ThemeImageRequest): void {
  if (!(THEME_IMAGE_PURPOSES as readonly string[]).includes(request.purpose)) {
    throw new Error(`Unknown Theme Studio image purpose: ${request.purpose}`);
  }
  if (
    !(THEME_IMAGE_ASPECT_RATIOS as readonly string[]).includes(
      request.aspectRatio,
    )
  ) {
    throw new Error(`Unsupported image aspect ratio: ${request.aspectRatio}`);
  }
  if (!request.prompt.trim()) throw new Error("An image prompt is required.");
  if (request.prompt.length > THEME_IMAGE_LIMITS.maxPromptChars) {
    throw new Error("The image prompt is too long.");
  }
  if (request.references.length > THEME_IMAGE_LIMITS.maxReferences) {
    throw new Error("Too many reference images.");
  }
  if (request.purpose === "anchor" && request.references.length > 0) {
    throw new Error("The anchor is the first image; it has no references.");
  }
}

/** Parses "4:3" into width over height. */
export function aspectValue(ratio: string): number {
  const [w, h] = ratio.split(":").map(Number);
  return w > 0 && h > 0 ? w / h : Number.NaN;
}
