import {
  HOMEPAGE_SECTION_TYPES,
  validatePageSlug,
  validateSections,
  type PageSectionItem,
} from "@/lib/sections/registry";
import { sanitizeMenusForSave } from "@/lib/menus";
import type {
  ThemeCatalogSize,
  ThemeFeature,
  ThemeIndustry,
} from "@/lib/themes/meta";
import type { ThemeDefinition } from "@/lib/themes/types";
import { parseThemeStudioModelKey, type ThemeStudioModelKey } from "./models";

export const THEME_INTENT_SCHEMA_VERSION = 1 as const;
export const THEME_PACKAGE_SCHEMA_VERSION = 2 as const;

export const THEME_STUDIO_VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 768, height: 1024 },
  mobile: { width: 390, height: 844 },
} as const;

export const THEME_STUDIO_LIMITS = {
  promptChars: 12_000,
  referenceImages: 10,
  referenceImageBytes: 10 * 1024 * 1024,
  referenceTotalBytes: 40 * 1024 * 1024,
  projectsPerOperatorPerDay: 20,
  concurrentRunsPerOperator: 2,
  runWallTimeSeconds: 20 * 60,
  modelRetries: 2,
  repairAttempts: 2,
  packageChars: 2 * 1024 * 1024,
  pages: 20,
  assetBriefs: 40,
  assumptions: 30,
  capabilityGaps: 20,
} as const;

export const THEME_STUDIO_PROJECT_STATES = [
  "draft",
  "generating",
  "ready",
  "candidate",
  "approved",
  "published",
  "failed",
  "blocked",
  "archived",
] as const;

export type ThemeStudioProjectState =
  (typeof THEME_STUDIO_PROJECT_STATES)[number];

const STATE_TRANSITIONS: Record<
  ThemeStudioProjectState,
  readonly ThemeStudioProjectState[]
> = {
  draft: ["generating", "archived"],
  generating: ["ready", "failed", "blocked"],
  ready: ["generating", "candidate", "blocked", "archived"],
  candidate: ["generating", "approved", "blocked", "archived"],
  approved: ["generating", "published", "blocked", "archived"],
  published: ["archived"],
  failed: ["generating", "archived"],
  blocked: ["generating", "ready", "archived"],
  archived: [],
};

export function canTransitionThemeStudioProject(
  from: ThemeStudioProjectState,
  to: ThemeStudioProjectState,
): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

export type ThemeStudioSurface =
  | "home"
  | "shop"
  | "product"
  | "cart"
  | "content"
  | "not_found";

export type ThemeCapabilityGapCode =
  | "missing_section"
  | "missing_layout_variant"
  | "missing_design_token"
  | "unsupported_interaction"
  | "unsupported_asset"
  | "requires_custom_code";

export interface ThemeCapabilityGap {
  code: ThemeCapabilityGapCode;
  requestedCapability: string;
  reason: string;
  blocking: boolean;
  suggestedPlatformCapability?: string;
}

export interface ThemeIntent {
  schemaVersion: typeof THEME_INTENT_SCHEMA_VERSION;
  summary: string;
  audiences: string[];
  industries: ThemeIndustry[];
  commercialGoals: string[];
  visual: {
    moodKeywords: string[];
    paletteDirection: string;
    typographyDirection: string;
    density: "airy" | "balanced" | "dense";
    shape: "soft" | "mixed" | "square";
    motion: "none" | "restrained" | "expressive";
  };
  pagePlans: {
    surface: ThemeStudioSurface;
    purpose: string;
    sectionTypes: string[];
  }[];
  responsive: Record<
    "desktop" | "tablet" | "mobile",
    { composition: string[]; navigation: string; media: string }
  >;
  assetBriefs: {
    id: string;
    purpose: string;
    subject: string;
    aspectRatio: string;
    artDirection: string;
    source: "operator" | "curated" | "generate";
  }[];
  assumptions: string[];
  capabilityGaps: ThemeCapabilityGap[];
}

export interface ThemePackageAsset {
  id: string;
  path: string;
  kind: "reference" | "hero" | "product" | "category" | "content" | "preview";
  source: "generated" | "operator-owned" | "licensed" | "legacy-bundled";
  sha256: string | null;
  width: number | null;
  height: number | null;
  alt: string;
  licenseNote?: string;
}

export interface ThemePackageV2 {
  schemaVersion: typeof THEME_PACKAGE_SCHEMA_VERSION;
  definition: ThemeDefinition;
  renderer: {
    minVersion: number;
    viewports: typeof THEME_STUDIO_VIEWPORTS;
  };
  declaredCapabilities: {
    features: ThemeFeature[];
    surfaces: ThemeStudioSurface[];
  };
  assets: ThemePackageAsset[];
  provenance: {
    origin: "generated" | "bundled";
    modelKey: ThemeStudioModelKey | null;
    promptVersion: string | null;
    referenceDigests: string[];
  };
  capabilityGaps: ThemeCapabilityGap[];
}

export type ThemeContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: string[] };

const INDUSTRIES: readonly ThemeIndustry[] = [
  "general",
  "art",
  "automotive",
  "beauty",
  "clothing",
  "electronics",
  "entertainment",
  "food-and-drink",
  "garden",
  "hardware",
  "home",
  "jewelry-and-accessories",
  "kids",
  "office",
  "pets",
  "services",
  "shoes",
  "sports",
  "toys",
  "wellness",
  "wholesale",
];

const CATALOG_SIZES: readonly ThemeCatalogSize[] = [
  "one-product",
  "small",
  "medium",
  "large",
];

const FEATURES: readonly ThemeFeature[] = [
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
];

