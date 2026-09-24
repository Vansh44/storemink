"use client";

import { useEffect } from "react";
import { isPlatformHost } from "@/lib/store/host";

// ---------------------------------------------------------------------------
// The Theme Studio acceptance probe.
//
// Rendered ONLY on a Theme Studio preview store (the storefront layout checks
// the store's preview marker; the store itself resolves only for a request
// carrying a preview grant). When the Studio's acceptance runner frames a
// preview page and asks, this measures the page as a browser actually lays it
// out — which a server fetch cannot — and posts back RAW measurements:
//
//   • horizontal overflow in pixels, and the elements causing it;
//   • axe-core WCAG 2.1 A/AA violations with their impact;
//   • images that failed to load (after scrolling, so lazy images load);
//   • LCP and cumulative layout shift from the Performance timeline.
//
// ★ IT DECIDES NOTHING. Thresholds are applied on the server
// (lib/theme-studio/acceptance-gates.ts); there is no "passed" field here.
//
// ★ IT ANSWERS ONLY ITS PARENT, AND ONLY A PLATFORM-HOST PARENT. The message
// must come from `window.parent` and from an origin whose host is the
// StoreMink platform, and the reply is addressed to that exact origin. axe is
// imported on demand, so a preview page that is never measured never loads it.
// ---------------------------------------------------------------------------

interface LayoutShiftEntry extends PerformanceEntry {
  value: number;
  hadRecentInput: boolean;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<void> {
  await Promise.race([promise.then(() => undefined), sleep(ms)]);
}

function describe(element: Element): string {
  const id = element.id ? `#${element.id}` : "";
  const classes =
    typeof element.className === "string" && element.className.trim()
      ? `.${element.className.trim().split(/\s+/).slice(0, 2).join(".")}`
      : "";
  return `${element.tagName.toLowerCase()}${id}${classes}`.slice(0, 120);
}

/**
 * Whether content at this element is hidden from the page by something other
 * than the viewport edge: a fixed-position ancestor (an off-canvas drawer is
 * off-screen on purpose), or a scroll/clip container that itself fits (a
 * carousel is MEANT to hold more than it shows). Cached per element, since a
 * page has thousands and they share ancestors.
 */
function exemptFromOverflow(
  element: Element,
  edge: number,
  cache: Map<Element, boolean>,
): boolean {
  const cached = cache.get(element);
  if (cached !== undefined) return cached;
  let exempt = false;
  const parent = element.parentElement;
  if (parent && parent !== document.body) {
    const style = getComputedStyle(parent);
    if (style.position === "fixed") {
      exempt = true;
    } else if (
      style.overflowX !== "visible" &&
      parent.getBoundingClientRect().right <= edge
    ) {
      exempt = true;
    } else {
      exempt = exemptFromOverflow(parent, edge, cache);
    }
  }
  if (!exempt && getComputedStyle(element).position === "fixed") exempt = true;
  cache.set(element, exempt);
  return exempt;
}

/**
 * How far laid-out content reaches past the right edge, measured from the
 * boxes themselves.
 *
 * ★★ `scrollWidth` ALONE IS BLIND ON THIS STOREFRONT. `<html>` and `<body>`
 * carry `overflow-x: clip`, so content wider than the phone is cut off rather
 * than scrollable and `scrollWidth` reports it as fitting. That is how the
 * grocery product page shipped 734px wide on a 390px screen — its right half
 * simply missing — with this gate green. Measuring rectangles is what sees it.
 */
function clippedOverflow(limit: number): { px: number; offenders: string[] } {
  const width = document.documentElement.clientWidth;
  const edge = width + 1;
  const cache = new Map<Element, boolean>();
  const offenders: string[] = [];
  let px = 0;
  const all = document.body ? document.body.querySelectorAll("*") : [];
  for (let i = 0; i < all.length && i < 6000; i += 1) {
    const element = all[i];
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.right <= edge) continue;
    if (exemptFromOverflow(element, edge, cache)) continue;
    px = Math.max(px, Math.round(rect.right - width));
    const parent = element.parentElement;
    const parentSticksOut =
      parent !== null &&
      parent !== document.body &&
      parent.getBoundingClientRect().right > edge &&
      !exemptFromOverflow(parent, edge, cache);
    if (!parentSticksOut && offenders.length < limit) {
      offenders.push(describe(element));
    }
  }
  return { px, offenders };
}

async function settleImages(ms: number): Promise<void> {
  const pending = Array.from(document.images).filter(
    (img) => !img.complete && (img.currentSrc || img.src),
  );
  await withTimeout(
    Promise.all(
      pending.map(
        (img) =>
          new Promise<void>((resolve) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          }),
      ),
    ),
    ms,
  );
}

/**
 * Images that failed to load, confirmed by asking for each one again. A frame
 * can catch an image mid-flight (the image optimizer's first request in
 * development takes seconds), and a transient miss is not a broken asset; a
 * URL that fails twice is.
 */
