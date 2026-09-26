# Theme parity plan — Shopify paid-theme quality from one prompt

Owner goal (2026-09-25): Theme Studio must produce storefront themes at the
level of a paid Shopify theme (Prestige, Impulse, Symmetry, Dawn), flawless at
desktop, tablet and phone widths, with Shopify-level generated imagery, from as
few operator prompts as possible — "create a website for <category>" plus
optional screenshots.

## Why the storefront comes first

A generated theme is DATA rendered by one shared storefront. A prompt can only
choose among what the storefront can draw, so no amount of model work closes a
gap the renderer has. A 2026-09-25 audit of `app/(storefront)` against a paid
Shopify theme found the home sections broadly present and the gaps in shopping
UX and mobile behaviour. This plan closes those gaps first, then makes the
Studio use them.

## Rules that apply to every step

- **Opt-in, never a silent change to a live store.** A new capability that adds
  visible chrome is a theme layout/design option; existing themes and stores
  keep today's rendering until a theme (or merchant override) selects it.
  Strict improvements with no visual change at rest (e.g. swipe on an image the
  page already shows) may apply to everyone, and say so here.
- Every new option is added to the Theme Studio Stage B schema and prompt in
  the same change, so generated themes can use it.
- Merchant-visible editing changes follow the Help Centre gate in AGENTS.md;
  shopper-only rendering changes do not need a guide.

## Track 1 — mobile-first storefront capabilities

| #    | Step                                                                                                   | Status  |
| ---- | ------------------------------------------------------------------------------------------------------ | ------- |
| 1.1  | Product gallery: phone swipe with counter, lightbox with prev/next, swipe, keys and pinch (universal)  | ✅      |
| 1.2  | Sticky add-to-cart bar on phones (`layout.stickyAddToCart`)                                            | ✅      |
| 1.3  | Shop grid columns per breakpoint, 2 on phones (`layout.gridColumnsMobile/Desktop`)                     | ✅      |
| 1.4  | Hero: focal point, separate mobile image, height and overlay controls; swipe on the hero carousel      | ✅      |
| 1.5  | Variant option axes (size × colour), swatches, quick add for variant products                          | ✅      |
| 1.6  | Nested mobile menu drawer + desktop mega menu (menu items gain children and an optional image)         | ✅      |
| 1.7  | Predictive search dropdown; search visible in the phone header                                         | ✅      |
| 1.8  | Shop page: sort, price/availability filters, load more, category banner and per-category URLs          | ✅      |
| 1.9  | Cart drawer: free-delivery progress bar, upsell row                                                    | planned |
| 1.10 | Product page: shipping/returns/size accordions, theme-tokened badges and trust row, rich description   | planned |
| 1.11 | Announcement bar in the header (static/rotating, dismissible); dedicated logo strip; countdown section | planned |
| 1.12 | One breakpoint and container scale across the storefront                                               | planned |

### Found and fixed while building 1.1–1.3

- **Every storefront page's `<main>` could be wider than the phone.** The
  storefront root is a flex column, so a `margin: 0 auto` main was sized
  shrink-to-fit and one wide child set its width: the grocery product page
  measured 734px on a 390px screen, the right half cut off by `overflow-x:
clip`. Fixed with `.storefront-root > main { width: 100% }`, and the
  single-column product grids now use `minmax(0, 1fr)`.
- **The acceptance overflow gate could not see it.** The probe read
  `scrollWidth`, which `overflow-x: clip` hides. It now also measures element
  rectangles (off-canvas fixed drawers and fitting carousels are exempt).
- After the fix, a sweep of home, shop, a product, cart and two content pages
  at 360, 390, 768 and 1024px found 0px overflow on all four bundled demo
  stores.

### Found and fixed while building 1.4

- **A phone image must not be a second image.** Toggling two `<Image>`s with
  CSS preloads both, because the first hero is eager. The phone image is art
  direction in one `<picture>`, so a phone downloads only the phone file and a
  desktop only the banner (verified in the browser at 375, 768 and 1280px).
- **Every control defaults to storing nothing**, so no existing hero changes.
  The carousel's swipe and reduced-motion pause are universal: at rest nothing
  looks different, and a banner that moves by itself is exactly what reduced
  motion asks to stop.

### Found and fixed while building 1.5

- **The product page opened on the first variant even when it was sold out**,
  greying the buy button on arrival for a product with stock in every other
  size. It opens on `?variant=` when given, else the first variant in stock.
- **The grocery variant list greyed out any variant at stock 0**, including
  untracked and backorderable ones the classic layout sold. Both layouts use
  the shared sold-out rule.
- **"+ Add" on a card did nothing useful for a product with variants** — it
  fell through to the product page. It opens a chooser with the same pickers.
- Deferred: CSV Option1/2/3 columns, per-axis choice at the POS, swatches on
  product cards, and ProductGroup structured data.

