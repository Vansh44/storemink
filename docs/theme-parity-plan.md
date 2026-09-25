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
| 1.5  | Variant option axes (size × colour), swatches, quick add for variant products                          | planned |
| 1.6  | Nested mobile menu drawer + desktop mega menu (menu items gain children and an optional image)         | planned |
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
