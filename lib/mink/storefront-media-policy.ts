import type { PageSectionItem } from "@/lib/sections/registry";

// ---------------------------------------------------------------------------
// Phase 9D - a Mink layout proposal may only cite images the store owns.
//
// ★★ THE DEFECT THIS CLOSES IS LIVE IN 9B, AND IT IS SILENT.
// `safeHref` (lib/homepage/section-types.ts) blocks `javascript:`, `data:` and
// `vbscript:` and accepts EVERY other string. So a `gallery` needs two images,
// a model asked for one has never been shown a single real image URL, and an
// invented `https://images.example.com/shop-hero.jpg` passes validateConfig,
// is stored, renders on the review card as "Added: Gallery", is approved, and
// lands in `store_pages.sections` as a broken image on the merchant's own
// storefront. Nothing errors at any step -- which is why the fix has to be a
// refusal at the contract, not a warning on the card.
//
// ★ THE ALLOWLIST IS "WHAT THE MODEL WAS ACTUALLY SHOWN", nothing wider.
// Three sources, and each is a URL that provably exists:
//   1. every media URL already on the CURRENT page (preservation -- a proposal
//      that keeps or moves an existing block must never be refused for it);
//   2. every `media_assets.url` returned by `list_storefront_media`;
//   3. every exact catalogue photograph returned by a product read tool.
// A store-owned GCS PREFIX rule was considered and rejected: the builder's own
// uploads land under `stores/{storeId}/uploads/` with no row anywhere, so no
// read tool can list them and the model could only ever reach one by
// CONSTRUCTING a path -- which is the invented-URL defect again, wearing a
// prefix that makes it look checked.
//
// ⚠ THE CONSEQUENCE, STATED RATHER THAN PAPERED OVER: a theme-seeded store
// keeps its imagery at `/themes/{id}/*.webp`, which is owned by no store row.
// So on a page that has no images yet, a model asked for a general gallery may
// have nothing to use and must say so. Asking for real imagery is better than
// putting two broken images on the page.
//
// ★ LINKS ARE DELIBERATELY NOT RESTRICTED. `href` and `cta_href` are places a
// shopper is sent, and a merchant legitimately points them at Instagram, a
// supplier, a Google form. `*_url` is media the storefront LOADS, and a wrong
// one is a hole in the page rather than a link nobody clicks.
// ---------------------------------------------------------------------------

/**
 * The naming rule this whole guard rests on: a section config key ending in
 * `_url` names media the page renders (`image_url`, `video_url`, `logo_url`,
 * `poster_url`), and a key named `href` names a link the shopper follows.
 *
 * ⚠ It is a CONVENTION, so it is pinned by `storefront-media-policy.test.ts`,
 * which scans the section registry's source for any field whose name suggests
 * media and fails unless it ends in `_url`. A future `background_image` would
 * otherwise slip past this file with nothing reporting it.
 */
export const MINK_MEDIA_URL_KEY_SUFFIX = "_url";

/** Bounds one refusal message; a URL is untrusted merchant/model text. */
const URL_ECHO_CHARS = 120;
/** Bounds the walk over a config the registry has already size-capped. */
const MAX_WALK_DEPTH = 8;

/**
 * Every media URL a section list references, in document order.
 *
 * Deep, because media lives at three depths already: `config.image_url` on a
 * hero, `config.items[].image_url` on a gallery, `config.slides[].video_url`
 * on a carousel. Walking rather than enumerating the seventeen types is the
 * point -- an enumerated list is the thing that goes stale.
 */
export function collectSectionMediaUrls(
  sections: readonly PageSectionItem[],
): string[] {
  const found: string[] = [];
  for (const section of sections) {
    walk(section.config, found, 0);
  }
  return found;
}

/**
 * Refuse any media URL the proposal did not get from the store.
 *
 * Returns one issue per offending URL rather than stopping at the first: a
 * model that invented one gallery image invented all of them, and listing them
 * together is what lets a single retry fix the whole section.
 */
export function assertLayoutMediaIsOwned(
  proposed: readonly PageSectionItem[],
  allowedUrls: Iterable<string>,
): string[] {
  const allowed = new Set<string>();
  for (const url of allowedUrls) {
    const normalized = normalizeMediaUrl(url);
    if (normalized) allowed.add(normalized);
  }
  const issues: string[] = [];
  const reported = new Set<string>();
  for (const [index, section] of proposed.entries()) {
    const urls: string[] = [];
    walk(section.config, urls, 0);
    for (const url of urls) {
      if (allowed.has(url) || reported.has(url)) continue;
      reported.add(url);
      issues.push(
        `Section ${index + 1}: ${JSON.stringify(url.slice(0, URL_ECHO_CHARS))} is not an image this store has. Cite an exact catalogue image returned by search_products or get_current_product, use list_storefront_media and cite a url it returned, keep an image already on this page, or ask the merchant to add it first.`,
      );
    }
  }
  return issues;
}

/**
 * The comparison key. Trim only -- a URL path is case-sensitive, and folding
 * case here would accept a near-miss the storefront then fails to load.
 */
export function normalizeMediaUrl(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function walk(value: unknown, out: string[], depth: number): void {
  if (depth > MAX_WALK_DEPTH || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, out, depth + 1);
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      if (!key.endsWith(MINK_MEDIA_URL_KEY_SUFFIX)) continue;
      const url = normalizeMediaUrl(entry);
      // An empty field is a cleared field, not an unowned image.
      if (url) out.push(url);
      continue;
    }
    walk(entry, out, depth + 1);
  }
}
