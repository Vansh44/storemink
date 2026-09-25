"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useTransition,
} from "react";
import Image from "next/image";
import Link from "next/link";
import { toast } from "sonner";
import {
  X,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Sparkles,
  Image as ImageIcon,
  Loader2,
  Package,
  Truck,
  Tag,
  Boxes,
  Layers,
  Eye,
  Search,
  type LucideIcon,
} from "lucide-react";
import { uploadImage } from "@/lib/storage/uploads";
import { Button } from "@/components/ui/button";
import { ImageUpload } from "@/components/ui/image-upload";
import { NumberField } from "@/components/ui/number-field";
import { slugify } from "@/lib/slug";
import {
  generateVariantRows,
  normalizeOptions,
  type ProductOption,
} from "@/lib/products/options";
import { OptionsEditor } from "./options-editor";
import {
  createProduct,
  updateProduct,
  generateProductDescription,
  generateProductSeo,
  type ProductFormData,
  type VariantFormData,
} from "@/app/actions/product-actions";
import type {
  Product,
  CategoryOption,
  CardColorOption,
  TaxClassOption,
} from "./page";

type Props = {
  product: Product | null;
  categories: CategoryOption[];
  colors: CardColorOption[];
  taxClasses: TaxClassOption[];
  onClose: () => void;
  onSaved: () => void;
  // Store default for NEW simple products (inventory.simpleTrackDefault). Only
  // seeds the initial checkbox when creating; ignored when editing an existing
  // product (its own value wins).
  defaultTrackInventory?: boolean;
  canUseGrossMargin?: boolean;
  // When the parent renders the Save/Cancel controls itself (the full-page
  // editor puts them in a sticky header), it hides the form's own action bar
  // and drives saving through the imperative ref below.
  hideActions?: boolean;
  // Lets the parent mirror the in-flight state on its own Save button.
  onPendingChange?: (pending: boolean) => void;
};

// Imperative handle so a parent-rendered Save button can trigger the form's
// validated save (used by the full-page editor's sticky header).
export interface ProductEditorFormHandle {
  submit: () => void;
}

const EMPTY: ProductFormData = {
  name: "",
  slug: "",
  description: "",
  category_id: null,
  base_price: 0,
  selling_price: 0,
  cost_price: null,
  image_url: "",
  images: [],
  status: "draft",
  featured: false,
  sort_order: 0,
  card_color: "",
  seo_title: "",
  seo_description: "",
  variants: [],
  track_inventory: false,
  allow_backorder: false,
  low_stock_threshold: null,
  sku: "",
  barcode: "",
  tax_class_id: null,
  hsn_code: null,
  returnable: true,
  return_window_days: null,
  requires_shipping: true,
  weight_grams: null,
  length_cm: null,
  width_cm: null,
  height_cm: null,
};

function toForm(product: Product): ProductFormData {
  return {
    name: product.name,
    slug: product.slug,
    description: product.description ?? "",
    category_id: product.category_id,
    base_price: product.base_price,
    selling_price: product.selling_price,
    cost_price: product.cost_price,
    image_url: product.image_url ?? "",
    images: product.images ?? [],
    status: product.status,
    featured: product.featured,
    sort_order: product.sort_order,
    card_color: product.card_color ?? "",
    options: storedOptions(product.options),
    seo_title: product.seo_title ?? "",
    seo_description: product.seo_description ?? "",
    track_inventory: product.track_inventory,
    allow_backorder: product.allow_backorder,
    low_stock_threshold: product.low_stock_threshold,
    sku: product.sku ?? "",
    barcode: product.barcode ?? "",
    tax_class_id: product.tax_class_id,
    hsn_code: product.hsn_code,
    returnable: product.returnable !== false,
    return_window_days: product.return_window_days,
    requires_shipping: product.requires_shipping !== false,
    weight_grams: product.weight_grams,
    length_cm: product.length_cm,
    width_cm: product.width_cm,
    height_cm: product.height_cm,
    variants: (product.variants ?? []).map((v) => ({
      id: v.id, // preserve DB id for reconcile (stable variant ids)
      name: v.name,
      base_price: v.base_price,
      selling_price: v.selling_price,
      cost_price: v.cost_price,
      special_price: v.special_price ?? null,
      stock: v.stock,
      sku: v.sku ?? "",
      barcode: v.barcode ?? "",
      requires_shipping: v.requires_shipping,
      weight_grams: v.weight_grams,
      length_cm: v.length_cm,
      width_cm: v.width_cm,
      height_cm: v.height_cm,
      images: v.images ?? (v.image_url ? [v.image_url] : []),
      option_values: v.option_values ?? [],
    })),
  };
}

/** A new variant row, priced like the product until the merchant changes it
 *  — a generated matrix of ₹0 rows would read as free on the storefront. */
function blankVariant(f: ProductFormData): VariantFormData {
  return {
    name: "",
    base_price: f.base_price,
    selling_price: f.selling_price,
    cost_price: null,
    special_price: null,
    stock: 0,
    sku: "",
    barcode: "",
    requires_shipping: null,
    weight_grams: null,
    length_cm: null,
    width_cm: null,
    height_cm: null,
    images: [],
  };
}

/** Stored options, read through the same normaliser the save uses. A value
 *  the rules refuse opens as "no options" rather than breaking the editor. */
function storedOptions(raw: unknown): ProductOption[] {
  const out = normalizeOptions(raw);
  return "options" in out ? out.options : [];
}

const fieldClass =
  "w-full rounded-lg border border-[#d1d5db] bg-white px-3 py-2 text-sm text-[#1f2937] outline-none transition placeholder:text-[#9ca3af] focus:border-[#4f46e5] focus:ring-2 focus:ring-[#4f46e5]/15";
