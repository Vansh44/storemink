import { sanitizeMenusForSave } from "@/lib/menus";
import type { PageSectionItem } from "@/lib/sections/registry";
import type {
  ThemeCatalogSize,
  ThemeEngineRef,
  ThemeFeature,
  ThemeIndustry,
} from "@/lib/themes/meta";
import type {
  ThemeCategorySeed,
  ThemeDefinition,
  ThemeDesign,
  ThemePageSeed,
  ThemeProductSeed,
} from "@/lib/themes/types";
import {
  THEME_PACKAGE_SCHEMA_VERSION,
  THEME_STUDIO_FEATURES,
  THEME_STUDIO_VIEWPORTS,
  validateThemePackageV2,
  type ThemeCapabilityGap,
  type ThemeIntent,
  type ThemePackageAsset,
  type ThemePackageV2,
  type ThemeStudioSurface,
} from "./contracts";
import type { ThemeStudioModelKey } from "./models";
import { PALETTE_KEYS, THEME_STUDIO_SECTION_TYPES } from "./schemas";
import { resolveOptionRows, type ProductOption } from "@/lib/products/options";

// ---------------------------------------------------------------------------
// Stage B compiler: model draft → ThemePackageV2.
//
// The model authors the CREATIVE parts (tokens, pages, copy, catalogue). The
// server owns everything that is a fact about StoreMink rather than a design
// choice — id, engine, release, catalog visibility, demo, renderer, viewports,
// provenance and the asset manifest — so the model cannot assert any of them.
//
// Every problem found here is returned as a sentence rather than thrown: the
// pipeline hands the list back to the model once per repair attempt, and a
// sentence the model can act on is the whole value of that loop.
// ---------------------------------------------------------------------------

export const THEME_ASSET_PREFIX = "theme-asset://";

/** Marks every placeholder in a package; publication must refuse any package
 * still carrying one. */
export const PLACEHOLDER_LICENSE_NOTE =
  "StoreMink placeholder. Replace with operator-owned, licensed or generated imagery before publication.";

/** Slots the server always provides, independent of the intent's briefs. */
export const SYSTEM_SLOTS = {
  preview: { aspectRatio: "4:3", alt: "Theme preview" },
  "screenshot-desktop": { aspectRatio: "16:10", alt: "Storefront on desktop" },
  "screenshot-mobile": { aspectRatio: "9:19", alt: "Storefront on mobile" },
} as const;

export interface CompileFacts {
  themeId: string;
  name: string;
  industries: ThemeIndustry[];
  catalogSizes: ThemeCatalogSize[];
  requiredFeatures: ThemeFeature[];
  baseEngine: ThemeEngineRef | null;
  versionNumber: number;
  modelKey: ThemeStudioModelKey;
  modelLabel: string;
  promptVersion: string;
  referenceDigests: string[];
}

export interface SlotAsset {
  sha256: string;
  width: number;
  height: number;
}

