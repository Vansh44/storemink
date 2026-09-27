// Per-store navigation menus (header + footer). Stored in the store_menus table
// (one row per store, jsonb columns) and edited in /dashboard/navigation. The
// storefront reads them cached (lib/storefront/queries getStoreMenus, tag
// TAGS.menus) and hands them to Header/Footer via the MenuProvider.
//
// Label→href link lists. hrefs are internal paths (e.g. "/shop", "/our-story")
// or absolute URLs; they are rendered as-is, so validate on save. The HEADER
// list is a tree (children, grandchildren, an optional mega-menu image); the
// footer lists stay flat. The shape and its cleaners live in lib/chrome/nav.ts,
// shared with store_chrome, so a theme's menus and a merchant's are one thing.

import { cleanNavLinks, cleanNavTree, type NavLink } from "@/lib/chrome/nav";

export type MenuLink = NavLink;

export interface FooterGroup {
  title: string;
  links: MenuLink[];
}

export interface StoreMenus {
  /** Top navigation bar (desktop + mobile drawer). */
  header: MenuLink[];
  /** Footer link columns (each a titled group). */
  footerGroups: FooterGroup[];
  /** Footer legal row (Privacy, Terms, …). */
  footerLegal: MenuLink[];
}

// Sensible defaults — WholeSip's original hardcoded nav. Used as the fallback
// for any store without a store_menus row, and as the seed a merchant starts
// from. A store can trim/replace these in the dashboard.
export const DEFAULT_MENUS: StoreMenus = {
  header: [
    { label: "Shop", href: "/shop" },
    { label: "Track Order", href: "/track-order" },
    { label: "Find Us", href: "/find-us" },
    { label: "Enquiries", href: "/enquiries" },
    { label: "Blogs", href: "/blogs" },
  ],
  footerGroups: [
    {
      title: "Shop",
      links: [
        { label: "All Products", href: "/shop" },
        { label: "Gift Packs", href: "/gift-packs" },
      ],
    },
    {
      title: "Company",
      links: [
        { label: "Our Story", href: "/our-story" },
        { label: "Blog", href: "/blogs" },
        { label: "Contact Us", href: "/contact" },
      ],
    },
    {
      title: "Support",
      links: [
        { label: "FAQs", href: "/faqs" },
        { label: "Track My Order", href: "/track-order" },
        { label: "Returns & Refunds", href: "/returns" },
        { label: "Shipping Info", href: "/shipping" },
      ],
    },
  ],
  footerLegal: [
    { label: "Privacy Policy", href: "/privacy-policy" },
    { label: "Terms of Use", href: "/terms" },
    { label: "Refund Policy", href: "/refund-policy" },
    { label: "Cookie Policy", href: "/cookie-policy" },
  ],
};

// Caps to keep menus sane and the payload small.
const MAX_GROUPS = 6;
const MAX_LABEL = 60;

const cleanLinks = (raw: unknown): MenuLink[] => cleanNavLinks(raw);

function cleanGroups(raw: unknown): FooterGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((g): FooterGroup | null => {
      if (!g || typeof g !== "object") return null;
      const gr = g as Record<string, unknown>;
      const title =
        typeof gr.title === "string" ? gr.title.trim().slice(0, MAX_LABEL) : "";
      const links = cleanLinks(gr.links);
      if (!title && links.length === 0) return null;
      return { title, links };
    })
    .filter((g): g is FooterGroup => g !== null)
    .slice(0, MAX_GROUPS);
}

/**
 * Coerce arbitrary jsonb (a store_menus row, or user input on save) into a
 * valid StoreMenus. Each field that is missing/empty falls back to DEFAULT_MENUS
 * so the storefront always has usable nav.
 */
export function normalizeMenus(raw: unknown): StoreMenus {
  const r = (raw ?? {}) as Record<string, unknown>;
  const header = cleanNavTree(r.header);
  const footerGroups = cleanGroups(r.footerGroups ?? r.footer_groups);
  const footerLegal = cleanLinks(r.footerLegal ?? r.footer_legal);
  return {
    header: header.length ? header : DEFAULT_MENUS.header,
    footerGroups: footerGroups.length
      ? footerGroups
      : DEFAULT_MENUS.footerGroups,
    footerLegal: footerLegal.length ? footerLegal : DEFAULT_MENUS.footerLegal,
  };
}

/** Sanitize input for saving — same cleaning, but empty fields stay empty
 *  (an explicit choice to have no links), not replaced by defaults. */
export function sanitizeMenusForSave(raw: unknown): StoreMenus {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    header: cleanNavTree(r.header),
    footerGroups: cleanGroups(r.footerGroups ?? r.footer_groups),
    footerLegal: cleanLinks(r.footerLegal ?? r.footer_legal),
  };
}
