import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Header from "@/app/(storefront)/components/header/Header";
import Footer from "@/app/(storefront)/components/footer/Footer";
import AuthProvider from "@/app/(storefront)/components/auth/AuthProvider";
import CartProvider from "@/app/(storefront)/components/cart/CartProvider";
import { DeliveryLocationProvider } from "@/app/(storefront)/components/delivery/delivery-location-provider";
import CartDrawer from "@/app/(storefront)/components/cart/CartDrawer";
import AuthModalLoader from "@/app/(storefront)/components/auth/auth-modal-loader";
import { BrandProvider } from "@/app/(storefront)/components/brand-provider";
import { ChromeProvider } from "@/app/(storefront)/components/chrome-provider";
import { notFound } from "next/navigation";
import { cookies, headers } from "next/headers";
import { getStoreBrand } from "@/lib/store/brand";
import { getStoreChrome, getDraftChromeForPreview } from "@/lib/chrome/queries";
import { resolveStorefrontAppearance } from "@/lib/chrome/types";
import { getCurrentStoreOrNull } from "@/lib/store/resolve";
import { isStoreSearchIndexable } from "@/lib/store/launch";
import { getStoreUrl } from "@/lib/site";
import { resolveInstalledThemeDefinition } from "@/lib/themes/runtime-registry";
import { readThemeSelection } from "@/lib/themes/meta";
import { designToCssVars } from "@/lib/themes/types";
import { designOverrideCssVars } from "@/lib/chrome/design";
import { Toaster } from "@/components/ui/sonner";
import { MerchantTracking } from "@/app/(storefront)/components/merchant-tracking";
import { getPlatformAnalyticsFeatures } from "@/lib/analytics/platform-feature-store";
import { analyticsFeatureAllowed } from "@/lib/analytics/features";
import { resolveMerchantPixelSettings } from "@/lib/analytics/merchant-pixels";
import { effectivePlan } from "@/lib/plans";
import {
  GOOGLE_VERIFICATION_TOKEN_KEY,
  normalizeGoogleVerificationToken,
} from "@/lib/seo/store-indexing";
import { SESSION_COOKIE } from "@/lib/auth/constants";
import { STOREMINK_ICONS } from "@/lib/brand-assets";
import "./storefront-theme.css";

// Per-store default title/template + canonical origin. Individual pages may set
// their own title; this is the fallback and the "%s | Brand" suffix, and
// metadataBase makes OG/canonical URLs resolve to this store's own domain.
export async function generateMetadata(): Promise<Metadata> {
  // Guard like the layout component does: on an unclaimed/suspended host the
  // layout renders the root "store doesn't exist" 404. generateMetadata runs
  // independently, so it must NOT fall back to the WholeSip brand here (that's
  // what getStoreBrand()/getStoreUrl() do) — otherwise the tab title becomes
  // "… | WholeSip" and the favicon becomes WholeSip's logo on the 404.
  const store = await getCurrentStoreOrNull();
  if (!store) {
    return {
      title: "Store not found",
      icons: STOREMINK_ICONS,
      robots: { index: false, follow: false },
    };
  }

  const [brand, siteUrl] = await Promise.all([getStoreBrand(), getStoreUrl()]);
  // The Site Verification API's META method returns a complete <meta> tag.
  // Normalize legacy records as well as current bare-token records before
  // handing the value to Next, whose API renders the tag itself.
  const googleVerification = normalizeGoogleVerificationToken(
    store.settings?.[GOOGLE_VERIFICATION_TOKEN_KEY],
  );
  const searchIndexable = isStoreSearchIndexable(store);
  return {
    metadataBase: new URL(siteUrl),
    title: { default: brand.name, template: `%s | ${brand.name}` },
    description: brand.tagline ?? undefined,
    icons: brand.logoUrl ? { icon: brand.logoUrl } : STOREMINK_ICONS,
    ...(googleVerification
      ? { verification: { google: googleVerification } }
      : {}),
    // New stores contain shared theme seed until the owner publishes something
    // real, and demo stores are permanent shared showcases. robots.txt allows
    // crawlers to fetch these public pages specifically so this directive can
    // remove any stale copies that were indexed before the launch gate existed.
    ...(searchIndexable
      ? {}
      : { robots: { index: false, follow: false, nocache: true } }),
  };
}

