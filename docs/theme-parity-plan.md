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

| #   | Step                                                                                              | Status |
| --- | ------------------------------------------------------------------------------------------------- | ------ |
| 2.1 | Per-section colour schemes: Soft, Tinted, Brand, Dark (`style.scheme`, theme-declared or derived) | ✅     |
| 2.2 | Type scale and heading style (`design.typography`: face, scale, weight, case, spacing)            | ✅     |
| 2.3 | Button styles (`design.buttons`: shape, primary/secondary fill, case, weight, spacing, hover)     | ✅     |
| 2.4 | Page width and spacing rhythm (`design.page`: width, section gap, product-grid gap)               | ✅     |
| 2.5 | Restrained reveal-on-scroll motion (`design.motion.reveal`: fade or rise)                         | ✅     |

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

### Found and fixed while building 2.3

- **Storefront buttons had no shared identity.** Every button set its own
  colours, radius and hover in its own stylesheet, so a theme could not make
  "Buy now" and "Shop now" belong together. Buttons now carry a role class
  (primary or secondary), and each one paints from a declared colour pair, so
  one setting reaches all of them without changing any button a theme leaves
  alone.
- **An outlined button on the newsletter card read ink on ink.** On Vitrine
  the newsletter's light theme is an ink card, and a ring drawn in Vitrine's
  near-black accent disappeared into it (1:1). The card now counts as a colour
  field, where rings take the text colour, like the hero and banners.
- **An outline or underlined button needs a readable accent.** Validation
  refuses one when the accent does not reach 4.5:1 on the page, on cards, or
  in a scheme's band. Basket's orange on cream is 3.41:1, so Basket cannot
  ship outlined buttons without a darker accent.
- **Dropped: an underlined, text-only primary.** An "Add to cart" that looks
  like a link loses to a filled button, so text is offered for secondary
  buttons only.
- Found, not fixed: the cart drawer renders outside the themed storefront
  root, so no theme colours or button styles reach it. The editorial
  media-text button is a pill on every theme (it reads a radius token nothing
  defines) unless a theme sets a button shape. The footer newsletter button
  is not tagged.
- Opt-in: a theme without `design.buttons` emits no class and no variable.
  Bundled themes were not changed. Generated themes set it through Stage B
  (`theme-studio-v11`).
- Checked on all four demo themes at 375, 768 and 1280px on the homepage,
  shop, a product page and the cart, under three extreme settings (square
  outline with text secondaries, bold capitals and invert hover; pill with
  solid secondaries and lift; rounded outlines with capitals and darken). No
  button overflowed. The only contrast failures were Basket's outlined
  buttons, which validation refuses, and its existing 3.41:1 white on orange.
- Deferred: a merchant control for button style in the builder, for the same
  reason typography has none yet.

### Found and fixed while building 2.4

- **Nothing on a page lined up.** Homepage blocks stopped at 1320, 1440 or
  1200px, product rows and the shop listing ran the full screen, the product
  page and cart stopped at 1100 or 1120px, the footer at 1400px, and the
  header's logo sat 24px from the edge. With a theme width set, the header,
  every homepage section, the shop, the product page, the cart and the
  footer start at the same point.
- **Coloured bands stay full width.** A section keeps its band edge to edge
  and only its content is held to the page width. A section a merchant marks
  "Full width" ignores the theme width, as on Shopify.
- **The footer and two product layouts pad inside their width.** Their
  columns would have started 64px inside everything else; their cap is the
  page width plus that padding.
- **On editorial themes the shop and product pages were pinned to the left
  on large screens.** A rule meant for the editorial product page also caught
  the shop listing and never centred either, so on Vitrine at 1920px the shop
  grid had 64px on the left and 504px on the right. Fixed for every editorial
  theme, whether or not it sets a width.
- Opt-in: every width and gap reads its current value when a theme sets
  nothing, and the bundled themes were not changed. Generated themes set it
  through Stage B (`theme-studio-v12`).
- Checked on all four demo themes at 375, 768, 1280, 1600 and 1920px on the
  homepage, shop, a product page and the cart, under narrow, wide and full
  widths with compact and airy section spacing: every page lined up and none
  overflowed. Phones and tablets are unchanged at every setting.
- Not covered: blog pages, account pages and checkout keep their own reading
  widths. The compact cart stays a narrow column by design.
- Deferred: a merchant control for page width in the builder.

### Found and fixed while building 2.5

