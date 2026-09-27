// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EMPTY_CONFIG } from "@/lib/homepage/section-types";
import { HeroSection } from "./hero-section";
import { HeroCarouselSection } from "./hero-carousel-section";
import { TileGridSection } from "./tile-grid-section";
import { PromoBannerSection } from "../homepage/promo-banner-section";

// Copy over a photo picks its text colour from the pixels behind it
// (`MediaTone`). jsdom cannot decode an image or draw a canvas, so these pin
// the two things it CAN check: the tone probe sits inside the element that
// carries the theme class (the one it rewrites), and it only exists where a
// photo is under the copy. The colour decision itself is tested in
// lib/storefront/media-tone.test.ts. With no measurement the configured
// colour must survive untouched — that is the fail-quiet contract.

const IMG = "/themes/vitrine/hero.webp";
const probeIn = (root: Element | null) =>
  root?.querySelector(":scope > span[hidden]") ?? null;

describe("the tone probe", () => {
  it("carousel: inside each photo slide, not a colour or video slide", () => {
    const base = EMPTY_CONFIG.hero_carousel.slides[0];
    const { container } = render(
      <HeroCarouselSection
        sectionId="c"
        config={{
          ...EMPTY_CONFIG.hero_carousel,
          autoplay: false,
          slides: [
            { ...base, heading: "Photo", image_url: IMG, theme: "dark" },
            {
              ...base,
              heading: "Film",
              image_url: "",
              video_url: "/clip.mp4",
            },
            {
              ...base,
              heading: "Colour",
              image_url: "",
              video_url: "",
              background: "#f4dfe0",
            },
          ],
        }}
      />,
    );
    const slides = [...container.querySelectorAll(".home-carousel-slide")];
    expect(probeIn(slides[0])).not.toBeNull();
    expect(probeIn(slides[1])).toBeNull();
    expect(probeIn(slides[2])).toBeNull();
    // Nothing measured: the configured colour stands.
    expect(slides[0]).toHaveClass("theme-dark");
    expect(slides[0]).not.toHaveClass("sm-scrim");
  });

  it("carousel: a tuned overlay leaves the colour to the merchant", () => {
    const base = EMPTY_CONFIG.hero_carousel.slides[0];
    const { container } = render(
      <HeroCarouselSection
        sectionId="c"
        config={{
          ...EMPTY_CONFIG.hero_carousel,
          autoplay: false,
          slides: [
            {
              ...base,
              heading: "Photo",
              image_url: IMG,
              overlay_opacity: 40,
            },
          ],
        }}
      />,
    );
    const slide = container.querySelector(".home-carousel-slide");
    expect(slide).toHaveClass(`theme-${base.theme}`);
  });

  it("hero: only when the image is the background", () => {
    const behind = render(
      <HeroSection
        sectionId="h"
        config={{
          ...EMPTY_CONFIG.hero,
          variant: "minimal",
          heading: "Hi",
          image_url: IMG,
        }}
      />,
    );
    expect(
      probeIn(behind.container.querySelector(".home-hero")),
    ).not.toBeNull();
    const beside = render(
      <HeroSection
        sectionId="h2"
        config={{
          ...EMPTY_CONFIG.hero,
          variant: "split",
          heading: "Hi",
          image_url: IMG,
        }}
      />,
    );
    expect(probeIn(beside.container.querySelector(".home-hero"))).toBeNull();
  });

  it("promo banner and tiles: only with an image", () => {
    const withImage = render(
      <PromoBannerSection
        sectionId="b"
        config={{
          ...EMPTY_CONFIG.promo_banner,
          heading: "Sale",
          image_url: IMG,
        }}
      />,
    );
    expect(
      probeIn(withImage.container.querySelector(".home-banner")),
    ).not.toBeNull();
    const plain = render(
      <PromoBannerSection
        sectionId="b2"
        config={{ ...EMPTY_CONFIG.promo_banner, heading: "Sale" }}
      />,
    );
    expect(probeIn(plain.container.querySelector(".home-banner"))).toBeNull();

    const tile = {
      title: "Cookies",
      subtitle: "",
      href: "",
      background: "",
      theme: "light" as const,
    };
    const { container } = render(
      <TileGridSection
        sectionId="t"
        config={{
          ...EMPTY_CONFIG.tile_grid,
          tiles: [
            { ...tile, image_url: IMG },
            { ...tile, image_url: "", background: "#223344" },
          ],
        }}
      />,
    );
    const tiles = [...container.querySelectorAll(".home-tile")];
    expect(probeIn(tiles[0])).not.toBeNull();
    expect(probeIn(tiles[1])).toBeNull();
  });

  it("carousel copy clears the arrows only when there are arrows", () => {
    const base = EMPTY_CONFIG.hero_carousel.slides[0];
    const one = render(
      <HeroCarouselSection
        sectionId="c1"
        config={{
          ...EMPTY_CONFIG.hero_carousel,
          autoplay: false,
          slides: [{ ...base, heading: "Only", image_url: IMG }],
        }}
      />,
    );
    expect(one.container.querySelector(".home-carousel")).not.toHaveClass(
      "has-arrows",
    );
    const two = render(
      <HeroCarouselSection
        sectionId="c2"
        config={{
          ...EMPTY_CONFIG.hero_carousel,
          autoplay: false,
          slides: [
            { ...base, heading: "A", image_url: IMG },
            { ...base, heading: "B", image_url: IMG },
          ],
        }}
      />,
    );
    expect(two.container.querySelector(".home-carousel")).toHaveClass(
      "has-arrows",
    );
  });
});
