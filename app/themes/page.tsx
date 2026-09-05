import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Palette,
  ShoppingBag,
  Smartphone,
  Sparkles,
} from "lucide-react";
import { BrandMark } from "@/app/platform/brand-mark";
import { PLATFORM_URL, THEMES_URL } from "@/lib/site";
import { ROOT_DOMAIN } from "@/lib/store/host";
import {
  THEME_CATEGORIES,
  THEME_META,
  canPreviewTheme,
  isThemeSelectable,
  newestThemesFirst,
  type ThemeIndustry,
  type ThemeMeta,
} from "@/lib/themes/meta";
import {
  ThemeClosingArt,
  ThemeHeroStage,
  type ShowcaseTheme,
} from "./theme-showcases";
import { ThemeCatalogCarousel } from "./theme-catalog-carousel";

const FEATURE_LABELS: Record<string, string> = {
  "advanced-search": "Advanced search",
  blogs: "Editorial blog",
  "cart-drawer": "Cart drawer",
  "category-navigation": "Category navigation",
  faq: "FAQ layouts",
  "product-filtering": "Product filtering",
  "product-recommendations": "Product recommendations",
  "promo-tiles": "Promotion tiles",
  "quick-add": "Quick add",
  "variant-picker": "Variant picker",
};

const STANDARD_ITEMS = [
  {
    icon: Smartphone,
    number: "01",
    title: "Composed for every screen",
    body: "Layouts are shaped for mobile from the start, with tap targets, typography and merchandising that feel intentional at every size.",
  },
  {
    icon: ShoppingBag,
    number: "02",
    title: "Built around the buying journey",
    body: "Discovery, product options, cart states and content extremes are reviewed with real catalog data before release.",
  },
  {
    icon: Palette,
    number: "03",
    title: "Made to become yours",
    body: "Change color, type, imagery and sections without code—while the theme keeps the details beautifully coherent.",
  },
] as const;

function demoUrl(slug: string) {
  return `https://${slug}.${ROOT_DOMAIN}`;
}

function statusLabel(theme: ThemeMeta) {
  if (theme.catalog.visibility === "legacy") return "Foundation theme";
  if (theme.release.status === "published") return "Available";
  if (theme.release.status === "approved") return "Approved";
  return "In review";
}

function industryLabel(theme: ThemeMeta) {
  return theme.catalog.industries.join(" · ").replaceAll("-", " ");
}

