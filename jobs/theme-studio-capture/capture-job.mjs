// Theme Studio capture job (Track 3.6).
//
// Photographs a Theme Studio version's private preview store in headless
// Chromium and posts the catalog card and screenshots back to the web app,
// which saves them as a new version. Runs as its own Cloud Run job (see
// docs/theme-studio-capture-job.md); locally, `npm run theme-studio:capture`.
//
//   APP_ORIGIN      the web app, e.g. https://storemink.com (required)
//   CRON_SECRET     the internal-route bearer secret (required)
//   CHROMIUM_PATH   a Chromium binary (the container's); or
//   CAPTURE_CHROME_CHANNEL=chrome   use the machine's installed Chrome
//
// ★ IT KNOWS NOTHING BUT WHAT A CLAIM HANDS IT: a capture id, a lease token,
// the preview's origin, a cookie good only while that capture runs, and the
// shots to take. It never touches the database, and every picture it sends
// is re-decoded, cropped and compressed by the web app.
//
// ★ EACH SHOT IS A FRESH BROWSER CONTEXT at its own size, scale and device,
// with reduced motion, so a carousel is on its first slide and nothing is
// mid-animation, and every scroll-revealed section is shown.

import { pathToFileURL } from "node:url";

/** Longest a capture's browser work may run. */
export const CAPTURE_WINDOW_MS = 5 * 60_000;
/** A claim is only taken when at least this much browser time remains;
 * starting one with less only burns an attempt on a certain timeout. */
export const MIN_CAPTURE_MS = 3 * 60_000;
/** Finish runs server acceptance (route checks bounded to 150s, preview, one
 * transaction). Cloud Run does not cut that request off (`maxDuration` is not
 * enforced self-hosted; the service timeout is 1200s), so THIS wait is the
 * bound the server work is sized against: generous enough that a slow but
 * healthy finish is not abandoned mid-commit. */
export const FINISH_TIMEOUT_MS = 270_000;
/** The job's task timeout is 600s; keep 30s for claims and shutdown. */
export const DEFAULT_BUDGET_MS = 570_000;
/** Most QA browser contexts measured at once. Each holds full-page renders,
 * and the job runs with 2 GiB; callers may ask for fewer, never more. */
export const MAX_QA_CONTEXTS = 2;

export class CaptureError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** A closed error code the web app accepts, from anything that was thrown. */
export function errorCode(error) {
  if (error instanceof CaptureError) return error.code;
  const message = String(error?.message ?? error);
  if (/timeout/i.test(message)) return "capture_timeout";
  if (/qa_probe_missing/i.test(message)) return "qa_probe_missing";
  if (/qa_measure_failed/i.test(message)) return "qa_measure_failed";
  if (/net::|ERR_/i.test(message)) return "capture_network";
  return "capture_browser_error";
}

const PHONE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

