import Link from "next/link";
import Image from "next/image";
import { ImageIcon } from "lucide-react";
import { collectionPath } from "@/lib/storefront/collection-links";
import type {
  SectionStyle,
  ShopByCategoryConfig,
} from "@/lib/homepage/section-types";
import { SectionShell } from "../sections/section-shell";

import { HorizontalCarousel } from "./horizontal-carousel";

export interface CategoryTile {
  id: string;
  name: string;
  slug: string;
  image_url: string | null;
}

// Presentational: receives the resolved, ordered categories. Tiles link to
// each category's own page. Renders nothing when there are no categories.
export function ShopByCategorySection({
  sectionId,
  style,
  config,
  categories,
}: {
  sectionId: string;
  style?: SectionStyle;
  config: ShopByCategoryConfig;
  categories: CategoryTile[];
}) {
  if (categories.length === 0) return null;

  const content = categories.map((c) => (
    <Link key={c.id} href={collectionPath(c.slug)} className="home-cat-tile">
      <div className="home-cat-img">
        {c.image_url ? (
          <Image
            src={c.image_url}
            alt=""
            fill
            sizes="(max-width: 768px) 40vw, 200px"
            className="home-cat-img-el"
          />
        ) : (
          <div className="home-cat-img-placeholder">
            <ImageIcon size={28} strokeWidth={1.5} aria-hidden />
          </div>
        )}
      </div>
      <span className="home-cat-name">{c.name}</span>
    </Link>
  ));

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
      {config.layout === "grid" ? (
        <div
          className={`home-cat-grid${config.display === "cards" ? " is-cards" : ""}`}
        >
          {content}
        </div>
      ) : (
        <HorizontalCarousel
          carouselClass="home-cat-carousel"
          scrollClass={`home-cat-scroll${config.display === "cards" ? " is-cards" : ""}`}
          arrowClass="home-cat-arrow"
        >
          {content}
        </HorizontalCarousel>
      )}
    </SectionShell>
  );
}
