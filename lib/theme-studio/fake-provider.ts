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
