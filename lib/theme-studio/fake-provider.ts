import type {
  ThemeCatalogSize,
  ThemeFeature,
  ThemeIndustry,
} from "@/lib/themes/meta";
import {
  THEME_INTENT_SCHEMA_VERSION,
  validateThemeIntent,
  type ThemeContractResult,
  type ThemeIntent,
} from "./contracts";
import { EMPTY_CONFIG } from "@/lib/homepage/section-types";
import { studio } from "@/lib/themes/definitions/studio";
import type { ThemeStudioModelClient } from "./provider";
import { ZERO_USAGE } from "./provider";

// ---------------------------------------------------------------------------
// The Phase 2 provider: deterministic, offline, free.
//
// It exists so the whole durable pipeline — queue, lease, cancel, retry,
// immutable version, audit — can be exercised end to end before any model is
// wired in. It calls no network, reads no reference pixels, and produces a
// Stage A `ThemeIntent` that goes through the SAME validator a real model's
// output will, so a provider that returns something invalid fails the run
// rather than creating a version.
//
// ★ It says what it is. The intent's first assumption records that no model
// was called, so a fake version can never be mistaken for real analysis by
// anyone reading it later.
// ---------------------------------------------------------------------------

export interface FakeProviderInput {
  name: string;
  brief: string;
  industries: ThemeIndustry[];
  catalogSizes: ThemeCatalogSize[];
  requiredFeatures: ThemeFeature[];
  referenceCount: number;
  /** True once the operator has answered a clarifying question, so the
   * clarify drill asks once rather than forever. */
  answered?: boolean;
  /** Deterministic failure hook for tests and staging drills. */
  failWith?: "invalid_output";
}

