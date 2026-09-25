// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CONFIG } from "@/lib/homepage/section-types";
import {
  HERO_MOBILE_QUERY,
  HeroImage,
  HeroOverlay,
  focalPosition,
  heroClasses,
} from "./hero-media";
import { HeroSection } from "./hero-section";
import { HeroCarouselSection } from "./hero-carousel-section";

const DESKTOP = "/themes/basket/hero.webp";
const PHONE = "/themes/basket/hero-phone.webp";

describe("hero media helpers", () => {
  it("emits no focal position at the centre default", () => {
    expect(focalPosition({})).toBeUndefined();
    expect(focalPosition({ focal_x: 50, focal_y: 50 })).toBeUndefined();
    expect(focalPosition({ focal_x: 20, focal_y: 70 })).toBe("20% 70%");
  });

  it("adds no classes at the defaults", () => {
    expect(heroClasses({})).toBe("");
    expect(heroClasses({ height: "auto", content_position: "middle" })).toBe(
      "",
    );
    expect(
      heroClasses({
        height: "screen",
        content_position: "bottom",
        overlay_opacity: 0,
      }),
    ).toBe("height-screen content-bottom has-overlay");
  });

  it("renders no overlay unless the merchant tuned one", () => {
    const { container, rerender } = render(
      <HeroOverlay opacity={undefined} theme="light" />,
    );
    expect(container.querySelector(".home-hero-overlay")).toBeNull();
    rerender(<HeroOverlay opacity={40} theme="light" />);
    expect(container.querySelector(".home-hero-overlay")).toHaveStyle({
      background: "rgba(0, 0, 0, 0.4)",
    });
    // Dark text gets a light veil, so the copy stays readable either way.
    rerender(<HeroOverlay opacity={40} theme="dark" />);
    expect(container.querySelector(".home-hero-overlay")).toHaveStyle({
      background: "rgba(255, 255, 255, 0.4)",
    });
  });
});

describe("HeroImage", () => {
  it("is a single image with the focal point when there is no phone image", () => {
    const { container } = render(
      <HeroImage
        src={DESKTOP}
        alt="Fresh produce"
        sizes="100vw"
        className="home-hero-img"
        eager
        options={{ focal_x: 30, focal_y: 60 }}
      />,
    );
    expect(container.querySelector("picture")).toBeNull();
    const img = screen.getByRole("img", { name: "Fresh produce" });
    expect(img).toHaveStyle({ objectPosition: "30% 60%" });
  });

  it("art-directs a phone image through one <picture>, so one file is fetched", () => {
    const { container } = render(
      <HeroImage
        src={DESKTOP}
        alt="Fresh produce"
        sizes="100vw"
        className="home-hero-img"
        eager
        options={{ mobile_image_url: PHONE, focal_x: 30, focal_y: 60 }}
      />,
    );
    const picture = container.querySelector("picture.home-hero-picture");
    expect(picture).not.toBeNull();
    const source = picture!.querySelector("source");
    expect(source).toHaveAttribute("media", HERO_MOBILE_QUERY);
    expect(source?.getAttribute("srcset")).toContain(encodeURIComponent(PHONE));
    const img = picture!.querySelector("img")!;
    expect(img.getAttribute("srcset")).toContain(encodeURIComponent(DESKTOP));
    expect(img).toHaveAttribute("fetchpriority", "high");
    expect(img).toHaveAttribute("loading", "eager");
    // The focal point is the DESKTOP image's; CSS applies it above phone width.
    expect(img).toHaveClass("has-focal");
    expect(img.style.getPropertyValue("--sm-focal")).toBe("30% 60%");
  });

  it("lazy-loads a phone-art-directed image that is not first", () => {
    const { container } = render(
      <HeroImage
        src={DESKTOP}
        alt="Slide"
        sizes="100vw"
        className="home-carousel-media"
        eager={false}
        options={{ mobile_image_url: PHONE }}
      />,
    );
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).not.toHaveAttribute("fetchpriority");
    expect(img).not.toHaveClass("has-focal");
  });
});

describe("HeroSection controls", () => {
  it("renders exactly as before when no control is set", () => {
    const { container } = render(
      <HeroSection
        sectionId="h"
        config={{ ...EMPTY_CONFIG.hero, heading: "Hi", image_url: DESKTOP }}
      />,
    );
    const hero = container.querySelector(".home-hero")!;
    expect(hero.className).not.toMatch(/height-|content-|has-overlay/);
    expect(container.querySelector(".home-hero-overlay")).toBeNull();
  });

  it("applies height, position and overlay to a background hero", () => {
    const { container } = render(
      <HeroSection
        sectionId="h"
        config={{
          ...EMPTY_CONFIG.hero,
          variant: "minimal",
          heading: "Hi",
          image_url: DESKTOP,
          theme: "light",
          height: "large",
          content_position: "top",
          overlay_opacity: 35,
        }}
      />,
    );
    const hero = container.querySelector(".home-hero")!;
    expect(hero).toHaveClass("height-large", "content-top", "has-overlay");
    expect(container.querySelector(".home-hero-overlay")).not.toBeNull();
  });

  it("ignores the overlay when the image is not behind the copy", () => {
    // A split/banner hero shows its image BESIDE the text, so a veil over it
    // would only darken the photograph.
    const { container } = render(
      <HeroSection
        sectionId="h"
        config={{
          ...EMPTY_CONFIG.hero,
          variant: "split",
          heading: "Hi",
          image_url: DESKTOP,
          overlay_opacity: 35,
        }}
      />,
    );
    expect(container.querySelector(".home-hero")).not.toHaveClass(
      "has-overlay",
    );
    expect(container.querySelector(".home-hero-overlay")).toBeNull();
  });
});

