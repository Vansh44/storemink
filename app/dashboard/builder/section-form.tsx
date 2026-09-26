"use client";

import { ChevronUp, ChevronDown, X, Plus } from "lucide-react";
import { ImageUpload } from "@/components/ui/image-upload";
import { VideoUpload } from "@/components/ui/video-upload";
import { NumberField } from "@/components/ui/number-field";
import { CustomCodeFrame } from "@/app/(storefront)/components/sections/custom-code-frame";
import CodeEditor from "./code-editor-lazy";
import { FieldGroup } from "./field-group";
import {
  MAX_FAQ_ITEMS,
  MAX_GALLERY_ITEMS,
  MAX_HERO_SLIDES,
  MAX_TESTIMONIAL_ITEMS,
  MAX_TICKER_MESSAGES,
  MAX_TILES,
  MAX_USP_ITEMS,
  USP_ICONS,
  type AnySectionConfig,
  type CustomCodeConfig,
  type FaqAccordionConfig,
  type FaqItem,
  type FeaturedProductsConfig,
  type GalleryConfig,
  type GalleryItem,
  type HeroCarouselConfig,
  type HeroConfig,
  type HeroHeight,
  type HeroImageOptions,
  type HeroSlide,
  type HomepageSectionType,
  type LatestBlogsConfig,
  type MediaTextConfig,
  type NewsletterSectionConfig,
  type PromoBannerConfig,
  type RichTextConfig,
  type ShopByCategoryConfig,
  type TickerConfig,
  type TileGridConfig,
  type TileItem,
  type TestimonialItem,
  type TestimonialsConfig,
  type UspBarConfig,
  type UspItem,
  type VideoConfig,
} from "@/lib/homepage/section-types";

// ---------------------------------------------------------------------------
// Shared section-config forms. One <SectionForm> dispatches to a per-type field
// group; each group is a controlled (config, setConfig) editor with NO server
// calls, so it works both in the homepage editor dialog and in the website
// builder (which persists via its own draft-save action).
// ---------------------------------------------------------------------------

// Option rows for the pickers. Defined here (not imported from a server page)
// so both consumers share one source.
export interface ProductOption {
  id: string;
  name: string;
  slug: string;
  image_url: string | null;
  featured: boolean;
}
export interface CategoryOption {
  id: string;
  name: string;
  slug: string;
  image_url: string | null;
}
export interface BlogOption {
  id: string;
  name: string; // blog title, named `name` to fit the shared OrderedPicker
  slug: string;
}

export const fieldClass =
  "border-input bg-background focus:border-primary placeholder:text-muted-foreground w-full rounded-md border px-3 py-2 text-sm outline-none";
export const labelClass =
  "text-muted-foreground mb-1.5 block text-xs font-medium uppercase tracking-wide";

