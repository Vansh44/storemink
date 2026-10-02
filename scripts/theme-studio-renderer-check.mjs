/** Offline layout regression for shared native section layouts and controls.
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
const axe = readFileSync(requireJob.resolve("axe-core/axe.min.js"), "utf8");
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
  :root{--sm-ink:#211c25;--sm-ink-soft:#554d59;--sm-ink-faint:#675c6b;--sm-cream:#faf8f5;--sm-cream-deep:#efece9;--sm-border:#ccc;--sm-surface:#fff;--sm-on-ink:#fff;--sm-accent:#45243c;--sm-on-accent:#fff;--brand-primary:#45243c;--sm-shadow-rgb:30,20,30;--sm-page-width:1320px;--sm-page-cream:#faf8f5;--sm-page-cream-deep:#efece9;--sm-page-surface:#fff;--sm-page-sand:#efece9;--sm-page-tile:#efece9;--sm-page-ink:#211c25;--sm-page-ink-soft:#554d59;--sm-page-ink-faint:#675c6b;--sm-page-border:#ccc;--sm-page-on-ink:#fff;--sm-page-accent:#45243c;--sm-page-on-accent:#fff;--sm-scheme-soft-bg:#faf8f5;--sm-scheme-soft-fg:#211c25;--sm-scheme-soft-surface:#fff;--sm-scheme-soft-accent:#45243c;--sm-scheme-soft-on-accent:#fff;--sm-scheme-inverse-bg:#211c25;--sm-scheme-inverse-fg:#faf8f5;--sm-scheme-inverse-surface:#211c25;--sm-scheme-inverse-accent:#faf8f5;--sm-scheme-inverse-on-accent:#211c25}
  ${css}
  </style></head><body><main class="storefront-root sm-page-width"><div class="home-sections">${html}</div></main></body></html>`;

// Markup follows the native sections' public classes. Synthetic media uses the
// same absolute fill behavior as next/image; all requests are blocked.
const fill = (className, ratio = "portrait") =>
  `<img class="${className}" alt="Studio ceramic vessel" src="${image(ratio === "landscape" ? 1600 : 1280, ratio === "portrait" ? 1600 : ratio === "square" ? 1280 : 1200)}" style="position:absolute;inset:0;width:100%;height:100%">`;
const heading = "Thoughtfully Crafted Everyday Essentials";
const copy =
  "Durable essentials with carefully considered details, natural materials and generous space for everyday living.";
function fixtures() {
  const out = [];
  for (const ratio of ["portrait", "square", "landscape"]) {
    for (const cols of [2, 3, 4])
      for (const layout of ["grid", "editorial"])
        out.push({
          label: `gallery/${layout}/${cols}/${ratio}`,
          html: `<div class="home-gallery layout-${layout} cols-${cols}">${Array.from({ length: 4 }, () => `<a href="/shop" class="home-gallery-card"><span class="home-gallery-media ratio-${ratio}">${fill("home-gallery-image", ratio)}</span><span class="home-gallery-caption">${copy}</span></a>`).join("")}</div>`,
        });
    for (const position of ["left", "right"])
      for (const align of ["left", "center"])
        out.push({
          label: `media-text/${position}/${align}/${ratio}`,
          html: `<div class="home-media-text media-${position} align-${align}"><div class="home-media-text-media ratio-${ratio}">${fill("home-media-text-image", ratio)}</div><div class="home-media-text-copy"><h2 class="home-media-text-heading">${heading}</h2><p class="home-media-text-body">${copy}</p><a href="/shop" class="home-media-text-cta">Explore the collection</a></div></div>`,
        });
  }
  for (const cols of [2, 3, 4])
    for (const size of ["sm", "md", "lg"])
      out.push({
        label: `tiles/${cols}/${size}`,
        html: `<div class="home-tile-grid cols-${cols} size-${size}">${Array.from({ length: 4 }, () => `<a href="/shop" class="home-tile theme-dark"><span class="home-tile-copy"><span class="home-tile-title">Everyday essentials</span><span class="home-tile-sub">${copy}</span></span></a>`).join("")}</div>`,
      });
  for (const cols of [2, 3])
    for (const layout of ["grid", "editorial"])
      out.push({
        label: `testimonials/${layout}/${cols}`,
        html: `<div class="home-testimonials layout-${layout} cols-${cols}">${Array.from({ length: 3 }, () => `<figure class="home-testimonial"><blockquote class="home-testimonial-quote">${copy}</blockquote><figcaption class="home-testimonial-attribution"><cite>Alex Morgan</cite>Verified customer</figcaption></figure>`).join("")}</div>`,
      });
  for (const theme of ["light", "dark"])
    for (const align of ["left", "center"])
      out.push({
        label: `newsletter/${theme}/${align}`,
        html: `<div class="home-newsletter theme-${theme} align-${align}"><div><h2 class="home-newsletter-heading">${heading}</h2><p class="home-newsletter-sub">${copy}</p></div><form class="home-newsletter-form"><div class="home-newsletter-fields"><input class="home-newsletter-input" type="email" aria-label="Email"><button class="home-newsletter-button">Subscribe</button></div><label class="home-newsletter-consent"><input type="checkbox"><span>Send me occasional collection news and offers. I agree to the privacy policy and can unsubscribe at any time.</span></label></form></div>`,
      });
  out.push({
    label: "faq/long-text",
    html: `<div class="home-faq-filters"><button class="home-faq-pill active">Delivery and returns</button><button class="home-faq-pill">Care and materials</button></div><div class="home-faq-list"><div class="home-faq-item open"><button class="home-faq-q">How do you select and care for thoughtfully crafted natural materials?</button><p class="home-faq-a">${copy.repeat(3)}</p></div></div>`,
  });
  out.push({
    label: "rich-text/long-heading",
    html: `<div class="home-rich-text"><div class="home-rich-text-content"><h2>${heading}</h2><p>${copy.repeat(4)}</p><p><a href="/shop">Discover our thoughtfully considered collection</a></p></div></div>`,
  });
  return out;
}

async function measureNative(page) {
  return page.evaluate(async () => {
    await Promise.all([...document.images].map((i) => i.decode()));
    const targets = [...document.querySelectorAll("a,button,input")]
      .filter((e) => {
        const b = e.getBoundingClientRect();
        return b.width && b.height && getComputedStyle(e).display !== "inline";
      })
      .flatMap((e) => {
        const b = e.getBoundingClientRect();
        return b.width < 24 || b.height < 24
          ? [{ target: e.className, width: b.width, height: b.height }]
          : [];
      });
    const crop = [...document.images].flatMap((e) => {
      const b = e.getBoundingClientRect();
      const s = e.naturalWidth / e.naturalHeight;
      const f = b.width / b.height;
      const retained = Math.min(s / f, f / s);
      return retained < 0.35 ? [{ target: e.className, retained }] : [];
    });
    const clipped = [
      ...document.querySelectorAll("h1,h2,h3,p,blockquote,span"),
    ].flatMap((e) => {
      const b = e.getBoundingClientRect();
      return e.scrollWidth > e.clientWidth + 2 && b.width > 0
        ? [e.className]
        : [];
    });
    return {
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      targets,
      crop,
      clipped,
    };
  });
}

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
    for (const fixture of fixtures()) {
      for (const [scheme, padding, bleed] of [
        ["soft", "sm", false],
        ["inverse", "lg", true],
      ]) {
        await page.setContent(
          documentHtml(
            `<section class="home-section sm-scheme sm-scheme-${scheme} home-pad-${padding} ${bleed ? "is-fullbleed" : ""}">${fixture.html}</section>`,
          ),
        );
        const measured = await measureNative(page);
        await page.addScriptTag({ content: axe });
        const contrast = await page.evaluate(async () => {
          const { violations } = await window.axe.run(document, {
            runOnly: { type: "rule", values: ["color-contrast"] },
          });
          return violations.flatMap((v) =>
            v.nodes.map((n) => n.target.join(" ")),
          );
        });
        cases++;
        if (
          measured.overflow ||
          measured.targets.length ||
          measured.crop.length ||
          measured.clipped.length ||
          contrast.length
        )
          failures.push({
            label: `${width}px ${fixture.label}/${scheme}/${padding}/${bleed}`,
            ...measured,
            contrast,
          });
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
  await page.setViewportSize({ width: 360, height: 800 });
  await page.setContent(
    documentHtml(
      '<button style="width:9px;height:9px;padding:0">x</button><div style="width:2000px">overflow</div><h2 style="width:20px;white-space:nowrap">Clipped heading</h2><div style="position:relative;width:300px;height:40px"><img alt="Crop" src="' +
        image(900, 1600) +
        '" style="position:absolute;width:100%;height:100%;object-fit:cover"></div>',
    ),
  );
  const broken = await measureNative(page);
  await page.addScriptTag({ content: axe });
  await page.evaluate(() => {
    const p = document.createElement("p");
    p.textContent = "Contrast negative control";
    p.style.cssText =
      "position:fixed;top:0;left:0;color:#aaaaaa;background:#ffffff;font-size:16px;z-index:100";
    document.body.append(p);
  });
  const badContrast = await page.evaluate(
    async () =>
      (
        await window.axe.run(document, {
          runOnly: { type: "rule", values: ["color-contrast"] },
        })
      ).violations.length,
  );
  if (
    !broken.overflow ||
    !broken.targets.length ||
    !broken.crop.length ||
    !broken.clipped.length ||
    !badContrast
  )
    failures.push({ label: "negative controls were not detected", ...broken });
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
