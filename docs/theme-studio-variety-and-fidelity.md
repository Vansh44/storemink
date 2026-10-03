# AI Theme Studio — Variety and Reference Fidelity

**Product requirements + technical requirements**

**Implementation status, 3 October 2026:** Track V (V1–V7) is implemented for
new v21 runs; the complete live exit criterion is still pending final validation
of collection-banner guidance (§12). Reference fidelity
(F1/F2) and renderer additions remain separate pending phases.

|          |                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Status   | Approved by owner 2026-10-03 (decisions in §11)                                                                                     |
| Date     | 2026-10-03                                                                                                                          |
| Area     | AI Theme Studio (operator console), shared storefront renderer                                                                      |
| Audience | Owner, engineering                                                                                                                  |
| Related  | `docs/mink-ai-theme-studio-plan.md`, `docs/theme-acceptance.md`, `docs/theme-studio-performance.md`, CODEBASE.md §11 (Theme Studio) |

---

## 0. Summary

Two problems, one cause.

1. **Every generated theme looks like the same theme.** Across the seven Gemini-generated themes in production, the product card, shop page, category section, newsletter band, page width, main button and page colours are identical in all seven. Only the accent colour, the photos, the corner radius and the header style change.
2. **A theme built from screenshots does not look like the screenshots.** Screenshots are reduced to prose notes by the first model stage; the stage that builds the theme never sees them, and nothing ever compares the result with them.

Both come from the same place: the generator is steered toward a small set of safe defaults, and it has no way to see, measure or correct how far its output is from what was asked for.

This document defines the problem with evidence (Part 1), the product requirements, and the technical design (Part 2) in three tracks:

- **Track V — Variety.** Make the model choose every visible style on purpose, allow real colour fields, and stop every theme converging on the same layout. Prompt, schema and default changes; no new renderer code.
- **Track R — Renderer vocabulary.** Add the fonts, section styles and component styles the renderer is missing, so different themes _can_ look different and screenshots _can_ be matched.
- **Track F — Reference fidelity.** Turn screenshots into a measured specification, build the theme from that specification, render it, compare it against the screenshots, and repair the gaps in a loop until it is as close as the renderer allows.

---

# Part 1 — Product requirements

## 1. Background

The AI Theme Studio (`/dashboard/themes/studio`, superadmin-only) turns an operator's brief and optional reference screenshots into a StoreMink theme: a data package (palette, fonts, layout choices, pages made of sections, sample catalogue, artwork) rendered by StoreMink's one shared storefront renderer. It never writes code. That is a deliberate security and maintainability decision and it stays: a theme can only use what the renderer can draw.

A theme goes through: brief → **Stage A** (design analysis → intent) → **Stage B** (intent → draft package) → compiler → layout preflight → artwork → final capture → automated acceptance + visual QA → operator publishes.

## 2. Problem 1 — every theme looks the same

### 2.1 Evidence (production, 2026-10-03)

Latest version of each of the seven Gemini-generated themes: Fashion, Luma, Crave, Luxe, Vanta, Aurelle, Bubble. Industries span clothing, beauty, jewellery, food and drink.

**Identical in all 7:**

| Setting                | Value in every theme                                                          |
| ---------------------- | ----------------------------------------------------------------------------- |
| Product card           | `quick_add`                                                                   |
| Shop page              | 2 columns on phones, filters on, sticky add-to-cart on, hover second image on |
| Category section       | circles, horizontal scroll                                                    |
| Last homepage section  | dark (`inverse`) newsletter band                                              |
| Page width             | `wide`                                                                        |
| Primary button         | `solid`                                                                       |
| Page background / text | near-white (`#FAF6EE`–`#FFFFFF`) / near-black                                 |

**Nearly identical:**

| Setting                                                      | Share                       |
| ------------------------------------------------------------ | --------------------------- |
| Heading font = display face, scale `large`, tracking `tight` | 6/7                         |
| Hero = single banner image                                   | 5/7                         |
| Scrolling ticker strip at the top                            | 6/7                         |
| Image-and-text band with image on the left                   | 5/6                         |
| Testimonials = 3 cards                                       | 4/4 that use it             |
| Reveal motion = fade                                         | 6/7                         |
| Body font = Plus Jakarta                                     | 4/7                         |
| Display font = Space Grotesk                                 | 3/7; only Luxe used a serif |
| Accent colour = black (fully monochrome theme)               | 3/7 (Luma, Luxe, Vanta)     |

**What actually differs:** header style (classic / centered / market), corner radius (0–24 px), button shape (pill / square), uppercase text (2 themes), accent colour, photos and copy.

To an operator or a merchant the themes read as one theme recoloured, which defeats the purpose of a theme catalogue.

### 2.2 Why it happens

