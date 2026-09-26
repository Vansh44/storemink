// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { StickyAddToCart } from "./sticky-add-to-cart";

type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;
let fire: Callback = () => {};

function installObserver() {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: Callback) {
        fire = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
}

afterEach(() => vi.unstubAllGlobals());

function renderBar(disabled = false, onAdd = vi.fn()) {
  const target = createRef<HTMLDivElement>();
  const utils = render(
    <>
      <div ref={target} />
      <StickyAddToCart
        target={target}
        name="Linen shirt"
        variantName="M"
        image="/a.webp"
        price={1499}
        compareAt={1999}
        disabled={disabled}
        onAdd={onAdd}
      />
    </>,
  );
  return { ...utils, onAdd };
}

const bar = (c: HTMLElement) => c.querySelector(".sm-sticky-atc")!;

describe("StickyAddToCart", () => {
  it("appears only once the real buttons scrolled away ABOVE the shopper", () => {
    installObserver();
    const { container } = renderBar();
    expect(bar(container).className).not.toContain("is-shown");
    // Still below the fold (not yet reached): stays hidden.
    act(() =>
      fire([
        { isIntersecting: false, boundingClientRect: { top: 900 } as DOMRect },
      ]),
    );
    expect(bar(container).className).not.toContain("is-shown");
    // Scrolled past: shown.
    act(() =>
      fire([
        { isIntersecting: false, boundingClientRect: { top: -40 } as DOMRect },
      ]),
    );
    expect(bar(container).className).toContain("is-shown");
    expect(bar(container).getAttribute("aria-hidden")).toBe("false");
    // Back in view: hidden again, so two buy buttons never show together.
    act(() =>
      fire([
        { isIntersecting: true, boundingClientRect: { top: 200 } as DOMRect },
      ]),
    );
    expect(bar(container).className).not.toContain("is-shown");
  });

  it("buys through the page's own handler and shows the sale price", () => {
    installObserver();
    const { onAdd } = renderBar();
    expect(screen.getByText("M · ₹1,499")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { hidden: true }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("is disabled when the selected option is sold out", () => {
    installObserver();
    renderBar(true);
    const button = screen.getByRole("button", { hidden: true });
    expect(button.textContent).toBe("Sold out");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
