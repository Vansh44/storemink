import { describe, expect, it } from "vitest";
import {
  cleanNavLinks,
  cleanNavTree,
  flattenNav,
  isSafeNavImage,
  NAV_LIMITS,
  navPanelKind,
} from "./nav";
import { normalizeChrome, sanitizeChromeForSave } from "./types";
import { sanitizeMenusForSave } from "@/lib/menus";

const shop = {
  label: "Shop",
  href: "/shop",
  image_url: "/themes/vitrine/hero.webp",
  children: [
    {
      label: "Men",
      href: "/shop?category=men",
      children: [
        { label: "Shirts", href: "/shop?category=shirts" },
        { label: "Trousers", href: "/shop?category=trousers" },
      ],
    },
    { label: "Sale", href: "/shop?category=sale" },
  ],
};

describe("cleanNavTree", () => {
  it("leaves a flat menu exactly as it was", () => {
    const flat = [
      { label: "Shop", href: "/shop" },
      { label: "About", href: "/about" },
    ];
    // Byte-identical: no [] children, no "" image — the at-rest guarantee.
    expect(JSON.stringify(cleanNavTree(flat))).toBe(JSON.stringify(flat));
  });

  it("keeps three levels and a top-level image", () => {
    expect(cleanNavTree([shop])).toEqual([shop]);
  });

  it("stops at the third level", () => {
    const deep = [
      {
        label: "A",
        href: "/a",
        children: [
          {
            label: "B",
            href: "/b",
            children: [
              {
                label: "C",
                href: "/c",
                children: [{ label: "D", href: "/d" }],
              },
            ],
          },
        ],
      },
    ];
    const [a] = cleanNavTree(deep);
    expect(a.children?.[0].children?.[0]).toEqual({ label: "C", href: "/c" });
  });

  it("lets a heading with children skip its href, but not an empty one", () => {
    expect(
      cleanNavTree([
        {
          label: "Shop by room",
          href: "",
          children: [{ label: "Hall", href: "/hall" }],
        },
        { label: "Nothing", href: "", children: [] },
        { label: "", href: "/x" },
      ]),
    ).toEqual([
      {
        label: "Shop by room",
        href: "",
        children: [{ label: "Hall", href: "/hall" }],
      },
    ]);
  });

  it("drops an image on an item with no children or below the top", () => {
    const [plain, parent] = cleanNavTree([
      { label: "About", href: "/about", image_url: "/a.webp" },
      {
        label: "Shop",
        href: "/shop",
        children: [
          {
            label: "Men",
            href: "/men",
            image_url: "/m.webp",
            children: [{ label: "Shirts", href: "/shirts" }],
          },
        ],
      },
    ]);
    expect(plain).not.toHaveProperty("image_url");
    expect(parent.children?.[0]).not.toHaveProperty("image_url");
  });

  it("refuses an image a menu should not load", () => {
    const withImage = (image_url: string) =>
      cleanNavTree([{ ...shop, image_url }])[0].image_url;
    expect(withImage("javascript:alert(1)")).toBeUndefined();
    expect(withImage("//evil.example/x.png")).toBeUndefined();
    expect(withImage("http://example.com/x.png")).toBeUndefined();
    expect(withImage("https://storage.googleapis.com/b/x.webp")).toBe(
      "https://storage.googleapis.com/b/x.webp",
    );
    expect(withImage("theme-asset://hero-main")).toBe(
      "theme-asset://hero-main",
    );
  });

  it("caps each level and the tree as a whole", () => {
    const many = (n: number, depth: number): unknown[] =>
      Array.from({ length: n }, (_, i) => ({
        label: `L${depth}-${i}`,
        href: `/x${depth}-${i}`,
        children: depth < 2 ? many(n, depth + 1) : undefined,
      }));
    const tree = cleanNavTree(many(20, 0));
    expect(tree.length).toBeLessThanOrEqual(NAV_LIMITS.topLevel);
    expect(tree[0].children).toHaveLength(NAV_LIMITS.children);
    expect(tree[0].children?.[0].children).toHaveLength(
      NAV_LIMITS.grandchildren,
    );
    expect(flattenNav(tree).length).toBeLessThanOrEqual(NAV_LIMITS.totalItems);
    // The budget keeps what came first.
    expect(tree[0].label).toBe("L0-0");
  });
});

describe("the footer stays flat", () => {
  it("drops children from a footer link", () => {
    expect(cleanNavLinks([shop])).toEqual([{ label: "Shop", href: "/shop" }]);
  });

  it("through both chrome paths and the legacy menus", () => {
    const raw = {
      header: { links: [shop] },
      footer: { groups: [{ title: "Shop", links: [shop] }], legal: [shop] },
    };
    for (const chrome of [normalizeChrome(raw), sanitizeChromeForSave(raw)]) {
      expect(chrome.header.links).toEqual([shop]);
      expect(chrome.footer.groups[0].links[0]).toEqual({
        label: "Shop",
        href: "/shop",
      });
      expect(chrome.footer.legal[0]).not.toHaveProperty("children");
    }
    const menus = sanitizeMenusForSave({ header: [shop], footerLegal: [shop] });
    expect(menus.header).toEqual([shop]);
    expect(menus.footerLegal[0]).not.toHaveProperty("children");
  });
});

describe("navPanelKind", () => {
  it("opens a list, a panel, or nothing", () => {
    expect(navPanelKind({ label: "A", href: "/a" })).toBe("none");
    expect(
      navPanelKind({
        label: "A",
        href: "/a",
        children: [{ label: "B", href: "/b" }],
      }),
    ).toBe("dropdown");
    expect(navPanelKind(shop)).toBe("mega");
    expect(
      navPanelKind({
        label: "A",
        href: "/a",
        image_url: "/x.webp",
        children: [{ label: "B", href: "/b" }],
      }),
    ).toBe("mega");
  });
});

describe("isSafeNavImage", () => {
  it("rejects empty and data urls", () => {
    expect(isSafeNavImage("")).toBe(false);
    expect(isSafeNavImage("data:image/png;base64,AAAA")).toBe(false);
    expect(isSafeNavImage("theme-asset://Bad Slot")).toBe(false);
  });
});
