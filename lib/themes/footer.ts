import { DEFAULT_CHROME, type StoreChrome } from "@/lib/chrome/types";
import type { ThemeDefinition } from "./types";
import type { NewsletterSectionConfig } from "@/lib/homepage/section-types";

/** Carry the theme's homepage newsletter voice onto commerce pages when the
 * store still has platform-default footer copy. Merchant-written copy wins. */
export function withThemeNewsletter(
  chrome: StoreChrome,
  theme: ThemeDefinition | null,
): StoreChrome {
  const current = chrome.footer.newsletter;
  const defaults = DEFAULT_CHROME.footer.newsletter;
  const keys = ["heading", "subtext", "buttonLabel", "consentText"] as const;
  if (!keys.every((key) => current[key] === defaults[key])) return chrome;
  const section = theme?.preset.pages
    .find((p) => p.slug === "")
    ?.sections.find((s) => s.enabled && s.type === "newsletter");
  if (!section || section.type !== "newsletter") return chrome;
  const config = section.config as NewsletterSectionConfig;
  if (!config.heading.trim()) return chrome;
  return {
    ...chrome,
    footer: {
      ...chrome.footer,
      newsletter: {
        ...current,
        heading: config.heading,
        subtext: config.subheading || current.subtext,
        buttonLabel: config.button_label || current.buttonLabel,
        consentText: config.consent_text || current.consentText,
      },
    },
  };
}
