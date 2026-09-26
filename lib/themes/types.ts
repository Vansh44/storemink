import type { ProductOption } from "@/lib/products/options";
import type { PageSectionItem } from "@/lib/sections/registry";
import type { StoreMenus } from "@/lib/menus";
import type { ThemeMeta } from "./meta";
import { schemeCssVars, type ThemeColorSchemes } from "./schemes";

// ---------------------------------------------------------------------------
// Theme definition — the full data package a theme seeds into a store: pages
// (incl. the homepage sentinel), menus, brand accents, and sample commerce
// data so product sections look alive on day one. Definitions can embed large
// custom_code strings, so they are ONLY imported server-side via
// lib/themes/index.ts — the signup client bundle imports lib/themes/meta.ts.
//
// v1 constraints (enforced by lib/themes/themes.test.ts):
//   • sections use non-id sources only (featured products "featured",
//     categories "all") — no cross-entity id rewriting needed;
//   • no latest_blogs sections (fresh stores have no posts → renders nothing);
//   • imagery is bundled under public/themes/{id}/ (never the media bucket,
//     so per-store storage cleanup can't touch shared theme assets).
// ---------------------------------------------------------------------------

export interface ThemePageSeed {
  /** "" is the homepage sentinel — every theme MUST include it. */
  slug: string;
  title: string;
  seo_title?: string;
  seo_description?: string;
  /** Section ids here are human-readable placeholders — applyTheme regenerates
   *  UUIDs at seed time. */
  sections: PageSectionItem[];
}

export interface ThemeCategorySeed {
  name: string;
  slug: string;
  description?: string;
  image_url?: string;
  sort_order?: number;
}

export interface ThemeVariantSeed {
  name: string;
  base_price: number;
  selling_price: number;
  special_price?: number | null;
  stock: number;
  sku?: string;
  sort_order?: number;
  images?: string[];
  /** This variant's value for each of its product's `options`, in order. */
  option_values?: string[];
}

export interface ThemeProductSeed {
  name: string;
  slug: string;
  description: string;
  /** Must match a ThemeCategorySeed slug. */
  category_slug: string;
  base_price: number;
  selling_price: number;
  image_url: string;
  images?: string[];
  featured?: boolean;
  sort_order?: number;
  card_color?: string;
  /** Option axes ("Size", "Colour"), as lib/products/options.ts defines them.
   *  When present, every variant carries a matching `option_values`. */
  options?: ProductOption[];
  variants?: ThemeVariantSeed[];
}

// ---------------------------------------------------------------------------
// Theme DESIGN — the visual "skin": full colour palette, fonts and shape.
// A theme overrides EVERY token here; the values default (in globals.css) to
// WholeSip's, so an un-themed store keeps today's look. designToCssVars()
// flattens this into the inline CSS-custom-property map the (storefront)
// layout writes onto .storefront-root, so it cascades to every storefront
// component with zero per-component wiring.
//
// `accent`/`accentDeep` are intentionally OPTIONAL: the accent chain is driven
// by --brand-primary (the merchant's chosen colour, seeded from the theme),
// so a theme leaves accent alone unless it wants a fixed accent regardless of
// the merchant's colour.
// ---------------------------------------------------------------------------
export interface ThemePalette {
  cream: string; // page background
  creamDeep: string; // alt surface / hover / image tiles
  surface: string; // cards / inputs
  ink: string; // headings + body (darkest)
  inkSoft: string; // muted text
  inkFaint: string; // subtle / struck price
  taupe: string; // promo ticker / soft band
  sand: string; // chips / soft pill surface
  butter: string; // sparingly-used highlight
  border: string; // hairline
  tile: string; // default product card tile
  accentWarm: string; // small warm accents (ticker separators)
  onAccent: string; // text/icon on an accent-filled button
  onInk: string; // text/icon on an ink-filled surface
  shadowRgb: string; // "r, g, b" base for rgba() shadows
  success: string;
  successSoft: string;
  error: string;
  errorSoft: string;
  star: string; // rating stars
  highlight: string; // "best value" / promo highlight
  accent?: string; // optional fixed accent (else --brand-primary drives it)
  accentDeep?: string;
}

export interface ThemeFonts {
  /** CSS font value for body/UI text, e.g. "var(--font-inter)". Overrides the
   *  --font-outfit / --font-roboto slots used across the storefront. */
  body: string;
  /** CSS font value for display headings — overrides the --font-stick-no-bills
   *  slot used for large hero-style headings. */
  display: string;
}

export interface ThemeShape {
  card: string; // e.g. "20px" | "4px"
  control: string; // inputs / buttons
  sm: string; // small controls
  pill: string; // pills / chips / avatars ("999px" or a squarer value)
}

