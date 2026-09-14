// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NewsletterSection } from "./newsletter-section";
import { VideoSection } from "./video-section";

vi.mock("@/app/actions/newsletter-actions", () => ({
  subscribeNewsletter: vi.fn(),
}));

describe("Phase 3 video and newsletter storefront sections", () => {
  it("renders a direct video with its merchant playback settings", () => {
    const { container } = render(
      <VideoSection
        sectionId="film"
        config={{
          eyebrow: "Watch",
          heading: "Behind the collection",
          subheading: "Inside the studio",
          video_url: "https://cdn.example.com/story.mp4",
          poster_url: "https://cdn.example.com/poster.webp",
          poster_alt: "A maker working in the studio",
          aspect_ratio: "portrait",
          width: "contained",
          autoplay: false,
          loop: false,
          controls: true,
        }}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Behind the collection" }),
    ).toBeVisible();
    const video = container.querySelector("video");
    expect(video).toHaveAttribute(
      "poster",
      "https://cdn.example.com/poster.webp",
    );
    expect(video).toHaveAttribute("controls");
    expect(container.querySelector(".home-video-player")).toHaveClass(
      "ratio-portrait",
    );
  });

  it("constructs a private YouTube embed with accessible labeling", () => {
    render(
      <VideoSection
        sectionId="film"
        config={{
          eyebrow: "",
          heading: "Campaign film",
          subheading: "",
          video_url: "https://youtu.be/aoc6aPPRqVY",
          poster_url: "",
          poster_alt: "",
          aspect_ratio: "landscape",
          width: "full",
          autoplay: false,
          loop: false,
          controls: true,
        }}
      />,
    );
    expect(screen.getByTitle("Campaign film")).toHaveAttribute(
      "src",
      expect.stringContaining("youtube-nocookie.com/embed/aoc6aPPRqVY"),
    );
  });

  it("disables autoplay and restores controls for reduced-motion visitors", () => {
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    render(
      <VideoSection
        sectionId="quiet-film"
        config={{
          eyebrow: "",
          heading: "Quiet campaign film",
          subheading: "",
          video_url: "https://youtu.be/aoc6aPPRqVY",
          poster_url: "",
          poster_alt: "",
          aspect_ratio: "landscape",
          width: "contained",
          autoplay: true,
          loop: true,
          controls: false,
        }}
      />,
    );
    const frame = screen.getByTitle("Quiet campaign film");
    expect(frame).toHaveAttribute("src", expect.stringContaining("autoplay=0"));
    expect(frame).toHaveAttribute("src", expect.stringContaining("controls=1"));
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: original,
    });
  });

  it("renders an explicit-consent newsletter form with merchant copy", () => {
    render(
      <NewsletterSection
        sectionId="letters"
        config={{
          eyebrow: "Stay close",
          heading: "Notes worth opening",
          subheading: "Monthly stories and product news.",
          button_label: "Join the list",
          success_message: "Welcome — check your inbox.",
          consent_text: "I agree to receive store news by email.",
          theme: "dark",
          alignment: "center",
        }}
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "Email address" }),
    ).toBeRequired();
    expect(screen.getByRole("checkbox")).toBeRequired();
    expect(
      screen.getByText("I agree to receive store news by email."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Join the list" })).toBeVisible();
  });
});
