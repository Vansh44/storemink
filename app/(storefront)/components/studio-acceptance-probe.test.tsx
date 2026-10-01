// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import axe from "axe-core";
import { StudioAcceptanceProbe } from "./studio-acceptance-probe";

vi.mock("axe-core", () => ({
  default: { run: vi.fn(async () => ({ violations: [] })) },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)
    .innerText;
});

it("reports distinct failing elements and axe's contrast measurements", async () => {
  vi.useFakeTimers();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const price =
    "Element has insufficient color contrast of 2.1 (foreground #aaaaaa, background #ffffff, expected 4.5:1).";
  vi.mocked(axe.run).mockResolvedValueOnce({
    violations: [
      {
        id: "color-contrast",
        impact: "serious",
        help: "Elements must meet minimum color contrast ratio thresholds",
        nodes: [
          ...Array.from({ length: 20 }, (_, i) => ({
            target: [`.shop-card:nth-child(${i + 1}) > .shop-card-base`],
            failureSummary: price,
          })),
          {
            target: [".shop-card-off"],
            failureSummary: "Discount text fails contrast of 2.5:1.",
          },
          {
            target: [".columnTitle"],
            failureSummary: "Footer heading fails contrast of 2.3:1.",
          },
        ],
      },
    ],
  } as never);
  render(<StudioAcceptanceProbe />);
  const pending = window.__smThemeStudioMeasure!();
  await vi.runAllTimersAsync();
  const evidence = await pending;
  expect(evidence.violations).toEqual([
    expect.objectContaining({
      id: "color-contrast",
      nodes: 22,
      examples: [
        { target: ".shop-card:nth-child(1) > .shop-card-base", summary: price },
        {
          target: ".shop-card-off",
          summary: "Discount text fails contrast of 2.5:1.",
        },
        {
          target: ".columnTitle",
          summary: "Footer heading fails contrast of 2.3:1.",
        },
      ],
    }),
  ]);
});

it("distinguishes deliberate clipping and labelled controls from real defects", async () => {
  vi.useFakeTimers();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 360,
  });
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent ?? "";
    },
  });
  const { container } = render(
    <>
      <StudioAcceptanceProbe />
      <label
        id="hidden"
        style={{
          opacity: 1,
          overflowX: "hidden",
          clip: "rect(0px, 0px, 0px, 0px)",
        }}
      >
        Accessible label
      </label>
      <p
        id="ellipsis"
        style={{ opacity: 1, overflowX: "hidden", textOverflow: "ellipsis" }}
      >
        Long name
      </p>
      <p
        id="clamp"
        style={{ opacity: 1, overflowY: "hidden", WebkitLineClamp: 2 }}
      >
        Long description
      </p>
      <div className="home-ticker" style={{ opacity: 1, overflowX: "hidden" }}>
        <div
          className="home-ticker-track"
          style={{ animationName: "home-ticker-scroll" }}
        >
          Moving text
        </div>
      </div>
      <p id="broken" style={{ opacity: 1, overflowX: "hidden" }}>
        Unintentionally clipped text
      </p>
      <label id="consent">
        <input type="checkbox" style={{ opacity: 1 }} />
        Subscribe
      </label>
      <button id="tiny" style={{ opacity: 1 }}>
        Buy
      </button>
    </>,
  );
  for (const id of ["hidden", "ellipsis", "clamp", "broken"]) {
    Object.defineProperties(container.querySelector(`#${id}`)!, {
      scrollWidth: { value: id === "clamp" ? 100 : 200 },
      clientWidth: { value: id === "hidden" ? 1 : 100 },
      scrollHeight: { value: id === "clamp" ? 60 : 20 },
      clientHeight: { value: id === "hidden" ? 1 : 20 },
    });
  }
  Object.defineProperties(container.querySelector(".home-ticker")!, {
    scrollWidth: { value: 2000 },
    clientWidth: { value: 360 },
  });
  const rect = (width: number, height: number) => ({
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON() {},
  });
  for (const [selector, width, height] of [
    ["input", 13, 13],
    ["#consent", 150, 30],
    ["#tiny", 20, 20],
  ] as const) {
    vi.spyOn(
      container.querySelector(selector)!,
      "getBoundingClientRect",
    ).mockReturnValue(rect(width, height));
  }
  const pending = window.__smThemeStudioMeasure!();
  await vi.runAllTimersAsync();
  const evidence = await pending;
  expect(evidence.clippedText).toEqual([
    { target: "p#broken", clippedX: 100, clippedY: 0 },
  ]);
  expect(evidence.smallTapTargets).toEqual([
    { target: "button#tiny", width: 20, height: 20 },
  ]);
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