const labelClass = "mb-1.5 block text-[13px] font-medium text-[#374151]";
const hintClass = "mt-1 text-[11px] leading-relaxed text-[#9ca3af]";
const aiButtonClass =
  "flex shrink-0 items-center gap-1 rounded-md border border-indigo-200 bg-gradient-to-r from-indigo-50 to-violet-50 px-2.5 py-1 text-xs font-medium text-[#4f46e5] hover:from-indigo-100 hover:to-violet-100 disabled:cursor-not-allowed disabled:opacity-50";

// Per-section colour themes — a tinted card + a matching icon badge give each
// group its own identity so the editor reads as a colourful, scannable page
// rather than a wall of white. Kept subtle (light washes) so field text and the
// white inputs stay crisp on top.
type Tint =
  | "indigo"
  | "violet"
  | "emerald"
  | "amber"
  | "sky"
  | "slate"
  | "teal";
const TINTS: Record<Tint, { card: string; badge: string }> = {
  indigo: {
    card: "border-indigo-100 bg-indigo-50/40",
    badge: "bg-indigo-100 text-indigo-600",
  },
  violet: {
    card: "border-violet-100 bg-violet-50/40",
    badge: "bg-violet-100 text-violet-600",
  },
  emerald: {
    card: "border-emerald-100 bg-emerald-50/40",
    badge: "bg-emerald-100 text-emerald-600",
  },
  amber: {
    card: "border-amber-100 bg-amber-50/40",
    badge: "bg-amber-100 text-amber-600",
  },
  sky: {
    card: "border-sky-100 bg-sky-50/40",
    badge: "bg-sky-100 text-sky-600",
  },
  slate: {
    card: "border-slate-200 bg-slate-50",
    badge: "bg-slate-200 text-slate-600",
  },
  teal: {
    card: "border-teal-100 bg-teal-50/40",
    badge: "bg-teal-100 text-teal-600",
  },
};

// The editor is split into tabs so a merchant sees one focused group of
// settings at a time instead of one long scroll. Each field-Section below lives
// under exactly one tab; `validationTab` (in handleSave) maps a save error back
// to the tab that owns the offending field so we can jump there.
type TabId =
  | "basics"
  | "media"
  | "pricing"
  | "inventory"
  | "variants"
  | "visibility"
  | "seo";
const TABS: { id: TabId; label: string; icon: LucideIcon }[] = [
  { id: "basics", label: "Basics", icon: Package },
  { id: "media", label: "Media", icon: ImageIcon },
  { id: "pricing", label: "Pricing", icon: Tag },
  { id: "inventory", label: "Inventory", icon: Boxes },
  { id: "variants", label: "Variants", icon: Layers },
  { id: "visibility", label: "Visibility", icon: Eye },
  { id: "seo", label: "SEO", icon: Search },
];

