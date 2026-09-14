// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NumberField } from "./number-field";

describe("NumberField", () => {
  it("distinguishes an explicit zero from an empty optional value", () => {
    const onValueChange = vi.fn();
    render(
      <NumberField aria-label="Cost" value={1} onValueChange={onValueChange} />,
    );

    const input = screen.getByRole("textbox", { name: "Cost" });
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.change(input, { target: { value: "" } });

    expect(onValueChange).toHaveBeenNthCalledWith(1, 0, "0");
    expect(onValueChange).toHaveBeenNthCalledWith(2, 0, "");
  });
});
