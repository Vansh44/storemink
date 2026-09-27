import { isAllowedProviderVersion } from "./models";

// ---------------------------------------------------------------------------
// The one image model Theme Studio may call.
//
// ★ THE MODEL MERCHANT MINK ALREADY CALLS, NOT A NEW ONE. gemini-3.1-flash-image
// on the Vertex global endpoint was verified live for Mink on 2026-09-21 with
// the same safety settings, people block, 2K size and wide aspect ratios this
// client sends (CODEBASE.md "Mink Phase 9E"). Theme Studio reuses the model and
// that evidence, but not Mink's client: Mink's is bound to a store, a merchant
// prompt and five fixed purposes.
//
// ★ An override may pin a published VERSION of the same model and nothing else
// (the text registry's rule): "gemini-3.1-flash-lite-image" is a different,
// cheaper model, and silently substituting it is what the allowlist forbids.
// ---------------------------------------------------------------------------

export const THEME_STUDIO_IMAGE_MODEL_KEY = "gemini-3.1-flash-image";

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
