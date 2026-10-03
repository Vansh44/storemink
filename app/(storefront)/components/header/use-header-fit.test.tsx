// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { useRef, type CSSProperties } from "react";
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

function Harness({ initialHeight }: { initialHeight?: string }) {
  const ref = useRef<HTMLElement>(null);
  useHeaderFit(ref, CLASSES, []);
  return (
    <div
      className="storefront-root"
      style={{ "--sm-header-h": initialHeight } as CSSProperties}
    >
      <header ref={ref}>
        <a className="logo">Shop</a>
        <nav className="nav">links</nav>
        <div className="right">
          <div className="search">search</div>
        </div>
      </header>
    </div>
  );
}

let transitionsOffDuringMeasure: boolean[] = [];
let headerHeight = 68;
let onResize: (() => void) | undefined;
let nextFrame: FrameRequestCallback | undefined;

beforeEach(() => {
  transitionsOffDuringMeasure = [];
  headerHeight = 68;
  onResize = undefined;
  nextFrame = undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        onResize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    nextFrame = callback;
    return 1;
  });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      if (this.tagName === "HEADER") {
        return {
          left: 0,
          right: 1024,
          width: 1024,
          height: headerHeight,
          top: 0,
          bottom: headerHeight,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
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
  vi.unstubAllGlobals();
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
    expect(
      container
        .querySelector<HTMLElement>(".storefront-root")!
        .style.getPropertyValue("--sm-header-h"),
    ).toBe("68px");
  });

  it("refreshes clearance when the bar grows or shrinks", () => {
    const { container } = render(<Harness />);
    const root = container.querySelector<HTMLElement>(".storefront-root")!;
    for (const [height, expected] of [
      [92.4, "93px"],
      [60, "60px"],
    ] as const) {
      headerHeight = height;
      act(() => {
        onResize?.();
        nextFrame?.(0);
      });
      expect(root.style.getPropertyValue("--sm-header-h")).toBe(expected);
    }
  });

  it("restores an existing height override when unmounted", () => {
    const { container, unmount } = render(<Harness initialHeight="80px" />);
    const root = container.querySelector<HTMLElement>(".storefront-root")!;
    expect(root.style.getPropertyValue("--sm-header-h")).toBe("68px");
    unmount();
    expect(root.style.getPropertyValue("--sm-header-h")).toBe("80px");
  });

  it("keeps the fallback when the bar has no measurable height", () => {
    headerHeight = 0;
    const { container } = render(<Harness initialHeight="80px" />);
    expect(
      container
        .querySelector<HTMLElement>(".storefront-root")!
        .style.getPropertyValue("--sm-header-h"),
    ).toBe("80px");
  });
});
