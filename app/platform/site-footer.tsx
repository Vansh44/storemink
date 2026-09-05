import Link from "next/link";
import { Globe2, Mail } from "lucide-react";
import { LEGAL_DOCS } from "@/lib/legal/documents";
import {
  BRAND_TAGLINE,
  BRAND_SOCIAL_LINKS,
  SUPPORT_EMAIL,
} from "@/lib/seo/brand-identity";
import { POS_URL, THEMES_URL } from "@/lib/site";
import { BrandMark } from "./brand-mark";

// The one platform footer, shared by the apex homepage and /legal/*.
//
// ★ IT WAS INLINE IN page.tsx, so the policy pages had neither a header nor a
// footer — the only public pages in the estate with no chrome at all, and the
// ones the signup consent sentence links to. Extracted rather than copied for
// the reason `SiteHeader` was: a second hand-written copy is how four hosts
// ended up with four different headers.
//
// `anchorBase` matches SiteHeader: the homepage's section links are same-page
// fragments, while a policy page has to send them back to the homepage.
export function SiteFooter({ anchorBase = "" }: { anchorBase?: string }) {
  return (
    <footer className="smh-footer">
      <div className="smh-container smh-footer-grid">
        <div className="smh-footer-brand">
          <Link href="/" className="smh-logo">
            <BrandMark size={29} />
            <span aria-hidden="true">
              Store<em>Mink</em>
            </span>
          </Link>
          <p>
            {BRAND_TAGLINE} One connected platform for online and in-person
            commerce.
          </p>
          <span>
            Made in India <Globe2 size={14} />
          </span>
        </div>
        <div>
          <h3>Platform</h3>
          <nav>
            <a href={`${anchorBase}#platform`}>Overview</a>
            <Link href={POS_URL}>Point of Sale</Link>
            <a href={THEMES_URL}>Themes</a>
            <a href={`${anchorBase}#pricing`}>Pricing</a>
          </nav>
        </div>
        <div>
          <h3>Get started</h3>
          <nav>
            <Link href="/signup">Create your store</Link>
            <Link href="/login">Log in</Link>
            <a href="https://help.storemink.com">Help Centre</a>
            <a href={`mailto:${SUPPORT_EMAIL}`}>Contact support</a>
          </nav>
        </div>
        <div>
          <h3>Company</h3>
          <nav>
            {BRAND_SOCIAL_LINKS.map((social) => (
              <a
                key={social.href}
                href={social.href}
                rel="me noopener"
                target="_blank"
              >
                {social.label}
              </a>
            ))}
            <a href={`mailto:${SUPPORT_EMAIL}`}>
              <Mail size={13} /> {SUPPORT_EMAIL}
            </a>
          </nav>
        </div>
        <div>
          <h3>Legal</h3>
          <nav>
            {LEGAL_DOCS.map((document) => (
              <Link key={document.slug} href={`/legal/${document.slug}`}>
                {document.title}
              </Link>
            ))}
          </nav>
        </div>
      </div>
      <div className="smh-container smh-footer-base">
        <span>© {new Date().getFullYear()} StoreMink</span>
        <span>Your brand. Your customers. Your growth.</span>
      </div>
    </footer>
  );
}
