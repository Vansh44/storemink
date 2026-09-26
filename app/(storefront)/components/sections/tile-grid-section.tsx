import Link from "next/link";
import Image from "next/image";
import type {
  SectionStyle,
  TileGridConfig,
  TileItem,
} from "@/lib/homepage/section-types";
import { SectionShell } from "./section-shell";
import { MediaTone } from "./media-tone";

// One tile: colour field and/or cover image with a text overlay. Linked tiles
// wrap in next/link (internal) or a plain anchor (external); unlinked tiles
// stay a div. Tile `background` is a strict colour (safeColor) — safe inline.
function Tile({ tile }: { tile: TileItem }) {
  const inner = (
    <>
      {tile.image_url && (
        <Image
          src={tile.image_url}
          alt={tile.title || "Tile"}
          fill
          sizes="(max-width: 760px) 50vw, 320px"
          className="home-tile-img"
        />
      )}
      {tile.image_url && (tile.title || tile.subtitle) && (
        <MediaTone preferred={tile.theme} copy=".home-tile-copy" />
      )}
      {(tile.title || tile.subtitle) && (
        <span className="home-tile-copy">
          {tile.title && <span className="home-tile-title">{tile.title}</span>}
          {tile.subtitle && (
            <span className="home-tile-sub">{tile.subtitle}</span>
          )}
        </span>
      )}
    </>
  );

  const className = `home-tile theme-${tile.theme}`;
  const styleAttr = tile.background
    ? { background: tile.background }
    : undefined;

  if (tile.href && /^https?:\/\//i.test(tile.href)) {
    return (
      <a
        className={className}
        style={styleAttr}
        href={tile.href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {inner}
      </a>
    );
  }
  if (tile.href) {
    return (
      <Link className={className} style={styleAttr} href={tile.href}>
        {inner}
      </Link>
    );
  }
  return (
    <div className={className} style={styleAttr}>
      {inner}
    </div>
  );
}

// Grid of linked colour/image tiles — offer tiles, curated collections,
// 2-up mini banners. Columns are the desktop count; wraps down responsively.
export function TileGridSection({
  sectionId,
  style,
  config,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: TileGridConfig;
}) {
  if (config.tiles.length === 0) return null;

  return (
    <SectionShell sectionId={sectionId} style={style}>
      {(config.heading || config.subheading) && (
        <div className="home-section-head">
          {config.heading && (
            <h2 className="home-section-title">{config.heading}</h2>
          )}
          {config.subheading && (
            <p className="home-section-sub">{config.subheading}</p>
          )}
        </div>
      )}
      <div
        className={`home-tile-grid cols-${config.columns} size-${config.height}`}
      >
        {config.tiles.map((tile, i) => (
          <Tile key={i} tile={tile} />
        ))}
      </div>
    </SectionShell>
  );
}
