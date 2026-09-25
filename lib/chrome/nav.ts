// ---------------------------------------------------------------------------
// Navigation links — the one shape the header menu, the footer columns and a
// theme preset's menus all share, and the one cleaner each of them uses.
//
// A HEADER link may carry `children` (a second level) and those may carry
// their own (a third). That is Shopify's ceiling too, and it is what a mega
// menu needs: "Shop" → "Men" (a column) → "Shirts", "Trousers" (its links).
// A top-level item with children may also carry `image_url`, a feature tile in
// the desktop panel.
//
// ★ A FLAT LINK CLEANS TO EXACTLY WHAT IT WAS. `children` and `image_url` are
//   OMITTED rather than written as [] / "", so every menu stored before nesting
//   existed round-trips byte for byte — which is what keeps a live header
//   unchanged, and what keeps the Theme Studio contract's "sanitised menus
//   equal the stored menus" check passing for every bundled theme.
// ★ FOOTER LINKS STAY FLAT. A footer column is already the second level, and a
//   collapsible tree at the bottom of every page is not a thing shoppers use —
//   cleanNavLinks drops children rather than storing what nothing renders.
// ★ ONE BUDGET FOR THE WHOLE TREE. Per-level caps alone multiply (12 × 10 × 10
//   is 1,200 links in one jsonb cell, on every page of the store), so the tree
//   also stops at NAV_LIMITS.totalItems, counted in document order — the items
//   a merchant put first are the ones kept.
// ---------------------------------------------------------------------------

export interface NavLink {
  label: string;
  href: string;
  /** Header only: the next level down. Absent, never [], when there is none. */
  children?: NavLink[];
  /** Header top level only, and only with children: a mega-menu tile. */
  image_url?: string;
}

export const NAV_LIMITS = {
  topLevel: 12,
  children: 10,
  grandchildren: 10,
  totalItems: 150,
  label: 60,
  href: 512,
  image: 512,
} as const;

/** Levels below the top a header tree may have: children, then grandchildren. */
const MAX_DEPTH = 3;

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().slice(0, max) : "";

/**
 * An image a menu tile may load: a site path, an https URL, or (inside a theme
 * package, before publication) a `theme-asset://` slot. Everything else — an
 * http URL, a protocol-relative one, `javascript:` or `data:` — is dropped,
 * because this string becomes an <img src> on every page of the store.
 */
export function isSafeNavImage(url: string): boolean {
  if (!url) return false;
  if (url.startsWith("/")) return !url.startsWith("//");
  if (/^theme-asset:\/\/[a-z0-9][a-z0-9-]*$/.test(url)) return true;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** A flat label→href link: the footer's shape, and the old header's. */
function cleanFlatLink(raw: unknown): NavLink | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const label = str(r.label, NAV_LIMITS.label);
  const href = str(r.href, NAV_LIMITS.href);
  if (!label || !href) return null;
  return { label, href };
}

/** Flat link list, children dropped. Footer columns and the legal row. */
export function cleanNavLinks(
  raw: unknown,
  max: number = NAV_LIMITS.topLevel,
): NavLink[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(cleanFlatLink)
    .filter((l): l is NavLink => l !== null)
    .slice(0, max);
}

const LEVEL_CAP = [
  NAV_LIMITS.topLevel,
  NAV_LIMITS.children,
  NAV_LIMITS.grandchildren,
];

/**
 * The header tree. Same rules as a flat link at every level, plus: an item
 * that HAS children may leave `href` empty (a heading that opens a menu rather
 * than going anywhere), and an item with neither a destination nor anything
 * under it is dropped — it would render as a heading over nothing.
 */
export function cleanNavTree(raw: unknown): NavLink[] {
  const budget = { left: NAV_LIMITS.totalItems };

  const level = (value: unknown, depth: number): NavLink[] => {
    if (!Array.isArray(value)) return [];
    const out: NavLink[] = [];
    for (const item of value) {
      if (out.length >= LEVEL_CAP[depth] || budget.left <= 0) break;
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const label = str(r.label, NAV_LIMITS.label);
      if (!label) continue;
      const href = str(r.href, NAV_LIMITS.href);
      // Reserve this item's place BEFORE its children, so a parent is never
      // dropped for the sake of its own descendants.
      budget.left -= 1;
      const children =
        depth + 1 < MAX_DEPTH ? level(r.children, depth + 1) : [];
      if (!href && children.length === 0) {
        budget.left += 1;
        continue;
      }
      const link: NavLink = { label, href };
      if (children.length) {
        link.children = children;
        const image = str(r.image_url, NAV_LIMITS.image);
        if (depth === 0 && isSafeNavImage(image)) link.image_url = image;
      }
      out.push(link);
    }
    return out;
  };

  return level(raw, 0);
}

/** Every link in a tree, parents before their children. */
export function flattenNav(links: readonly NavLink[]): NavLink[] {
  const out: NavLink[] = [];
  const walk = (list: readonly NavLink[]) => {
    for (const link of list) {
      out.push(link);
      if (link.children) walk(link.children);
    }
  };
  walk(links);
  return out;
}

/**
 * How the desktop header opens a top-level item: not at all, a short list
 * under it, or a full-width panel. A panel is for a menu with COLUMNS (a child
 * with its own links) or a feature image; a list of five links in a
 * full-width panel is a lot of empty screen.
 */
export function navPanelKind(link: NavLink): "none" | "dropdown" | "mega" {
  if (!link.children?.length) return "none";
  if (link.image_url || link.children.some((c) => c.children?.length))
    return "mega";
  return "dropdown";
}
