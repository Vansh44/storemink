import { describe, it, expect } from "vitest";
import {
  clampLimit,
  heroImageOptions,
  validateConfig,
  summarizeSection,
  EMPTY_CONFIG,
  LIMIT_MIN,
  LIMIT_MAX,
  MAX_FAQ_ITEMS,
  MAX_GALLERY_ITEMS,
  MAX_HERO_SLIDES,
  MAX_TICKER_MESSAGES,
  MAX_TILES,
  MAX_TESTIMONIAL_ITEMS,
  MAX_USP_ITEMS,
  type FaqAccordionConfig,
  type FeaturedProductsConfig,
  type GalleryConfig,
  type HeroCarouselConfig,
  type HeroConfig,
  type ShopByCategoryConfig,
  type PromoBannerConfig,
  type LatestBlogsConfig,
  type MediaTextConfig,
  type NewsletterSectionConfig,
  type TickerConfig,
  type TileGridConfig,
  type TestimonialsConfig,
  type VideoConfig,
  type UspBarConfig,
} from "./section-types";

// clampLimit() pins the "max products/blogs to show" knob into 1..12, falling
// back to the featured default (8) when the value is garbage. Floats are
// truncated since you can't show 4.7 cards.
describe("clampLimit", () => {
  it("falls back to the featured default for non-finite input", () => {
    expect(clampLimit(Number.NaN)).toBe(EMPTY_CONFIG.featured_products.limit);
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBe(
      EMPTY_CONFIG.featured_products.limit,
    );
    expect(clampLimit(Number.NEGATIVE_INFINITY)).toBe(8);
  });

  it("clamps values below LIMIT_MIN up to 1", () => {
    expect(clampLimit(0)).toBe(LIMIT_MIN);
    expect(clampLimit(-99)).toBe(1);
  });

  it("clamps values above LIMIT_MAX down to 12", () => {
    expect(clampLimit(13)).toBe(LIMIT_MAX);
    expect(clampLimit(1000)).toBe(12);
  });

  it("truncates floats toward zero before clamping", () => {
    expect(clampLimit(4.7)).toBe(4);
    expect(clampLimit(11.9)).toBe(11);
    // 12.9 truncates to 12 which is in range (not bumped to 13 then clamped).
    expect(clampLimit(12.9)).toBe(12);
  });

  it("passes in-range integers through unchanged", () => {
    expect(clampLimit(1)).toBe(1);
    expect(clampLimit(8)).toBe(8);
    expect(clampLimit(12)).toBe(12);
  });
});

