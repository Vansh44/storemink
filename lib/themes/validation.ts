import { validatePageSlug, validateSections } from "@/lib/sections/registry";
import { contrastRatio } from "@/lib/chrome/design";
import {
  isSectionScheme,
  resolveScheme,
  schemeContrastIssues,
  schemesUsed,
  SECTION_SCHEMES,
} from "./schemes";
import { typographyIssues } from "./typography";
import { normalizeMenus } from "@/lib/menus";
import { flattenNav } from "@/lib/chrome/nav";
import { STORE_POLICY_SLUGS } from "@/lib/legal/store-policies";
import type { ThemeMeta } from "./meta";
import type { ThemeDefinition } from "./types";

// ---------------------------------------------------------------------------
// Theme package validation, as PRODUCTION functions.
//
// These rules used to live only inside lib/themes/themes.test.ts, which meant
// they could guard the four hand-authored themes in CI and nothing else. A
// Theme Studio candidate is a theme too, and it is created at runtime where
// no test ever runs, so the same rules have to be callable from the server.
// themes.test.ts now asserts every bundled theme returns no findings here, and
// the Studio acceptance gates (lib/theme-studio/acceptance-gates.ts) run the
// identical functions over a generated package.
//
// ★ FINDINGS, NOT EXCEPTIONS. A reviewer needs every problem at once, with a
// sentence they can act on; throwing on the first one turns a ten-issue
// candidate into ten round trips.
//
// ★ PURE. No filesystem, no database. Asset BYTES are checked by the caller
// (a bundled theme reads public/, a Studio package reads theme_studio_assets)
// through validateThemeImage, which takes only the measured metadata.
// ---------------------------------------------------------------------------

export type ThemeFindingArea =
  | "catalog"
  | "pages"
  | "homepage"
  | "sample"
  | "links"
  | "design"
  | "brand";

export interface ThemeFinding {
  area: ThemeFindingArea;
  code: string;
  message: string;
}

/** Every palette slot a theme MUST fill. accent/accentDeep are optional: the
 * --brand-primary chain drives them. Mirrors ThemePalette in types.ts. */
export const REQUIRED_PALETTE_KEYS = [
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
  "shadowRgb",
  "success",
  "successSoft",
  "error",
  "errorSoft",
  "star",
  "highlight",
] as const;

export const THEME_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
const RGB_TRIPLE_RE = /^\d{1,3},\s*\d{1,3},\s*\d{1,3}$/;
export const THEME_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
export const PLACEHOLDER_COPY_RE = /\b(?:coming soon|lorem ipsum|theme \d+)\b/i;
const FONT_VAR_RE = /^var\(--font-[a-z-]+\)$/;

export const THEME_IMAGE_RULES = {
  maxBytes: 500 * 1024,
  maxPreviewBytes: 250 * 1024,
  minWidth: 800,
  minPreviewHeight: 600,
  previewAspect: 4 / 3,
  aspectTolerance: 0.01,
  formats: ["webp", "avif"] as readonly string[],
} as const;

/** WCAG AA: 4.5 for body text, 3 for button labels and large display type. */
export const THEME_TEXT_CONTRAST = 4.5;
export const THEME_UI_CONTRAST = 3;

const LAYOUT_VARIANTS = {
  header: ["classic", "market", "centered", "minimal"],
  card: ["classic", "quick_add", "overlay", "framed", "grocery"],
  productDetail: ["classic", "grocery", "editorial"],
  cart: ["classic", "grocery", "compact"],
  footer: ["rich", "minimal", "editorial"],
} as const;

function finding(
  area: ThemeFindingArea,
  code: string,
  message: string,
): ThemeFinding {
  return { area, code, message };
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/** Every image URL a theme can render: catalog art, sample catalogue, and any
 * `image_url` nested in a section config. */
export function collectThemeImageUrls(theme: ThemeDefinition): Set<string> {
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
  // A mega-menu tile is an image the header renders on every page.
  for (const link of flattenNav(theme.preset.menus.header)) {
    if (link.image_url) urls.add(link.image_url);
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "image_url" && typeof nested === "string" && nested) {
        urls.add(nested);
      } else {
        visit(nested);
      }
    }
  };
  for (const page of theme.preset.pages) {
    for (const section of page.sections) visit(section.config);
  }
  return urls;
}

