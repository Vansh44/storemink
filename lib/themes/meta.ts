// ---------------------------------------------------------------------------
// Theme catalog META — deliberately client-safe.
//
// Full preset packages live in definitions/* and can contain large page,
// menu, and sample-catalog payloads. Client components (signup today; the
// merchant theme catalog later) import only this manifest.
// ---------------------------------------------------------------------------

export type ThemeIndustry =
  | "general"
  | "art"
  | "automotive"
  | "beauty"
  | "clothing"
  | "electronics"
  | "entertainment"
  | "food-and-drink"
  | "garden"
  | "hardware"
  | "home"
  | "jewelry-and-accessories"
  | "kids"
  | "office"
  | "pets"
  | "services"
  | "shoes"
  | "sports"
  | "toys"
  | "wellness"
  | "wholesale";

export type ThemeCatalogSize = "one-product" | "small" | "medium" | "large";

export type ThemeFeature =
  | "advanced-search"
  | "blogs"
  | "cart-drawer"
  | "category-navigation"
  | "faq"
  | "product-filtering"
  | "product-recommendations"
  | "promo-tiles"
  | "quick-add"
  | "variant-picker";

export type ThemeReleaseStatus =
  | "draft"
  | "candidate"
  | "approved"
  | "published"
  | "blocked";

/** `legacy` keeps an existing default selectable while making clear it has
 * not passed the professional catalog gate. Only `public` is a normal catalog
 * release; `hidden` is unavailable to merchants. */
export type ThemeCatalogVisibility = "hidden" | "legacy" | "public";

export type ThemeDemoStatus = "healthy" | "unavailable" | "provisioning";

export interface ThemeEngineRef {
  /** Shared structural renderer/capability family, not the merchant preset. */
  id: string;
  /** Integer contract version. Engine changes are independent of preset copy. */
  version: number;
}

export interface ThemeReleaseMeta {
  /** Semver for the immutable preset package registered server-side. */
  version: string;
  status: ThemeReleaseStatus;
  releasedAt?: string;
  notes: string[];
}

export interface ThemeScreenshot {
  src: string;
  viewport: "desktop" | "mobile";
  alt: string;
}

export interface ThemeCatalogMeta {
  visibility: ThemeCatalogVisibility;
  industries: ThemeIndustry[];
  catalogSizes: ThemeCatalogSize[];
  features: ThemeFeature[];
  keywords: string[];
  /** Plan gate (undefined = every plan). Signup provisions `free`. */
  minPlan?: "basic" | "pro";
  /** Primary 4:3 card image used by compact pickers. */
  previewImage: string;
  /** Detail-gallery contract. More views can be added without changing UI. */
  screenshots: ThemeScreenshot[];
}

export interface ThemeDemoMeta {
  slug: string;
  status: ThemeDemoStatus;
  checkedAt?: string;
  unavailableReason?: string;
}

export interface ThemeMeta {
  /** Preset id stored as stores.settings.template for legacy compatibility. */
  id: string;
  name: string;
  description: string;
  engine: ThemeEngineRef;
  release: ThemeReleaseMeta;
  catalog: ThemeCatalogMeta;
  demo: ThemeDemoMeta;
}

