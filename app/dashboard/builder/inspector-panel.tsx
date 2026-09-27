"use client";

import { useEffect, useState, useTransition } from "react";
import {
  ArrowLeft,
  Code2,
  Copy,
  Paintbrush,
  Settings2,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  SECTION_TYPE_META,
  type AnySectionConfig,
  type CustomCodeConfig,
  type SectionPaddingY,
  type SectionStyle,
} from "@/lib/homepage/section-types";
import type { PageSectionItem } from "@/lib/sections/registry";
import type { ThemeDesignDefaults } from "@/lib/chrome/design";
import {
  SCHEMELESS_SECTION_TYPES,
  SECTION_SCHEMES,
  SECTION_SCHEME_META,
  schemePreviews,
  withPaletteOverrides,
  type SchemeDesign,
  type SectionScheme,
} from "@/lib/themes/schemes";
import type { PageDraft } from "@/app/actions/page-actions";
import type { StoreChrome } from "@/lib/chrome/types";
import {
  HeaderForm,
  FooterForm,
  BrandForm,
  type BrandAppearance,
} from "./chrome-form";
import {
  SectionForm,
  fieldClass,
  labelClass,
  type BlogOption,
  type CategoryOption,
  type ProductOption,
} from "./section-form";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";

type Options = {
  products: ProductOption[];
  categories: CategoryOption[];
  blogs: BlogOption[];
};

type Tab = "content" | "style" | "advanced";

