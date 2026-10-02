/** Optional diagnostic evidence, never an acceptance gate or a cache key. */
export interface CaptureTiming {
  browserMs: number;
  catalogMs: number;
  qaMs: number;
  samples: {
    viewport: string;
    surface: string;
    navigationMs: number;
    probeMs: number;
    screenshotMs: number;
  }[];
}
const object = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const ms = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 600_000;
export function parseCaptureTiming(v: unknown): CaptureTiming | null {
  if (
    !object(v) ||
    !ms(v.browserMs) ||
    !ms(v.catalogMs) ||
    !ms(v.qaMs) ||
    !Array.isArray(v.samples) ||
    v.samples.length > 30
  )
    return null;
  if (
    v.samples.some(
      (s) =>
        !object(s) ||
        typeof s.viewport !== "string" ||
        s.viewport.length > 32 ||
        typeof s.surface !== "string" ||
        s.surface.length > 32 ||
        !ms(s.navigationMs) ||
        !ms(s.probeMs) ||
        !ms(s.screenshotMs),
    )
  )
    return null;
  return {
    browserMs: v.browserMs,
    catalogMs: v.catalogMs,
    qaMs: v.qaMs,
    samples: v.samples.map((s) => ({
      viewport: s.viewport,
      surface: s.surface,
      navigationMs: s.navigationMs,
      probeMs: s.probeMs,
      screenshotMs: s.screenshotMs,
    })),
  };
}

export interface CapturedRoute {
  path: string;
  surface: string;
  status: number;
  html: string;
  robots: string;
}
export const MAX_CAPTURED_HTML_BYTES = 1024 * 1024;
/** Reuse only the initial HTML already fetched by this claim's real browser.
 * Bind it to the exact package/build/lease; older workers fall back to fresh
 * fetches. Nothing is cached across captures or mutable preview stores. */
export function parseCapturedRoutes(
  raw: unknown,
  pages: readonly { path: string; surface: string }[],
): CapturedRoute[] {
  if (!Array.isArray(raw) || raw.length > pages.length) return [];
  const suppliedPaths = raw.flatMap((r) =>
    object(r) && typeof r.path === "string" ? [r.path] : [],
  );
  // Ambiguous duplicate bodies cannot choose which response supplies evidence.
  // Fall back to the ordinary fetch path for the whole optional batch.
  if (new Set(suppliedPaths).size !== suppliedPaths.length) return [];
  const seen = new Set<string>();
  return raw
    .filter((r): r is CapturedRoute => {
      if (
        !object(r) ||
        typeof r.path !== "string" ||
        typeof r.surface !== "string" ||
        !pages.some((p) => p.path === r.path && p.surface === r.surface) ||
        seen.has(r.path) ||
        typeof r.status !== "number" ||
        ![200, 404].includes(r.status) ||
        typeof r.html !== "string" ||
        !r.html ||
        Buffer.byteLength(r.html) > MAX_CAPTURED_HTML_BYTES ||
        typeof r.robots !== "string" ||
        r.robots.length > 512
      )
        return false;
      seen.add(r.path);
      return true;
    })
    .map((r) => ({
      path: r.path,
      surface: r.surface,
      status: r.status,
      html: r.html,
      robots: r.robots,
    }));
}
