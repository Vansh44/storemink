import { describe, it, expect } from "vitest";
import {
  DEFAULT_CHROME,
  normalizeChrome,
  resolveStorefrontAppearance,
  sanitizeChromeForSave,
} from "./types";

describe("normalizeChrome", () => {
  it("returns the defaults for empty input", () => {
    for (const raw of [null, undefined, {}, "nonsense", 42]) {
      const c = normalizeChrome(raw);
      expect(c.header.links).toEqual(DEFAULT_CHROME.header.links);
      expect(c.footer.groups).toEqual(DEFAULT_CHROME.footer.groups);
    }
  });

  /**
   * THE bug this module is most likely to grow.
   *
   * A toggle coerced with `v || fallback` turns an explicit `false` back into
   * the default `true` — so switching the newsletter off would appear to work,
   * survive a save, and silently come back on the next read. Every toggle here
   * defaults ON, which makes that failure invisible in testing and obvious to
   * the merchant.
   */
  it("keeps an explicit false instead of falling back to the default", () => {
    const c = normalizeChrome({
      header: { showSearch: false, showCart: false, sticky: false },
      footer: {
        newsletter: { enabled: false },
        contact: { enabled: false },
        social: { enabled: false },
        badges: { enabled: false },
        showCredit: false,
      },
    });
    expect(c.header.showSearch).toBe(false);
    expect(c.header.showCart).toBe(false);
    expect(c.header.sticky).toBe(false);
    expect(c.footer.newsletter.enabled).toBe(false);
    expect(c.footer.contact.enabled).toBe(false);
    expect(c.footer.social.enabled).toBe(false);
    expect(c.footer.badges.enabled).toBe(false);
    expect(c.footer.showCredit).toBe(false);
  });

  it("treats a missing toggle as the default, not as off", () => {
    const c = normalizeChrome({ header: {}, footer: {} });
    expect(c.header.showSearch).toBe(true);
    expect(c.footer.newsletter.enabled).toBe(true);
  });

  // A non-boolean must not be read as truthy/falsy — "false" and 0 are the
  // shapes a hand-edited jsonb row or a bad form serialisation produces.
  it("ignores non-boolean values and uses the default", () => {
    const c = normalizeChrome({
      header: { showSearch: "false" },
      footer: { showCredit: 0 },
    });
    expect(c.header.showSearch).toBe(true);
    expect(c.footer.showCredit).toBe(true);
  });

  it("drops links missing a label or href", () => {
    const c = normalizeChrome({
      header: {
        links: [
          { label: "Shop", href: "/shop" },
          { label: "", href: "/x" },
          { label: "No href", href: "" },
          "nonsense",
          null,
        ],
      },
    });
    expect(c.header.links).toEqual([{ label: "Shop", href: "/shop" }]);
  });

  it("caps link and group counts", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      label: `L${i}`,
      href: `/l${i}`,
    }));
    const c = normalizeChrome({
      header: { links: many },
      footer: {
        groups: Array.from({ length: 20 }, (_, i) => ({
          title: `G${i}`,
          links: many,
        })),
      },
    });
    expect(c.header.links.length).toBe(12);
    expect(c.footer.groups.length).toBe(6);
    expect(c.footer.groups[0].links.length).toBe(12);
  });

  it("trims and length-caps text", () => {
    const c = normalizeChrome({
      header: { links: [{ label: "  Shop  ", href: "  /shop  " }] },
      footer: { newsletter: { heading: "x".repeat(500) } },
    });
    expect(c.header.links[0]).toEqual({ label: "Shop", href: "/shop" });
    expect(c.footer.newsletter.heading.length).toBe(160);
  });

  it("drops a footer group that has neither title nor links", () => {
    const c = normalizeChrome({
      footer: {
        groups: [
          { title: "Real", links: [{ label: "A", href: "/a" }] },
          { title: "", links: [] },
        ],
      },
    });
    expect(c.footer.groups.map((g) => g.title)).toEqual(["Real"]);
  });
});

