import Image, { getImageProps } from "next/image";
import type { CSSProperties } from "react";
import type {
  HeroContentPosition,
  HeroHeight,
  HeroImageOptions,
} from "@/lib/homepage/section-types";

// ---------------------------------------------------------------------------
// The banner photograph shared by the hero and every carousel slide, with the
// controls a paid Shopify theme gives a merchant: a focal point, a separate
// phone image, and an overlay strength. No hooks, so it renders from the
// server hero and the client carousel alike.
//
// ★ A PHONE IMAGE IS ART DIRECTION, NOT A SECOND <Image>. Two images toggled
//   by CSS would preload both on every visit, because the first hero image is
//   eager. `<picture>` with a media-matched <source> lets the browser fetch
//   exactly one — the pattern Next documents for `getImageProps`.
// ★ The focal point applies to the MAIN image only. A phone image is composed
//   for the phone, so centring it is what its author meant; applying the
//   desktop subject position to a different photograph would crop it wrongly.
// ---------------------------------------------------------------------------

/** Phones get the mobile image below this width. */
export const HERO_MOBILE_QUERY = "(max-width: 767.98px)";

export function focalPosition(options: HeroImageOptions): string | undefined {
  const x = options.focal_x ?? 50;
  const y = options.focal_y ?? 50;
  return x === 50 && y === 50 ? undefined : `${x}% ${y}%`;
}

export function HeroImage({
  src,
  alt,
  sizes,
  className,
  eager,
  options,
}: {
  src: string;
  alt: string;
  sizes: string;
  className: string;
  eager: boolean;
  options: HeroImageOptions;
}) {
  const focal = focalPosition(options);
  const mobile = options.mobile_image_url?.trim() || "";

  if (!mobile) {
    return (
      <Image
        src={src}
        alt={alt}
        fill
        preload={eager}
        sizes={sizes}
        className={className}
        style={focal ? { objectPosition: focal } : undefined}
      />
    );
  }

  const common = { alt, fill: true, sizes } as const;
  const {
    props: { srcSet: desktopSet, ...desktop },
  } = getImageProps({ ...common, src });
  const {
    props: { srcSet: mobileSet },
  } = getImageProps({ ...common, src: mobile, sizes: "100vw" });

  return (
    <picture className="home-hero-picture">
      <source media={HERO_MOBILE_QUERY} srcSet={mobileSet} sizes="100vw" />
      <img
        {...desktop}
        srcSet={desktopSet}
        alt={alt}
        className={`${className}${focal ? " has-focal" : ""}`}
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : undefined}
        style={
          {
            ...desktop.style,
            ...(focal ? { "--sm-focal": focal } : {}),
          } as CSSProperties
        }
      />
    </picture>
  );
}

/** The legibility overlay a merchant has tuned, or null to keep the text
 *  theme's built-in scrim. Light text gets a dark veil, dark text a light
 *  one — the copy stays readable either way. */
export function HeroOverlay({
  opacity,
  theme,
}: {
  opacity: number | undefined;
  theme: "dark" | "light";
}) {
  if (opacity === undefined) return null;
  const rgb = theme === "light" ? "0, 0, 0" : "255, 255, 255";
  return (
    <span
      className="home-hero-overlay"
      aria-hidden
      style={{ background: `rgba(${rgb}, ${opacity / 100})` }}
    />
  );
}

/** Root classes for the height preset, content position and a tuned overlay
 *  (which switches the built-in scrim off). Empty at the defaults. */
export function heroClasses(options: {
  height?: HeroHeight;
  content_position?: HeroContentPosition;
  overlay_opacity?: number;
}): string {
  return [
    options.height && options.height !== "auto"
      ? `height-${options.height}`
      : "",
    options.content_position && options.content_position !== "middle"
      ? `content-${options.content_position}`
      : "",
    options.overlay_opacity !== undefined ? "has-overlay" : "",
  ]
    .filter(Boolean)
    .join(" ");
}
