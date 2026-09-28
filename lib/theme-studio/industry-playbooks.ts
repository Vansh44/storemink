import type { ThemeIndustry } from "@/lib/themes/meta";

// Track 4's deterministic starting point. These are not finished themes and
// never override an operator brief or a reference image; they fill ordinary
// omissions so Stage A can make explicit assumptions instead of interrupting
// the operator for choices that professional theme design can safely make.

export interface IndustryPlaybook {
  pageStructure: readonly string[];
  homeSections: readonly string[];
  colourFamilies: readonly string[];
  imageStyle: string;
  defaults: readonly string[];
}

const commerce = (
  homeSections: readonly string[],
  colourFamilies: readonly string[],
  imageStyle: string,
  defaults: readonly string[],
): IndustryPlaybook => ({
  pageStructure: [
    "Home routes into collections and featured products",
    "Shop supports category discovery, sorting and filters",
    "Product leads with media, price, options, trust and fulfilment",
    "Cart keeps totals and checkout action visually dominant",
  ],
  homeSections,
  colourFamilies,
  imageStyle,
  defaults,
});

export const INDUSTRY_PLAYBOOKS: Readonly<
  Record<ThemeIndustry, IndustryPlaybook>
> = {
  general: commerce(
    [
      "hero",
      "shop_by_category",
      "featured_products",
      "media_text",
      "usp_bar",
      "newsletter",
    ],
    ["warm neutral", "charcoal", "one saturated brand accent"],
    "Clean editorial product photography with consistent light and scale.",
    ["balanced density", "mixed corners", "restrained motion"],
  ),
  art: commerce(
    [
      "hero",
      "gallery",
      "shop_by_category",
      "featured_products",
      "media_text",
      "newsletter",
    ],
    ["gallery white", "ink black", "one pigment-led accent"],
    "Museum-like crops, visible material texture and generous negative space.",
    ["airy rhythm", "square or lightly softened geometry", "quiet typography"],
  ),
  automotive: commerce(
    [
      "hero_carousel",
      "shop_by_category",
      "featured_products",
      "media_text",
      "usp_bar",
      "newsletter",
    ],
    ["graphite", "steel", "signal red or electric blue"],
    "Low-angle, high-contrast imagery with precise detail and controlled reflections.",
    ["dense specifications", "square geometry", "restrained motion"],
  ),
  beauty: commerce(
    [
      "hero",
      "shop_by_category",
      "featured_products",
      "media_text",
      "testimonials",
      "newsletter",
    ],
    ["soft cream", "skin-tone neutrals", "botanical or jewel accent"],
    "Luminous close-ups, tactile ingredients and consistent soft studio light.",
    ["airy rhythm", "soft corners", "benefit-led product hierarchy"],
  ),
  clothing: commerce(
    [
      "hero_carousel",
      "shop_by_category",
      "featured_products",
      "gallery",
      "media_text",
      "newsletter",
    ],
    ["editorial neutral", "black", "seasonal accent"],
    "Full-look editorial photography plus consistent garment cut-outs and detail crops.",
    ["airy rhythm", "square geometry", "image-led composition"],
  ),
  electronics: commerce(
    [
      "hero",
      "shop_by_category",
      "featured_products",
      "tile_grid",
      "usp_bar",
      "newsletter",
    ],
    ["cool white", "slate", "electric blue or lime accent"],
    "Crisp product renders, controlled gradients and close technical detail without fake UI text.",
    ["balanced density", "mixed corners", "comparison-friendly hierarchy"],
  ),
  entertainment: commerce(
    [
      "hero_carousel",
      "tile_grid",
      "featured_products",
      "gallery",
      "rich_text",
      "newsletter",
    ],
    ["near black", "cinematic jewel tones", "bright event accent"],
    "Cinematic crops, expressive lighting and clear separation between artwork and commerce copy.",
    ["expressive but bounded motion", "mixed geometry", "poster-led hierarchy"],
  ),
  "food-and-drink": commerce(
    [
      "hero",
      "shop_by_category",
      "featured_products",
      "promo_banner",
      "usp_bar",
      "testimonials",
      "newsletter",
    ],
    ["warm cream", "ingredient earth tones", "fresh produce accent"],
    "Appetising natural light, consistent table surface and close texture without fabricated packaging text.",
    ["compact-to-balanced rhythm", "soft corners", "quick-add emphasis"],
  ),
  garden: commerce(
    [
      "hero",
      "shop_by_category",
      "featured_products",
      "media_text",
      "gallery",
      "rich_text",
      "newsletter",
    ],
    ["leaf green", "soil neutrals", "sunlit cream"],
    "Natural outdoor light, botanical texture and useful scale/context for each product.",
    ["airy rhythm", "soft geometry", "educational content"],
  ),
  hardware: commerce(
    [
      "hero",
      "shop_by_category",
      "featured_products",
      "tile_grid",
      "usp_bar",
      "faq_accordion",
    ],
    ["workshop white", "graphite", "safety orange or yellow"],
    "Straight-on product clarity, material close-ups and real-use context with no decorative clutter.",
    ["dense catalogue", "square geometry", "search-first navigation"],
  ),
  home: commerce(
    [
      "hero",
      "shop_by_category",
      "featured_products",
      "media_text",
      "gallery",
      "testimonials",
      "newsletter",
    ],
    ["warm stone", "linen", "earth or mineral accent"],
    "Editorial interiors plus consistent isolated product views in soft natural light.",
    ["airy rhythm", "mixed corners", "room-led collection discovery"],
  ),
  "jewelry-and-accessories": commerce(
    [
      "hero",
      "shop_by_category",
      "featured_products",
      "gallery",
      "media_text",
      "testimonials",
    ],
    ["ivory", "ink", "metallic-inspired muted accent"],
    "Macro detail, controlled specular light and consistent elegant scale without imitation branding.",
    ["airy rhythm", "square geometry", "high-detail media"],
  ),
  kids: commerce(
    [
      "hero_carousel",
      "shop_by_category",
      "featured_products",
      "tile_grid",
      "usp_bar",
      "testimonials",
      "newsletter",
    ],
    ["warm white", "playful primary family", "calming secondary pastels"],
    "Bright, safe, tactile scenes with simple backgrounds and age-appropriate context.",
    ["balanced rhythm", "soft corners", "playful restrained motion"],
  ),
  office: commerce(
    [
      "hero",
      "shop_by_category",
      "featured_products",
      "media_text",
      "tile_grid",
      "usp_bar",
      "newsletter",
    ],
    ["paper white", "slate", "focused blue or green"],
    "Orderly desk scenes, orthographic product views and consistent functional detail.",
    ["balanced density", "mixed corners", "utility-led hierarchy"],
  ),
  pets: commerce(
    [
      "hero",
      "shop_by_category",
      "featured_products",
      "media_text",
      "usp_bar",
      "testimonials",
      "newsletter",
    ],
    ["warm neutral", "friendly green", "cheerful accent"],
    "Warm lifestyle scenes and clean product-only shots; animals look natural, safe and uncostumed.",
    ["balanced rhythm", "soft corners", "trust-led composition"],
  ),
  services: commerce(
    [
      "hero",
      "media_text",
      "tile_grid",
      "testimonials",
      "faq_accordion",
      "newsletter",
    ],
    ["clear white", "confident dark", "one trustworthy accent"],
    "Authentic process and outcome imagery with people used only when the brief calls for them.",
    [
      "airy rhythm",
      "mixed corners",
      "proof and enquiry before catalogue density",
    ],
  ),
  shoes: commerce(
    [
      "hero_carousel",
      "shop_by_category",
      "featured_products",
      "gallery",
      "media_text",
      "newsletter",
    ],
    ["editorial white", "black", "sport or fashion accent"],
    "Consistent side profiles, sole/detail crops and energetic on-foot context.",
    ["airy rhythm", "square geometry", "size and variant clarity"],
  ),
  sports: commerce(
    [
      "hero_carousel",
      "shop_by_category",
      "featured_products",
      "tile_grid",
      "usp_bar",
      "media_text",
      "newsletter",
    ],
    ["high-contrast neutral", "team-independent dark", "energy accent"],
    "Dynamic use scenes balanced by precise product shots and visible functional detail.",
    ["balanced density", "mixed geometry", "expressive restrained motion"],
  ),
  toys: commerce(
    [
      "hero",
      "shop_by_category",
      "featured_products",
      "tile_grid",
      "gallery",
      "usp_bar",
      "newsletter",
    ],
    ["clean cream", "bright multi-colour family", "deep ink anchor"],
    "Playful tabletop scenes with clear scale, simple backgrounds and no licensed characters.",
    ["balanced rhythm", "soft corners", "category-first discovery"],
  ),
  wellness: commerce(
    [
      "hero",
      "shop_by_category",
      "featured_products",
      "media_text",
      "testimonials",
      "faq_accordion",
      "newsletter",
    ],
    ["calm cream", "sage or mineral", "muted restorative accent"],
    "Quiet natural light, tactile ingredients and credible routines without medical claims.",
    ["airy rhythm", "soft corners", "calm restrained motion"],
  ),
  wholesale: commerce(
    [
      "hero",
      "shop_by_category",
      "featured_products",
      "tile_grid",
      "usp_bar",
      "faq_accordion",
    ],
    ["utility white", "navy or charcoal", "clear action accent"],
    "Consistent pack shots showing units, cases and scale with minimal styling.",
    ["dense catalogue", "square geometry", "search and collection hierarchy"],
  ),
};

export function industryStartingPattern(industries: readonly ThemeIndustry[]): {
  industry: ThemeIndustry;
  playbook: IndustryPlaybook;
} {
  const industry = industries.find((value) => value !== "general") ?? "general";
  return { industry, playbook: INDUSTRY_PLAYBOOKS[industry] };
}

export function industryPlaybookPrompt(
  industries: readonly ThemeIndustry[],
): string {
  const { industry, playbook } = industryStartingPattern(industries);
  return JSON.stringify({ industry, ...playbook }, null, 2);
}
