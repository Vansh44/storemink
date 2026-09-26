import Link from "next/link";
import Image from "next/image";
import { ImageIcon } from "lucide-react";
import { effectivePricing, formatPrice, type PricedLike } from "@/lib/pricing";
import { productIsSoldOut, productLowStockLeft } from "@/lib/inventory/status";
import { hoverImageUrl } from "@/lib/products/gallery";
import { QuickAddButton } from "./quick-add-button";

// Card background falls back to this when a product has no card_color set.
// (Per-product colour is the source of truth.)
export const DEFAULT_CARD_BG = "#f4f2ee";

export type ShopCardProduct = Omit<PricedLike, "variants"> & {
  id: string;
  name: string;
  slug: string;
  image_url: string | null;
  /** Rest of the gallery. Only [1] is used here — the hover image. Optional so
   *  a caller that has not been widened to select it simply gets no swap. */
  images?: string[] | null;
  featured?: boolean;
  card_color?: string | null;
  /** Resolved category name; shown as an eyebrow label when present. */
  category?: string | null;
  track_inventory: boolean;
  stock: number;
  low_stock_threshold: number | null;
  allow_backorder: boolean;
  variants?: {
    base_price: number;
    selling_price: number;
    special_price?: number | null;
    sort_order?: number;
    track_inventory: boolean;
    stock: number;
    low_stock_threshold: number | null;
    allow_backorder: boolean;
  }[];
};

// Single source of truth for the storefront product card — used by the shop
// grid and the homepage "featured products" section so styling stays in sync.
// `storeLowStockThreshold` is the store-wide default (inventory.lowStockThreshold)
// resolved per request by the rendering page; a per-SKU threshold overrides it.
export function ShopCard({
  product: p,
  storeLowStockThreshold = 0,
  headingLevel = 3,
  offerBadge,
}: {
  product: ShopCardProduct;
  storeLowStockThreshold?: number;
  /**
   * A line-level offer's saving on THIS product, from `offerBadgeFor`.
   *
   * ★ OPTIONAL, so every existing call site (homepage sections, related
   * carousels, search) keeps working untouched and simply shows no badge —
   * a card that renders a stale or absent offer is worse than one that renders
   * none. Pass it from a page that has already loaded the store's offers.
   */
  offerBadge?: { label: string } | null;
  /** Shop grids sit directly below the page h1; homepage/related carousels
   * sit below a section h2. Keep the shared card's heading hierarchy valid in
   * both contexts. */
  headingLevel?: 2 | 3;
}) {
  const pr = effectivePricing(p);
  const NameHeading = headingLevel === 2 ? "h2" : "h3";

  // The second photograph, cross-faded in on hover. Rendered ONLY when one
  // exists — see the `.sm-card-hoverimg` note in storefront-theme.css for why
  // this is a real conditional render rather than the render-always-and-hide-
  // with-CSS approach QuickAddButton uses.
  const hoverSrc = hoverImageUrl(p.image_url, p.images);

  // Stock status via the shared resolver so cards, the detail page, and the
  // dashboard agree (sold-out wins over low; low uses the effective threshold).
  const variants = p.variants ?? [];
  const isOutOfStock = productIsSoldOut(variants, p);
  const lowStockAmount = isOutOfStock
    ? null
    : productLowStockLeft(variants, p, storeLowStockThreshold);
  const isLowStock = lowStockAmount !== null;

  return (
    <Link
      href={`/shop/${p.slug}`}
      className="shop-card"
      style={
        { "--card-bg": p.card_color || DEFAULT_CARD_BG } as React.CSSProperties
      }
    >
      <div className="shop-card-img">
        {p.image_url ? (
          <>
            <Image
              src={p.image_url}
              alt={p.name}
              fill
              sizes="(max-width: 768px) 50vw, 280px"
              className="shop-card-img-el"
            />
            {hoverSrc && (
              <span className="shop-card-img-hover" aria-hidden>
                <Image
                  src={hoverSrc}
                  alt=""
                  fill
                  sizes="(max-width: 768px) 50vw, 280px"
                  loading="lazy"
                  className="shop-card-img-el"
                />
              </span>
            )}
          </>
        ) : (
          <div className="shop-card-img-placeholder">
            <ImageIcon size={28} strokeWidth={1.5} aria-hidden />
          </div>
        )}
      </div>

      <div className="shop-card-body">
        <div className="shop-card-head flex items-start justify-between">
          <div className="min-w-0">
            {p.category && <span className="shop-card-cat">{p.category}</span>}
            <NameHeading className="shop-card-name">{p.name}</NameHeading>
          </div>
          <div className="shrink-0 ml-2 flex flex-col items-end gap-1">
            {/* ★ STOCK OUTRANKS THE OFFER, always. "20% off" beside "Sold
                Out" invites a shopper to try to buy something they cannot, and
                the offer is the less urgent of the two facts. */}
            {isOutOfStock ? (
              <span className="text-[10px] font-bold uppercase tracking-wider bg-zinc-200 text-zinc-600 px-1.5 py-0.5 rounded-sm">
                Sold Out
              </span>
            ) : isLowStock ? (
              <span className="text-[10px] font-bold uppercase tracking-wider bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-sm">
                Only {lowStockAmount} left!
              </span>
            ) : offerBadge ? (
              <span className="sm-offer-badge">{offerBadge.label}</span>
            ) : null}
          </div>
        </div>
        <div className="shop-card-price">
          {pr.hasVariants && <span className="shop-card-from">from </span>}
          <span className="shop-card-sell">{formatPrice(pr.selling)}</span>
          {pr.discount > 0 && (
            <>
              <span className="shop-card-base">{formatPrice(pr.base)}</span>
              <span className="shop-card-off">{pr.discount}% off</span>
            </>
          )}
          {/* Hidden unless the theme opts into quick-add (.sm-card-quickadd). */}
          <QuickAddButton product={p} />
        </div>
      </div>
    </Link>
  );
}