const SURFACES: readonly ThemeStudioSurface[] = [
  "home",
  "shop",
  "product",
  "cart",
  "content",
  "not_found",
];

const GAP_CODES: readonly ThemeCapabilityGapCode[] = [
  "missing_section",
  "missing_layout_variant",
  "missing_design_token",
  "unsupported_interaction",
  "unsupported_asset",
  "requires_custom_code",
];

const ROOT_INTENT_KEYS = [
  "schemaVersion",
  "summary",
  "audiences",
  "industries",
  "commercialGoals",
  "visual",
  "pagePlans",
  "responsive",
  "assetBriefs",
  "assumptions",
  "capabilityGaps",
] as const;

const SHA256_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ASSET_ID_RE = /^[a-z][a-z0-9-]{0,79}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const RGB_TRIPLE_RE = /^\d{1,3},\s*\d{1,3},\s*\d{1,3}$/;
const CSS_LENGTH_RE = /^\d+(?:\.\d+)?(?:px|rem|em|%)$/;
const FONT_RE = /^var\(--font-[a-z0-9-]+\)$/;
const RATIO_RE = /^\d{1,3}:\d{1,3}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  issues: string[],
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    issues.push(`${label} has unsupported fields: ${extras.join(", ")}.`);
  }
}

function requiredString(
  value: unknown,
  label: string,
  issues: string[],
  max = 500,
): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) issues.push(`${label} is required.`);
  else if (text.length > max)
    issues.push(`${label} exceeds ${max} characters.`);
  return text.slice(0, max);
}

