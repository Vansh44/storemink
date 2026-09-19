// ---------------------------------------------------------------------------
// Page-section registry — the canonical import for the website builder.
//
// Section TYPES live in lib/homepage/section-types.ts (re-exported here) so
// the existing homepage editor and the page builder share one catalog. This
// module adds the page-level pieces: the {id,type,enabled,config} item shape
// stored in store_pages.sections (jsonb), its validator, and page-slug rules
// (shape + reserved names so a merchant page can never shadow a real route).
//
// Pure module (no server imports) — shared by server actions, the builder UI,
// the storefront, and tests.
// ---------------------------------------------------------------------------

export * from "@/lib/homepage/section-types";

import {
  HOMEPAGE_SECTION_TYPES,
  validateConfig,
  validateSectionStyle,
  type AnySectionConfig,
  type HomepageSectionType,
  type SectionStyle,
  type ValidateMode,
} from "@/lib/homepage/section-types";

/** Alias — "homepage" naming is historical; these types serve every page. */
export type SectionType = HomepageSectionType;

/** One section inside a page's `sections` jsonb array. `style` is the shared
 *  per-section appearance (SectionShell) — a SIBLING of config so per-type
 *  validation never has to know about it; absent = pre-style rows render
 *  exactly as before. */
export interface PageSectionItem {
  id: string;
  type: SectionType;
  enabled: boolean;
  config: AnySectionConfig;
  style?: SectionStyle;
}

export const MAX_PAGE_SECTIONS = 40;

/**
 * Validate + normalise a draft sections array (from the builder) into clean
 * PageSectionItems. Every config passes through validateConfig, ids must be
 * unique non-empty strings, unknown types are rejected. Returns the FIRST
 * error with its section index so the builder can point at the culprit.
 * mode "draft" (autosave) skips completeness rules; "publish" is strict.
 *
 * `lenientIds` holds sections to validate in "draft" mode whatever `mode` says
 * — content the caller has established the merchant did not just write and
 * cannot necessarily fix. Everything else is unaffected, which matters because
 * the two modes do not merely differ in what they REFUSE: a gallery drops its
 * imageless items under "publish", so switching a whole list to draft mode to
 * rescue one section would quietly change what gets stored for the others.
 */
export function validateSections(
  raw: unknown,
  {
    mode = "publish",
    lenientIds,
  }: { mode?: ValidateMode; lenientIds?: ReadonlySet<string> } = {},
): { sections: PageSectionItem[] } | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: "Sections must be a list." };
  }
  if (raw.length > MAX_PAGE_SECTIONS) {
    return { error: `A page can have at most ${MAX_PAGE_SECTIONS} sections.` };
  }

  const sections: PageSectionItem[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < raw.length; i++) {
    const item = (raw[i] ?? {}) as Record<string, unknown>;
    const label = `Section ${i + 1}`;

    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) return { error: `${label}: missing id.` };
    if (seen.has(id)) return { error: `${label}: duplicate id.` };
    seen.add(id);

    const type = item.type as SectionType;
    if (!HOMEPAGE_SECTION_TYPES.includes(type)) {
      return { error: `${label}: unknown section type.` };
    }

    const validated = validateConfig(
      type,
      item.config,
      lenientIds?.has(id) ? "draft" : mode,
    );
    if ("error" in validated) {
      return { error: `${label} (${type}): ${validated.error}` };
    }

    const style = validateSectionStyle(item.style);
    sections.push({
      id,
      type,
      enabled: item.enabled !== false,
      config: validated.config,
      ...(style ? { style } : {}),
    });
  }

  return { sections };
}

// --- Page slugs --------------------------------------------------------------

/**
 * Every slug a merchant page may NOT use. Two sources of truth to protect:
 *  1. real route segments under app/(storefront)/(pages)/ — Next serves static
 *     routes before the [pageSlug] dynamic route, so a page with one of these
 *     slugs would save fine but silently never render;
 *  2. top-level app routes + well-known files.
 * A unit test walks the (pages) directory and fails if a new static route is
 * added without reserving it here (see registry.test.ts).
 */
export const RESERVED_PAGE_SLUGS: ReadonlySet<string> = new Set([
  // app/(storefront)/(pages)/* INTERACTIVE static routes (forms / data / client
  // state — stay in code, so a merchant page can never shadow them). The former
  // content-only static pages (our-story, faqs, contact, careers, find-us,
  // gift-packs, ingredients, process, sustainability, wholesale, track-order,
  // returns, shipping, terms, privacy-policy, cookie-policy, refund-policy) were
  // retired in Phase 4b and are now merchant-editable store_pages, so they are
  // intentionally NOT reserved.
  "blogs",
  "cart",
  "checkout",
  "enquiries",
  "notifications",
  "orders",
  "profile",
  "shop",
  // top-level app routes (never storefront pages, but never claimable either)
  "dashboard",
  "auth",
  "api",
  "platform",
  "help",
  // well-known files / roots
  "robots.txt",
  "sitemap.xml",
  "favicon.ico",
  "index",
  "home",
]);

export const PAGE_SLUG_MAX_LENGTH = 60;
const PAGE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Validate a merchant-chosen page slug. Returns the normalised slug or an
 * error message. ("" is the future homepage sentinel — not creatable here.)
 */
export function validatePageSlug(
  raw: unknown,
): { slug: string } | { error: string } {
  const slug = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!slug) return { error: "Give the page a URL slug." };
  if (slug.length > PAGE_SLUG_MAX_LENGTH) {
    return {
      error: `Slugs can be at most ${PAGE_SLUG_MAX_LENGTH} characters.`,
    };
  }
  if (!PAGE_SLUG_RE.test(slug)) {
    return {
      error:
        "Slugs can only contain lowercase letters, numbers and hyphens (e.g. about-us).",
    };
  }
  if (RESERVED_PAGE_SLUGS.has(slug)) {
    return { error: `"${slug}" is reserved — pick a different slug.` };
  }
  return { slug };
}