export default async function ThemesPage({
  searchParams,
}: {
  searchParams: Promise<{ industry?: string }>;
}) {
  const requested = (await searchParams).industry;
  const selected: ThemeIndustry | "all" = THEME_CATEGORIES.some(
    (category) => category.id === requested,
  )
    ? (requested as ThemeIndustry | "all")
    : "all";
  const selectableThemes = newestThemesFirst(
    THEME_META.filter(isThemeSelectable),
  );
  const showcaseThemes: ShowcaseTheme[] = selectableThemes.map((theme) => ({
    id: theme.id,
    name: theme.name,
    industry: industryLabel(theme),
    previewImage: theme.catalog.previewImage,
    previewAlt:
      theme.catalog.screenshots[0]?.alt ?? `${theme.name} theme preview`,
  }));
  const themes = selectableThemes.filter(
    (theme) =>
      selected === "all" || theme.catalog.industries.includes(selected),
  );

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "StoreMink Themes",
    url: THEMES_URL,
    description:
      "A curated catalog of responsive, commerce-ready StoreMink storefront themes.",
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: themes.length,
      itemListElement: themes.map((theme, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: theme.name,
        url: `${THEMES_URL}/#${theme.id}`,
      })),
    },
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <aside className="themes-announcement">
        <span>StoreMink themes</span>
        <p>Beautiful by default. Unmistakably yours.</p>
        <a href="#catalog">
          Explore the collection <ArrowRight size={14} aria-hidden />
        </a>
      </aside>

      {/* Full-bleed shell so the inset row can stick without the page
          scrolling past either side of it — the same wrapper
          .smh-header / .posx-nav-shell / .hc-topbar provide. */}
      <div className="themes-nav-shell">
        <header className="themes-nav">
          <Link
            href={THEMES_URL}
            className="themes-wordmark"
            aria-label="StoreMink Themes home"
          >
            <BrandMark size={29} priority />
            <span aria-hidden="true">
              Store<em>Mink</em>
            </span>
            <i aria-hidden="true">Themes</i>
          </Link>
          <nav aria-label="Theme catalog navigation">
            <a href="#catalog">Browse themes</a>
            <a href="#standard">Why StoreMink</a>
            <a href="https://help.storemink.com">Help</a>
            <Link href={`${PLATFORM_URL}/signup`} className="themes-nav-cta">
              Start your store <ArrowUpRight size={15} aria-hidden />
            </Link>
          </nav>
        </header>
      </div>

      <main>
        <section className="themes-hero">
          <div className="themes-hero-content">
            <p className="themes-kicker">
              <Sparkles size={15} aria-hidden /> Curated storefront design
            </p>
            <h1>
              Make your store <br />
              impossible to <i>scroll past.</i>
            </h1>
            <p className="themes-hero-copy">
              Commerce-ready themes with the polish of a custom build. Pick a
              distinctive starting point, shape every detail to your brand, and
              launch without touching code.
            </p>
            <div className="themes-hero-actions">
              <a href="#catalog" className="themes-primary-action">
                Browse all themes <ArrowRight size={18} aria-hidden />
              </a>
              <a href="#standard" className="themes-secondary-action">
                See what&apos;s included
              </a>
            </div>
            <div className="themes-proof" aria-label="Theme quality promises">
              <span>
                <Check size={14} aria-hidden /> No-code editing
              </span>
              <span>
                <Check size={14} aria-hidden /> Mobile composed
              </span>
              <span>
                <Check size={14} aria-hidden /> Commerce tested
              </span>
            </div>
          </div>

          <ThemeHeroStage themes={showcaseThemes} />
        </section>

        <section className="themes-catalog" id="catalog">
          <div className="themes-catalog-head">
            <div>
              <p className="themes-overline">Find your starting point</p>
              <h2>
                Designed to sell.
                <br />
                Ready to make yours.
              </h2>
            </div>
            <p>
              Each theme is a complete point of view—not just a new color
              palette. Browse by business, preview the real storefront, then
              customize every surface in StoreMink.
            </p>
          </div>

          <nav
            className="themes-filters"
            aria-label="Filter themes by industry"
          >
            {THEME_CATEGORIES.map((category) => (
              <Link
                key={category.id}
                href={
                  category.id === "all"
                    ? "/#catalog"
                    : `/?industry=${category.id}#catalog`
                }
                aria-current={selected === category.id ? "page" : undefined}
              >
                {category.label}
              </Link>
            ))}
          </nav>

          <ThemeCatalogCarousel count={themes.length}>
            {themes.map((theme, index) => {
              const previewable = canPreviewTheme(theme);
              return (
                <article className="theme-card" id={theme.id} key={theme.id}>
                  <div className="theme-card-visual">
                    <Image
                      src={theme.catalog.previewImage}
                      alt={`${theme.name} theme storefront preview`}
                      fill
                      sizes="(max-width: 680px) 86vw, (max-width: 1180px) 34vw, 390px"
                      loading={index === 0 ? "eager" : "lazy"}
                    />
                    <div className="theme-card-badges">
                      <span>{statusLabel(theme)}</span>
                      <span>
                        {theme.catalog.minPlan
                          ? `${theme.catalog.minPlan}+`
                          : "All plans"}
                      </span>
                    </div>
                    {previewable && (
                      <a
                        className="theme-preview-action"
                        href={demoUrl(theme.demo.slug)}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Preview ${theme.name} theme`}
                      >
                        Live preview <ArrowUpRight size={16} aria-hidden />
                      </a>
                    )}
                  </div>

                  <div className="theme-card-content">
                    <p className="theme-eyebrow">{industryLabel(theme)}</p>
                    <div className="theme-card-title">
                      <h3>{theme.name}</h3>
                      <span>{String(index + 1).padStart(2, "0")}</span>
                    </div>
                    <p className="theme-description">{theme.description}</p>
                    <ul
                      className="theme-features"
                      aria-label={`${theme.name} features`}
                    >
                      {theme.catalog.features.slice(0, 4).map((feature) => (
                        <li key={feature}>
                          <Check size={12} aria-hidden />
                          {FEATURE_LABELS[feature] ?? feature}
                        </li>
                      ))}
                    </ul>
                    <div className="theme-card-actions">
                      {previewable ? (
                        <a
                          href={demoUrl(theme.demo.slug)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          View live store <ArrowUpRight size={15} aria-hidden />
                        </a>
                      ) : (
                        <span
                          className="theme-preview-offline"
                          title={theme.demo.unavailableReason}
                        >
                          Live preview being restored
                        </span>
                      )}
                      <Link href={`${PLATFORM_URL}/signup`}>
                        Start with {theme.name}{" "}
                        <ArrowRight size={15} aria-hidden />
                      </Link>
                    </div>
                  </div>
                </article>
              );
            })}
          </ThemeCatalogCarousel>
        </section>

        <section className="themes-standard" id="standard">
          <div className="themes-standard-intro">
            <p className="themes-overline">The StoreMink standard</p>
            <h2>More than a beautiful first impression.</h2>
            <p>
              The details people notice—and the ones they don&apos;t have to—are
              already considered. Your job is to make it feel like your brand.
            </p>
          </div>
          <div className="themes-standard-grid">
            {STANDARD_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <article key={item.number}>
                  <div className="themes-standard-icon">
                    <Icon size={23} strokeWidth={1.6} aria-hidden />
                    <span>{item.number}</span>
                  </div>
                  <h3>{item.title}</h3>
                  <p>{item.body}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section className="themes-closing">
          <ThemeClosingArt themes={showcaseThemes} />
          <div className="themes-closing-copy">
            <p className="themes-overline">Your next chapter starts here</p>
            <h2>
              Launch beautifully.
              <br />
              <i>Grow confidently.</i>
            </h2>
            <p>
              Start with a polished storefront today, then keep shaping it as
              your catalog, customers and ambition grow.
            </p>
            <Link href={`${PLATFORM_URL}/signup`}>
              Start your free store <ArrowUpRight size={17} aria-hidden />
            </Link>
          </div>
        </section>
      </main>

      <footer className="themes-footer">
        <div>
          <div className="themes-wordmark">
            <BrandMark size={26} />
            <span>
              Store<em>Mink</em>
            </span>
            <i>Themes</i>
          </div>
          <p>Professional storefronts. No code required.</p>
        </div>
        <nav aria-label="Footer navigation">
          <Link href={PLATFORM_URL}>StoreMink</Link>
          <a href="#catalog">Themes</a>
          <a href="https://help.storemink.com">Help Centre</a>
          <Link href={`${PLATFORM_URL}/signup`}>Create a store</Link>
        </nav>
        <p className="themes-footer-note">Made for independent brands.</p>
      </footer>
    </>
  );
}
