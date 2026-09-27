"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, ImageIcon, X } from "lucide-react";

// ---------------------------------------------------------------------------
// The product-page gallery and its full-screen viewer, shared by every PDP
// layout (classic, editorial, grocery).
//
// ★ ONE TRACK, TWO BEHAVIOURS, CHOSEN BY CSS. Every image is rendered as a
//   slide in one track. At desktop widths the track shows only the ACTIVE
//   slide and thumbnails switch it — exactly the old main-image + thumbnails
//   look. Below the two-column breakpoint the track becomes a horizontal
//   scroll-snap strip, so a shopper SWIPES between photos the way every
//   premium Shopify theme lets them. Swipe is native scrolling, not a gesture
//   library: it keeps momentum, respects the OS's own feel and costs no JS.
// ★ HIDDEN SLIDES COST NOTHING. Non-active slides are `display: none` on
//   desktop and every slide but the first is lazy, so a lazy image that is
//   never laid out is never fetched — the rule `.sm-card-hoverimg` relies on.
// ★ It applies to EVERY store, deliberately: at rest it shows the same first
//   photo the page always showed, so nothing a merchant chose changes; what
//   changes is that a phone can now reach the other photos without aiming at
//   a 72px thumbnail. The counter is the only new element, and only when
//   there is more than one photo.
// ---------------------------------------------------------------------------

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** The slide a horizontally scrolled track is resting on. */
export function slideIndexAt(
  scrollLeft: number,
  slideWidth: number,
  count: number,
): number {
  if (slideWidth <= 0 || count <= 0) return 0;
  const index = Math.round(Math.abs(scrollLeft) / slideWidth);
  return Math.min(Math.max(index, 0), count - 1);
}

/** Keep a scroll-snap track on `index` without fighting a user mid-swipe:
 *  only scroll when the track is actually a strip (scrollable) and is not
 *  already resting there. `resetKey` re-runs it when the image set changes
 *  (a variant switch), since the index alone may not have moved. */
