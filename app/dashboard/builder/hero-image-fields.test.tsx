// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The uploader talks to storage; here it only needs to report a URL or "".
vi.mock("@/components/ui/image-upload", () => ({
  ImageUpload: ({
    onUploadSuccess,
  }: {
    onUploadSuccess: (url: string) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onUploadSuccess("/phone.webp")}>
        upload phone
      </button>
      <button type="button" onClick={() => onUploadSuccess("")}>
        remove phone
      </button>
    </div>
  ),
}));
vi.mock("./code-editor-lazy", () => ({ default: () => null }));

import { HeroImageFields } from "./section-form";

function renderFields(
  value: Parameters<typeof HeroImageFields>[0]["value"],
  overlay = true,
) {
  const onChange = vi.fn();
  render(
    <HeroImageFields
      image="/hero.webp"
      value={value}
      onChange={onChange}
      overlay={overlay}
    />,
  );
  return onChange;
}

describe("HeroImageFields", () => {
  it("sets the focal point where the merchant clicks the preview", () => {
    const onChange = renderFields({});
    const preview = screen.getByRole("button", {
      name: /set the focal point/i,
    });
    preview.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 100 }) as DOMRect;
    fireEvent.click(preview, { clientX: 50, clientY: 80 });
    expect(onChange).toHaveBeenCalledWith({ focal_x: 25, focal_y: 80 });
  });

  it("stores nothing when the point is put back in the centre", () => {
    const onChange = renderFields({ focal_x: 25, focal_y: 80 });
    fireEvent.click(screen.getByRole("button", { name: "Reset to centre" }));
    expect(onChange).toHaveBeenCalledWith({
      focal_x: undefined,
      focal_y: undefined,
    });
  });

  it("clears the phone image rather than storing an empty string", () => {
    const onChange = renderFields({ mobile_image_url: "/phone.webp" });
    fireEvent.click(screen.getByRole("button", { name: "remove phone" }));
    expect(onChange).toHaveBeenCalledWith({ mobile_image_url: undefined });
  });

  it("offers a way back to the theme's own overlay", () => {
    const onChange = renderFields({ overlay_opacity: 40 });
    expect(screen.getByText("Overlay 40%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use default" }));
    expect(onChange).toHaveBeenCalledWith({ overlay_opacity: undefined });
  });

  it("stores no position for the middle default", () => {
    const onChange = renderFields({ content_position: "top" });
    fireEvent.change(screen.getByDisplayValue("Top"), {
      target: { value: "middle" },
    });
    expect(onChange).toHaveBeenCalledWith({ content_position: undefined });
  });

  it("hides overlay and position where the copy is not on the image", () => {
    renderFields({}, false);
    expect(screen.queryByText(/Overlay/)).toBeNull();
    expect(screen.queryByText("Text position")).toBeNull();
  });
});
