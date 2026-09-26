// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  ProductGallery,
  ProductLightbox,
  slideIndexAt,
} from "./product-gallery";

const IMAGES = ["/a.webp", "/b.webp", "/c.webp"];

describe("slideIndexAt", () => {
  it("rounds to the slide the track is resting on and clamps", () => {
    expect(slideIndexAt(0, 390, 3)).toBe(0);
    expect(slideIndexAt(400, 390, 3)).toBe(1);
    expect(slideIndexAt(580, 390, 3)).toBe(1);
    expect(slideIndexAt(9999, 390, 3)).toBe(2);
    // RTL tracks report negative scrollLeft.
    expect(slideIndexAt(-780, 390, 3)).toBe(2);
    expect(slideIndexAt(100, 0, 3)).toBe(0);
    expect(slideIndexAt(100, 390, 0)).toBe(0);
  });
});

describe("ProductGallery", () => {
  it("marks exactly one slide active and switches it from a thumbnail", () => {
    const onActive = vi.fn();
    const { container } = render(
      <ProductGallery
        images={IMAGES}
        alt="Linen shirt"
        activeIndex={1}
        onActiveIndexChange={onActive}
        onZoom={vi.fn()}
        classPrefix="pdp"
        sizes="100vw"
      />,
    );
    const slides = container.querySelectorAll(".sm-gallery-slide");
    expect(slides).toHaveLength(3);
    expect(
      Array.from(slides).map((s) => s.getAttribute("data-active")),
    ).toEqual(["false", "true", "false"]);
    expect(screen.getByText("2 / 3")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Show photo 3 of 3"));
    expect(onActive).toHaveBeenCalledWith(2);
  });

  it("opens the viewer on the tapped photo", () => {
    const onZoom = vi.fn();
    render(
      <ProductGallery
        images={IMAGES}
        alt="Linen shirt"
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onZoom={onZoom}
        classPrefix="gpdp"
        sizes="100vw"
      />,
    );
    fireEvent.click(screen.getByLabelText("Zoom photo 1 of 3"));
    expect(onZoom).toHaveBeenCalledWith(0);
  });

  it("adds no counter or thumbnails for a single photo", () => {
    const { container } = render(
      <ProductGallery
        images={["/a.webp"]}
        alt="Linen shirt"
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onZoom={vi.fn()}
        classPrefix="pdp"
        sizes="100vw"
      />,
    );
    expect(container.querySelector(".sm-gallery-count")).toBeNull();
    expect(container.querySelector(".pdp-thumbs")).toBeNull();
    expect(container.querySelector(".is-multi")).toBeNull();
  });

  it("shows the placeholder when there is no photo", () => {
    const { container } = render(
      <ProductGallery
        images={[]}
        alt="Linen shirt"
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onZoom={vi.fn()}
        classPrefix="pdp"
        sizes="100vw"
      />,
    );
    expect(container.querySelector(".pdp-img-placeholder")).toBeTruthy();
  });
});

describe("ProductLightbox", () => {
  it("moves with the arrow keys, wraps, and closes on Escape", () => {
    const onIndex = vi.fn();
    const onClose = vi.fn();
    render(
      <ProductLightbox
        images={IMAGES}
        alt="Linen shirt"
        index={2}
        onIndexChange={onIndex}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onIndex).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onIndex).toHaveBeenLastCalledWith(1);
    fireEvent.click(screen.getByLabelText("Next photo"));
    expect(onIndex).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("locks page scroll while open and restores it on close", () => {
    document.body.style.overflow = "auto";
    const { unmount } = render(
      <ProductLightbox
        images={IMAGES}
        alt="Linen shirt"
        index={0}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
  });

  it("focuses Close on open and offers no arrows for one photo", () => {
    render(
      <ProductLightbox
        images={["/a.webp"]}
        alt="Linen shirt"
        index={0}
        onIndexChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
    expect(screen.queryByLabelText("Next photo")).toBeNull();
  });
});
