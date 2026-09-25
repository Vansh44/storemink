// ---------------------------------------------------------------------------
// Recognising a Theme Studio preview store. Pure and dependency-free, because
// the store resolver asks this of EVERY store it resolves and must not pull the
// Studio's server modules into the ordinary request path.
//
// ★ BOTH markers are required: `demo: true` and a well-formed `studioPreview`.
// `stores.settings` is written only by server code, but asking for both means
// a stray key on a real merchant's settings can never turn their storefront
// into something that 404s without a preview grant — the demo flag is what
// already makes a store refuse orders and stay out of search.
// ---------------------------------------------------------------------------

export const STUDIO_PREVIEW_SLUG_PREFIX = "studio-preview-";

export interface StudioPreviewMarker {
  projectId: string;
  versionId: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function studioPreviewMarker(
  settings: unknown,
): StudioPreviewMarker | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return null;
  }
  const record = settings as Record<string, unknown>;
  if (record.demo !== true) return null;
  const marker = record.studioPreview;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    return null;
  }
  const { projectId, versionId } = marker as Record<string, unknown>;
  return typeof projectId === "string" &&
    UUID_RE.test(projectId) &&
    typeof versionId === "string" &&
    UUID_RE.test(versionId)
    ? { projectId, versionId }
    : null;
}

/** A path the preview enter route may redirect to: same-origin and absolute,
 * never protocol-relative (`//evil.example`) or backslash-smuggled. */
export function isSafePreviewPath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length <= 512 &&
    /^\/(?![/\\])[^\s\\]*$/.test(path)
  );
}