| #   | Cause                                                                                                                                                                                  | Where                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| C1  | Every industry playbook starts from the same skeleton: hero → shop by category → featured products → image/text band → newsletter. The model follows it unless references override it. | `lib/theme-studio/industry-playbooks.ts`                                        |
| C2  | A new theme picks one of only **three** fixed layout compositions (classic / editorial / grocery), and the prompt says layout overrides should **"normally" be `"{}"`**.               | `lib/theme-studio/initial-draft.ts`, `prompts.ts` (`stageBInitialSystemPrompt`) |
| C3  | The draft expansion hard-codes the shop page for everyone: sticky add-to-cart, 2 mobile columns, filters, collection banner.                                                           | `initial-draft.ts` (`expandInitialDraft`)                                       |
| C4  | **Whatever is the preset wins.** Fields the model omits receive the section's preset (`EMPTY_CONFIG`): e.g. category = circles + scroll. Every theme kept them.                        | `initial-draft.ts` (`mechanicalDefaults`), `lib/homepage/section-types.ts`      |
| C5  | Quick add is described to the planner as a native capability, so every theme asks for the `quick_add` card, including luxury and jewellery.                                            | Stage A/B prompts                                                               |
| C6  | Light page / dark text is the safe answer to the contrast gate and nothing encourages a coloured or dark page.                                                                         | prompts, `lib/themes/validation.ts`                                             |
| C7  | The renderer vocabulary is small: 17 section types, most with 2–3 styles; 9 fonts of which only 2 are expressive display faces.                                                        | `lib/homepage/section-types.ts`, `lib/chrome/design.ts` (`DESIGN_FONTS`)        |
| C8  | The model never sees what themes already exist, so it has no reason to differ.                                                                                                         | pipeline input                                                                  |
| C9  | Visual QA rewards safe, readable choices; it never asks "is this distinct?".                                                                                                           | `lib/theme-studio/visual-qa.ts`                                                 |

## 3. Problem 2 — screenshots are not reproduced

The operator's intent when attaching screenshots is usually: "make our store look like this." Today:

| #   | Cause                                                                                                                                                                                        | Where                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| F1  | Screenshots go **only to Stage A**, which returns prose lists (`structure`, `palette`, `typography`… as free strings). Exact colours, sizes, spacing and proportions are lost in paraphrase. | `pipeline.ts`, `schemas.ts` (`referenceAnalysis`) |
| F2  | **Stage B never sees the screenshots**; it builds from the paraphrase.                                                                                                                       | `pipeline.ts` (Stage B content is text only)      |
| F3  | The prompt tells the model to "**extract design structure only**" and lists "distinctive identity" under `copyingToAvoid`, which works against resemblance.                                  | `prompts.ts` (`referenceLabel`, Stage A rules)    |
| F4  | The industry playbook is a competing source of truth and can override what the screenshots show.                                                                                             | `prompts.ts` (`factsBlock`)                       |
| F5  | **Nothing measures fidelity.** Visual QA judges the theme against a generic scorecard with zero references.                                                                                  | `visual-qa.ts` (`referenceCount: 0`)              |
| F6  | Even a perfect reading cannot be expressed when the renderer lacks the component (C7). Today that gap is silent.                                                                             | renderer                                          |
| F7  | Screenshots are not classified by page (home / collection / product) or viewport (desktop / phone), so a phone screenshot can drive desktop decisions.                                       | Stage A                                           |

## 4. Goals and non-goals

### Goals

- **G1 Variety.** Two themes generated for different briefs must look different at a glance, in layout and type as well as colour.
- **G2 Fidelity.** A theme generated from screenshots must reproduce the reference's visual system and page structure as closely as the renderer can express, and say precisely where it could not.
- **G3 Measurable.** Both variety and fidelity are scored automatically on every run and visible to the operator.
- **G4 Safe by construction.** Still data, never code; every existing acceptance, accessibility, contrast and security gate stays.

### Non-goals

- Pixel-identical clones. Photographs are regenerated (and never contain people), copy is original, and the renderer is shared; "near 100%" means the same _design_, not the same _pixels_ (see §6).
- Copying a third party's logo, brand name, marketing copy, photographs or trademarks.
- Letting the model write HTML, CSS or JavaScript.

## 5. Users and use cases

| User                       | Use case                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| Operator (StoreMink staff) | "Make a jewellery theme that does not look like Luxe."                                          |
| Operator                   | "Here are 6 screenshots of a store we like. Recreate this look for StoreMink."                  |
| Operator                   | "This theme is close but the hero and type are wrong — fix those." (screenshot-guided revision) |
| Merchant (indirect)        | Chooses from a catalogue where themes are genuinely different.                                  |

## 6. What "near 100% similar" means (legal and product boundary)

**Approved by the owner (2026-10-03).** Boundary:

