import type { Metadata } from "next";
import { BRAND_TAGLINE } from "@/lib/seo/brand-identity";
import { getThemeCatalog } from "@/lib/themes/runtime-registry";
import { SignupThemeCatalogProvider } from "./theme-catalog-context";

// page.tsx is a client component (the signup wizard), so its metadata lives
// here. Without this it inherited the platform layout's metadata wholesale and
// served the homepage's exact title + og:url — two URLs claiming to be the same
// page, one of which app/sitemap.ts submits.
export const metadata: Metadata = {
  title: `${BRAND_TAGLINE} — StoreMink`,
  description:
    "Create your StoreMink storefront in minutes, then manage orders, inventory, locations, sales and POS from one connected dashboard with AI built in.",
  alternates: { canonical: "/signup" },
  openGraph: {
    title: `${BRAND_TAGLINE} — StoreMink`,
    description:
      "Create your storefront in minutes, sell online and in person, and manage everything from one connected dashboard with AI built in.",
    url: "/signup",
  },
};

export default async function SignupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const themes = await getThemeCatalog();
  return (
    <SignupThemeCatalogProvider themes={themes}>
      {children}
    </SignupThemeCatalogProvider>
  );
}