export const THEME_META: readonly ThemeMeta[] = [
  {
    id: "basket",
    name: "Basket",
    description:
      "A bright grocery-market theme — solid search header, category circles, offer tiles and quick-add product cards.",
    engine: { id: "storefront-grocery", version: 1 },
    release: {
      version: "1.0.0",
      status: "published",
      releasedAt: "2026-07-04",
      notes: [
        "Initial grocery storefront preset.",
        "Awaiting a restored live demo and the Phase 1 acceptance evidence.",
      ],
    },
    catalog: {
      // Basket remains the signup default so store creation still has a valid
      // starting point, but `legacy` prevents it being represented as a theme
      // that passed the new professional catalog gate.
      visibility: "legacy",
      industries: ["food-and-drink"],
      catalogSizes: ["small", "medium", "large"],
      features: [
        "advanced-search",
        "blogs",
        "cart-drawer",
        "category-navigation",
        "faq",
        "product-filtering",
        "product-recommendations",
        "promo-tiles",
        "quick-add",
        "variant-picker",
      ],
      keywords: ["grocery", "food", "delivery", "market", "quick add"],
      previewImage: "/themes/basket/preview.webp",
      screenshots: [
        {
          src: "/themes/basket/preview.webp",
          viewport: "desktop",
          alt: "Basket grocery storefront homepage",
        },
      ],
    },
    demo: {
      slug: "demo-basket",
      status: "unavailable",
      checkedAt: "2026-08-05",
      unavailableReason:
        "The demo host currently resolves to StoreMink's storefront-not-found page.",
    },
  },
  {
    id: "studio",
    name: "Studio",
    description:
      "An editorial home-design theme with gallery-like space, image-led storytelling and refined product discovery.",
    engine: { id: "storefront-editorial", version: 1 },
    release: {
      version: "0.1.0",
      status: "published",
      releasedAt: "2026-08-12",
      notes: [
        "Production route and responsive audit passed after the pristine demo reseed on 2026-08-12.",
        "Published to the catalog and signup; the strict performance target and two-reviewer scorecard remain open release follow-ups.",
      ],
    },
    catalog: {
      visibility: "public",
      industries: ["home", "art"],
      catalogSizes: ["small", "medium"],
      features: [
        "advanced-search",
        "blogs",
        "cart-drawer",
        "category-navigation",
        "faq",
        "product-filtering",
        "product-recommendations",
        "promo-tiles",
        "variant-picker",
      ],
      keywords: [
        "furniture",
        "home decor",
        "design studio",
        "objects",
        "editorial",
      ],
      previewImage: "/themes/studio/preview.webp",
      screenshots: [
        {
          src: "/themes/studio/preview.webp",
          viewport: "desktop",
          alt: "Studio editorial home-design storefront preview",
        },
      ],
    },
    demo: {
      slug: "demo-studio",
      status: "healthy",
      checkedAt: "2026-08-12",
    },
  },
  {
    id: "ritual",
    name: "Ritual",
    description:
      "A sensorial beauty and wellness theme built around product routines, botanical storytelling and intimate editorial imagery.",
    engine: { id: "storefront-editorial", version: 1 },
    release: {
      version: "0.1.0",
      status: "published",
      releasedAt: "2026-08-12",
      notes: [
        "Production route and responsive audit passed after the pristine demo reseed on 2026-08-12.",
        "Published to the catalog and signup; the strict performance target and two-reviewer scorecard remain open release follow-ups.",
      ],
    },
    catalog: {
      visibility: "public",
      industries: ["beauty", "wellness"],
      catalogSizes: ["small", "medium"],
      features: [
        "advanced-search",
        "blogs",
        "cart-drawer",
        "category-navigation",
        "faq",
        "product-filtering",
        "product-recommendations",
        "variant-picker",
      ],
      keywords: ["skincare", "beauty", "wellness", "botanical", "body care"],
      previewImage: "/themes/ritual/preview.webp",
      screenshots: [
        {
          src: "/themes/ritual/preview.webp",
          viewport: "desktop",
          alt: "Ritual botanical beauty storefront preview",
        },
      ],
    },
    demo: {
      slug: "demo-ritual",
      status: "healthy",
      checkedAt: "2026-08-12",
    },
  },
  {
    id: "vitrine",
    name: "Vitrine",
    description:
      "A monochrome fashion preset for footwear, bags and accessories \u2014 square product photography in a hairline grid, zero corner radius and one colour reserved for markdown.",
    engine: { id: "storefront-classic", version: 1 },
    release: {
      version: "0.1.0",
      status: "published",
      releasedAt: "2026-08-23",
      notes: [
        "Initial preset: Jost + Instrument Serif, zero-radius shape scale, monochrome palette with a single markdown red.",
        "Homepage seeds three interchangeable editorial splits so a merchant can re-merchandise each season without touching layout.",
        "Demo store live and route-checked 2026-08-22.",
        "Accessibility, Lighthouse and the required two-person design review were confirmed passed on 2026-08-23.",
      ],
    },
    catalog: {
      visibility: "public",
      industries: ["clothing", "shoes", "jewelry-and-accessories"],
      catalogSizes: ["medium", "large"],
      features: [
        "product-filtering",
        "variant-picker",
        "promo-tiles",
        "category-navigation",
        "cart-drawer",
      ],
      keywords: [
        "fashion",
        "footwear",
        "shoes",
        "handbags",
        "accessories",
        "monochrome",
        "minimal",
        "editorial",
      ],
      previewImage: "/themes/vitrine/preview.webp",
      screenshots: [
        {
          src: "/themes/vitrine/preview.webp",
          viewport: "desktop",
          alt: "Vitrine fashion storefront preview with footwear and bags",
        },
      ],
    },
    demo: {
      slug: "demo-vitrine",
      status: "healthy",
      checkedAt: "2026-08-22",
    },
  },
] as const;

