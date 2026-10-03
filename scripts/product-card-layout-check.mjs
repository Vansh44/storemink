/** Offline browser regression for shared product cards. Uses production CSS
 * in both load orders, local Chrome and synthetic products; no network or DB.
 * Run: node scripts/product-card-layout-check.mjs
 * --css-ref=<git revision> checks older CSS for diagnosis; --screenshots=<dir>
 * saves representative phone fixtures. These are not live theme screenshots.
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const requireJob = createRequire(
  new URL("../jobs/theme-studio-capture/package.json", import.meta.url),
);
const { chromium } = requireJob("playwright-core");
const option = (key) =>
  process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3);
const ref = option("css-ref");
const screenshots = option("screenshots");
if (screenshots) mkdirSync(screenshots, { recursive: true });
const readCss = (path) =>
  ref
    ? execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" })
    : readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sheets = [
  readCss("app/(storefront)/storefront-theme.css"),
  readCss("app/(storefront)/(pages)/shop/shop.css"),
  readCss("app/(storefront)/components/homepage/homepage.css"),
];
const beverage = `data:image/webp;base64,${readFileSync(new URL("../public/themes/basket/p-juice.webp", import.meta.url)).toString("base64")}`;
const products = [
  ["Artisanal Brews", "Golden Ginger Fizz Kombucha", "260", "280", "7", true],
  ["Artisanal Brews", "Wild Berry Hops Kombucha", "270", "290", "7", false],
  [
    "Variety & Bundles",
    "The Sunshine Sampler 12-Pack",
    "1,850",
    "2,200",
    "16",
    true,
  ],
  [
    "Limited Edition & Seasonal Bundles",
    "Celebration Collection Gift Box",
    "1,29,999",
    "1,49,999",
    "13",
    true,
  ],
];
// Matches ShopCard's public structure, including atomic price groups and a
// stock-badge column only when present. Baseline markup reproduces the report.
function cards(fixture) {
  return (fixture === "regular" ? products.slice(0, 3) : products.slice(3))
    .map(([category, name, sell, base, off, from]) => {
      const current = `${from ? '<span class="shop-card-from">from </span>' : ""}<span class="shop-card-sell">₹${sell}</span>`;
      const deal = `<span class="shop-card-base">₹${base}</span><span class="shop-card-off">${off}% off</span>`;
      return `<a class="shop-card" href="/shop/product" style="--card-bg:#f4f2ee">
      <div class="shop-card-img"><img class="shop-card-img-el" src="${beverage}" alt="Fruit beverage" style="position:absolute;inset:0;width:100%;height:100%"></div>
      <div class="shop-card-body"><div class="shop-card-head flex items-start justify-between"><div class="min-w-0"><span class="shop-card-cat">${category}</span><h3 class="shop-card-name">${name}</h3></div>${ref ? '<div class="shrink-0 ml-2 flex flex-col items-end gap-1"></div>' : ""}</div>
      <div class="shop-card-price">${ref ? current + deal : `<span class="shop-card-current">${current}</span><span class="shop-card-deal">${deal}</span>`}<div role="button" tabindex="0" class="shop-card-add flex items-center justify-center">+ Add</div></div></div></a>`;
    })
    .join("");
}
const variants = {
  classic: "",
  quickadd: "sm-card-quickadd",
  grocery: "sm-storefront-grocery sm-card-quickadd",
  framed: "sm-card-framed",
  overlay: "sm-card-overlay",
};
function html(skin, surface, order, fixture) {
  return `<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:0;font:16px/1.5 Arial}
    :root{--sm-ink:#171717;--sm-ink-soft:#555;--sm-ink-faint:#666;--sm-cream:#fff;--sm-cream-deep:#f4f2ee;--sm-border:#ccc;--sm-surface:#fff;--sm-on-ink:#fff;--sm-accent:#880035;--sm-on-accent:#fff;--sm-butter:#f4f2ee;--sm-shadow-rgb:25,25,25;--sm-radius-card:20px;--sm-radius-control:12px;--sm-radius-sm:8px;--sm-radius-pill:999px}
    .flex{display:flex}.flex-col{flex-direction:column}.items-start{align-items:flex-start}.items-end{align-items:flex-end}.items-center{align-items:center}.justify-between{justify-content:space-between}.justify-center{justify-content:center}.min-w-0{min-width:0}.shrink-0{flex-shrink:0}.ml-2{margin-left:8px}.gap-1{gap:4px}
    ${order === "forward" ? sheets.join("\n") : [...sheets].reverse().join("\n")}
    </style></head><body><main class="storefront-root sm-grid-m2 sm-grid-d5 ${variants[skin]}">
    ${surface === "home" ? `<section class="home-section"><div class="home-section-head"><h2 class="home-section-title">Artisanal Amber Brews</h2><p class="home-section-sub">Small-batch drinks and thoughtfully selected bundles.</p></div><div class="home-product-carousel"><div class="home-product-scroll">${cards(fixture)}</div></div></section>` : `<div class="shop-listing"><div class="shop-panel-body"><div class="shop-grid">${cards(fixture)}</div></div></div>`}
    </main></body></html>`;
}
const executablePath =
  process.env.CHROME_EXECUTABLE_PATH ||
  (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : chromium.executablePath());
const browser = await chromium.launch({ executablePath, headless: true });
const failures = [],
  measurements = [];
try {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  for (const width of [360, 390, 768, 1024, 1440])
    for (const skin of Object.keys(variants))
      for (const surface of ["home", "shop"])
        for (const order of ["forward", "reverse"])
          for (const fixture of ["regular", "long-label-price"]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.setContent(html(skin, surface, order, fixture));
            const result = await page.evaluate(() => {
              const box = (el) => el.getBoundingClientRect();
              return {
                overflow: document.documentElement.scrollWidth > innerWidth + 1,
                cards: [...document.querySelectorAll(".shop-card")].map(
                  (card) => {
                    const frame = box(card),
                      media = box(card.querySelector(".shop-card-img"));
                    const cat = card.querySelector(".shop-card-cat"),
                      catBox = box(cat),
                      style = getComputedStyle(cat);
                    const name = box(card.querySelector(".shop-card-name"));
                    const add = card.querySelector(".shop-card-add"),
                      button = box(add);
                    const escaped = [
                      ...card.querySelectorAll(
                        ".shop-card-cat,.shop-card-current,.shop-card-deal,.shop-card-add",
                      ),
                    ]
                      .filter((el) => {
                        const r = box(el);
                        return (
                          r.width &&
                          (r.left < frame.left - 1 ||
                            r.right > frame.right + 1 ||
                            el.scrollWidth > el.clientWidth + 1)
                        );
                      })
                      .map((el) => el.className);
                    return {
                      width: frame.width,
                      height: frame.height,
                      overhead: frame.height - media.height,
                      categoryHeight: catBox.height,
                      nameHeight: name.height,
                      priceHeight: box(card.querySelector(".shop-card-price"))
                        .height,
                      labelLineRatio:
                        parseFloat(style.lineHeight) /
                        parseFloat(style.fontSize),
                      labelGap: name.top - catBox.bottom,
                      buttonHeight:
                        getComputedStyle(add).display === "none"
                          ? null
                          : button.height,
                      escaped,
                    };
                  },
                ),
              };
            });
            const label = `${width}/${skin}/${surface}/${fixture}/${order}`;
            measurements.push({ label, ...result });
            const problems = result.cards.flatMap((c) => [
              ...(c.escaped.length ? [`overflow: ${c.escaped.join(",")}`] : []),
              ...(c.labelLineRatio > 1.3
                ? ["loose category line spacing"]
                : []),
              ...(c.labelGap < 4 || c.labelGap > 10
                ? [`category gap ${c.labelGap}`]
                : []),
              // An unusually long label needs additional lines. Ordinary cards
              // must stay compact; the stress fixture must remain fully readable.
              ...(skin !== "overlay" &&
              c.width < 250 &&
              c.overhead > (fixture === "regular" ? 220 : 250)
                ? [`excessive card height ${c.height}`]
                : []),
              ...(c.buttonHeight !== null && c.buttonHeight < 40
                ? [`small add target ${c.buttonHeight}`]
                : []),
            ]);
            if (result.overflow || problems.length)
              failures.push({ label, overflow: result.overflow, problems });
            if (
              screenshots &&
              width === 390 &&
              skin === "quickadd" &&
              fixture === "regular" &&
              order === "forward"
            )
              await page.screenshot({
                path: join(screenshots, `${surface}.png`),
                fullPage: true,
              });
          }
} finally {
  await browser.close();
}
console.log(
  JSON.stringify(
    {
      cases: measurements.length,
      failures,
      phone: measurements.filter(
        (m) =>
          m.label.startsWith("390/quickadd/") &&
          m.label.endsWith("regular/forward"),
      ),
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