async function confirmBrokenImages(): Promise<number> {
  const suspects = [
    ...new Set(
      Array.from(document.images)
        .filter(
          (img) =>
            img.complete &&
            img.naturalWidth === 0 &&
            (img.currentSrc || img.src),
        )
        .map((img) => img.currentSrc || img.src),
    ),
  ];
  const results = await Promise.all(
    suspects.map(
      (src) =>
        new Promise<boolean>((resolve) => {
          const probe = new Image();
          const timer = setTimeout(() => resolve(true), 8_000);
          probe.onload = () => {
            clearTimeout(timer);
            resolve(probe.naturalWidth === 0);
          };
          probe.onerror = () => {
            clearTimeout(timer);
            resolve(true);
          };
          probe.src = src;
        }),
    ),
  );
  return results.filter(Boolean).length;
}

async function measure(perf: { lcp: number | null; cls: number }) {
  if (document.readyState !== "complete") {
    await withTimeout(
      new Promise<void>((resolve) =>
        window.addEventListener("load", () => resolve(), { once: true }),
      ),
      15_000,
    );
  }
  if (document.fonts?.ready) await withTimeout(document.fonts.ready, 5_000);

  // Scroll through the page so lazy images load and below-the-fold layout is
  // exercised, then return to the top before measuring.
  const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
  for (
    let y = 0;
    y < document.documentElement.scrollHeight && y < 40_000;
    y += step
  ) {
    window.scrollTo(0, y);
    await sleep(60);
  }
  window.scrollTo(0, 0);
  await settleImages(6_000);
  await sleep(800);

  const root = document.documentElement;
  const scrollWidth = Math.max(
    root.scrollWidth,
    document.body?.scrollWidth ?? 0,
  );
  const clipped = clippedOverflow(5);
  const overflowPx = Math.max(scrollWidth - root.clientWidth, clipped.px);
  const brokenImages = await confirmBrokenImages();

  const axe = (await import("axe-core")).default;
  const results = await axe.run(
    { exclude: [["nextjs-portal"]] },
    {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
      resultTypes: ["violations"],
    },
  );

  return {
    path: `${location.pathname}${location.search}`.slice(0, 512),
    width: window.innerWidth,
    height: window.innerHeight,
    overflowPx,
    overflowOffenders: overflowPx > 1 ? clipped.offenders : [],
    brokenImages,
    violations: results.violations.slice(0, 100).map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? null,
      nodes: violation.nodes.length,
      help: violation.help.slice(0, 200),
      // The first offending element, so a reviewer can find it.
      target: String(violation.nodes[0]?.target?.[0] ?? "").slice(0, 120),
    })),
    lcpMs: perf.lcp === null ? null : Math.round(perf.lcp),
    cls: Math.round(perf.cls * 10_000) / 10_000,
  };
}

export function StudioAcceptanceProbe() {
  useEffect(() => {
    if (window.parent === window) return;
    const perf = { lcp: null as number | null, cls: 0 };
    const observers: PerformanceObserver[] = [];
    try {
      const lcp = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) perf.lcp = entry.startTime;
      });
      lcp.observe({ type: "largest-contentful-paint", buffered: true });
      observers.push(lcp);
    } catch {
      /* not supported: reported as null */
    }
    try {
      const shifts = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as LayoutShiftEntry[]) {
          if (!entry.hadRecentInput) perf.cls += entry.value;
        }
      });
      shifts.observe({ type: "layout-shift", buffered: true });
      observers.push(shifts);
    } catch {
      /* not supported */
    }

    let started = false;
    const onMessage = async (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      let host: string;
      try {
        host = new URL(event.origin).host;
      } catch {
        return;
      }
      if (!isPlatformHost(host)) return;
      const data = event.data as {
        type?: unknown;
        nonce?: unknown;
        sample?: unknown;
      } | null;
      if (!data || data.type !== "sm-acceptance-run") return;
      if (typeof data.nonce !== "string" || data.nonce.length > 200) return;
      if (typeof data.sample !== "number" || !Number.isInteger(data.sample)) {
        return;
      }
      // ★ A page that has already measured stays SILENT. When the runner moves
      // the frame to the next page, this document is still alive for a moment
      // and receives the next page's request; acknowledging it would tell the
      // runner the request had landed, and the new page would never be asked.
      if (started) return;
      started = true;
      const { nonce, sample } = data;
      window.parent.postMessage(
        { type: "sm-acceptance-ack", nonce, sample },
        event.origin,
      );
      try {
        const result = await measure(perf);
        window.parent.postMessage(
          { type: "sm-acceptance-result", nonce, sample, result },
          event.origin,
        );
      } catch (error) {
        window.parent.postMessage(
          {
            type: "sm-acceptance-error",
            nonce,
            sample,
            message: String(
              error instanceof Error ? error.message : error,
            ).slice(0, 200),
          },
          event.origin,
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      for (const observer of observers) observer.disconnect();
    };
  }, []);
  return null;
}
