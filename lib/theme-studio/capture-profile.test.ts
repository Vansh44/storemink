import { expect, it } from "vitest";
import { parseCaptureTiming, parseCapturedRoutes } from "./capture-profile";

it("rejects unbounded or malformed diagnostics and strips extra payload", () => {
  const timing = {
    browserMs: 100,
    catalogMs: 10,
    qaMs: 90,
    samples: [
      {
        viewport: "phone360",
        surface: "home",
        navigationMs: 20,
        probeMs: 30,
        screenshotMs: 40,
        secret: "ignore",
      },
    ],
    extra: "ignore",
  };
  expect(parseCaptureTiming(timing)?.samples[0]).not.toHaveProperty("secret");
  expect(parseCaptureTiming({ ...timing, browserMs: Infinity })).toBeNull();
  expect(
    parseCaptureTiming({
      ...timing,
      samples: Array(31).fill(timing.samples[0]),
    }),
  ).toBeNull();
});
it("binds reusable HTML to exact planned paths/surfaces and ignores malformed, duplicate or oversized responses", () => {
  const route = {
    path: "/",
    surface: "home",
    status: 200,
    html: "<main>storefront</main>",
    robots: "noindex",
  };
  const pages = [{ path: "/", surface: "home" }];
  expect(parseCapturedRoutes([route], pages)).toEqual([route]);
  expect(parseCapturedRoutes([route, route], pages)).toEqual([]);
  expect(
    parseCapturedRoutes(
      [route, { ...route, html: "different response" }],
      [...pages, { path: "/shop", surface: "shop" }],
    ),
  ).toEqual([]);
  expect(
    parseCapturedRoutes([{ ...route, path: "/unplanned" }], pages),
  ).toEqual([]);
  expect(parseCapturedRoutes([{ ...route, surface: "shop" }], pages)).toEqual(
    [],
  );
  expect(parseCapturedRoutes([{ ...route, status: "200" }], pages)).toEqual([]);
  expect(
    parseCapturedRoutes(
      [{ ...route, html: "x".repeat(1024 * 1024 + 1) }],
      pages,
    ),
  ).toEqual([]);
});