function stringList(
  value: unknown,
  label: string,
  issues: string[],
  {
    min = 0,
    max = 20,
    itemMax = 240,
  }: { min?: number; max?: number; itemMax?: number } = {},
): string[] {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array.`);
    return [];
  }
  if (value.length < min)
    issues.push(`${label} needs at least ${min} item(s).`);
  if (value.length > max) issues.push(`${label} allows at most ${max} items.`);
  const out: string[] = [];
  for (let index = 0; index < Math.min(value.length, max); index++) {
    const text = requiredString(
      value[index],
      `${label}[${index}]`,
      issues,
      itemMax,
    );
    if (text) out.push(text);
  }
  return out;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  issues: string[],
): T | null {
  if (typeof value === "string" && allowed.includes(value as T))
    return value as T;
  issues.push(`${label} must be one of: ${allowed.join(", ")}.`);
  return null;
}

function parseCapabilityGaps(
  value: unknown,
  label: string,
  issues: string[],
): ThemeCapabilityGap[] {
  if (!Array.isArray(value)) {
    issues.push(`${label} must be an array.`);
    return [];
  }
  if (value.length > THEME_STUDIO_LIMITS.capabilityGaps) {
    issues.push(
      `${label} allows at most ${THEME_STUDIO_LIMITS.capabilityGaps} items.`,
    );
  }
  return value
    .slice(0, THEME_STUDIO_LIMITS.capabilityGaps)
    .flatMap((raw, index) => {
      if (!isRecord(raw)) {
        issues.push(`${label}[${index}] must be an object.`);
        return [];
      }
      rejectUnknownKeys(
        raw,
        [
          "code",
          "requestedCapability",
          "reason",
          "blocking",
          "suggestedPlatformCapability",
        ],
        `${label}[${index}]`,
        issues,
      );
      const code = enumValue(
        raw.code,
        GAP_CODES,
        `${label}[${index}].code`,
        issues,
      );
      const requestedCapability = requiredString(
        raw.requestedCapability,
        `${label}[${index}].requestedCapability`,
        issues,
        240,
      );
      const reason = requiredString(
        raw.reason,
        `${label}[${index}].reason`,
        issues,
        500,
      );
      if (typeof raw.blocking !== "boolean") {
        issues.push(`${label}[${index}].blocking must be a boolean.`);
      }
      const suggested =
        raw.suggestedPlatformCapability === undefined
          ? undefined
          : requiredString(
              raw.suggestedPlatformCapability,
              `${label}[${index}].suggestedPlatformCapability`,
              issues,
              240,
            );
      if (
        !code ||
        !requestedCapability ||
        !reason ||
        typeof raw.blocking !== "boolean"
      ) {
        return [];
      }
      return [
        {
          code,
          requestedCapability,
          reason,
          blocking: raw.blocking,
          ...(suggested ? { suggestedPlatformCapability: suggested } : {}),
        },
      ];
    });
}

export function validateThemeIntent(
  input: unknown,
): ThemeContractResult<ThemeIntent> {
  const issues: string[] = [];
  if (!isRecord(input))
    return { ok: false, issues: ["Theme intent must be an object."] };
  rejectUnknownKeys(input, ROOT_INTENT_KEYS, "Theme intent", issues);
  if (input.schemaVersion !== THEME_INTENT_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${THEME_INTENT_SCHEMA_VERSION}.`);
  }

  const summary = requiredString(input.summary, "summary", issues, 1_000);
  const audiences = stringList(input.audiences, "audiences", issues, {
    min: 1,
    max: 8,
    itemMax: 160,
  });
  const industries = Array.isArray(input.industries)
    ? input.industries.flatMap((value, index) => {
        const parsed = enumValue(
          value,
          INDUSTRIES,
          `industries[${index}]`,
          issues,
        );
        return parsed ? [parsed] : [];
      })
    : (issues.push("industries must be an array."), []);
  if (industries.length === 0)
    issues.push("industries needs at least one item.");
  const commercialGoals = stringList(
    input.commercialGoals,
    "commercialGoals",
    issues,
    {
      min: 1,
      max: 8,
      itemMax: 240,
    },
  );

  const visual = isRecord(input.visual) ? input.visual : {};
  if (!isRecord(input.visual)) issues.push("visual must be an object.");
  rejectUnknownKeys(
    visual,
    [
      "moodKeywords",
      "paletteDirection",
      "typographyDirection",
      "density",
      "shape",
      "motion",
    ],
    "visual",
    issues,
  );
  const moodKeywords = stringList(
    visual.moodKeywords,
    "visual.moodKeywords",
    issues,
    {
      min: 2,
      max: 10,
      itemMax: 60,
    },
  );
  const paletteDirection = requiredString(
    visual.paletteDirection,
    "visual.paletteDirection",
    issues,
    500,
  );
  const typographyDirection = requiredString(
    visual.typographyDirection,
    "visual.typographyDirection",
    issues,
    500,
  );
  const density = enumValue(
    visual.density,
    ["airy", "balanced", "dense"] as const,
    "visual.density",
    issues,
  );
  const shape = enumValue(
    visual.shape,
    ["soft", "mixed", "square"] as const,
    "visual.shape",
    issues,
  );
  const motion = enumValue(
    visual.motion,
    ["none", "restrained", "expressive"] as const,
    "visual.motion",
    issues,
  );

  const pagePlans: ThemeIntent["pagePlans"] = [];
  if (!Array.isArray(input.pagePlans)) {
    issues.push("pagePlans must be an array.");
  } else {
    if (input.pagePlans.length === 0)
      issues.push("pagePlans needs at least one item.");
    if (input.pagePlans.length > SURFACES.length) {
      issues.push(`pagePlans allows at most ${SURFACES.length} items.`);
    }
    const seen = new Set<ThemeStudioSurface>();
    for (const [index, raw] of input.pagePlans
      .slice(0, SURFACES.length)
      .entries()) {
      if (!isRecord(raw)) {
        issues.push(`pagePlans[${index}] must be an object.`);
        continue;
      }
      rejectUnknownKeys(
        raw,
        ["surface", "purpose", "sectionTypes"],
        `pagePlans[${index}]`,
        issues,
      );
      const surface = enumValue(
        raw.surface,
        SURFACES,
        `pagePlans[${index}].surface`,
        issues,
      );
      const purpose = requiredString(
        raw.purpose,
        `pagePlans[${index}].purpose`,
        issues,
        500,
      );
      const sectionTypes = stringList(
        raw.sectionTypes,
        `pagePlans[${index}].sectionTypes`,
        issues,
        { max: 20, itemMax: 80 },
      );
      for (const type of sectionTypes) {
        if (!HOMEPAGE_SECTION_TYPES.includes(type as never)) {
          issues.push(
            `pagePlans[${index}].sectionTypes contains unsupported section ${JSON.stringify(type)}; record it as a capability gap instead.`,
          );
        }
      }
      if (surface && seen.has(surface))
        issues.push(`pagePlans repeats surface ${surface}.`);
      if (surface) seen.add(surface);
      if (surface && purpose)
        pagePlans.push({ surface, purpose, sectionTypes });
    }
  }

  const responsiveInput = isRecord(input.responsive) ? input.responsive : {};
  if (!isRecord(input.responsive)) issues.push("responsive must be an object.");
  rejectUnknownKeys(
    responsiveInput,
    ["desktop", "tablet", "mobile"],
    "responsive",
    issues,
  );
  const responsive = {} as ThemeIntent["responsive"];
  for (const viewport of ["desktop", "tablet", "mobile"] as const) {
    const raw = isRecord(responsiveInput[viewport])
      ? responsiveInput[viewport]
      : {};
    if (!isRecord(responsiveInput[viewport]))
      issues.push(`responsive.${viewport} must be an object.`);
    rejectUnknownKeys(
      raw,
      ["composition", "navigation", "media"],
      `responsive.${viewport}`,
      issues,
    );
    responsive[viewport] = {
      composition: stringList(
        raw.composition,
        `responsive.${viewport}.composition`,
        issues,
        {
          min: 1,
          max: 12,
          itemMax: 240,
        },
      ),
      navigation: requiredString(
        raw.navigation,
        `responsive.${viewport}.navigation`,
        issues,
        400,
      ),
      media: requiredString(
        raw.media,
        `responsive.${viewport}.media`,
        issues,
        400,
      ),
    };
  }

  const assetBriefs: ThemeIntent["assetBriefs"] = [];
  if (!Array.isArray(input.assetBriefs)) {
    issues.push("assetBriefs must be an array.");
  } else {
    if (input.assetBriefs.length > THEME_STUDIO_LIMITS.assetBriefs) {
      issues.push(
        `assetBriefs allows at most ${THEME_STUDIO_LIMITS.assetBriefs} items.`,
      );
    }
    const seen = new Set<string>();
    for (const [index, raw] of input.assetBriefs
      .slice(0, THEME_STUDIO_LIMITS.assetBriefs)
      .entries()) {
      if (!isRecord(raw)) {
        issues.push(`assetBriefs[${index}] must be an object.`);
        continue;
      }
      rejectUnknownKeys(
        raw,
        ["id", "purpose", "subject", "aspectRatio", "artDirection", "source"],
        `assetBriefs[${index}]`,
        issues,
      );
      const id = requiredString(raw.id, `assetBriefs[${index}].id`, issues, 80);
      if (id && !ASSET_ID_RE.test(id))
        issues.push(`assetBriefs[${index}].id must be kebab-case.`);
      if (seen.has(id))
        issues.push(`assetBriefs repeats id ${JSON.stringify(id)}.`);
      seen.add(id);
      const purpose = requiredString(
        raw.purpose,
        `assetBriefs[${index}].purpose`,
        issues,
        240,
      );
      const subject = requiredString(
        raw.subject,
        `assetBriefs[${index}].subject`,
        issues,
        500,
      );
      const aspectRatio = requiredString(
        raw.aspectRatio,
        `assetBriefs[${index}].aspectRatio`,
        issues,
        12,
      );
      if (aspectRatio && !RATIO_RE.test(aspectRatio)) {
        issues.push(`assetBriefs[${index}].aspectRatio must look like 4:3.`);
      }
      const artDirection = requiredString(
        raw.artDirection,
        `assetBriefs[${index}].artDirection`,
        issues,
        800,
      );
      const source = enumValue(
        raw.source,
        ["operator", "curated", "generate"] as const,
        `assetBriefs[${index}].source`,
        issues,
      );
      if (id && purpose && subject && aspectRatio && artDirection && source) {
        assetBriefs.push({
          id,
          purpose,
          subject,
          aspectRatio,
          artDirection,
          source,
        });
      }
    }
  }

  const assumptions = stringList(input.assumptions, "assumptions", issues, {
    max: THEME_STUDIO_LIMITS.assumptions,
    itemMax: 400,
  });
  const capabilityGaps = parseCapabilityGaps(
    input.capabilityGaps,
    "capabilityGaps",
    issues,
  );

  if (issues.length > 0 || !density || !shape || !motion)
    return { ok: false, issues };
  return {
    ok: true,
    value: {
      schemaVersion: THEME_INTENT_SCHEMA_VERSION,
      summary,
      audiences,
      industries,
      commercialGoals,
      visual: {
        moodKeywords,
        paletteDirection,
        typographyDirection,
        density,
        shape,
        motion,
      },
      pagePlans,
      responsive,
      assetBriefs,
      assumptions,
      capabilityGaps,
    },
  };
}

