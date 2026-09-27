// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEADER_COMPACT_ATTR, useHeaderFit } from "./use-header-fit";

// jsdom lays nothing out, so the header here reports rectangles from a table
// keyed on how much is folded — the shape a real one has: the menu collides
// with the search box until it moves to the drawer.

const CLASSES = {
  logo: "logo",
  navLinks: "nav",
  headerRight: "right",
  searchWrap: "search",
};

type Rect = [left: number, right: number];
const RECTS: Record<string, Record<string, Rect>> = {
  "": { logo: [24, 160], nav: [200, 620], search: [600, 800] },
  nav: { logo: [24, 160], nav: [0, 0], search: [500, 700] },
};

function Harness() {
  const ref = useRef<HTMLElement>(null);
  useHeaderFit(ref, CLASSES, []);
  return (
    <header ref={ref}>
      <a className="logo">Shop</a>
      <nav className="nav">links</nav>
      <div className="right">
        <div className="search">search</div>
      </div>
    </header>
  );
}

let transitionsOffDuringMeasure: boolean[] = [];

beforeEach(() => {
  transitionsOffDuringMeasure = [];
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const header = this.closest("header")!;
      transitionsOffDuringMeasure.push(
        header.hasAttribute("data-header-measuring"),
      );
      const state = header.getAttribute(HEADER_COMPACT_ATTR) ?? "";
      const table = RECTS[state] ?? RECTS.nav;
      const [left, right] = table[this.className] ?? [0, 0];
      return {
        left,
        right,
        width: right - left,
        height: right > left ? 40 : 0,
        top: 0,
        bottom: 40,
        x: left,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    },
  );
  window.matchMedia = vi.fn(() => ({ matches: false })) as never;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useHeaderFit", () => {
  it("folds the menu when it collides with the search box", () => {
    const { container } = render(<Harness />);
    const header = container.querySelector("header")!;
    expect(header.getAttribute(HEADER_COMPACT_ATTR)).toBe("nav");
  });

  it("folds nothing when the full header fits", () => {
    RECTS[""].search = [660, 860];
    try {
      const { container } = render(<Harness />);
      expect(
        container.querySelector("header")!.getAttribute(HEADER_COMPACT_ATTR),
      ).toBe("");
    } finally {
      RECTS[""].search = [600, 800];
    }
  });

  it("measures with transitions off, then gives them back", () => {
    const { container } = render(<Harness />);
    expect(transitionsOffDuringMeasure.length).toBeGreaterThan(0);
    expect(transitionsOffDuringMeasure.every(Boolean)).toBe(true);
    expect(
      container.querySelector("header")!.hasAttribute("data-header-measuring"),
    ).toBe(false);
  });

  it("leaves phones to CSS", () => {
    window.matchMedia = vi.fn(() => ({ matches: true })) as never;
    const { container } = render(<Harness />);
    expect(
      container.querySelector("header")!.getAttribute(HEADER_COMPACT_ATTR),
    ).toBe("");
    expect(transitionsOffDuringMeasure).toEqual([]);
  });
});
