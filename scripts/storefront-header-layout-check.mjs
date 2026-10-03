/** Offline header clearance regression using production CSS and local Chrome.
 * No network, database or provider calls. The measured cases model the height
 * published by useHeaderFit; its observer/lifecycle is tested in Vitest.
 * Run: node scripts/storefront-header-layout-check.mjs
 * --css-ref=<revision> diagnoses old CSS; --screenshots=<dir> saves fixtures,
 * not live storefront evidence.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const requireJob = createRequire(
  new URL("../jobs/theme-studio-capture/package.json", import.meta.url),
);
const { chromium } = requireJob("playwright-core");
const option = (name) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const ref = option("css-ref");
const screenshots = option("screenshots");
if (screenshots) mkdirSync(screenshots, { recursive: true });
const read = (path) =>
  ref
    ? execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" })
    : readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sheets = [
  read("app/(storefront)/storefront-theme.css"),
  read("app/(storefront)/components/homepage/homepage.css"),
  read("app/(storefront)/components/header/Header.module.css"),
  read("app/(storefront)/components/delivery/delivery-location.module.css"),
].map((css) => css.replace(/:global\(([^()]*)\)/g, "$1"));
const publishesHeight = read(
  "app/(storefront)/components/header/use-header-fit.ts",
).includes("publishHeight();");
const icon =
  '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/></svg>';
const hero =
  '<div class="home-hero variant-minimal theme-dark"><div class="home-hero-copy"><h1 class="home-hero-heading">The new season</h1></div></div>';
const first = {
  ticker:
    '<section class="home-section home-pad-sm is-fullbleed" style="background:#2a211f"><div class="home-ticker theme-light speed-slow"><div class="home-ticker-track"><div class="home-ticker-seq"><span class="home-ticker-item">Complimentary delivery over ₹2,999</span><span class="home-ticker-item">Free 14-day exchanges</span></div></div></div></section>',
  text: '<section class="home-section"><div class="home-rich-text"><h1>Our story</h1><p>Thoughtfully made everyday essentials.</p></div></section>',
  hero: `<section class="home-section">${hero}</section>`,
  carousel:
    '<section class="home-section"><div class="home-carousel" style="height:300px">Photo carousel</div></section>',
  custom:
    '<section class="home-section home-custom-code"><div style="height:300px;background:#eee">Custom hero</div></section>',
};
function fixture(header, content, width, order) {
  // Landscape/tablet fits fold the same three controls as useHeaderFit.
  const compact =
    width > 768 && width < 1200
      ? 'data-header-compact="nav delivery search"'
      : "";
  return `<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:0;font:16px/1.5 Arial}button,input{font:inherit}button{padding:0}svg{display:block}
    :root{--sm-ink:#2a211f;--sm-cream:#fbfaf8;--sm-surface:#fff;--sm-ink-soft:#6e635e;--sm-ink-faint:#766861;--sm-on-ink:#fff;--sm-shadow-rgb:42,33,31;--sm-border:#ddd6cf;--sm-header-bg:#fbfaf8;--sm-header-fg:#2a211f;--sm-accent-warm:#8c6f63;--sm-on-accent:#fff;--sm-sand:#efebe6}
    ${order === "forward" ? sheets.join("\n") : [...sheets].reverse().join("\n")}
    </style></head><body><div class="storefront-root sm-header-${header}">
    <header class="header" ${compact}><div class="headerLeft"><a class="logo" href="/"><span class="brandNameText">Vitrine</span></a><nav class="navLinks"><a href="/shop">Shop</a><a href="/about">Our story</a></nav></div>
    <div class="headerRight"><div class="root" data-delivery-control><button class="trigger">${icon}<span class="triggerCopy"><small>Deliver to</small><strong>Check delivery</strong></span></button></div><div class="searchWrap"><form class="searchBar"><input class="searchInput" aria-label="Search" placeholder="Search products"></form></div><button class="phoneSearchBtn" aria-label="Search">${icon}</button><div class="iconGroup"><button class="userIcon" aria-label="Account">${icon}</button><button class="cartBtn" aria-label="Cart">${icon}</button></div><button class="hamburgerBtn" aria-label="Menu">${icon}</button></div></header>
    <main><div class="home-sections">${first[content]}<section class="home-section">${hero}</section></div></main></div></body></html>`;
}
const executablePath =
  process.env.CHROME_EXECUTABLE_PATH ||
  (existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : chromium.executablePath());
const browser = await chromium.launch({ executablePath, headless: true });
const measurements = [],
  failures = [];
try {
  const page = await browser.newPage();
  await page.route("**/*", (route) => route.abort());
  for (const [width, height] of [
    [360, 780],
    [390, 844],
    [430, 932],
    [768, 1024],
    [844, 390],
    [1440, 900],
  ])
    for (const header of ["classic", "centered", "minimal", "market"])
      for (const content of Object.keys(first))
        for (const order of ["forward", "reverse"])
          for (const mode of ["server", "measured"]) {
            await page.setViewportSize({ width, height });
            await page.setContent(fixture(header, content, width, order));
            if (mode === "measured" && publishesHeight)
              await page.evaluate(() => {
                const header = document.querySelector("header");
                header
                  .closest(".storefront-root")
                  .style.setProperty(
                    "--sm-header-h",
                    `${Math.ceil(header.getBoundingClientRect().height)}px`,
                  );
              });
            const result = await page.evaluate(() => {
              const header = document
                .querySelector("header")
                .getBoundingClientRect();
              const first = document
                .querySelector(".home-section")
                .getBoundingClientRect();
              const children = [
                ...document.querySelectorAll(
                  "header .logo,header .phoneSearchBtn,header .userIcon,header .cartBtn,header .hamburgerBtn",
                ),
              ]
                .map((el) => el.getBoundingClientRect())
                .filter((r) => r.width && r.height);
              return {
                headerHeight: header.height,
                contentTop: first.top,
                gap: first.top - header.bottom,
                controlsPadding: Math.min(
                  ...children.map((r) =>
                    Math.min(r.top - header.top, header.bottom - r.bottom),
                  ),
                ),
                overflow: document.documentElement.scrollWidth > innerWidth + 1,
              };
            });
            const label = `${width}x${height}/${header}/${content}/${order}/${mode}`;
            measurements.push({ label, ...result });
            const problems = [];
            if (["ticker", "text"].includes(content) && result.gap < 15.9)
              problems.push(
                `leading content overlaps/crowds the header (${result.gap}px)`,
              );
            if (result.controlsPadding < 11.9)
              problems.push(
                `controls have only ${result.controlsPadding}px vertical padding`,
              );
            if (width <= 768 && result.overflow)
              problems.push("phone viewport overflow");
            // Photo/custom-led transparent headers keep their existing origin;
            // the opaque market bar reserves space once, including in landscape.
            if (
              content === "custom" &&
              Math.abs(
                result.contentTop -
                  (header === "market" ? result.headerHeight : 0),
              ) > (mode === "server" ? 16 : 1)
            )
              problems.push("custom hero clearance changed");
            if (["hero", "carousel"].includes(content)) {
              const expected =
                header === "market"
                  ? result.headerHeight +
                    Math.min(32, Math.max(16, width * 0.025))
                  : Math.min(72, Math.max(40, width * 0.06));
              if (
                Math.abs(result.contentTop - expected) >
                (mode === "server" ? 16 : 1)
              )
                problems.push("native hero origin changed");
            }
            if (problems.length) failures.push({ label, problems });
            if (
              screenshots &&
              width === 390 &&
              header === "minimal" &&
              content === "ticker" &&
              order === "forward" &&
              mode === "measured"
            )
              await page.screenshot({
                path: join(screenshots, "vitrine-header.png"),
                clip: { x: 0, y: 0, width, height: 250 },
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
        (m) => m.label === "390x844/minimal/ticker/forward/measured",
      ),
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