function firstSentence(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  const end = trimmed.search(/[.!?](\s|$)/);
  const sentence = end > 0 ? trimmed.slice(0, end + 1) : trimmed;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

export function runFakeProvider(
  input: FakeProviderInput,
): ThemeContractResult<ThemeIntent> {
  if (input.failWith === "invalid_output") {
    return validateThemeIntent({ schemaVersion: THEME_INTENT_SCHEMA_VERSION });
  }
  const large = input.catalogSizes.includes("large");
  const wantsFaq = input.requiredFeatures.includes("faq");
  const intent: ThemeIntent = {
    schemaVersion: THEME_INTENT_SCHEMA_VERSION,
    summary: `${input.name}: ${firstSentence(input.brief, 400)}`,
    audiences: ["Shoppers described in the operator brief"],
    industries: [...input.industries],
    commercialGoals: [
      "Make the catalogue easy to browse on every device",
      "Keep the path from product to cart short",
    ],
    visual: {
      moodKeywords: ["clear", "considered"],
      paletteDirection:
        "Neutral base with one accent, to be refined by the model.",
      typographyDirection: "A readable sans body with a distinct display face.",
      density: large ? "dense" : "balanced",
      shape: "mixed",
      motion: "restrained",
    },
    pagePlans: [
      {
        surface: "home",
        purpose: "Introduce the brand and route shoppers into the catalogue.",
        sectionTypes: [
          "hero",
          large ? "shop_by_category" : "media_text",
          "featured_products",
          ...(wantsFaq ? ["faq_accordion"] : []),
        ],
      },
      {
        surface: "product",
        purpose: "Make price, options and availability obvious.",
        sectionTypes: [],
      },
    ],
    responsive: {
      desktop: {
        composition: ["Wide hero", "Multi-column product grid"],
        navigation: "Primary navigation with visible search.",
        media: "Wide crops that preserve product scale.",
      },
      tablet: {
        composition: ["Two-column product grid"],
        navigation: "Secondary links collapse into a drawer.",
        media: "4:3 crops with protected focal points.",
      },
      mobile: {
        composition: ["Single-column story", "Two-up product grid"],
        navigation: "Thumb-reachable drawer and cart controls.",
        media: "Portrait crops authored for small screens.",
      },
    },
    assetBriefs: [
      {
        id: "home-hero",
        purpose: "Homepage hero",
        subject: "The store's own products in use",
        aspectRatio: "16:9",
        artDirection: "Natural light, no third-party logos or copied artwork.",
        source: "operator",
      },
    ],
    assumptions: [
      "Fake provider output: no model was called and no reference image was analysed.",
      `The operator attached ${input.referenceCount} reference image(s).`,
    ],
    capabilityGaps: [],
  };
  return validateThemeIntent(intent);
}

// ---------------------------------------------------------------------------
// The offline model CLIENT. It implements the same interface as the Gemini
// client, so a fake run goes through the real pipeline: envelope handling,
// intent validation, compilation, placeholder rendering, package validation and
// the repair loop. What it returns is deterministic and built from the bundled
// Studio theme's tokens, so a fake version is always a valid package.
//
// Drill hooks, read from the operator's brief (never used by a real provider):
//   [[fake:clarify]]         Stage A asks a question
//   [[fake:decline]]         Stage A declines
//   [[fake:invalid_output]]  Stage A never returns a valid intent
//   [[fake:repair]]          Stage B's first draft is invalid; the repair fixes it
// ---------------------------------------------------------------------------

const FAKE_CATEGORIES = [
  { name: "Everyday", slug: "everyday" },
  { name: "Home", slug: "home" },
  { name: "Travel", slug: "travel" },
  { name: "Gifts", slug: "gifts" },
] as const;

function fakeDraft(intent: ThemeIntent, name: string): Record<string, unknown> {
  const slot = intent.assetBriefs[0]?.id ?? "home-hero";
  const { palette, fonts, shape } = studio.preset.design;
  const noStyle = { scheme: null, padding: null, width: null };
  const section = (
    type: string,
    config: unknown,
    style: Record<string, unknown> = noStyle,
  ) => ({
    type,
    configJson: JSON.stringify(config),
    style: { ...noStyle, ...style },
  });
  return {
    description: `${name}: a clear, responsive storefront generated by the offline test provider.`,
    keywords: ["test", "storefront"],
    features: ["category-navigation"],
    brand: {
      primaryColor: palette.ink,
      tagline: `${name} everyday essentials`,
      blurb: `${name} is an offline test storefront with a full sample catalogue.`,
    },
    design: {
      palette: { ...palette, accent: null, accentDeep: null },
      fonts,
      shape,
      layout: {
        header: "centered",
        headerBackground: null,
        headerForeground: null,
        card: "framed",
        cardHoverImage: null,
        stickyAddToCart: true,
        gridColumnsMobile: 2,
        gridColumnsDesktop: null,
        shopFilters: true,
        collectionBanner: true,
        productDetail: "editorial",
        cart: null,
        footer: "minimal",
        storefront: null,
      },
      // One declared scheme and one derived, so both paths run offline.
      schemes: {
        soft: null,
        tint: {
          background: "#dfe4ff",
          text: palette.ink,
          surface: null,
          accent: null,
          onAccent: null,
        },
        accent: null,
        inverse: null,
      },
      typography: {
        headingFont: "display",
        headingScale: "large",
        headingWeight: "semibold",
        headingCase: null,
        headingTracking: "tight",
      },
    },
    pages: [
      {
        slug: "",
        title: "Home",
        seoTitle: null,
        seoDescription: null,
        sections: [
          section("hero", {
            ...EMPTY_CONFIG.hero,
            heading: name,
            image_url: `theme-asset://${slot}`,
            height: "large",
            focal_y: 40,
          }),
          section("shop_by_category", EMPTY_CONFIG.shop_by_category, {
            scheme: "tint",
            width: "full",
          }),
          section("featured_products", EMPTY_CONFIG.featured_products),
          section("promo_banner", {
            ...EMPTY_CONFIG.promo_banner,
            heading: "New arrivals every week",
            cta_label: "Shop now",
            cta_href: "/shop",
          }),
          section("newsletter", EMPTY_CONFIG.newsletter, {
            scheme: "inverse",
            padding: "lg",
            width: "full",
          }),
        ],
      },
      {
        slug: "about",
        title: "About",
        seoTitle: null,
        seoDescription: null,
        sections: [
          section("media_text", {
            ...EMPTY_CONFIG.media_text,
            cta_href: "/shop",
            image_url: `theme-asset://${slot}`,
          }),
        ],
      },
    ],
    menus: {
      header: [
        {
          label: "Shop",
          href: "/shop",
          image_url: `theme-asset://${slot}`,
          children: [
            {
              label: "Everyday",
              href: "/collections/everyday",
              children: [{ label: "Sample one", href: "/shop/sample-one" }],
            },
          ],
        },
        { label: "About", href: "/about", image_url: "", children: [] },
      ],
      footerGroups: [
        { title: "Shop", links: [{ label: "All products", href: "/shop" }] },
      ],
      footerLegal: [],
    },
    // ★ Four categories and eight products: the production content floors
    // (validateThemeSampleData) now run in the compiler, and the offline
    // provider must produce a package that clears them, as a model must.
    categories: FAKE_CATEGORIES.map((category) => ({
      name: category.name,
      slug: category.slug,
      description: null,
      imageSlot: slot,
    })),
    products: [
      {
        name: "Sample one",
        slug: "sample-one",
        description: "A sample product from the offline provider.",
        categorySlug: "everyday",
        basePrice: 999,
        sellingPrice: 899,
        imageSlot: slot,
        featured: true,
        // One product with real option axes, so the offline path exercises
        // option compilation and the storefront pickers end to end.
        options: [
          { name: "Size", values: ["S", "M"], swatches: [] },
          {
            name: "Colour",
            values: ["Black", "Sand"],
            swatches: [
              { value: "Black", hex: "#111111" },
              { value: "Sand", hex: "#d6c3a1" },
            ],
          },
        ],
        variants: [
          ["S", "Black"],
          ["S", "Sand"],
          ["M", "Black"],
          ["M", "Sand"],
        ].map((optionValues) => ({
          name: optionValues.join(" / "),
          optionValues,
          basePrice: 999,
          sellingPrice: 899,
          stock: 5,
        })),
      },
      {
        name: "Sample two",
        slug: "sample-two",
        description: "Another sample product from the offline provider.",
        categorySlug: "everyday",
        basePrice: 1499,
        sellingPrice: 1499,
        imageSlot: slot,
        featured: false,
        options: [],
        variants: [],
      },
      ...FAKE_CATEGORIES.flatMap((category, c) =>
        [0, 1].map((n) => ({
          name: `${category.name} pick ${n + 1}`,
          slug: `${category.slug}-pick-${n + 1}`,
          description: `A ${category.name.toLowerCase()} sample product for testing.`,
          categorySlug: category.slug,
          basePrice: 499 + c * 100 + n * 50,
          sellingPrice: 499 + c * 100 + n * 50,
          imageSlot: slot,
          featured: n === 0,
          options: [],
          variants: [],
        })),
      ).slice(0, 6),
    ],
    capabilityGaps: [],
  };
}

export function createFakeModelClient(
  input: FakeProviderInput,
): ThemeStudioModelClient {
  const hook = (name: string) => input.brief.includes(`[[fake:${name}]]`);
  return {
    provider: "fake",
    async generate(request) {
      const isRepair = request.content.some(
        (block) =>
          block.type === "text" &&
          block.text.includes("failed StoreMink validation"),
      );
      if (request.stage === "intent") {
        if (hook("clarify") && !input.answered) {
          return {
            kind: "ok",
            usage: ZERO_USAGE,
            value: {
              decision: "clarify",
              questions: ["Where will product photography come from?"],
              declineReason: null,
              intent: null,
            },
          };
        }
        if (hook("decline")) {
          return {
            kind: "ok",
            usage: ZERO_USAGE,
            value: {
              decision: "decline",
              questions: [],
              declineReason: "Test provider decline drill.",
              intent: null,
            },
          };
        }
        const intent = runFakeProvider({
          ...input,
          failWith: hook("invalid_output") ? "invalid_output" : undefined,
        });
        return {
          kind: "ok",
          usage: ZERO_USAGE,
          value: {
            decision: "proceed",
            questions: [],
            declineReason: null,
            intent: intent.ok
              ? intent.value
              : { schemaVersion: THEME_INTENT_SCHEMA_VERSION },
          },
        };
      }
      const intent = runFakeProvider(input);
      if (!intent.ok) return { kind: "invalid_json", usage: ZERO_USAGE };
      const draft = fakeDraft(intent.value, input.name);
      if (hook("repair") && !isRepair) {
        return {
          kind: "ok",
          usage: ZERO_USAGE,
          value: { ...draft, pages: [] },
        };
      }
      return { kind: "ok", usage: ZERO_USAGE, value: draft };
    },
  };
}
