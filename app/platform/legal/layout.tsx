import { SiteFooter } from "../site-footer";
import { SiteHeader } from "../site-header";
import "../homepage.css";

// ★ THE POLICY PAGES HAD NO HEADER. /legal and /legal/{slug} rendered a bare
// document — no mark, no navigation, no way back to the site except the one
// "All policies" link on a document page (and nothing at all on the index).
// These are the pages the signup consent sentence links to, so they are often
// someone's first view of StoreMink.
//
// `.smh` carries the --smh-* tokens homepage.css is scoped to, and the header
// is the same component the apex renders, so it cannot drift from it.
export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="smh">
      <SiteHeader anchorBase="/" />
      {children}
      <SiteFooter anchorBase="/" />
    </div>
  );
}
