import { expect, it } from "vitest";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import { studio } from "./definitions/studio";
import { withThemeNewsletter } from "./footer";
import type { NewsletterSectionConfig } from "@/lib/homepage/section-types";

it("shares the homepage newsletter voice with default commerce footers without changing toggles", () => {
  const theme = structuredClone(studio);
  const section = theme.preset.pages
    .find((p) => p.slug === "")!
    .sections.find((s) => s.type === "newsletter")!;
  if (section.type !== "newsletter") throw new Error("fixture");
  const config = section.config as NewsletterSectionConfig;
  config.heading = "The Atelier Dispatch";
  config.subheading = "Private collection previews.";
  const chrome = structuredClone(DEFAULT_CHROME);
  chrome.footer.newsletter.enabled = false;
  const next = withThemeNewsletter(chrome, theme);
  expect(next.footer.newsletter.heading).toBe("The Atelier Dispatch");
  expect(next.footer.newsletter.subtext).toBe("Private collection previews.");
  expect(next.footer.newsletter.enabled).toBe(false);
  expect(chrome.footer.newsletter.heading).toBe("Stay in the loop");
});

it("preserves merchant copy and themes without a newsletter", () => {
  const chrome = structuredClone(DEFAULT_CHROME);
  chrome.footer.newsletter.heading = "Our subscriber club";
  expect(withThemeNewsletter(chrome, studio)).toBe(chrome);
  expect(withThemeNewsletter(DEFAULT_CHROME, null)).toBe(DEFAULT_CHROME);
});
