import { isAllowedProviderVersion } from "./models";

// ---------------------------------------------------------------------------
// The one image model Theme Studio may call.
//
// ★★ THE PRO IMAGE MODEL (2026-09-29, owner: "highest capacity, no limitation
// in terms of cost"). Theme Studio used gemini-3.1-flash-image, the model
// merchant Mink calls; it now uses gemini-3-pro-image, Google's GA Pro image
// model, which follows long briefs and reference images more closely.
// Verified live on the Vertex global endpoint in storemink-prod with this
// client's exact configuration (four harm filters at BLOCK_LOW_AND_ABOVE,
// ALLOW_NONE people, prominent people blocked, 2K, JPEG q95) plus an inline
// ANCHOR reference: finishReason STOP, a 1856×2304 4:5 JPEG in 26.4 s, 1,120
// output tokens. Mink keeps its own model; this client is not Mink's.
//
// ★ An override may pin a published VERSION of the same model and nothing else
// (the text registry's rule): "gemini-3.1-flash-image" is a different,
// cheaper model, and silently substituting it is what the allowlist forbids.
// ---------------------------------------------------------------------------

export const THEME_STUDIO_IMAGE_MODEL_KEY = "gemini-3-pro-image";

export type ThemeStudioImageModelKey = typeof THEME_STUDIO_IMAGE_MODEL_KEY;

export interface ThemeStudioImageConfig {
  projectId: string;
  location: string;
  modelKey: ThemeStudioImageModelKey;
  /** The provider id actually sent: the key, or an allowed version of it. */
  providerModel: string;
}

/** Null when no Google Cloud project is configured (the offline fake runs). */
export function getThemeStudioImageConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ThemeStudioImageConfig | null {
  const projectId =
    env.THEME_STUDIO_GCP_PROJECT_ID?.trim() || env.GCP_PROJECT_ID?.trim();
  if (!projectId) return null;
  const override = env.THEME_STUDIO_IMAGE_MODEL?.trim();
  if (
    override &&
    !isAllowedProviderVersion(THEME_STUDIO_IMAGE_MODEL_KEY, override)
  ) {
    throw new Error(
      `THEME_STUDIO_IMAGE_MODEL must stay within the ${THEME_STUDIO_IMAGE_MODEL_KEY} model family.`,
    );
  }
  return {
    projectId,
    location: env.THEME_STUDIO_IMAGE_LOCATION?.trim() || "global",
    modelKey: THEME_STUDIO_IMAGE_MODEL_KEY,
    providerModel: override || THEME_STUDIO_IMAGE_MODEL_KEY,
  };
}
