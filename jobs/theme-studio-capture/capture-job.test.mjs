import { describe, expect, it, vi } from "vitest";
import {
  CaptureError,
  errorCode,
  runCaptureJob,
  takeQaScreenshots,
  takeShots,
  mapCaptureWork,
  CAPTURE_WINDOW_MS,
  DEFAULT_BUDGET_MS,
  FINISH_TIMEOUT_MS,
  MIN_CAPTURE_MS,
  MAX_QA_CONTEXTS,
} from "./capture-job.mjs";

const claim = {
  captureId: "c-1",
  leaseToken: "l-1",
  origin: "http://studio-preview-ab.localhost:3000",
  cookie: { name: "sm_studio_capture", value: "token" },
  shots: [
    {
      slotId: "preview",
      path: "/",
      viewport: { width: 1280, height: 960 },
      deviceScaleFactor: 2,
      mobile: false,
    },
    {
      slotId: "screenshot-mobile",
      path: "/",
      viewport: { width: 390, height: 823 },
      deviceScaleFactor: 3,
      mobile: true,
    },
  ],
};

/** A browser whose every page answers `status` and screenshots `bytes`. */
function fakeBrowser({ status = 200, failOn } = {}) {
  const contexts = [];
  const browser = {
    close: vi.fn(async () => {}),
    newContext: vi.fn(async (options) => {
      const context = {
        options,
        cookies: [],
        visited: [],
        styles: [],
        closed: false,
        async addCookies(list) {
          context.cookies.push(...list);
        },
        async newPage() {
          return {
            async goto(url) {
              context.visited.push(url);
              if (failOn === "goto")
                throw new Error("Timeout 60000ms exceeded");
              return { status: () => status };
            },
            async waitForLoadState() {},
            async waitForFunction() {
              if (failOn === "probe") throw new Error("Timeout");
            },
            async addStyleTag(style) {
              context.styles.push(style.content);
            },
            async evaluate() {
              return {
                path: "/",
                width: options.viewport.width,
                height: options.viewport.height,
                overflowPx: 0,
                overflowOffenders: [],
                clippedText: [],
                smallTapTargets: [],
                imageCropIssues: [],
                brokenImages: 0,
                violations: [],
                lcpMs: 900,
                cls: 0,
              };
            },
            async waitForTimeout() {},
            async screenshot(opts) {
              context.screenshot = opts;
              return Buffer.from(`${options.viewport.width}`);
            },
            async close() {},
          };
        },
        async close() {
          context.closed = true;
        },
      };
      contexts.push(context);
      return context;
    }),
  };
  return { browser, contexts };
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

describe("taking the shots", () => {
  it("bounds parallel browser work, preserves order and drains in-flight work on failure", async () => {
    let active = 0,
      peak = 0;
    const results = await mapCaptureWork([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, n === 1 ? 15 : 1));
      active--;
      return n;
    });
    expect(peak).toBe(2);
    expect(results).toEqual([1, 2, 3, 4, 5]);
    // The helper honours what it is asked for; the QA cap lives in one place.
    let widest = 0;
    let running = 0;
    await mapCaptureWork([1, 2, 3, 4], 3, async () => {
      running++;
      widest = Math.max(widest, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running--;
    });
    expect(widest).toBe(3);
    let drained = false;
    await expect(
      mapCaptureWork([1, 2, 3], 2, async (n) => {
        if (n === 1) throw new Error("broken page");
        await new Promise((resolve) => setTimeout(resolve, 10));
        drained = true;
      }),
    ).rejects.toThrow("broken page");
    expect(drained).toBe(true);
  });
  it("opens each shot in its own context at its size and device, with the capture cookie", async () => {
    const { browser, contexts } = fakeBrowser();
    const images = await takeShots(browser, claim, { settleMs: 0 });
    expect(images).toEqual([
      { slotId: "preview", base64: Buffer.from("1280").toString("base64") },
      {
        slotId: "screenshot-mobile",
        base64: Buffer.from("390").toString("base64"),
      },
    ]);
    expect(contexts[0].options).toMatchObject({
      viewport: { width: 1280, height: 960 },
      deviceScaleFactor: 2,
      isMobile: false,
      reducedMotion: "reduce",
    });
    expect(contexts[1].options).toMatchObject({
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    expect(contexts[1].options.userAgent).toMatch(/Mobile/);
    for (const context of contexts) {
      expect(context.cookies).toEqual([
        { name: "sm_studio_capture", value: "token", url: claim.origin },
      ]);
      expect(context.visited).toEqual([`${claim.origin}/`]);
      expect(context.screenshot).toEqual({ type: "jpeg", quality: 92 });
      expect(context.styles).toEqual(["nextjs-portal{display:none!important}"]);
      expect(context.closed).toBe(true);
    }
  });

  it("refuses a page that is not the storefront, and still closes the context", async () => {
    const { browser, contexts } = fakeBrowser({ status: 404 });
    await expect(takeShots(browser, claim, { settleMs: 0 })).rejects.toEqual(
      new CaptureError("preview_status_404"),
    );
    expect(contexts[0].closed).toBe(true);
  });

  it("turns what a browser throws into a closed code", () => {
    expect(errorCode(new CaptureError("preview_status_500"))).toBe(
      "preview_status_500",
    );
    expect(errorCode(new Error("Timeout 60000ms exceeded"))).toBe(
      "capture_timeout",
    );
    expect(errorCode(new Error("net::ERR_CONNECTION_REFUSED"))).toBe(
      "capture_network",
    );
    expect(errorCode("something else")).toBe("capture_browser_error");
  });

  it("reuses the preview to measure and screenshot every QA page and width", async () => {
    const { browser, contexts } = fakeBrowser();
    const qa = await takeQaScreenshots(
      browser,
      {
        ...claim,
        qa: {
          pages: [
            { surface: "home", path: "/" },
            { surface: "shop", path: "/shop" },
          ],
          viewports: {
            phone360: { width: 360, height: 800 },
            desktop1440: { width: 1440, height: 900 },
          },
        },
      },
      { settleMs: 0 },
    );
    expect(qa.evidence.samples).toHaveLength(4);
    expect(qa.evidence.samples.map((sample) => sample.viewport)).toEqual([
      "phone360",
      "phone360",
      "desktop1440",
      "desktop1440",
    ]);
    expect(qa.evidence.samples.map((sample) => sample.surface)).toEqual([
      "home",
      "shop",
      "home",
      "shop",
    ]);
    expect(qa.screenshots.map((shot) => shot.key)).toEqual([
      "phone360:home",
      "phone360:shop",
      "desktop1440:home",
      "desktop1440:shop",
    ]);
    expect(contexts).toHaveLength(2);
    expect(contexts[0].screenshot).toEqual({
      type: "jpeg",
      quality: 55,
      fullPage: true,
    });
  });
});

describe("the job", () => {
  it("claims, shoots and posts until nothing is queued, launching one browser", async () => {
    const { browser } = fakeBrowser();
    const launch = vi.fn(async () => browser);
    const calls = [];
    const answers = [
      response(200, claim),
      response(200, { status: "succeeded", versionId: "v-9" }),
      response(204),
    ];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return answers.shift();
    });
    const results = await runCaptureJob({
      appOrigin: "http://localhost:3000",
      cronSecret: "s3cret",
      launch,
      fetchImpl,
      log: {},
    });
    expect(calls.map((c) => c.url)).toEqual([
      "http://localhost:3000/api/internal/theme-studio/captures/claim",
      "http://localhost:3000/api/internal/theme-studio/captures/c-1",
      "http://localhost:3000/api/internal/theme-studio/captures/claim",
    ]);
    for (const call of calls) {
      expect(call.init.headers.authorization).toBe("Bearer s3cret");
    }
    const posted = JSON.parse(calls[1].init.body);
    expect(posted.leaseToken).toBe("l-1");
    expect(posted.images.map((i) => i.slotId)).toEqual([
      "preview",
      "screenshot-mobile",
    ]);
    expect(results).toEqual([
      { captureId: "c-1", http: 200, status: "succeeded", versionId: "v-9" },
    ]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("reports a failed shot as an error code, never as pictures", async () => {
    const { browser } = fakeBrowser({ failOn: "goto" });
    const answers = [
      response(200, claim),
      response(200, { status: "requeued" }),
      response(204),
    ];
    const bodies = [];
    await runCaptureJob({
      appOrigin: "http://localhost:3000",
      cronSecret: "s",
      launch: async () => browser,
      fetchImpl: async (_url, init) => {
        if (init.body) bodies.push(JSON.parse(init.body));
        return answers.shift();
      },
      log: {},
    });
    expect(bodies).toEqual([{ leaseToken: "l-1", error: "capture_timeout" }]);
  });

  it("includes browser launch in the deadline and closes a browser that arrives late", async () => {
    const { browser } = fakeBrowser();
    let launched;
    const times = [0, 0, 299_990];
    const bodies = [];
    await runCaptureJob({
      appOrigin: "http://localhost:3000",
      cronSecret: "s",
      maxCaptures: 1,
      now: () => times.shift() ?? 300_000,
      launch: () =>
        new Promise((resolve) => {
          launched = resolve;
        }),
      fetchImpl: async (_url, init) => {
        if (!init.body) return response(200, claim);
        bodies.push(JSON.parse(init.body));
        return response(200, { status: "requeued" });
      },
      log: {},
    });
    expect(bodies).toEqual([{ leaseToken: "l-1", error: "capture_timeout" }]);
    launched(browser);
    await Promise.resolve();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(browser.newContext).not.toHaveBeenCalled();
  });

  it("launches no browser when nothing is queued, and fails loudly when the claim does", async () => {
    const launch = vi.fn();
    expect(
      await runCaptureJob({
        appOrigin: "http://localhost:3000",
        cronSecret: "s",
        launch,
        fetchImpl: async () => response(204),
        log: {},
      }),
    ).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
    await expect(
      runCaptureJob({
        appOrigin: "http://localhost:3000",
        cronSecret: "s",
        launch,
        fetchImpl: async () => response(503),
        log: {},
      }),
    ).rejects.toThrow("claim failed with HTTP 503");
  });

  it("stops at its capture limit", async () => {
    const { browser } = fakeBrowser();
    let claims = 0;
    const results = await runCaptureJob({
      appOrigin: "http://localhost:3000",
      cronSecret: "s",
      launch: async () => browser,
      maxCaptures: 2,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/claim")) {
          claims += 1;
          return response(200, { ...claim, captureId: `c-${claims}` });
        }
        return response(200, { status: "succeeded" });
      },
      log: {},
    });
    expect(results).toHaveLength(2);
    expect(claims).toBe(2);
  });
});

it("accepts a real 404 only for the deliberate not-found surface", async () => {
  const qaClaim = {
    ...claim,
    qa: {
      pages: [{ surface: "not_found", path: "/missing" }],
      viewports: { phone360: { width: 360, height: 800 } },
    },
  };
  const { browser } = fakeBrowser({ status: 404 });
  expect((await takeQaScreenshots(browser, qaClaim)).screenshots).toHaveLength(
    1,
  );
  const wrong = fakeBrowser({ status: 200 });
  await expect(takeQaScreenshots(wrong.browser, qaClaim)).rejects.toThrow(
    "preview_status_200",
  );
  await expect(
    takeQaScreenshots(browser, {
      ...qaClaim,
      qa: { ...qaClaim.qa, pages: [{ surface: "home", path: "/" }] },
    }),
  ).rejects.toThrow("preview_status_404");
});

it("reports missing hydration separately from a generic browser crash", async () => {
  const { browser, contexts } = fakeBrowser({ failOn: "probe" });
  await expect(
    takeQaScreenshots(browser, {
      ...claim,
      qa: {
        pages: [{ surface: "home", path: "/" }],
        viewports: { phone360: { width: 360, height: 800 } },
      },
    }),
  ).rejects.toThrow("qa_probe_missing");
  expect(contexts[0].closed).toBe(true);
});

it("reports browser launch failure instead of abandoning a running lease", async () => {
  const answers = [
    response(200, claim),
    response(200, { status: "requeued" }),
    response(204),
  ];
  const bodies = [];
  await runCaptureJob({
    appOrigin: claim.origin,
    cronSecret: "s",
    launch: async () => {
      throw new Error("launch failed");
    },
    fetchImpl: async (_url, init) => {
      if (init.body) bodies.push(JSON.parse(init.body));
      return answers.shift();
    },
    log: {},
  });
  expect(bodies).toEqual([
    { leaseToken: claim.leaseToken, error: "capture_browser_error" },
  ]);
});

it("fails the job on a rejected finish rather than claiming more work", async () => {
  const { browser } = fakeBrowser();
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(response(200, claim))
    .mockResolvedValueOnce(response(503));
  await expect(
    runCaptureJob({
      appOrigin: claim.origin,
      cronSecret: "s",
      launch: async () => browser,
      fetchImpl,
      log: {},
    }),
  ).rejects.toThrow("finish failed with HTTP 503");
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(browser.close).toHaveBeenCalled();
});

it("reports a hung browser before its lease expires and closes it", async () => {
  vi.useFakeTimers();
  try {
    const browser = {
      newContext: () => new Promise(() => {}),
      close: vi.fn(async () => {}),
    };
    const bodies = [];
    const answers = [
      response(200, claim),
      response(200, { status: "requeued" }),
    ];
    const pending = runCaptureJob({
      appOrigin: claim.origin,
      cronSecret: "s",
      launch: async () => browser,
      fetchImpl: async (_url, init) => {
        if (init.body) bodies.push(JSON.parse(init.body));
        return answers.shift();
      },
      log: {},
      maxCaptures: 1,
    });
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    await pending;
    expect(bodies).toEqual([
      { leaseToken: claim.leaseToken, error: "capture_timeout" },
    ]);
    expect(browser.close).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

describe("execution time budget", () => {
  it("waits on finish longer than the route runs, and fits one full capture in the task timeout", () => {
    // app/api/internal/theme-studio/captures/[captureId]/route.ts maxDuration.
    expect(FINISH_TIMEOUT_MS).toBeGreaterThan(240_000);
    expect(CAPTURE_WINDOW_MS + FINISH_TIMEOUT_MS).toBeLessThanOrEqual(
      DEFAULT_BUDGET_MS,
    );
    // Cloud Run task timeout (docs/theme-studio-capture-job.md).
    expect(DEFAULT_BUDGET_MS).toBeLessThan(600_000);
  });

  it("claims nothing once a capture could no longer get its minimum browser time", async () => {
    const fetchImpl = vi.fn();
    const elapsed = DEFAULT_BUDGET_MS - FINISH_TIMEOUT_MS - MIN_CAPTURE_MS + 1;
    const times = [0, elapsed];
    expect(
      await runCaptureJob({
        appOrigin: claim.origin,
        cronSecret: "s",
        launch: vi.fn(),
        fetchImpl,
        now: () => times.shift() ?? elapsed,
        log: {},
      }),
    ).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("carries on with the queue when a finish reports the lease was lost", async () => {
    const { browser } = fakeBrowser();
    const answers = [
      response(200, claim),
      response(409, { status: "lost" }),
      response(200, { ...claim, captureId: "c-2" }),
      response(200, { status: "succeeded" }),
      response(204),
    ];
    const results = await runCaptureJob({
      appOrigin: claim.origin,
      cronSecret: "s",
      launch: async () => browser,
      fetchImpl: async () => answers.shift(),
      log: {},
    });
    expect(results).toEqual([
      { captureId: "c-1", http: 409, status: "lost" },
      { captureId: "c-2", http: 200, status: "succeeded" },
    ]);
  });
});

it("never measures more QA contexts at once than MAX_QA_CONTEXTS, whatever is asked", async () => {
  let open = 0;
  let peak = 0;
  const browser = {
    close: vi.fn(async () => {}),
    newContext: vi.fn(async (options) => {
      open++;
      peak = Math.max(peak, open);
      return {
        async addCookies() {},
        async newPage() {
          return {
            async goto() {
              await new Promise((resolve) => setTimeout(resolve, 2));
              return { status: () => 200 };
            },
            async addStyleTag() {},
            async waitForTimeout() {},
            async waitForFunction() {},
            async evaluate() {
              return { width: options.viewport.width };
            },
            async screenshot() {
              return Buffer.from("jpeg");
            },
            async close() {},
          };
        },
        async close() {
          open--;
        },
      };
    }),
  };
  await takeQaScreenshots(
    browser,
    {
      ...claim,
      qa: {
        pages: [{ surface: "home", path: "/" }],
        viewports: {
          a: { width: 360, height: 800 },
          b: { width: 390, height: 844 },
          c: { width: 768, height: 1024 },
          d: { width: 1024, height: 768 },
        },
      },
    },
    { settleMs: 0, concurrency: 9 },
  );
  expect(peak).toBe(MAX_QA_CONTEXTS);
});
