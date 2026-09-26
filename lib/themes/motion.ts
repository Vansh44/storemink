// ---------------------------------------------------------------------------
// Restrained motion a theme may set: homepage and page sections that fade, or
// fade and rise a short way, as they scroll into view.
//
// ★ OPT-IN, AND ABSENT MEANS NO MOTION. A theme that sets nothing (or
// `reveal: "none"`) emits no class and the storefront mounts no observer.
//
// ★ NOTHING IS HIDDEN BY THE SERVER. Every section renders visible; after the
// page loads, ScrollReveal (app/(storefront)/components/scroll-reveal.tsx)
// marks only sections wholly BELOW the viewport as pending and reveals each as
// it arrives. So a page without JavaScript, a slow hydration, the first screen
// and the hero are never hidden — no flash, and nothing held back from the
// largest paint.
//
// ★ OPACITY AND TRANSFORM ONLY, so no layout moves (no layout shift), and the
// attribute is removed once a section has arrived so no transform lingers to
// trap a fixed-position child.
//
// Pure: the storefront layout, theme validation, the Theme Studio compiler and
// the tests all import this one file.
// ---------------------------------------------------------------------------

export const MOTION_REVEALS = ["none", "fade", "rise"] as const;

export type MotionReveal = (typeof MOTION_REVEALS)[number];

export interface ThemeMotion {
  /** "fade" fades sections in as they scroll into view; "rise" fades and
   *  lifts them a short way. "none" is the same as not setting it. */
  reveal?: MotionReveal;
}

/** The elements that reveal. Sections only — cards, headings and images
 *  moving individually is the busy kind of motion this is not. */
export const REVEAL_SELECTOR = ".home-section";

/** The event that reveals everything at once. Printing uses it, and the Theme
 *  Studio acceptance probe dispatches it before it measures. */
export const REVEAL_ALL_EVENT = "sm:reveal-all";

function pick<T extends string>(
  list: readonly T[],
  value: unknown,
): T | undefined {
  return typeof value === "string" &&
    (list as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Keep only the recognised settings. Unknown values are dropped, never
 *  guessed at; validation reports them separately. */
export function cleanMotion(raw: unknown): ThemeMotion {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const out: ThemeMotion = {};
  const reveal = pick(MOTION_REVEALS, r.reveal);
  if (reveal) out.reveal = reveal;
  return out;
}

/** Whether this theme reveals sections on scroll at all. */
export function revealsOnScroll(raw: ThemeMotion | undefined): boolean {
  const reveal = cleanMotion(raw).reveal;
  return reveal === "fade" || reveal === "rise";
}

/** Root classes: `sm-reveal` switches the pending/shown rules on, and
 *  `sm-reveal-rise` adds the lift. None when the theme reveals nothing. */
export function motionRootClasses(raw: ThemeMotion | undefined): string[] {
  const reveal = cleanMotion(raw).reveal;
  if (reveal === "fade") return ["sm-reveal"];
  if (reveal === "rise") return ["sm-reveal", "sm-reveal-rise"];
  return [];
}

/** Problems with a theme's motion settings, in words the Theme Studio repair
 *  loop and a reviewer can act on. */
export function motionIssues(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return ["motion must be an object."];
  }
  const issues: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key !== "reveal") {
      issues.push(`motion.${key} is not a motion setting.`);
    } else if (
      value !== undefined &&
      !(MOTION_REVEALS as readonly string[]).includes(String(value))
    ) {
      issues.push(
        `motion.reveal "${String(value)}" must be one of ${MOTION_REVEALS.join(", ")}.`,
      );
    }
  }
  return issues;
}
