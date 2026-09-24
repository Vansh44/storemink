import { DESIGN_FONTS } from "@/lib/chrome/design";
import { HOMEPAGE_SECTION_TYPES } from "@/lib/homepage/section-types";
import {
  THEME_STUDIO_FEATURES,
  THEME_STUDIO_INDUSTRIES,
  THEME_INTENT_SCHEMA_VERSION,
} from "./contracts";

// ---------------------------------------------------------------------------
// Provider-facing JSON schemas for structured output.
//
// Gemini's responseJsonSchema accepts a SUBSET of JSON Schema: types including
// `null`, `properties`, `required`, `additionalProperties`, `anyOf`, `enum`,
// `items`, item counts and numeric bounds — but not `minLength`, `maxLength`,
// `pattern`, `allOf` or `oneOf`, and "very large or deeply nested schemas may be
// rejected". So every object is closed and nothing leans on string rules; these
// are the STRUCTURAL guarantee only. `validateThemeIntent`,
// `validateThemePackageV2` and the compiler remain authoritative for every
// cross-field, registry and length rule; anything they refuse goes back to the
// model through the bounded repair loop.
//
// ★ Optional values are modelled as `anyOf [T, null]` and every property is
// required. A property the model may omit is a property it may silently forget;
// an explicit null is a decision it has to make.
//
// ★ A section's config is carried as a JSON STRING. The 15 renderable section
// types have 15 unrelated config shapes; a closed schema for each would be a
// very large union compiled on every call, and the section registry's own
// `validateSections` is the authority either way. The string is parsed and
// validated server-side.
// ---------------------------------------------------------------------------

/** Section types a generated theme may use: everything renderable except
 * executable custom code, blog feeds (a new store has no blogs) and video (the
 * asset pipeline produces still images only, so a video block could only ever
 * be empty — a request for one is a capability gap). */
export const THEME_STUDIO_SECTION_TYPES = HOMEPAGE_SECTION_TYPES.filter(
  (type) =>
    type !== "custom_code" && type !== "latest_blogs" && type !== "video",
);

export const THEME_STUDIO_FONT_VALUES = Object.values(DESIGN_FONTS);

const SURFACES = ["home", "shop", "product", "cart", "content", "not_found"];
const GAP_CODES = [
  "missing_section",
  "missing_layout_variant",
  "missing_design_token",
  "unsupported_interaction",
  "unsupported_asset",
  "requires_custom_code",
];

type Schema = Record<string, unknown>;

const str: Schema = { type: "string" };
const strList: Schema = { type: "array", items: str };
const nullable = (schema: Schema): Schema => ({
  anyOf: [schema, { type: "null" }],
});
const enumOf = (values: readonly string[]): Schema => ({
  type: "string",
  enum: [...values],
});
const obj = (properties: Record<string, Schema>): Schema => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});

const capabilityGap = obj({
  code: enumOf(GAP_CODES),
  requestedCapability: str,
  reason: str,
  blocking: { type: "boolean" },
  suggestedPlatformCapability: nullable(str),
});

const responsiveBreakpoint = obj({
  composition: strList,
  navigation: str,
  media: str,
});

export const STAGE_A_INTENT_SCHEMA: Schema = obj({
  schemaVersion: { type: "integer", enum: [THEME_INTENT_SCHEMA_VERSION] },
  summary: str,
  audiences: strList,
  industries: { type: "array", items: enumOf(THEME_STUDIO_INDUSTRIES) },
  commercialGoals: strList,
  visual: obj({
    moodKeywords: strList,
    paletteDirection: str,
    typographyDirection: str,
    density: enumOf(["airy", "balanced", "dense"]),
    shape: enumOf(["soft", "mixed", "square"]),
    motion: enumOf(["none", "restrained", "expressive"]),
  }),
  pagePlans: {
    type: "array",
    items: obj({
      surface: enumOf(SURFACES),
      purpose: str,
      sectionTypes: {
        type: "array",
        items: enumOf(THEME_STUDIO_SECTION_TYPES),
      },
    }),
  },
  responsive: obj({
    desktop: responsiveBreakpoint,
    tablet: responsiveBreakpoint,
    mobile: responsiveBreakpoint,
  }),
  assetBriefs: {
    type: "array",
    items: obj({
      id: str,
      purpose: str,
      subject: str,
      aspectRatio: enumOf([
        "1:1",
        "4:3",
        "3:2",
        "16:9",
        "21:9",
        "3:4",
        "2:3",
        "4:5",
        "9:16",
      ]),
      artDirection: str,
      source: enumOf(["operator", "curated", "generate"]),
    }),
  },
  assumptions: strList,
  capabilityGaps: { type: "array", items: capabilityGap },
});