/** Every link a shopper can follow: menus plus any section href/cta_href. */
export function collectThemeHrefs(theme: ThemeDefinition): string[] {
  const hrefs: string[] = [];
  const { header, footerGroups, footerLegal } = theme.preset.menus;
  // A nested header item is a link like any other; a heading with no
  // destination of its own (href "") is not.
  for (const link of flattenNav(header)) if (link.href) hrefs.push(link.href);
  for (const group of footerGroups) {
    for (const link of group.links) hrefs.push(link.href);
  }
  for (const link of footerLegal) hrefs.push(link.href);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (
        (key === "href" || key === "cta_href") &&
        typeof nested === "string" &&
        nested
      ) {
        hrefs.push(nested);
      } else {
        visit(nested);
      }
    }
  };
  for (const page of theme.preset.pages) {
    for (const section of page.sections) visit(section.config);
  }
  return hrefs;
}

export interface CatalogMetaOptions {
  /** Bundled themes keep their art under /themes/{id}/; a Studio package
   * names declared assets instead, so the path rule only applies here. */
  bundledAssets: boolean;
}

/** TA-2.1 / TA-2.2: identity, release and catalog copy. */
export function validateThemeCatalogMeta(
  theme: ThemeMeta,
  options: CatalogMetaOptions,
): ThemeFinding[] {
  const out: ThemeFinding[] = [];
  const add = (code: string, message: string) =>
    out.push(finding("catalog", code, message));
  if (!THEME_ID_RE.test(theme.id)) {
    add("id", "The theme id must be lowercase letters, digits and hyphens.");
  }
  if (!theme.name.trim()) add("name", "The theme needs a name.");
  if (theme.description.trim().length < 40) {
    add("description", "The description must be at least 40 characters.");
  }
  if (PLACEHOLDER_COPY_RE.test(theme.name)) {
    add("name_placeholder", "The name reads like placeholder copy.");
  }
  if (PLACEHOLDER_COPY_RE.test(theme.description)) {
    add(
      "description_placeholder",
      "The description reads like placeholder copy.",
    );
  }
  if (!THEME_ID_RE.test(theme.engine.id) || !(theme.engine.version > 0)) {
    add("engine", "The renderer engine reference is invalid.");
  }
  if (!SEMVER_RE.test(theme.release.version)) {
    add("release_version", "The release version must be semver (1.2.3).");
  }
  if (theme.release.notes.length === 0) {
    add("release_notes", "The release needs at least one note.");
  }
  const { catalog } = theme;
  for (const [key, list] of [
    ["industries", catalog.industries],
    ["catalogSizes", catalog.catalogSizes],
    ["features", catalog.features],
    ["keywords", catalog.keywords],
  ] as const) {
    if (list.length === 0) add(`${key}_empty`, `Declare at least one ${key}.`);
    if (key !== "keywords" && hasDuplicates(list)) {
      add(`${key}_duplicate`, `${key} contains duplicates.`);
    }
  }
  if (catalog.screenshots.length === 0) {
    add("screenshots", "The catalog needs at least one screenshot.");
  }
  for (const screenshot of catalog.screenshots) {
    if (screenshot.alt.trim().length < 15) {
      add(
        "screenshot_alt",
        "Every screenshot needs alt text of 15+ characters.",
      );
    }
  }
  if (options.bundledAssets) {
    if (catalog.previewImage !== `/themes/${theme.id}/preview.webp`) {
      add(
        "preview_path",
        `The preview must be /themes/${theme.id}/preview.webp.`,
      );
    }
    for (const screenshot of catalog.screenshots) {
      if (!screenshot.src.startsWith(`/themes/${theme.id}/`)) {
        add(
          "screenshot_path",
          `Screenshots must live under /themes/${theme.id}/.`,
        );
      }
    }
  }
  if (catalog.visibility === "public") {
    if (theme.release.status !== "published") {
      add("public_unpublished", "Only a published release may be public.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(theme.release.releasedAt ?? "")) {
      add("public_release_date", "A public release needs a release date.");
    }
    if (theme.demo.status !== "healthy") {
      add("public_demo", "A public release needs a healthy demo.");
    }
  }
  if (theme.release.status === "blocked" && catalog.visibility === "public") {
    add("blocked_public", "A blocked release cannot be public.");
  }
  if (theme.demo.slug !== `demo-${theme.id}`) {
    add("demo_slug", `The demo slug must be demo-${theme.id}.`);
  }
  return out;
}

/** TA-2.3: one homepage, unique addressable pages, strict sections. */
export function validateThemePages(theme: ThemeDefinition): ThemeFinding[] {
  const out: ThemeFinding[] = [];
  const add = (code: string, message: string) =>
    out.push(finding("pages", code, message));
  const pages = theme.preset.pages;
  const homepages = pages.filter((page) => page.slug === "").length;
  if (homepages !== 1) {
    add(
      "homepage_count",
      `There must be exactly one homepage (found ${homepages}).`,
    );
  }
  if (hasDuplicates(pages.map((page) => page.slug))) {
    add("slug_duplicate", "Two pages share a slug.");
  }
  for (const page of pages) {
    const label = page.slug || "(home)";
    if (!page.title.trim()) add("title", `${label}: the page needs a title.`);
    if ((page.seo_description?.trim().length ?? 0) < 20) {
      add(
        "seo_description",
        `${label}: the SEO description must be 20+ characters.`,
      );
    }
    if (hasDuplicates(page.sections.map((section) => section.id))) {
      add("section_id_duplicate", `${label}: two sections share an id.`);
    }
    if (page.slug !== "") {
      const slug = validatePageSlug(page.slug);
      if (!("slug" in slug) || slug.slug !== page.slug) {
        add("slug_invalid", `${label}: the slug is not addressable.`);
      }
    }
    const strict = validateSections(page.sections, { mode: "publish" });
    if ("error" in strict) {
      add("section_invalid", `${label}: ${strict.error}`);
    }
    for (const section of page.sections) {
      const config = section.config as unknown as Record<string, unknown>;
      if (section.type === "latest_blogs") {
        add(
          "latest_blogs",
          `${label}: blog sections render nothing on a new store.`,
        );
      }
      if (section.type === "custom_code") {
        add("custom_code", `${label}: themes may not ship custom code.`);
      }
      if (
        section.type === "featured_products" &&
        (config.source !== "featured" ||
          (Array.isArray(config.product_ids) && config.product_ids.length > 0))
      ) {
        add(
          "id_source",
          `${label}: featured products must use the "featured" source.`,
        );
      }
      if (section.type === "shop_by_category" && config.source !== "all") {
        add("id_source", `${label}: categories must use the "all" source.`);
      }
    }
  }
  return out;
}

/** TA-2.4: a floor on homepage structure, never a design target. */
export function validateThemeHomepage(theme: ThemeDefinition): ThemeFinding[] {
  const homepage = theme.preset.pages.find((page) => page.slug === "");
  if (!homepage) return [];
  const enabled = homepage.sections.filter((section) => section.enabled);
  const out: ThemeFinding[] = [];
  if (enabled.length < 5) {
    out.push(
      finding(
        "homepage",
        "sections",
        `The homepage needs 5+ enabled sections (has ${enabled.length}).`,
      ),
    );
  }
  const types = new Set(enabled.map((section) => section.type)).size;
  if (types < 4) {
    out.push(
      finding(
        "homepage",
        "variety",
        `The homepage needs 4+ distinct section types (has ${types}).`,
      ),
    );
  }
  return out;
}

/** TA-2.5: enough sample catalogue to render a credible demo. */
export function validateThemeSampleData(
  theme: ThemeDefinition,
): ThemeFinding[] {
  const out: ThemeFinding[] = [];
  const add = (code: string, message: string) =>
    out.push(finding("sample", code, message));
  const sample = theme.preset.sampleData;
  if (!sample) {
    add("missing", "Sample data is required for a credible demo.");
    return out;
  }
  if (sample.categories.length < 4) {
    add(
      "categories",
      `Seed at least 4 categories (has ${sample.categories.length}).`,
    );
  }
  if (sample.products.length < 8) {
    add(
      "products",
      `Seed at least 8 products (has ${sample.products.length}).`,
    );
  }
  const categorySlugs = sample.categories.map((category) => category.slug);
  if (hasDuplicates(categorySlugs))
    add("category_slug", "Two categories share a slug.");
  if (hasDuplicates(sample.products.map((product) => product.slug))) {
    add("product_slug", "Two products share a slug.");
  }
  for (const product of sample.products) {
    if (!categorySlugs.includes(product.category_slug)) {
      add(
        "category_ref",
        `${product.slug}: category "${product.category_slug}" is not seeded.`,
      );
    }
    if (!product.name.trim())
      add("product_name", `${product.slug}: needs a name.`);
    if (product.description.trim().length < 20) {
      add(
        "product_description",
        `${product.slug}: description must be 20+ characters.`,
      );
    }
    if (!(product.base_price > 0) || !(product.selling_price > 0)) {
      add("product_price", `${product.slug}: prices must be positive.`);
    } else if (product.selling_price > product.base_price) {
      add(
        "product_price",
        `${product.slug}: selling price exceeds the base price.`,
      );
    }
  }
  if (!sample.products.some((product) => product.featured)) {
    add("featured", "Mark at least one product as featured.");
  }
  return out;
}

/** Storefront routes that live in code rather than as pages. Pinned against
 * app/(storefront)/(pages) by validation.test.ts, so a route added there is
 * not reported as a dead link. */
export const STOREFRONT_CODE_ROUTES: ReadonlySet<string> = new Set([
  "blogs",
  "cart",
  "checkout",
  // Only /collections/<slug> is a page; a bare /collections is refused below.
  "collections",
  "enquiries",
  "notifications",
  "orders",
  "profile",
  "shop",
]);

/**
 * Legal documents a MERCHANT writes, never a theme. Their links are expected
 * to exist before the pages do (Settings → Policies creates them at exactly
 * these slugs), and a theme that generated policy text would be worse than a
 * missing page: prose nobody read that looks authoritative. So these links are
 * exempt from the dead-link rule. cookie-policy is not in the Policies editor
 * but is the same kind of document, and every bundled theme links it.
 */
export const MERCHANT_AUTHORED_SLUGS: ReadonlySet<string> = new Set([
  ...STORE_POLICY_SLUGS,
  "cookie-policy",
]);

/**
 * Every link must reach something the store will actually have. A link that
 * NAMES a category or product must reach a seeded one; a single-segment page
 * link must reach a seeded page or a storefront route.
 *
 * ★ The menus are read the way the STOREFRONT reads them (normalizeMenus), not
 * as stored. An empty legal row falls back to the platform's default Privacy,
 * Terms and Refund links, so a theme that seeds none of those pages ships a
 * footer of dead links unless this counts the fallback too.
 */
export function validateThemeLinks(theme: ThemeDefinition): ThemeFinding[] {
  const out: ThemeFinding[] = [];
  const categories = new Set(
    (theme.preset.sampleData?.categories ?? []).map(
      (category) => category.slug,
    ),
  );
  const products = new Set(
    (theme.preset.sampleData?.products ?? []).map((product) => product.slug),
  );
  const pages = new Set(theme.preset.pages.map((page) => page.slug));
  const rendered = normalizeMenus(theme.preset.menus);
  const hrefs = new Set([
    ...collectThemeHrefs(theme),
    ...flattenNav(rendered.header)
      .map((link) => link.href)
      .filter(Boolean),
    ...rendered.footerGroups.flatMap((group) => group.links.map((l) => l.href)),
    ...rendered.footerLegal.map((link) => link.href),
  ]);
  for (const href of hrefs) {
    // A category is linked by its own page (/collections/<slug>) or by the
    // older query form, which now redirects there. Either must name a
    // seeded category.
    const category =
      href.match(/^\/collections\/([^/?#]+)\/?$/) ??
      href.match(/^\/shop\?category=([^&]+)$/);
    if (category) {
      if (!categories.has(category[1])) {
        out.push(
          finding("links", "category", `${href} names no seeded category.`),
        );
      }
      continue;
    }
    if (/^\/collections\/?(?:[?#].*)?$/.test(href)) {
      out.push(
        finding(
          "links",
          "category",
          `${href} names no category; link /collections/<category slug>.`,
        ),
      );
      continue;
    }
    const product = href.match(/^\/shop\/([^/?#]+)$/);
    if (product) {
      if (!products.has(product[1])) {
        out.push(
          finding("links", "product", `${href} names no seeded product.`),
        );
      }
      continue;
    }
    const page = href.match(/^\/([a-z0-9-]+)\/?(?:[?#].*)?$/);
    if (
      page &&
      !pages.has(page[1]) &&
      !STOREFRONT_CODE_ROUTES.has(page[1]) &&
      !MERCHANT_AUTHORED_SLUGS.has(page[1])
    ) {
      out.push(
        finding(
          "links",
          "page",
          `${href} links to a page the theme does not seed.`,
        ),
      );
    }
  }
  return out;
}

/** TA-2.2 (brand copy) and TA-2.7 (a complete, injectable, legible design). */
export function validateThemeDesign(theme: ThemeDefinition): ThemeFinding[] {
  const out: ThemeFinding[] = [];
  const { brand, design } = theme.preset;
  const brandIssue = (code: string, message: string) =>
    out.push(finding("brand", code, message));
  if ((brand.tagline?.trim().length ?? 0) < 10) {
    brandIssue("tagline", "The brand tagline must be 10+ characters.");
  } else if (PLACEHOLDER_COPY_RE.test(brand.tagline ?? "")) {
    brandIssue(
      "tagline_placeholder",
      "The tagline reads like placeholder copy.",
    );
  }
  if ((brand.blurb?.trim().length ?? 0) < 40) {
    brandIssue("blurb", "The brand blurb must be 40+ characters.");
  } else if (PLACEHOLDER_COPY_RE.test(brand.blurb ?? "")) {
    brandIssue("blurb_placeholder", "The blurb reads like placeholder copy.");
  }
  if (!THEME_COLOR_RE.test(brand.primaryColor)) {
    brandIssue("primary_color", "The brand colour must be a hex colour.");
  }

  const issue = (code: string, message: string) =>
    out.push(finding("design", code, message));
  const palette = design.palette as unknown as Record<string, unknown>;
  for (const key of REQUIRED_PALETTE_KEYS) {
    const value = palette[key];
    const ok =
      typeof value === "string" &&
      (key === "shadowRgb"
        ? RGB_TRIPLE_RE.test(value)
        : THEME_COLOR_RE.test(value));
    if (!ok)
      issue("palette", `palette.${key} is missing or not a valid colour.`);
  }
  for (const key of ["accent", "accentDeep"] as const) {
    const value = palette[key];
    if (
      value !== undefined &&
      !(typeof value === "string" && THEME_COLOR_RE.test(value))
    ) {
      issue("palette", `palette.${key} is not a valid colour.`);
    }
  }
  if (
    !FONT_VAR_RE.test(design.fonts.body) ||
    !FONT_VAR_RE.test(design.fonts.display)
  ) {
    issue("fonts", "Fonts must reference a loaded --font-* variable.");
  }
  // Heading typography is opt-in, so a theme that sets none is not checked
  // here — including against a face that would fake its bold.
  for (const problem of typographyIssues(design.typography, design.fonts)) {
    issue("typography", problem);
  }
  for (const key of ["card", "control", "sm", "pill"] as const) {
    if (!/^\d/.test(design.shape[key] ?? "")) {
      issue("shape", `shape.${key} must be a CSS length.`);
    }
  }
  const layout = design.layout;
  for (const key of ["headerBackground", "headerForeground"] as const) {
    const value = layout?.[key];
    if (value !== undefined && !THEME_COLOR_RE.test(value)) {
      issue("layout_color", `layout.${key} must be a hex colour.`);
    }
  }
  for (const [key, allowed] of Object.entries(LAYOUT_VARIANTS)) {
    const value = layout?.[key as keyof typeof LAYOUT_VARIANTS];
    if (
      value !== undefined &&
      !(allowed as readonly string[]).includes(value)
    ) {
      issue(
        "layout_variant",
        `layout.${key} "${value}" is not a registered variant.`,
      );
    }
  }

  // Legibility is judged on the pairs the storefront actually renders. A pair
  // whose colours are not plain hex was already reported above; skip it
  // rather than report a meaningless ratio.
  const hex = (value: unknown): string | null =>
    typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
  const pairs: Array<[unknown, unknown, number, string]> = [
    [
      palette.ink,
      palette.cream,
      THEME_TEXT_CONTRAST,
      "Body text on the page background",
    ],
    [palette.ink, palette.surface, THEME_TEXT_CONTRAST, "Text on cards"],
    [
      palette.inkSoft,
      palette.cream,
      THEME_TEXT_CONTRAST,
      "Muted text on the page background",
    ],
    [
      palette.inkSoft,
      palette.sand,
      THEME_TEXT_CONTRAST,
      "Muted labels on sand chips (the delivery pill)",
    ],
    [
      palette.onInk,
      palette.ink,
      THEME_TEXT_CONTRAST,
      "Text on dark (ink) surfaces",
    ],
    [
      palette.onAccent,
      palette.accent ?? brand.primaryColor,
      THEME_UI_CONTRAST,
      "Button labels on the accent colour",
    ],
  ];
  if (layout?.headerBackground && layout.headerForeground) {
    pairs.push([
      layout.headerForeground,
      layout.headerBackground,
      THEME_TEXT_CONTRAST,
      "Header text on the header bar",
    ]);
  }
  for (const [fg, bg, minimum, label] of pairs) {
    const a = hex(fg);
    const b = hex(bg);
    if (!a || !b) continue;
    const ratio = contrastRatio(a, b);
    if (ratio < minimum) {
      issue(
        "contrast",
        `${label} is hard to read (${ratio.toFixed(2)}:1, needs ${minimum}:1).`,
      );
    }
  }

  // Section colour schemes. A declared scheme must be plain hex and is always
  // checked; a DERIVED one only when a page uses it — a theme is not failed
  // for a scheme nobody wears, and the builder marks an unreadable one when a
  // merchant goes to pick it.
  const declared = (design.schemes ?? {}) as Record<string, unknown>;
  for (const [id, raw] of Object.entries(declared)) {
    if (!isSectionScheme(id)) {
      issue("scheme", `schemes.${id} is not a known colour scheme.`);
      continue;
    }
    const scheme = raw as Record<string, unknown> | null;
    for (const key of ["background", "text", "surface", "accent", "onAccent"]) {
      const value = scheme?.[key];
      const required = key === "background" || key === "text";
      if ((required || value !== undefined) && !hex(value)) {
        issue("scheme", `schemes.${id}.${key} must be a hex colour.`);
      }
    }
    const hasAccent = hex(scheme?.accent) !== null;
    const hasOnAccent = hex(scheme?.onAccent) !== null;
    if (hasAccent !== hasOnAccent) {
      issue(
        "scheme",
        `schemes.${id} must set accent and onAccent together, or neither.`,
      );
    }
  }
  const paletteReady =
    ["cream", "creamDeep", "surface", "ink", "onInk", "onAccent"].every(
      (key) => hex(palette[key]) !== null,
    ) && hex(design.palette.accent ?? brand.primaryColor) !== null;
  if (paletteReady) {
    const check = new Set([
      ...Object.keys(declared).filter(isSectionScheme),
      ...schemesUsed(theme.preset.pages),
    ]);
    for (const id of SECTION_SCHEMES) {
      if (!check.has(id)) continue;
      const resolved = resolveScheme(id, design, brand.primaryColor);
      for (const problem of schemeContrastIssues(id, resolved)) {
        issue("scheme_contrast", problem.message);
      }
    }
  }
  return out;
}

export type ThemeDefinitionOptions = CatalogMetaOptions;

/** Every package-level rule in one call. An empty list means the package is
 * valid; it does NOT mean the theme is approved (theme-acceptance.md). */
export function validateThemeDefinition(
  theme: ThemeDefinition,
  options: ThemeDefinitionOptions,
): ThemeFinding[] {
  return [
    ...validateThemeCatalogMeta(theme, options),
    ...validateThemePages(theme),
    ...validateThemeHomepage(theme),
    ...validateThemeSampleData(theme),
    ...validateThemeLinks(theme),
    ...validateThemeDesign(theme),
  ];
}

export interface ThemeImageFacts {
  format: string | null | undefined;
  width: number | null | undefined;
  height: number | null | undefined;
  bytes: number;
}

/** TA-2.6: a production-sized image. Takes MEASURED facts, so the bundled
 * test (sharp over public/) and the Studio gate (a stored asset row) share it. */
export function validateThemeImage(
  label: string,
  facts: ThemeImageFacts,
  options: { preview: boolean },
): string[] {
  const rules = THEME_IMAGE_RULES;
  const issues: string[] = [];
  if (!rules.formats.includes(String(facts.format ?? ""))) {
    issues.push(
      `${label}: must be WebP or AVIF (is ${facts.format ?? "unknown"}).`,
    );
  }
  if ((facts.width ?? 0) < rules.minWidth) {
    issues.push(
      `${label}: must be at least ${rules.minWidth}px wide (is ${facts.width ?? 0}px).`,
    );
  }
  if (facts.bytes > rules.maxBytes) {
    issues.push(
      `${label}: must be at most 500 KiB (is ${Math.ceil(facts.bytes / 1024)} KiB).`,
    );
  }
  if (options.preview) {
    if ((facts.height ?? 0) < rules.minPreviewHeight) {
      issues.push(
        `${label}: the preview must be at least ${rules.minPreviewHeight}px tall.`,
      );
    }
    if (facts.bytes > rules.maxPreviewBytes) {
      issues.push(`${label}: the preview must be at most 250 KiB.`);
    }
    const aspect = (facts.width ?? 0) / (facts.height || 1);
    if (Math.abs(aspect - rules.previewAspect) > rules.aspectTolerance) {
      issues.push(`${label}: the preview must be 4:3.`);
    }
  }
  return issues;
}