// Right panel. Two modes:
//   • a section is selected → section inspector (Content / Style / Advanced),
//     writing through to the draft on every change (autosaved upstream);
//   • nothing selected → page settings (title/slug/SEO/delete).
export function InspectorPanel({
  draft,
  section,
  options,
  onConfigChange,
  onStyleChange,
  onDuplicate,
  onDelete,
  onClearSelection,
  onOpenCodeEditor,
  onOpenPageSettings,
  chromeTarget,
  chrome,
  onChromeChange,
  themeDefaults,
  schemeDesign,
  onClearChrome,
  brand,
  onBrandChange,
  loading,
}: {
  draft: PageDraft | null;
  section: PageSectionItem | null;
  options: Options;
  onConfigChange: (config: AnySectionConfig) => void;
  onStyleChange: (style: SectionStyle) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClearSelection: () => void;
  onOpenCodeEditor: () => void;
  onOpenPageSettings: () => void;
  /** Editing the site-wide header/footer instead of a page section. */
  chromeTarget: "header" | "footer" | "brand" | null;
  chrome: StoreChrome;
  onChromeChange: (next: StoreChrome) => void;
  onClearChrome: () => void;
  brand: BrandAppearance;
  themeDefaults: ThemeDesignDefaults;
  schemeDesign: SchemeDesign;
  onBrandChange: (next: BrandAppearance) => void;
  /** A page is being opened — do not tell the merchant to pick one. */
  loading: boolean;
}) {
  const [tab, setTab] = useState<Tab>("content");

  // Selecting a different section resets to the Content tab.
  const sectionId = section?.id ?? null;
  const [prevSectionId, setPrevSectionId] = useState(sectionId);
  if (sectionId !== prevSectionId) {
    setPrevSectionId(sectionId);
    setTab("content");
  }

  // Chrome is store-wide, so it is editable even before a page is chosen —
  // this branch deliberately sits ABOVE the "select a page" guard.
  if (chromeTarget) {
    return (
      <aside className="sm-builder-inspector has-selection">
        <div className="sm-builder-inspector-head">
          <button
            type="button"
            className="sm-builder-inspector-back"
            onClick={onClearChrome}
            aria-label="Back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <span className="sm-builder-inspector-title">
            {chromeTarget === "header"
              ? "Header"
              : chromeTarget === "brand"
                ? "Brand"
                : "Footer"}
          </span>
        </div>
        <div className="sm-builder-inspector-body">
          <p className="sm-b-scope">Appears on every page of your store.</p>
          {chromeTarget === "header" ? (
            <HeaderForm chrome={chrome} onChange={onChromeChange} />
          ) : chromeTarget === "brand" ? (
            <BrandForm
              brand={brand}
              onChange={onBrandChange}
              chrome={chrome}
              onChromeChange={onChromeChange}
              themeDefaults={themeDefaults}
            />
          ) : (
            <FooterForm chrome={chrome} onChange={onChromeChange} />
          )}
        </div>
      </aside>
    );
  }

  if (!draft) {
    return (
      <aside className="sm-builder-inspector">
        {/* "Select a page" while a page is ALREADY opening tells the merchant
            to do something that is underway — the builder auto-opens Home, and
            on a slow connection that took long enough to read as broken. */}
        <p className="sm-builder-empty">
          {loading ? "Opening…" : "Select a page to start editing."}
        </p>
      </aside>
    );
  }

  if (!section) {
    return (
      <aside className="sm-builder-inspector">
        <div className="sm-builder-inspector-idle">
          <p className="sm-builder-inspector-idle-hint">
            Click a section on the canvas — or in the outline — to edit it.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onOpenPageSettings}
          >
            <Settings2 className="mr-1.5 h-4 w-4" /> Page settings
          </Button>
        </div>
      </aside>
    );
  }

  const meta = SECTION_TYPE_META[section.type];

  return (
    <aside className="sm-builder-inspector has-selection">
      <div className="sm-builder-inspector-head">
        <button
          className="sm-builder-backbtn"
          onClick={onClearSelection}
          title="Back to page settings"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="sm-builder-inspector-title">{meta.label}</span>
      </div>

      <div className="sm-builder-tabs">
        <TabButton
          active={tab === "content"}
          onClick={() => setTab("content")}
          icon={<SlidersHorizontal className="h-3.5 w-3.5" />}
          label="Content"
        />
        <TabButton
          active={tab === "style"}
          onClick={() => setTab("style")}
          icon={<Paintbrush className="h-3.5 w-3.5" />}
          label="Style"
        />
        <TabButton
          active={tab === "advanced"}
          onClick={() => setTab("advanced")}
          icon={<Settings2 className="h-3.5 w-3.5" />}
          label="Advanced"
        />
      </div>

      <div className="sm-builder-inspector-body">
        {tab === "content" &&
          (section.type === "custom_code" ? (
            <CustomCodeSummary
              config={section.config as CustomCodeConfig}
              onOpen={onOpenCodeEditor}
            />
          ) : (
            <div className="space-y-5">
              <SectionForm
                type={section.type}
                config={section.config}
                setConfig={onConfigChange}
                products={options.products}
                categories={options.categories}
                blogs={options.blogs}
              />
            </div>
          ))}

        {tab === "style" && (
          <StyleForm
            sectionType={section.type}
            style={section.style ?? {}}
            onChange={onStyleChange}
            schemeDesign={withPaletteOverrides(
              schemeDesign,
              chrome.design.palette,
            )}
            brandPrimary={brand.primaryColor}
          />
        )}

        {tab === "advanced" && (
          <div className="space-y-5">
            <div>
              <label className={labelClass}>Anchor id</label>
              <input
                className={fieldClass}
                value={section.style?.anchor ?? ""}
                onChange={(e) =>
                  onStyleChange({
                    ...(section.style ?? {}),
                    anchor: e.target.value.trim().toLowerCase(),
                  })
                }
                placeholder="our-story"
              />
              <p className="text-muted-foreground mt-1 text-[11px]">
                Link straight to this section with /{draft.slug || ""}#anchor.
                Lowercase letters, numbers, hyphens; must start with a letter.
              </p>
            </div>

            <div className="flex flex-col gap-2 border-t pt-4">
              <Button variant="outline" size="sm" onClick={onDuplicate}>
                <Copy className="mr-1.5 h-4 w-4" /> Duplicate section
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-[var(--dash-red,#d33a45)]"
                onClick={onDelete}
              >
                <Trash2 className="mr-1.5 h-4 w-4" /> Delete section
              </Button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      className={`sm-builder-tab ${active ? "active" : ""}`}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

// --- Style tab ---------------------------------------------------------------

const PADDING_OPTIONS: { value: SectionPaddingY; label: string }[] = [
  { value: "none", label: "None" },
  { value: "sm", label: "S" },
  { value: "md", label: "M" },
  { value: "lg", label: "L" },
];

// Quick style presets: each chip is just a SectionStyle partial layered over
// the current style. Pure data — the strict per-field validation still runs
// server-side on save.
// ★ "Tinted" and "Contrast" pick a colour SCHEME, not a raw background. They
//   used to set #f6f7f9 and #111827, and "Contrast" left the section's text
//   dark — dark text on a near-black band. A scheme changes text and buttons
//   with the background, in the theme's own colours.
const STYLE_PRESETS: {
  label: string;
  patch: Partial<SectionStyle>;
  scheme?: boolean;
}[] = [
  {
    label: "Plain",
    patch: { background: undefined, scheme: undefined, padding_y: "none" },
  },
  {
    label: "Tinted",
    patch: { background: undefined, scheme: "soft", padding_y: "md" },
    scheme: true,
  },
  {
    label: "Contrast",
    patch: { background: undefined, scheme: "inverse", padding_y: "lg" },
    scheme: true,
  },
  { label: "Airy", patch: { background: undefined, padding_y: "lg" } },
  { label: "Band", patch: { width: "full", padding_y: "md" } },
];

export function StyleForm({
  sectionType,
  style,
  onChange,
  schemeDesign,
  brandPrimary,
}: {
  sectionType: PageSectionItem["type"];
  style: SectionStyle;
  onChange: (style: SectionStyle) => void;
  schemeDesign: SchemeDesign;
  brandPrimary: string;
}) {
  const set = <K extends keyof SectionStyle>(key: K, value: SectionStyle[K]) =>
    onChange({ ...style, [key]: value });

  // A carousel or promo banner is covered by its own photo and custom code
  // cannot see the theme; neither takes a scheme (the server drops one too).
  const canScheme = !SCHEMELESS_SECTION_TYPES.includes(sectionType);
  const scheme = canScheme ? style.scheme : undefined;
  const previews = schemePreviews(schemeDesign, brandPrimary);
  const pickScheme = (next: SectionScheme | undefined) =>
    onChange({
      ...style,
      scheme: next,
      // A scheme owns the colours, so a custom background is cleared.
      background: next ? undefined : style.background,
      // A band with no padding puts its copy against the band's edge.
      padding_y:
        next && (!style.padding_y || style.padding_y === "none")
          ? "md"
          : style.padding_y,
    });

  // rich_text has its own width control (Content tab); banners and custom code
  // are already edge-to-edge by design.
  const showWidth = !["rich_text", "promo_banner", "custom_code"].includes(
    sectionType,
  );

  return (
    <div className="space-y-5">
      <div>
        <label className={labelClass}>Presets</label>
        <div className="sm-builder-presets">
          {STYLE_PRESETS.filter((p) => canScheme || !p.scheme).map((p) => (
            <button
              key={p.label}
              type="button"
              className="sm-builder-preset"
              onClick={() => onChange({ ...style, ...p.patch })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="text-muted-foreground mt-1 text-[11px]">
          One-click starting points — tweak anything below after.
        </p>
      </div>

      {canScheme && (
        <div>
          <label className={labelClass}>Colour scheme</label>
          <div
            className="sm-builder-schemes"
            role="radiogroup"
            aria-label="Colour scheme"
          >
            <button
              type="button"
              role="radio"
              aria-checked={!scheme}
              className={`sm-builder-scheme ${!scheme ? "active" : ""}`}
              onClick={() => pickScheme(undefined)}
            >
              <span className="sm-builder-scheme-swatch is-page">Aa</span>
              <span className="sm-builder-scheme-label">Page</span>
            </button>
            {SECTION_SCHEMES.map((id) => {
              const p = previews[id];
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={scheme === id}
                  title={SECTION_SCHEME_META[id].description}
                  className={`sm-builder-scheme ${scheme === id ? "active" : ""}`}
                  onClick={() => pickScheme(id)}
                >
                  <span
                    className="sm-builder-scheme-swatch"
                    style={{ background: p.background, color: p.text }}
                  >
                    Aa
                    <i style={{ background: p.accent }} />
                  </span>
                  <span className="sm-builder-scheme-label">
                    {SECTION_SCHEME_META[id].label}
                  </span>
                </button>
              );
            })}
          </div>
          {scheme && !previews[scheme].readable ? (
            <p className="mt-1 text-[11px] text-amber-700">
              Some text is hard to read in this scheme with your current
              colours. Try another, or adjust your colours under Brand.
            </p>
          ) : (
            <p className="text-muted-foreground mt-1 text-[11px]">
              {scheme
                ? `${SECTION_SCHEME_META[scheme].description}. Text, cards and buttons change with it.`
                : "Uses your page's colours."}
            </p>
          )}
        </div>
      )}

      {!scheme && (
        <div>
          <label className={labelClass}>Background color</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              className="h-9 w-11 cursor-pointer rounded-md border p-0.5"
              value={
                /^#[0-9a-f]{6}$/i.test(style.background ?? "")
                  ? (style.background as string)
                  : "#ffffff"
              }
              onChange={(e) => set("background", e.target.value)}
            />
            <input
              className={fieldClass}
              value={style.background ?? ""}
              onChange={(e) => set("background", e.target.value)}
              placeholder="transparent"
            />
            {style.background && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => set("background", undefined)}
              >
                Clear
              </Button>
            )}
          </div>
          <p className="text-muted-foreground mt-1 text-[11px]">
            Hex, rgb() or hsl(). Leave empty for the page background.
          </p>
        </div>
      )}

      <div>
        <label className={labelClass}>Vertical padding</label>
        <div className="sm-builder-segmented">
          {PADDING_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={`sm-builder-segment ${
                (style.padding_y ?? "none") === o.value ? "active" : ""
              }`}
              onClick={() => set("padding_y", o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <p className="text-muted-foreground mt-1 text-[11px]">
          Extra space above and below this section.
        </p>
      </div>

      {showWidth && (
        <div>
          <label className={labelClass}>Width</label>
          <div className="sm-builder-segmented">
            <button
              className={`sm-builder-segment ${(style.width ?? "contained") === "contained" ? "active" : ""}`}
              onClick={() => set("width", "contained")}
            >
              Contained
            </button>
            <button
              className={`sm-builder-segment ${style.width === "full" ? "active" : ""}`}
              onClick={() => set("width", "full")}
            >
              Full width
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- custom_code compact panel ------------------------------------------------

function CustomCodeSummary({
  config,
  onOpen,
}: {
  config: CustomCodeConfig;
  onOpen: () => void;
}) {
  const parts = [
    config.html.trim() && "HTML",
    config.css.trim() && "CSS",
    config.js.trim() && "JS",
  ].filter(Boolean);
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-[13px] leading-relaxed">
        {parts.length > 0
          ? `This section contains ${parts.join(" + ")}.`
          : "No code yet."}{" "}
        It runs in a secure sandbox, isolated from the rest of your site.
      </p>
      <Button className="w-full" onClick={onOpen}>
        <Code2 className="mr-1.5 h-4 w-4" /> Open code editor
      </Button>
    </div>
  );
}

// --- Page settings form (hosted in the builder's topbar dialog) --------------

export function PageSettingsForm({
  draft,
  onSave,
  onDeletePage,
}: {
  draft: PageDraft;
  onSave: (fields: {
    title: string;
    slug: string;
    seo_title: string;
    seo_description: string;
    seo_noindex: boolean;
  }) => Promise<boolean>;
  onDeletePage: () => void;
}) {
  const isHomepage = draft.slug === "";
  const [title, setTitle] = useState(draft.title);
  const [slug, setSlug] = useState(draft.slug);
  const [seoTitle, setSeoTitle] = useState(draft.seo_title);
  const [seoDescription, setSeoDescription] = useState(draft.seo_description);
  const [seoNoindex, setSeoNoindex] = useState(draft.seo_noindex);
  const [isPending, startTransition] = useTransition();

  // Publish/unpublish refresh the draft object — keep pristine fields synced
  // without clobbering in-progress edits (keyed remount handles page switch).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSlug((s) => (s === "" && draft.slug !== "" ? draft.slug : s));
  }, [draft.slug]);

  const dirty =
    title !== draft.title ||
    slug !== draft.slug ||
    seoTitle !== draft.seo_title ||
    seoDescription !== draft.seo_description ||
    seoNoindex !== draft.seo_noindex;

  // ★ use-autosave covers the SECTION draft, not this form — title, slug and
  // the SEO copy are held locally until "Save settings" is pressed.
  useUnsavedChangesWarning(dirty);

  const save = () => {
    startTransition(async () => {
      const ok = await onSave({
        title,
        slug,
        seo_title: seoTitle,
        seo_description: seoDescription,
        seo_noindex: seoNoindex,
      });
      if (ok) toast.success("Page settings saved");
    });
  };

  return (
    <div>
      <div className="space-y-5">
        <div>
          <label className={labelClass}>Title</label>
          <input
            className={fieldClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {!isHomepage && (
          <div>
            <label className={labelClass}>URL slug</label>
            <div className="flex items-center gap-1 text-sm">
              <span className="text-muted-foreground">/</span>
              <input
                className={fieldClass}
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              />
            </div>
            <p className="text-muted-foreground mt-1 text-[11px]">
              Changing this changes the page&apos;s address.
            </p>
          </div>
        )}

        <div>
          <label className={labelClass}>SEO title</label>
          <input
            className={fieldClass}
            value={seoTitle}
            onChange={(e) => setSeoTitle(e.target.value)}
            placeholder={title || "Page title"}
          />
        </div>

        <div>
          <label className={labelClass}>SEO description</label>
          <textarea
            className={`${fieldClass} min-h-[70px] resize-y`}
            value={seoDescription}
            onChange={(e) => setSeoDescription(e.target.value)}
          />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={seoNoindex}
            onChange={(e) => setSeoNoindex(e.target.checked)}
          />
          Hide from search engines (noindex)
        </label>

        <Button
          className="w-full"
          onClick={save}
          disabled={!dirty || isPending}
        >
          {isPending ? "Saving…" : "Save settings"}
        </Button>

        {!isHomepage && (
          <div className="border-t pt-4">
            <Button
              variant="outline"
              size="sm"
              className="w-full text-[var(--dash-red,#d33a45)]"
              onClick={onDeletePage}
            >
              <Trash2 className="mr-1.5 h-4 w-4" /> Delete page
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