export const DEFAULT_THEME_ID = "basket";

export const INDUSTRY_LABELS: Record<ThemeIndustry, string> = {
  general: "General",
  art: "Art",
  automotive: "Automotive",
  beauty: "Beauty",
  clothing: "Clothing",
  electronics: "Electronics",
  entertainment: "Entertainment",
  "food-and-drink": "Food & Beverages",
  garden: "Garden",
  hardware: "Hardware",
  home: "Home & Decor",
  "jewelry-and-accessories": "Jewelry & Accessories",
  kids: "Kids",
  office: "Office",
  pets: "Pets",
  services: "Services",
  shoes: "Shoes",
  sports: "Sports",
  toys: "Toys",
  wellness: "Wellness",
  wholesale: "Wholesale",
};

/** Only render filters backed by at least one visible catalog entry. */
export type ThemeCategory = {
  id: ThemeIndustry | "all";
  label: string;
};

/** Build filters from the resolved catalog, not the source-controlled fallback.
 * Runtime releases can add an industry without requiring an app deploy. */
export function themeCategoriesFor(
  themes: readonly ThemeMeta[],
): ThemeCategory[] {
  return [
    { id: "all", label: "All" },
    ...Array.from(
      new Set(
        themes
          .filter((theme) => theme.catalog.visibility !== "hidden")
          .flatMap((theme) => theme.catalog.industries),
      ),
      (id) => ({ id, label: INDUSTRY_LABELS[id] }),
    ),
  ];
}

export interface StoredThemeInstallation {
  presetId: string;
  presetVersion: string;
  engineId: string;
  engineVersion: number;
  appliedAt: string;
}

export interface ThemeSelection {
  id: string;
  version?: string;
}

/** Read the new pinned installation first, then the legacy `template` id.
 * This lets already-created stores render without a data migration. */
export function readThemeSelection(settings: unknown): ThemeSelection | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return null;
  }
  const record = settings as Record<string, unknown>;
  const installed = record.theme;
  if (installed && typeof installed === "object" && !Array.isArray(installed)) {
    const value = installed as Record<string, unknown>;
    if (typeof value.presetId === "string" && isThemeId(value.presetId)) {
      return {
        id: value.presetId,
        ...(typeof value.presetVersion === "string" && value.presetVersion
          ? { version: value.presetVersion }
          : {}),
      };
    }
  }
  return typeof record.template === "string" && isThemeId(record.template)
    ? { id: record.template }
    : null;
}

export function isThemeId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length <= 80 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)
  );
}

export function isThemeSelectable(theme: ThemeMeta): boolean {
  return theme.catalog.visibility !== "hidden";
}

/** New catalog releases lead everywhere themes are presented. ISO dates sort
 * lexically; missing dates stay behind dated releases, with manifest order as
 * the stable tie-breaker. */
export function newestThemesFirst<T extends ThemeMeta>(
  themes: readonly T[],
): T[] {
  return themes
    .map((theme, index) => ({ theme, index }))
    .sort((a, b) => {
      const byDate = (b.theme.release.releasedAt ?? "").localeCompare(
        a.theme.release.releasedAt ?? "",
      );
      return byDate || a.index - b.index;
    })
    .map(({ theme }) => theme);
}

export function canPreviewTheme(theme: ThemeMeta): boolean {
  return theme.demo.status === "healthy";
}
