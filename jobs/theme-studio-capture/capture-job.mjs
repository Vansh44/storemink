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
      await page
        .waitForLoadState("networkidle", { timeout: 15_000 })
        .catch(() => {});
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
  budgetMs = 8 * 60_000,
  now = () => Date.now(),
}) {
  const started = now();
  const headers = {
    authorization: `Bearer ${cronSecret}`,
    "content-type": "application/json",
  };
  const results = [];
  let browser = null;
  try {
    while (results.length < maxCaptures && now() - started < budgetMs) {
      const response = await fetchImpl(
        new URL("/api/internal/theme-studio/captures/claim", appOrigin),
        { method: "POST", headers },
      );
      if (response.status === 204) break;
      if (!response.ok) {
        throw new Error(`claim failed with HTTP ${response.status}`);
      }
      const claim = await response.json();
      browser ??= await launch();
      let body;
      try {
        body = {
          leaseToken: claim.leaseToken,
          images: await takeShots(browser, claim),
        };
      } catch (error) {
        body = { leaseToken: claim.leaseToken, error: errorCode(error) };
        log.warn?.(`capture ${claim.captureId}: ${body.error}`);
      }
      const finished = await fetchImpl(
        new URL(
          `/api/internal/theme-studio/captures/${claim.captureId}`,
          appOrigin,
        ),
        { method: "POST", headers, body: JSON.stringify(body) },
      );
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
