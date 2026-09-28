import { describe, expect, it, vi } from "vitest";
import {
  CaptureError,
  errorCode,
  runCaptureJob,
  takeQaScreenshots,
  takeShots,
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