- **Sections fade in, or fade and rise, as they scroll into view.** Only
  sections below the first screen move, so the first thing a shopper sees is
  never held back and nothing flashes. Without JavaScript, or before the page
  is ready, every section is simply visible.
- **Motion never hides anything that matters.** It is off for shoppers who ask
  their device for reduced motion, off in the builder, and a section shows at
  once when keyboard focus enters it or the page is printed.
- **Theme Studio's acceptance checks would have skipped hidden sections.**
  The accessibility and overflow checks ignore invisible content, so the
  checker now reveals every section before it measures.
- **The intent's motion preference finally does something.** Theme Studio has
  recorded "none", "restrained" or "expressive" since Phase 0 and nothing
  used it; it now maps to none, fade and rise.
- Opt-in: a theme without `design.motion` mounts nothing and adds no class,
  and the bundled themes were not changed (`theme-studio-v13` for generated
  themes).
- Checked in the browser on Ritual with rise forced for the test: only
  sections below the first screen started hidden, every one arrived during a
  full scroll and kept no leftover attribute, the page height did not change
  and layout shift was 0. Leaving the page and coming back re-scanned it, and
  the checker's reveal-all showed every section at once.
- Deferred: per-card and per-heading motion, and a merchant control in the
  builder. Track 2 is complete.

## Track 3 — generated imagery

Theme Studio generates every asset brief with the Gemini image model already
used by Mink: one art-direction anchor per theme so the set is coherent,
consistent product pack shots, crop to each slot's ratio, a vision quality check
with regeneration. Owner decision: no per-theme cost cap.

| #   | Step                                                                                                           | Status |
| --- | -------------------------------------------------------------------------------------------------------------- | ------ |
| 3.1 | Image client: allowlisted model, its own prompt, request builder (anchor, composition per purpose), fake, cost | ✅     |
| 3.2 | Generation run: anchor first, every placeholder art slot matched to it, cropped to its slot, one new version   | ✅     |
| 3.3 | Consistent product pack shots: one staging across products, a distinct slot per product                        | ✅     |
| 3.4 | Vision quality check with regeneration                                                                         | ✅     |
| 3.5 | Studio screens: generate, regenerate a slot, show the brief and the cost                                       | ✅     |
| 3.6 | Catalog card and screenshots captured from the preview store, so a generated theme can publish                 | ✅     |

### Found and fixed while building 3.1

- **Theme Studio had no way to call an image model.** Its client sends JSON
  requests only, no image model was allowlisted, and cost was priced in text
  tokens. The image client uses the same model Mink already calls, behind its
  own allowlist entry, prompt and safety settings, so a theme's demo images
  meet the same bar as a merchant's.
- **Where a subject sits is decided by code, not the brief.** A hero is cut
  taller on phones and a category tile to a circle; the model writing the
  brief cannot know that, so the composition for each kind of image is fixed.
- **Every image after the first is matched to an art-direction anchor**, and a
  product shot can also be matched to an earlier product shot, so a set reads
  as one shoot.
- **One paid attempt per image.** A timeout may already have been billed, so
  only a rate-limit refusal (which bills nothing) is retried.
- **Cost:** about $0.10 per 2K image at Google's list price.
- Checked live on 2026-09-26: an art-direction image and two product shots
  matched to it, about 20 seconds and $0.10 each. The three read as one shoot
  (same palette, glaze and light), the product shots share one backdrop and
  camera height, and none carries text, a logo or a person. Each was cropped
  to its slot and came in at 53–106 KB against a 500 KB limit.
- Found, for 3.3: nothing stops every product sharing one image slot, and the
  offline test provider does exactly that.

### Found and fixed while building 3.2

- **An operator can now have Theme Studio draw a version's images.** It draws
  one art-direction image, then every placeholder picture matched to it, and
  saves them as a new version; the version drawn from stays as it was. The
  cost is shown before the click, and a run is never retried on its own
  because every image is paid.
- **Only placeholders are drawn.** An image an operator uploaded is never
  replaced, and the catalog card and screenshots are left alone because they
  are pictures of the storefront.
- **If the art-direction image is refused, nothing else is drawn**: images
  without the shared look would not belong together and would each be paid
  for. A picture refused on its own keeps its placeholder while the rest are
  drawn.
- **Found, now planned as 3.6: a generated theme still cannot publish on its
  own.** Publication requires a real catalog card and two screenshots, which
  only an upload provides today.
