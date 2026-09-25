// ---------------------------------------------------------------------------
// Which text colour reads on the photo behind it. Pure, so the decision is
// tested without a browser; `media-tone.tsx` measures the pixels and applies
// the answer.
//
// ★ A section's text colour ("dark" or "light") is chosen once, but the photo
//   under the words is different on every slide and at every crop, so no
//   single choice is right for every image. This keeps the merchant's choice
//   whenever it reads, switches to the other colour when only that one reads,
//   and asks for a soft edge scrim only when neither does (a busy photo).
// ★ WORST CASE, NOT AVERAGE. A heading half over a black boot and half over a
//   white wall averages to mid-grey, where both colours "pass" and half the
//   words vanish. Dark text is judged against the darkest tenth of the pixels
//   behind it, light text against the brightest tenth.
// ---------------------------------------------------------------------------

export type Tone = "dark" | "light";

/** WCAG AA for body text. The subheading is body-sized, so it sets the bar. */
export const MIN_CONTRAST = 4.5;

/** The share of pixels allowed to fall below the bar (glyph edges, specks). */
export const TAIL = 0.1;

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB colour, 0 (black) to 1 (white). */
export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** `#rgb`, `#rrggbb` or `rgb()/rgba()` → luminance, or null if unreadable. */
export function colorLuminance(value: string): number | null {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (hex) {
    const h =
      hex[1].length === 3
        ? hex[1]
            .split("")
            .map((c) => c + c)
            .join("")
        : hex[1];
    return relativeLuminance(
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    );
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(v);
  if (rgb) return relativeLuminance(+rgb[1], +rgb[2], +rgb[3]);
  return null;
}

/** The value at fraction `p` of the sorted samples. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * sorted.length)),
  );
  return sorted[i];
}

export interface ToneDecision {
  tone: Tone;
  /** Neither colour reads everywhere: add the soft edge scrim. */
  scrim: boolean;
}

/**
 * Pick the text colour for copy over `lumas` (the luminance of every sampled
 * pixel behind the words). `ink` and `onInk` are the luminances of the
 * theme's dark and light text colours.
 */
export function chooseTone(
  lumas: readonly number[],
  preferred: Tone,
  ink: number,
  onInk: number,
): ToneDecision {
  if (lumas.length === 0) return { tone: preferred, scrim: false };
  const sorted = [...lumas].sort((a, b) => a - b);
  const worst: Record<Tone, number> = {
    dark: contrastRatio(ink, percentile(sorted, TAIL)),
    light: contrastRatio(onInk, percentile(sorted, 1 - TAIL)),
  };
  const other: Tone = preferred === "dark" ? "light" : "dark";
  if (worst[preferred] >= MIN_CONTRAST)
    return { tone: preferred, scrim: false };
  if (worst[other] >= MIN_CONTRAST) return { tone: other, scrim: false };
  // Neither reads everywhere. Keep whichever reads better, and let the scrim
  // do the rest; ties keep the merchant's choice.
  return {
    tone: worst[other] > worst[preferred] ? other : preferred,
    scrim: true,
  };
}