function useTrackSync(
  track: React.RefObject<HTMLDivElement | null>,
  index: number,
  count: number,
  resetKey: string,
) {
  useEffect(() => {
    const el = track.current;
    if (!el || el.scrollWidth <= el.clientWidth + 1) return;
    if (slideIndexAt(el.scrollLeft, el.clientWidth, count) === index) return;
    el.scrollTo({
      left: index * el.clientWidth,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [track, index, count, resetKey]);
}

/** Report the slide a swiped track settles on. Computed on every scroll event
 *  rather than behind requestAnimationFrame: it is one division, the caller
 *  only sets state when the index actually changes, and a frame-throttle has
 *  a failure mode this does not — a frame that never fires (a backgrounded
 *  tab) leaves the throttle latched and the counter frozen. */
function useScrollIndex(
  track: React.RefObject<HTMLDivElement | null>,
  count: number,
  onIndex: (index: number) => void,
) {
  return () => {
    const el = track.current;
    if (!el || el.scrollWidth <= el.clientWidth + 1) return;
    onIndex(slideIndexAt(el.scrollLeft, el.clientWidth, count));
  };
}

export function ProductGallery({
  images,
  alt,
  activeIndex,
  onActiveIndexChange,
  onZoom,
  classPrefix,
  sizes,
}: {
  images: string[];
  alt: string;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onZoom: (index: number) => void;
  /** The layout's own class family, so each layout keeps its styling. */
  classPrefix: "pdp" | "gpdp";
  sizes: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const count = images.length;
  const active = Math.min(Math.max(activeIndex, 0), Math.max(count - 1, 0));
  const multi = count > 1;
  const p = classPrefix;

  useTrackSync(track, active, count, images.join("|"));
  const onScroll = useScrollIndex(track, count, (index) => {
    if (index !== active) onActiveIndexChange(index);
  });

  if (count === 0) {
    return (
      <div className={`${p}-gallery sm-gallery`}>
        <div className={`${p}-main-img`}>
          <div className={`${p}-img-placeholder`}>
            <ImageIcon size={40} strokeWidth={1.5} aria-hidden />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`${p}-gallery sm-gallery`}>
      <div className="sm-gallery-frame">
        <div
          ref={track}
          className={`sm-gallery-track${multi ? " is-multi" : ""}`}
          onScroll={multi ? onScroll : undefined}
          aria-roledescription={multi ? "carousel" : undefined}
          aria-label={multi ? `${alt} photos` : undefined}
        >
          {images.map((url, index) => (
            <button
              key={url}
              type="button"
              className={`${p}-main-img sm-gallery-slide`}
              data-active={index === active ? "true" : "false"}
              onClick={() => onZoom(index)}
              aria-label={
                multi
                  ? `Zoom photo ${index + 1} of ${count}`
                  : "Zoom product photo"
              }
            >
              <Image
                src={url}
                alt={index === 0 ? alt : `${alt} — photo ${index + 1}`}
                fill
                sizes={sizes}
                className={`${p}-main-img-el`}
                priority={index === 0}
              />
              {p === "pdp" && (
                <span className="pdp-zoom-hint" aria-hidden>
                  🔍 Click to zoom
                </span>
              )}
            </button>
          ))}
        </div>
        {multi && (
          <span className="sm-gallery-count" aria-live="polite">
            {active + 1} / {count}
          </span>
        )}
      </div>
      {multi && (
        <div className={`${p}-thumbs`}>
          {images.map((url, index) => (
            <button
              key={url}
              type="button"
              className={`${p}-thumb${index === active ? " active" : ""}`}
              onClick={() => onActiveIndexChange(index)}
              aria-label={`Show photo ${index + 1} of ${count}`}
              aria-current={index === active ? "true" : undefined}
            >
              <Image
                src={url}
                alt=""
                fill
                sizes="72px"
                className={`${p}-thumb-el`}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ viewer

/** Zoom factor for the desktop click-to-magnify. Phones pinch natively. */
const MAGNIFY = 2.25;

export function ProductLightbox({
  images,
  alt,
  index,
  onIndexChange,
  onClose,
}: {
  images: string[];
  alt: string;
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const count = images.length;
  const active = Math.min(Math.max(index, 0), Math.max(count - 1, 0));
  const [magnified, setMagnified] = useState<{ x: number; y: number } | null>(
    null,
  );

  const go = useCallback(
    (delta: number) => {
      setMagnified(null);
      onIndexChange((active + delta + count) % count);
    },
    [active, count, onIndexChange],
  );

  // ★ The slide the viewer OPENS on is placed instantly, never animated in
  // from photo one — opening on photo four must not scroll past three others.
  useEffect(() => {
    const el = track.current;
    if (el) el.scrollLeft = active * el.clientWidth;
    closeButton.current?.focus();
    // Opening position only; later moves go through useTrackSync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useTrackSync(track, active, count, "lightbox");
  const onScroll = useScrollIndex(track, count, (next) => {
    if (next !== active) {
      setMagnified(null);
      onIndexChange(next);
    }
  });

  // Keyboard: Escape closes, arrows move. Scroll is locked behind the dialog
  // so a swipe that overshoots does not scroll the product page underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && count > 1) go(1);
      else if (e.key === "ArrowLeft" && count > 1) go(-1);
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [count, go, onClose]);

  const toggleMagnify = (e: React.MouseEvent<HTMLDivElement>) => {
    // Coarse pointers pinch instead; a tap there must not jump the zoom.
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    if (magnified) {
      setMagnified(null);
      return;
    }
    const box = e.currentTarget.getBoundingClientRect();
    setMagnified({
      x: ((e.clientX - box.left) / box.width) * 100,
      y: ((e.clientY - box.top) / box.height) * 100,
    });
  };

  const pan = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!magnified) return;
    const box = e.currentTarget.getBoundingClientRect();
    setMagnified({
      x: ((e.clientX - box.left) / box.width) * 100,
      y: ((e.clientY - box.top) / box.height) * 100,
    });
  };

  return (
    <div
      className="sm-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={`${alt} — photo ${active + 1} of ${count}`}
    >
      <div className="sm-lightbox-bar">
        {count > 1 && (
          <span className="sm-lightbox-count" aria-live="polite">
            {active + 1} / {count}
          </span>
        )}
        <button
          ref={closeButton}
          type="button"
          className="sm-lightbox-btn sm-lightbox-close"
          onClick={onClose}
          aria-label="Close"
        >
          <X size={20} aria-hidden />
        </button>
      </div>

      <div
        ref={track}
        className={`sm-lightbox-track${count > 1 ? " is-multi" : ""}`}
        onScroll={count > 1 ? onScroll : undefined}
      >
        {images.map((url, i) => (
          <div key={url} className="sm-lightbox-slide">
            <div
              className={`sm-lightbox-stage${i === active && magnified ? " is-magnified" : ""}`}
              onClick={i === active ? toggleMagnify : undefined}
              onMouseMove={i === active ? pan : undefined}
              style={
                i === active && magnified
                  ? {
                      transform: `scale(${MAGNIFY})`,
                      transformOrigin: `${magnified.x}% ${magnified.y}%`,
                    }
                  : undefined
              }
            >
              <Image
                src={url}
                alt={i === 0 ? alt : `${alt} — photo ${i + 1}`}
                fill
                sizes="100vw"
                className="sm-lightbox-img"
                priority={i === active}
              />
            </div>
          </div>
        ))}
      </div>

      {count > 1 && (
        <>
          <button
            type="button"
            className="sm-lightbox-btn sm-lightbox-prev"
            onClick={() => go(-1)}
            aria-label="Previous photo"
          >
            <ChevronLeft size={22} aria-hidden />
          </button>
          <button
            type="button"
            className="sm-lightbox-btn sm-lightbox-next"
            onClick={() => go(1)}
            aria-label="Next photo"
          >
            <ChevronRight size={22} aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}