| Reproduced (target ≈ identical)                                                                           | Not reproduced                                                     |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Page structure and section order                                                                          | Logos, wordmarks, brand names                                      |
| Layout per section (split, full-bleed, grid columns, carousel)                                            | Marketing copy and product names (always original)                 |
| Colour system (exact hex for page, text, accent, bands)                                                   | Photographs (regenerated in the same style, no people)             |
| Typography _feel_: serif/sans/display class, weight, case, scale ratio, tracking (nearest available font) | Exact proprietary typefaces not in StoreMink's font set            |
| Spacing rhythm, page width, density                                                                       | Distinctive trademarked trade dress the owner flags                |
| Component styles: buttons, cards, borders, radii, badges, header/footer layout                            | Custom interactions the renderer cannot express (reported as gaps) |

Principle: reproduce the _design system_, never the _brand identity_. This matches how a designer recreates "a store like X" for a client and keeps StoreMink clear of passing-off claims.

## 7. Functional requirements

### Track V — Variety

| ID  | Requirement                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V1  | The model must make an **explicit choice** for every visible style setting (card style, category style, hero type, newsletter style, page width, grid columns, motion, shop filters, sticky cart). No silent presets.                                                                |
| V2  | Page background and text may be **any palette that passes contrast**, including dark and coloured pages. The prompt must present this as normal.                                                                                                                                     |
| V3  | Quick add is a **card style option**, not a default capability; editorial and luxury briefs should normally use framed or overlay cards.                                                                                                                                             |
| V4  | Each industry has **2–4 alternative page structures**; the ticker strip is not part of any default.                                                                                                                                                                                  |
| V5  | The model receives a compact **fingerprint of existing catalogue and recent Studio themes** and must differ from the closest one on at least N of: layout composition, card style, hero type, page colour, fonts, button style.                                                      |
| V6  | Each new theme gets one of seven approved **design directions** (§T-V6): _luxury minimal_, _bold and loud_, _magazine / editorial_, _dense catalogue_, _soft and natural_, _playful and colourful_, _classic and trusted_. Chosen to fit the brief and to differ from recent themes. |
| V7  | A **distinctness score** is computed for every version and shown to the operator; below threshold triggers one targeted repair.                                                                                                                                                      |

### Track R — Renderer vocabulary

| ID  | Requirement                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Add ~10 fonts with distinct personalities: 2–3 serifs (high-contrast didone, humanist), a condensed display sans, a geometric sans, a monospace, a rounded sans, an editorial italic. |
| R2  | Hero styles: full-bleed with text overlay (positions), big-type no-image, asymmetric split, stacked collage, video-first.                                                             |
| R3  | Product card styles: bordered, shadowed, edge-to-edge image, image ratio (1:1, 4:5, 3:4), text alignment, price emphasis, badge styles.                                               |
| R4  | Section styles: dividers (none / line / wave / angled), spacing scale per section, section-level background image, borders vs shadows as a theme-wide choice.                         |
| R5  | New section types: lookbook, story / timeline, logo wall, comparison table, countdown / offer band, split collection showcase, editorial quote.                                       |
| R6  | Every addition is a registry entry with `validateConfig`, builder form, renderer, thumbnail, Theme Studio schema + prompt, and acceptance coverage — the existing section contract.   |

### Track F — Reference fidelity

| ID   | Requirement                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-1  | Each screenshot is classified by **page kind** and **viewport** before analysis.                                                                                                                                                           |
| F-2  | Each screenshot produces a **structured Reference Spec** (§T-F1): ordered regions mapped to StoreMink section types with measured attributes — never free prose for anything measurable.                                                   |
| F-3  | Colours in the spec are **measured from pixels**, not guessed.                                                                                                                                                                             |
| F-4  | Where the spec is explicit, it **overrides** the industry playbook and design-direction defaults (reference-locked fields).                                                                                                                |
| F-5  | Stage B receives the **screenshots and the spec**, not only Stage A's summary.                                                                                                                                                             |
| F-6  | After artwork, the theme is rendered at each reference's viewport and **compared region by region** with the reference; a **fidelity score** (0–100) and a list of differences are stored.                                                 |
| F-7  | Differences that settings can fix trigger **targeted repairs** (bounded iterations), re-measured each time. Differences the renderer cannot express are recorded as **capability gaps** and shown to the operator, never silently dropped. |
| F-8  | The operator sees the reference and our render side by side, per page and viewport, with the score and the gap list.                                                                                                                       |
| F-9  | Screenshot-guided revisions ("make the hero like screenshot 3") use the same spec and comparison.                                                                                                                                          |
| F-10 | Brand identity (logos, names, copy, photos) is never reproduced (§6).                                                                                                                                                                      |

## 8. Success metrics