// validateConfig() is the trust boundary: it normalises raw editor/form input
// into a clean, storable config (irrelevant keys dropped) or returns an error.
describe("validateConfig", () => {
  it("rejects an unknown section type", () => {
    const out = validateConfig("definitely_unknown" as never, {});
    expect(out).toEqual({ error: "Unknown section type." });
  });

  // --- featured_products ---------------------------------------------------
  describe("featured_products", () => {
    it("defaults source to 'featured' and drops irrelevant keys", () => {
      const out = validateConfig("featured_products", {
        heading: "  Bestsellers  ",
        subheading: "  picks  ",
        // product_ids/category_id are irrelevant for source=featured and must
        // be dropped/nulled.
        product_ids: ["a", "b"],
        category_id: "cat-1",
        limit: 6,
      });
      expect("config" in out).toBe(true);
      const config = (out as { config: FeaturedProductsConfig }).config;
      expect(config).toEqual({
        heading: "Bestsellers",
        subheading: "picks",
        source: "featured",
        product_ids: [],
        category_id: null,
        limit: 6,
      });
    });

    it("errors when source=manual has no product_ids", () => {
      const out = validateConfig("featured_products", {
        source: "manual",
        product_ids: [],
      });
      expect(out).toEqual({ error: "Pick at least one product." });
    });

    it("keeps product_ids and nulls category_id for a valid manual config", () => {
      const out = validateConfig("featured_products", {
        heading: "Hand picks",
        source: "manual",
        product_ids: ["p1", "p2", 3, "p3"], // non-string filtered out
        category_id: "cat-should-be-dropped",
        limit: 4,
      });
      const config = (out as { config: FeaturedProductsConfig }).config;
      expect(config.source).toBe("manual");
      expect(config.product_ids).toEqual(["p1", "p2", "p3"]);
      expect(config.category_id).toBe(null);
    });

    it("errors when source=category has no category_id", () => {
      const out = validateConfig("featured_products", {
        source: "category",
        category_id: "   ",
      });
      expect(out).toEqual({ error: "Choose a category." });
    });

    it("keeps category_id and empties product_ids for a valid category config", () => {
      const out = validateConfig("featured_products", {
        source: "category",
        category_id: "  cat-42  ",
        product_ids: ["should", "be", "dropped"],
      });
      const config = (out as { config: FeaturedProductsConfig }).config;
      expect(config.source).toBe("category");
      expect(config.category_id).toBe("cat-42");
      expect(config.product_ids).toEqual([]);
    });

    it("clamps the limit", () => {
      const out = validateConfig("featured_products", {
        source: "featured",
        limit: 999,
      });
      const config = (out as { config: FeaturedProductsConfig }).config;
      expect(config.limit).toBe(LIMIT_MAX);
    });

    it("falls back to the default limit when limit is non-numeric", () => {
      const out = validateConfig("featured_products", {
        source: "featured",
        limit: "abc",
      });
      const config = (out as { config: FeaturedProductsConfig }).config;
      // Number("abc") is NaN -> clampLimit -> default 8.
      expect(config.limit).toBe(8);
    });
  });

  // --- hero ------------------------------------------------------------------
  describe("hero", () => {
    it("requires a headline or image when publishing", () => {
      const out = validateConfig("hero", { heading: "", image_url: "" });
      expect(out).toEqual({
        error: "Add a headline or an image for the hero.",
      });
      // Draft mode lets the empty hero through (autosave mid-edit).
      expect("config" in validateConfig("hero", {}, "draft")).toBe(true);
    });

    it("normalises variant/theme/alignment and strips unsafe values", () => {
      const out = validateConfig("hero", {
        heading: "  Hi  ",
        variant: "weird",
        theme: "neon",
        alignment: "right",
        cta_href: "javascript:alert(1)",
        background: "url(evil)",
        badge_text: " 51% off ",
      });
      const config = (out as { config: HeroConfig }).config;
      expect(config.heading).toBe("Hi");
      expect(config.variant).toBe("banner");
      expect(config.theme).toBe("dark");
      expect(config.alignment).toBe("left");
      expect(config.cta_href).toBe("");
      expect(config.background).toBe("");
      expect(config.badge_text).toBe("51% off");
    });

    it("keeps a strict colour background", () => {
      const out = validateConfig("hero", {
        heading: "x",
        background: "#fae3c1",
      });
      expect((out as { config: HeroConfig }).config.background).toBe("#fae3c1");
    });

    it("keeps a safe video_url and strips unsafe schemes", () => {
      const ok = validateConfig("hero", {
        heading: "x",
        video_url: "https://cdn.example.com/clip.mp4",
      });
      expect((ok as { config: HeroConfig }).config.video_url).toBe(
        "https://cdn.example.com/clip.mp4",
      );
      const bad = validateConfig("hero", {
        heading: "x",
        video_url: "javascript:alert(1)",
      });
      expect((bad as { config: HeroConfig }).config.video_url).toBe("");
    });
  });

  // --- hero image controls (Track 1.4) ---------------------------------------
  describe("hero image controls", () => {
    it("stores nothing extra when every control is at its default", () => {
      // Untouched content must serialise exactly as it did before 1.4.
      const out = validateConfig("hero", {
        heading: "x",
        height: "auto",
        focal_x: 50,
        focal_y: 50,
        content_position: "middle",
      });
      const config = (out as { config: HeroConfig }).config;
      for (const key of [
        "height",
        "focal_x",
        "focal_y",
        "overlay_opacity",
        "content_position",
        "mobile_image_url",
      ]) {
        expect(config).not.toHaveProperty(key);
      }
    });

    it("keeps set controls and clamps them into range", () => {
      const out = validateConfig("hero", {
        heading: "x",
        height: "screen",
        focal_x: 130,
        focal_y: "-4",
        overlay_opacity: 95,
        content_position: "bottom",
        mobile_image_url: "https://cdn.example.com/phone.webp",
      });
      const config = (out as { config: HeroConfig }).config;
      expect(config.height).toBe("screen");
      expect(config.focal_x).toBe(100);
      expect(config.focal_y).toBe(0);
      expect(config.overlay_opacity).toBe(80);
      expect(config.content_position).toBe("bottom");
      expect(config.mobile_image_url).toBe(
        "https://cdn.example.com/phone.webp",
      );
    });

    it("reads null and blank as ABSENT, never as 0", () => {
      // Number(null) === 0: a cleared field must not become a 0% focal point
      // or a fully transparent overlay that switches the built-in scrim off.
      const opts = heroImageOptions({
        focal_x: null,
        focal_y: "",
        overlay_opacity: null,
      });
      expect(opts).toEqual({});
    });

    it("keeps a real 0 overlay and a one-axis focal point", () => {
      expect(heroImageOptions({ overlay_opacity: 0 })).toEqual({
        overlay_opacity: 0,
      });
      expect(heroImageOptions({ focal_y: 20 })).toEqual({
        focal_x: 50,
        focal_y: 20,
      });
    });

    it("drops unknown heights and positions and unsafe phone images", () => {
      const out = validateConfig("hero", {
        heading: "x",
        height: "huge",
        content_position: "left",
        mobile_image_url: "javascript:alert(1)",
      });
      const config = (out as { config: HeroConfig }).config;
      expect(config).not.toHaveProperty("height");
      expect(config).not.toHaveProperty("content_position");
      expect(config).not.toHaveProperty("mobile_image_url");
    });

    it("applies per slide and to the carousel height", () => {
      const out = validateConfig("hero_carousel", {
        height: "medium",
        slides: [
          { heading: "a", focal_x: 30, overlay_opacity: 40 },
          { heading: "b" },
        ],
      });
      const config = (out as { config: HeroCarouselConfig }).config;
      expect(config.height).toBe("medium");
      expect(config.slides[0]).toMatchObject({
        focal_x: 30,
        focal_y: 50,
        overlay_opacity: 40,
      });
      expect(config.slides[1]).not.toHaveProperty("focal_x");
    });

    it("is idempotent, so a re-save changes nothing", () => {
      const first = validateConfig("hero", {
        heading: "x",
        height: "large",
        focal_x: 25,
        overlay_opacity: 30,
      }) as { config: HeroConfig };
      const second = validateConfig("hero", first.config) as {
        config: HeroConfig;
      };
      expect(second.config).toEqual(first.config);
    });
  });

  // --- hero_carousel ---------------------------------------------------------
  describe("hero_carousel", () => {
    it("sanitises slides, clamps the interval and defaults autoplay on", () => {
      const out = validateConfig("hero_carousel", {
        slides: [
          {
            heading: "  Slide one ",
            cta_href: "javascript:evil()",
            video_url: "https://cdn.example.com/a.mp4",
            background: "url(x)",
            theme: "neon",
          },
        ],
        interval_seconds: 99,
      });
      const config = (out as { config: HeroCarouselConfig }).config;
      expect(config.slides).toHaveLength(1);
      expect(config.slides[0].heading).toBe("Slide one");
      expect(config.slides[0].cta_href).toBe("");
      expect(config.slides[0].video_url).toBe("https://cdn.example.com/a.mp4");
      expect(config.slides[0].background).toBe("");
      expect(config.slides[0].theme).toBe("dark");
      expect(config.autoplay).toBe(true);
      expect(config.interval_seconds).toBe(15);
    });

    it("drops empty slides on publish and errors when none remain", () => {
      const empty = { heading: "", image_url: "", video_url: "" };
      expect(validateConfig("hero_carousel", { slides: [empty] })).toEqual({
        error: "Add at least one slide with a headline, image or video.",
      });
      // Draft keeps the empty row so the editor doesn't lose it mid-edit.
      const draft = validateConfig(
        "hero_carousel",
        { slides: [empty] },
        "draft",
      );
      expect(
        (draft as { config: HeroCarouselConfig }).config.slides,
      ).toHaveLength(1);
    });

    it("caps the slide count", () => {
      const slides = Array.from({ length: MAX_HERO_SLIDES + 1 }, () => ({
        heading: "s",
      }));
      expect(validateConfig("hero_carousel", { slides })).toEqual({
        error: `At most ${MAX_HERO_SLIDES} slides.`,
      });
    });
  });

  // --- usp_bar ---------------------------------------------------------------
  describe("usp_bar", () => {
    it("drops empty rows, caps items and falls back on unknown icons", () => {
      const out = validateConfig("usp_bar", {
        items: [
          { icon: "truck", title: "Fast delivery", subtitle: "" },
          { icon: "not-an-icon", title: "Quality", subtitle: "Guaranteed" },
          { icon: "leaf", title: "", subtitle: "" }, // dropped
        ],
        theme: "light",
      });
      const config = (out as { config: UspBarConfig }).config;
      expect(config.items).toHaveLength(2);
      expect(config.items[1].icon).toBe("star");
      expect(config.theme).toBe("light");
    });

    it("errors on publish with no items, allows it in draft", () => {
      expect(validateConfig("usp_bar", { items: [] })).toEqual({
        error: "Add at least one item.",
      });
      expect(
        "config" in validateConfig("usp_bar", { items: [] }, "draft"),
      ).toBe(true);
    });

    it("rejects more than MAX_USP_ITEMS", () => {
      const items = Array.from({ length: MAX_USP_ITEMS + 1 }, () => ({
        icon: "star",
        title: "t",
        subtitle: "",
      }));
      expect(validateConfig("usp_bar", { items })).toEqual({
        error: `At most ${MAX_USP_ITEMS} items.`,
      });
    });
  });

  // --- ticker ------------------------------------------------------------------
  describe("ticker", () => {
    it("keeps non-empty messages and normalises speed/theme", () => {
      const out = validateConfig("ticker", {
        messages: ["Free shipping", "   ", "New arrivals"],
        speed: "fast",
        theme: "light",
      });
      const config = (out as { config: TickerConfig }).config;
      expect(config.messages).toEqual(["Free shipping", "New arrivals"]);
      expect(config.speed).toBe("fast");
      expect(config.theme).toBe("light");
    });

    it("defaults an unknown speed to medium", () => {
      const out = validateConfig("ticker", { messages: ["a"], speed: "turbo" });
      expect((out as { config: TickerConfig }).config.speed).toBe("medium");
    });

    it("errors on publish with no messages, allows it in draft", () => {
      expect(validateConfig("ticker", { messages: [] })).toEqual({
        error: "Add at least one message.",
      });
      expect(
        "config" in validateConfig("ticker", { messages: [] }, "draft"),
      ).toBe(true);
    });

    it("rejects more than MAX_TICKER_MESSAGES", () => {
      const messages = Array.from(
        { length: MAX_TICKER_MESSAGES + 1 },
        (_, i) => `m${i}`,
      );
      expect(validateConfig("ticker", { messages })).toEqual({
        error: `At most ${MAX_TICKER_MESSAGES} messages.`,
      });
    });
  });

  // --- tile_grid ---------------------------------------------------------------
  describe("tile_grid", () => {
    it("normalises tiles: strict colours, safe hrefs, empty tiles dropped", () => {
      const out = validateConfig("tile_grid", {
        heading: "Offers",
        columns: 7,
        height: "huge",
        tiles: [
          {
            title: "Juices",
            href: "/shop",
            background: "expression(alert(1))",
            theme: "light",
          },
          { title: "", subtitle: "", image_url: "" }, // dropped
        ],
      });
      const config = (out as { config: TileGridConfig }).config;
      expect(config.tiles).toHaveLength(1);
      expect(config.tiles[0].background).toBe("");
      expect(config.tiles[0].href).toBe("/shop");
      expect(config.tiles[0].theme).toBe("light");
      expect(config.columns).toBe(4);
      expect(config.height).toBe("sm");
    });

    it("errors on publish with no tiles and caps the tile count", () => {
      expect(validateConfig("tile_grid", { tiles: [] })).toEqual({
        error: "Add at least one tile.",
      });
      const tiles = Array.from({ length: MAX_TILES + 1 }, () => ({
        title: "t",
      }));
      expect(validateConfig("tile_grid", { tiles })).toEqual({
        error: `At most ${MAX_TILES} tiles.`,
      });
    });
  });

  describe("media_text", () => {
    it("normalises editorial layout and strips unsafe links", () => {
      const out = validateConfig("media_text", {
        eyebrow: "  Our craft  ",
        heading: "  Made slowly  ",
        body: "  A considered process.  ",
        cta_label: "Read more",
        cta_href: "javascript:alert(1)",
        image_url: "https://cdn.example.com/story.webp",
        image_alt: "  An artisan at work  ",
        media_position: "right",
        media_ratio: "landscape",
        alignment: "center",
      });
      const config = (out as { config: MediaTextConfig }).config;
      expect(config).toEqual({
        eyebrow: "Our craft",
        heading: "Made slowly",
        body: "A considered process.",
        cta_label: "Read more",
        cta_href: "",
        image_url: "https://cdn.example.com/story.webp",
        image_alt: "An artisan at work",
        media_position: "right",
        media_ratio: "landscape",
        alignment: "center",
      });
    });

    it("requires content when publishing but keeps an empty draft", () => {
      expect(validateConfig("media_text", {})).toEqual({
        error: "Add a heading, story or image.",
      });
      expect("config" in validateConfig("media_text", {}, "draft")).toBe(true);
    });
  });

  describe("gallery", () => {
    it("requires two images, drops empty published rows and normalises layout", () => {
      const out = validateConfig("gallery", {
        heading: "  Lookbook  ",
        layout: "unexpected",
        columns: 9,
        image_ratio: "square",
        items: [
          { image_url: "/one.webp", caption: " One " },
          { image_url: "", caption: "No image" },
          {
            image_url: "/two.webp",
            href: "javascript:alert(1)",
          },
        ],
      });
      const config = (out as { config: GalleryConfig }).config;
      expect(config.heading).toBe("Lookbook");
      expect(config.items).toHaveLength(2);
      expect(config.items[0].caption).toBe("One");
      expect(config.items[1].href).toBe("");
      expect(config.layout).toBe("editorial");
      expect(config.columns).toBe(3);
      expect(config.image_ratio).toBe("square");
    });

    it("allows incomplete rows in drafts and enforces the item cap", () => {
      expect(
        validateConfig("gallery", { items: [{ image_url: "/one" }] }),
      ).toEqual({ error: "Add at least two gallery images." });
      expect(
        "config" in
          validateConfig("gallery", { items: [{ image_url: "" }] }, "draft"),
      ).toBe(true);
      const items = Array.from({ length: MAX_GALLERY_ITEMS + 1 }, () => ({
        image_url: "/image.webp",
      }));
      expect(validateConfig("gallery", { items })).toEqual({
        error: `At most ${MAX_GALLERY_ITEMS} gallery images.`,
      });
    });
  });

  describe("testimonials", () => {
    it("supports quotes and logo-only press mentions", () => {
      const out = validateConfig("testimonials", {
        eyebrow: "  In the press ",
        layout: "editorial",
        columns: 2,
        items: [
          { quote: "  Beautifully made. ", author: "Asha" },
          {
            logo_url: "/press.svg",
            logo_alt: "Design Journal",
            detail: "Editors’ pick",
          },
          { quote: "", logo_url: "" },
        ],
      });
      const config = (out as { config: TestimonialsConfig }).config;
      expect(config.items).toHaveLength(2);
      expect(config.items[0].quote).toBe("Beautifully made.");
      expect(config.items[1].logo_alt).toBe("Design Journal");
      expect(config.layout).toBe("editorial");
      expect(config.columns).toBe(2);
    });

    it("requires one item on publish and enforces the item cap", () => {
      expect(validateConfig("testimonials", { items: [] })).toEqual({
        error: "Add at least one testimonial or press mention.",
      });
      expect(
        "config" in validateConfig("testimonials", { items: [] }, "draft"),
      ).toBe(true);
      const items = Array.from({ length: MAX_TESTIMONIAL_ITEMS + 1 }, () => ({
        quote: "Great",
      }));
      expect(validateConfig("testimonials", { items })).toEqual({
        error: `At most ${MAX_TESTIMONIAL_ITEMS} testimonials.`,
      });
    });
  });

  // --- faq_accordion ---------------------------------------------------------
  describe("faq_accordion", () => {
    it("drops empty rows and caps question length", () => {
      const out = validateConfig("faq_accordion", {
        heading: "  FAQ  ",
        show_filters: true,
        items: [
          { question: "Q1?", answer: "A1", category: "Delivery" },
          { question: "", answer: "", category: "X" }, // dropped
        ],
      });
      const config = (out as { config: FaqAccordionConfig }).config;
      expect(config.heading).toBe("FAQ");
      expect(config.items).toHaveLength(1);
      expect(config.items[0].category).toBe("Delivery");
      expect(config.show_filters).toBe(true);
    });

    it("errors on publish with no items, allows it in draft", () => {
      expect(validateConfig("faq_accordion", { items: [] })).toEqual({
        error: "Add at least one question.",
      });
      expect(
        "config" in validateConfig("faq_accordion", { items: [] }, "draft"),
      ).toBe(true);
    });

    it("rejects more than the item cap", () => {
      const items = Array.from({ length: MAX_FAQ_ITEMS + 1 }, () => ({
        question: "q",
        answer: "a",
      }));
      expect(validateConfig("faq_accordion", { items })).toEqual({
        error: `At most ${MAX_FAQ_ITEMS} questions.`,
      });
    });
  });

  // --- shop_by_category ----------------------------------------------------
  describe("shop_by_category", () => {
    it("defaults source to 'all' and layout to 'scroll'", () => {
      const out = validateConfig("shop_by_category", {
        heading: "  Categories  ",
        category_ids: ["dropped"], // irrelevant for source=all
      });
      const config = (out as { config: ShopByCategoryConfig }).config;
      expect(config).toEqual({
        heading: "Categories",
        subheading: "",
        source: "all",
        category_ids: [],
        layout: "scroll",
        display: "circles",
      });
    });

    it("errors when source=selected has no category_ids", () => {
      const out = validateConfig("shop_by_category", {
        source: "selected",
        category_ids: [],
      });
      expect(out).toEqual({ error: "Pick at least one category." });
    });

    it("keeps category_ids for a valid selected config", () => {
      const out = validateConfig("shop_by_category", {
        source: "selected",
        category_ids: ["c1", "c2"],
      });
      const config = (out as { config: ShopByCategoryConfig }).config;
      expect(config.source).toBe("selected");
      expect(config.category_ids).toEqual(["c1", "c2"]);
    });

    it("honours an explicit layout='grid'", () => {
      const out = validateConfig("shop_by_category", {
        source: "all",
        layout: "grid",
      });
      const config = (out as { config: ShopByCategoryConfig }).config;
      expect(config.layout).toBe("grid");
    });
  });

  // --- latest_blogs --------------------------------------------------------
  describe("latest_blogs", () => {
    it("defaults source to 'latest' and drops blog_ids", () => {
      const out = validateConfig("latest_blogs", {
        heading: "  Journal  ",
        blog_ids: ["dropped"],
        limit: 5,
      });
      const config = (out as { config: LatestBlogsConfig }).config;
      expect(config).toEqual({
        heading: "Journal",
        subheading: "",
        source: "latest",
        blog_ids: [],
        limit: 5,
        layout: "scroll",
      });
    });

    it("errors when source=manual has no blog_ids", () => {
      const out = validateConfig("latest_blogs", {
        source: "manual",
        blog_ids: [],
      });
      expect(out).toEqual({ error: "Pick at least one blog post." });
    });

    it("keeps blog_ids for a valid manual config", () => {
      const out = validateConfig("latest_blogs", {
        source: "manual",
        blog_ids: ["b1", "b2"],
      });
      const config = (out as { config: LatestBlogsConfig }).config;
      expect(config.source).toBe("manual");
      expect(config.blog_ids).toEqual(["b1", "b2"]);
    });

    it("clamps the limit", () => {
      const out = validateConfig("latest_blogs", {
        source: "latest",
        limit: 0,
      });
      const config = (out as { config: LatestBlogsConfig }).config;
      expect(config.limit).toBe(LIMIT_MIN);
    });

    it("defaults layout to 'scroll' and honours layout='grid'", () => {
      const scroll = (
        validateConfig("latest_blogs", { source: "latest" }) as {
          config: LatestBlogsConfig;
        }
      ).config;
      expect(scroll.layout).toBe("scroll");

      const grid = (
        validateConfig("latest_blogs", {
          source: "manual",
          blog_ids: ["b1"],
          layout: "grid",
        }) as { config: LatestBlogsConfig }
      ).config;
      expect(grid.layout).toBe("grid");
    });

    it("keeps source=featured and needs no blog_ids", () => {
      const out = validateConfig("latest_blogs", {
        source: "featured",
        limit: 4,
      });
      const config = (out as { config: LatestBlogsConfig }).config;
      expect(config.source).toBe("featured");
      expect(config.blog_ids).toEqual([]);
      expect(config.limit).toBe(4);
    });
  });

  // --- promo_banner --------------------------------------------------------
  describe("promo_banner", () => {
    it("errors when neither image_url nor heading is present", () => {
      const out = validateConfig("promo_banner", {
        subtext: "just some text",
      });
      expect(out).toEqual({
        error: "Add an image or a heading for the banner.",
      });
    });

    it("passes with only an image_url", () => {
      const out = validateConfig("promo_banner", {
        image_url: "https://cdn.example.com/banner.jpg",
      });
      expect("config" in out).toBe(true);
    });

    it("passes with only a heading", () => {
      const out = validateConfig("promo_banner", { heading: "Summer Sale" });
      expect("config" in out).toBe(true);
    });

    it("strips dangerous cta_href schemes to empty string", () => {
      for (const href of [
        "javascript:alert(1)",
        "  JavaScript:alert(1)",
        "data:text/html,<script>",
        "vbscript:msgbox(1)",
      ]) {
        const out = validateConfig("promo_banner", {
          heading: "Hi",
          cta_href: href,
        });
        const config = (out as { config: PromoBannerConfig }).config;
        expect(config.cta_href).toBe("");
      }
    });

    it("allows http(s) and relative cta_href", () => {
      const https = validateConfig("promo_banner", {
        heading: "Hi",
        cta_href: "https://example.com/sale",
      });
      expect((https as { config: PromoBannerConfig }).config.cta_href).toBe(
        "https://example.com/sale",
      );

      const relative = validateConfig("promo_banner", {
        heading: "Hi",
        cta_href: "/shop",
      });
      expect((relative as { config: PromoBannerConfig }).config.cta_href).toBe(
        "/shop",
      );
    });

    it("defaults alignment to 'left' and theme to 'light'", () => {
      const out = validateConfig("promo_banner", {
        heading: "Hi",
        alignment: "weird",
        theme: "rainbow",
      });
      const config = (out as { config: PromoBannerConfig }).config;
      expect(config.alignment).toBe("left");
      expect(config.theme).toBe("light");
    });

    it("honours center/right alignment and dark theme", () => {
      const center = validateConfig("promo_banner", {
        heading: "Hi",
        alignment: "center",
        theme: "dark",
      });
      const centerConfig = (center as { config: PromoBannerConfig }).config;
      expect(centerConfig.alignment).toBe("center");
      expect(centerConfig.theme).toBe("dark");

      const right = validateConfig("promo_banner", {
        heading: "Hi",
        alignment: "right",
      });
      expect((right as { config: PromoBannerConfig }).config.alignment).toBe(
        "right",
      );
    });

    it("trims text fields", () => {
      const out = validateConfig("promo_banner", {
        image_url: "  https://cdn.example.com/b.jpg  ",
        heading: "  Sale  ",
        subtext: "  Up to 50% off  ",
        cta_label: "  Shop now  ",
      });
      const config = (out as { config: PromoBannerConfig }).config;
      expect(config.image_url).toBe("https://cdn.example.com/b.jpg");
      expect(config.heading).toBe("Sale");
      expect(config.subtext).toBe("Up to 50% off");
      expect(config.cta_label).toBe("Shop now");
    });
  });
});

