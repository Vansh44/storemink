// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StudioAcceptanceProbe } from "./studio-acceptance-probe";

vi.mock("axe-core", () => ({
  default: { run: vi.fn(async () => ({ violations: [] })) },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("measures a storefront containing SVG icons and still detects clipped HTML text", async () => {
  vi.useFakeTimers();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  // jsdom does not implement innerText. Match browsers: only HTML has it.
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent ?? "";
    },
  });
  const { container } = render(
    <>
      <StudioAcceptanceProbe />
      <button>
        <svg>
          <path d="M0 0" />
        </svg>
        Search
      </button>
      <p style={{ overflowX: "hidden", opacity: 1 }}>Clipped heading</p>
    </>,
  );
  const paragraph = container.querySelector("p")!;
  Object.defineProperties(paragraph, {
    scrollWidth: { value: 200 },
    clientWidth: { value: 100 },
  });
  expect(container.querySelector("svg")).not.toHaveProperty("innerText");
  const pending = window.__smThemeStudioMeasure!();
  await vi.runAllTimersAsync();
  const evidence = await pending;
  expect(evidence.clippedText).toEqual([
    { target: "p", clippedX: 100, clippedY: 0 },
  ]);
  expect(evidence.violations).toEqual([]);
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)
    .innerText;
});
