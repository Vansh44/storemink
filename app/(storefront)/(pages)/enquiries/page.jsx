import { getStoreBrand } from "@/lib/store/brand";
import { requireStorefrontStore } from "@/lib/store/resolve";
import { isDemoStore } from "@/lib/store/launch";
import EnquiriesForm from "./enquiries-form";

// Per-store metadata (layout templates the title as "%s | {brand}").
export async function generateMetadata() {
  const brand = await getStoreBrand();
  return {
    title: "Get in touch",
    description: `Have a question or suggestion? Send the ${brand.name} team an enquiry and we'll get back to you soon.`,
  };
}

export default async function Enquiries() {
  // Guard the host. The (storefront) layout also calls this, but a layout's
  // notFound() does NOT abort a concurrently-rendering child page — so without
  // it here, an unclaimed subdomain streamed the WholeSip fallback's brand into
  // this page's HTML at 200. Every storefront page guards itself (CODEBASE.md §3).
  const store = await requireStorefrontStore();
  // A theme preview takes no enquiries: the form shows, but sends nothing
  // (and never texts a verification code to whoever types a number).
  return <EnquiriesForm demoStore={isDemoStore(store)} />;
}
