/**
 * StoreMink's own brand identity for structured data — the platform entity, not
 * a merchant's store.
 *
 * This lives in one module because the SAME Organization node has to be emitted
 * from two hosts (the apex and help.storemink.com) under one `@id`. Two
 * hand-written copies would drift, and a drifted entity is worse than one
 * absent: search engines would see two different descriptions of the thing at
 * `https://storemink.com/#organization`.
 *
 * Pure — imports only dependency-free host and brand-asset constants.
 */
import { PLATFORM_URL } from "@/lib/store/host";
import { STOREMINK_LOGO } from "@/lib/brand-assets";

/**
 * Official profiles, for schema.org `sameAs`.
 *
 * `sameAs` is an ASSERTION that these accounts are this organisation. It is one
 * of the strongest corroborating signals for a brand query, and it works both
 * ways round: each profile should also list storemink.com as its website, so
 * the claim can be confirmed rather than just made.
 *
 * Rules for this list, all of which cost real ranking if broken:
 *  - PUBLIC profile URLs only. An admin/dashboard URL
 *    (linkedin.com/company/<id>/admin/...) is behind a login and identifies a
 *    session, not the brand — it must never appear here.
 *  - Canonical form only. LinkedIn's own <link rel="canonical"> is
 *    /company/storemink, so no /home/ suffix and no trailing slash.
 *  - Only accounts we actually control. A wrong handle claims someone else's
 *    account is us.
 *
 * Verified live 2026-07-29: the YouTube and LinkedIn pages both carry the
 * StoreMink name and the site's own tagline; the Instagram payload carries the
 * display name "StoreMink" (a nonexistent handle's does not).
 */
export const BRAND_SAME_AS: readonly string[] = [
  "https://www.linkedin.com/company/storemink",
  "https://www.youtube.com/@storemink",
  "https://www.instagram.com/storemink.official",
];

export const SUPPORT_EMAIL = "support@storemink.com";

export const BRAND_TAGLINE = "Build what's yours.";

export const BRAND_DESCRIPTION =
  "StoreMink is the AI-native business operating system for independent brands, bringing commerce, operations and intelligence together in one platform.";

/**
 * Safe fallbacks for Google's automated site-name system.
 *
 * Keep the invented brand as one word. "store mink" is an ordinary phrase
 * about mink storage and was causing Google to associate the company with fur
 * care. Google explicitly supports the lowercase domain as the final fallback
 * when the preferred site name is not yet recognised.
 */
const ALTERNATE_NAMES = [
  "Storemink",
  "storemink.com",
  "StoreMink",
  "storemink",
  "store mink",
  "Store Mink",
  "storemink.com | Build what's yours.",
];

/**
 * The platform Organization node. Emitted on the apex AND the help centre under
 * one `@id`, so every help article's publisher resolves to this same entity
 * (see helpArticleSchema in ./schema.ts).
 */
export function platformOrganizationSchema(): Record<string, unknown> {
  return {
    "@type": "Organization",
    "@id": `${PLATFORM_URL}/#organization`,
    name: "StoreMink",
    alternateName: ALTERNATE_NAMES,
    url: PLATFORM_URL,
    logo: `${PLATFORM_URL}${STOREMINK_LOGO}`,
    description: BRAND_DESCRIPTION,
    sameAs: [...BRAND_SAME_AS],
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: SUPPORT_EMAIL,
      url: `https://help.${PLATFORM_URL.replace(/^https?:\/\//, "")}`,
      availableLanguage: ["en"],
    },
    address: { "@type": "PostalAddress", addressCountry: "IN" },
  };
}

/** The platform WebSite node, publisher-linked to the Organization above. */
export function platformWebsiteSchema(): Record<string, unknown> {
  return {
    "@type": "WebSite",
    "@id": `${PLATFORM_URL}/#website`,
    name: "StoreMink",
    alternateName: ALTERNATE_NAMES,
    url: PLATFORM_URL,
    publisher: { "@id": `${PLATFORM_URL}/#organization` },
  };
}

/**
 * Footer link labels for the same profiles. Kept beside BRAND_SAME_AS so a
 * profile can't be claimed in schema without also being linked in the page —
 * a `sameAs` with no visible corresponding link is a weaker signal, and an
 * unreachable brand looks unfinished to a human reader too.
 */
export const BRAND_SOCIAL_LINKS: readonly { label: string; href: string }[] = [
  { label: "LinkedIn", href: "https://www.linkedin.com/company/storemink" },
  { label: "YouTube", href: "https://www.youtube.com/@storemink" },
  { label: "Instagram", href: "https://www.instagram.com/storemink.official" },
];