/** Take every shot a claim asks for; returns [{ slotId, base64 }]. */
export async function takeShots(browser, claim, { settleMs = 400 } = {}) {
  const images = [];
  for (const shot of claim.shots) {
    const context = await browser.newContext({
      viewport: shot.viewport,
      deviceScaleFactor: shot.deviceScaleFactor,
      isMobile: shot.mobile,
      hasTouch: shot.mobile,
      reducedMotion: "reduce",
      ...(shot.mobile ? { userAgent: PHONE_UA } : {}),
    });
    try {
      await context.addCookies([
        {
          name: claim.cookie.name,
          value: claim.cookie.value,
          url: claim.origin,
        },
      ]);
      const page = await context.newPage();
      const response = await page.goto(new URL(shot.path, claim.origin).href, {
        waitUntil: "load",
        timeout: 60_000,
      });
      const status = response ? response.status() : 0;
      if (status !== 200) throw new CaptureError(`preview_status_${status}`);
      // Readiness below waits for the actual fonts/images. Analytics and
      // background requests must not add a 15-second network-idle wait.
      // Next's development badge is not part of the storefront (it never
      // renders in production), so a local capture hides it.
      await page.addStyleTag({
        content: "nextjs-portal{display:none!important}",
      });
      await page.evaluate(async () => {
        // Show every scroll-revealed section, load every image the first
        // screen shows, and wait for the theme's fonts.
        window.dispatchEvent(new Event("sm:reveal-all"));
        for (const img of document.querySelectorAll('img[loading="lazy"]')) {
          img.loading = "eager";
        }
        await document.fonts.ready;
        await Promise.all(
          [...document.images]
            .filter((img) => !img.complete)
            .map(
              (img) =>
                new Promise((resolve) => {
                  img.addEventListener("load", resolve, { once: true });
                  img.addEventListener("error", resolve, { once: true });
                  setTimeout(resolve, 8_000);
                }),
            ),
        );
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(settleMs);
      const bytes = await page.screenshot({ type: "jpeg", quality: 92 });
      images.push({ slotId: shot.slotId, base64: bytes.toString("base64") });
    } finally {
      await context.close();
    }
  }
  return images;
}

/** Track 5: measure and screenshot every preview page at every QA width. */
export async function takeQaScreenshots(
  browser,
  claim,
  { settleMs = 250, concurrency = MAX_QA_CONTEXTS } = {},
) {
  if (!claim.qa) return undefined;
  const measured = await mapCaptureWork(
    Object.entries(claim.qa.viewports),
    Math.min(concurrency, MAX_QA_CONTEXTS),
    async ([viewport, dimensions]) => {
      const samples = [];
      const screenshots = [];
      const mobile = dimensions.width <= 768;
      const context = await browser.newContext({
        viewport: dimensions,
        deviceScaleFactor: 1,
        isMobile: mobile,
        hasTouch: mobile,
        reducedMotion: "reduce",
        ...(mobile ? { userAgent: PHONE_UA } : {}),
      });
      try {
        await context.addCookies([
          {
            name: claim.cookie.name,
            value: claim.cookie.value,
            url: claim.origin,
          },
        ]);
        for (const preview of claim.qa.pages) {
          const page = await context.newPage();
          const response = await page.goto(
            new URL(preview.path, claim.origin).href,
            { waitUntil: "load", timeout: 60_000 },
          );
          const status = response ? response.status() : 0;
          const expected = preview.surface === "not_found" ? 404 : 200;
          if (status !== expected)
            throw new CaptureError(`preview_status_${status}`);
          // The probe waits for fonts and images itself. Network-idle can add
          // 15 seconds to each of thirty pages because of unrelated traffic.
          await page.addStyleTag({
            content: "nextjs-portal{display:none!important}",
          });
          await page.waitForTimeout(settleMs);
          // load/networkidle do not guarantee React's effect has installed the
          // probe (especially on a cold streamed 404). Wait for that condition.
          await page
            .waitForFunction(
              () => typeof window.__smThemeStudioMeasure === "function",
              undefined,
              { timeout: 20_000 },
            )
            .catch(() => {
              throw new CaptureError("qa_probe_missing");
            });
          const result = await page.evaluate(async () => {
            let timer;
            try {
              return await Promise.race([
                window.__smThemeStudioMeasure(),
                new Promise((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error("qa_measure_timeout")),
                    45_000,
                  );
                }),
              ]);
            } catch (error) {
              throw new Error(
                /timeout/i.test(String(error))
                  ? "qa_measure_timeout"
                  : "qa_measure_failed",
              );
            } finally {
              clearTimeout(timer);
            }
          });
          samples.push({ ...result, viewport, surface: preview.surface });
          // The evidence above is measured at the real viewport. Compress only
          // the visual evidence so six long pages stay inside the job payload.
          await page.evaluate(() => {
            document.documentElement.style.zoom = "0.65";
          });
          const bytes = await page.screenshot({
            type: "jpeg",
            quality: 55,
            fullPage: true,
          });
          if (bytes.byteLength > 512 * 1024) {
            throw new CaptureError("qa_screenshot_too_large");
          }
          screenshots.push({
            key: `${viewport}:${preview.surface}`,
            viewport,
            surface: preview.surface,
            path: preview.path,
            base64: bytes.toString("base64"),
          });
          await page.close?.();
        }
      } finally {
        await context.close();
      }
      return { samples, screenshots };
    },
  );
  return {
    buildId: claim.qa.buildId,
    evidence: {
      userAgent: PHONE_UA,
      samples: measured.flatMap((value) => value.samples),
    },
    screenshots: measured.flatMap((value) => value.screenshots),
  };
}

/** Bounded browser work; preserve plan order and drain in-flight contexts
 * before returning an error. Never leave asynchronous work on a reused browser. */
export async function mapCaptureWork(items, concurrency, work) {
  const output = new Array(items.length);
  let next = 0;
  let failure;
  const lanes = Array.from(
    {
      length: Math.min(items.length, Math.max(1, Math.floor(concurrency) || 1)),
    },
    async () => {
      while (!failure && next < items.length) {
        const index = next++;
        try {
          output[index] = await work(items[index], index);
        } catch (error) {
          failure = error || new Error("capture_work_failed");
        }
      }
    },
  );
  await Promise.all(lanes);
  if (failure) throw failure;
  return output;
}

