/** Approved directions are guidance within the native renderer, never fixed
 * templates. The operator brief and reference design take precedence. */
export const PALETTE_FAMILIES = [
  "light",
  "dark",
  "colour-field",
  "tinted-neutral",
] as const;
export type PaletteFamily = (typeof PALETTE_FAMILIES)[number];
export const DESIGN_DIRECTIONS = {
  "luxury-minimal": {
    label: "Luxury minimal",
    palettes: ["light", "tinted-neutral"],
    type: "Instrument Serif or Fraunces headings; restrained sans body, wide tracking",
    styles:
      "airy, framed or overlay cards, outline primary controls with readable accent text, square corners, focused one-column mobile grid, no reveal motion; prefer collectionBanner false for a quiet category title followed directly by product photography",
    industries: ["jewelry-and-accessories", "beauty"],
  },
  "bold-and-loud": {
    label: "Bold and loud",
    palettes: ["dark", "colour-field"],
    type: "Stick No Bills condensed or Space Grotesk display; confident weight and case",
    styles:
      "split or colour-field hero, strong bands, tight product grid, restrained rise motion",
    industries: ["clothing", "shoes", "sports", "entertainment"],
  },
  "magazine-editorial": {
    label: "Magazine / editorial",
    palettes: ["light", "tinted-neutral"],
    type: "Instrument Serif or Fraunces display with readable Inter or Jost body",
    styles:
      "editorial galleries, alternating media stories, overlay cards, generous whitespace; prefer collectionBanner false when category cards and home stories already introduce the imagery, avoiding a repeated large banner on every collection",
    industries: ["clothing", "home", "art", "shoes"],
  },
  "dense-catalogue": {
    label: "Dense catalogue",
    palettes: ["light"],
    type: "Roboto or Inter, clear geometric hierarchy",
    styles:
      "market header, grocery or quick_add cards, 4–5 desktop columns, compact spacing and filters, horizontally scrolling categories, no reveal motion",
    industries: [
      "food-and-drink",
      "electronics",
      "hardware",
      "wholesale",
      "office",
    ],
  },
  "soft-and-natural": {
    label: "Soft and natural",
    palettes: ["tinted-neutral"],
    type: "Fraunces or soft Outfit headings; readable body",
    styles:
      "visibly sage, clay or mineral page fields (not a barely tinted white), rounded corners, circular categories, image/text stories, no reveal motion",
    industries: ["beauty", "wellness", "garden", "pets", "food-and-drink"],
  },
  "playful-and-colourful": {
    label: "Playful and colourful",
    palettes: ["colour-field"],
    type: "Outfit or Fraunces expressive display and friendly readable body",
    styles:
      "colourful page fields and tile grids, pill controls, circular scrolling categories, varied bands, restrained rise motion",
    industries: ["kids", "toys", "food-and-drink", "pets"],
  },
  "classic-and-trusted": {
    label: "Classic and trusted",
    palettes: ["light"],
    type: "Inter or Roboto, balanced scale and familiar hierarchy",
    styles:
      "balanced grid, clear USP bar, testimonials, conventional rhythm; collectionBanner true suits image-led category introductions",
    industries: ["general", "home", "automotive", "services", "office"],
  },
} as const;
export type DesignDirection = keyof typeof DESIGN_DIRECTIONS;
export const DESIGN_DIRECTION_IDS = Object.keys(
  DESIGN_DIRECTIONS,
) as DesignDirection[];

export function recommendedDirection(
  industries: readonly string[],
  recent: readonly (DesignDirection | null)[],
): DesignDirection {
  return [...DESIGN_DIRECTION_IDS].sort((a, b) => {
    const rank = (id: DesignDirection) =>
      ((DESIGN_DIRECTIONS[id].industries as readonly string[]).some((i) =>
        industries.includes(i),
      )
        ? 0
        : 3) + recent.filter((r) => r === id).length;
    return rank(a) - rank(b);
  })[0];
}