| Metric                                                          | Today (estimate)          | Target after V | Target after V+R+F                           |
| --------------------------------------------------------------- | ------------------------- | -------------- | -------------------------------------------- |
| Settings identical across all themes (of the 7 tracked in §2.1) | 7 / 7                     | ≤ 1            | 0                                            |
| Median pairwise distinctness score (§T-V5)                      | not measured, est. < 0.25 | ≥ 0.45         | ≥ 0.6                                        |
| Themes with non-near-white page                                 | 0 / 7                     | ≥ 30%          | ≥ 30%                                        |
| Fidelity score on golden reference set (§T-Q) — approved target | not measured              | n/a            | ≥ 85 median (phase F1–F3), ≥ 92 with Track R |
| Reference regions reported as capability gaps                   | silent                    | n/a            | 100% of unmatched regions reported           |
| Operator rating "looks like the screenshots" (1–5)              | —                         | —              | ≥ 4 median                                   |
| Publication rate without manual revision                        | —                         | +20%           | +40%                                         |

Every metric is computed from stored run data, so it can be reported per release.

## 9. Phasing

| Phase  | Scope                                                                                                                | Size                | Exit criteria                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| **V1** | Track V: V1–V6 (prompt, schema, defaults, playbooks, fingerprints, directions)                                       | ~2–3 days           | 8 generated themes for 4 industries: no setting from §2.1 identical in all; distinctness median ≥ 0.45 |
| **V2** | V7 distinctness score + repair; operator display                                                                     | ~2 days             | Score stored per version, repair triggered below threshold                                             |
| **F1** | Reference classification + structured Reference Spec + pixel palette + spec-to-package mapping + Stage B sees images | ~1 week             | Golden set: palette ΔE ≤ 5 on page/text/accent; section order correct ≥ 90%                            |
| **F2** | Fidelity loop: render, compare, score, targeted repair, gap report, side-by-side UI                                  | ~1–1.5 weeks        | Golden set fidelity median ≥ 85                                                                        |
| **R1** | First Track R items, chosen by the capability-gap report (fonts, hero and card styles are the expected candidates)   | ~1 week             | Fidelity +5 on golden set; distinctness +0.1                                                           |
| **R2** | Section styles + new section types (R4–R5), prioritised by the capability-gap report                                 | ~2 weeks, iterative | Gap report's top 5 gaps closed                                                                         |

**Approved (2026-10-03): Track R is built in the order the capability-gap report gives, not a fixed list.** Track R therefore starts after F2 has produced gap data from real screenshots; R1–R5 above are the candidate pool, not a sequence.

## 10. Risks and open questions

| Risk / question                                          | Mitigation / owner decision                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Legal: resemblance to a third-party store                | §6 boundary approved 2026-10-03; flag list for protected trade dress                                      |
| Variety pushes toward ugly or unreadable themes          | All existing gates (contrast, acceptance, visual QA) still apply; distinctness never outranks quality     |
| Cost: fidelity loop adds vision calls and captures       | ~US$0.05–0.15 per comparison iteration, ≤ 3 iterations; cost is not the constraint per owner (2026-09-29) |
| Latency: more iterations                                 | Loop runs in the existing background pipeline; operator is notified                                       |
| Screenshot quality (cropped, mobile-only, partial pages) | F-1 classification; spec records confidence per region; low confidence never locks a field                |
| Renderer ceiling                                         | Gap report makes it explicit and drives Track R                                                           |
| Owner decisions needed                                   | Resolved 2026-10-03 — see §11                                                                             |

---

# Part 2 — Technical requirements

## T-0. Current architecture (relevant parts)

```
operator brief + screenshots
  └─ Stage A  (gemini, HIGH, images)        → ThemeIntent  (referenceAnalysis = prose lists)
       └─ Stage B (gemini, HIGH, TEXT ONLY) → compact draft (composition + layoutOverridesJson + pages…)
            └─ expandInitialDraft            → fills mechanical defaults, fixed shop layout
                 └─ compiler                 → ThemePackageV2 (validated)
                      └─ layout preflight capture → artwork → final capture
                           └─ acceptance gates + visual QA (no references) → repairs (settings)
```

Key modules: `lib/theme-studio/{prompts,schemas,pipeline,initial-draft,compiler,industry-playbooks,visual-qa,qa-diagnosis,targeted-repair,capture,capture-core}.ts`, capture job `jobs/theme-studio-capture/`, renderer `lib/homepage/section-types.ts`, `lib/chrome/design.ts`, `lib/themes/*`.

The renderer is the ceiling for both variety and fidelity; everything below either uses more of it (V, F) or raises it (R).

## T-V. Track V — Variety

### T-V1. Explicit style choices (V1, C2–C4)