describe("resolveStorefrontAppearance", () => {
  it("uses modern theme defaults while separating quick-add from card shape", () => {
    expect(
      resolveStorefrontAppearance({
        header: "centered",
        card: "quick_add",
        productDetail: "editorial",
        cart: "compact",
        footer: "minimal",
      }),
    ).toEqual({
      header: "centered",
      card: "classic",
      cardQuickAdd: true,
      cardHoverImage: false,
      stickyAddToCart: false,
      gridColumnsMobile: 1,
      gridColumnsDesktop: 4,
      productDetail: "editorial",
      cart: "compact",
      footer: "minimal",
    });
  });

  it("carries the theme's hover-image opt-in, and ignores card overrides", () => {
    // Off unless the theme asks for it — no existing storefront changes.
    expect(resolveStorefrontAppearance({}).cardHoverImage).toBe(false);
    expect(resolveStorefrontAppearance(undefined).cardHoverImage).toBe(false);
    expect(
      resolveStorefrontAppearance({ cardHoverImage: true }).cardHoverImage,
    ).toBe(true);
    // Hover-swap is orthogonal to the merchant's card choice: overriding the
    // card variant must neither enable nor cancel it.
    expect(
      resolveStorefrontAppearance(
        { cardHoverImage: true, card: "framed" },
        { ...DEFAULT_CHROME.appearance, card: "overlay" },
      ).cardHoverImage,
    ).toBe(true);
    expect(
      resolveStorefrontAppearance(
        { card: "framed" },
        { ...DEFAULT_CHROME.appearance, card: "quick_add" },
      ).cardHoverImage,
    ).toBe(false);
  });

  it("keeps shopping chrome off unless the theme opts in", () => {
    // No existing storefront gains a sticky bar or a new grid.
    expect(resolveStorefrontAppearance(undefined)).toMatchObject({
      stickyAddToCart: false,
      gridColumnsMobile: 1,
      gridColumnsDesktop: 4,
    });
    expect(
      resolveStorefrontAppearance({
        stickyAddToCart: true,
        gridColumnsMobile: 2,
        gridColumnsDesktop: 5,
      }),
    ).toMatchObject({
      stickyAddToCart: true,
      gridColumnsMobile: 2,
      gridColumnsDesktop: 5,
    });
    // A stored value outside the choices falls back to the default rather
    // than emitting a class nothing styles.
    expect(
      resolveStorefrontAppearance({
        gridColumnsMobile: 3 as never,
        gridColumnsDesktop: 7 as never,
      }),
    ).toMatchObject({ gridColumnsMobile: 1, gridColumnsDesktop: 4 });
  });

  it("preserves pinned legacy grocery storefronts", () => {
    expect(
      resolveStorefrontAppearance({ storefront: "grocery" }),
    ).toMatchObject({
      card: "grocery",
      productDetail: "grocery",
      cart: "grocery",
    });
  });

  it("applies merchant overrides without changing inherited surfaces", () => {
    expect(
      resolveStorefrontAppearance(
        { header: "market", card: "grocery", footer: "rich" },
        {
          ...DEFAULT_CHROME.appearance,
          header: "minimal",
          card: "overlay",
          footer: "editorial",
        },
      ),
    ).toEqual({
      header: "minimal",
      card: "overlay",
      cardQuickAdd: false,
      cardHoverImage: false,
      stickyAddToCart: false,
      gridColumnsMobile: 1,
      gridColumnsDesktop: 4,
      productDetail: "classic",
      cart: "classic",
      footer: "editorial",
    });
  });

  it("normalises invalid stored appearance values back to theme inheritance", () => {
    const chrome = normalizeChrome({ appearance: { header: "impossible" } });
    expect(chrome.appearance).toEqual(DEFAULT_CHROME.appearance);
  });
});

describe("sanitizeChromeForSave", () => {
  /**
   * The difference that matters between the two functions. normalizeChrome
   * feeds the STOREFRONT, so an empty header falls back to something
   * navigable. Save must NOT do that, or deleting your last footer column is
   * an edit the product refuses to perform — you press delete, it saves, and
   * the column reappears.
   */
  it("preserves an explicitly emptied list", () => {
    const c = sanitizeChromeForSave({
      header: { links: [] },
      footer: { groups: [], legal: [] },
    });
    expect(c.header.links).toEqual([]);
    expect(c.footer.groups).toEqual([]);
    expect(c.footer.legal).toEqual([]);
  });

  it("still cleans and caps what it does keep", () => {
    const c = sanitizeChromeForSave({
      header: {
        links: [
          { label: "  A  ", href: "/a" },
          { label: "", href: "" },
        ],
      },
    });
    expect(c.header.links).toEqual([{ label: "A", href: "/a" }]);
  });

  it("round-trips its own output unchanged", () => {
    const once = sanitizeChromeForSave(DEFAULT_CHROME);
    expect(sanitizeChromeForSave(once)).toEqual(once);
  });
});
