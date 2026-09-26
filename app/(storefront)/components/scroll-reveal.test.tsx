// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REVEAL_ALL_EVENT } from "@/lib/themes/motion";
import { ScrollReveal } from "./scroll-reveal";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

// A controllable IntersectionObserver: tests decide what "scrolls into view".
let observers: FakeObserver[] = [];
class FakeObserver {
  observed = new Set<Element>();
  constructor(public callback: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
  arrive(el: Element) {
    this.callback(
      [{ target: el, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

/** A storefront root with sections whose tops sit at the given offsets. The
 *  viewport is 800px tall. */
function page(tops: number[]) {
  document.body.innerHTML = `<div class="storefront-root">${tops
    .map(
      (_, i) =>
        `<section class="home-section" id="s${i}"><a href="#x${i}">link ${i}</a></section>`,
    )
    .join("")}</div>`;
  tops.forEach((top, i) => {
    const el = document.getElementById(`s${i}`)!;
    el.getBoundingClientRect = () => ({ top }) as DOMRect;
  });
  return tops.map((_, i) => document.getElementById(`s${i}`)!);
}

const state = (el: Element) => el.getAttribute("data-reveal");

beforeEach(() => {
  observers = [];
  pathname = "/";
  vi.stubGlobal("IntersectionObserver", FakeObserver);
  Object.defineProperty(window, "innerHeight", {
    value: 800,
    configurable: true,
  });
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
  })) as unknown as typeof window.matchMedia;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ScrollReveal", () => {
  it("hides only sections wholly below the screen", () => {
    const [hero, second, below, far] = page([0, 500, 800, 2400]);
    render(<ScrollReveal />);
    // The first screen — including a section that starts on it — is never
    // hidden, so nothing flashes and the largest paint is never held back.
    expect(state(hero)).toBeNull();
    expect(state(second)).toBeNull();
    expect(state(below)).toBe("pending");
    expect(state(far)).toBe("pending");
    expect([...observers[0].observed]).toEqual([below, far]);
  });

  it("does not hide a section already scrolled past", () => {
    const [above] = page([-1200, 1600]);
    render(<ScrollReveal />);
    expect(state(above)).toBeNull();
  });

  it("shows a section as it arrives, then leaves no attribute behind", () => {
    const [, below] = page([0, 1200]);
    render(<ScrollReveal />);
    act(() => observers[0].arrive(below));
    expect(state(below)).toBe("shown");
    expect(observers[0].observed.has(below)).toBe(false);
    act(() => vi.advanceTimersByTime(1000));
    // No transform lingers to trap a fixed-position child.
    expect(state(below)).toBeNull();
  });

  it("hides nothing for a visitor who asks for reduced motion", () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("reduce"),
      media: query,
    })) as unknown as typeof window.matchMedia;
    const [, below] = page([0, 1200]);
    render(<ScrollReveal />);
    expect(state(below)).toBeNull();
    expect(observers).toHaveLength(0);
  });

  it("hides nothing where IntersectionObserver is missing", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const [, below] = page([0, 1200]);
    render(<ScrollReveal />);
    expect(state(below)).toBeNull();
  });

  it("shows a pending section the moment keyboard focus enters it", () => {
    const [, below] = page([0, 1200]);
    render(<ScrollReveal />);
    act(() => below.querySelector("a")!.focus());
    expect(state(below)).toBe("shown");
  });

  it("shows everything for printing and for the acceptance probe", () => {
    const [, a, b] = page([0, 1200, 2400]);
    render(<ScrollReveal />);
    act(() => {
      window.dispatchEvent(new Event(REVEAL_ALL_EVENT));
    });
    expect(state(a)).toBe("shown");
    expect(state(b)).toBe("shown");

    cleanup();
    const [, c] = page([0, 1200]);
    render(<ScrollReveal />);
    act(() => {
      window.dispatchEvent(new Event("beforeprint"));
    });
    expect(state(c)).toBe("shown");
  });

  it("clears its marks on the way out and scans the next page afresh", () => {
    const [, below] = page([0, 1200]);
    const { rerender } = render(<ScrollReveal />);
    expect(state(below)).toBe("pending");
    pathname = "/pages/about";
    rerender(<ScrollReveal />);
    // The old page's section is released; the next page's is marked.
    expect(observers).toHaveLength(2);
    expect(observers[0].observed.size).toBe(0);
    expect(state(below)).toBe("pending");
    expect(observers[1].observed.has(below)).toBe(true);
  });
});