function collectThemeImageUrls(theme: ThemeDefinition): string[] {
  const urls = new Set<string>([
    theme.catalog.previewImage,
    ...theme.catalog.screenshots.map((screenshot) => screenshot.src),
  ]);
  for (const product of theme.preset.sampleData?.products ?? []) {
    urls.add(product.image_url);
    for (const url of product.images ?? []) urls.add(url);
    for (const variant of product.variants ?? []) {
      for (const url of variant.images ?? []) urls.add(url);
    }
  }
  for (const category of theme.preset.sampleData?.categories ?? []) {
    if (category.image_url) urls.add(category.image_url);
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "image_url" && typeof nested === "string" && nested)
        urls.add(nested);
      else visit(nested);
    }
  };
  for (const page of theme.preset.pages) visit(page.sections);
  return [...urls].sort();
}

export function themeDefinitionToPackageV2(
  theme: ThemeDefinition,
): ThemePackageV2 {
  const assets = collectThemeImageUrls(theme).map((path, index) => ({
    id: `legacy-${String(index + 1).padStart(2, "0")}`,
    path,
    kind: (path === theme.catalog.previewImage ? "preview" : "content") as
      | "preview"
      | "content",
    source: "legacy-bundled" as const,
    sha256: null,
    width: null,
    height: null,
    alt:
      theme.catalog.screenshots.find((screenshot) => screenshot.src === path)
        ?.alt ?? `${theme.name} theme asset`,
  }));
  return {
    schemaVersion: THEME_PACKAGE_SCHEMA_VERSION,
    definition: theme,
    renderer: {
      minVersion: theme.engine.version,
      viewports: THEME_STUDIO_VIEWPORTS,
    },
    declaredCapabilities: {
      features: [...theme.catalog.features],
      surfaces: [...SURFACES],
    },
    assets,
    provenance: {
      origin: "bundled",
      modelKey: null,
      promptVersion: null,
      referenceDigests: [],
    },
    capabilityGaps: [],
  };
}

export function themePackageV2ToDefinition(
  pkg: ThemePackageV2,
): ThemeDefinition {
  return pkg.definition;
}

export function canAdvanceThemePackageToCandidate(
  pkg: ThemePackageV2,
): boolean {
  return !pkg.capabilityGaps.some((gap) => gap.blocking);
}

