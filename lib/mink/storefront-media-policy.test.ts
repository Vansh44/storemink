import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_CONFIG, type PageSectionItem } from "@/lib/sections/registry";
import {
  assertLayoutMediaIsOwned,
  collectSectionMediaUrls,
} from "./storefront-media-policy";

const OWNED = "https://storage.googleapis.com/bucket/stores/s1/media/a_1.webp";
const OTHER = "https://storage.googleapis.com/bucket/stores/s1/media/b_2.webp";
const INVENTED = "https://images.example.com/beautiful-hero.jpg";

function hero(imageUrl: string, id = "hero"): PageSectionItem {
  return {
    id,
    type: "hero",
    enabled: true,
    config: { ...EMPTY_CONFIG.hero, heading: "Hi", image_url: imageUrl },
  } as PageSectionItem;
}

function gallery(urls: string[], id = "gal"): PageSectionItem {
  return {
    id,
    type: "gallery",
    enabled: true,
    config: {
      ...EMPTY_CONFIG.gallery,
      items: urls.map((image_url) => ({
        image_url,
        image_alt: "",
        caption: "",
        href: "",
      })),
    },
  } as PageSectionItem;
}

describe("Phase 9D layout media ownership", () => {
  it("collects media from every depth a section puts it at", () => {
    const carousel = {
      id: "car",
      type: "hero_carousel",
      enabled: true,
      config: {
        ...EMPTY_CONFIG.hero_carousel,
        slides: [
          {
            heading: "",
            subheading: "",
            cta_label: "",
            cta_href: "",
            image_url: OWNED,
            video_url: OTHER,
            background: "",
            theme: "dark",
          },
        ],
      },
    } as unknown as PageSectionItem;

    expect(
      collectSectionMediaUrls([hero(OWNED), gallery([OTHER]), carousel]).sort(),
    ).toEqual([OTHER, OTHER, OWNED, OWNED].sort());
  });

  it("ignores an empty field and never treats a link as media", () => {
    const section = {
      id: "mt",
      type: "media_text",
      enabled: true,
      config: {
        ...EMPTY_CONFIG.media_text,
        heading: "Story",
        body: "Body",
        image_url: "",
        // A CTA is a place the shopper is sent, not media the page loads, so a
        // merchant may legitimately point it anywhere.
        cta_href: "https://instagram.com/somebody",
      },
    } as PageSectionItem;

    expect(collectSectionMediaUrls([section])).toEqual([]);
    expect(assertLayoutMediaIsOwned([section], [])).toEqual([]);
  });

  it("refuses an invented URL and names the tool that would have prevented it", () => {
    const issues = assertLayoutMediaIsOwned(
      [gallery([OWNED, INVENTED])],
      [OWNED],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(INVENTED);
    expect(issues[0]).toContain("list_storefront_media");
  });

  it("accepts an image the store owns and one already on the page", () => {
    expect(
      assertLayoutMediaIsOwned(
        [hero(OWNED), gallery([OTHER, OWNED])],
        [OWNED, OTHER],
      ),
    ).toEqual([]);
  });

  it("reports each unowned URL once, so one retry can fix a whole gallery", () => {
    const issues = assertLayoutMediaIsOwned(
      [gallery([INVENTED, INVENTED, OTHER]), hero(INVENTED, "h2")],
      [],
    );
    expect(issues).toHaveLength(2);
  });

  it("does not fold case, because a URL path is case-sensitive", () => {
    expect(
      assertLayoutMediaIsOwned([hero(OWNED.toUpperCase())], [OWNED]),
    ).toHaveLength(1);
  });

  it("trims, so a stray space in a stored URL is not a refusal", () => {
    expect(assertLayoutMediaIsOwned([hero(` ${OWNED} `)], [OWNED])).toEqual([]);
  });
});

describe("the naming rule the guard rests on", () => {
  /**
   * ★★ THE DRIFT GUARD. `collectSectionMediaUrls` finds media by the `_url`
   * suffix rather than by an enumerated list of the seventeen section types,
   * precisely so a new field is covered automatically -- but only if it is
   * NAMED that way. A future `background_image` would slip past the walk with
   * nothing reporting it, and the symptom would be an invented URL saved to a
   * live storefront. This fails the moment such a field is declared.
   */
  it("has no media-shaped section field that the walk cannot see", () => {
    const source = readFileSync(
      join(process.cwd(), "lib/homepage/section-types.ts"),
      "utf8",
    );
    const declared = new Set(
      [...source.matchAll(/^\s+([a-z][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1]),
    );
    // Names that LOOK like media and are not a URL: a colour, an icon key from
    // the fixed catalogue, alt text, an aspect ratio, a layout side, and the
    // section-type keys of the META/EMPTY_CONFIG records.
    const notAUrl = new Set([
      "background",
      "icon",
      "image_alt",
      "image_ratio",
      "logo_alt",
      "media_position",
      "media_ratio",
      "media_text",
      "poster_alt",
      "promo_banner",
      "video",
    ]);
    const missed = [...declared].filter(
      (name) =>
        /image|video|logo|poster|photo|media|icon|src|thumb|banner|picture|avatar|background/i.test(
          name,
        ) &&
        !name.endsWith("_url") &&
        !notAUrl.has(name),
    );
    expect(missed).toEqual([]);
    // And the exemptions must stay real: a name here that no longer exists
    // would quietly widen the list for the next field that resembles it.
    expect([...notAUrl].filter((name) => !declared.has(name))).toEqual([]);
  });
});
