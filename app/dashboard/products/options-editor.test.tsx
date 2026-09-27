// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OptionsEditor } from "./options-editor";
import type { ProductOption } from "@/lib/products/options";

function renderEditor(options: ProductOption[], legacyNames: string[] = []) {
  const onChange = vi.fn();
  render(
    <OptionsEditor
      options={options}
      onChange={onChange}
      legacyNames={legacyNames}
    />,
  );
  return onChange;
}

describe("OptionsEditor", () => {
  it("turns existing plain variants into the first option's values", () => {
    const onChange = renderEditor([], ["S", "M", "S", "S/M"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Add options like size or colour" }),
    );
    // Duplicates collapse and a name holding the separator is left out.
    expect(onChange).toHaveBeenCalledWith([{ name: "", values: ["S", "M"] }]);
  });

  it("adds values as tags on Enter and on a comma, never twice", () => {
    const onChange = renderEditor([{ name: "Size", values: ["S"] }]);
    const input = screen.getByLabelText("Values");
    fireEvent.change(input, { target: { value: "M" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith([
      { name: "Size", values: ["S", "M"] },
    ]);
    fireEvent.change(input, { target: { value: "s, L," } });
    expect(onChange).toHaveBeenLastCalledWith([
      { name: "Size", values: ["S", "L"] },
    ]);
  });

  it("guesses a swatch for each value when swatches are switched on", () => {
    const onChange = renderEditor([
      { name: "Colour", values: ["Navy blue", "Mystery"] },
    ]);
    fireEvent.click(
      screen.getByLabelText("Show as colour swatches on the storefront"),
    );
    expect(onChange).toHaveBeenCalledWith([
      {
        name: "Colour",
        values: ["Navy blue", "Mystery"],
        swatches: { "Navy blue": "#1b2a4a", Mystery: "#9ca3af" },
      },
    ]);
  });

  it("removes a value's swatch with the value", () => {
    const onChange = renderEditor([
      {
        name: "Colour",
        values: ["Black", "Tan"],
        swatches: { Black: "#111111", Tan: "#c19a6b" },
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Remove Tan" }));
    expect(onChange).toHaveBeenCalledWith([
      { name: "Colour", values: ["Black"], swatches: { Black: "#111111" } },
    ]);
  });

  it("explains an option set the save would refuse", () => {
    renderEditor([{ name: "Size", values: ["M", "m"] }]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      '"Size" lists "m" twice.',
    );
  });

  it("stops offering options at three", () => {
    renderEditor([
      { name: "A", values: ["x"] },
      { name: "B", values: ["y"] },
      { name: "C", values: ["z"] },
    ]);
    expect(
      screen.queryByRole("button", { name: /add another option/i }),
    ).toBeNull();
  });
});
