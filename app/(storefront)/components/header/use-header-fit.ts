"use client";

import { useLayoutEffect, type RefObject } from "react";
import {
  chooseCompaction,
  type CompactStep,
  type FitBox,
} from "@/lib/storefront/header-fit";

// Measures the live header and writes `data-header-compact` on it ("nav",
// "nav delivery", "nav delivery search", or nothing). Header.module.css and
// delivery-location.module.css fold those items into the drawer.
//
// ★ The attribute is written straight to the DOM, not rendered: the answer
//   depends on layout, which the server cannot know, and a React state round
//   trip would paint the overlapping header once before correcting it.
//   React never renders the attribute, so it never writes it back.
// ★ Every check starts from the full header. Measuring from the current
//   state would keep a tablet folded after it rotates to landscape.

export const HEADER_COMPACT_ATTR = "data-header-compact";
const MEASURING_ATTR = "data-header-measuring";
const PHONE_QUERY = "(max-width: 768px)";

/** Right-hand controls that stop being useful when squeezed. Both can shrink
 *  (min-width: 0) without ever overlapping anything, so overlap alone would
 *  never fold them. Kept below each theme's natural width: the minimal
 *  header's search is ~163px wide on purpose. */
const MIN_WIDTHS: Record<string, number> = {
  search: 140,
  delivery: 120,
};

function boxOf(el: Element, minWidth?: number): FitBox | null {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null; // hidden
  return { left: r.left, right: r.right, minWidth };
}

export function useHeaderFit(
  ref: RefObject<HTMLElement | null>,
  classes: {
    logo: string;
    navLinks: string;
    headerRight: string;
    searchWrap: string;
  },
  /** Anything that changes what the header holds. */
  deps: readonly unknown[],
) {
  const { logo, navLinks, headerRight, searchWrap } = classes;
  useLayoutEffect(() => {
    const header = ref.current;
    if (!header) return;

    const measure = (steps: readonly CompactStep[]) => {
      header.setAttribute(HEADER_COMPACT_ATTR, steps.join(" "));
      const items: FitBox[] = [];
      const add = (el: Element | null | undefined, minWidth?: number) => {
        const box = el ? boxOf(el, minWidth) : null;
        if (box) items.push(box);
      };
      add(header.querySelector(`.${logo}`));
      add(header.querySelector(`.${navLinks}`));
      const right = header.querySelector(`.${headerRight}`);
      for (const child of Array.from(right?.children ?? [])) {
        const minWidth = child.classList.contains(searchWrap)
          ? MIN_WIDTHS.search
          : child.hasAttribute("data-delivery-control")
            ? MIN_WIDTHS.delivery
            : undefined;
        add(child, minWidth);
      }
      return {
        clientWidth: header.clientWidth,
        scrollWidth: header.scrollWidth,
        items,
      };
    };

    let frame = 0;
    let live = true;
    const fit = () => {
      // The search box animates its width and the header its padding; a
      // measurement taken mid-animation reports a layout that is about to
      // change (it passed a fit that then closed to a 4px gap). Transitions
      // are off only while measuring, so what the shopper sees still eases.
      // Phones are plain CSS (Header.module.css ≤768px), whose tight row
      // overlaps hit areas on purpose; measuring it would fold nothing new.
      if (window.matchMedia?.(PHONE_QUERY).matches) {
        header.setAttribute(HEADER_COMPACT_ATTR, "");
        return;
      }
      header.setAttribute(MEASURING_ATTR, "");
      const steps = chooseCompaction(measure);
      header.setAttribute(HEADER_COMPACT_ATTR, steps.join(" "));
      void header.offsetWidth; // settle before transitions return
      header.removeAttribute(MEASURING_ATTR);
    };
    const schedule = () => {
      if (!live) return; // fonts.ready can settle after unmount
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    };

    fit();
    // A ResizeObserver reports after layout; a window `resize` event can
    // arrive before the new width has been laid out and measure the old one.
    // Re-fitting is idempotent, so the observer seeing the header's own
    // height change after a fold settles on the next pass.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    if (observer) observer.observe(header);
    else window.addEventListener("resize", schedule);
    // The theme's web font arrives after first paint and is usually wider
    // than the fallback it replaces.
    document.fonts?.ready.then(schedule).catch(() => {});
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
    };
    // The class names are stable per build; `deps` carry the content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, logo, navLinks, headerRight, searchWrap, ...deps]);
}
