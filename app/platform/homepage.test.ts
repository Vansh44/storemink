import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(process.cwd(), "app/platform/page.tsx"), "utf8");
const css = readFileSync(
  join(process.cwd(), "app/platform/homepage.css"),
  "utf8",
);
const header = readFileSync(
  join(process.cwd(), "app/platform/site-header.tsx"),
  "utf8",
);
const footer = readFileSync(
  join(process.cwd(), "app/platform/site-footer.tsx"),
  "utf8",
);
const legalLayout = readFileSync(
  join(process.cwd(), "app/platform/legal/layout.tsx"),
  "utf8",
);

describe("StoreMink public homepage", () => {
  it("presents the connected commerce story and its conversion paths", () => {
    expect(page).toContain('id="platform"');
    expect(page).toContain('id="pricing"');
    expect(page).toContain('id="faq"');
    expect(page).toContain("Create your store.");
    expect(page).toContain("Sell everywhere.");
    expect(page).toContain("Grow with AI.");
    expect(page).toContain("Mink AI, currently in beta, helps");
    expect(page).toContain('q: "What can Mink AI do?"');
    expect(page).toContain("StoreMink Point of Sale");
    expect(page).toContain('href="/signup"');
    expect(page).toContain('type="application/ld+json"');
  });

  // ★ ONE HEADER, and the policy pages must keep using it. /legal and
  // /legal/{slug} rendered with NO header at all — no mark, no navigation, no
  // way back — which is how they shipped while the markup lived inline in
  // page.tsx. A second hand-written copy for those routes is the drift this
  // guards against.
  it("shares one header and one footer between the apex and the policy pages", () => {
    expect(page).toContain("<SiteHeader");
    expect(page).toContain("<SiteFooter");
    // No second copy of either chrome left behind in the homepage.
    expect(page).not.toContain('className="smh-header"');
    expect(page).not.toContain('className="smh-footer"');
    expect(legalLayout).toContain("<SiteHeader");
    expect(legalLayout).toContain("<SiteFooter");
    expect(legalLayout).toContain('className="smh"');
    expect(header).toContain('className="smh-header"');
    expect(header).toContain("<HomepageMobileNav");
    expect(footer).toContain('className="smh-footer"');
    expect(footer).toContain("LEGAL_DOCS.map");
    for (const chrome of [header, footer]) {
      expect(chrome).toContain("<BrandMark");
      expect(chrome).toContain("Store<em>Mink</em>");
      // The policy pages are not the homepage, so their section links have to
      // leave the route rather than resolve to a fragment that is not there.
      expect(chrome).toContain("${anchorBase}#platform");
    }
    expect(legalLayout.match(/anchorBase="\/"/g)).toHaveLength(2);
  });

  it("uses the current multidevice POS product image", () => {
    expect(page).toContain('src="/brand/storemink-pos-multidevice.png"');
    expect(page).toContain(
      'alt="StoreMink Point of Sale running on a desktop, tablet and phone"',
    );
  });

  it("keeps the redesign isolated, responsive and motion-safe", () => {
    expect(css).toContain(".smh {");
    expect(css).toMatch(/@media \(max-width: 940px\)/);
    expect(css).toMatch(/@media \(max-width: 680px\)/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\)/);
    expect(css).not.toMatch(/^\.(?:stq|posx)-/m);
  });
});