### Found and fixed while building 1.6

- **The phone drawer could not scroll.** It was a fixed 100vh column with no
  overflow, so a long menu was cut off below the fold with nothing to say so.
  It scrolls now, at `100dvh`.
- **An image-only menu tile would have been an unnamed link.** The tile is a
  link whose accessible name comes from its caption, not an `alt=""` image.
- Deferred: a merchant-chosen promo block in the panel other than one image,
  per-link icons, and a nested footer.

### Found and fixed while building 1.7

- **The phone header had no search.** The header box is hidden below 768px and
  search lived only inside the menu drawer — a tap, a scroll, and shown even
  when the merchant had switched search off. A search icon in the phone header
  opens a full-width sheet; the drawer copy is gone, and the merchant's
  "Show search" switch now governs phone search too.
- **The dropdown and the results page share one matching rule**
  (`lib/storefront/product-search.ts`), so a suggestion is always something
  "See all results" will show. Ranking only orders matches.
- **The box now reads the cached catalogue through a GET route**, not a server
  action — actions run one at a time per client, so a keystroke's lookup would
  have queued in front of the shopper's next Add to cart.
- Deferred: matching blog posts and pages, typo tolerance, and recent searches.

### Found and fixed while building 1.8

- **A category had no address of its own.** `/shop?category=` rendered one
  shop for every category, with one canonical, so no category page could be
  indexed or shared. `/collections/<slug>` is a real page with its own title,
  description, image and breadcrumb; the old links 308 there, keeping their
  search and filters.
- **The category chips were buttons**, so a shopper could not open a category
  in a new tab and a crawler could not follow one. They are links now.
- **A product's breadcrumb could link a hidden category**, which then showed
  the whole shop. It links only an active one.
- **Sort, filters and load more are opt-in** (`shopFilters`), and a store
  without them ignores those URL parameters, so no existing shop changes.
  Filter edits are a draft until "Show N products".
- Deferred: filtering by option value (size, colour) and by tag, server-side
  pagination for catalogues too large to load at once, and a price slider.

### Found and fixed after Track 1.8

- **Text over a photo could be unreadable on every theme.** A section's text
  colour is chosen per section, not per image. Each section that puts copy on
  an image now measures the photo behind the words once it loads and uses
  whichever text colour reads there; only when neither does (a busy photo)
  does it add a soft gradient from the edge the copy sits on. A first attempt
  painted a pale panel behind the words and was rejected as ugly.
- Carousel copy is padded clear of the arrows, and the arrows are hidden on
  touch phones, where swipe and the dots remain.
- Full-width media + text bands keep the page margin; only the carousel, hero,
  ticker, trust bar and newsletter run edge to edge.
- The header no longer overlaps at tablet widths. It measures itself and
  folds what does not fit into the drawer, one step at a time: the menu
  (behind the hamburger), then the delivery control, then the search box (a
  search icon opens it instead). A fixed breakpoint cannot do this, because
  whether a header fits depends on the theme's font and the merchant's menu.
  Checked on all four themes from 769px to 1440px. Delivery was also
  unreachable between 769px and 900px; it now always lives in one place or
  the other.

### First live Gemini run (2026-09-25, Gemini 3.8 Flash, prompt v6)

The golden set was run against the real model for about $1.12. 15 of 32 cases
returned: 12 passed, 3 acceptable (injection or remote-fetch briefs came back
as a clarifying question instead of a refusal), 0 unsafe. The other 17 were
`rate_limited` — Vertex returned `RESOURCE_EXHAUSTED` even for a 5-token call,
so it was project or shared capacity, not request pacing. They are unrun.

- **Gemini accepts the large Stage B schema** with no repair rounds.
- **The generated themes use the new controls.** Of 9 saved packages, 7 had a
  mega menu, and all used nested menus with an image, product options (mostly
  with swatches), hero height and overlay, the phone buy bar and a
  two-column phone grid.
- **The prompt contradicted a production floor.** It asked for "three to six
  categories" while `validateThemeSampleData` requires four, and the compiler
  never ran the content floors, so a three-category theme passed the pipeline
  and failed only at acceptance. The compiler now runs the model-controlled
  floors (pages, homepage, sample data, links, design) as repair issues, and
  the prompt (`theme-studio-v7`) states them — including that a section
  example's placeholder link (`/our-story`) must be replaced.
- **The 17 rate-limited cases were rerun** (2026-09-25, about $1.06, no spend
  cap): 8 passed — including all three capability-gap briefs and both
  clarify briefs — 0 unsafe, and 9 were refused again by Vertex capacity (8
  `rate_limited`, 1 `provider_unavailable`). 23 of 32 cases have now run.
- **A rate limit is now waited out.** The SDK's own
  retry was one to two seconds apart, too short for this shortage. The model
  client now waits 15s, 30s, 60s, then 120s twice, with jitter, for at most
  six minutes and never past the run's deadline, before reporting
  `rate_limited`. A 429 is refused before the model runs, so waiting cannot
  bill twice.