function validateThemeDefinition(
  value: unknown,
  issues: string[],
): value is ThemeDefinition {
  if (!isRecord(value)) {
    issues.push("definition must be an object.");
    return false;
  }
  rejectUnknownKeys(
    value,
    [
      "id",
      "name",
      "description",
      "engine",
      "release",
      "catalog",
      "demo",
      "preset",
    ],
    "definition",
    issues,
  );
  const id = requiredString(value.id, "definition.id", issues, 80);
  if (id && !ID_RE.test(id)) issues.push("definition.id must be kebab-case.");
  const name = requiredString(value.name, "definition.name", issues, 100);
  requiredString(value.description, "definition.description", issues, 1_000);

  const engine = isRecord(value.engine) ? value.engine : {};
  if (!isRecord(value.engine))
    issues.push("definition.engine must be an object.");
  rejectUnknownKeys(engine, ["id", "version"], "definition.engine", issues);
  if (
    !ID_RE.test(requiredString(engine.id, "definition.engine.id", issues, 80))
  ) {
    issues.push("definition.engine.id must be kebab-case.");
  }
  if (!Number.isInteger(engine.version) || Number(engine.version) < 1) {
    issues.push("definition.engine.version must be a positive integer.");
  }

  const release = isRecord(value.release) ? value.release : {};
  if (!isRecord(value.release))
    issues.push("definition.release must be an object.");
  rejectUnknownKeys(
    release,
    ["version", "status", "releasedAt", "notes"],
    "definition.release",
    issues,
  );
  const version = requiredString(
    release.version,
    "definition.release.version",
    issues,
    30,
  );
  if (version && !SEMVER_RE.test(version))
    issues.push("definition.release.version must be semver.");
  enumValue(
    release.status,
    ["draft", "candidate", "approved", "published", "blocked"] as const,
    "definition.release.status",
    issues,
  );
  stringList(release.notes, "definition.release.notes", issues, {
    min: 1,
    max: 20,
    itemMax: 500,
  });

  const catalog = isRecord(value.catalog) ? value.catalog : {};
  if (!isRecord(value.catalog))
    issues.push("definition.catalog must be an object.");
  rejectUnknownKeys(
    catalog,
    [
      "visibility",
      "industries",
      "catalogSizes",
      "features",
      "keywords",
      "minPlan",
      "previewImage",
      "screenshots",
    ],
    "definition.catalog",
    issues,
  );
  enumValue(
    catalog.visibility,
    ["hidden", "legacy", "public"] as const,
    "definition.catalog.visibility",
    issues,
  );
  for (const [label, raw, allowed] of [
    ["industries", catalog.industries, INDUSTRIES],
    ["catalogSizes", catalog.catalogSizes, CATALOG_SIZES],
    ["features", catalog.features, FEATURES],
  ] as const) {
    if (!Array.isArray(raw) || raw.length === 0) {
      issues.push(`definition.catalog.${label} must be a non-empty array.`);
    } else {
      raw.forEach((entry, index) => {
        if (!allowed.includes(entry as never)) {
          issues.push(`definition.catalog.${label}[${index}] is unsupported.`);
        }
      });
    }
  }
  stringList(catalog.keywords, "definition.catalog.keywords", issues, {
    min: 1,
    max: 30,
    itemMax: 80,
  });
  requiredString(
    catalog.previewImage,
    "definition.catalog.previewImage",
    issues,
    500,
  );
  if (!Array.isArray(catalog.screenshots) || catalog.screenshots.length === 0) {
    issues.push("definition.catalog.screenshots must be a non-empty array.");
  }

  const demo = isRecord(value.demo) ? value.demo : {};
  if (!isRecord(value.demo)) issues.push("definition.demo must be an object.");
  rejectUnknownKeys(
    demo,
    ["slug", "status", "checkedAt", "unavailableReason"],
    "definition.demo",
    issues,
  );
  const demoSlug = requiredString(
    demo.slug,
    "definition.demo.slug",
    issues,
    100,
  );
  if (id && demoSlug !== `demo-${id}`)
    issues.push(`definition.demo.slug must be demo-${id}.`);
  enumValue(
    demo.status,
    ["healthy", "unavailable", "provisioning"] as const,
    "definition.demo.status",
    issues,
  );

  const preset = isRecord(value.preset) ? value.preset : {};
  if (!isRecord(value.preset))
    issues.push("definition.preset must be an object.");
  rejectUnknownKeys(
    preset,
    ["brand", "design", "pages", "menus", "sampleData"],
    "definition.preset",
    issues,
  );
  const brand = isRecord(preset.brand) ? preset.brand : {};
  if (!isRecord(preset.brand))
    issues.push("definition.preset.brand must be an object.");
  rejectUnknownKeys(
    brand,
    ["primaryColor", "tagline", "blurb"],
    "definition.preset.brand",
    issues,
  );
  if (
    !HEX_RE.test(
      requiredString(
        brand.primaryColor,
        "definition.preset.brand.primaryColor",
        issues,
        20,
      ),
    )
  ) {
    issues.push("definition.preset.brand.primaryColor must be a hex colour.");
  }

  validateDefinitionDesign(preset.design, issues);
  validateDefinitionPages(preset.pages, issues);

  const normalizedMenus = sanitizeMenusForSave(preset.menus);
  if (JSON.stringify(normalizedMenus) !== JSON.stringify(preset.menus)) {
    issues.push(
      "definition.preset.menus contains invalid, truncated, or unsupported values.",
    );
  }
  validateSampleData(preset.sampleData, issues);

  return Boolean(id && name) && issues.length === 0;
}

