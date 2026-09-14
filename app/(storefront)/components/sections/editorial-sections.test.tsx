// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GallerySection } from "./gallery-section";
import { MediaTextSection } from "./media-text-section";
import { TestimonialsSection } from "./testimonials-section";

describe("Phase 3 editorial storefront sections", () => {
  it("renders media-with-text with accessible media, layout and CTA", () => {
    const { container } = render(
      <MediaTextSection
        sectionId="story"
        config={{
          eyebrow: "Our craft",
          heading: "Made slowly",
          body: "A considered process.",
          cta_label: "Read the story",
          cta_href: "/our-story",
          image_url: "/themes/basket/story.webp",
          image_alt: "An artisan preparing the product",
          media_position: "right",
          media_ratio: "landscape",
          alignment: "left",
        }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Made slowly" })).toBeVisible();
    expect(
      screen.getByRole("img", { name: "An artisan preparing the product" }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Read the story" }),
    ).toHaveAttribute("href", "/our-story");
    expect(container.querySelector(".home-media-text")).toHaveClass(
      "media-right",
    );
  });

  it("renders an editorial gallery with linked captions", () => {
    const { container } = render(
      <GallerySection
        sectionId="lookbook"
        config={{
          heading: "The edit",
          subheading: "New season",
          layout: "editorial",
          columns: 3,
          image_ratio: "portrait",
          items: [
            {
              image_url: "/themes/basket/one.webp",
              image_alt: "Product on a linen table",
              caption: "The everyday edit",
              href: "/shop",
            },
            {
              image_url: "/themes/basket/two.webp",
              image_alt: "Product detail",
              caption: "Natural textures",
              href: "",
            },
          ],
        }}
      />,
    );
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(
      screen.getByRole("link", { name: /everyday edit/i }),
    ).toHaveAttribute("href", "/shop");
    expect(container.querySelector(".home-gallery")).toHaveClass(
      "layout-editorial",
      "cols-3",
    );
  });

  it("uses semantic quotes and attribution for testimonials", () => {
    const { container } = render(
      <TestimonialsSection
        sectionId="reviews"
        config={{
          eyebrow: "Loved by customers",
          heading: "Worth sharing",
          subheading: "",
          layout: "cards",
          columns: 2,
          items: [
            {
              quote: "Beautifully made and thoughtfully packed.",
              author: "Asha Rao",
              detail: "Verified customer",
              logo_url: "",
              logo_alt: "",
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByText("Beautifully made and thoughtfully packed."),
    ).toBeVisible();
    expect(screen.getByText("Asha Rao").closest("cite")).not.toBeNull();
    expect(container.querySelector("blockquote")).not.toBeNull();
  });
});
