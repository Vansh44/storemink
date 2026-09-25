import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chooseCompaction,
  COMPACT_STEPS,
  headerFits,
  type CompactStep,
  type HeaderLayout,
} from "./header-fit";

const layout = (
  items: HeaderLayout["items"],
  width = 1000,
  scrollWidth = width,
): HeaderLayout => ({ clientWidth: width, scrollWidth, items });

describe("headerFits", () => {
  it("accepts a row with clear space between every item", () => {
    expect(
      headerFits(
        layout([
          { left: 24, right: 160 },
          { left: 200, right: 600 },
          { left: 640, right: 976 },
        ]),
      ),
    ).toBe(true);
  });

  it("rejects items that touch or overlap", () => {
    const logo = { left: 24, right: 160 };
    expect(headerFits(layout([logo, { left: 150, right: 400 }]))).toBe(false);
    // Clear of each other, but by less than the minimum gap.
    expect(headerFits(layout([logo, { left: 165, right: 400 }]))).toBe(false);
    expect(headerFits(layout([logo, { left: 172, right: 400 }]))).toBe(true);
  });

  it("judges by position, not by the order items were read in", () => {
    // The centred header puts the menu left of the logo it follows in the DOM.
    expect(
      headerFits(
        layout([
          { left: 460, right: 600 }, // logo
          { left: 24, right: 440 }, // menu
          { left: 612, right: 976 },
        ]),
      ),
    ).toBe(true);
  });

  it("rejects a header wider than the screen", () => {
    expect(headerFits(layout([{ left: 24, right: 200 }], 800, 817))).toBe(
      false,
    );
  });

  it("rejects a control squeezed below its minimum", () => {
    const search = (w: number) => ({
      left: 300,
      right: 300 + w,
      minWidth: 140,
    });
    expect(headerFits(layout([search(163)]))).toBe(true);
    expect(headerFits(layout([search(100)]))).toBe(false);
  });
});

describe("chooseCompaction", () => {
  // A fake header that only fits once `fitsAt` steps are folded.
  const header = (fitsAt: number) => {
    const seen: string[] = [];
    const measure = (steps: readonly CompactStep[]) => {
      seen.push(steps.join(" "));
      return steps.length >= fitsAt
        ? layout([{ left: 0, right: 100 }])
        : layout([
            { left: 0, right: 100 },
            { left: 50, right: 200 },
          ]);
    };
    return { measure, seen };
  };

  it("folds nothing when the full header fits", () => {
    const h = header(0);
    expect(chooseCompaction(h.measure)).toEqual([]);
    expect(h.seen).toEqual([""]);
  });

  it("folds one step at a time, menu first, and stops at the first fit", () => {
    const h = header(2);
    expect(chooseCompaction(h.measure)).toEqual(["nav", "delivery"]);
    expect(h.seen).toEqual(["", "nav", "nav delivery"]);
  });

  it("folds everything when nothing else fits", () => {
    const h = header(99);
    expect(chooseCompaction(h.measure)).toEqual([...COMPACT_STEPS]);
  });
});

describe("every step folds something", () => {
  // A step with no CSS behind it would be reported as taken while the header
  // still overlaps, and the drawer would never gain what it promised.
  const header = readFileSync(
    "app/(storefront)/components/header/Header.module.css",
    "utf8",
  );
  const delivery = readFileSync(
    "app/(storefront)/components/delivery/delivery-location.module.css",
    "utf8",
  );
  const rule = (css: string, selector: string) =>
    new RegExp(
      selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{[^}]*display:",
    ).test(css);

  it("nav hides the menu and shows the hamburger", () => {
    expect(rule(header, '.header[data-header-compact~="nav"] .navLinks')).toBe(
      true,
    );
    expect(
      rule(header, '.header[data-header-compact~="nav"] .hamburgerBtn'),
    ).toBe(true);
  });

  it("delivery moves from the header to the drawer", () => {
    expect(
      rule(
        delivery,
        ':global([data-header-compact~="delivery"]) .root:not(.drawerRoot)',
      ),
    ).toBe(true);
    expect(
      rule(delivery, ':global([data-header-compact~="delivery"]) .drawerRoot'),
    ).toBe(true);
  });

  it("search swaps the box for the search icon", () => {
    expect(
      rule(
        header,
        '.header[data-header-compact~="search"] .searchWrap:not(.searchWrapSheet)',
      ),
    ).toBe(true);
    expect(
      rule(header, '.header[data-header-compact~="search"] .phoneSearchBtn'),
    ).toBe(true);
  });

  it("covers every step there is", () => {
    for (const step of COMPACT_STEPS) {
      expect(`${header}\n${delivery}`).toContain(
        `[data-header-compact~="${step}"]`,
      );
    }
  });
});
