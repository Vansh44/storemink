// Theme Studio runtime switches. Server-only by content: nothing here is
// exposed to a browser, and nothing here is shared with merchant Mink
// (`MINK_AI_ENABLED` does not stop Theme Studio, and this does not stop Mink).

/** Providers a run may be queued against. Phase 2 ships only `fake`, which
 * makes no network call and spends nothing; Phase 3 adds `anthropic-vertex`.
 * The database CHECK already admits both so Phase 3 needs no migration. */
export const THEME_STUDIO_PROVIDERS = ["fake", "anthropic-vertex"] as const;
export type ThemeStudioProvider = (typeof THEME_STUDIO_PROVIDERS)[number];

/** Providers this build can actually execute. A queued run naming anything
 * else would sit forever, so queueing refuses it up front. */
const IMPLEMENTED_PROVIDERS: readonly ThemeStudioProvider[] = ["fake"];

export const THEME_STUDIO_FAKE_PROMPT_VERSION = "theme-studio-fake-v1";

export interface ThemeStudioConfig {
  /** Global emergency stop for NEW generation. Viewing, cancelling and
   * archiving keep working, so an operator can still clean up. */
  generationEnabled: boolean;
  provider: ThemeStudioProvider | null;
}

export function getThemeStudioConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ThemeStudioConfig {
  const rawProvider = (env.THEME_STUDIO_PROVIDER ?? "fake").trim();
  const provider = THEME_STUDIO_PROVIDERS.includes(
    rawProvider as ThemeStudioProvider,
  )
    ? (rawProvider as ThemeStudioProvider)
    : null;
  return {
    generationEnabled:
      env.THEME_STUDIO_GENERATION_ENABLED?.trim().toLowerCase() !== "false",
    provider,
  };
}

export function isImplementedProvider(
  provider: ThemeStudioProvider | null,
): provider is ThemeStudioProvider {
  return provider !== null && IMPLEMENTED_PROVIDERS.includes(provider);
}
