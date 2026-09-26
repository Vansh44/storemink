import Image from "next/image";
import Link from "next/link";
import type {
  MediaTextConfig,
  SectionStyle,
} from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";

function Cta({ config }: { config: MediaTextConfig }) {
  if (!config.cta_label || !config.cta_href) return null;
  const className = "home-media-text-cta sm-btn-primary";
  if (/^https?:\/\//i.test(config.cta_href)) {
    return (
      <a
        className={className}
        href={config.cta_href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {config.cta_label}
      </a>
    );
  }
  return (
    <Link className={className} href={config.cta_href}>
      {config.cta_label}
    </Link>
  );
}

export function MediaTextSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: MediaTextConfig;
}) {
  if (!config.heading && !config.body && !config.image_url) return null;

  return (
    <SectionShell sectionId={sectionId} style={style}>
      <div
        className={`home-media-text media-${config.media_position} align-${config.alignment}${config.image_url ? "" : " no-media"}`}
      >
        {config.image_url && (
          <div className={`home-media-text-media ratio-${config.media_ratio}`}>
            <Image
              src={config.image_url}
              alt={config.image_alt || config.heading}
              fill
              sizes="(max-width: 760px) 100vw, 50vw"
              className="home-media-text-image"
            />
          </div>
        )}
        <div className="home-media-text-copy">
          {config.eyebrow && (
            <p className="home-section-eyebrow">{config.eyebrow}</p>
          )}
          {config.heading && (
            <h2 className="home-media-text-heading">{config.heading}</h2>
          )}
          {config.body && <p className="home-media-text-body">{config.body}</p>}
          <Cta config={config} />
        </div>
      </div>
    </SectionShell>
  );
}
