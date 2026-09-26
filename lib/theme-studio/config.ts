import { parseThemeStudioModelKey, type ThemeStudioModelKey } from "./models";

// Theme Studio runtime switches. Server-only by content: nothing here is
// exposed to a browser, and nothing here is shared with merchant Mink
// (`MINK_AI_ENABLED` does not stop Theme Studio, and this does not stop Mink).

/** Providers a run may be queued against: the offline test provider, which
 * makes no network call and spends nothing, and Gemini models on Vertex. */
export const THEME_STUDIO_PROVIDERS = ["fake", "vertex-gemini"] as const;
export type ThemeStudioProvider = (typeof THEME_STUDIO_PROVIDERS)[number];

export const THEME_STUDIO_FAKE_PROMPT_VERSION = "theme-studio-fake-v1";

/** Default per-operator ceiling on ESTIMATED model spend in any 24 hours. */
const DEFAULT_DAILY_SPEND_USD = 25;

export interface ThemeStudioConfig {
  /** Global emergency stop for NEW generation. Viewing, cancelling and
   * archiving keep working, so an operator can still clean up. */
  generationEnabled: boolean;
  provider: ThemeStudioProvider | null;
  /** Models switched off by deployment, e.g. one not yet enabled in the
   * target Vertex project. Never silently replaced by another model. */
  disabledModels: ReadonlySet<ThemeStudioModelKey>;
  dailySpendMicroUsd: number;
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
  const disabledModels = new Set(
    (env.THEME_STUDIO_DISABLED_MODELS ?? "")
      .split(",")
      .map((key) => parseThemeStudioModelKey(key.trim()))
      .filter((key): key is ThemeStudioModelKey => key !== null),
  );
  const spend = Number(env.THEME_STUDIO_DAILY_SPEND_USD);
  return {
    generationEnabled:
      env.THEME_STUDIO_GENERATION_ENABLED?.trim().toLowerCase() !== "false",
    provider,
    disabledModels,
    dailySpendMicroUsd: Math.round(
      (Number.isFinite(spend) && spend >= 0 ? spend : DEFAULT_DAILY_SPEND_USD) *
        1_000_000,
    ),
  };
}

export function isImplementedProvider(
  provider: ThemeStudioProvider | null,
): provider is ThemeStudioProvider {
  return provider !== null;
}
