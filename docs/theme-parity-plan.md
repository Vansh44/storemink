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
| 1.7  | Predictive search dropdown; search visible in the phone header                                         | planned |
| 1.8  | Shop page: sort, price/availability filters, load more, category banner and per-category URLs          | planned |
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
- ⚠ The pipeline never retries a 429, by design. A merchant run during a
  capacity shortfall fails outright; a bounded backoff is worth adding before
  production traffic.

## Track 2 — design engine

Themes gain type scale, button styles, container width, spacing rhythm, named
per-section colour schemes and restrained reveal-on-scroll motion.

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