/** Stage A's envelope. The model decides first whether it CAN proceed. */
export const STAGE_A_ENVELOPE_SCHEMA: Schema = obj({
  decision: enumOf(["proceed", "clarify", "decline"]),
  questions: strList,
  declineReason: nullable(str),
  intent: nullable(STAGE_A_INTENT_SCHEMA),
});

const link = obj({ label: str, href: str });
const hex = str;
const PALETTE_KEYS = [
  "cream",
  "creamDeep",
  "surface",
  "ink",
  "inkSoft",
  "inkFaint",
  "taupe",
  "sand",
  "butter",
  "border",
  "tile",
  "accentWarm",
  "onAccent",
  "onInk",
  "success",
  "successSoft",
  "error",
  "errorSoft",
  "star",
  "highlight",
] as const;

export const STAGE_B_DRAFT_SCHEMA: Schema = obj({
  description: str,
  keywords: strList,
  features: { type: "array", items: enumOf(THEME_STUDIO_FEATURES) },
  brand: obj({ primaryColor: hex, tagline: str, blurb: str }),
  design: obj({
    palette: obj({
      ...Object.fromEntries(PALETTE_KEYS.map((key) => [key, hex])),
      shadowRgb: str,
      accent: nullable(hex),
      accentDeep: nullable(hex),
    }),
    fonts: obj({
      body: enumOf(THEME_STUDIO_FONT_VALUES),
      display: enumOf(THEME_STUDIO_FONT_VALUES),
    }),
    shape: obj({ card: str, control: str, sm: str, pill: str }),
    layout: obj({
      header: nullable(enumOf(["classic", "market", "centered", "minimal"])),
      headerBackground: nullable(hex),
      headerForeground: nullable(hex),
      card: nullable(
        enumOf(["classic", "quick_add", "overlay", "framed", "grocery"]),
      ),
      cardHoverImage: nullable({ type: "boolean" }),
      stickyAddToCart: nullable({ type: "boolean" }),
      gridColumnsMobile: nullable({ type: "integer", enum: [1, 2] }),
      gridColumnsDesktop: nullable({ type: "integer", enum: [3, 4, 5] }),
      productDetail: nullable(enumOf(["classic", "grocery", "editorial"])),
      cart: nullable(enumOf(["classic", "grocery", "compact"])),
      footer: nullable(enumOf(["rich", "minimal", "editorial"])),
      storefront: nullable(enumOf(["classic", "grocery"])),
    }),
  }),
  pages: {
    type: "array",
    items: obj({
      slug: str,
      title: str,
      seoTitle: nullable(str),
      seoDescription: nullable(str),
      sections: {
        type: "array",
        items: obj({
          type: enumOf(THEME_STUDIO_SECTION_TYPES),
          configJson: str,
        }),
      },
    }),
  },
  menus: obj({
    header: { type: "array", items: link },
    footerGroups: {
      type: "array",
      items: obj({ title: str, links: { type: "array", items: link } }),
    },
    footerLegal: { type: "array", items: link },
  }),
  categories: {
    type: "array",
    items: obj({
      name: str,
      slug: str,
      description: nullable(str),
      imageSlot: nullable(str),
    }),
  },
  products: {
    type: "array",
    items: obj({
      name: str,
      slug: str,
      description: str,
      categorySlug: str,
      basePrice: { type: "number" },
      sellingPrice: { type: "number" },
      imageSlot: str,
      featured: { type: "boolean" },
      variants: {
        type: "array",
        items: obj({
          name: str,
          basePrice: { type: "number" },
          sellingPrice: { type: "number" },
          stock: { type: "integer" },
        }),
      },
    }),
  },
  capabilityGaps: { type: "array", items: capabilityGap },
});

export { PALETTE_KEYS };
