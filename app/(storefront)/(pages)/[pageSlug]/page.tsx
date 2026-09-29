import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireStorefrontStoreId } from "@/lib/store/resolve";
import { getStoreBrand } from "@/lib/store/brand";
import { brandOgImageUrl } from "@/lib/seo/og-card";
import { getPublishedPage } from "@/lib/storefront/queries";
import { getDraftPageForPreview } from "@/lib/pages/preview";
import {
  fetchSectionDatasets,
  resolveSectionData,
} from "@/lib/sections/resolve-data";
import { PageSectionRenderer } from "@/app/(storefront)/components/sections/page-section-renderer";
import { DraftCanvas } from "@/app/(storefront)/components/sections/draft-canvas";
import {
  PreviewBridge,
  PreviewBadge,
} from "@/app/(storefront)/components/sections/preview-bridge";
import { BuilderOverlay } from "@/app/(storefront)/components/sections/builder-overlay";
import type { PageSectionItem } from "@/lib/sections/registry";
import { getStoreSetting } from "@/lib/settings/resolve";
import "@/app/(storefront)/(pages)/shop/shop.css"; // .shop-card styles for product sections
import "@/app/(storefront)/components/homepage/homepage.css";

// Custom merchant pages built in /dashboard/builder. This dynamic segment sits
// alongside the static (pages)/* routes; App Router serves the static siblings
// (shop, blogs, our-story, …) first, so this only ever handles slugs that don't
// match a built-in route. Unknown slugs fall through to a cached 404.
//
// Storefront reads are cached per store (unstable_cache); the page stays
// dynamic only because requireStorefrontStoreId reads headers().
export const revalidate = 300;

type Props = {
  params: Promise<{ pageSlug: string }>;
  searchParams: Promise<{ preview?: string }>;
};

const isPreview = (sp: { preview?: string }) => sp.preview === "1";

export async function generateMetadata({
  params,
  searchParams,
}: Props): Promise<Metadata> {
  const [{ pageSlug }, sp] = await Promise.all([params, searchParams]);
  const storeId = await requireStorefrontStoreId();

  // Preview renders draft content — always noindex, minimal metadata.
  if (isPreview(sp)) {
    const draft = await getDraftPageForPreview(storeId, pageSlug);
    if (draft) {
      return {
        title: `${draft.title || draft.slug} (preview)`,
        robots: { index: false, follow: false },
      };
    }
  }

  const page = await getPublishedPage(storeId, pageSlug);
  if (!page) return {};

  const brand = await getStoreBrand();
  const title = page.seo_title || page.title || brand.name;
  const description = page.seo_description || undefined;
  // Custom pages have no image field → a generated branded card (page title
  // over the brand name/colour), so shares aren't imageless.
  const ogImage = brandOgImageUrl({
    title: page.title || brand.name,
    subtitle: brand.name,
    color: brand.primaryColor,
  });
  return {
    title,
    description,
    alternates: { canonical: `/${page.slug}` },
    ...(page.seo_noindex ? { robots: { index: false, follow: false } } : {}),
    openGraph: {
      title,
      description,
      url: `/${page.slug}`,
      type: "website",
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  };
}

async function renderSections(
  sections: PageSectionItem[],
  storeId: string,
  preview: boolean,
) {
  const allowCustomCode = Boolean(await getStoreSetting("pages.customCode"));
  const entitledSections = allowCustomCode
    ? sections
    : sections.filter((section) => section.type !== "custom_code");
  if (preview) {
    // Builder preview: sections render CLIENT-side (DraftCanvas) so builder
    // edits paint instantly via the `sm-draft` postMessage — ship the full
    // dataset snapshots so local re-resolution never lacks data.
    const datasets = await fetchSectionDatasets(entitledSections, storeId, {
      all: true,
    });
    return (
      <main>
        <DraftCanvas initialSections={entitledSections} datasets={datasets} />
        <PreviewBridge />
        <PreviewBadge />
        <BuilderOverlay />
      </main>
    );
  }
  const resolved = await resolveSectionData(
    entitledSections.filter((s) => s.enabled),
    storeId,
  );
  return (
    <main>
      <PageSectionRenderer sections={entitledSections} resolved={resolved} />
    </main>
  );
}

export default async function StorePage({ params, searchParams }: Props) {
  const [{ pageSlug }, sp] = await Promise.all([params, searchParams]);
  const storeId = await requireStorefrontStoreId();

  // Builder preview: draft sections, admin-gated + uncached. Unauthorized or
  // missing → fall through to the published render (never leak, never error).
  if (isPreview(sp)) {
    const draft = await getDraftPageForPreview(storeId, pageSlug);
    if (draft) {
      return renderSections(draft.sections ?? [], storeId, true);
    }
  }

  const page = await getPublishedPage(storeId, pageSlug);
  if (!page) notFound();

  return renderSections(page.published_sections ?? [], storeId, false);
}