export function SectionForm({
  type,
  config,
  setConfig,
  products,
  categories,
  blogs,
}: {
  type: HomepageSectionType;
  config: AnySectionConfig;
  setConfig: (c: AnySectionConfig) => void;
  products: ProductOption[];
  categories: CategoryOption[];
  blogs: BlogOption[];
}) {
  switch (type) {
    case "hero":
      return <HeroFields config={config as HeroConfig} setConfig={setConfig} />;
    case "hero_carousel":
      return (
        <CarouselFields
          config={config as HeroCarouselConfig}
          setConfig={setConfig}
        />
      );
    case "usp_bar":
      return (
        <UspBarFields config={config as UspBarConfig} setConfig={setConfig} />
      );
    case "ticker":
      return (
        <TickerFields config={config as TickerConfig} setConfig={setConfig} />
      );
    case "tile_grid":
      return (
        <TileGridFields
          config={config as TileGridConfig}
          setConfig={setConfig}
        />
      );
    case "media_text":
      return (
        <MediaTextFields
          config={config as MediaTextConfig}
          setConfig={setConfig}
        />
      );
    case "gallery":
      return (
        <GalleryFields config={config as GalleryConfig} setConfig={setConfig} />
      );
    case "testimonials":
      return (
        <TestimonialsFields
          config={config as TestimonialsConfig}
          setConfig={setConfig}
        />
      );
    case "video":
      return (
        <VideoFields config={config as VideoConfig} setConfig={setConfig} />
      );
    case "newsletter":
      return (
        <NewsletterFields
          config={config as NewsletterSectionConfig}
          setConfig={setConfig}
        />
      );
    case "faq_accordion":
      return (
        <FaqFields
          config={config as FaqAccordionConfig}
          setConfig={setConfig}
        />
      );
    case "featured_products":
      return (
        <FeaturedFields
          config={config as FeaturedProductsConfig}
          setConfig={setConfig}
          products={products}
          categories={categories}
        />
      );
    case "shop_by_category":
      return (
        <CategoryFields
          config={config as ShopByCategoryConfig}
          setConfig={setConfig}
          categories={categories}
        />
      );
    case "promo_banner":
      return (
        <BannerFields
          config={config as PromoBannerConfig}
          setConfig={setConfig}
        />
      );
    case "latest_blogs":
      return (
        <BlogFields
          config={config as LatestBlogsConfig}
          setConfig={setConfig}
          blogs={blogs}
        />
      );
    case "rich_text":
      return (
        <RichTextFields
          config={config as RichTextConfig}
          setConfig={setConfig}
        />
      );
    case "custom_code":
      return (
        <CustomCodeFields
          config={config as CustomCodeConfig}
          setConfig={setConfig}
        />
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// An ordered list of chosen ids with up/down/remove + an "add" dropdown of the
// remaining options. Shared by manual products, selected categories, blogs.
// ---------------------------------------------------------------------------
function OrderedPicker({
  selectedIds,
  options,
  onChange,
  addLabel,
}: {
  selectedIds: string[];
  options: { id: string; name: string }[];
  onChange: (ids: string[]) => void;
  addLabel: string;
}) {
  const byId = new Map(options.map((o) => [o.id, o]));
  const remaining = options.filter((o) => !selectedIds.includes(o.id));

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= selectedIds.length) return;
    const next = [...selectedIds];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {selectedIds.length > 0 && (
        <div className="space-y-1.5">
          {selectedIds.map((id, i) => (
            <div
              key={id}
              className="bg-background flex items-center gap-2 rounded-md border px-2 py-1.5"
            >
              <span className="flex-1 truncate text-sm">
                {byId.get(id)?.name ?? (
                  <span className="text-[var(--dash-red)]">
                    (missing — {id.slice(0, 8)}...)
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                title="Move up"
                className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
              >
                <ChevronUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === selectedIds.length - 1}
                title="Move down"
                className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => onChange(selectedIds.filter((x) => x !== id))}
                title="Remove"
                className="text-muted-foreground hover:text-[var(--dash-red)] flex h-7 w-6 items-center justify-center rounded hover:bg-[var(--dash-red-soft)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      {remaining.length > 0 && (
        <div className="flex items-center gap-2">
          <Plus className="text-muted-foreground h-3.5 w-3.5" />
          <select
            className={fieldClass}
            value=""
            onChange={(e) => {
              if (e.target.value) onChange([...selectedIds, e.target.value]);
            }}
          >
            <option value="">{addLabel}</option>
            {remaining.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

// Strict-colour input: free text (hex/rgb/hsl) + a native picker swatch.
// Invalid values are dropped by validateConfig, so this stays permissive.
function ColorField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const pickable = /^#[0-9a-f]{6}$/i.test(value);
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        className="h-9 w-10 shrink-0 cursor-pointer rounded-md border p-0.5"
        value={pickable ? value : "#ffffff"}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Pick a colour"
      />
      <input
        className={fieldClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "#f6e7cf (blank = theme default)"}
      />
    </div>
  );
}

// Video slot: upload a file (signed-URL flow, straight to storage) or paste a
// direct .mp4/.webm URL. Both write the same config field; the storefront
// plays it muted/looping in place of the image.
function VideoField({
  value,
  onChange,
}: {
  value: string;
  onChange: (url: string) => void;
}) {
  return (
    <div className="space-y-2">
      <VideoUpload
        folder="homepage"
        defaultVideo={value || undefined}
        onUploadSuccess={onChange}
      />
      <input
        className={fieldClass}
        value={value}
        onChange={(e) => onChange(e.target.value.trim())}
        placeholder="…or paste a YouTube / Vimeo / .mp4 link"
      />
    </div>
  );
}

const USP_ICON_LABELS: Record<(typeof USP_ICONS)[number], string> = {
  star: "Star",
  "badge-check": "Badge check",
  truck: "Truck (delivery)",
  shield: "Shield (protection)",
  leaf: "Leaf (natural)",
  gift: "Gift",
  lock: "Lock (secure)",
  refresh: "Refresh (returns)",
  clock: "Clock (speed)",
  heart: "Heart",
  headphones: "Headphones (support)",
  sparkles: "Sparkles (quality)",
};

function HeroFields({
  config,
  setConfig,
}: {
  config: HeroConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof HeroConfig>(key: K, value: HeroConfig[K]) =>
    setConfig({ ...config, [key]: value });

  return (
    <>
      <FieldGroup title="Layout">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Layout</label>
            <select
              className={fieldClass}
              value={config.variant}
              onChange={(e) =>
                set("variant", e.target.value as HeroConfig["variant"])
              }
            >
              <option value="banner">Banner card (copy + image)</option>
              <option value="split">Split (half copy, half image)</option>
              <option value="minimal">Minimal (centred statement)</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Text alignment</label>
            <select
              className={fieldClass}
              value={config.alignment}
              onChange={(e) =>
                set("alignment", e.target.value as HeroConfig["alignment"])
              }
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
            </select>
          </div>
          <HeightSelect
            value={config.height}
            onChange={(height) => setConfig(withHeight(config, height))}
          />
        </div>
      </FieldGroup>

      <FieldGroup title="Text">
        <div>
          <label className={labelClass}>Headline</label>
          <input
            className={fieldClass}
            value={config.heading}
            onChange={(e) => set("heading", e.target.value)}
            placeholder="From farm to your kitchen"
          />
        </div>

        <div>
          <label className={labelClass}>Subheadline</label>
          <textarea
            className={`${fieldClass} min-h-[60px] resize-y`}
            value={config.subheading}
            onChange={(e) => set("subheading", e.target.value)}
            placeholder="(optional)"
          />
        </div>

        <div>
          <label className={labelClass}>Badge (optional)</label>
          <input
            className={fieldClass}
            value={config.badge_text}
            onChange={(e) => set("badge_text", e.target.value)}
            placeholder="51% off this week"
          />
        </div>
      </FieldGroup>

      <FieldGroup title="Button">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Button label</label>
            <input
              className={fieldClass}
              value={config.cta_label}
              onChange={(e) => set("cta_label", e.target.value)}
              placeholder="Shop now"
            />
          </div>
          <div>
            <label className={labelClass}>Button link</label>
            <input
              className={fieldClass}
              value={config.cta_href}
              onChange={(e) => set("cta_href", e.target.value)}
              placeholder="/shop"
            />
          </div>
        </div>
      </FieldGroup>

      <FieldGroup title="Image & colour">
        <div>
          <label className={labelClass}>Image</label>
          <ImageUpload
            folder="homepage"
            defaultImage={config.image_url || undefined}
            onUploadSuccess={(url) => set("image_url", url)}
          />
          <p className="text-muted-foreground mt-1 text-[11px]">
            Banner/split show it beside the copy; minimal uses it as a full
            background.
          </p>
        </div>

        <HeroImageFields
          image={config.image_url}
          value={config}
          overlay={config.variant === "minimal"}
          onChange={(patch) => setConfig(withImageOptions(config, patch))}
        />

        <div>
          <label className={labelClass}>Video (optional)</label>
          <VideoField
            value={config.video_url}
            onChange={(url) => set("video_url", url)}
          />
          <p className="text-muted-foreground mt-1 text-[11px]">
            Plays muted on loop in place of the image; the image becomes the
            loading poster.
          </p>
        </div>

        <div>
          <label className={labelClass}>Text theme</label>
          <select
            className={fieldClass}
            value={config.theme}
            onChange={(e) =>
              set("theme", e.target.value as HeroConfig["theme"])
            }
          >
            <option value="dark">Dark text (light background)</option>
            <option value="light">Light text (dark background)</option>
          </select>
        </div>

        <div>
          <label className={labelClass}>Background colour</label>
          <ColorField
            value={config.background}
            onChange={(v) => set("background", v)}
          />
        </div>
      </FieldGroup>
    </>
  );
}

const HEIGHT_OPTIONS: { value: HeroHeight; label: string }[] = [
  { value: "auto", label: "Default" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "screen", label: "Full screen" },
];

function HeightSelect({
  value,
  onChange,
}: {
  value: HeroHeight | undefined;
  onChange: (v: HeroHeight | undefined) => void;
}) {
  return (
    <div>
      <label className={labelClass}>Height</label>
      <select
        className={fieldClass}
        value={value ?? "auto"}
        onChange={(e) => {
          const v = e.target.value as HeroHeight;
          onChange(v === "auto" ? undefined : v);
        }}
      >
        {HEIGHT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The image controls a paid Shopify theme gives a banner: where the subject
 * is (so every crop keeps it), a separate photograph for phones, how strong
 * the overlay behind the copy is, and whether the copy sits high or low.
 * Every control has an explicit "default" that stores nothing.
 */
export function HeroImageFields({
  image,
  value,
  onChange,
  overlay,
}: {
  image: string;
  value: HeroImageOptions;
  onChange: (patch: HeroImageOptions) => void;
  /** Overlay + position only mean something where copy sits on the media. */
  overlay: boolean;
}) {
  const x = value.focal_x ?? 50;
  const y = value.focal_y ?? 50;
  const setFocal = (fx: number, fy: number) => {
    const rx = Math.round(Math.min(100, Math.max(0, fx)));
    const ry = Math.round(Math.min(100, Math.max(0, fy)));
    onChange(
      rx === 50 && ry === 50
        ? { focal_x: undefined, focal_y: undefined }
        : { focal_x: rx, focal_y: ry },
    );
  };
  return (
    <div className="space-y-3">
      {image && (
        <div>
          <label className={labelClass}>Focal point</label>
          <button
            type="button"
            className="relative block w-full overflow-hidden rounded-md border"
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              setFocal(
                ((e.clientX - box.left) / box.width) * 100,
                ((e.clientY - box.top) / box.height) * 100,
              );
            }}
            aria-label={`Set the focal point (now ${x}% across, ${y}% down)`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- editor preview of an uploaded URL. */}
            <img src={image} alt="" className="block h-auto w-full" />
            <span
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
              style={{ left: `${x}%`, top: `${y}%` }}
            />
          </button>
          <p className="text-muted-foreground mt-1 text-[11px]">
            Click the subject. Every crop — wide desktop, tall phone — keeps
            this point in view.{" "}
            {value.focal_x !== undefined && (
              <button
                type="button"
                className="underline"
                onClick={() => setFocal(50, 50)}
              >
                Reset to centre
              </button>
            )}
          </p>
        </div>
      )}

      <div>
        <label className={labelClass}>Phone image (optional)</label>
        <ImageUpload
          folder="homepage"
          defaultImage={value.mobile_image_url || undefined}
          onUploadSuccess={(url) =>
            onChange({ mobile_image_url: url || undefined })
          }
        />
        <p className="text-muted-foreground mt-1 text-[11px]">
          A taller photo composed for phones. Phones download only this one.
        </p>
      </div>

      {overlay && (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>
              Overlay{" "}
              {value.overlay_opacity !== undefined
                ? `${value.overlay_opacity}%`
                : "(default)"}
            </label>
            <input
              type="range"
              min={0}
              max={80}
              step={5}
              className="w-full"
              value={value.overlay_opacity ?? 0}
              onChange={(e) =>
                onChange({ overlay_opacity: Number(e.target.value) })
              }
            />
            {value.overlay_opacity !== undefined && (
              <button
                type="button"
                className="text-muted-foreground text-[11px] underline"
                onClick={() => onChange({ overlay_opacity: undefined })}
              >
                Use default
              </button>
            )}
          </div>
          <div>
            <label className={labelClass}>Text position</label>
            <select
              className={fieldClass}
              value={value.content_position ?? "middle"}
              onChange={(e) => {
                const v = e.target.value;
                onChange({
                  content_position:
                    v === "top" || v === "bottom" ? v : undefined,
                });
              }}
            >
              <option value="top">Top</option>
              <option value="middle">Middle</option>
              <option value="bottom">Bottom</option>
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

/** Merge a patch, dropping keys set back to their default (undefined) so
 *  the stored config stays exactly what an untouched hero always stored. */
function withImageOptions<T extends HeroImageOptions>(
  base: T,
  patch: HeroImageOptions,
): T {
  const next = { ...base, ...patch } as T & Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    if ((patch as Record<string, unknown>)[key] === undefined) delete next[key];
  }
  return next;
}

/** Set or clear (back to the default) a hero/carousel height preset. */
function withHeight<T extends { height?: HeroHeight }>(
  base: T,
  height: HeroHeight | undefined,
): T {
  const next = { ...base };
  if (height) next.height = height;
  else delete next.height;
  return next;
}

const EMPTY_SLIDE: HeroSlide = {
  heading: "",
  subheading: "",
  cta_label: "",
  cta_href: "",
  image_url: "",
  video_url: "",
  background: "",
  theme: "dark",
};

function CarouselFields({
  config,
  setConfig,
}: {
  config: HeroCarouselConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof HeroCarouselConfig>(
    key: K,
    value: HeroCarouselConfig[K],
  ) => setConfig({ ...config, [key]: value });
  const setSlide = (i: number, patch: Partial<HeroSlide>) =>
    set(
      "slides",
      config.slides.map((s, j) => (j === i ? { ...s, ...patch } : s)),
    );
  const move = (i: number, dir: -1 | 1) => {
    const target = i + dir;
    if (target < 0 || target >= config.slides.length) return;
    const next = [...config.slides];
    [next[i], next[target]] = [next[target], next[i]];
    set("slides", next);
  };

  return (
    <>
      <FieldGroup title="Playback">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.autoplay}
            onChange={(e) => set("autoplay", e.target.checked)}
          />
          Auto-play slides
        </label>
        <div>
          <label className={labelClass}>Seconds per slide</label>
          <select
            className={fieldClass}
            value={config.interval_seconds}
            onChange={(e) => set("interval_seconds", Number(e.target.value))}
            disabled={!config.autoplay}
          >
            {[2, 3, 5, 8, 10, 15].map((s) => (
              <option key={s} value={s}>
                {s} seconds
              </option>
            ))}
          </select>
        </div>
        <HeightSelect
          value={config.height}
          onChange={(height) => setConfig(withHeight(config, height))}
        />
      </FieldGroup>

      <div className="space-y-2">
        <label className={labelClass}>Slides</label>
        {config.slides.map((slide, i) => (
          <div
            key={i}
            className="bg-background space-y-2 rounded-md border p-2"
          >
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs font-medium">
                Slide {i + 1}
              </span>
              <div className="ml-auto flex items-center">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === config.slides.length - 1}
                  title="Move down"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    set(
                      "slides",
                      config.slides.filter((_, j) => j !== i),
                    )
                  }
                  title="Remove"
                  className="text-muted-foreground hover:text-[var(--dash-red)] flex h-7 w-6 items-center justify-center rounded hover:bg-[var(--dash-red-soft)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <input
              className={fieldClass}
              value={slide.heading}
              onChange={(e) => setSlide(i, { heading: e.target.value })}
              placeholder="Fresh deals every week"
            />
            <input
              className={fieldClass}
              value={slide.subheading}
              onChange={(e) => setSlide(i, { subheading: e.target.value })}
              placeholder="Subheading (optional)"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={slide.cta_label}
                onChange={(e) => setSlide(i, { cta_label: e.target.value })}
                placeholder="Shop now"
              />
              <input
                className={fieldClass}
                value={slide.cta_href}
                onChange={(e) => setSlide(i, { cta_href: e.target.value })}
                placeholder="/shop"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select
                className={fieldClass}
                value={slide.theme}
                onChange={(e) =>
                  setSlide(i, { theme: e.target.value as HeroSlide["theme"] })
                }
              >
                <option value="dark">Dark text</option>
                <option value="light">Light text (adds a scrim)</option>
              </select>
              <ColorField
                value={slide.background}
                onChange={(v) => setSlide(i, { background: v })}
              />
            </div>
            <ImageUpload
              folder="homepage"
              defaultImage={slide.image_url || undefined}
              onUploadSuccess={(url) => setSlide(i, { image_url: url })}
            />
            <HeroImageFields
              image={slide.image_url}
              value={slide}
              overlay
              onChange={(patch) =>
                set(
                  "slides",
                  config.slides.map((s, j) =>
                    j === i ? withImageOptions(s, patch) : s,
                  ),
                )
              }
            />
            <VideoField
              value={slide.video_url}
              onChange={(url) => setSlide(i, { video_url: url })}
            />
          </div>
        ))}
        {config.slides.length < MAX_HERO_SLIDES && (
          <button
            type="button"
            onClick={() =>
              set("slides", [...config.slides, { ...EMPTY_SLIDE }])
            }
            className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
          >
            <Plus className="h-3.5 w-3.5" /> Add slide
          </button>
        )}
      </div>
    </>
  );
}

function UspBarFields({
  config,
  setConfig,
}: {
  config: UspBarConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const setItems = (items: UspItem[]) => setConfig({ ...config, items });
  const setItem = (i: number, patch: Partial<UspItem>) =>
    setItems(config.items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const move = (i: number, dir: -1 | 1) => {
    const target = i + dir;
    if (target < 0 || target >= config.items.length) return;
    const next = [...config.items];
    [next[i], next[target]] = [next[target], next[i]];
    setItems(next);
  };

  return (
    <>
      <div>
        <label className={labelClass}>Text theme</label>
        <select
          className={fieldClass}
          value={config.theme}
          onChange={(e) =>
            setConfig({
              ...config,
              theme: e.target.value as UspBarConfig["theme"],
            })
          }
        >
          <option value="dark">Dark text (light background)</option>
          <option value="light">Light text (dark background)</option>
        </select>
        <p className="text-muted-foreground mt-1 text-[11px]">
          For a dark strip, set a dark background in the Style tab and pick
          light text here.
        </p>
      </div>

      <div className="space-y-2">
        <label className={labelClass}>Items</label>
        {config.items.map((item, i) => (
          <div
            key={i}
            className="bg-background space-y-2 rounded-md border p-2"
          >
            <div className="flex items-center gap-2">
              <select
                className={`${fieldClass} max-w-[180px]`}
                value={item.icon}
                onChange={(e) =>
                  setItem(i, { icon: e.target.value as UspItem["icon"] })
                }
              >
                {USP_ICONS.map((icon) => (
                  <option key={icon} value={icon}>
                    {USP_ICON_LABELS[icon]}
                  </option>
                ))}
              </select>
              <div className="ml-auto flex items-center">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === config.items.length - 1}
                  title="Move down"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setItems(config.items.filter((_, j) => j !== i))
                  }
                  title="Remove"
                  className="text-muted-foreground hover:text-[var(--dash-red)] flex h-7 w-6 items-center justify-center rounded hover:bg-[var(--dash-red-soft)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={item.title}
                onChange={(e) => setItem(i, { title: e.target.value })}
                placeholder="Free delivery"
              />
              <input
                className={fieldClass}
                value={item.subtitle}
                onChange={(e) => setItem(i, { subtitle: e.target.value })}
                placeholder="On orders over ₹499 (optional)"
              />
            </div>
          </div>
        ))}
        {config.items.length < MAX_USP_ITEMS && (
          <button
            type="button"
            onClick={() =>
              setItems([
                ...config.items,
                { icon: "star", title: "", subtitle: "" },
              ])
            }
            className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
          >
            <Plus className="h-3.5 w-3.5" /> Add item
          </button>
        )}
      </div>
    </>
  );
}

function TickerFields({
  config,
  setConfig,
}: {
  config: TickerConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const setMessages = (messages: string[]) =>
    setConfig({ ...config, messages });
  const setMessage = (i: number, value: string) =>
    setMessages(config.messages.map((m, j) => (j === i ? value : m)));
  const move = (i: number, dir: -1 | 1) => {
    const target = i + dir;
    if (target < 0 || target >= config.messages.length) return;
    const next = [...config.messages];
    [next[i], next[target]] = [next[target], next[i]];
    setMessages(next);
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Speed</label>
          <select
            className={fieldClass}
            value={config.speed}
            onChange={(e) =>
              setConfig({
                ...config,
                speed: e.target.value as TickerConfig["speed"],
              })
            }
          >
            <option value="slow">Slow</option>
            <option value="medium">Medium</option>
            <option value="fast">Fast</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Text theme</label>
          <select
            className={fieldClass}
            value={config.theme}
            onChange={(e) =>
              setConfig({
                ...config,
                theme: e.target.value as TickerConfig["theme"],
              })
            }
          >
            <option value="dark">Dark text (light background)</option>
            <option value="light">Light text (dark background)</option>
          </select>
        </div>
      </div>
      <p className="text-muted-foreground -mt-1 text-[11px]">
        For a dark strip, set a dark background in the Style tab and pick light
        text here.
      </p>

      <div className="space-y-2">
        <label className={labelClass}>Messages</label>
        {config.messages.map((message, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className={fieldClass}
              value={message}
              onChange={(e) => setMessage(i, e.target.value)}
              placeholder="Free shipping over ₹499"
              maxLength={120}
            />
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                title="Move up"
                className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
              >
                <ChevronUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === config.messages.length - 1}
                title="Move down"
                className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() =>
                  setMessages(config.messages.filter((_, j) => j !== i))
                }
                title="Remove"
                className="text-muted-foreground hover:text-[var(--dash-red)] flex h-7 w-6 items-center justify-center rounded hover:bg-[var(--dash-red-soft)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}
        {config.messages.length < MAX_TICKER_MESSAGES && (
          <button
            type="button"
            onClick={() => setMessages([...config.messages, ""])}
            className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
          >
            <Plus className="h-3.5 w-3.5" /> Add message
          </button>
        )}
      </div>
    </>
  );
}

function TileGridFields({
  config,
  setConfig,
}: {
  config: TileGridConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof TileGridConfig>(
    key: K,
    value: TileGridConfig[K],
  ) => setConfig({ ...config, [key]: value });
  const setTile = (i: number, patch: Partial<TileItem>) =>
    set(
      "tiles",
      config.tiles.map((t, j) => (j === i ? { ...t, ...patch } : t)),
    );
  const move = (i: number, dir: -1 | 1) => {
    const target = i + dir;
    if (target < 0 || target >= config.tiles.length) return;
    const next = [...config.tiles];
    [next[i], next[target]] = [next[target], next[i]];
    set("tiles", next);
  };

  return (
    <>
      <FieldGroup title="Header & layout">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Heading</label>
            <input
              className={fieldClass}
              value={config.heading}
              onChange={(e) => set("heading", e.target.value)}
              placeholder="Top offers this week"
            />
          </div>
          <div>
            <label className={labelClass}>Subheading</label>
            <input
              className={fieldClass}
              value={config.subheading}
              onChange={(e) => set("subheading", e.target.value)}
              placeholder="(optional)"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Columns (desktop)</label>
            <select
              className={fieldClass}
              value={config.columns}
              onChange={(e) =>
                set(
                  "columns",
                  Number(e.target.value) as TileGridConfig["columns"],
                )
              }
            >
              <option value={2}>2 — mini banners</option>
              <option value={3}>3</option>
              <option value={4}>4 — offer tiles</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Tile height</label>
            <select
              className={fieldClass}
              value={config.height}
              onChange={(e) =>
                set("height", e.target.value as TileGridConfig["height"])
              }
            >
              <option value="sm">Short</option>
              <option value="md">Medium</option>
              <option value="lg">Tall</option>
            </select>
          </div>
        </div>
      </FieldGroup>

      <div className="space-y-2">
        <label className={labelClass}>Tiles</label>
        {config.tiles.map((tile, i) => (
          <div
            key={i}
            className="bg-background space-y-2 rounded-md border p-2"
          >
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs font-medium">
                Tile {i + 1}
              </span>
              <div className="ml-auto flex items-center">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === config.tiles.length - 1}
                  title="Move down"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    set(
                      "tiles",
                      config.tiles.filter((_, j) => j !== i),
                    )
                  }
                  title="Remove"
                  className="text-muted-foreground hover:text-[var(--dash-red)] flex h-7 w-6 items-center justify-center rounded hover:bg-[var(--dash-red-soft)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={tile.title}
                onChange={(e) => setTile(i, { title: e.target.value })}
                placeholder="Fresh produce"
              />
              <input
                className={fieldClass}
                value={tile.subtitle}
                onChange={(e) => setTile(i, { subtitle: e.target.value })}
                placeholder="from ₹19 (optional)"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={tile.href}
                onChange={(e) => setTile(i, { href: e.target.value })}
                placeholder="/collections/fruits"
              />
              <select
                className={fieldClass}
                value={tile.theme}
                onChange={(e) =>
                  setTile(i, { theme: e.target.value as TileItem["theme"] })
                }
              >
                <option value="dark">Dark text</option>
                <option value="light">Light text</option>
              </select>
            </div>
            <ColorField
              value={tile.background}
              onChange={(v) => setTile(i, { background: v })}
            />
            <ImageUpload
              folder="homepage"
              defaultImage={tile.image_url || undefined}
              onUploadSuccess={(url) => setTile(i, { image_url: url })}
            />
          </div>
        ))}
        {config.tiles.length < MAX_TILES && (
          <button
            type="button"
            onClick={() =>
              set("tiles", [
                ...config.tiles,
                {
                  title: "",
                  subtitle: "",
                  href: "",
                  image_url: "",
                  background: "",
                  theme: "dark",
                },
              ])
            }
            className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
          >
            <Plus className="h-3.5 w-3.5" /> Add tile
          </button>
        )}
      </div>
    </>
  );
}

function FaqFields({
  config,
  setConfig,
}: {
  config: FaqAccordionConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof FaqAccordionConfig>(
    key: K,
    value: FaqAccordionConfig[K],
  ) => setConfig({ ...config, [key]: value });
  const setItem = (i: number, patch: Partial<FaqItem>) =>
    set(
      "items",
      config.items.map((it, j) => (j === i ? { ...it, ...patch } : it)),
    );
  const move = (i: number, dir: -1 | 1) => {
    const target = i + dir;
    if (target < 0 || target >= config.items.length) return;
    const next = [...config.items];
    [next[i], next[target]] = [next[target], next[i]];
    set("items", next);
  };

  return (
    <>
      <FieldGroup title="Header">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Heading</label>
            <input
              className={fieldClass}
              value={config.heading}
              onChange={(e) => set("heading", e.target.value)}
              placeholder="Frequently asked questions"
            />
          </div>
          <div>
            <label className={labelClass}>Subheading</label>
            <input
              className={fieldClass}
              value={config.subheading}
              onChange={(e) => set("subheading", e.target.value)}
              placeholder="(optional)"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.show_filters}
            onChange={(e) => set("show_filters", e.target.checked)}
          />
          Show category filter pills
        </label>
      </FieldGroup>

      <div className="space-y-2">
        <label className={labelClass}>Questions</label>
        {config.items.map((item, i) => (
          <div
            key={i}
            className="bg-background space-y-2 rounded-md border p-2"
          >
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs font-medium">
                Q{i + 1}
              </span>
              <div className="ml-auto flex items-center">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  title="Move up"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === config.items.length - 1}
                  title="Move down"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    set(
                      "items",
                      config.items.filter((_, j) => j !== i),
                    )
                  }
                  title="Remove"
                  className="text-muted-foreground hover:text-[var(--dash-red)] flex h-7 w-6 items-center justify-center rounded hover:bg-[var(--dash-red-soft)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <input
              className={fieldClass}
              value={item.question}
              onChange={(e) => setItem(i, { question: e.target.value })}
              placeholder="How fresh is the produce?"
            />
            <textarea
              className={`${fieldClass} min-h-[70px] resize-y`}
              value={item.answer}
              onChange={(e) => setItem(i, { answer: e.target.value })}
              placeholder="Answer…"
            />
            {config.show_filters && (
              <input
                className={fieldClass}
                value={item.category}
                onChange={(e) => setItem(i, { category: e.target.value })}
                placeholder="Filter group (e.g. Delivery)"
              />
            )}
          </div>
        ))}
        {config.items.length < MAX_FAQ_ITEMS && (
          <button
            type="button"
            onClick={() =>
              set("items", [
                ...config.items,
                { question: "", answer: "", category: "" },
              ])
            }
            className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
          >
            <Plus className="h-3.5 w-3.5" /> Add question
          </button>
        )}
      </div>
    </>
  );
}

function MediaTextFields({
  config,
  setConfig,
}: {
  config: MediaTextConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof MediaTextConfig>(
    key: K,
    value: MediaTextConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <FieldGroup title="Story">
        <div>
          <label className={labelClass}>Eyebrow</label>
          <input
            className={fieldClass}
            value={config.eyebrow}
            onChange={(e) => set("eyebrow", e.target.value)}
            placeholder="Our story"
          />
        </div>
        <div>
          <label className={labelClass}>Heading</label>
          <input
            className={fieldClass}
            value={config.heading}
            onChange={(e) => set("heading", e.target.value)}
            placeholder="Made with intention"
          />
        </div>
        <div>
          <label className={labelClass}>Body</label>
          <textarea
            className={`${fieldClass} min-h-[120px] resize-y`}
            value={config.body}
            onChange={(e) => set("body", e.target.value)}
            placeholder="Tell the story behind your materials, process or people."
          />
        </div>
      </FieldGroup>

      <FieldGroup title="Image">
        <ImageUpload
          folder="homepage"
          defaultImage={config.image_url || undefined}
          onUploadSuccess={(url) => set("image_url", url)}
        />
        <div>
          <label className={labelClass}>Image description</label>
          <input
            className={fieldClass}
            value={config.image_alt}
            onChange={(e) => set("image_alt", e.target.value)}
            placeholder="Describe the image for screen readers"
          />
        </div>
      </FieldGroup>

      <FieldGroup title="Layout">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>Image position</label>
            <select
              className={fieldClass}
              value={config.media_position}
              onChange={(e) =>
                set(
                  "media_position",
                  e.target.value as MediaTextConfig["media_position"],
                )
              }
            >
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Image shape</label>
            <select
              className={fieldClass}
              value={config.media_ratio}
              onChange={(e) =>
                set(
                  "media_ratio",
                  e.target.value as MediaTextConfig["media_ratio"],
                )
              }
            >
              <option value="portrait">Portrait</option>
              <option value="square">Square</option>
              <option value="landscape">Landscape</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Text alignment</label>
            <select
              className={fieldClass}
              value={config.alignment}
              onChange={(e) =>
                set("alignment", e.target.value as MediaTextConfig["alignment"])
              }
            >
              <option value="left">Left</option>
              <option value="center">Center</option>
            </select>
          </div>
        </div>
      </FieldGroup>

      <FieldGroup title="Button">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Button label</label>
            <input
              className={fieldClass}
              value={config.cta_label}
              onChange={(e) => set("cta_label", e.target.value)}
              placeholder="Discover more"
            />
          </div>
          <div>
            <label className={labelClass}>Button link</label>
            <input
              className={fieldClass}
              value={config.cta_href}
              onChange={(e) => set("cta_href", e.target.value)}
              placeholder="/our-story"
            />
          </div>
        </div>
      </FieldGroup>
    </>
  );
}

const EMPTY_GALLERY_ITEM: GalleryItem = {
  image_url: "",
  image_alt: "",
  caption: "",
  href: "",
};

function GalleryFields({
  config,
  setConfig,
}: {
  config: GalleryConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof GalleryConfig>(
    key: K,
    value: GalleryConfig[K],
  ) => setConfig({ ...config, [key]: value });
  const setItem = (index: number, patch: Partial<GalleryItem>) =>
    set(
      "items",
      config.items.map((item, i) =>
        i === index ? { ...item, ...patch } : item,
      ),
    );
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= config.items.length) return;
    const items = [...config.items];
    [items[index], items[target]] = [items[target], items[index]];
    set("items", items);
  };

  return (
    <>
      <FieldGroup title="Header">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Heading</label>
            <input
              className={fieldClass}
              value={config.heading}
              onChange={(e) => set("heading", e.target.value)}
              placeholder="The edit"
            />
          </div>
          <div>
            <label className={labelClass}>Subheading</label>
            <input
              className={fieldClass}
              value={config.subheading}
              onChange={(e) => set("subheading", e.target.value)}
              placeholder="A closer look at the collection"
            />
          </div>
        </div>
      </FieldGroup>

      <FieldGroup title="Layout">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>Composition</label>
            <select
              className={fieldClass}
              value={config.layout}
              onChange={(e) =>
                set("layout", e.target.value as GalleryConfig["layout"])
              }
            >
              <option value="editorial">Editorial lead image</option>
              <option value="grid">Even grid</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Columns</label>
            <select
              className={fieldClass}
              value={config.columns}
              onChange={(e) =>
                set(
                  "columns",
                  Number(e.target.value) as GalleryConfig["columns"],
                )
              }
            >
              <option value="2">2</option>
              <option value="3">3</option>
              <option value="4">4</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Image shape</label>
            <select
              className={fieldClass}
              value={config.image_ratio}
              onChange={(e) =>
                set(
                  "image_ratio",
                  e.target.value as GalleryConfig["image_ratio"],
                )
              }
            >
              <option value="portrait">Portrait</option>
              <option value="square">Square</option>
              <option value="landscape">Landscape</option>
            </select>
          </div>
        </div>
      </FieldGroup>

      <div className="space-y-2">
        <label className={labelClass}>Images</label>
        {config.items.map((item, index) => (
          <div
            key={index}
            className="bg-background space-y-2 rounded-md border p-2"
          >
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs font-medium">
                Image {index + 1}
              </span>
              <div className="ml-auto flex items-center">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  title="Move up"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === config.items.length - 1}
                  title="Move down"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    set(
                      "items",
                      config.items.filter((_, i) => i !== index),
                    )
                  }
                  title="Remove"
                  className="text-muted-foreground hover:text-[var(--dash-red)] flex h-7 w-6 items-center justify-center rounded hover:bg-[var(--dash-red-soft)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <ImageUpload
              folder="homepage"
              defaultImage={item.image_url || undefined}
              onUploadSuccess={(url) => setItem(index, { image_url: url })}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={item.image_alt}
                onChange={(e) => setItem(index, { image_alt: e.target.value })}
                placeholder="Image description"
              />
              <input
                className={fieldClass}
                value={item.caption}
                onChange={(e) => setItem(index, { caption: e.target.value })}
                placeholder="Caption (optional)"
              />
            </div>
            <input
              className={fieldClass}
              value={item.href}
              onChange={(e) => setItem(index, { href: e.target.value })}
              placeholder="Link (optional, e.g. /shop/new-arrivals)"
            />
          </div>
        ))}
        {config.items.length < MAX_GALLERY_ITEMS && (
          <button
            type="button"
            onClick={() =>
              set("items", [...config.items, { ...EMPTY_GALLERY_ITEM }])
            }
            className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
          >
            <Plus className="h-3.5 w-3.5" /> Add image
          </button>
        )}
      </div>
    </>
  );
}

const EMPTY_TESTIMONIAL: TestimonialItem = {
  quote: "",
  author: "",
  detail: "",
  logo_url: "",
  logo_alt: "",
};

function TestimonialsFields({
  config,
  setConfig,
}: {
  config: TestimonialsConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof TestimonialsConfig>(
    key: K,
    value: TestimonialsConfig[K],
  ) => setConfig({ ...config, [key]: value });
  const setItem = (index: number, patch: Partial<TestimonialItem>) =>
    set(
      "items",
      config.items.map((item, i) =>
        i === index ? { ...item, ...patch } : item,
      ),
    );
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= config.items.length) return;
    const items = [...config.items];
    [items[index], items[target]] = [items[target], items[index]];
    set("items", items);
  };

  return (
    <>
      <FieldGroup title="Header">
        <div>
          <label className={labelClass}>Eyebrow</label>
          <input
            className={fieldClass}
            value={config.eyebrow}
            onChange={(e) => set("eyebrow", e.target.value)}
            placeholder="Loved by customers"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Heading</label>
            <input
              className={fieldClass}
              value={config.heading}
              onChange={(e) => set("heading", e.target.value)}
              placeholder="What people are saying"
            />
          </div>
          <div>
            <label className={labelClass}>Subheading</label>
            <input
              className={fieldClass}
              value={config.subheading}
              onChange={(e) => set("subheading", e.target.value)}
              placeholder="(optional)"
            />
          </div>
        </div>
      </FieldGroup>

      <FieldGroup title="Layout">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Style</label>
            <select
              className={fieldClass}
              value={config.layout}
              onChange={(e) =>
                set("layout", e.target.value as TestimonialsConfig["layout"])
              }
            >
              <option value="cards">Cards</option>
              <option value="editorial">Editorial quotes</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Columns</label>
            <select
              className={fieldClass}
              value={config.columns}
              onChange={(e) =>
                set(
                  "columns",
                  Number(e.target.value) as TestimonialsConfig["columns"],
                )
              }
            >
              <option value="2">2</option>
              <option value="3">3</option>
            </select>
          </div>
        </div>
      </FieldGroup>

      <div className="space-y-2">
        <label className={labelClass}>Quotes and mentions</label>
        {config.items.map((item, index) => (
          <div
            key={index}
            className="bg-background space-y-2 rounded-md border p-2"
          >
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs font-medium">
                Item {index + 1}
              </span>
              <div className="ml-auto flex items-center">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  title="Move up"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronUp className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === config.items.length - 1}
                  title="Move down"
                  className="text-muted-foreground hover:bg-muted flex h-7 w-6 items-center justify-center rounded disabled:opacity-30"
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    set(
                      "items",
                      config.items.filter((_, i) => i !== index),
                    )
                  }
                  title="Remove"
                  className="text-muted-foreground hover:text-[var(--dash-red)] flex h-7 w-6 items-center justify-center rounded hover:bg-[var(--dash-red-soft)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <textarea
              className={`${fieldClass} min-h-[88px] resize-y`}
              value={item.quote}
              onChange={(e) => setItem(index, { quote: e.target.value })}
              placeholder="The product changed our daily ritual…"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                className={fieldClass}
                value={item.author}
                onChange={(e) => setItem(index, { author: e.target.value })}
                placeholder="Name or publication"
              />
              <input
                className={fieldClass}
                value={item.detail}
                onChange={(e) => setItem(index, { detail: e.target.value })}
                placeholder="Customer, city or award"
              />
            </div>
            <div>
              <label className={labelClass}>Logo (optional)</label>
              <ImageUpload
                folder="homepage"
                defaultImage={item.logo_url || undefined}
                onUploadSuccess={(url) => setItem(index, { logo_url: url })}
              />
              <input
                className={`${fieldClass} mt-2`}
                value={item.logo_alt}
                onChange={(e) => setItem(index, { logo_alt: e.target.value })}
                placeholder="Logo description"
              />
            </div>
          </div>
        ))}
        {config.items.length < MAX_TESTIMONIAL_ITEMS && (
          <button
            type="button"
            onClick={() =>
              set("items", [...config.items, { ...EMPTY_TESTIMONIAL }])
            }
            className="text-muted-foreground hover:bg-muted flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
          >
            <Plus className="h-3.5 w-3.5" /> Add item
          </button>
        )}
      </div>
    </>
  );
}

function VideoFields({
  config,
  setConfig,
}: {
  config: VideoConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof VideoConfig>(key: K, value: VideoConfig[K]) =>
    setConfig({ ...config, [key]: value });

  return (
    <>
      <FieldGroup title="Header">
        <div>
          <label className={labelClass}>Eyebrow</label>
          <input
            className={fieldClass}
            value={config.eyebrow}
            onChange={(e) => set("eyebrow", e.target.value)}
            placeholder="Watch"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Heading</label>
            <input
              className={fieldClass}
              value={config.heading}
              onChange={(e) => set("heading", e.target.value)}
              placeholder="See the story unfold"
            />
          </div>
          <div>
            <label className={labelClass}>Subheading</label>
            <input
              className={fieldClass}
              value={config.subheading}
              onChange={(e) => set("subheading", e.target.value)}
              placeholder="(optional)"
            />
          </div>
        </div>
      </FieldGroup>

      <FieldGroup title="Video">
        <VideoField
          value={config.video_url}
          onChange={(url) => set("video_url", url)}
        />
        <div>
          <label className={labelClass}>Poster image</label>
          <ImageUpload
            folder="homepage"
            defaultImage={config.poster_url || undefined}
            onUploadSuccess={(url) => set("poster_url", url)}
          />
          <input
            className={`${fieldClass} mt-2`}
            value={config.poster_alt}
            onChange={(e) => set("poster_alt", e.target.value)}
            placeholder="Describe the poster image"
          />
        </div>
      </FieldGroup>

      <FieldGroup title="Playback and layout">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Aspect ratio</label>
            <select
              className={fieldClass}
              value={config.aspect_ratio}
              onChange={(e) =>
                set(
                  "aspect_ratio",
                  e.target.value as VideoConfig["aspect_ratio"],
                )
              }
            >
              <option value="landscape">Landscape (16:9)</option>
              <option value="square">Square</option>
              <option value="portrait">Portrait</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Width</label>
            <select
              className={fieldClass}
              value={config.width}
              onChange={(e) =>
                set("width", e.target.value as VideoConfig["width"])
              }
            >
              <option value="contained">Contained</option>
              <option value="full">Full width</option>
            </select>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.autoplay}
            onChange={(e) => set("autoplay", e.target.checked)}
          />
          Auto-play muted
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.loop}
            onChange={(e) => set("loop", e.target.checked)}
          />
          Loop playback
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.controls}
            onChange={(e) => set("controls", e.target.checked)}
          />
          Show player controls
        </label>
      </FieldGroup>
    </>
  );
}

function NewsletterFields({
  config,
  setConfig,
}: {
  config: NewsletterSectionConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof NewsletterSectionConfig>(
    key: K,
    value: NewsletterSectionConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <FieldGroup title="Message">
        <div>
          <label className={labelClass}>Eyebrow</label>
          <input
            className={fieldClass}
            value={config.eyebrow}
            onChange={(e) => set("eyebrow", e.target.value)}
            placeholder="Stay close"
          />
        </div>
        <div>
          <label className={labelClass}>Heading</label>
          <input
            className={fieldClass}
            value={config.heading}
            onChange={(e) => set("heading", e.target.value)}
            placeholder="Notes worth opening"
          />
        </div>
        <div>
          <label className={labelClass}>Subheading</label>
          <textarea
            className={`${fieldClass} min-h-[72px] resize-y`}
            value={config.subheading}
            onChange={(e) => set("subheading", e.target.value)}
            placeholder="New releases, useful stories and occasional offers."
          />
        </div>
      </FieldGroup>

      <FieldGroup title="Form copy">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Button label</label>
            <input
              className={fieldClass}
              value={config.button_label}
              onChange={(e) => set("button_label", e.target.value)}
              placeholder="Subscribe"
            />
          </div>
          <div>
            <label className={labelClass}>Success message</label>
            <input
              className={fieldClass}
              value={config.success_message}
              onChange={(e) => set("success_message", e.target.value)}
              placeholder="You're on the list — thank you."
            />
          </div>
        </div>
        <div>
          <label className={labelClass}>Consent text</label>
          <textarea
            className={`${fieldClass} min-h-[72px] resize-y`}
            value={config.consent_text}
            onChange={(e) => set("consent_text", e.target.value)}
            placeholder="I agree to receive store news and offers by email."
          />
          <p className="text-muted-foreground mt-1 text-[11px]">
            Visitors must tick this before subscribing.
          </p>
        </div>
      </FieldGroup>

      <FieldGroup title="Layout">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass}>Alignment</label>
            <select
              className={fieldClass}
              value={config.alignment}
              onChange={(e) =>
                set(
                  "alignment",
                  e.target.value as NewsletterSectionConfig["alignment"],
                )
              }
            >
              <option value="center">Centered</option>
              <option value="left">Split / left</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Text theme</label>
            <select
              className={fieldClass}
              value={config.theme}
              onChange={(e) =>
                set("theme", e.target.value as NewsletterSectionConfig["theme"])
              }
            >
              <option value="dark">Dark text / light field</option>
              <option value="light">Light text / dark field</option>
            </select>
          </div>
        </div>
      </FieldGroup>
    </>
  );
}

function FeaturedFields({
  config,
  setConfig,
  products,
  categories,
}: {
  config: FeaturedProductsConfig;
  setConfig: (c: AnySectionConfig) => void;
  products: ProductOption[];
  categories: CategoryOption[];
}) {
  const set = <K extends keyof FeaturedProductsConfig>(
    key: K,
    value: FeaturedProductsConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Heading</label>
          <input
            className={fieldClass}
            value={config.heading}
            onChange={(e) => set("heading", e.target.value)}
            placeholder="Bestsellers"
          />
        </div>
        <div>
          <label className={labelClass}>Subheading</label>
          <input
            className={fieldClass}
            value={config.subheading}
            onChange={(e) => set("subheading", e.target.value)}
            placeholder="(optional)"
          />
        </div>
      </div>

      <div>
        <label className={labelClass}>Which products?</label>
        <select
          className={fieldClass}
          value={config.source}
          onChange={(e) =>
            set("source", e.target.value as FeaturedProductsConfig["source"])
          }
        >
          <option value="featured">Featured products (auto)</option>
          <option value="manual">Hand-picked</option>
          <option value="category">All from a category</option>
        </select>
      </div>

      {config.source === "manual" && (
        <div>
          <label className={labelClass}>Products (in display order)</label>
          <OrderedPicker
            selectedIds={config.product_ids}
            options={products.map((p) => ({ id: p.id, name: p.name }))}
            onChange={(ids) => set("product_ids", ids)}
            addLabel="Add a product..."
          />
        </div>
      )}

      {config.source === "category" && (
        <div>
          <label className={labelClass}>Category</label>
          <select
            className={fieldClass}
            value={config.category_id ?? ""}
            onChange={(e) => set("category_id", e.target.value || null)}
          >
            <option value="">Select a category...</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {config.source !== "manual" && (
        <div className="max-w-[160px]">
          <label className={labelClass}>Max products</label>
          <NumberField
            className={fieldClass}
            value={config.limit}
            onValueChange={(n) => set("limit", n)}
            allowDecimal={false}
          />
          <p className="text-muted-foreground mt-1 text-[11px]">1–12.</p>
        </div>
      )}
    </>
  );
}

function CategoryFields({
  config,
  setConfig,
  categories,
}: {
  config: ShopByCategoryConfig;
  setConfig: (c: AnySectionConfig) => void;
  categories: CategoryOption[];
}) {
  const set = <K extends keyof ShopByCategoryConfig>(
    key: K,
    value: ShopByCategoryConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Heading</label>
          <input
            className={fieldClass}
            value={config.heading}
            onChange={(e) => set("heading", e.target.value)}
            placeholder="Shop by Category"
          />
        </div>
        <div>
          <label className={labelClass}>Subheading</label>
          <input
            className={fieldClass}
            value={config.subheading}
            onChange={(e) => set("subheading", e.target.value)}
            placeholder="(optional)"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Which categories?</label>
          <select
            className={fieldClass}
            value={config.source}
            onChange={(e) =>
              set("source", e.target.value as ShopByCategoryConfig["source"])
            }
          >
            <option value="all">All active categories</option>
            <option value="selected">Selected only</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Layout</label>
          <select
            className={fieldClass}
            value={config.layout}
            onChange={(e) =>
              set("layout", e.target.value as ShopByCategoryConfig["layout"])
            }
          >
            <option value="grid">Grid</option>
            <option value="scroll">Horizontal scroll</option>
          </select>
        </div>
      </div>

      <div className="max-w-[220px]">
        <label className={labelClass}>Tile shape</label>
        <select
          className={fieldClass}
          value={config.display ?? "circles"}
          onChange={(e) =>
            set("display", e.target.value as ShopByCategoryConfig["display"])
          }
        >
          <option value="circles">Circles</option>
          <option value="cards">Rounded cards</option>
        </select>
      </div>

      {config.source === "selected" && (
        <div>
          <label className={labelClass}>Categories (in display order)</label>
          <OrderedPicker
            selectedIds={config.category_ids}
            options={categories.map((c) => ({ id: c.id, name: c.name }))}
            onChange={(ids) => set("category_ids", ids)}
            addLabel="Add a category..."
          />
        </div>
      )}
    </>
  );
}

function BannerFields({
  config,
  setConfig,
}: {
  config: PromoBannerConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof PromoBannerConfig>(
    key: K,
    value: PromoBannerConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <div>
        <label className={labelClass}>Banner image</label>
        <ImageUpload
          folder="homepage"
          defaultImage={config.image_url || undefined}
          onUploadSuccess={(url) => set("image_url", url)}
        />
      </div>

      <div>
        <label className={labelClass}>Heading</label>
        <input
          className={fieldClass}
          value={config.heading}
          onChange={(e) => set("heading", e.target.value)}
          placeholder="Summer Sale"
        />
      </div>

      <div>
        <label className={labelClass}>Subtext</label>
        <textarea
          className={`${fieldClass} min-h-[60px] resize-y`}
          value={config.subtext}
          onChange={(e) => set("subtext", e.target.value)}
          placeholder="(optional)"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Button label</label>
          <input
            className={fieldClass}
            value={config.cta_label}
            onChange={(e) => set("cta_label", e.target.value)}
            placeholder="Shop now"
          />
        </div>
        <div>
          <label className={labelClass}>Button link</label>
          <input
            className={fieldClass}
            value={config.cta_href}
            onChange={(e) => set("cta_href", e.target.value)}
            placeholder="/shop"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Text alignment</label>
          <select
            className={fieldClass}
            value={config.alignment}
            onChange={(e) =>
              set("alignment", e.target.value as PromoBannerConfig["alignment"])
            }
          >
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Text theme</label>
          <select
            className={fieldClass}
            value={config.theme}
            onChange={(e) =>
              set("theme", e.target.value as PromoBannerConfig["theme"])
            }
          >
            <option value="light">Light (dark image)</option>
            <option value="dark">Dark (light image)</option>
          </select>
        </div>
      </div>
    </>
  );
}

function BlogFields({
  config,
  setConfig,
  blogs,
}: {
  config: LatestBlogsConfig;
  setConfig: (c: AnySectionConfig) => void;
  blogs: BlogOption[];
}) {
  const set = <K extends keyof LatestBlogsConfig>(
    key: K,
    value: LatestBlogsConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Heading</label>
          <input
            className={fieldClass}
            value={config.heading}
            onChange={(e) => set("heading", e.target.value)}
            placeholder="From the Journal"
          />
        </div>
        <div>
          <label className={labelClass}>Subheading</label>
          <input
            className={fieldClass}
            value={config.subheading}
            onChange={(e) => set("subheading", e.target.value)}
            placeholder="(optional)"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Which posts?</label>
          <select
            className={fieldClass}
            value={config.source}
            onChange={(e) =>
              set("source", e.target.value as LatestBlogsConfig["source"])
            }
          >
            <option value="latest">Latest published (auto)</option>
            <option value="featured">Featured posts (auto)</option>
            <option value="manual">Hand-picked</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>Layout</label>
          <select
            className={fieldClass}
            value={config.layout}
            onChange={(e) =>
              set("layout", e.target.value as LatestBlogsConfig["layout"])
            }
          >
            <option value="grid">Grid</option>
            <option value="scroll">Horizontal scroll</option>
          </select>
        </div>
      </div>

      {config.source === "manual" ? (
        <div>
          <label className={labelClass}>Posts (in display order)</label>
          <OrderedPicker
            selectedIds={config.blog_ids}
            options={blogs.map((b) => ({ id: b.id, name: b.name }))}
            onChange={(ids) => set("blog_ids", ids)}
            addLabel="Add a blog post..."
          />
          {blogs.length === 0 && (
            <p className="text-muted-foreground mt-1 text-[11px]">
              No published blogs yet — publish a post first.
            </p>
          )}
        </div>
      ) : (
        <div className="max-w-[160px]">
          <label className={labelClass}>Max posts</label>
          <NumberField
            className={fieldClass}
            value={config.limit}
            onValueChange={(n) => set("limit", n)}
            allowDecimal={false}
          />
          <p className="text-muted-foreground mt-1 text-[11px]">1–12.</p>
        </div>
      )}
    </>
  );
}

function RichTextFields({
  config,
  setConfig,
}: {
  config: RichTextConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof RichTextConfig>(
    key: K,
    value: RichTextConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <div>
        <label className={labelClass}>Content (HTML)</label>
        <CodeEditor
          language="html"
          value={config.html}
          onChange={(v) => set("html", v)}
          placeholder="<h2>About us</h2>&#10;<p>Tell your story…</p>"
          minHeight="180px"
        />
        <p className="text-muted-foreground mt-1 text-[11px]">
          Basic HTML — headings, paragraphs, links, lists, images. Unsafe tags
          and scripts are removed automatically.
        </p>
      </div>
      <div className="max-w-[220px]">
        <label className={labelClass}>Width</label>
        <select
          className={fieldClass}
          value={config.width}
          onChange={(e) =>
            set("width", e.target.value as RichTextConfig["width"])
          }
        >
          <option value="contained">Contained (readable column)</option>
          <option value="full">Full width</option>
        </select>
      </div>
    </>
  );
}

function CustomCodeFields({
  config,
  setConfig,
}: {
  config: CustomCodeConfig;
  setConfig: (c: AnySectionConfig) => void;
}) {
  const set = <K extends keyof CustomCodeConfig>(
    key: K,
    value: CustomCodeConfig[K],
  ) => setConfig({ ...config, [key]: value });

  return (
    <>
      <div className="rounded-md border border-[var(--dash-amber-border,#f0c67a)] bg-[var(--dash-amber-soft,#fdf6e7)] px-3 py-2 text-[11px] leading-relaxed text-[var(--dash-amber-ink,#8a6d1f)]">
        Your code runs in a secure sandbox — isolated from the rest of your site
        and from customer accounts. Great for self-contained widgets (carousels,
        embeds, animations).
      </div>

      <div>
        <label className={labelClass}>HTML</label>
        <CodeEditor
          language="html"
          value={config.html}
          onChange={(v) => set("html", v)}
          placeholder="<div class='my-carousel'>…</div>"
          minHeight="280px"
        />
      </div>

      <div>
        <label className={labelClass}>CSS</label>
        <CodeEditor
          language="css"
          value={config.css}
          onChange={(v) => set("css", v)}
          placeholder=".my-carousel { … }"
          minHeight="240px"
        />
      </div>

      <div>
        <label className={labelClass}>JavaScript</label>
        <CodeEditor
          language="javascript"
          value={config.js}
          onChange={(v) => set("js", v)}
          placeholder="// runs when the section loads"
          minHeight="240px"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Height</label>
          <select
            className={fieldClass}
            value={config.height_mode}
            onChange={(e) =>
              set(
                "height_mode",
                e.target.value as CustomCodeConfig["height_mode"],
              )
            }
          >
            <option value="auto">Auto (fit content)</option>
            <option value="fixed">Fixed</option>
          </select>
        </div>
        {config.height_mode === "fixed" && (
          <div>
            <label className={labelClass}>Height (px)</label>
            <NumberField
              className={fieldClass}
              value={config.fixed_height}
              onValueChange={(n) => set("fixed_height", n)}
              allowDecimal={false}
            />
          </div>
        )}
      </div>

      {(config.html.trim() || config.css.trim() || config.js.trim()) && (
        <div>
          <label className={labelClass}>Live preview</label>
          <div className="overflow-hidden rounded-md border">
            <CustomCodeFrame config={config} title="Custom code preview" />
          </div>
        </div>
      )}
    </>
  );
}
