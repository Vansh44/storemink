// Source-controlled theme releases and the synchronous bundled fallback.
// Runtime-aware server call sites use lib/themes/runtime-registry.ts, which
// resolves validated database releases before calling getThemeDefinition here.
// NEVER import this from a client component: definitions embed page, menu, and
// sample-catalog payloads. Client surfaces receive a ThemeMeta projection.
import { DEFAULT_THEME_ID, THEME_META } from "./meta";
import { basket } from "./definitions/basket";
import { ritual } from "./definitions/ritual";
import { studio } from "./definitions/studio";
import { vitrine } from "./definitions/vitrine";
import type { ThemeDefinition } from "./types";

/** Keep older immutable releases here when a preset version advances. */
export const THEME_DEFINITIONS: readonly ThemeDefinition[] = [
  basket,
  studio,
  ritual,
  vitrine,
];

const BY_RELEASE = new Map(
  THEME_DEFINITIONS.map((theme) => [
    `${theme.id}@${theme.release.version}`,
    theme,
  ]),
);

function currentRelease(id: string): ThemeDefinition | undefined {
  const meta = THEME_META.find((theme) => theme.id === id);
  return meta ? BY_RELEASE.get(`${id}@${meta.release.version}`) : undefined;
}

/** True only for a preset this build ships. A format-valid id that is in
 * neither this list nor the runtime registry (a retired preset such as the
 * old Arcade/Fresko placeholders, or any stray `template` value) must render
 * un-themed rather than be silently re-skinned as the platform default. */
export function isBundledThemeId(id: unknown): id is string {
  return typeof id === "string" && currentRelease(id) !== undefined;
}

/** Resolve an installed preset. A supplied version is honored when its
 * immutable definition remains registered. Missing/legacy versions fall back
 * to that preset's current release, then the platform default. */
export function getThemeDefinition(
  id: unknown,
  version?: unknown,
): ThemeDefinition {
  if (typeof id === "string") {
    if (typeof version === "string") {
      const pinned = BY_RELEASE.get(`${id}@${version}`);
      if (pinned) return pinned;
    }
    const current = currentRelease(id);
    if (current) return current;
  }
  const fallback = currentRelease(DEFAULT_THEME_ID);
  if (!fallback) {
    throw new Error(
      `Default theme release is not registered: ${DEFAULT_THEME_ID}`,
    );
  }
  return fallback;
}