// A titled, described, colour-tinted panel — the building block of the editor.
function Section({
  title,
  description,
  icon: Icon,
  tint,
  aside,
  children,
}: {
  title: string;
  description?: string;
  icon: LucideIcon;
  tint: Tint;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = TINTS[tint];
  return (
    <section className={`rounded-xl border ${t.card} p-4 shadow-sm sm:p-5`}>
      <div className="mb-4 flex items-start gap-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${t.badge}`}
          aria-hidden
        >
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-[#111827]">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-[#6b7280]">
              {description}
            </p>
          ) : null}
        </div>
        {aside ? <div className="shrink-0">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

// Per-variant gallery: a strip of 44px thumbnails plus an "add" tile.
function VariantGallery({
  images,
  onChange,
}: {
  images: string[];
  onChange: (imgs: string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const uploaded: string[] = [];
      for (const file of Array.from(files)) {
        uploaded.push(await uploadImage(file, { folder: "product-images" }));
      }
      onChange([...images, ...uploaded]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {images.map((url) => (
        <div
          key={url}
          className="relative h-11 w-11 overflow-hidden rounded-md border border-[#e5e7eb]"
        >
          <Image src={url} alt="" fill className="object-cover" />
          <button
            type="button"
            onClick={() => onChange(images.filter((u) => u !== url))}
            title="Remove image"
            className="absolute right-0 top-0 z-10 rounded-bl bg-black/70 p-0.5 text-white hover:bg-red-500"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      <input
        type="file"
        multiple
        ref={inputRef}
        accept="image/png, image/jpeg, image/webp"
        onChange={handleFiles}
        className="hidden"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        title="Add image(s) for this variant"
        className="flex h-11 w-11 items-center justify-center rounded-md border border-dashed border-[#d1d5db] bg-[#f9fafb] text-[#9ca3af] hover:border-[#4f46e5] hover:text-[#4f46e5]"
      >
        {uploading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <ImageIcon className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

/**
 * The product editor form body — driven by the full-page editor panel
 * (product-edit-panel.tsx) for both creating and editing a product. Mounts
 * fresh each time it's shown, so form state is initialised lazily from
 * `product` (no open/reset effect needed).
 */
export const ProductEditorForm = forwardRef<ProductEditorFormHandle, Props>(
  function ProductEditorForm(
    {
      product,
      categories,
      colors,
      taxClasses,
      onClose,
      onSaved,
      defaultTrackInventory = false,
      canUseGrossMargin = false,
      hideActions = false,
      onPendingChange,
    }: Props,
    ref,
  ) {
    const [form, setForm] = useState<ProductFormData>(() =>
      product
        ? toForm(product)
        : { ...EMPTY, track_inventory: defaultTrackInventory },
    );
    const [isPending, startTransition] = useTransition();
    const [isGenerating, setIsGenerating] = useState(false);
    const [isGeneratingSeo, setIsGeneratingSeo] = useState(false);
    // Once the user edits the slug by hand we stop auto-deriving it from the name.
    const [slugTouched, setSlugTouched] = useState(!!product);
    // Active editor tab + the tab a failed save jumped to (marked with a dot).
    const [tab, setTab] = useState<TabId>("basics");
    const [errorTab, setErrorTab] = useState<TabId | null>(null);
    const descriptionRef = useRef<HTMLTextAreaElement>(null);
    const isEditing = !!product;

    // Grow the description textarea to fit its content.
    const autosize = (el: HTMLTextAreaElement | null) => {
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    const setDescriptionRef = (el: HTMLTextAreaElement | null) => {
      descriptionRef.current = el;
      if (el) requestAnimationFrame(() => autosize(el));
    };
    useEffect(() => {
      requestAnimationFrame(() => autosize(descriptionRef.current));
    }, [form.description]);

    const set = <K extends keyof ProductFormData>(
      key: K,
      value: ProductFormData[K],
    ) => setForm((f) => ({ ...f, [key]: value }));

    // Typing the name fills the slug live until the user overrides it.
    const handleNameChange = (value: string) =>
      setForm((f) => ({
        ...f,
        name: value,
        slug: slugTouched ? f.slug : slugify(value),
      }));

    const handleSlugChange = (value: string) => {
      setSlugTouched(value.trim() !== "");
      set("slug", value);
    };

    // ── Gallery helpers ────────────────────────────────────────
    const addGalleryImage = (url: string) => {
      if (!url) return;
      setForm((f) =>
        f.images.includes(url) ? f : { ...f, images: [...f.images, url] },
      );
    };
    const removeGalleryImage = (url: string) =>
      setForm((f) => ({ ...f, images: f.images.filter((u) => u !== url) }));

    // ── Variant helpers ────────────────────────────────────────
    const addVariant = () =>
      setForm((f) => ({ ...f, variants: [...f.variants, blankVariant(f)] }));
    // Options are stored as typed (so a half-finished option stays on screen)
    // and the variant rows are regenerated whenever they are valid. Rows are
    // matched by combination, so an edit never loses an existing row's id,
    // prices or stock — only a combination the merchant removed goes.
    const setOptions = (next: ProductOption[]) =>
      setForm((f) => {
        const valid = normalizeOptions(next);
        if (!("options" in valid)) return { ...f, options: next };
        if (valid.options.length === 0)
          return {
            ...f,
            options: next,
            variants: f.variants.map((v) => ({ ...v, option_values: [] })),
          };
        return {
          ...f,
          options: next,
          variants: generateVariantRows(valid.options, f.variants, () =>
            blankVariant(f),
          ),
        };
      });
    const hasOptions = (form.options ?? []).length > 0;
    const updateVariant = <K extends keyof VariantFormData>(
      index: number,
      key: K,
      value: VariantFormData[K],
    ) =>
      setForm((f) => ({
        ...f,
        variants: f.variants.map((v, i) =>
          i === index ? { ...v, [key]: value } : v,
        ),
      }));
    const removeVariant = (index: number) =>
      setForm((f) => ({
        ...f,
        variants: f.variants.filter((_, i) => i !== index),
      }));
    // Move a variant up/down. Row order = sort_order on save, and the storefront
    // selects the first (top) variant by default — so this also sets the default.
    const moveVariant = (index: number, dir: -1 | 1) =>
      setForm((f) => {
        const target = index + dir;
        if (target < 0 || target >= f.variants.length) return f;
        const variants = [...f.variants];
        [variants[index], variants[target]] = [
          variants[target],
          variants[index],
        ];
        return { ...f, variants };
      });

    // The store's brand soul + the current form fields → Gemini → description.
    const handleGenerate = async () => {
      if (!form.name.trim()) {
        toast.error("Add a product name first");
        return;
      }
      setIsGenerating(true);
      const categoryName =
        categories.find((c) => c.id === form.category_id)?.name ?? null;
      const result = await generateProductDescription({
        name: form.name,
        categoryName,
        base_price: form.base_price,
        selling_price: form.selling_price,
        variants: form.variants.map((v) => v.name).filter((n) => n.trim()),
        notes: form.description.trim() || undefined,
      });
      setIsGenerating(false);
      if (result.error) {
        toast.error(result.error);
      } else if (result.description) {
        set("description", result.description);
        toast.success("Description generated");
      }
    };

    // Same pipeline, SEO flavour: fills both SEO fields at once.
    const handleGenerateSeo = async () => {
      if (!form.name.trim()) {
        toast.error("Add a product name first");
        return;
      }
      if (!form.description.trim()) {
        toast.error("Fill in the product description before generating SEO");
        return;
      }
      setIsGeneratingSeo(true);
      const categoryName =
        categories.find((c) => c.id === form.category_id)?.name ?? null;
      const result = await generateProductSeo({
        name: form.name,
        categoryName,
        base_price: form.base_price,
        selling_price: form.selling_price,
        variants: form.variants.map((v) => v.name).filter((n) => n.trim()),
        description: form.description.trim() || undefined,
      });
      setIsGeneratingSeo(false);
      if (result.error) {
        toast.error(result.error);
      } else if (result.seo_title && result.seo_description) {
        set("seo_title", result.seo_title);
        set("seo_description", result.seo_description);
        toast.success("SEO fields generated");
      }
    };

    const handleSave = () => {
      // Jump to the tab that owns a failed field, flag it with a dot, and toast
      // — so a required field on a hidden tab never errors with no visible cause.
      const fail = (target: TabId, message: string) => {
        setErrorTab(target);
        setTab(target);
        toast.error(message);
      };
      setErrorTab(null);
      if (!form.name.trim()) return fail("basics", "Name is required");
      if (!form.category_id) return fail("basics", "Category is required");
      if (!form.description.trim())
        return fail("basics", "Description is required");
      if (!form.seo_title.trim() || !form.seo_description.trim())
        return fail("seo", "SEO title and description are required");
      const badVariant = form.variants.find((v) => !v.name.trim());
      if (badVariant)
        return fail(
          "variants",
          "Each variant needs a name (or remove the empty row)",
        );
      if (form.selling_price > 0 && form.selling_price > form.base_price)
        return fail(
          "pricing",
          "Selling price can't be higher than the base price",
        );
      const badPrice = form.variants.find(
        (v) => v.selling_price > 0 && v.selling_price > v.base_price,
      );
      if (badPrice)
        return fail(
          "variants",
          `Variant "${badPrice.name}" has a selling price above its base price`,
        );
      const badSpecial = form.variants.find(
        (v) =>
          v.special_price != null &&
          v.special_price > 0 &&
          v.base_price > 0 &&
          v.special_price > v.base_price,
      );
      if (badSpecial)
        return fail(
          "variants",
          `Variant "${badSpecial.name}" has a sale price above its base price`,
        );
      startTransition(async () => {
        const result = isEditing
          ? await updateProduct(product!.id, form)
          : await createProduct(form);
        if (result.error) {
          toast.error(result.error);
        } else {
          toast.success(isEditing ? "Product updated" : "Product created");
          onSaved();
        }
      });
    };

    const selectedCategory = categories.find((c) => c.id === form.category_id);
    const discountPct =
      form.base_price > 0 &&
      form.selling_price > 0 &&
      form.selling_price < form.base_price
        ? Math.round(
            ((form.base_price - form.selling_price) / form.base_price) * 100,
          )
        : 0;
    const totalStock = product
      ? form.variants.length > 0
        ? form.variants.reduce((sum, variant) => sum + variant.stock, 0)
        : product.stock
      : null;

    // Expose the validated save to a parent-rendered Save button (sticky header
    // on the full page) and keep that button's spinner in sync. Route through a
    // ref to the latest handleSave so the handle itself stays stable (handleSave
    // is re-created each render as it closes over the live form state).
    const saveRef = useRef(handleSave);
    useEffect(() => {
      saveRef.current = handleSave;
    });
    useImperativeHandle(ref, () => ({ submit: () => saveRef.current() }), []);
    useEffect(() => {
      onPendingChange?.(isPending);
    }, [isPending, onPendingChange]);

    return (
      <>
        {/* The form's own action bar — shown only when the parent DOESN'T render
          its own controls (i.e. in the modal). The full-page editor sets
          hideActions and puts Save/Cancel in its sticky header instead. */}
        {!hideActions && (
          <div className="dash-editor-actionbar sticky top-0 z-20 -mt-2 mb-3 flex items-center justify-between gap-2 border-b border-[#e5e7eb] bg-white py-3">
            <span className="hidden text-xs text-[#9ca3af] sm:inline">
              {selectedCategory
                ? `In ${selectedCategory.name}`
                : "Pick a category to publish"}
            </span>
            <div className="ml-auto flex gap-2">
              <Button variant="outline" onClick={onClose} disabled={isPending}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={isPending}>
                {isPending
                  ? "Saving…"
                  : isEditing
                    ? "Save changes"
                    : "Create product"}
              </Button>
            </div>
          </div>
        )}

        {/* Tab bar — one focused group of settings at a time, so the editor
          never reads as one long wall of fields. A failed save flags the tab
          that owns the offending field with a red dot (errorTab). */}
        <div className="mb-5 flex justify-center gap-1 overflow-x-auto border-b border-[#e5e7eb]">
          {TABS.map((t) => {
            const active = tab === t.id;
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`relative flex shrink-0 items-center gap-1.5 border-b-2 px-3.5 py-2.5 text-sm font-medium transition ${
                  active
                    ? "border-[#4f46e5] text-[#4f46e5]"
                    : "border-transparent text-[#6b7280] hover:text-[#111827]"
                }`}
              >
                <Icon className="h-4 w-4" />
                {t.label}
                {errorTab === t.id && (
                  <span
                    aria-hidden
                    className="absolute right-1 top-1.5 h-1.5 w-1.5 rounded-full bg-red-500"
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Each panel below is kept mounted and toggled with `hidden` (not
          unmounted) so in-progress uploads and the autosized description survive
          tab switches. Single column, capped for comfortable reading. */}
        <div className="mx-auto max-w-3xl py-2">
          <div className={tab === "basics" ? "space-y-4" : "hidden"}>
            {/* Product details */}
            <Section
              title="Product details"
              description="The name, description, and storefront link your customers see."
              icon={Package}
              tint="indigo"
            >
              <div className="space-y-4">
                <div>
                  <label className={labelClass}>Name *</label>
                  <input
                    className={fieldClass}
                    value={form.name}
                    onChange={(e) => handleNameChange(e.target.value)}
                    placeholder="e.g. Almond Milk 500ml"
                  />
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className={labelClass}>URL handle (slug)</label>
                    <input
                      className={fieldClass}
                      value={form.slug}
                      onChange={(e) => handleSlugChange(e.target.value)}
                      placeholder="auto from name"
                    />
                    <p className={hintClass}>
                      Lives at{" "}
                      <span className="font-mono">
                        /shop/{form.slug || "…"}
                      </span>
                    </p>
                  </div>
                  <div>
                    <label className={labelClass}>Category *</label>
                    <select
                      className={fieldClass}
                      value={form.category_id ?? ""}
                      onChange={(e) =>
                        set("category_id", e.target.value || null)
                      }
                    >
                      <option value="">Select a category…</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.status === "hidden" ? " (hidden)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className={labelClass}>Tax class</label>
                  <select
                    className={fieldClass}
                    value={form.tax_class_id ?? ""}
                    onChange={(e) =>
                      set("tax_class_id", e.target.value || null)
                    }
                  >
                    <option value="">Use store default</option>
                    {taxClasses.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.rate}%)
                      </option>
                    ))}
                  </select>
                  <p className={hintClass}>
                    Products without a tax class use the store default. Applies
                    at checkout when tax is enabled (Invoices &amp; Billing).
                  </p>
                </div>

                {/* Returns. Per-product because a setting can't address one
                    SKU — perishables, personalised items and clearance are
                    final sale while the rest of the catalogue isn't. */}
                <div>
                  <label className={labelClass}>Returns</label>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={form.returnable === false}
                      onChange={(e) => {
                        const finalSale = e.target.checked;
                        set("returnable", !finalSale);
                        // A window on something that can never come back is
                        // dead config that will confuse whoever reads it next.
                        if (finalSale) set("return_window_days", null);
                      }}
                    />
                    <span>
                      Final sale — this product can&apos;t be returned
                    </span>
                  </label>
                  {form.returnable !== false && (
                    <div className="mt-2">
                      <input
                        type="number"
                        min={0}
                        max={365}
                        className={fieldClass}
                        placeholder="Use store default"
                        value={form.return_window_days ?? ""}
                        onChange={(e) =>
                          set(
                            "return_window_days",
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                          )
                        }
                      />
                      <p className={hintClass}>
                        Days after delivery this product can be returned. Leave
                        blank to follow the store&apos;s window (Orders →
                        Settings). 0 means same day only.
                      </p>
                    </div>
                  )}
                </div>

                <div>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <label className={`${labelClass} mb-0`}>
                      Description *
                    </label>
                    <button
                      type="button"
                      onClick={handleGenerate}
                      disabled={isGenerating || isPending}
                      title="Generate from your brand guide with AI"
                      className={aiButtonClass}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      {isGenerating ? "Generating…" : "Generate with AI"}
                    </button>
                  </div>
                  <textarea
                    ref={setDescriptionRef}
                    className={`${fieldClass} min-h-[96px] resize-none overflow-hidden`}
                    value={form.description}
                    onChange={(e) => {
                      set("description", e.target.value);
                      autosize(e.target);
                    }}
                    placeholder="Describe the product… or type rough notes and click Generate with AI"
                  />
                  <p className={hintClass}>
                    Written in your brand voice. Shown on the product page.
                  </p>
                </div>
              </div>
            </Section>
          </div>

          <div className={tab === "media" ? "space-y-4" : "hidden"}>
            {/* Media */}
            <Section
              title="Media"
              description="Add photos so customers can see what they are buying. The primary image is the storefront thumbnail."
              icon={ImageIcon}
              tint="violet"
            >
              <div className="space-y-4">
                <div>
                  <label className={labelClass}>Primary image</label>
                  <ImageUpload
                    folder="product-images"
                    defaultImage={form.image_url || undefined}
                    onUploadSuccess={(url) => set("image_url", url)}
                  />
                </div>

                <div>
                  <label className={labelClass}>Gallery (extra images)</label>
                  {form.images.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {form.images.map((url) => (
                        <div
                          key={url}
                          className="relative h-16 w-16 overflow-hidden rounded-md border border-[#e5e7eb]"
                        >
                          <Image
                            src={url}
                            alt="Gallery image"
                            fill
                            className="object-cover"
                          />
                          <button
                            type="button"
                            onClick={() => removeGalleryImage(url)}
                            className="absolute right-0.5 top-0.5 rounded bg-black/70 p-0.5 text-white hover:bg-red-500"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <ImageUpload
                    folder="product-images"
                    onUploadSuccess={addGalleryImage}
                  />
                </div>
              </div>
            </Section>
          </div>

          <div className={tab === "pricing" ? "space-y-4" : "hidden"}>
            {/* Pricing */}
            <Section
              title="Pricing"
              description="Set the list price (MRP) and what customers actually pay."
              icon={Tag}
              tint="emerald"
            >
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label className={labelClass}>Base price ₹ (MRP)</label>
                  <NumberField
                    className={fieldClass}
                    value={form.base_price}
                    onValueChange={(n) => set("base_price", n)}
                  />
                </div>
                {canUseGrossMargin ? (
                  <div>
                    <label className={labelClass}>Cost per unit ₹</label>
                    <NumberField
                      className={fieldClass}
                      value={form.cost_price ?? 0}
                      onValueChange={(n, raw) =>
                        set("cost_price", raw === "" ? null : n)
                      }
                    />
                    <p className={hintClass}>
                      What this item costs you. The first value safely fills
                      older sales with no cost; later edits affect new sales.
                    </p>
                  </div>
                ) : null}
                <div>
                  <label className={labelClass}>Selling price ₹</label>
                  <NumberField
                    className={fieldClass}
                    value={form.selling_price}
                    onValueChange={(n) => set("selling_price", n)}
                  />
                  <p className={hintClass}>
                    Leave 0 to sell at base price. Must be ≤ base price.
                    {discountPct > 0 ? (
                      <span className="ml-1 font-medium text-[#15a34a]">
                        {discountPct}% off
                      </span>
                    ) : null}
                  </p>
                </div>
              </div>
            </Section>

            <Section
              title="Shipping"
              description="Physical measurements used for courier serviceability and labels. Final packed dimensions can still be corrected when booking."
              icon={Truck}
              tint="teal"
            >
              <div className="space-y-4">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-[#1f2937]">
                  <input
                    type="checkbox"
                    checked={form.requires_shipping !== false}
                    onChange={(e) => set("requires_shipping", e.target.checked)}
                    className="h-4 w-4 accent-[#4f46e5]"
                  />
                  This is a physical product that requires shipping
                </label>
                {form.requires_shipping !== false && (
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                    <div>
                      <label className={labelClass}>Weight (g)</label>
                      <NumberField
                        className={fieldClass}
                        value={form.weight_grams ?? 0}
                        onValueChange={(n) =>
                          set("weight_grams", n > 0 ? n : null)
                        }
                        allowDecimal={false}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>Length (cm)</label>
                      <NumberField
                        className={fieldClass}
                        value={form.length_cm ?? 0}
                        onValueChange={(n) =>
                          set("length_cm", n > 0 ? n : null)
                        }
                      />
                    </div>
                    <div>
                      <label className={labelClass}>Width (cm)</label>
                      <NumberField
                        className={fieldClass}
                        value={form.width_cm ?? 0}
                        onValueChange={(n) => set("width_cm", n > 0 ? n : null)}
                      />
                    </div>
                    <div>
                      <label className={labelClass}>Height (cm)</label>
                      <NumberField
                        className={fieldClass}
                        value={form.height_cm ?? 0}
                        onValueChange={(n) =>
                          set("height_cm", n > 0 ? n : null)
                        }
                      />
                    </div>
                    <div className="col-span-2 sm:col-span-1">
                      <label className={labelClass}>HSN</label>
                      <input
                        className={fieldClass}
                        value={form.hsn_code ?? ""}
                        onChange={(event) =>
                          set("hsn_code", event.target.value || null)
                        }
                        inputMode="numeric"
                        maxLength={20}
                        placeholder="e.g. 2202"
                      />
                    </div>
                  </div>
                )}
                <p className={hintClass}>
                  Shiprocket requires a positive packed weight and dimensions.
                  Variants inherit these values unless an import supplies an
                  override.
                </p>
              </div>
            </Section>
          </div>

          <div className={tab === "inventory" ? "space-y-4" : "hidden"}>
            <Section
              title="Inventory"
              description="Choose whether to track this item here, then manage physical quantities by location."
              icon={Boxes}
              tint="amber"
            >
              <div className="space-y-5">
                <div className="rounded-xl border border-amber-200 bg-white p-4">
                  {product ? (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="text-xs font-semibold uppercase tracking-wide text-[#92400e]">
                          Total across all locations
                        </div>
                        <div className="mt-1 text-2xl font-semibold text-[#111827]">
                          {totalStock} units
                        </div>
                        <p className="mt-1 text-xs text-[#6b7280]">
                          Open Inventory to see and change each location&apos;s
                          shelf separately.
                        </p>
                      </div>
                      <Link
                        href={`/dashboard/inventory?q=${encodeURIComponent(product.name)}`}
                        className="inline-flex shrink-0 items-center justify-center rounded-lg bg-[#111827] px-3.5 py-2 text-sm font-medium text-white hover:opacity-90"
                      >
                        Manage stock by location
                      </Link>
                    </div>
                  ) : (
                    <div>
                      <div className="font-semibold text-[#111827]">
                        Create the product before stocking a location
                      </div>
                      <p className="mt-1 text-xs text-[#6b7280]">
                        Save this product, then Inventory will let you add the
                        counted quantity to the right shop or warehouse.
                      </p>
                    </div>
                  )}
                </div>

                {form.variants.length === 0 ? (
                  <>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <label className={labelClass}>SKU</label>
                        <input
                          className={`${fieldClass} cursor-not-allowed bg-[#f3f4f6] font-mono text-[#6b7280]`}
                          value={form.sku || "Auto-generated on save"}
                          readOnly
                          title="SKUs are generated automatically and cannot be edited"
                        />
                        <p className={hintClass}>
                          Auto-generated &amp; locked.
                        </p>
                      </div>
                      <div>
                        <label className={labelClass}>Barcode</label>
                        <input
                          className={`${fieldClass} font-mono`}
                          value={form.barcode ?? ""}
                          placeholder="Scan or type the barcode"
                          onChange={(e) => set("barcode", e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.preventDefault();
                          }}
                        />
                        <p className={hintClass}>
                          The supplier barcode on the packaging — what the
                          register scans.
                        </p>
                      </div>
                    </div>

                    <label className="flex cursor-pointer items-center gap-2 text-sm text-[#1f2937]">
                      <input
                        type="checkbox"
                        checked={form.track_inventory}
                        onChange={(e) =>
                          set("track_inventory", e.target.checked)
                        }
                        className="h-4 w-4 accent-[#4f46e5]"
                      />
                      Track quantity for this product
                    </label>

                    {form.track_inventory && (
                      <div className="ml-6 space-y-3 border-l-2 border-[#e0e7ff] pl-4">
                        <label className="flex cursor-pointer items-center gap-2 text-sm text-[#1f2937]">
                          <input
                            type="checkbox"
                            checked={form.allow_backorder}
                            onChange={(e) =>
                              set("allow_backorder", e.target.checked)
                            }
                            className="h-4 w-4 accent-[#4f46e5]"
                          />
                          Continue selling when out of stock (backorder)
                        </label>
                        <div>
                          <label className={labelClass}>
                            Low stock alert threshold
                          </label>
                          <NumberField
                            className={`${fieldClass} max-w-[120px]`}
                            value={form.low_stock_threshold ?? 0}
                            onValueChange={(n) =>
                              set("low_stock_threshold", n > 0 ? n : null)
                            }
                          />
                          <p className={hintClass}>
                            Warn when stock drops to this level. Leave 0 to use
                            the store default.
                          </p>
                        </div>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="rounded-lg border border-dashed border-amber-200 bg-amber-50/50 px-4 py-3 text-sm text-[#78350f]">
                    Each variant is a separate stock item. Add names, prices,
                    barcodes, and opening stock under <strong>Variants</strong>;
                    after saving, change quantities in Inventory at the correct
                    location.
                  </div>
                )}
              </div>
            </Section>
          </div>

          <div className={tab === "variants" ? "space-y-4" : "hidden"}>
            {/* Options */}
            <Section
              title="Options"
              description="Name the choices a shopper makes, like Size and Colour. Every combination becomes a variant below, and the storefront shows one picker per option."
              icon={Layers}
              tint="sky"
            >
              <OptionsEditor
                options={form.options ?? []}
                onChange={setOptions}
                legacyNames={form.variants.map((v) => v.name)}
              />
            </Section>

            {/* Variants */}
            <Section
              title="Variants"
              description={
                hasOptions
                  ? "One row per combination of your options — each with its own price, stock, and auto-generated SKU."
                  : "Options like size or flavour — each with its own price, stock, and auto-generated SKU. Leave empty for a single-price product."
              }
              icon={Layers}
              tint="sky"
              aside={
                hasOptions ? undefined : (
                  <button
                    type="button"
                    onClick={addVariant}
                    className="flex items-center gap-1 rounded-md border border-[#d1d5db] bg-white px-2.5 py-1 text-xs font-medium text-[#374151] hover:bg-[#f3f4f6]"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add variant
                  </button>
                )
              }
            >
              {form.variants.length === 0 ? (
                <p className="rounded-lg border border-dashed border-[#d1d5db] bg-[#f9fafb] px-4 py-6 text-center text-xs text-[#9ca3af]">
                  No variants yet. This is a single-price product — add variants
                  only if it comes in multiple options.
                </p>
              ) : (
                <div className="overflow-x-auto sm:overflow-visible">
                  {product && (
                    <div className="mb-3 flex flex-col gap-2 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2.5 text-xs text-indigo-900 sm:flex-row sm:items-center sm:justify-between">
                      <span>
                        Existing stock is shown as a store-wide total here and
                        cannot be edited in the product form.
                      </span>
                      <Link
                        href={`/dashboard/inventory?q=${encodeURIComponent(product.name)}`}
                        className="shrink-0 font-semibold text-[#4f46e5] hover:underline"
                      >
                        Manage by location →
                      </Link>
                    </div>
                  )}
                  <div className="min-w-[500px] space-y-2 sm:min-w-0">
                    <div className="grid grid-cols-[1fr_72px_72px_60px_110px_120px_72px] gap-2 px-1 text-[10px] uppercase tracking-wide text-[#9ca3af]">
                      <span>Name</span>
                      <span>Base ₹</span>
                      <span>Sell ₹</span>
                      <span>Stock</span>
                      <span>SKU</span>
                      <span>Barcode</span>
                      <span />
                    </div>
                    {form.variants.map((v, i) => (
                      <div
                        key={i}
                        className="space-y-2 rounded-lg border border-[#f3f4f6] bg-[#fafafa] p-2"
                      >
                        <div className="grid grid-cols-[1fr_72px_72px_60px_110px_120px_72px] items-center gap-2">
                          {hasOptions ? (
                            <div
                              className={`${fieldClass} truncate bg-[#f3f4f6] font-medium`}
                              title="Named from its option values"
                            >
                              {v.name}
                            </div>
                          ) : (
                            <input
                              className={fieldClass}
                              value={v.name}
                              onChange={(e) =>
                                updateVariant(i, "name", e.target.value)
                              }
                              placeholder="500ml"
                            />
                          )}
                          <NumberField
                            className={fieldClass}
                            value={v.base_price}
                            onValueChange={(n) =>
                              updateVariant(i, "base_price", n)
                            }
                          />
                          <NumberField
                            className={fieldClass}
                            value={v.selling_price}
                            onValueChange={(n) =>
                              updateVariant(i, "selling_price", n)
                            }
                          />
                          {v.id ? (
                            <div
                              className={`${fieldClass} cursor-not-allowed bg-[#f3f4f6] text-center font-mono text-[#6b7280]`}
                              title="Store-wide total. Manage stock by location in Inventory."
                            >
                              {v.stock}
                            </div>
                          ) : (
                            <NumberField
                              className={fieldClass}
                              value={v.stock}
                              onValueChange={(n) =>
                                updateVariant(i, "stock", n)
                              }
                              allowDecimal={false}
                              aria-label={`Opening stock for ${v.name || `variant ${i + 1}`}`}
                            />
                          )}
                          <input
                            className={`${fieldClass} cursor-not-allowed bg-[#f3f4f6] font-mono text-[11px] text-[#6b7280]`}
                            value={v.sku || "on save"}
                            readOnly
                            title="Auto-generated on save"
                          />
                          {/* Each variant carries its OWN supplier barcode —
                              500ml and 1L are different codes on the shelf.
                              Focus and scan to fill it. */}
                          <input
                            className={`${fieldClass} font-mono text-[11px]`}
                            value={v.barcode ?? ""}
                            placeholder="Scan"
                            title="Supplier barcode — scan the item to fill"
                            onChange={(e) =>
                              updateVariant(i, "barcode", e.target.value)
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") e.preventDefault();
                            }}
                          />
                          <div className="flex items-center justify-end gap-0.5">
                            <button
                              type="button"
                              onClick={() => moveVariant(i, -1)}
                              disabled={i === 0}
                              title={i === 0 ? "Default variant" : "Move up"}
                              className="flex h-8 w-6 items-center justify-center rounded-md text-[#6b7280] hover:bg-[#f3f4f6] disabled:cursor-not-allowed disabled:opacity-30"
                            >
                              <ChevronUp className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveVariant(i, 1)}
                              disabled={i === form.variants.length - 1}
                              title="Move down"
                              className="flex h-8 w-6 items-center justify-center rounded-md text-[#6b7280] hover:bg-[#f3f4f6] disabled:cursor-not-allowed disabled:opacity-30"
                            >
                              <ChevronDown className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeVariant(i)}
                              title="Remove variant"
                              className="flex h-8 w-6 items-center justify-center rounded-md text-[#6b7280] hover:bg-[rgba(239,68,68,0.12)] hover:text-[#ef4444]"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="w-10 shrink-0 text-[10px] uppercase tracking-wide text-[#9ca3af]">
                            Imgs
                          </span>
                          <VariantGallery
                            images={v.images}
                            onChange={(imgs) =>
                              updateVariant(i, "images", imgs)
                            }
                          />
                        </div>
                        {canUseGrossMargin ? (
                          <div className="flex items-center gap-2">
                            <span className="w-10 shrink-0 text-[10px] uppercase tracking-wide text-[#9ca3af]">
                              Cost
                            </span>
                            <NumberField
                              className={`${fieldClass} w-24`}
                              value={v.cost_price ?? 0}
                              onValueChange={(n, raw) =>
                                updateVariant(
                                  i,
                                  "cost_price",
                                  raw === "" ? null : n,
                                )
                              }
                            />
                            <span className="text-[11px] text-[#9ca3af]">
                              ₹ — leave blank to inherit the product cost.
                            </span>
                          </div>
                        ) : null}
                        <div className="flex items-center gap-2">
                          <span
                            className="w-10 shrink-0 text-[10px] uppercase tracking-wide text-[#9ca3af]"
                            title="Optional sale price for this variant"
                          >
                            Sale
                          </span>
                          <NumberField
                            className={`${fieldClass} w-24`}
                            value={v.special_price ?? 0}
                            onValueChange={(n) =>
                              updateVariant(
                                i,
                                "special_price",
                                n > 0 ? n : null,
                              )
                            }
                          />
                          <span className="text-[11px] text-[#9ca3af]">
                            ₹ — leave 0 for no sale. Shows a yellow tag on the
                            variant chip when set.
                          </span>
                        </div>
                      </div>
                    ))}
                    <p className={hintClass}>
                      The top variant is selected by default on the product page
                      — use the arrows to reorder. Stock entered for a new
                      variant is opening stock at the main location.
                    </p>
                  </div>
                </div>
              )}
            </Section>
          </div>

          <div className={tab === "visibility" ? "space-y-4" : "hidden"}>
            {/* Organization & visibility */}
            <Section
              title="Organization & visibility"
              description="Publishing state, storefront placement, and card styling."
              icon={Eye}
              tint="slate"
            >
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className={labelClass}>Status</label>
                    <select
                      className={fieldClass}
                      value={form.status}
                      onChange={(e) =>
                        set("status", e.target.value as "draft" | "published")
                      }
                    >
                      <option value="draft">
                        Draft — hidden from storefront
                      </option>
                      <option value="published">Published — live</option>
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>Sort order</label>
                    <NumberField
                      className={fieldClass}
                      value={form.sort_order}
                      onValueChange={(n) => set("sort_order", n)}
                      allowDecimal={false}
                    />
                    <p className={hintClass}>Lower numbers appear first.</p>
                  </div>
                </div>

                <label className="flex cursor-pointer items-center gap-2 text-sm text-[#1f2937]">
                  <input
                    type="checkbox"
                    checked={form.featured}
                    onChange={(e) => set("featured", e.target.checked)}
                    className="h-4 w-4 accent-[#4f46e5]"
                  />
                  Feature this product on the homepage
                </label>

                <div>
                  <label className={labelClass}>Card colour (storefront)</label>
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className="h-9 w-9 shrink-0 rounded-md border border-[#e5e7eb]"
                      style={{ background: form.card_color || "transparent" }}
                    />
                    <select
                      className={`${fieldClass} flex-1`}
                      value={form.card_color}
                      onChange={(e) => set("card_color", e.target.value)}
                    >
                      <option value="">Default (no colour)</option>
                      {colors.map((c) => (
                        <option key={c.id} value={c.hex}>
                          {c.name} — {c.hex}
                        </option>
                      ))}
                      {/* Preserve a custom/legacy hex not in the palette */}
                      {form.card_color &&
                        !colors.some((c) => c.hex === form.card_color) && (
                          <option value={form.card_color}>
                            Custom — {form.card_color}
                          </option>
                        )}
                    </select>
                  </div>
                  <p className={hintClass}>
                    Shades come from{" "}
                    <Link href="/dashboard/colors" className="underline">
                      Colours
                    </Link>
                    . Name &amp; price stay near-black for contrast; blank uses
                    the storefront default.
                  </p>
                </div>
              </div>
            </Section>
          </div>

          <div className={tab === "seo" ? "space-y-4" : "hidden"}>
            {/* Search engine listing (SEO) */}
            <Section
              title="Search engine listing"
              description="Control how this product appears in Google and when shared."
              icon={Search}
              tint="teal"
              aside={
                <button
                  type="button"
                  onClick={handleGenerateSeo}
                  disabled={
                    isGeneratingSeo || isPending || !form.description.trim()
                  }
                  title={
                    form.description.trim()
                      ? "Generate SEO title & description from your brand guide with AI"
                      : "Add a product description first"
                  }
                  className={aiButtonClass}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {isGeneratingSeo ? "Generating…" : "Generate with AI"}
                </button>
              }
            >
              <div className="space-y-4">
                {/* Live Google-style preview */}
                <div className="rounded-lg border border-[#e5e7eb] bg-[#f9fafb] p-3.5">
                  <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-[#9ca3af]">
                    Search preview
                  </p>
                  <div className="truncate text-[15px] leading-snug text-[#1a0dab]">
                    {form.seo_title || form.name || "Product title"}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-[#006621]">
                    yourstore.com › shop › {form.slug || "product"}
                  </div>
                  <div className="mt-1 line-clamp-2 text-[13px] leading-snug text-[#4d5156]">
                    {form.seo_description ||
                      "Your meta description appears here — a compelling summary encourages clicks from search results."}
                  </div>
                </div>

                <div>
                  <label className={labelClass}>SEO title *</label>
                  <input
                    className={fieldClass}
                    value={form.seo_title}
                    onChange={(e) => set("seo_title", e.target.value)}
                    placeholder={form.name || "Product title | Store"}
                  />
                  <p className={hintClass}>
                    {form.seo_title.length}/60 characters ·{" "}
                    {form.description.trim()
                      ? "Tip: lead with the product name."
                      : "Fill in the description above to generate this with AI."}
                  </p>
                </div>
                <div>
                  <label className={labelClass}>SEO description *</label>
                  <textarea
                    className={`${fieldClass} min-h-[64px] resize-y`}
                    value={form.seo_description}
                    onChange={(e) => set("seo_description", e.target.value)}
                    placeholder="One or two calm sentences describing the product."
                  />
                  <p className={hintClass}>
                    {form.seo_description.length}/160 characters
                  </p>
                </div>
              </div>
            </Section>
          </div>
        </div>
      </>
    );
  },
);
