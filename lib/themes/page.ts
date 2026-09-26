// ---------------------------------------------------------------------------
// Page width and spacing rhythm a theme may set: how wide the content runs,
// how much room separates homepage sections, and the gap between product
// cards.
//
// ★ OPT-IN, AND ABSENT MEANS TODAY'S LAYOUT EXACTLY. Every consumer reads a
// variable WITH ITS CURRENT VALUE AS THE FALLBACK (`max-width:
// var(--sm-page-width, 1100px)`), so a theme that sets nothing emits no
// variable and every width, gap and gutter computes as before.
//
// ★ ONE WIDTH FOR THE WHOLE STORE. Today the homepage blocks cap at 1320,
// 1440 or 1200px, product rows and the shop listing not at all, the product
// page and cart at 1100–1120, the footer at 1400 and the header runs edge to
// edge — so nothing lines up. A chosen width applies to all of them.
//
// ★ BANDS STAY FULL WIDTH. Homepage sections and the shop listing reach the
// width through their side padding — `max(gutter, (100% − width) / 2)` — so a
// coloured band still paints edge to edge while its content is held to the
// page width. A section the merchant marks "Full width" opts out of it.
//
// Pure: the storefront layout, theme validation, the Theme Studio compiler and
// the tests all import this one file.
// ---------------------------------------------------------------------------

export const PAGE_WIDTHS = ["narrow", "standard", "wide", "full"] as const;
export const SECTION_GAPS = ["compact", "standard", "airy"] as const;
export const GRID_GAPS = ["tight", "standard", "roomy"] as const;

export type PageWidth = (typeof PAGE_WIDTHS)[number];
export type SectionGap = (typeof SECTION_GAPS)[number];
export type GridGap = (typeof GRID_GAPS)[number];

export interface ThemePage {
  /** How wide the content runs on a large screen. Phones and tablets narrower
   *  than the width are unchanged: the side gutter governs there. */
  width?: PageWidth;
  /** The room between homepage sections. */
  sectionGap?: SectionGap;
  /** The gap between product cards in grids and rows. */
  gridGap?: GridGap;
}

export const PAGE_WIDTH_VALUE: Record<PageWidth, string> = {
  narrow: "1080px",
  standard: "1240px",
  wide: "1440px",
  full: "100%",
};

/** "standard" is today's gap, so it emits nothing. */
export const SECTION_GAP_VALUE: Record<SectionGap, string | null> = {
  compact: "clamp(24px, 4vw, 44px)",
  standard: null,
  airy: "clamp(64px, 9vw, 120px)",
};

/** Product grids use 22px or 28px today, depending on the grid. A chosen gap
 *  applies to every product grid, so "standard" is a real value here. */
export const GRID_GAP_VALUE: Record<GridGap, string> = {
  tight: "12px",
  standard: "22px",
  roomy: "36px",
};

/**
 * Containers whose `max-width` follows the page width. A test fails if one of
 * them stops reading `var(--sm-page-width, <its current width>)`.
 *
 * ★ NARROW-BY-DESIGN BLOCKS ARE NOT HERE: the rich-text column, the FAQ list,
 * a media block without media, the editorial gallery, portrait and square
 * video, the compact cart. A reading measure is not a page width.
 */
export const PAGE_WIDTH_CONTAINERS = [
  ".home-media-text",
  ".home-gallery",
  ".home-testimonials",
  ".home-video-player",
  ".home-newsletter",
  ".shop-grid",
  ".shop-breadcrumb",
  ".pdp-grid",
  ".pdp-related",
  ".cart-head",
  ".cart-layout",
  ".cart-loading",
  ".gcart-breadcrumb",
  ".gcart-title",
  ".gcart-subtitle",
  ".gcart-layout",
  ".gcart-loading",
  ".newsletterInner",
  ".trustInner",
] as const;

/** Footer rows and the editorial and grocery product pages, whose side padding sits
 *  inside their cap: the cap is the page width plus that padding, so their
 *  content starts where the page's does. */
export const PADDED_PAGE_WIDTH_CONTAINERS = [
  ".mainGrid",
  ".bottomSection",
  ".sm-pdp-editorial .shop-main.pdp-page",
  ".sm-storefront-grocery .gpdp-main",
] as const;

function pick<T extends string>(
  list: readonly T[],
  value: unknown,
): T | undefined {
  return typeof value === "string" &&
    (list as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Keep only the recognised settings. Unknown values are dropped, never
 *  guessed at; validation reports them separately. */
export function cleanPage(raw: unknown): ThemePage {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  const out: ThemePage = {};
  const width = pick(PAGE_WIDTHS, r.width);
  const sectionGap = pick(SECTION_GAPS, r.sectionGap);
  const gridGap = pick(GRID_GAPS, r.gridGap);
  if (width) out.width = width;
  if (sectionGap) out.sectionGap = sectionGap;
  if (gridGap) out.gridGap = gridGap;
  return out;
}

/** The variables these settings write onto `.storefront-root`. Only what is
 *  set: an absent key must leave every width and gap on its own value. */
export function pageCssVars(
  raw: ThemePage | undefined,
): Record<string, string> {
  const t = cleanPage(raw);
  const vars: Record<string, string> = {};
  if (t.width) vars["--sm-page-width"] = PAGE_WIDTH_VALUE[t.width];
  const gap = t.sectionGap ? SECTION_GAP_VALUE[t.sectionGap] : null;
  if (gap) vars["--sm-section-gap"] = gap;
  if (t.gridGap) vars["--sm-grid-gap"] = GRID_GAP_VALUE[t.gridGap];
  return vars;
}

/**
 * Root classes. Only the width needs one: it lets a "Full width" section put
 * its own width back to the whole screen. Without a theme width that section
 * already runs full, so the class must not exist and cannot change it.
 */
export function pageRootClasses(raw: ThemePage | undefined): string[] {
  return cleanPage(raw).width ? ["sm-page-width"] : [];
}

/** Problems with a theme's page settings, in words the Theme Studio repair
 *  loop and a reviewer can act on. */
export function pageIssues(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return ["page must be an object."];
  }
  const allowed: Record<string, readonly string[]> = {
    width: PAGE_WIDTHS,
    sectionGap: SECTION_GAPS,
    gridGap: GRID_GAPS,
  };
  const issues: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const list = allowed[key];
    if (!list) {
      issues.push(`page.${key} is not a page setting.`);
    } else if (value !== undefined && !list.includes(String(value))) {
      issues.push(
        `page.${key} "${String(value)}" must be one of ${list.join(", ")}.`,
      );
    }
  }
  return issues;
}
