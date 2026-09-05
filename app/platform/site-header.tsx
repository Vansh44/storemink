import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { POS_URL, THEMES_URL } from "@/lib/site";
import { BrandMark } from "./brand-mark";
import { HomepageMobileNav } from "./homepage-mobile-nav";

// The one platform header, shared by the apex homepage and /legal/*.
//
// ★ IT WAS INLINE IN page.tsx, AND THE POLICY PAGES THEREFORE HAD NO HEADER AT
// ALL — /legal and /legal/{slug} rendered a bare document with no mark, no
// navigation and no way back to the site except one "All policies" link. A
// second hand-written copy for those routes is how four hosts ended up with
// four different headers in the first place, so this is the shared one.
//
// `anchorBase` is the only thing that varies: the homepage's section links are
// same-page fragments, while a policy page has to send them to the homepage.
export function SiteHeader({ anchorBase = "" }: { anchorBase?: string }) {
  return (
    <header className="smh-header">
      <nav className="smh-nav" aria-label="Main navigation">
        <Link href="/" className="smh-logo" aria-label="StoreMink home">
          <BrandMark size={29} priority />
          <span aria-hidden="true">
            Store<em>Mink</em>
          </span>
        </Link>
        <div className="smh-nav-links">
          <a href={`${anchorBase}#platform`}>Platform</a>
          <Link href={POS_URL}>Point of Sale</Link>
          <a href={THEMES_URL}>Themes</a>
          <a href={`${anchorBase}#pricing`}>Pricing</a>
          <a href="https://help.storemink.com">Resources</a>
        </div>
        <div className="smh-nav-actions">
          <Link href="/login" className="smh-link-button">
            Log in
          </Link>
          <Link href="/signup" className="smh-button smh-button-dark">
            Start free <ArrowRight size={16} />
          </Link>
        </div>
        <HomepageMobileNav
          posUrl={POS_URL}
          themesUrl={THEMES_URL}
          anchorBase={anchorBase}
        />
      </nav>
    </header>
  );
}
