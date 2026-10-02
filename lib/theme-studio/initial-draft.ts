import { EMPTY_CONFIG } from "@/lib/homepage/section-types";
import type { ThemeIntent } from "./contracts";

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const COPY_FIELDS = new Set([
  "heading",
  "subheading",
  "subtext",
  "eyebrow",
  "body",
  "cta_label",
  "cta_href",
  "button_label",
  "success_message",
  "consent_text",
  "badge_text",
  "image_alt",
  "poster_alt",
  "html",
]);
/** Registry examples also contain merchant onboarding copy and sample offers.
 * They describe the shape, but must never manufacture content for a new brand.
 * Required empty lists/copy go through the ordinary publish/content floors. */
function mechanicalDefaults(config: object): RecordValue {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      Array.isArray(value) ? [] : COPY_FIELDS.has(key) ? "" : value,
    ]),
  );
}

/** Native commerce compositions supply mechanical defaults, not brand copy or
 * artwork. Explicit choices remain subject to the ordinary compiler checks. */
export const NATIVE_COMPOSITIONS = {
  classic: {
    header: "classic",
    card: "classic",
    productDetail: "classic",
    cart: "classic",
    footer: "rich",
    storefront: "classic",
  },
  editorial: {
    header: "centered",
    card: "framed",
    productDetail: "editorial",
    cart: "compact",
    footer: "editorial",
    storefront: "classic",
  },
  grocery: {
    header: "market",
    card: "grocery",
    productDetail: "grocery",
    cart: "grocery",
    footer: "rich",
    storefront: "grocery",
  },
} as const;

/** Expand the v20 initial draft before compilation. This never runs on an old
 * paid checkpoint, manual revision, or settings repair. Derived navigation and
 * option combinations come only from the model's validated catalogue/pages. */