function validateDefinitionDesign(value: unknown, issues: string[]): void {
  if (!isRecord(value)) {
    issues.push("definition.preset.design must be an object.");
    return;
  }
  rejectUnknownKeys(
    value,
    ["palette", "fonts", "shape", "layout"],
    "definition.preset.design",
    issues,
  );
  const palette = isRecord(value.palette) ? value.palette : {};
  const paletteKeys = [
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
  ];
  rejectUnknownKeys(
    palette,
    [...paletteKeys, "shadowRgb", "accent", "accentDeep"],
    "definition.preset.design.palette",
    issues,
  );
  for (const key of paletteKeys) {
    if (!HEX_RE.test(String(palette[key] ?? ""))) {
      issues.push(
        `definition.preset.design.palette.${key} must be a hex colour.`,
      );
    }
  }
  if (!RGB_TRIPLE_RE.test(String(palette.shadowRgb ?? ""))) {
    issues.push(
      "definition.preset.design.palette.shadowRgb must be an RGB triple.",
    );
  }
  for (const key of ["accent", "accentDeep"] as const) {
    if (palette[key] !== undefined && !HEX_RE.test(String(palette[key]))) {
      issues.push(
        `definition.preset.design.palette.${key} must be a hex colour.`,
      );
    }
  }
  const fonts = isRecord(value.fonts) ? value.fonts : {};
  rejectUnknownKeys(
    fonts,
    ["body", "display"],
    "definition.preset.design.fonts",
    issues,
  );
  for (const key of ["body", "display"] as const) {
    if (!FONT_RE.test(String(fonts[key] ?? ""))) {
      issues.push(
        `definition.preset.design.fonts.${key} must reference a loaded font variable.`,
      );
    }
  }
  const shape = isRecord(value.shape) ? value.shape : {};
  rejectUnknownKeys(
    shape,
    ["card", "control", "sm", "pill"],
    "definition.preset.design.shape",
    issues,
  );
  for (const key of ["card", "control", "sm", "pill"] as const) {
    if (!CSS_LENGTH_RE.test(String(shape[key] ?? ""))) {
      issues.push(
        `definition.preset.design.shape.${key} must be a CSS length.`,
      );
    }
  }
  if (value.layout !== undefined && !isRecord(value.layout)) {
    issues.push(
      "definition.preset.design.layout must be an object when supplied.",
    );
  } else if (isRecord(value.layout)) {
    rejectUnknownKeys(
      value.layout,
      [
        "header",
        "headerBackground",
        "headerForeground",
        "card",
        "cardHoverImage",
        "productDetail",
        "cart",
        "footer",
        "storefront",
      ],
      "definition.preset.design.layout",
      issues,
    );
    const layoutEnums = [
      ["header", ["classic", "market", "centered", "minimal"]],
      ["card", ["classic", "quick_add", "overlay", "framed", "grocery"]],
      ["productDetail", ["classic", "grocery", "editorial"]],
      ["cart", ["classic", "grocery", "compact"]],
      ["footer", ["rich", "minimal", "editorial"]],
      ["storefront", ["classic", "grocery"]],
    ] as const;
    for (const [key, allowed] of layoutEnums) {
      if (
        value.layout[key] !== undefined &&
        !allowed.includes(value.layout[key] as never)
      ) {
        issues.push(`definition.preset.design.layout.${key} is unsupported.`);
      }
    }
    for (const key of ["headerBackground", "headerForeground"] as const) {
      if (
        value.layout[key] !== undefined &&
        !HEX_RE.test(String(value.layout[key]))
      ) {
        issues.push(
          `definition.preset.design.layout.${key} must be a hex colour.`,
        );
      }
    }
    if (
      value.layout.cardHoverImage !== undefined &&
      typeof value.layout.cardHoverImage !== "boolean"
    ) {
      issues.push(
        "definition.preset.design.layout.cardHoverImage must be a boolean.",
      );
    }
  }
}

function validateDefinitionPages(value: unknown, issues: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push("definition.preset.pages must be a non-empty array.");
    return;
  }
  if (value.length > THEME_STUDIO_LIMITS.pages) {
    issues.push(
      `definition.preset.pages allows at most ${THEME_STUDIO_LIMITS.pages} pages.`,
    );
  }
  const slugs = new Set<string>();
  let homepages = 0;
  for (const [index, raw] of value
    .slice(0, THEME_STUDIO_LIMITS.pages)
    .entries()) {
    if (!isRecord(raw)) {
      issues.push(`definition.preset.pages[${index}] must be an object.`);
      continue;
    }
    rejectUnknownKeys(
      raw,
      ["slug", "title", "seo_title", "seo_description", "sections"],
      `definition.preset.pages[${index}]`,
      issues,
    );
    const slug = typeof raw.slug === "string" ? raw.slug : "";
    if (slug === "") homepages += 1;
    else if ("error" in validatePageSlug(slug)) {
      issues.push(`definition.preset.pages[${index}].slug is invalid.`);
    }
    if (slugs.has(slug))
      issues.push(
        `definition.preset.pages repeats slug ${JSON.stringify(slug)}.`,
      );
    slugs.add(slug);
    requiredString(
      raw.title,
      `definition.preset.pages[${index}].title`,
      issues,
      160,
    );
    const validated = validateSections(raw.sections, { mode: "publish" });
    if ("error" in validated) {
      issues.push(`definition.preset.pages[${index}]: ${validated.error}`);
    }
    if (
      Array.isArray(raw.sections) &&
      raw.sections.some(
        (section) => isRecord(section) && section.type === "custom_code",
      )
    ) {
      issues.push(
        `definition.preset.pages[${index}] uses prohibited custom_code.`,
      );
    }
  }
  if (homepages !== 1)
    issues.push("definition.preset.pages must contain exactly one homepage.");
}

function validateSampleData(value: unknown, issues: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push(
      "definition.preset.sampleData must be an object when supplied.",
    );
    return;
  }
  if (!Array.isArray(value.categories) || !Array.isArray(value.products)) {
    issues.push(
      "definition.preset.sampleData needs categories and products arrays.",
    );
    return;
  }
  const categorySlugs = new Set<string>();
  for (const [index, raw] of value.categories.entries()) {
    if (!isRecord(raw)) {
      issues.push(
        `definition.preset.sampleData.categories[${index}] must be an object.`,
      );
      continue;
    }
    requiredString(
      raw.name,
      `definition.preset.sampleData.categories[${index}].name`,
      issues,
      120,
    );
    const slug = requiredString(
      raw.slug,
      `definition.preset.sampleData.categories[${index}].slug`,
      issues,
      80,
    );
    if (!ID_RE.test(slug))
      issues.push(
        `definition.preset.sampleData.categories[${index}].slug is invalid.`,
      );
    if (categorySlugs.has(slug))
      issues.push(`definition.preset.sampleData repeats category ${slug}.`);
    categorySlugs.add(slug);
  }
  for (const [index, raw] of value.products.entries()) {
    if (!isRecord(raw)) {
      issues.push(
        `definition.preset.sampleData.products[${index}] must be an object.`,
      );
      continue;
    }
    requiredString(
      raw.name,
      `definition.preset.sampleData.products[${index}].name`,
      issues,
      160,
    );
    requiredString(
      raw.slug,
      `definition.preset.sampleData.products[${index}].slug`,
      issues,
      100,
    );
    requiredString(
      raw.image_url,
      `definition.preset.sampleData.products[${index}].image_url`,
      issues,
      500,
    );
    if (!categorySlugs.has(String(raw.category_slug ?? ""))) {
      issues.push(
        `definition.preset.sampleData.products[${index}] references an unknown category.`,
      );
    }
    if (!(Number(raw.base_price) > 0) || !(Number(raw.selling_price) > 0)) {
      issues.push(
        `definition.preset.sampleData.products[${index}] needs positive prices.`,
      );
    }
  }
}