// Layout variants on the shared storefront chrome. All optional — absent
// means the classic WholeSip chrome, so existing themes are untouched.
export interface ThemeLayout {
  /** "market": solid coloured header bar with a prominent, functional search
   *  box (grocery style). "classic" (default): transparent-to-cream bar. */
  header?: "classic" | "market" | "centered" | "minimal";
  /** Market header colours (strict colours; defaults: ink / on-ink). */
  headerBackground?: string;
  headerForeground?: string;
  /** "quick_add": product cards get an inline "+ Add" to-cart button.
   *  "classic" (default): the whole card is a click-through link only. */
  card?: "classic" | "quick_add" | "overlay" | "framed" | "grocery";
  /** Cross-fade the product card to the product's SECOND photograph on hover.
   *  Opt-in per theme because, unlike the quick-add button (which is rendered
   *  always and hidden by CSS), a second image costs a network request — see
   *  the note on `.sm-card-hoverimg` in storefront-theme.css. Absent = off, so
   *  storefront changes. */
  cardHoverImage?: boolean;
  /** Product-detail composition. `storefront:grocery` remains the legacy
   *  shorthand and is used when this field is absent. */
  productDetail?: "classic" | "grocery" | "editorial";
  /** Cart composition. `storefront:grocery` remains the legacy fallback. */
  cart?: "classic" | "grocery" | "compact";
  /** Footer composition; current multi-column footer is `rich`. */
  footer?: "rich" | "minimal" | "editorial";
  /** The overall storefront treatment. "grocery" switches product cards, the
   *  product-detail page and the cart to a distinct premium grocery layout
   *  (new markup + new classes, gated by the `sm-storefront-grocery` root
   *  class), so a store on this theme looks nothing like the classic WholeSip
   *  storefront. "classic" (default) = today's shared layout, untouched. */
  storefront?: "classic" | "grocery";
  /** A phone add-to-cart bar that slides up once the product page's own buy
   *  buttons have scrolled out of view. Opt-in: it adds chrome to every
   *  product page. Absent = off. */
  stickyAddToCart?: boolean;
  /** Shop grid columns on a phone (≤460px). Absent = 1, the long-standing
   *  default; premium themes choose 2. */
  gridColumnsMobile?: 1 | 2;
  /** Shop grid columns on a wide desktop (>1100px). Absent = 4. */
  gridColumnsDesktop?: 3 | 4 | 5;
  /** Shop and collection pages gain a sort menu, availability and price
   *  filters, and show products 24 at a time behind "Load more". Opt-in: it
   *  adds a toolbar and hides products past the first page. Absent = off. */
  shopFilters?: boolean;
  /** A collection page opens with its category's image and description.
   *  Absent = off: the page is titled with the category name only. */
  collectionBanner?: boolean;
}

export interface ThemeDesign {
  palette: ThemePalette;
  fonts: ThemeFonts;
  shape: ThemeShape;
  layout?: ThemeLayout;
  /** Named colour schemes a section can wear (lib/themes/schemes.ts). A
   *  scheme the theme does not declare is derived from the palette, so this
   *  is only for a band the theme wants in its own colours. */
  schemes?: ThemeColorSchemes;
}

/** Immutable authored preset package. Applying it seeds starting content;
 * merchant edits then live in store-scoped DB rows and are not this object. */
export interface ThemePreset {
  brand: {
    primaryColor: string;
    tagline?: string;
    blurb?: string;
  };
  /** The visual skin — palette, fonts, shape. */
  design: ThemeDesign;
  pages: ThemePageSeed[];
  menus: StoreMenus;
  sampleData?: {
    categories: ThemeCategorySeed[];
    products: ThemeProductSeed[];
  };
}

/** One immutable preset release. Multiple releases with the same id may stay
 * registered so stores pinned to an older version never change implicitly. */
export interface ThemeDefinition extends ThemeMeta {
  preset: ThemePreset;
}

/**
 * Flatten a ThemeDesign into the inline CSS-custom-property map the storefront
 * layout writes onto .storefront-root. Keys are the real token names; the
 * cascade + inline-style specificity means these beat the globals.css defaults.
 *
 * NOTE: the accent chain is driven by --brand-primary; pass the store's
 * primary colour so a theme with a fixed `palette.accent` can steer it, while
 * a theme that omits `accent` lets the merchant's colour flow through.
 */
export function designToCssVars(
  design: ThemeDesign,
  brandPrimary: string,
): Record<string, string> {
  const p = design.palette;
  return {
    "--brand-primary": p.accent ?? brandPrimary,
    "--sm-cream": p.cream,
    "--sm-cream-deep": p.creamDeep,
    "--sm-surface": p.surface,
    "--sm-ink": p.ink,
    "--sm-ink-soft": p.inkSoft,
    "--sm-ink-faint": p.inkFaint,
    "--sm-taupe": p.taupe,
    "--sm-sand": p.sand,
    "--sm-butter": p.butter,
    "--sm-border": p.border,
    "--sm-tile": p.tile,
    "--sm-accent-warm": p.accentWarm,
    "--sm-on-accent": p.onAccent,
    "--sm-on-ink": p.onInk,
    "--sm-shadow-rgb": p.shadowRgb,
    "--sm-success": p.success,
    "--sm-success-soft": p.successSoft,
    "--sm-error": p.error,
    "--sm-error-soft": p.errorSoft,
    "--sm-star": p.star,
    "--sm-highlight": p.highlight,
    ...(p.accentDeep ? { "--sm-accent-deep": p.accentDeep } : {}),
    ...(design.layout?.headerBackground
      ? { "--sm-header-bg": design.layout.headerBackground }
      : {}),
    ...(design.layout?.headerForeground
      ? { "--sm-header-fg": design.layout.headerForeground }
      : {}),
    "--font-outfit": design.fonts.body,
    "--font-roboto": design.fonts.body,
    "--font-stick-no-bills": design.fonts.display,
    "--sm-radius-card": design.shape.card,
    "--sm-radius-control": design.shape.control,
    "--sm-radius-sm": design.shape.sm,
    "--sm-radius-pill": design.shape.pill,
    ...schemeCssVars(design, brandPrimary),
  };
}
