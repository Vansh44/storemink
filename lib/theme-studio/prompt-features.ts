/** Persisted versions keep their request shape. Future prompt revisions inherit
 * these introduced capabilities rather than silently reverting to legacy calls. */
export const THEME_STUDIO_PROMPT_VERSION = "theme-studio-v22";

export function themePromptFeatures(version: string) {
  const revision = Number(/^theme-studio-v(\d+)$/.exec(version)?.[1] ?? 0);
  return {
    targetedRepair: revision >= 19,
    nativeFraming: revision >= 19,
    nativeCommerce: revision >= 20,
    compactInitial: revision >= 20,
    variety: revision >= 21,
    stableAssetIds: revision >= 22,
  };
}