- **Schema.** In `STAGE_B_INITIAL_DRAFT_SCHEMA` replace `layoutOverridesJson` (string, "normally `{}`") with a required, enumerated `layout` object: `header`, `card`, `productDetail`, `cart`, `footer`, `gridColumnsMobile`, `gridColumnsDesktop`, `shopFilters`, `stickyAddToCart`, `cardHoverImage`, `collectionBanner`. `composition` becomes a starting suggestion, not a lock.
- **Section configs.** For each section type, define the **visible style fields** (e.g. `shop_by_category.display/layout`, `hero.variant/height`, `newsletter.theme`, `testimonials.layout/columns`, `media_text.media_position/ratio`) and make them **required** in the section config the model writes. `mechanicalDefaults` keeps filling only non-visual fields.
- **Expansion.** Remove the hard-coded `stickyAddToCart / gridColumnsMobile / shopFilters / collectionBanner` defaults from `expandInitialDraft`; they come from the model's `layout`.
- **Compiler.** A missing visible style field is a repair issue ("Choose a style for …"), not a silent default.

### T-V2. Palette freedom (V2, C6)

- Prompt: page background may be light, dark, coloured or tinted; examples of each; contrast rules stated as constraints, not as a reason to choose white.
- Add a palette **family** field to the intent (`light`, `dark`, `colour-field`, `tinted-neutral`) chosen in Stage A and carried to Stage B.
- Contrast validation unchanged (`validateThemeDesign`), so dark/colour pages remain readable.

### T-V3. Quick add as an option (V3, C5)

- Remove quick add from the capability description used in planning; describe card styles with when-to-use guidance (quick add for grocery/dense catalogues; framed/overlay for editorial and luxury).

### T-V4. Playbook alternatives (V4, C1)

- `IndustryPlaybook.homeSections` → `structures: { name, sections[] }[]` with 2–4 entries per industry (e.g. _story-led_, _catalogue-led_, _lookbook-led_, _offer-led_). Ticker removed from all defaults. Stage A picks one and records the choice in `assumptions`.

### T-V5. Fingerprints and distinctness (V5, V7, C8, C9)

- **Fingerprint** (pure function, `lib/theme-studio/fingerprint.ts`): a small vector from a package — composition and layout enums, card style, hero type, homepage section-type sequence, page luminance band, accent hue bucket, body/display font, button shape/fill, radius bucket, heading case/scale, motion.
- **Distinctness** = weighted Hamming/Jaccard distance (0–1) to the nearest theme among published catalogue releases and the last N (e.g. 20) Studio versions.
- **Input to the model:** the fingerprints of the 5 nearest/most recent themes as trusted JSON ("existing themes — differ from these").
- **Gate:** after compile, distinctness < threshold (start 0.35) → one targeted repair naming the closest theme and the shared attributes. Stored in the version's QA report; shown in the workspace.

### T-V6. Design directions (V6)

- A curated list in code (`lib/theme-studio/design-directions.ts`), each with: palette family, type pairing guidance, hero/card/section style preferences, density, motion. Stage A chooses one (biased away from directions used by the nearest themes) and records it in the intent. When screenshots are supplied, the Reference Spec wins over the direction for every field it states (§T-F3).
- The seven approved directions (owner, 2026-10-03):

| Direction             | Typical stores                             | Palette family                                 | Type                                                         | Layout tendencies                                                                 |
| --------------------- | ------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Luxury minimal        | jewellery, perfume, premium beauty         | light or tinted neutral, one restrained accent | high-contrast serif headings, light sans body, wide tracking | airy spacing, few products per row, framed or overlay cards, square corners       |
| Bold and loud         | streetwear, sneakers, energy drinks        | dark or colour-field                           | heavy condensed or display sans, uppercase                   | big-type hero, edge-to-edge images, strong bands, tight grid                      |
| Magazine / editorial  | fashion, home, lifestyle                   | light or tinted                                | editorial serif or italic display                            | large images, story and lookbook sections, asymmetric splits, generous whitespace |
| Dense catalogue       | grocery, pharmacy, electronics accessories | light with a bright functional accent          | clear geometric sans                                         | quick-add cards, 4–5 desktop columns, filters, compact spacing                    |
| Soft and natural      | organic food, skincare, wellness           | warm tinted neutrals, earthy accents           | humanist sans or soft serif                                  | rounded corners, soft bands, image-and-text stories, gentle motion                |
| Playful and colourful | kids, snacks, gifts, toys                  | colour-field, several accents                  | rounded or quirky display sans                               | pill buttons, colourful tiles, badges, lively motion                              |
| Classic and trusted   | home goods, appliances, general stores     | light, navy/green style accents                | neutral sans                                                 | balanced grid, clear USP bar, testimonials, standard spacing                      |

### T-V7. Prompt and version management

- New prompt version `theme-studio-v21`, gated through `prompt-features.ts` (no literal version comparisons). Older queued runs keep their behaviour.

## T-R. Track R — Renderer vocabulary

Each item follows the existing section contract: registry type + `EMPTY_CONFIG` + `validateConfig` (draft/publish modes) + renderer component + builder form + thumbnail + Theme Studio schema/prompt + acceptance and renderer-fixture coverage (`scripts/theme-studio-renderer-check.mjs`) + Help Centre only if merchants see a new builder option.

