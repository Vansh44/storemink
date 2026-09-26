import type {
  NewsletterSectionConfig,
  SectionStyle,
} from "@/lib/homepage/section-types";
import { NewsletterForm } from "../newsletter-form";
import { SectionShell } from "./section-shell";

export function NewsletterSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: NewsletterSectionConfig;
}) {
  if (!config.heading && !config.subheading) return null;
  return (
    <SectionShell sectionId={sectionId} style={style}>
      <div
        className={`home-newsletter theme-${config.theme} align-${config.alignment}`}
      >
        <div className="home-newsletter-copy">
          {config.eyebrow && (
            <p className="home-section-eyebrow">{config.eyebrow}</p>
          )}
          {config.heading && (
            <h2 className="home-newsletter-heading">{config.heading}</h2>
          )}
          {config.subheading && (
            <p className="home-newsletter-sub">{config.subheading}</p>
          )}
        </div>
        <NewsletterForm
          source="section"
          buttonLabel={config.button_label}
          consentText={config.consent_text}
          successMessage={config.success_message}
          classes={{
            form: "home-newsletter-form",
            fields: "home-newsletter-fields",
            input: "home-newsletter-input",
            button: "home-newsletter-button sm-btn-primary",
            consent: "home-newsletter-consent",
            message: "home-newsletter-message",
          }}
        />
      </div>
    </SectionShell>
  );
}