export function expandInitialDraft(
  raw: unknown,
  intent: ThemeIntent,
): {
  value: unknown;
  issues: string[];
} {
  if (!record(raw))
    return { value: raw, issues: ["The draft must be an object."] };
  if (
    typeof raw.composition !== "string" ||
    !Object.hasOwn(NATIVE_COMPOSITIONS, raw.composition)
  )
    return {
      value: raw,
      issues: ["Choose a native classic, editorial or grocery composition."],
    };
  if (
    typeof raw.navigation !== "string" ||
    !["simple", "collections"].includes(raw.navigation)
  )
    return { value: raw, issues: ["Choose simple or collections navigation."] };
  const value = structuredClone(raw);
  const issues: string[] = [];
  const composition =
    NATIVE_COMPOSITIONS[raw.composition as keyof typeof NATIVE_COMPOSITIONS];
  if (record(value.design)) {
    let chosen: RecordValue = {};
    try {
      const parsed = JSON.parse(String(value.design.layoutOverridesJson));
      if (!record(parsed))
        issues.push("design.layoutOverridesJson must encode an object.");
      else {
        const keys = [
          "header",
          "headerBackground",
          "headerForeground",
          "card",
          "cardHoverImage",
          "stickyAddToCart",
          "gridColumnsMobile",
          "gridColumnsDesktop",
          "shopFilters",
          "collectionBanner",
          "productDetail",
          "cart",
          "footer",
          "storefront",
        ];
        const unknown = Object.keys(parsed).filter(
          (key) => !keys.includes(key),
        );
        if (unknown.length)
          issues.push(
            `Unsupported layout overrides: ${unknown.slice(0, 5).join(", ")}.`,
          );
        chosen = parsed;
      }
    } catch {
      issues.push("design.layoutOverridesJson must encode an object.");
    }
    delete value.design.layoutOverridesJson;
    value.design.layout = {
      ...composition,
      stickyAddToCart: true,
      gridColumnsMobile: 2,
      gridColumnsDesktop: intent.visual.density === "dense" ? 5 : 3,
      shopFilters: true,
      collectionBanner: true,
      ...Object.fromEntries(
        Object.entries(chosen).filter(([, v]) => v !== null && v !== undefined),
      ),
    };
  }
  value.pages = list(value.pages).map((page, pageIndex) => {
    if (!record(page)) return page;
    return {
      ...page,
      sections: list(page.sections).map((section, sectionIndex) => {
        if (!record(section)) return section;
        const defaults =
          typeof section.type === "string" &&
          Object.hasOwn(EMPTY_CONFIG, section.type)
            ? EMPTY_CONFIG[section.type as keyof typeof EMPTY_CONFIG]
            : undefined;
        if (!defaults) return section; // ordinary compiler rejects the type
        try {
          const config = JSON.parse(String(section.configJson));
          if (!record(config)) return section;
          if (
            section.type === "rich_text" &&
            (typeof config.html !== "string" || !config.html.trim())
          )
            issues.push(
              `pages[${pageIndex}].sections[${sectionIndex}].configJson: rich_text requires a nonempty html string with original paragraphs. Put content in html, not body, text or markdown.`,
            );
          const expanded = {
            ...mechanicalDefaults(defaults),
            ...config,
          } as RecordValue;
          // These source/ID defaults are fixed because demo IDs are assigned later.
          if (
            section.type === "featured_products" &&
            config.source === undefined
          )
            expanded.source = "featured";
          if (
            section.type === "shop_by_category" &&
            config.source === undefined
          )
            expanded.source = "all";
          if (
            (section.type === "hero" || section.type === "hero_carousel") &&
            config.height === undefined
          )
            expanded.height = "medium";
          return { ...section, configJson: JSON.stringify(expanded) };
        } catch {
          return section;
        } // preserve the exact validation error
      }),
    };
  });
  value.products = list(value.products).map((product, index) => {
    if (!record(product)) return product;
    const options = list(product.options);
    let combinations: string[][] = [[]];
    if (options.length > 3) {
      issues.push(`products[${index}] supports at most three option axes.`);
      return { ...product, variants: [] };
    }
    for (const option of options) {
      if (
        !record(option) ||
        !Array.isArray(option.values) ||
        option.values.length < 1 ||
        option.values.some((v) => typeof v !== "string" || !v.trim())
      ) {
        issues.push(
          `products[${index}] option values must be nonempty strings.`,
        );
        combinations = [];
        break;
      }
      if (combinations.length * option.values.length > 100) {
        issues.push(`products[${index}] exceeds 100 option combinations.`);
        combinations = [];
        break;
      }
      const values = option.values as string[];
      combinations = combinations.flatMap((prior) =>
        values.map((v) => [...prior, v]),
      );
    }
    return {
      ...product,
      variants: options.length
        ? combinations.map((optionValues) => ({
            name: optionValues.join(" / "),
            optionValues,
            basePrice: product.basePrice,
            sellingPrice: product.sellingPrice,
            stock: 25,
          }))
        : [],
    };
  });
  const categories = list(value.categories).filter(record);
  const pages = list(value.pages)
    .filter(record)
    .filter((p) => typeof p.slug === "string" && p.slug);
  const link = (label: unknown, href: string) => ({ label, href });
  const header = [
    {
      ...link("Shop", "/shop"),
      image_url: "",
      children:
        raw.navigation === "collections"
          ? categories.map((c) => ({
              ...link(c.name, `/collections/${c.slug}`),
              children: [],
            }))
          : [],
    },
    ...pages.slice(0, 5).map((p) => ({
      ...link(p.title, `/${p.slug}`),
      image_url: "",
      children: [],
    })),
  ];
  value.menus = {
    header,
    footerGroups: [
      {
        title: "Explore",
        links: [
          link("Shop all", "/shop"),
          ...pages.map((p) => link(p.title, `/${p.slug}`)),
        ],
      },
    ],
    footerLegal: [],
  };
  // Features are capabilities, not model-authored claims about new code.
  value.features = ["category-navigation"];
  return { value, issues };
}