- Checked end to end against a real local database with the offline
  providers: queueing, the run, every stored image, the new version and its
  parent, the package contract, a refused art-direction image and a retry.
  The live image model was checked separately with the same request shape.

### Found and fixed while building 3.3

- **Every product now gets its own photograph.** Theme Studio used to let all
  products share one image slot, and its offline test provider did exactly
  that. The design stage now writes one brief for how the whole range is
  photographed, and each product gets its own slot drawn from that brief. A
  revision that keeps a product keeps its photo.
- **Two products sharing one photograph is now refused** by the production
  sample-data checks, so the model is asked to fix it and acceptance refuses
  it. No bundled theme shares one.
- **The range reads as one shoot.** The first product photo that comes back is
  sent with every later product photo, so they share a backdrop, camera
  height, framing and scale. If it is refused, the next one that works takes
  its place. The hero, category and editorial images start at the same time
  and don't wait for it.
- **Each product photo is described by the product itself**: its name and
  description, staged the way the range brief says. A version made before this,
  where several products still share a slot, keeps the old description instead
  of borrowing one product's name.
- No extra images and no meaningful extra cost: each later product request
  carries one more reference image.
- Checked live on 2026-09-27: a ceramics theme with eight products (mug,
  ramen bowl, vase, plate, teapot, jug, platter, espresso cups), plus the
  art-direction image and the hero. Every product came out as itself, on the
  same warm seamless backdrop, at the same eye-level camera, light and scale.
  None had text, a logo or a person. It cost $1.45 for ten images.
- Found: the shared staging project rate-limits image requests hard. Ten
  images took 6 minutes 20 seconds, mostly waiting out rate-limit refusals,
  which cost nothing. A full theme (sixteen products plus art) could approach
  the 19-minute run deadline. A run that hits it keeps what it drew, and the
  rest stay placeholders. Not changed here.
- Found: one product request came back with 8,400 output tokens instead of the
  usual 1,680 (about $0.50 instead of $0.10). Only the first image is kept.
  The cost estimate and daily spend cap already count the whole bill.

### Found and fixed while building 3.4

- **Every generated image is now checked before it is used.** A fast vision
  model looks at each image as the storefront will crop it, next to the
  art-direction image and, for products, the first product photo. It can only
  name problems from a fixed list: wrong subject, lettering or a logo, a
  person, something malformed, more than one product, off-style, a different
  setup, or a bad crop.
- **A problem means one redraw**, told what was wrong. If a serious problem
  (the first five) is still there after it, the slot keeps its placeholder so
  a bad image never reaches a store. If only a minor one is, the better image
  is kept and the problem noted. A refusal or provider error is not redrawn.
- **If the art-direction image is rejected twice, nothing else is drawn**, as
  when it is refused. A rejected product photo is never used as the setup for
  the others.
- **If the checker is unavailable, the images are kept** and marked
  unchecked: it is a quality check, and the image model's own safety filters
  have already run.
- **Cost:** about $0.003 a check. The Generate panel now gives the likely cost
  and the most a run can cost if every image has to be redrawn, and checks
  count toward the daily spend limit.
- Checked live on 2026-09-27: on a ceramics set the checker caught
  hand-painted lettering on a mug, and sent two product photos on a different
  backdrop back to match the first; the redraws matched.
- **Found and fixed:** the lettering-free redraw of that mug was first
  rejected as the wrong subject, because the product's description asked for
  the words. The checker is now told a store image never carries lettering,
  so leaving it out is never the wrong subject. Rechecked live: the redraw
  passed.
- **Found, not changed:** redraws add requests, and on the staging project's
  image quota two product photos failed after the rate-limit waits ran out.
  They keep their placeholders.
- Checked end to end against the local database with the offline providers:
  a redraw that passes, and one whose serious problem remains.

### Found and fixed while building 3.5

- **Any placeholder or generated image can now be redrawn on its own.** On a
  version's Images page an operator ticks the images to redraw and sees the
  likely cost and the most it can cost before confirming. An image the
  operator uploaded is never offered: it is theirs to replace.
- **A redraw matches the set it joins.** It reuses the theme's existing
  art-direction image and, for a product, an existing product photo, so the
  new image sits in the same light and setup as the rest. It finds them even
  after an upload or an earlier redraw.
- **Each image shows its story**: what the image model was asked for, whether
  it was redrawn, what the check found, and what it cost. The run list shows
  what an image run drew, redrew, kept with a minor problem or left as a
  placeholder, with the image and check costs separately.