describe("phase 3 video and newsletter sections", () => {
  it("requires a safe video URL on publish and keeps incomplete drafts", () => {
    expect(validateConfig("video", { video_url: "" })).toEqual({
      error: "Add a video before publishing.",
    });
    expect("config" in validateConfig("video", {}, "draft")).toBe(true);
    expect(
      validateConfig("video", { video_url: "javascript:alert(1)" }),
    ).toEqual({
      error: "Add a video before publishing.",
    });
  });

  it("normalises video playback and layout options", () => {
    const out = validateConfig("video", {
      eyebrow: " Watch ",
      heading: " Studio film ",
      video_url: "https://vimeo.com/123456789",
      poster_url: "javascript:alert(1)",
      aspect_ratio: "portrait",
      width: "full",
      autoplay: true,
      loop: true,
      controls: false,
    });
    const config = (out as { config: VideoConfig }).config;
    expect(config).toMatchObject({
      eyebrow: "Watch",
      heading: "Studio film",
      video_url: "https://vimeo.com/123456789",
      poster_url: "",
      aspect_ratio: "portrait",
      width: "full",
      autoplay: true,
      loop: true,
      controls: false,
    });
  });

  it("requires newsletter copy and explicit consent text on publish", () => {
    expect(validateConfig("newsletter", {})).toEqual({
      error: "Add a newsletter heading or description.",
    });
    expect(validateConfig("newsletter", { heading: "Join us" })).toEqual({
      error: "Add consent text before publishing.",
    });
    expect("config" in validateConfig("newsletter", {}, "draft")).toBe(true);
  });

  it("normalises newsletter copy, theme and alignment", () => {
    const out = validateConfig("newsletter", {
      heading: "  Notes worth opening ",
      consent_text: " I agree to receive updates. ",
      button_label: "",
      success_message: "",
      theme: "light",
      alignment: "left",
    });
    const config = (out as { config: NewsletterSectionConfig }).config;
    expect(config).toMatchObject({
      heading: "Notes worth opening",
      consent_text: "I agree to receive updates.",
      button_label: "Subscribe",
      success_message: "You're on the list — thank you.",
      theme: "light",
      alignment: "left",
    });
  });
});

