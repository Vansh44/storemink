"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type {
  HeroCarouselConfig,
  HeroSlide,
  SectionStyle,
} from "@/lib/homepage/section-types";
import { videoEmbedUrl } from "@/lib/homepage/video-embed";
import { SectionShell } from "./section-shell";
import { HeroImage, HeroOverlay, heroClasses } from "./hero-media";

/** Horizontal travel, in px, that counts as a swipe rather than a tap. */
const SWIPE_PX = 40;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

// Auto-playing hero slideshow. Each slide is a full-width media banner —
// a photo or a muted looping video — with copy overlaid on top. Slides are
// stacked and cross-faded (opacity), so media keeps playing/decoding without
// layout shift. Autoplay pauses on hover and while the tab is hidden
// (browsers throttle intervals anyway; the guard keeps timing honest).
// ★ Phones SWIPE between slides (a horizontal pointer drag; vertical page
//   scrolling is left to the browser by `touch-action: pan-y`). Autoplay also
//   pauses while a control inside has keyboard focus, and never runs for a
//   visitor who asked the OS for reduced motion — an auto-advancing banner is
//   exactly the movement that setting exists to stop.
export function HeroCarouselSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: HeroCarouselConfig;
}) {
  const slides = config.slides.filter(
    (s) => s.heading || s.image_url || s.video_url,
  );
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const count = slides.length;

  const step = useCallback(
    (dir: 1 | -1) => {
      if (count === 0) return;
      setIndex((i) => (((i + dir) % count) + count) % count);
    },
    [count],
  );

  // Reduced motion is read when the timer would start rather than held in
  // state: it is a browser-only fact, so reading it here keeps the server and
  // first client render identical without a setState-in-effect round trip.
  useEffect(() => {
    if (!config.autoplay || paused || count < 2 || prefersReducedMotion())
      return;
    const ms = Math.min(15, Math.max(2, config.interval_seconds || 5)) * 1000;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible")
        setIndex((i) => (i + 1) % count);
    }, ms);
    return () => clearInterval(timer);
  }, [config.autoplay, config.interval_seconds, paused, count]);

  if (count === 0) return null;

  return (
    <SectionShell sectionId={sectionId} style={style}>
      <div
        className={`home-carousel${config.height && config.height !== "auto" ? ` height-${config.height}` : ""}`}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null))
            setPaused(false);
        }}
        onPointerDown={(e) => {
          if (count < 2 || e.pointerType === "mouse") return;
          swipeStart.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const start = swipeStart.current;
          swipeStart.current = null;
          if (!start) return;
          const dx = e.clientX - start.x;
          const dy = e.clientY - start.y;
          if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy))
            step(dx < 0 ? 1 : -1);
        }}
        onPointerCancel={() => {
          swipeStart.current = null;
        }}
        aria-roledescription="carousel"
      >
        {slides.map((slide, i) => (
          <Slide key={i} slide={slide} active={i === index} first={i === 0} />
        ))}

        {count > 1 && (
          <>
            <button
              type="button"
              className="home-carousel-arrow is-prev"
              onClick={() => step(-1)}
              aria-label="Previous slide"
            >
              <ChevronLeft />
            </button>
            <button
              type="button"
              className="home-carousel-arrow is-next"
              onClick={() => step(1)}
              aria-label="Next slide"
            >
              <ChevronRight />
            </button>
            <div className="home-carousel-dots">
              {slides.map((_, i) => (
                <button
                  key={i}
                  type="button"
                  className={`home-carousel-dot ${i === index ? "is-active" : ""}`}
                  onClick={() => setIndex(i)}
                  aria-label={`Go to slide ${i + 1}`}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </SectionShell>
  );
}

function Slide({
  slide,
  active,
  first,
}: {
  slide: HeroSlide;
  active: boolean;
  first: boolean;
}) {
  const hasCta = slide.cta_label && slide.cta_href;
  const isExternal = /^https?:\/\//i.test(slide.cta_href);

  return (
    <div
      className={`home-carousel-slide theme-${slide.theme} ${active ? "is-active" : ""} ${heroClasses(slide)}`}
      style={slide.background ? { background: slide.background } : undefined}
      aria-hidden={!active}
    >
      {videoEmbedUrl(slide.video_url) ? (
        <span className="home-video-embed-wrap">
          <iframe
            src={videoEmbedUrl(slide.video_url) as string}
            className="home-video-embed"
            allow="autoplay; encrypted-media; picture-in-picture"
            title={slide.heading || "Slide video"}
            tabIndex={-1}
            aria-hidden
          />
        </span>
      ) : slide.video_url ? (
        <video
          src={slide.video_url}
          poster={slide.image_url || undefined}
          className="home-carousel-media"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
        />
      ) : slide.image_url ? (
        <HeroImage
          src={slide.image_url}
          alt={slide.heading || "Slide"}
          eager={first}
          sizes="100vw"
          className="home-carousel-media"
          options={slide}
        />
      ) : null}
      <HeroOverlay opacity={slide.overlay_opacity} theme={slide.theme} />

      {(slide.heading || slide.subheading || hasCta) && (
        <div className="home-carousel-copy">
          {slide.heading && (
            <h2 className="home-carousel-heading">{slide.heading}</h2>
          )}
          {slide.subheading && (
            <p className="home-carousel-sub">{slide.subheading}</p>
          )}
          {hasCta &&
            (isExternal ? (
              <a
                className="home-hero-cta"
                href={slide.cta_href}
                target="_blank"
                rel="noopener noreferrer"
                tabIndex={active ? 0 : -1}
              >
                {slide.cta_label}
              </a>
            ) : (
              <Link
                className="home-hero-cta"
                href={slide.cta_href}
                tabIndex={active ? 0 : -1}
              >
                {slide.cta_label}
              </Link>
            ))}
        </div>
      )}
    </div>
  );
}