describe("HeroCarouselSection", () => {
  const slides = [
    { ...EMPTY_CONFIG.hero_carousel.slides[0], heading: "One" },
    { ...EMPTY_CONFIG.hero_carousel.slides[0], heading: "Two" },
    { ...EMPTY_CONFIG.hero_carousel.slides[0], heading: "Three" },
  ].map((s) => ({ ...s, image_url: "", video_url: "" }));

  const activeHeading = (container: HTMLElement) =>
    container.querySelector(".home-carousel-slide.is-active h2")?.textContent;

  let reduced = false;
  beforeEach(() => {
    reduced = false;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("reduced-motion") ? reduced : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function swipe(el: Element, dx: number, dy = 0, pointerType = "touch") {
    fireEvent.pointerDown(el, { clientX: 200, clientY: 200, pointerType });
    fireEvent.pointerUp(el, {
      clientX: 200 + dx,
      clientY: 200 + dy,
      pointerType,
    });
  }

  it("swipes to the next and previous slide on touch", () => {
    const { container } = render(
      <HeroCarouselSection
        sectionId="c"
        config={{ ...EMPTY_CONFIG.hero_carousel, autoplay: false, slides }}
      />,
    );
    const carousel = container.querySelector(".home-carousel")!;
    expect(activeHeading(container)).toBe("One");
    swipe(carousel, -80);
    expect(activeHeading(container)).toBe("Two");
    swipe(carousel, 80);
    expect(activeHeading(container)).toBe("One");
    // Wraps backwards from the first slide.
    swipe(carousel, 80);
    expect(activeHeading(container)).toBe("Three");
  });

  it("treats a short or mostly vertical drag as a tap or a scroll", () => {
    const { container } = render(
      <HeroCarouselSection
        sectionId="c"
        config={{ ...EMPTY_CONFIG.hero_carousel, autoplay: false, slides }}
      />,
    );
    const carousel = container.querySelector(".home-carousel")!;
    swipe(carousel, -20);
    swipe(carousel, -60, 120);
    expect(activeHeading(container)).toBe("One");
  });

  it("leaves mouse drags alone, which have the arrows", () => {
    const { container } = render(
      <HeroCarouselSection
        sectionId="c"
        config={{ ...EMPTY_CONFIG.hero_carousel, autoplay: false, slides }}
      />,
    );
    swipe(container.querySelector(".home-carousel")!, -80, 0, "mouse");
    expect(activeHeading(container)).toBe("One");
  });

  it("autoplays normally", () => {
    vi.useFakeTimers();
    const { container } = render(
      <HeroCarouselSection
        sectionId="c"
        config={{
          ...EMPTY_CONFIG.hero_carousel,
          autoplay: true,
          interval_seconds: 3,
          slides,
        }}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(activeHeading(container)).toBe("Two");
  });

  it("never autoplays for a visitor who asked for reduced motion", () => {
    reduced = true;
    vi.useFakeTimers();
    const { container } = render(
      <HeroCarouselSection
        sectionId="c"
        config={{
          ...EMPTY_CONFIG.hero_carousel,
          autoplay: true,
          interval_seconds: 3,
          slides,
        }}
      />,
    );
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(activeHeading(container)).toBe("One");
  });

  it("pauses autoplay while a control inside has keyboard focus", () => {
    vi.useFakeTimers();
    const { container } = render(
      <HeroCarouselSection
        sectionId="c"
        config={{
          ...EMPTY_CONFIG.hero_carousel,
          autoplay: true,
          interval_seconds: 3,
          slides,
        }}
      />,
    );
    act(() => {
      screen.getByRole("button", { name: "Next slide" }).focus();
    });
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(activeHeading(container)).toBe("One");
  });

  it("applies the carousel height preset", () => {
    const { container } = render(
      <HeroCarouselSection
        sectionId="c"
        config={{
          ...EMPTY_CONFIG.hero_carousel,
          autoplay: false,
          height: "screen",
          slides,
        }}
      />,
    );
    expect(container.querySelector(".home-carousel")).toHaveClass(
      "height-screen",
    );
  });
});