export function validateThemePackageV2(
  input: unknown,
): ThemeContractResult<ThemePackageV2> {
  const issues: string[] = [];
  let size = 0;
  try {
    size = JSON.stringify(input).length;
  } catch {
    return { ok: false, issues: ["Theme package must be JSON serializable."] };
  }
  if (size > THEME_STUDIO_LIMITS.packageChars) {
    issues.push(
      `Theme package exceeds ${THEME_STUDIO_LIMITS.packageChars} characters.`,
    );
  }
  if (!isRecord(input))
    return { ok: false, issues: ["Theme package must be an object."] };
  rejectUnknownKeys(
    input,
    [
      "schemaVersion",
      "definition",
      "renderer",
      "declaredCapabilities",
      "assets",
      "provenance",
      "capabilityGaps",
    ],
    "Theme package",
    issues,
  );
  if (input.schemaVersion !== THEME_PACKAGE_SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${THEME_PACKAGE_SCHEMA_VERSION}.`);
  }
  const definitionIssues: string[] = [];
  const validDefinition = validateThemeDefinition(
    input.definition,
    definitionIssues,
  );
  issues.push(...definitionIssues);

  const renderer = isRecord(input.renderer) ? input.renderer : {};
  if (!isRecord(input.renderer)) issues.push("renderer must be an object.");
  if (
    !Number.isInteger(renderer.minVersion) ||
    Number(renderer.minVersion) < 1
  ) {
    issues.push("renderer.minVersion must be a positive integer.");
  }
  if (
    JSON.stringify(renderer.viewports) !==
    JSON.stringify(THEME_STUDIO_VIEWPORTS)
  ) {
    issues.push(
      "renderer.viewports must use the StoreMink acceptance viewports.",
    );
  }

  const capabilities = isRecord(input.declaredCapabilities)
    ? input.declaredCapabilities
    : {};
  if (!isRecord(input.declaredCapabilities)) {
    issues.push("declaredCapabilities must be an object.");
  }
  if (!Array.isArray(capabilities.features)) {
    issues.push("declaredCapabilities.features must be an array.");
  } else {
    capabilities.features.forEach((feature, index) => {
      if (!FEATURES.includes(feature as ThemeFeature)) {
        issues.push(`declaredCapabilities.features[${index}] is unsupported.`);
      }
    });
  }
  if (!Array.isArray(capabilities.surfaces)) {
    issues.push("declaredCapabilities.surfaces must be an array.");
  } else {
    capabilities.surfaces.forEach((surface, index) => {
      if (!SURFACES.includes(surface as ThemeStudioSurface)) {
        issues.push(`declaredCapabilities.surfaces[${index}] is unsupported.`);
      }
    });
  }

  const assets = parsePackageAssets(input.assets, issues);
  const referenced = validDefinition
    ? collectThemeImageUrls(input.definition as unknown as ThemeDefinition)
    : [];
  const assetPaths = new Set(assets.map((asset) => asset.path));
  for (const path of referenced) {
    if (!assetPaths.has(path))
      issues.push(`Theme asset is referenced but not declared: ${path}.`);
  }
  const definitionId = isRecord(input.definition)
    ? String(input.definition.id ?? "")
    : "";
  for (const [index, asset] of assets.entries()) {
    if (
      asset.path.startsWith("/themes/") &&
      definitionId &&
      !asset.path.startsWith(`/themes/${definitionId}/`)
    ) {
      issues.push(
        `assets[${index}].path must stay under /themes/${definitionId}/.`,
      );
    }
  }

  const provenance = isRecord(input.provenance) ? input.provenance : {};
  if (!isRecord(input.provenance)) issues.push("provenance must be an object.");
  const origin = enumValue(
    provenance.origin,
    ["generated", "bundled"] as const,
    "provenance.origin",
    issues,
  );
  const modelKey =
    provenance.modelKey === null
      ? null
      : parseThemeStudioModelKey(provenance.modelKey);
  if (provenance.modelKey !== null && !modelKey)
    issues.push("provenance.modelKey is not allowlisted.");
  const promptVersion =
    provenance.promptVersion === null
      ? null
      : requiredString(
          provenance.promptVersion,
          "provenance.promptVersion",
          issues,
          80,
        );
  const referenceDigests = stringList(
    provenance.referenceDigests,
    "provenance.referenceDigests",
    issues,
    { max: THEME_STUDIO_LIMITS.referenceImages, itemMax: 64 },
  );
  referenceDigests.forEach((digest, index) => {
    if (!SHA256_RE.test(digest))
      issues.push(`provenance.referenceDigests[${index}] must be SHA-256.`);
  });
  if (origin === "generated" && (!modelKey || !promptVersion)) {
    issues.push(
      "Generated packages require an allowlisted modelKey and promptVersion.",
    );
  }
  if (origin === "generated") {
    assets.forEach((asset, index) => {
      if (!asset.sha256)
        issues.push(
          `assets[${index}].sha256 is required for generated packages.`,
        );
      if (asset.source === "legacy-bundled") {
        issues.push(
          `assets[${index}] cannot be legacy-bundled in a generated package.`,
        );
      }
    });
  }
  const capabilityGaps = parseCapabilityGaps(
    input.capabilityGaps,
    "capabilityGaps",
    issues,
  );

  if (issues.length > 0 || !origin || !validDefinition) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      schemaVersion: THEME_PACKAGE_SCHEMA_VERSION,
      definition: input.definition as unknown as ThemeDefinition,
      renderer: {
        minVersion: Number(renderer.minVersion),
        viewports: THEME_STUDIO_VIEWPORTS,
      },
      declaredCapabilities: {
        features: capabilities.features as ThemeFeature[],
        surfaces: capabilities.surfaces as ThemeStudioSurface[],
      },
      assets,
      provenance: {
        origin,
        modelKey,
        promptVersion,
        referenceDigests,
      },
      capabilityGaps,
    },
  };
}

function parsePackageAssets(
  value: unknown,
  issues: string[],
): ThemePackageAsset[] {
  if (!Array.isArray(value)) {
    issues.push("assets must be an array.");
    return [];
  }
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  return value.flatMap((raw, index) => {
    if (!isRecord(raw)) {
      issues.push(`assets[${index}] must be an object.`);
      return [];
    }
    rejectUnknownKeys(
      raw,
      [
        "id",
        "path",
        "kind",
        "source",
        "sha256",
        "width",
        "height",
        "alt",
        "licenseNote",
      ],
      `assets[${index}]`,
      issues,
    );
    const id = requiredString(raw.id, `assets[${index}].id`, issues, 80);
    if (!ASSET_ID_RE.test(id))
      issues.push(`assets[${index}].id must be kebab-case.`);
    const path = requiredString(raw.path, `assets[${index}].path`, issues, 500);
    if (!path.startsWith("/themes/") && !path.startsWith("theme-asset://")) {
      issues.push(
        `assets[${index}].path must be a theme path or theme-asset reference.`,
      );
    }
    if (seenIds.has(id))
      issues.push(`assets repeats id ${JSON.stringify(id)}.`);
    if (seenPaths.has(path))
      issues.push(`assets repeats path ${JSON.stringify(path)}.`);
    seenIds.add(id);
    seenPaths.add(path);
    const kind = enumValue(
      raw.kind,
      [
        "reference",
        "hero",
        "product",
        "category",
        "content",
        "preview",
      ] as const,
      `assets[${index}].kind`,
      issues,
    );
    const source = enumValue(
      raw.source,
      ["generated", "operator-owned", "licensed", "legacy-bundled"] as const,
      `assets[${index}].source`,
      issues,
    );
    const sha256 =
      raw.sha256 === null
        ? null
        : requiredString(raw.sha256, `assets[${index}].sha256`, issues, 64);
    if (sha256 && !SHA256_RE.test(sha256))
      issues.push(`assets[${index}].sha256 must be SHA-256.`);
    const width = raw.width === null ? null : Number(raw.width);
    const height = raw.height === null ? null : Number(raw.height);
    if (width !== null && (!Number.isInteger(width) || width < 1)) {
      issues.push(`assets[${index}].width must be a positive integer or null.`);
    }
    if (height !== null && (!Number.isInteger(height) || height < 1)) {
      issues.push(
        `assets[${index}].height must be a positive integer or null.`,
      );
    }
    const alt = requiredString(raw.alt, `assets[${index}].alt`, issues, 240);
    if (!id || !path || !kind || !source || !alt) return [];
    return [
      {
        id,
        path,
        kind,
        source,
        sha256,
        width,
        height,
        alt,
        ...(typeof raw.licenseNote === "string" && raw.licenseNote.trim()
          ? { licenseNote: raw.licenseNote.trim().slice(0, 500) }
          : {}),
      },
    ];
  });
}

// Minimal provider-facing schema for Stage A. The handwritten validator above
// remains authoritative because it can express cross-field and registry rules
// JSON Schema cannot (unique surfaces, known section types, bounded gaps).
export const THEME_INTENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ROOT_INTENT_KEYS,
  properties: {
    schemaVersion: { type: "integer", const: THEME_INTENT_SCHEMA_VERSION },
    summary: { type: "string", maxLength: 1_000 },
    audiences: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string" },
    },
    industries: {
      type: "array",
      minItems: 1,
      items: { type: "string", enum: INDUSTRIES },
    },
    commercialGoals: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: { type: "string" },
    },
    visual: { type: "object" },
    pagePlans: { type: "array", minItems: 1, maxItems: SURFACES.length },
    responsive: { type: "object" },
    assetBriefs: { type: "array", maxItems: THEME_STUDIO_LIMITS.assetBriefs },
    assumptions: { type: "array", maxItems: THEME_STUDIO_LIMITS.assumptions },
    capabilityGaps: {
      type: "array",
      maxItems: THEME_STUDIO_LIMITS.capabilityGaps,
    },
  },
} as const;

export const THEME_PACKAGE_V2_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "definition",
    "renderer",
    "declaredCapabilities",
    "assets",
    "provenance",
    "capabilityGaps",
  ],
  properties: {
    schemaVersion: { type: "integer", const: THEME_PACKAGE_SCHEMA_VERSION },
    definition: { type: "object" },
    renderer: { type: "object" },
    declaredCapabilities: { type: "object" },
    assets: { type: "array" },
    provenance: { type: "object" },
    capabilityGaps: {
      type: "array",
      maxItems: THEME_STUDIO_LIMITS.capabilityGaps,
    },
  },
} as const;

export function sectionsInThemePackage(pkg: ThemePackageV2): PageSectionItem[] {
  return pkg.definition.preset.pages.flatMap((page) => page.sections);
}
