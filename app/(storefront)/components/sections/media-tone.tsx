"use client";

import { useEffect, useRef } from "react";
import {
  chooseTone,
  colorLuminance,
  relativeLuminance,
  type Tone,
  type ToneDecision,
} from "@/lib/storefront/media-tone";

// ---------------------------------------------------------------------------
// Keeps copy that sits on a photo readable, on every theme.
//
// Rendered INSIDE the section's root (the element carrying `theme-dark` /
// `theme-light`). Once the photo has loaded it looks at the pixels directly
// behind the words and applies `chooseTone`'s answer to the root: keep the
// section's text colour, switch it, or add `sm-scrim` (a soft gradient from
// the edge the copy sits against) when neither colour reads on a busy photo.
// Nothing is painted behind the words themselves.
//
// ★ It changes a CLASS the section already styles, so every theme's own
//   dark/light treatment (text, button, built-in scrim) comes along, and a
//   theme written later needs nothing.
// ★ It fails QUIET. No image, a video, a photo we are not allowed to read
//   (cross-origin), no canvas (jsdom, old browsers) — the section keeps the
//   colour the merchant chose, exactly as before this existed.
// ★ A merchant who has tuned the Overlay slider has taken control of the
//   image's tone, so `off` leaves their choice alone.
// ★ React re-renders the root with its configured class (the builder does on
//   every edit), so the decision is re-applied after every render, and
//   re-measured when the layout or the photo changes.
// ---------------------------------------------------------------------------

const SAMPLE_WIDTH = 240;
const THEMES = ["theme-dark", "theme-light"] as const;

const LUT = (() => {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) t[i] = relativeLuminance(i, 0, 0) / 0.2126;
  return t;
})();

function objectPosition(img: HTMLImageElement): [number, number] {
  const parts = getComputedStyle(img).objectPosition.split(/\s+/);
  const read = (p: string | undefined) =>
    p && p.endsWith("%") ? Math.min(1, Math.max(0, parseFloat(p) / 100)) : 0.5;
  return [read(parts[0]), read(parts[1])];
}

/** Luminance of every pixel behind the copy's text, or null if unreadable. */
function sample(img: HTMLImageElement, copy: HTMLElement) {
  const box = img.getBoundingClientRect();
  if (!box.width || !box.height || !img.naturalWidth) return null;
  const s = Math.min(1, SAMPLE_WIDTH / box.width);
  const w = Math.max(1, Math.round(box.width * s));
  const h = Math.max(1, Math.round(box.height * s));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  // Draw it the way `object-fit: cover` does, so we read what is on screen.
  const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  const [fx, fy] = objectPosition(img);
  let data: Uint8ClampedArray;
  try {
    ctx.drawImage(img, (w - dw) * fx, (h - dh) * fy, dw, dh);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null; // cross-origin photo: the browser will not let us read it
  }

  // The words, not the copy box's padding — and not the button, which
  // carries its own background.
  const blocks = Array.from(copy.children).filter(
    (el) =>
      !(el instanceof HTMLAnchorElement || el instanceof HTMLButtonElement),
  );
  const rects = (blocks.length ? blocks : [copy]).map((el) =>
    el.getBoundingClientRect(),
  );
  const lumas: number[] = [];
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor((r.left - box.left) * s));
    const x1 = Math.min(w, Math.ceil((r.right - box.left) * s));
    const y0 = Math.max(0, Math.floor((r.top - box.top) * s));
    const y1 = Math.min(h, Math.ceil((r.bottom - box.top) * s));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        lumas.push(
          0.2126 * LUT[data[i]] +
            0.7152 * LUT[data[i + 1]] +
            0.0722 * LUT[data[i + 2]],
        );
      }
    }
  }
  return lumas;
}

function tokenLuminance(root: HTMLElement, name: string, fallback: number) {
  return (
    colorLuminance(getComputedStyle(root).getPropertyValue(name)) ?? fallback
  );
}

export function MediaTone({
  preferred,
  copy,
  off = false,
}: {
  /** The section's configured text colour. */
  preferred: Tone;
  /** Selector for the copy block, inside the root. */
  copy: string;
  /** The merchant tuned the overlay: leave the tone alone. */
  off?: boolean;
}) {
  const marker = useRef<HTMLSpanElement>(null);
  const decision = useRef<ToneDecision | null>(null);

  const apply = () => {
    const root = marker.current?.parentElement;
    const d = decision.current;
    if (!root || !d) return;
    root.classList.remove(...THEMES);
    root.classList.add(`theme-${d.tone}`);
    root.classList.toggle("sm-scrim", d.scrim);
  };

  // After every render: React may have written the configured class back.
  useEffect(apply);

  useEffect(() => {
    const root = marker.current?.parentElement;
    if (!root || off) {
      decision.current = null;
      return;
    }
    const img = root.querySelector("img");
    const copyEl = root.querySelector<HTMLElement>(copy);
    if (!img || !copyEl) return;

    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!img.complete || !img.naturalWidth) return;
        const lumas = sample(img, copyEl);
        if (!lumas) return;
        decision.current = chooseTone(
          lumas,
          preferred,
          tokenLuminance(root, "--sm-ink", 0.02),
          tokenLuminance(root, "--sm-on-ink", 1),
        );
        apply();
      });
    };

    img.addEventListener("load", measure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(root);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      img.removeEventListener("load", measure);
      observer?.disconnect();
      // Hand the root back as the merchant configured it.
      decision.current = null;
      root.classList.remove("sm-scrim", ...THEMES);
      root.classList.add(`theme-${preferred}`);
    };
    // `apply` only reads refs, so it is not a dependency.
  }, [preferred, copy, off]);

  return <span ref={marker} hidden aria-hidden />;
}
