/** Offline layout regression for shared hero frames and carousel controls.
 * Install the capture job's dependencies, then run:
 *   node scripts/theme-studio-renderer-check.mjs
 * Uses local Chrome on macOS, or CHROME_EXECUTABLE_PATH / Playwright Chromium.
 * No network, credentials, database or provider calls. This is a renderer
 * fixture using production CSS, not a complete storefront quality benchmark.
 */
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireJob = createRequire(
  new URL("../jobs/theme-studio-capture/package.json", import.meta.url),
);
const { chromium } = requireJob("playwright-core");
const css = readFileSync(
  new URL(
    "../app/(storefront)/components/homepage/homepage.css",
    import.meta.url,
  ),
  "utf8",
);
const macChrome =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath =
  process.env.CHROME_EXECUTABLE_PATH ||
  (existsSync(macChrome) ? macChrome : chromium.executablePath());
const browser = await chromium.launch({ executablePath, headless: true });
const failures = [];
let cases = 0;

function image(width, height) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#dad4cc"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const documentHtml = (html) => `<!doctype html><html><head><style>
  *{box-sizing:border-box}body{margin:0;font:16px Arial}
  :root{--sm-ink:#211c25;--sm-cream-deep:#faf8f5;--sm-surface:#fff;--sm-on-accent:#fff;--brand-primary:#45243c}
  ${css}
  </style></head><body><main class="storefront-root"><div class="home-sections">${html}</div></main></body></html>`;

try {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  for (const width of [360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const variant of ["banner", "split"]) {
      // Desktop presets deliberately change a side-by-side frame and remain
      // repairable settings. Stacked media must retain its frame under every
      // preset; the representative desktop framing uses medium height.
      for (const height of width <= 860
        ? ["auto", "small", "medium", "large"]
        : ["medium"]) {
        for (const [sourceWidth, sourceHeight] of [
          [1280, 1600], // Aurelle's editorial story photograph
          [900, 1600],
          [1600, 900],
          [2100, 900],
        ]) {
          const label = `${width}px ${variant}/${height} ${sourceWidth}×${sourceHeight}`;
          await page.setContent(
            documentHtml(`<section class="home-section">
            <div class="home-hero variant-${variant} theme-dark align-left ${height === "auto" ? "" : `height-${height}`} ">
              <div class="home-hero-copy"><h1 class="home-hero-heading">Rooted in Quiet Luxury</h1><p class="home-hero-sub">Thoughtfully made essentials for everyday life.</p></div>
              <div class="home-hero-media"><img class="home-hero-img" alt="Editorial" src="${image(sourceWidth, sourceHeight)}" style="position:absolute;inset:0;height:100%;width:100%"></div>
            </div></section>`),
          );
          const measurement = await page.evaluate(async () => {
            const img = document.querySelector("img");
            await img.decode();
            const box = img.getBoundingClientRect();
            const source = img.naturalWidth / img.naturalHeight;
            const frame = box.width / box.height;
            return {
              retained: Math.min(source / frame, frame / source),
              overflow: document.documentElement.scrollWidth > innerWidth,
              width: box.width,
              height: box.height,
            };
          });
          cases++;
          if (
            measurement.retained < 0.35 ||
            measurement.overflow ||
            !measurement.height
          )
            failures.push({ label, ...measurement });
        }
      }
    }
    // Maximum supported slide count, including active and inactive controls.
    await page.setContent(
      documentHtml(`<section class="home-section"><div class="home-carousel">
      <div class="home-carousel-dots">${Array.from({ length: 8 }, (_, i) => `<button class="home-carousel-dot ${i === 0 ? "is-active" : ""}" aria-label="Go to slide ${i + 1}"></button>`).join("")}</div>
      </div></section>`),
    );
    const controls = await page.evaluate(() =>
      [...document.querySelectorAll("button")].map((button) => {
        const r = button.getBoundingClientRect();
        return {
          width: r.width,
          height: r.height,
          left: r.left,
          right: r.right,
        };
      }),
    );
    cases++;
    if (
      controls.some(
        (r) => r.width < 24 || r.height < 24 || r.left < 0 || r.right > width,
      )
    )
      failures.push({ label: `${width}px carousel controls`, controls });
    await page.locator("button").first().focus();
    if (
      await page
        .locator("button")
        .first()
        .evaluate((button) => getComputedStyle(button).outlineStyle === "none")
    )
      failures.push({ label: `${width}px carousel focus indicator` });
  }
} finally {
  await browser.close();
}

console.log(
  JSON.stringify(
    { script: fileURLToPath(import.meta.url), cases, failures },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