| Item                | Notes                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----- |
| Fonts (R1)          | Load via `next/font` with `preload: false` like existing faces; add to `DESIGN_FONTS`, `lib/themes/typography.ts` weight table (no faux bold), contrast/typography validation |
| Hero styles (R2)    | Extend `hero` variants; overlay positions; big-type variant uses `--sm-hs` scale                                                                                              |
| Card styles (R3)    | New `ThemeLayout.card` values + card tokens (border/shadow/ratio); keep `quick_add` behaviour separate from appearance                                                        |
| Section styles (R4) | `SectionStyle` additions (divider, background image); theme-level `surfaceStyle: border                                                                                       | shadow | flat` |
| New sections (R5)   | Prioritised by Track F's capability-gap counts                                                                                                                                |

## T-F. Track F — Reference fidelity

### T-F1. Reference Spec (F-1–F-3)

A new **Stage R** (reference analysis) runs before Stage A, once per screenshot, using the isolated reader pattern already proven in `lib/mink/design-from-image.ts` (structured, enumerated output; parser drops anything outside the vocabulary).

Per screenshot:

```ts
interface ReferenceSpec {
  index: number;
  pageKind: "home" | "collection" | "product" | "cart" | "content" | "other";
  viewport: "desktop" | "tablet" | "phone";
  confidence: number; // 0–1
  palette: {
    // measured (T-F2), then labelled by the model
    page: Hex;
    text: Hex;
    mutedText: Hex;
    accent: Hex;
    bands: Hex[];
    buttonFill: Hex;
    buttonText: Hex;
    border: Hex | null;
  };
  typography: {
    headingClass: "serif" | "sans" | "display" | "mono" | "script";
    headingWeight: "regular" | "medium" | "semibold" | "bold" | "heavy";
    headingCase: "none" | "uppercase";
    headingTracking: "tight" | "normal" | "wide";
    headingToBodyRatio: number; // e.g. 2.8
    bodyClass: "serif" | "sans";
  };
  shape: {
    cardRadiusPx: number;
    controlRadiusPx: number;
    buttonShape: "square" | "rounded" | "pill";
  };
  page: {
    width: "narrow" | "standard" | "wide" | "full";
    density: "airy" | "standard" | "compact";
  };
  header: {
    layout: "logo-left" | "logo-centered" | "split";
    transparentOverHero: boolean;
    hasSearchBar: boolean;
  };
  regions: Array<{
    // top to bottom
    order: number;
    sectionType: SectionType | "unsupported";
    style: Record<string, string | number>; // only fields that section type supports
    scheme: "page" | "soft" | "tint" | "accent" | "inverse";
    heightShare: number; // fraction of screenshot height
    unsupportedReason?: string; // feeds the capability-gap report
  }>;
  card?: {
    imageRatio: string;
    textAlign: "left" | "center";
    hasBorder: boolean;
    hasShadow: boolean;
    quickAdd: boolean;
  };
}
```