export interface CompileResult {
  package: ThemePackageV2 | null;
  /** Slots the package references, each needing a stored placeholder. */
  slots: string[];
  issues: string[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slotOf(url: string): string | null {
  return url.startsWith(THEME_ASSET_PREFIX)
    ? url.slice(THEME_ASSET_PREFIX.length)
    : null;
}

/** Walk a section config: media must be a known slot, links must be site paths. */
function checkConfigUrls(
  value: unknown,
  where: string,
  known: Set<string>,
  used: Set<string>,
  issues: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      checkConfigUrls(item, `${where}[${i}]`, known, used, issues),
    );
    return;
  }
  if (!isRec(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const at = `${where}.${key}`;
    if (typeof nested === "string" && nested !== "") {
      if (key === "video_url") {
        issues.push(
          `${at} must be "": video is not supported in generated themes.`,
        );
      } else if (key.endsWith("_url")) {
        const slot = slotOf(nested);
        if (!slot)
          issues.push(
            `${at} must be "" or a theme-asset:// slot, not an external URL.`,
          );
        else if (!known.has(slot))
          issues.push(`${at} uses unknown image slot "${slot}".`);
        else used.add(slot);
      } else if (
        key.endsWith("_href") &&
        (!nested.startsWith("/") || nested.startsWith("//"))
      ) {
        issues.push(`${at} must be "" or a site path starting with "/".`);
      }
    } else {
      checkConfigUrls(nested, at, known, used, issues);
    }
  }
}

function checkLink(href: string, where: string, issues: string[]) {
  if (!href.startsWith("/") || href.startsWith("//")) {
    issues.push(`${where} must be a site path starting with "/".`);
  }
}

function normalizeGaps(value: unknown): ThemeCapabilityGap[] {
  return list(value).flatMap((raw) => {
    if (!isRec(raw)) return [];
    const { suggestedPlatformCapability, ...rest } = raw;
    return [
      {
        ...(rest as unknown as ThemeCapabilityGap),
        ...(typeof suggestedPlatformCapability === "string" &&
        suggestedPlatformCapability.trim()
          ? { suggestedPlatformCapability }
          : {}),
      },
    ];
  });
}

function buildDesign(raw: unknown, issues: string[]): ThemeDesign | null {
  if (
    !isRec(raw) ||
    !isRec(raw.palette) ||
    !isRec(raw.fonts) ||
    !isRec(raw.shape)
  ) {
    issues.push("design must include palette, fonts and shape.");
    return null;
  }
  const paletteIn = raw.palette;
  const palette: Rec = {};
  for (const key of PALETTE_KEYS) palette[key] = paletteIn[key];
  palette.shadowRgb = paletteIn.shadowRgb;
  for (const key of ["accent", "accentDeep"] as const) {
    if (typeof paletteIn[key] === "string") palette[key] = paletteIn[key];
  }
  const layout: Rec = {};
  if (isRec(raw.layout)) {
    for (const [key, value] of Object.entries(raw.layout)) {
      if (value !== null && value !== undefined) layout[key] = value;
    }
  }
  return {
    palette: palette as unknown as ThemeDesign["palette"],
    fonts: { body: text(raw.fonts.body), display: text(raw.fonts.display) },
    shape: {
      card: text(raw.shape.card),
      control: text(raw.shape.control),
      sm: text(raw.shape.sm),
      pill: text(raw.shape.pill),
    },
    ...(Object.keys(layout).length > 0
      ? { layout: layout as ThemeDesign["layout"] }
      : {}),
  };
}

function buildPages(
  raw: unknown,
  known: Set<string>,
  used: Set<string>,
  issues: string[],
): ThemePageSeed[] {
  const allowed = new Set<string>(THEME_STUDIO_SECTION_TYPES);
  return list(raw).flatMap((page, pageIndex) => {
    if (!isRec(page)) {
      issues.push(`pages[${pageIndex}] must be an object.`);
      return [];
    }
    const slug = typeof page.slug === "string" ? page.slug.trim() : "";
    const key = slug || "home";
    const sections: PageSectionItem[] = list(page.sections).flatMap(
      (section, i) => {
        const where = `pages[${pageIndex}].sections[${i}]`;
        if (!isRec(section) || !allowed.has(String(section.type))) {
          issues.push(`${where} has an unsupported section type.`);
          return [];
        }
        let config: unknown;
        try {
          config = JSON.parse(String(section.configJson ?? ""));
        } catch {
          issues.push(`${where}.configJson is not valid JSON.`);
          return [];
        }
        if (!isRec(config)) {
          issues.push(`${where}.configJson must encode a JSON object.`);
          return [];
        }
        checkConfigUrls(config, `${where}.config`, known, used, issues);
        if (
          section.type === "featured_products" &&
          config.source !== "featured"
        ) {
          issues.push(
            `${where}: featured_products must use source "featured".`,
          );
        }
        if (section.type === "shop_by_category" && config.source !== "all") {
          issues.push(`${where}: shop_by_category must use source "all".`);
        }
        return [
          {
            id: `${key}-${String(section.type).replace(/_/g, "-")}-${i + 1}`,
            type: section.type as PageSectionItem["type"],
            enabled: true,
            config: config as unknown as PageSectionItem["config"],
          },
        ];
      },
    );
    const seoTitle = text(page.seoTitle);
    const seoDescription = text(page.seoDescription);
    return [
      {
        slug,
        title: text(page.title),
        ...(seoTitle ? { seo_title: seoTitle } : {}),
        ...(seoDescription ? { seo_description: seoDescription } : {}),
        sections,
      },
    ];
  });
}

/** Shortest SEO description the production validator accepts (TA-2.3). */
const SEO_DESCRIPTION_MIN = 20;
const SEO_DESCRIPTION_MAX = 160;

/**
 * Give every page a usable SEO description. The draft schema lets a model
 * leave one null, and the production validator requires 20+ characters on
 * every page, so without this a generated theme could pass acceptance and
 * then be refused at publication for a sentence it was never asked for. The
 * fallback is drawn only from text the draft already contains — the page
 * title and the theme's own description — never invented copy.
 */
function withSeoDescriptions(
  pages: ThemePageSeed[],
  themeDescription: string,
  themeName: string,
): ThemePageSeed[] {
  return pages.map((page) => {
    if ((page.seo_description?.trim().length ?? 0) >= SEO_DESCRIPTION_MIN) {
      return page;
    }
    const lead = page.slug === "" ? themeName : `${page.title} · ${themeName}`;
    const body = themeDescription || `${themeName} storefront`;
    let description = `${lead} — ${body}`.replace(/\s+/g, " ").trim();
    if (description.length > SEO_DESCRIPTION_MAX) {
      description = `${description.slice(0, SEO_DESCRIPTION_MAX - 1).trimEnd()}…`;
    }
    return description.length >= SEO_DESCRIPTION_MIN
      ? { ...page, seo_description: description }
      : page;
  });
}

function buildCatalogue(
  draft: Rec,
  known: Set<string>,
  used: Set<string>,
  issues: string[],
): { categories: ThemeCategorySeed[]; products: ThemeProductSeed[] } {
  const slotUrl = (slot: unknown, where: string): string | null => {
    const id = text(slot);
    if (!id) return null;
    if (!known.has(id)) {
      issues.push(`${where} uses unknown image slot "${id}".`);
      return null;
    }
    used.add(id);
    return `${THEME_ASSET_PREFIX}${id}`;
  };
  const categories = list(draft.categories).flatMap((raw, i) => {
    if (!isRec(raw)) return [];
    const image = slotUrl(raw.imageSlot, `categories[${i}].imageSlot`);
    const description = text(raw.description);
    return [
      {
        name: text(raw.name),
        slug: text(raw.slug),
        ...(description ? { description } : {}),
        ...(image ? { image_url: image } : {}),
        sort_order: i,
      },
    ];
  });
  const products = list(draft.products).flatMap((raw, i) => {
    if (!isRec(raw)) return [];
    const where = `products[${i}]`;
    const slug = text(raw.slug);
    if (!KEBAB_RE.test(slug)) issues.push(`${where}.slug must be kebab-case.`);
    const base = Number(raw.basePrice);
    const selling = Number(raw.sellingPrice);
    if (selling > base)
      issues.push(`${where}.sellingPrice must not exceed basePrice.`);
    const image = slotUrl(raw.imageSlot, `${where}.imageSlot`);
    if (!image)
      issues.push(`${where} needs an imageSlot from the asset briefs.`);
    const variants = list(raw.variants).flatMap((v, j) => {
      if (!isRec(v)) return [];
      const stock = Number(v.stock);
      if (!Number.isInteger(stock) || stock < 1) {
        issues.push(
          `${where}.variants[${j}].stock must be a positive integer.`,
        );
      }
      const optionValues = list(v.optionValues).map(text);
      return [
        {
          name: text(v.name),
          base_price: Number(v.basePrice),
          selling_price: Number(v.sellingPrice),
          stock,
          sort_order: j,
          ...(optionValues.length > 0 ? { option_values: optionValues } : {}),
        },
      ];
    });
    // Swatches arrive as a list of { value, hex } (the schema subset has no
    // map type) and are stored as the editor stores them, a value → hex map.
    const rawOptions = list(raw.options).flatMap((o) => {
      if (!isRec(o)) return [];
      const swatchList = list(o.swatches).filter(isRec);
      return [
        {
          name: text(o.name),
          values: list(o.values).map(text),
          ...(swatchList.length > 0
            ? {
                swatches: Object.fromEntries(
                  swatchList.map((sw) => [text(sw.value), text(sw.hex)]),
                ),
              }
            : {}),
        },
      ];
    });
    let options: ProductOption[] = [];
    let optionVariants = variants;
    if (rawOptions.length > 0) {
      const rows = resolveOptionRows(rawOptions, variants);
      if ("error" in rows) issues.push(`${where}.options: ${rows.error}`);
      else {
        options = rows.options;
        optionVariants = rows.variants;
      }
    }
    return [
      {
        name: text(raw.name),
        slug,
        description: text(raw.description),
        category_slug: text(raw.categorySlug),
        base_price: base,
        selling_price: selling,
        image_url: image ?? "",
        featured: raw.featured === true,
        sort_order: i,
        ...(options.length > 0 ? { options } : {}),
        ...(optionVariants.length > 0 ? { variants: optionVariants } : {}),
      },
    ];
  });
  if (categories.length === 0 || products.length === 0) {
    issues.push(
      "The sample catalogue needs at least one category and one product.",
    );
  }
  return { categories, products };
}

function assetKind(
  slot: string,
  intent: ThemeIntent,
): ThemePackageAsset["kind"] {
  if (slot === "preview" || slot.startsWith("screenshot-")) return "preview";
  const brief = intent.assetBriefs.find((b) => b.id === slot);
  const purpose = `${brief?.purpose ?? ""} ${slot}`.toLowerCase();
  if (/hero|banner/.test(purpose)) return "hero";
  if (/product/.test(purpose)) return "product";
  if (/categor|collection/.test(purpose)) return "category";
  return "content";
}

/** Aspect ratio and alt text for a slot's placeholder. */
export function slotSpec(
  slot: string,
  intent: ThemeIntent,
): { aspectRatio: string; alt: string } {
  if (slot in SYSTEM_SLOTS)
    return SYSTEM_SLOTS[slot as keyof typeof SYSTEM_SLOTS];
  const brief = intent.assetBriefs.find((b) => b.id === slot);
  return {
    aspectRatio: brief?.aspectRatio ?? "4:3",
    alt: (brief?.subject ?? slot).slice(0, 240),
  };
}

/** First pass: shape the draft and find the slots it needs. */
export function prepareDraft(
  draftInput: unknown,
  intent: ThemeIntent,
): {
  parts: {
    draft: Rec;
    design: ThemeDesign | null;
    pages: ThemePageSeed[];
    catalogue: {
      categories: ThemeCategorySeed[];
      products: ThemeProductSeed[];
    };
  } | null;
  slots: string[];
  issues: string[];
} {
  const issues: string[] = [];
  if (!isRec(draftInput)) {
    return {
      parts: null,
      slots: [],
      issues: ["The draft must be a JSON object."],
    };
  }
  const known = new Set<string>([
    ...intent.assetBriefs.map((b) => b.id),
    ...Object.keys(SYSTEM_SLOTS),
  ]);
  const used = new Set<string>(Object.keys(SYSTEM_SLOTS));
  const design = buildDesign(draftInput.design, issues);
  const pages = buildPages(draftInput.pages, known, used, issues);
  const catalogue = buildCatalogue(draftInput, known, used, issues);

  const menus = isRec(draftInput.menus) ? draftInput.menus : {};
  const links = [
    ...list(menus.header),
    ...list(menus.footerLegal),
    ...list(menus.footerGroups).flatMap((g) => (isRec(g) ? list(g.links) : [])),
  ];
  links.forEach((link, i) => {
    if (isRec(link)) checkLink(text(link.href), `menus link ${i + 1}`, issues);
  });

  return {
    parts: { draft: draftInput, design, pages, catalogue },
    slots: [...used].sort(),
    issues,
  };
}

/** Second pass: assemble and validate the package once slot assets exist. */
export function assemblePackage(
  prepared: NonNullable<ReturnType<typeof prepareDraft>["parts"]>,
  facts: CompileFacts,
  intent: ThemeIntent,
  slotAssets: Map<string, SlotAsset>,
  priorIssues: string[],
): CompileResult {
  const issues = [...priorIssues];
  const { draft, design, pages, catalogue } = prepared;
  const features = [
    ...new Set([
      ...list(draft.features).filter((f): f is ThemeFeature =>
        THEME_STUDIO_FEATURES.includes(f as ThemeFeature),
      ),
      ...facts.requiredFeatures,
    ]),
  ];
  if (features.length === 0) issues.push("Declare at least one theme feature.");
  const engine: ThemeEngineRef =
    facts.baseEngine ??
    (design?.layout?.storefront === "grocery"
      ? { id: "storefront-grocery", version: 1 }
      : { id: "storefront-editorial", version: 1 });

  const brand = isRec(draft.brand) ? draft.brand : {};
  const menus = sanitizeMenusForSave(draft.menus);
  const surfaces = [
    ...new Set<ThemeStudioSurface>([
      "home",
      "shop",
      "product",
      "cart",
      ...intent.pagePlans.map((plan) => plan.surface),
    ]),
  ];

  const assets: ThemePackageAsset[] = [];
  for (const [slot, asset] of [...slotAssets.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    assets.push({
      id: slot,
      path: `${THEME_ASSET_PREFIX}${slot}`,
      kind: assetKind(slot, intent),
      source: "generated",
      sha256: asset.sha256,
      width: asset.width,
      height: asset.height,
      alt: slotSpec(slot, intent).alt,
      licenseNote: PLACEHOLDER_LICENSE_NOTE,
    });
  }

  if (!design) return { package: null, slots: [...slotAssets.keys()], issues };

  const definition: ThemeDefinition = {
    id: facts.themeId,
    name: facts.name,
    description: text(draft.description),
    engine,
    release: {
      version: `0.0.${facts.versionNumber}`,
      status: "draft",
      notes: [
        `Generated by Theme Studio with ${facts.modelLabel} (prompt ${facts.promptVersion}). Not reviewed.`,
      ],
    },
    catalog: {
      visibility: "hidden",
      industries: facts.industries,
      catalogSizes: facts.catalogSizes,
      features,
      keywords: list(draft.keywords).map(text).filter(Boolean),
      previewImage: `${THEME_ASSET_PREFIX}preview`,
      screenshots: [
        {
          src: `${THEME_ASSET_PREFIX}screenshot-desktop`,
          viewport: "desktop",
          alt: `${facts.name} storefront on desktop (placeholder until review screenshots exist)`,
        },
        {
          src: `${THEME_ASSET_PREFIX}screenshot-mobile`,
          viewport: "mobile",
          alt: `${facts.name} storefront on mobile (placeholder until review screenshots exist)`,
        },
      ],
    },
    demo: {
      slug: `demo-${facts.themeId}`,
      status: "unavailable",
      unavailableReason: "Generated candidate; no demo store yet.",
    },
    preset: {
      brand: {
        primaryColor: text(brand.primaryColor),
        ...(text(brand.tagline) ? { tagline: text(brand.tagline) } : {}),
        ...(text(brand.blurb) ? { blurb: text(brand.blurb) } : {}),
      },
      design,
      pages: withSeoDescriptions(pages, text(draft.description), facts.name),
      menus,
      sampleData: catalogue,
    },
  };

  const candidate: ThemePackageV2 = {
    schemaVersion: THEME_PACKAGE_SCHEMA_VERSION,
    definition,
    renderer: { minVersion: engine.version, viewports: THEME_STUDIO_VIEWPORTS },
    declaredCapabilities: { features, surfaces },
    assets,
    provenance: {
      origin: "generated",
      modelKey: facts.modelKey,
      promptVersion: facts.promptVersion,
      referenceDigests: facts.referenceDigests,
    },
    capabilityGaps: normalizeGaps(draft.capabilityGaps),
  };

  const validated = validateThemePackageV2(candidate);
  if (!validated.ok) issues.push(...validated.issues);
  return {
    package: issues.length === 0 && validated.ok ? validated.value : null,
    slots: [...slotAssets.keys()],
    issues,
  };
}

/** Normalize a Stage A intent: the schema's explicit nulls become omissions,
 * which is what validateThemeIntent expects for an optional field. */
export function normalizeIntent(raw: unknown): unknown {
  if (!isRec(raw)) return raw;
  return { ...raw, capabilityGaps: normalizeGaps(raw.capabilityGaps) };
}
