"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { REVEAL_ALL_EVENT, REVEAL_SELECTOR } from "@/lib/themes/motion";

// ---------------------------------------------------------------------------
// Reveals page sections as they scroll into view, for a theme that sets
// `design.motion.reveal` (lib/themes/motion.ts). The storefront layout mounts
// it only for such a theme and never in the builder preview.
//
// ★ IT ONLY EVER HIDES WHAT IS WHOLLY BELOW THE SCREEN, and only once it has
// run. The server renders every section visible, so without JavaScript, before
// hydration, on the first screen and for anything scrolled past already,
// nothing is hidden. `data-reveal="pending"` is the only thing the CSS hides.
//
// ★ ONE WAY. A section that has been shown stays shown; its attribute is
// removed once the transition ends, so no transform lingers on it (a transform
// makes a section the containing block for any fixed-position child).
//
// ★ NEVER A TRAP. Reduced motion, no IntersectionObserver: nothing is hidden.
// Keyboard focus inside a pending section, printing, and the Theme Studio
// acceptance probe (REVEAL_ALL_EVENT) show it at once.
// ---------------------------------------------------------------------------

/** How long a shown section keeps its attribute: the CSS transition (700ms)
 *  plus room. A timer rather than transitionend alone, which never fires when
 *  nothing changed (a section focused before it moved). */
const SETTLE_MS = 900;

export function ScrollReveal() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    const root = document.querySelector(".storefront-root");
    if (!root) return;

    const timers = new Set<ReturnType<typeof setTimeout>>();
    const show = (el: Element) => {
      if (el.getAttribute("data-reveal") !== "pending") return;
      el.setAttribute("data-reveal", "shown");
      observer.unobserve(el);
      const timer = setTimeout(() => {
        timers.delete(timer);
        el.removeAttribute("data-reveal");
      }, SETTLE_MS);
      timers.add(timer);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) show(entry.target);
        }
      },
      // Reveal a little before the section's top edge reaches the bottom of
      // the screen, so it is already arriving as it comes into view.
      { rootMargin: "0px 0px -8% 0px", threshold: 0 },
    );

    const viewport = window.innerHeight;
    const pending: Element[] = [];
    for (const el of root.querySelectorAll(REVEAL_SELECTOR)) {
      if (el.getBoundingClientRect().top < viewport) continue;
      el.setAttribute("data-reveal", "pending");
      observer.observe(el);
      pending.push(el);
    }

    const showAll = () => pending.forEach(show);
    const onFocus = (event: FocusEvent) => {
      const section =
        event.target instanceof Element
          ? event.target.closest('[data-reveal="pending"]')
          : null;
      if (section) show(section);
    };
    window.addEventListener(REVEAL_ALL_EVENT, showAll);
    window.addEventListener("beforeprint", showAll);
    root.addEventListener("focusin", onFocus as EventListener);

    return () => {
      observer.disconnect();
      window.removeEventListener(REVEAL_ALL_EVENT, showAll);
      window.removeEventListener("beforeprint", showAll);
      root.removeEventListener("focusin", onFocus as EventListener);
      for (const timer of timers) clearTimeout(timer);
      // Leave nothing hidden behind: the next page scans afresh.
      for (const el of pending) el.removeAttribute("data-reveal");
    };
  }, [pathname]);

  return null;
}
