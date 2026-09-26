// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./code-editor-lazy", () => ({ default: () => null }));

import { StyleForm } from "./inspector-panel";
import type { SchemeDesign } from "@/lib/themes/schemes";
import type { SectionStyle } from "@/lib/homepage/section-types";

const schemeDesign: SchemeDesign = {
  palette: {
    cream: "#ffffff",
    creamDeep: "#f2f0ec",
    surface: "#ffffff",
    ink: "#111111",
    onInk: "#ffffff",
    onAccent: "#ffffff",
    accent: "#2542c7",
  },
};

function renderForm(
  style: SectionStyle,
  sectionType: Parameters<typeof StyleForm>[0]["sectionType"] = "media_text",
  design = schemeDesign,
) {
  const onChange = vi.fn();
  render(
    <StyleForm
      sectionType={sectionType}
      style={style}
      onChange={onChange}
      schemeDesign={design}
      brandPrimary="#000000"
    />,
  );
  return onChange;
}

describe("Style tab colour scheme", () => {
  it("offers Page plus the four schemes, painted in their real colours", () => {
    renderForm({});
    const group = screen.getByRole("radiogroup", { name: "Colour scheme" });
    const radios = Array.from(group.querySelectorAll('[role="radio"]'));
    expect(radios.map((r) => r.textContent)).toEqual([
      "AaPage",
      "AaSoft",
      "AaTinted",
      "AaBrand",
      "AaDark",
    ]);
    expect(screen.getByRole("radio", { name: /Page/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const dark = screen
      .getByRole("radio", { name: /Dark/ })
      .querySelector(".sm-builder-scheme-swatch") as HTMLElement;
    expect(dark.style.background).toBe("rgb(17, 17, 17)");
  });

  it("picking a scheme clears a custom background and adds padding", () => {
    const onChange = renderForm({ background: "#123456", padding_y: "none" });
    fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    expect(onChange).toHaveBeenCalledWith({
      scheme: "inverse",
      background: undefined,
      padding_y: "md",
    });
  });

  it("keeps padding the merchant already chose", () => {
    const onChange = renderForm({ padding_y: "lg" });
    fireEvent.click(screen.getByRole("radio", { name: /Soft/ }));
    expect(onChange.mock.calls[0][0]).toMatchObject({
      scheme: "soft",
      padding_y: "lg",
    });
  });

  it("Page removes the scheme", () => {
    const onChange = renderForm({ scheme: "soft", padding_y: "md" });
    fireEvent.click(screen.getByRole("radio", { name: /Page/ }));
    expect(onChange.mock.calls[0][0].scheme).toBeUndefined();
  });

  it("hides the background field while a scheme owns the colours", () => {
    renderForm({ scheme: "tint" });
    expect(screen.queryByText("Background color")).toBeNull();
    expect(
      screen.getByText(/Text, cards and buttons change with it/),
    ).toBeTruthy();
  });

  it("warns when a scheme is hard to read with the current colours", () => {
    renderForm({ scheme: "soft" }, "media_text", {
      ...schemeDesign,
      schemes: { soft: { background: "#dddddd", text: "#bbbbbb" } },
    });
    expect(screen.getByText(/hard to read in this scheme/)).toBeTruthy();
  });

  it("the Contrast preset picks the Dark scheme, not a raw colour", () => {
    const onChange = renderForm({});
    fireEvent.click(screen.getByRole("button", { name: "Contrast" }));
    expect(onChange.mock.calls[0][0]).toMatchObject({
      scheme: "inverse",
      background: undefined,
    });
  });

  it("a section on its own photo gets no scheme picker or scheme presets", () => {
    renderForm({}, "hero_carousel");
    expect(
      screen.queryByRole("radiogroup", { name: "Colour scheme" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Contrast" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Tinted" })).toBeNull();
    expect(screen.getByText("Background color")).toBeTruthy();
  });
});