export default async function StorefrontLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // An unclaimed subdomain / unknown custom domain must NOT fall back to the
  // WholeSip storefront — render a proper "store not found" 404 instead. This
  // one guard covers every storefront page (they all render inside this layout).
  const store = await getCurrentStoreOrNull();
  if (!store) notFound();

  // Anonymous storefronts do not need Firebase's browser SDK on their initial
  // route. A server cookie means identity must be restored immediately; with
  // no cookie the provider starts Firebase only if the account UI is opened.
  const hasCustomerSession = (await cookies()).has(SESSION_COOKIE);

  // Chrome: the PUBLISHED header/footer, except inside the builder's preview
  // iframe where the admin is shown their unsaved draft.
  //
  // The ?preview=1 flag arrives as a header because a LAYOUT cannot read
  // searchParams (Next 16) and this layout is what renders Header/Footer — see
  // the note in proxy.ts. The header is only a hint: getDraftChromeForPreview
  // runs the same getManagerUserId("builder") gate as the page-draft loader and
  // returns null for everyone else, so forging it leaks nothing.
  const previewing = (await headers()).get("x-sm-preview") === "1";
  const [brand, publishedChrome, draftChrome, analyticsFeatures] =
    await Promise.all([
      getStoreBrand(),
      getStoreChrome(store.id),
      previewing ? getDraftChromeForPreview(store.id) : Promise.resolve(null),
      getPlatformAnalyticsFeatures(),
    ]);
  const chrome = draftChrome ?? publishedChrome;

  // Merchant pixels are independently gated by platform rollout, the store's
  // effective plan (including expiry), its saved enable switch, and finally the
  // visitor's browser-side consent. Builder previews never collect analytics.
  const pixelSettings = resolveMerchantPixelSettings(store.settings);
  const plan = effectivePlan(store);
  const ga4MeasurementId =
    !previewing &&
    pixelSettings.ga4Enabled &&
    analyticsFeatureAllowed(analyticsFeatures, "googleAnalytics4", plan)
      ? pixelSettings.ga4MeasurementId
      : null;
  const metaPixelId =
    !previewing &&
    pixelSettings.metaPixelEnabled &&
    analyticsFeatureAllowed(analyticsFeatures, "metaPixel", plan)
      ? pixelSettings.metaPixelId
      : null;
  const firstPartyEnabled =
    !previewing &&
    analyticsFeatureAllowed(analyticsFeatures, "storefrontConversion", plan);

  // The visual skin: resolve the store's pinned theme release (falling back to
  // the legacy settings.template id) and flatten
  // its palette/fonts/shape into CSS custom properties written inline on
  // .storefront-root. Inline-style specificity beats the globals.css :root
  // defaults, so the whole storefront re-skins with no per-component wiring.
  // A store with NO real theme id (the WholeSip fallback, legacy stores) gets
  // only --brand-primary — the globals.css defaults ARE the WholeSip look, so
  // it stays exactly as today.
  const themeSelection = readThemeSelection(store.settings);
  const design =
    (await resolveInstalledThemeDefinition(themeSelection))?.preset.design ??
    null;
  // ★★ THE PRESET'S OWN MAP, KEPT SEPARATE FROM THE MERGED ONE. The inline
  // style below wants the merchant's overrides ON TOP; ChromeProvider wants
  // the map WITHOUT them, because its job when an override is CLEARED in the
  // builder is to put the theme's value back. Handing it the merged map made
  // it restore the very override that had just been cleared, so Reset
  // repainted the old colour and looked broken until a reload.
  const presetVars: Record<string, string> = design
    ? designToCssVars(design, brand.primaryColor)
    : { "--brand-primary": brand.primaryColor };
  // The merchant's own palette, type and shape sit ON TOP of the preset. Spread
  // LAST so an override wins; it emits only tokens actually set, so an
  // un-overridden store keeps inheriting the theme and a later preset upgrade
  // still reaches it.
  const designOverrides = designOverrideCssVars(chrome.design);
  const themeVars: Record<string, string> = {
    ...presetVars,
    ...designOverrides,
  };

  // Theme defaults + the merchant's published builder overrides resolve into
  // one appearance. Root classes let CSS switch treatments without forking
  // components; the same resolver runs client-side for instant builder preview.
  const appearance = resolveStorefrontAppearance(
    design?.layout,
    chrome.appearance,
  );
  const rootClass = [
    "storefront-root",
    `sm-header-${appearance.header}`,
    `sm-card-${appearance.card}`,
    appearance.cardQuickAdd ? "sm-card-quickadd" : "",
    appearance.cardHoverImage ? "sm-card-hoverimg" : "",
    // Only when a face is actually being imposed — see the `.sm-themed-type`
    // note in storefront-theme.css. ★ A FONT OVERRIDE COUNTS, not just a
    // theme: the class is what makes untokenised descendants inherit the
    // chosen face, so an un-themed store that picks a font would otherwise
    // render half in it and half in Tailwind's default — the two-family
    // defect §11 records for Vitrine. An un-themed store that overrides
    // NOTHING still gets no class, so its inherited font is untouched.
    design || chrome.design.fonts.body ? "sm-themed-type" : "",
    `sm-pdp-${appearance.productDetail}`,
    `sm-cart-${appearance.cart}`,
    `sm-footer-${appearance.footer}`,
    appearance.card === "grocery" ||
    appearance.productDetail === "grocery" ||
    appearance.cart === "grocery"
      ? "sm-storefront-grocery"
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <AuthProvider initialHasSession={hasCustomerSession}>
      <DeliveryLocationProvider>
        <MerchantTracking
          storeName={store.name}
          ga4MeasurementId={ga4MeasurementId}
          metaPixelId={metaPixelId}
          firstPartyEnabled={firstPartyEnabled}
        >
          <CartProvider>
            <BrandProvider brand={brand}>
              <ChromeProvider
                chrome={chrome}
                themeLayout={design?.layout}
                themeVars={presetVars}
                live={previewing}
              >
                <div className={rootClass} style={themeVars as CSSProperties}>
                  <Header />
                  {children}
                  <Footer />
                </div>
              </ChromeProvider>
            </BrandProvider>
            <AuthModalLoader />
            <CartDrawer />
            <Toaster richColors />
          </CartProvider>
        </MerchantTracking>
      </DeliveryLocationProvider>
    </AuthProvider>
  );
}
