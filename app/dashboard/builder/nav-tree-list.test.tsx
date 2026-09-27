// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/image-upload", () => ({
  ImageUpload: ({
    onUploadSuccess,
  }: {
    onUploadSuccess: (u: string) => void;
  }) => (
    <button type="button" onClick={() => onUploadSuccess("/uploads/menu.webp")}>
      Upload menu image
    </button>
  ),
}));

import { NavTreeList } from "./chrome-form";
import type { ChromeLink } from "@/lib/chrome/types";

function renderTree(links: ChromeLink[]) {
  const onChange = vi.fn();
  render(<NavTreeList links={links} onChange={onChange} />);
  return onChange;
}

describe("NavTreeList", () => {
  it("adds a sub-link under a menu link", () => {
    const onChange = renderTree([{ label: "Shop", href: "/shop" }]);
    fireEvent.click(
      screen.getByRole("button", { name: "Add sub-link under Shop" }),
    );
    expect(onChange).toHaveBeenCalledWith([
      { label: "Shop", href: "/shop", children: [{ label: "", href: "" }] },
    ]);
  });

  it("offers an image only on a top-level link that has sub-links", () => {
    renderTree([
      { label: "About", href: "/about" },
      {
        label: "Shop",
        href: "/shop",
        children: [
          {
            label: "Men",
            href: "/men",
            children: [{ label: "Shirts", href: "/s" }],
          },
        ],
      },
    ]);
    expect(
      screen.getAllByRole("button", { name: "Upload menu image" }),
    ).toHaveLength(1);
  });

  it("stops offering sub-links at the third level", () => {
    renderTree([
      {
        label: "Shop",
        href: "/shop",
        children: [
          {
            label: "Men",
            href: "/men",
            children: [{ label: "Shirts", href: "/s" }],
          },
        ],
      },
    ]);
    expect(
      screen.getByRole("button", { name: "Add sub-link under Men" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add sub-link under Shirts" }),
    ).toBeNull();
  });

  it("stores an uploaded image on the item", () => {
    const onChange = renderTree([
      {
        label: "Shop",
        href: "/shop",
        children: [{ label: "Men", href: "/men" }],
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Upload menu image" }));
    expect(onChange).toHaveBeenCalledWith([
      {
        label: "Shop",
        href: "/shop",
        image_url: "/uploads/menu.webp",
        children: [{ label: "Men", href: "/men" }],
      },
    ]);
  });

  it("turns a row back into a plain link when its last sub-link goes", () => {
    const onChange = renderTree([
      {
        label: "Shop",
        href: "/shop",
        image_url: "/x.webp",
        children: [{ label: "Men", href: "/men" }],
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Men" }));
    expect(onChange).toHaveBeenCalledWith([{ label: "Shop", href: "/shop" }]);
  });
});