## Track 2 — design engine

Themes gain type scale, button styles, container width, spacing rhythm, named
per-section colour schemes and restrained reveal-on-scroll motion.

| #   | Step                                                                                              | Status  |
| --- | ------------------------------------------------------------------------------------------------- | ------- |
| 2.1 | Per-section colour schemes: Soft, Tinted, Brand, Dark (`style.scheme`, theme-declared or derived) | ✅      |
| 2.2 | Type scale and heading style (`design.typography`: face, scale, weight, case, spacing)            | ✅      |
| 2.3 | Button styles                                                                                     | planned |
| 2.4 | Container width and spacing rhythm                                                                | planned |
| 2.5 | Restrained reveal-on-scroll motion                                                                | planned |

### Found and fixed while building 2.1

- **A section could change its background and nothing else.** The Style tab's
  colour set one inline background, so text, cards and buttons stayed tuned
  for the page. The "Contrast" preset put the default dark text on a
  near-black band. A scheme changes all of them together, and both presets
  now apply a scheme.
- **A product card's tile stayed light inside a dark band while its text
  turned white.** Cards, tiles and heroes whose copy sits on a photo carry
  their own fill, so inside a band they keep the page's colours.
- **A theme's button colours are not body-text colours.** Basket's white on
  orange is 3.41:1, fine for a button and unreadable as a band of copy. A
  derived Brand band picks a theme text colour that reaches 4.5:1, and black
  or white when none does.
- **The newsletter would have been a card inside a band.** Its own fill
  flipped to a white card inside a dark band; inside a band it drops its
  fill.
- Opt-in: no stored section has a scheme, and the bundled themes keep their
  hand-set section backgrounds. Generated themes use schemes through Stage B
  (`theme-studio-v9`).
- Checked on all four demo themes at 375, 768 and 1280px by rotating every
  scheme through every eligible section. No text fell below 4.5:1 because of
  a scheme, and nothing overflowed. The builder picker was tested in jsdom,
  not looked at in a signed-in browser.
- Deferred: migrating the bundled themes' hand-set backgrounds to declared
  schemes, schemes on the header and footer, and more than four schemes.

### Found and fixed while building 2.2

- **Themes chose a display face and almost nothing used it.** Studio and
  Ritual set Fraunces and Vitrine set Instrument Serif as the display font,
  but every homepage heading read the body font; only the collection-page
  title used the display slot. `typography.headingFont: "display"` puts the
  display face on every page and section heading.
- **A face with no bold weight fakes one.** Jost is loaded at 300–500 and
  Instrument Serif at 400 only, while headings ask for 600–800, so the browser
  smears regular glyphs into faux bold. Theme validation now refuses a
  typography block whose heading face would do that, and Theme Studio gets it
  back as a repair. Vitrine's current headings do this today (Jost at
  650–800); it has no typography block, so it is not judged, and fixing it
  means a new Vitrine release that sets a weight.
- **A capitalised, extra-large product name overflowed the editorial product
  page's narrow column** ("SNEAKER" at 1280px). Any typography setting lets a
  word that does not fit wrap inside its heading.
- Opt-in: a theme without `design.typography` writes no variable and no class,
  and every heading computes the same size, face, weight and spacing as
  before (checked on Vitrine at 1024px). Bundled themes were not changed.
  Generated themes set it through Stage B (`theme-studio-v10`).
- Checked on all four demo themes at 375, 768 and 1280px on the homepage,
  shop, a product page, the cart and a collection page, under three extreme
  settings (extra-large display capitals with wide spacing, extra-large heavy
  body type with tight spacing, extra-large capitals only): no heading wider
  than its box and no page overflow after the wrap fix. Phones get half the
  scale (1.25 becomes 1.125 at 375px).
- Deferred: a merchant control for heading style in the builder. Mink's
  design proposals replace the whole design override set, so adding typography
  there needs its own change to that contract. Utility page titles (checkout,
  account, orders) keep their plain style.

## Track 3 — generated imagery

Theme Studio generates every asset brief with the Gemini image model already
used by Mink: one art-direction anchor per theme so the set is coherent,
consistent product pack shots, crop to each slot's ratio, a vision quality check
with regeneration. Owner decision: no per-theme cost cap.

## Track 4 — fewer prompts

Industry playbooks (page structures, section order, palette families, image
style), structured reading of reference screenshots, and proceed-on-assumptions
instead of clarifying questions.

## Track 5 — automated QA and self-critique

A separate Cloud Run job with headless Chromium (owner-approved) screenshots
every surface at 360, 390, 768, 1024 and 1440 px, measures overflow, clipped
text, tap targets, image crop, axe, LCP and CLS, and a vision model scores the
screenshots against the theme-acceptance scorecard and revises before an
operator sees the theme.