- Found: the run list had no wording for image-run failures (they showed as
  "The run failed."). It now says what happened.
- Checked end to end against the local database with the offline providers,
  including a redraw after an upload. Checked live on 2026-09-27: a redrawn
  teapot matched the existing set's linen and light, for $0.105.
- Not checked in a browser: the Studio needs a superadmin sign-in. The screens
  are covered by component tests.

### Found and fixed while building 3.6

- **A generated theme can now publish without an upload.** On a version's
  Images page, "Capture catalog pictures" has a real browser open the
  version's private preview and photograph its home page as the catalog card
  and the desktop and phone screenshots, saved as a new version. It waits
  until the theme's own images are real, since the pictures show them.
- **The pictures are taken by a separate job with headless Chromium**
  (owner-approved), which Track 5's automated checks can reuse. It can only
  open the one preview it was given, and only while that capture is running.
  The job still has to be deployed and scheduled:
  `docs/theme-studio-capture-job.md`.
- Checked locally with real Chrome: two captures, each producing three
  correctly sized pictures, and a version whose publication check went from
  "3 image slots still have a placeholder" to nothing. Failure paths checked
  against the local database.
- **Found: preview stores showed "Name · v7 preview" as the shop's name**, which
  the pictures would have shown. Previews now show the theme's own name.
- **Found and fixed in the storefront: a long shop name ran under the header
  icons on phones** (by 209px for a 29-character name on a 375px screen). It
  now shortens with an ellipsis; on wider screens it does so only once the
  menu, delivery control and search have all folded away. Names that fit look
  exactly as before on all four demo themes.

## Track 4 — fewer prompts

**Implemented 2026-09-28.** `industry-playbooks.ts` provides an exhaustive
starting pattern for every Studio industry: page structure, homepage section
order, palette families, image direction and explicit defaults. Stage A now
returns a structured analysis for every supplied reference screenshot
(hierarchy, palette, typography, imagery, responsive clues, patterns to reuse
and details not to copy). Its prompt treats clarification as exceptional: it
uses the playbook and records assumptions unless the trusted brief fails to
say what is sold or contains directly conflicting hard requirements. A first
unnecessary clarification gets one bounded proceed-with-assumptions repair.
The fake provider and contract tests exercise the same shape.

Found while implementing: a playbook initially named `latest_blogs`, a section
the renderer does not support. Exhaustive playbook tests now require every
suggested section to come from the real homepage registry; the editorial slot
uses `rich_text` instead.

## Track 5 — automated QA and self-critique

**Implemented 2026-09-28 and deployed 2026-09-29.** With both
`THEME_STUDIO_CAPTURE_ENABLED=true` and `THEME_STUDIO_AUTO_QA_ENABLED=true`, a
generation or revision remains internal while the worker automatically draws
its imagery and captures its catalog pictures. The existing Chromium job then
opens every available preview surface at 360, 390, 768, 1024 and 1440 px. It
uses the same in-store probe as manual acceptance to measure overflow, clipped
text, sub-24px tap targets, extreme `object-fit: cover` crops, axe results,
broken images, LCP and CLS, and posts a screenshot for each page/width pair.

The server applies deterministic browser gates before trusting any model
verdict. `visual-qa.ts` composes the screenshots into one contact sheet per
width and asks the configured Studio model for the exact eight-row
theme-acceptance scorecard and closed rejection conditions. A pass needs every
row ≥4, total ≥34, no rejection, and every required browser gate green. A
failure queues a concrete automatic revision against the exact hidden version;
two revision rounds are allowed. Pass reveals the final version with a passed
marker. A third miss, a terminal worker error, or a terminal capture error
reveals the last complete version with a failed-QA marker, so a project cannot
remain invisibly wedged. Internal versions never appear in the operator's
version list before one of those terminal outcomes.

The queue/evidence record is `theme_studio_visual_qa_runs`; migration
`20260927_0144` also adds internal/operator visibility and QA state to versions,
automation metadata to runs/captures, and `qa_screenshot` assets. Dev and
production now run the one-minute model worker and five-minute Chromium job;
Cloud Build durably enables the real provider, capture and automatic QA after
both workers completed their empty-queue smoke checks.

Found while implementing: the original immutable-version trigger also blocked
the one safe mutation this design needs. The migration replaces it with a
narrow guard that permits only `internal/pending → operator/passed|failed`;
intent, package, lineage, digests and iteration remain immutable.
