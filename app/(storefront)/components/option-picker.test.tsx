// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OptionPicker } from "./option-picker";

const options = [
  { name: "Size", values: ["S", "M", "L"] },
  {
    name: "Colour",
    values: ["Black", "Tan"],
    swatches: { Black: "#111111", Tan: "#c19a6b" },
  },
];
const variants = [
  { id: "sb", option_values: ["S", "Black"], available: true },
  { id: "st", option_values: ["S", "Tan"], available: false },
  { id: "mb", option_values: ["M", "Black"], available: true },
  { id: "mt", option_values: ["M", "Tan"], available: true },
  { id: "lt", option_values: ["L", "Tan"], available: true },
];

function renderPicker(selectedId = "sb") {
  const onSelect = vi.fn();
  render(
    <OptionPicker
      options={options}
      variants={variants}
      selectedId={selectedId}
      onSelect={onSelect}
    />,
  );
  return onSelect;
}

describe("OptionPicker", () => {
  it("names each option and the value chosen for it", () => {
    renderPicker("mt");
    expect(screen.getByText("Size").closest("legend")).toHaveTextContent(
      "Size: M",
    );
    expect(screen.getByRole("button", { name: "Size M" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Colour Tan" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("renders a swatch axis as colours, labelled for screen readers", () => {
    renderPicker();
    const black = screen.getByRole("button", { name: "Colour Black" });
    expect(black).toHaveClass("is-swatch");
    expect(
      black.querySelector<HTMLElement>(".sm-opt-swatch")?.style.backgroundColor,
    ).toBe("rgb(17, 17, 17)");
  });

  it("marks a sold-out and a missing combination without hiding either", () => {
    renderPicker("sb");
    // S / Tan exists but is sold out.
    expect(
      screen.getByRole("button", { name: "Colour Tan, sold out" }),
    ).toHaveClass("is-unavailable");
    // L / Black does not exist at all.
    expect(
      screen.getByRole("button", {
        name: "Size L, not available with this selection",
      }),
    ).toHaveClass("is-unavailable");
  });

  it("moves to a real variant when a combination does not exist", () => {
    const onSelect = renderPicker("sb");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Size L, not available with this selection",
      }),
    );
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "lt" }),
    );
  });

  it("keeps the other picks when the exact combination exists", () => {
    const onSelect = renderPicker("mb");
    fireEvent.click(screen.getByRole("button", { name: "Colour Tan" }));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "mt" }),
    );
  });

  it("does nothing when the value is already chosen", () => {
    const onSelect = renderPicker("sb");
    fireEvent.click(screen.getByRole("button", { name: "Size S" }));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