/**
 * Drain captures until none are queued, the budget is spent or `maxCaptures`
 * are done. Returns what happened, for the job's log.
 */
export async function runCaptureJob({
  appOrigin,
  cronSecret,
  launch,
  fetchImpl = fetch,
  log = console,
  maxCaptures = 5,
  budgetMs = DEFAULT_BUDGET_MS,
  now = () => Date.now(),
}) {
  const started = now();
  // Browser time left for a capture claimed now, after reserving the finish.
  const captureTimeLeft = () =>
    budgetMs - (now() - started) - FINISH_TIMEOUT_MS;
  const headers = {
    authorization: `Bearer ${cronSecret}`,
    "content-type": "application/json",
  };
  const results = [];
  let browser = null;
  try {
    while (
      results.length < maxCaptures &&
      captureTimeLeft() >= MIN_CAPTURE_MS
    ) {
      const response = await fetchImpl(
        new URL("/api/internal/theme-studio/captures/claim", appOrigin),
        { method: "POST", headers, signal: AbortSignal.timeout(60_000) },
      );
      if (response.status === 204) break;
      if (!response.ok) {
        throw new Error(`claim failed with HTTP ${response.status}`);
      }
      const claim = await response.json();
      let body;
      let timer;
      let expired = false;
      try {
        // Leave the whole finish timeout for server acceptance before the
        // 10-minute lease/job expires. A hung page/evaluate must not hold a
        // theme forever.
        const remainingMs = Math.min(CAPTURE_WINDOW_MS, captureTimeLeft());
        if (remainingMs <= 0) throw new CaptureError("capture_timeout");
        body = await Promise.race([
          (async () => {
            if (!browser) {
              const launched = await launch();
              if (expired) {
                await launched.close().catch(() => {});
                throw new CaptureError("capture_timeout");
              }
              browser = launched;
            }
            const activeBrowser = browser;
            const images = await takeShots(activeBrowser, claim);
            return {
              leaseToken: claim.leaseToken,
              images,
              ...(claim.qa
                ? { qa: await takeQaScreenshots(activeBrowser, claim) }
                : {}),
            };
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              expired = true;
              reject(new CaptureError("capture_timeout"));
            }, remainingMs);
          }),
        ]);
      } catch (error) {
        body = { leaseToken: claim.leaseToken, error: errorCode(error) };
        log.warn?.(`capture ${claim.captureId}: ${body.error}`);
        // Do not reuse a crashed or timed-out Chromium for the retry.
        await browser?.close().catch(() => {});
        browser = null;
      } finally {
        clearTimeout(timer);
      }
      const finished = await fetchImpl(
        new URL(
          `/api/internal/theme-studio/captures/${claim.captureId}`,
          appOrigin,
        ),
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(FINISH_TIMEOUT_MS),
        },
      );
      // 409 means the lease was lost (expired or re-claimed): this capture is
      // no longer ours and nothing went wrong on the server, so carry on with
      // the queue. Any other failure stops the execution for monitoring.
      if (!finished.ok && finished.status !== 409)
        throw new Error(`finish failed with HTTP ${finished.status}`);
      const outcome = await finished.json().catch(() => ({}));
      results.push({
        captureId: claim.captureId,
        http: finished.status,
        ...outcome,
      });
      log.info?.(
        `capture ${claim.captureId}: ${outcome.status ?? finished.status}`,
      );
    }
  } finally {
    await browser?.close();
  }
  return results;
}

async function main() {
  const appOrigin = process.env.APP_ORIGIN;
  const cronSecret = process.env.CRON_SECRET;
  if (!appOrigin || !cronSecret) {
    console.error("APP_ORIGIN and CRON_SECRET are required.");
    process.exit(2);
  }
  const { chromium } = await import("playwright-core");
  const launch = () =>
    chromium.launch({
      ...(process.env.CHROMIUM_PATH
        ? { executablePath: process.env.CHROMIUM_PATH }
        : {}),
      ...(process.env.CAPTURE_CHROME_CHANNEL
        ? { channel: process.env.CAPTURE_CHROME_CHANNEL }
        : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  const results = await runCaptureJob({ appOrigin, cronSecret, launch });
  console.log(JSON.stringify({ captures: results }));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
