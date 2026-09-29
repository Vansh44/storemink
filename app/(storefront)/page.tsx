import type { Metadata } from "next";
import StructuredData from "@/app/(storefront)/components/structured-data";
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
import "@/app/(storefront)/(pages)/shop/shop.css"; // .shop-card styles for product sections
import "@/app/(storefront)/components/homepage/homepage.css";
import { getStoreSetting } from "@/lib/settings/resolve";

// The storefront homepage is the store_pages row with the empty slug (""), the
// "homepage sentinel". It's edited in /dashboard/builder like any other page —
// same section model, same draft → publish flow, same preview. The hero is just
// a custom_code section, so it's fully editable too. See CODEBASE.md §11.
//
// Storefront reads are cached per store (unstable_cache); the route stays
// dynamic only because requireStorefrontStoreId reads headers().
export const revalidate = 300;

const HOME_SLUG = "";

type Props = {
  searchParams: Promise<{ preview?: string }>;
};

const isPreview = (sp: { preview?: string }) => sp.preview === "1";

export async function generateMetadata({
  searchParams,
}: Props): Promise<Metadata> {
  const sp = await searchParams;
  const brand = await getStoreBrand();
  const fallbackTitle = brand.tagline
    ? `${brand.name} | ${brand.tagline}`
    : brand.name;

  // Preview renders draft content — always noindex.
  if (isPreview(sp)) {
    return {
      title: { absolute: `${brand.name} (preview)` },
      robots: { index: false, follow: false },
    };
  }

  const storeId = await requireStorefrontStoreId();
  const page = await getPublishedPage(storeId, HOME_SLUG);
  const title = page?.seo_title || fallbackTitle;
  const description = page?.seo_description || brand.tagline || undefined;
  // No dedicated homepage image field → a generated branded card (name +
  // tagline on the brand colour) so shares aren't imageless.
  const ogImage = brandOgImageUrl({
    title: brand.name,
    subtitle: brand.tagline,
    color: brand.primaryColor,
  });
  return {
    title: { absolute: title },
    description,
    alternates: { canonical: "/" },
    ...(page?.seo_noindex ? { robots: { index: false, follow: false } } : {}),
    openGraph: {
      title,
      description,
      url: "/",
      type: "website",
      images: [{ url: ogImage, width: 1200, height: 630, alt: brand.name }],
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
        <StructuredData />
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
      <StructuredData />
      <PageSectionRenderer sections={entitledSections} resolved={resolved} />
    </main>
  );
}

export default async function Home({ searchParams }: Props) {
  const sp = await searchParams;
  const storeId = await requireStorefrontStoreId();

  // Builder preview: draft sections, admin-gated + uncached. Unauthorized or
  // missing → fall through to the published render (never leak, never error).
  if (isPreview(sp)) {
    const draft = await getDraftPageForPreview(storeId, HOME_SLUG);
    if (draft) return renderSections(draft.sections ?? [], storeId, true);
  }

  const page = await getPublishedPage(storeId, HOME_SLUG);
  if (!page) {
    // No published homepage yet — render an empty shell (still valid + indexable
    // via metadata). The merchant builds it in /dashboard/builder.
    return (
      <main>
        <StructuredData />
      </main>
    );
  }

  return renderSections(page.published_sections ?? [], storeId, false);
}
