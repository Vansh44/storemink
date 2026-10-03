import { EMPTY_CONFIG, HERO_HEIGHTS } from "@/lib/homepage/section-types";
import {
  SCHEMELESS_SECTION_TYPES,
  SECTION_SCHEMES,
} from "@/lib/themes/schemes";

/** Visible native settings must be authored, rather than copied from create-mode
 * presets. Ordinary registry validation still owns content and valid values. */
export const VISIBLE_SECTION_CHOICES: Readonly<
  Record<string, Readonly<Record<string, readonly unknown[]>>>
> = {
  hero: {
    variant: ["banner", "split", "minimal"],
    height: HERO_HEIGHTS,
    theme: ["dark", "light"],
    alignment: ["left", "center"],
  },
  hero_carousel: {
    height: HERO_HEIGHTS,
    autoplay: [true, false],
    interval_seconds: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  },
  featured_products: {
    limit: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  },
  shop_by_category: {
    display: ["circles", "cards"],
    layout: ["scroll", "grid"],
  },
  promo_banner: {
    alignment: ["left", "center", "right"],
    theme: ["dark", "light"],
  },
  tile_grid: { columns: [2, 3, 4], height: ["sm", "md", "lg"] },
  media_text: {
    media_position: ["left", "right"],
    media_ratio: ["portrait", "square", "landscape"],
    alignment: ["left", "center"],
  },
  gallery: {
    layout: ["grid", "editorial"],
    columns: [2, 3, 4],
    image_ratio: ["portrait", "square", "landscape"],
  },
  testimonials: { layout: ["cards", "editorial"], columns: [2, 3] },
  newsletter: { theme: ["dark", "light"], alignment: ["left", "center"] },
  usp_bar: { theme: ["dark", "light"] },
  ticker: { speed: ["slow", "medium", "fast"], theme: ["dark", "light"] },
  faq_accordion: { show_filters: [true, false] },
  rich_text: { width: ["contained", "full"] },
};

export function sectionChoiceIssues(
  type: string,
  config: Record<string, unknown>,
  style: unknown,
): string[] {
  const issues: string[] = [];
  for (const [key, choices] of Object.entries(
    VISIBLE_SECTION_CHOICES[type] ?? {},
  )) {
    if (!Object.hasOwn(config, key) || !choices.includes(config[key]))
      issues.push(
        `Choose a supported visible style for ${type}.${key}: ${JSON.stringify(choices)}.`,
      );
  }
  const band = style as Record<string, unknown> | null;
  for (const key of [
    "padding",
    "width",
    ...(SCHEMELESS_SECTION_TYPES.includes(type) ? [] : ["scheme"]),
  ]) {
    // Null scheme explicitly chooses page colours; padding and width require a choice.
    if (
      !band ||
      !Object.hasOwn(band, key) ||
      (key !== "scheme" && band[key] === null)
    )
      issues.push(`Choose a visible section style for ${type}.style.${key}.`);
  }
  if (band && !["sm", "md", "lg"].includes(String(band.padding)))
    issues.push(`Choose sm, md or lg padding for ${type}.`);
  if (band && !["contained", "full"].includes(String(band.width)))
    issues.push(`Choose contained or full width for ${type}.`);
  if (
    band?.scheme !== null &&
    band?.scheme !== undefined &&
    !(SECTION_SCHEMES as readonly unknown[]).includes(band.scheme)
  )
    issues.push(`Choose a supported band scheme for ${type}.`);
  for (const item of Array.isArray(config.slides)
    ? config.slides
    : Array.isArray(config.tiles)
      ? config.tiles
      : []) {
    if (!item || !["dark", "light"].includes(item.theme))
      issues.push(
        `Choose dark or light text explicitly for each ${type} item.`,
      );
  }
  return issues;
}

export function nonVisualDefaults(
  type: keyof typeof EMPTY_CONFIG,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const visible = VISIBLE_SECTION_CHOICES[type] ?? {};
  return Object.fromEntries(
    Object.entries(defaults).filter(([key]) => !Object.hasOwn(visible, key)),
  );
}

export const REQUIRED_DESIGN_CHOICES = {
  layout: [
    "header",
    "card",
    "productDetail",
    "cart",
    "footer",
    "storefront",
    "gridColumnsMobile",
    "gridColumnsDesktop",
    "shopFilters",
    "stickyAddToCart",
    "cardHoverImage",
    "collectionBanner",
  ],
  typography: [
    "headingFont",
    "headingScale",
    "headingWeight",
    "headingCase",
    "headingTracking",
  ],
  buttons: [
    "shape",
    "primary",
    "secondary",
    "case",
    "weight",
    "tracking",
    "hover",
  ],
  page: ["width", "sectionGap", "gridGap"],
  motion: ["reveal"],
} as const;

export function explicitDraftStyleIssues(raw: unknown): string[] {
  const draft = raw as {
    design?: Record<string, Record<string, unknown>>;
    pages?: {
      sections?: { type: string; configJson: string; style: unknown }[];
    }[];
  } | null;
  const issues: string[] = [];
  for (const [group, keys] of Object.entries(REQUIRED_DESIGN_CHOICES))
    for (const key of keys) {
      if (
        draft?.design?.[group]?.[key] === undefined ||
        draft.design[group][key] === null
      )
        issues.push(
          `Choose a visible style for design.${group}.${key}; presets are not design decisions.`,
        );
    }
  for (const page of Array.isArray(draft?.pages) ? draft.pages : [])
    for (const section of Array.isArray(page?.sections) ? page.sections : []) {
      try {
        const config = JSON.parse(section.configJson);
        if (config && typeof config === "object" && !Array.isArray(config))
          issues.push(
            ...sectionChoiceIssues(section.type, config, section.style),
          );
      } catch {
        /* ordinary compiler owns malformed JSON */
      }
    }
  return issues;
}