// summarizeSection() produces the one-line label shown on dashboard list rows.
describe("summarizeSection", () => {
  it("summarises featured_products in manual mode", () => {
    const config: FeaturedProductsConfig = {
      heading: "Editor's Picks",
      subheading: "",
      source: "manual",
      product_ids: ["a", "b", "c"],
      category_id: null,
      limit: 8,
    };
    expect(summarizeSection({ type: "featured_products", config })).toBe(
      "Editor's Picks · 3 hand-picked",
    );
  });

  it("summarises featured_products in category mode", () => {
    const config: FeaturedProductsConfig = {
      heading: "Soaps",
      subheading: "",
      source: "category",
      product_ids: [],
      category_id: "cat-1",
      limit: 8,
    };
    expect(summarizeSection({ type: "featured_products", config })).toBe(
      "Soaps · by category",
    );
  });

  it("summarises featured_products in featured (default) mode", () => {
    const config: FeaturedProductsConfig = {
      heading: "Bestsellers",
      subheading: "",
      source: "featured",
      product_ids: [],
      category_id: null,
      limit: 6,
    };
    expect(summarizeSection({ type: "featured_products", config })).toBe(
      "Bestsellers · featured · up to 6",
    );
  });

  it("falls back to the default featured label when heading is blank", () => {
    const config: FeaturedProductsConfig = {
      heading: "   ",
      subheading: "",
      source: "featured",
      product_ids: [],
      category_id: null,
      limit: 4,
    };
    expect(summarizeSection({ type: "featured_products", config })).toBe(
      "Featured products · featured · up to 4",
    );
  });

  it("summarises shop_by_category for all vs selected", () => {
    const all: ShopByCategoryConfig = {
      heading: "Categories",
      subheading: "",
      source: "all",
      category_ids: [],
      layout: "grid",
    };
    expect(summarizeSection({ type: "shop_by_category", config: all })).toBe(
      "Categories · all categories",
    );

    const selected: ShopByCategoryConfig = {
      heading: "",
      subheading: "",
      source: "selected",
      category_ids: ["c1", "c2"],
      layout: "scroll",
    };
    expect(
      summarizeSection({ type: "shop_by_category", config: selected }),
    ).toBe("Shop by category · 2 selected");
  });

  it("summarises promo_banner with and without a heading", () => {
    const withHeading: PromoBannerConfig = {
      image_url: "",
      heading: "Summer Sale",
      subtext: "",
      cta_label: "",
      cta_href: "",
      alignment: "left",
      theme: "light",
    };
    expect(
      summarizeSection({ type: "promo_banner", config: withHeading }),
    ).toBe("Promo · Summer Sale");

    const noHeading: PromoBannerConfig = {
      ...withHeading,
      heading: "   ",
    };
    expect(summarizeSection({ type: "promo_banner", config: noHeading })).toBe(
      "Promo · (no heading)",
    );
  });

  it("summarises latest_blogs for manual vs latest", () => {
    const manual: LatestBlogsConfig = {
      heading: "Journal",
      subheading: "",
      source: "manual",
      blog_ids: ["b1", "b2"],
      limit: 3,
      layout: "scroll",
    };
    expect(summarizeSection({ type: "latest_blogs", config: manual })).toBe(
      "Journal · 2 hand-picked",
    );

    const latest: LatestBlogsConfig = {
      heading: "",
      subheading: "",
      source: "latest",
      blog_ids: [],
      limit: 5,
      layout: "grid",
    };
    expect(summarizeSection({ type: "latest_blogs", config: latest })).toBe(
      "Blog posts · latest · up to 5",
    );

    const featured: LatestBlogsConfig = {
      heading: "",
      subheading: "",
      source: "featured",
      blog_ids: [],
      limit: 4,
      layout: "grid",
    };
    expect(summarizeSection({ type: "latest_blogs", config: featured })).toBe(
      "Blog posts · featured · up to 4",
    );
  });
});