- `sectionType` and every `style` key/value are **enumerated from the section registry** (`HOMEPAGE_SECTION_TYPES`, each type's config enums), exactly as `parseDesignLayout` does for Mink. No free text reaches the theme from this stage.
- Low-confidence regions (< 0.5) are advisory and never lock a field.
- Stored on the run (new `reference_specs jsonb` on `theme_studio_runs`, additive migration) and in the intent (`intent.referenceSpecs`, intent schema version bump with a compatible reader).

### T-F2. Deterministic pixel measurement (F-3)

- `lib/theme-studio/reference-pixels.ts` (sharp): downscale, k-means (k ≈ 8) palette with area shares; sample known regions (top 6% → header, largest uniform area → page background, text-like high-contrast clusters → text) and pass the measured swatches to Stage R, which only **labels** them (page / text / accent / band). Hex values therefore come from pixels, not the model's estimate.
- Also measured: dominant background per horizontal band (section boundaries), approximate content width vs viewport, and corner radius estimates on detected card rectangles where reliable.

### T-F3. Spec → package mapping (F-4, F-5)

- `lib/theme-studio/reference-mapping.ts`: deterministic mapping for everything the spec states explicitly: palette tokens (with contrast-safe nudging if a measured pair fails AA, recorded as a deviation), nearest font by class/weight from `DESIGN_FONTS`, radii, page width, button style, header variant, card style, section order and per-section styles.
- Produces **reference-locked fields**. Stage B receives the screenshots (as today's Stage A does), the specs, and the locked fields as trusted constraints; it fills copy, catalogue and artwork briefs and may only change a locked field by recording a reason. The compiler rejects silent changes to locked fields (repair issue).
- Industry playbook and design direction apply **only to fields the spec does not state** (F4).
- Prompt change: references are "the design to reproduce (structure, colour, type, spacing, components)"; `copyingToAvoid` narrows to logos, names, copy, photographs and flagged trade dress (§6).

### T-F4. Fidelity loop (F-6, F-7)

Runs after artwork, alongside final capture, using the existing Chromium capture job.

1. **Render** each reference's page kind at the reference's viewport (existing `THEME_STUDIO_QA_VIEWPORTS` + an exact-width capture matching the reference screenshot width).
2. **Compare** per region:
   - _Structural:_ section sequence alignment (edit distance on section types), height shares.
   - _Colour:_ ΔE2000 between reference and render palette tokens and per-band backgrounds.
   - _Type:_ class/weight/case/scale ratio match.
   - _Perceptual:_ SSIM on downscaled grayscale layout masks (low resolution so photos and copy differences do not dominate).
   - _Vision judge:_ Gemini compares reference vs render side by side per region with a closed rubric (`layout`, `colour`, `typography`, `spacing`, `components`, 1–5 each) and returns structured differences, each with a `kind: settings | image | renderer` and a target path, the same vocabulary as `qa-diagnosis.ts` `QaRepair`.
3. **Score** = weighted (structure 30, colour 20, typography 20, spacing 15, components 15) → 0–100.
4. **Repair:** `settings` differences → `targeted-repair.ts` (existing focused settings repair, now fed by fidelity differences); `image` differences → targeted redraw with the reference's photographic style notes; `renderer` → **capability gap** (no repair). Re-measure; stop at score ≥ target, no improvement (`qaImproved` pattern), or 3 iterations (shares the existing iteration ceiling, migration 0145).
5. **Store** `fidelity_report` (score, per-region scores, differences, gaps, iteration) — on the visual QA row (`vision_report.fidelity`) to avoid a new table; additive JSON.

Fidelity complements, never replaces, the acceptance and visual-QA gates: a theme that matches a reference but fails contrast is still refused.

### T-F5. Operator UI (F-8, F-9)

- Version page: **Reference comparison** tab — each screenshot beside our render at the same viewport, region outlines, score, differences, capability gaps.
- Composer: "Match screenshot N more closely" quick action that queues a fidelity-guided revision using the stored spec.

### T-F6. Capability-gap report

- Aggregated across runs (`unsupportedReason` + `renderer` differences) in the operator Theme Studio list: "Most requested missing components". This is Track R's backlog.

## T-D. Data and migrations

| Change                                                                                                                   | Type                             |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `theme_studio_runs.reference_specs jsonb null`                                                                           | additive column                  |
| Intent schema version bump (`referenceSpecs`, `designDirection`, `paletteFamily`) with compatible reader for old intents | code                             |
| `vision_report.fidelity`, `vision_report.distinctness`                                                                   | additive JSON in existing column |
| Event types `fidelity_measured`, `fidelity_repair_queued` if new events are added (widen the event CHECK forward-only)   | migration                        |

All migrations expand-only (`docs/migrations.md`); durable `verify` asserts structure only.

## T-Q. Quality, evaluation and testing

- **Golden reference set** `evals/theme-studio/references/`: 10–15 screenshot sets across industries with expected Reference Specs (hand-labelled palette, section order, type class), used by `npm run theme-studio:eval` (offline fake + paid live mode, existing `--max-usd` guard).
- **Variety eval:** generate 2 themes per industry × 4 industries; report pairwise distinctness and the §2.1 "identical settings" table automatically.
- **Unit tests:** fingerprint/distinctness, pixel palette extraction (fixture images with known colours), spec parser (drops unknown keys/values, instruction-shaped text), spec→package mapping, fidelity scoring arithmetic, locked-field enforcement in the compiler.
- **Renderer fixtures:** every new Track R style added to `scripts/theme-studio-renderer-check.mjs` (CI job "Native theme layout regression").
- **Mutation checks** on the gates (locked-field refusal, distinctness repair trigger) as the codebase already does.

## T-S. Security

- Screenshots remain untrusted: Stage R uses the isolated-reader pattern (no tools, no memory), outputs only enumerated values; visible text in screenshots is never an instruction and is never copied.
- No code generation; all output still passes `validateThemePackageV2`, publish-mode section validation, contrast and security gates.

## T-C. Cost and latency (estimates, list prices)

| Step                                              | Per theme                                |
| ------------------------------------------------- | ---------------------------------------- |
| Stage R (per screenshot, Flash, ULTRA_HIGH)       | ~US$0.01–0.02 × up to 10                 |
| Stage B with images                               | +~US$0.02–0.05                           |
| Fidelity compare (per iteration, per page kind)   | ~US$0.03–0.08 + one capture              |
| Total added (typical 6 screenshots, 2 iterations) | ~US$0.25–0.60, +5–10 min background time |

## T-O. Observability

- Log per run: distinctness, nearest theme id, fidelity score per iteration, gap count (enums and numbers only; no screenshot or copy content).
- Operator console: distinctness and fidelity distributions per week; top capability gaps.

## T-P. Delivery checklist per phase

- CODEBASE.md updated in the same change (AGENTS.md rule).
- No Help Centre update for operator-only changes; Track R items that add merchant builder options update the relevant guide by `replace()`.
- Prompt version bump via `prompt-features.ts`; older runs unaffected.
- Evals run and results recorded in `docs/theme-studio-performance.md`.

---

## 11. Decisions log

| #   | Decision                                                                                                                                                     | Approved          | Effect on this document                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1   | Copy boundary: reproduce the design system (structure, layout, exact colours, type feel, spacing, components); never logos, brand names, copy or photographs | Owner, 2026-10-03 | §6 is the binding boundary; Stage R / Stage B prompts and the `copyingToAvoid` field follow it (§T-F3)                  |
| 2   | Design directions: luxury minimal, bold and loud, magazine / editorial, dense catalogue, soft and natural, playful and colourful, classic and trusted        | Owner, 2026-10-03 | V6 and §T-V6 list exactly these seven; adding or removing one is a code change to `design-directions.ts` and this table |
| 3   | Fidelity target: median ≥ 85 on the golden reference set after F2; ≥ 92 once Track R items land                                                              | Owner, 2026-10-03 | §8 targets and the F2 exit criterion; the fidelity loop stops repairing at the target (§T-F4)                           |
| 4   | Track R order follows the capability-gap report from real screenshots, not a fixed list                                                                      | Owner, 2026-10-03 | §9: Track R starts after F2; R1–R5 are a candidate pool ranked by gap counts (§T-F6)                                    |

## 12. Track V implementation record

Intent schema 2 adds the approved direction and palette family; the compatible
reader still accepts schema 1. Legacy queued requests retain their paid request
bindings. Explicit style validation covers layout, typography, buttons, page
rhythm, motion, section bands and native sections' visual settings. New initial
drafts fill non-visual defaults only. Three alternative structures per industry
leave room for brief-led adaptation; quick add and ticker are optional choices.
Native commerce capabilities are options rather than mandatory requirements.
Dark and colour-field intents must actually colour the page, not just an accent.
Tinted-neutral excludes near-white pages; white and ivory references use light.
The unchanged near-white band is relative luminance >0.8 with RGB spread <0.12.
Both stages describe these family boundaries and the compiler enforces them.
Both planning and synthesis receive the chosen direction guidance.
Quiet luxury/editorial directions favour compact collection title/grid openings;
image-led introductions or briefs needing collection descriptions can choose a
banner. Category photos do not require banners. These are explicit choices,
with brief/reference requirements taking priority.

The fingerprint uses weighted scalar differences and ordered section edit
distance. Comparison includes up to 20 recent other Studio projects, 76 published
releases and bundled fallback (at most 100 entries). Both stages see five recent
fingerprints and individual-choice frequencies for the complete snapshot; a
repair sees the five closest. Distance below 0.35 or fewer than three major
changed axes triggers one supported-style correction for new builds without
references. The correction preserves the validated palette and only changes scalar native
styles. An ineffective or unavailable correction retains the valid draft and
exposes its similarity. This is an operator quality signal, separate from required
acceptance and visual quality gates.

Migration 0153 adds `runs.variety_context` to freeze inputs across paid-response
recovery, and `versions.distinctness_report` so evidence exists before browser QA
and survives image/capture snapshots. This refines T-D additively: visual QA also
stores it in `vision_report.distinctness`. Guards protect the frozen context and
per-version evidence. No new table or event vocabulary is needed. Old versions
are not changed or retroactively scored.

`scripts/theme-studio-variety-eval.ts` evaluates eight builds/four industries.
Unit checks cover explicit false/one-column choices, legacy compatibility,
fingerprint semantics, one repair, preserved content/artwork, ineffective or
unavailable corrections, and reference priority. Rollback-only PostgreSQL checks
cover real context recovery, own-project exclusion, immutable evidence and
operator-only permissions. No merchant-visible change, no Help Centre update.

The last complete HIGH-reasoning Gemini 3.8 Flash batch compiled eight themes
across four industries: median pairwise distance 0.704, seven non-near-white page
backgrounds, and all nearest comparisons above 0.35 with at least three changed
axes. It did not clear the full exit bar because `collectionBanner` was identical
in all eight. Final banner guidance is implemented and locally tested; its live
batch awaits approval after automatic review rejected external-provider execution
and estimated spend. The thresholds remain unchanged. Exact results and the 20
individual tracked choices are saved in
[`evals/theme-studio/variety-live-2026-10-03.json`](../evals/theme-studio/variety-live-2026-10-03.json);
timing, cost and scope are described in `docs/theme-studio-performance.md`.
