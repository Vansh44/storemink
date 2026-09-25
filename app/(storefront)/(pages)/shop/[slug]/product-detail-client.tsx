"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  discountPercent,
  formatPrice,
  hasSpecialPrice,
  variantEffectiveSelling,
} from "@/lib/pricing";
import {
  isSoldOut,
  lowStockLeft,
  maxPurchasable,
} from "@/lib/inventory/status";
import { useCart } from "@/app/(storefront)/components/cart/CartProvider";
import { ShareButtons } from "@/app/(storefront)/components/share-buttons";
import { ProductDeliveryEstimator } from "@/app/(storefront)/components/delivery/product-delivery-estimator";
import { RelatedProducts, type RelatedProduct } from "./related-products";
import { productGallery } from "@/lib/products/gallery";
import { GroceryProductDetail } from "./grocery-product-detail";
import { ProductGallery, ProductLightbox } from "./product-gallery";
import { StickyAddToCart } from "./sticky-add-to-cart";
import { OptionPicker } from "@/app/(storefront)/components/option-picker";
import {
  initialVariant,
  usesOptionPickers,
  type ProductOption,
} from "@/lib/products/options";
import ReviewsSection, {
  RatingStars,
  type ProductReview,
} from "./reviews-section";

export interface DetailVariant {
  id: string;
  name: string;
  base_price: number;
  selling_price: number;
  // NULL when no sale price is set; otherwise overrides selling_price and
  // triggers the "best value" tag badge on the chip.
  special_price: number | null;
  sku: string | null;
  images: string[] | null;
  sort_order: number;
  track_inventory: boolean;
  stock: number;
  low_stock_threshold: number | null;
  allow_backorder: boolean;
  /** Positional values for the product's option axes ("M", "Black"); empty
   *  for a variant with none. */
  option_values?: string[];
}

export interface DetailProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category_id: string | null;
  base_price: number;
  selling_price: number;
  image_url: string | null;
  images: string[];
  seo_title: string | null;
  seo_description: string | null;
  category: { id: string; name: string; slug: string; status: string } | null;
  track_inventory: boolean;
  stock: number;
  low_stock_threshold: number | null;
  allow_backorder: boolean;
  /** FALSE = final sale. Said BEFORE the sale — discovering it afterwards is
   *  how a return policy becomes an argument. */
  returnable?: boolean;
  /** Option axes (size, colour). Empty for a product with plain variants. */
  options?: ProductOption[];
  variants: DetailVariant[];
}

// Effective selling price: fall back to base when no selling price is set.
function sellingOf(base: number, selling: number): number {
  return selling > 0 ? selling : base;
}

// Same fallback as sellingOf, but for variants — a special_price (if set)
// wins over the regular selling_price. Mirrors lib/pricing.variantEffective-
// Selling, with the base-fallback the PDP needs when selling_price is 0.
function variantSellingWithFallback(v: {
  base_price: number;
  selling_price: number;
  special_price: number | null;
}): number {
  const eff = variantEffectiveSelling(v);
  return eff > 0 ? eff : v.base_price;
}

export default function ProductDetailClient({
  product,
  related,
  reviews,
  grocery = false,
  storeLowStockThreshold = 0,
  offerMarker = null,
  requestedVariantId = null,
}: {
  product: DetailProduct;
  related: RelatedProduct[];
  reviews: ProductReview[];
  grocery?: boolean;
  // Store-wide default (inventory.lowStockThreshold), resolved by the page; a
  // per-SKU threshold overrides it. Drives the "Only X left" badge.
  storeLowStockThreshold?: number;
  /**
   * "20% off" or "Buy 1, get 1 free" — resolved on the SERVER by the offers
   * engine, so it is what the cart will actually do.
   *
   * ★ A STRING, NOT AN OFFER. Everything that decides it — scope, channel,
   * dates, auto-apply, conditions, the sale-price mode — is server-side, and
   * shipping the offer here would invite the client to re-derive an answer it
   * cannot reach. The page renders what it is given.
   */
  offerMarker?: string | null;
  /** `?variant=<id>` from the URL; ignored when it names no variant here. */
  requestedVariantId?: string | null;
}) {
  const router = useRouter();
  const { addItem } = useCart();
  const hasVariants = product.variants.length > 0;
  const options = useMemo(() => product.options ?? [], [product.options]);
  // Every variant with the two facts a picker needs. `available` is the same
  // isSoldOut rule the buy button uses, so a chip and the button can never
  // disagree about whether something can be bought.
  const pickable = useMemo(
    () =>
      product.variants.map((v) => ({
        ...v,
        option_values: v.option_values ?? [],
        available: !isSoldOut(v),
      })),
    [product.variants],
  );
  const showPickers = usesOptionPickers(options, pickable);
  // ★ The page opens on the requested variant, else the first one that can be
  //   BOUGHT. Opening on a sold-out first variant greyed the buy button on
  //   arrival for a product with plenty of other stock.
  const openingVariant = hasVariants
    ? (initialVariant(pickable, requestedVariantId) ?? null)
    : null;
  const [variantId, setVariantId] = useState<string | null>(
    openingVariant?.id ?? null,
  );
  const [quantity, setQuantity] = useState(1);
  // The photo the full-screen viewer is open on, or null when it is closed.
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);
  // The page's own buy buttons: the phone sticky bar appears once these scroll
  // out of view above the shopper.
  const actionsRef = useRef<HTMLDivElement>(null);

  const selectedVariant = hasVariants
    ? (product.variants.find((v) => v.id === variantId) ?? product.variants[0])
    : null;

  // Product-level gallery (shared across variants). Composed by the shared
  // resolver so the PDP's second photograph and the card's hover image are
  // always the same one.
  const productImages = useMemo(
    () => productGallery(product.image_url, product.images),
    [product.image_url, product.images],
  );

  // The gallery shown: the selected variant's OWN photos when it has any,
  // otherwise the shared product gallery.
  const variantImages = (selectedVariant?.images ?? []).filter(Boolean);
  const gallery =
    variantImages.length > 0
      ? Array.from(new Set(variantImages))
      : productImages;

  // Default image: the opening variant's first photo if it has one, else the
  // product gallery lead.
  const firstVariantImages = (openingVariant?.images ?? []).filter(Boolean);
  const [activeImg, setActiveImg] = useState<string | null>(
    firstVariantImages[0] ?? productImages[0] ?? null,
  );

  // Picking a variant swaps the main image to that variant's first photo (or
  // back to the product gallery when the variant has none of its own).
  const selectVariant = (v: DetailVariant) => {
    setVariantId(v.id);
    const imgs = (v.images ?? []).filter(Boolean);
    setActiveImg(imgs[0] ?? productImages[0] ?? null);
    // The URL names the variant on screen, so a shared or refreshed link
    // opens on it. replaceState, not the router: nothing on the server
    // depends on it, and a navigation would refetch the whole page.
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("variant", v.id);
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // A URL we cannot rewrite costs a shareable link, never the selection.
    }
  };

  const optionPicker = showPickers ? (
    <OptionPicker
      options={options}
      variants={pickable}
      selectedId={variantId}
      onSelect={selectVariant}
    />
  ) : null;

  const base = selectedVariant
    ? selectedVariant.base_price
    : product.base_price;
  const selling = selectedVariant
    ? variantSellingWithFallback(selectedVariant)
    : sellingOf(product.base_price, product.selling_price);
  const discount = discountPercent(base, selling);

  // Sell against the selected variant when present, else the simple product.
  // Shared resolver so the PDP, cards, and dashboard agree; "Only X left" now
  // honours the store-wide default threshold, not just a per-SKU override.
  const sellableSku = selectedVariant ?? product;
  const outOfStock = isSoldOut(sellableSku);
  const lowStockAmount = outOfStock
    ? null
    : lowStockLeft(sellableSku, storeLowStockThreshold);
  const isLowStock = lowStockAmount !== null;

  // The gallery tracks the active photo by URL (a variant switch swaps the
  // whole set); the gallery components speak in indexes.
  const activeIndex = Math.max(0, activeImg ? gallery.indexOf(activeImg) : 0);
  const setActiveIndex = (index: number) =>
    setActiveImg(gallery[index] ?? null);

  // Cap quantity at what the shopper can actually buy — the sellable SKU's
  // stock when it's tracked and non-backorderable, else a UI ceiling. Covers
  // simple products too (previously only variants were capped) and never wrongly
  // caps an untracked/backorderable SKU. Clamped at render so switching variants
  // can't leave a stale over-stock value; floored at 1 for display (the add
  // buttons are disabled when out of stock).
  const maxQty = maxPurchasable(sellableSku);
  const qty = Math.min(Math.max(1, quantity), Math.max(1, maxQty));

  // Aggregate rating for the summary shown near the title.
  const reviewCount = reviews.length;
  const averageRating =
    reviewCount > 0
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviewCount
      : 0;

  const addToCart = () => {
    addItem(
      {
        productId: product.id,
        slug: product.slug,
        name: product.name,
        variantId: selectedVariant?.id ?? null,
        variantName: selectedVariant?.name ?? null,
        price: selling,
        basePrice: base,
        image: activeImg ?? product.image_url ?? null,
        category: product.category?.name ?? null,
        // Snapshot the sellable SKU's stock so the cart can cap this line.
        trackInventory: sellableSku.track_inventory,
        stock: sellableSku.stock,
        allowBackorder: sellableSku.allow_backorder,
      },
      qty,
    );
  };

  const handleAddToCart = () => {
    if (outOfStock) return;
    addToCart();
    toast.success(`${product.name} added to cart`, { duration: 1800 });
  };

  const handleBuyNow = () => {
    if (outOfStock) return;
    addToCart();
    router.push("/cart");
  };

  if (grocery) {
    return (
      <main className="shop-main pdp-page gpdp-main">
        <GroceryProductDetail
          product={product}
          gallery={gallery}
          activeIndex={activeIndex}
          setActiveIndex={setActiveIndex}
          onZoom={setZoomIndex}
          actionsRef={actionsRef}
          averageRating={averageRating}
          reviewCount={reviewCount}
          hasVariants={hasVariants}
          variantId={variantId}
          selectVariant={selectVariant}
          optionPicker={optionPicker}
          offerMarker={offerMarker}
          base={base}
          selling={selling}
          discount={discount}
          outOfStock={outOfStock}
          qty={qty}
          setQuantity={setQuantity}
          maxQty={maxQty}
          onAddToCart={handleAddToCart}
          onBuyNow={handleBuyNow}
          deliveryEstimator={
            <ProductDeliveryEstimator
              productId={product.id}
              variantId={selectedVariant?.id ?? null}
              quantity={qty}
              outOfStock={outOfStock}
            />
          }
        />

        <ReviewsSection
          productId={product.id}
          productSlug={product.slug}
          reviews={reviews}
        />

        <RelatedProducts
          products={related}
          grocery
          storeLowStockThreshold={storeLowStockThreshold}
        />
        {zoomIndex !== null && gallery.length > 0 && (
          <ProductLightbox
            images={gallery}
            alt={product.name}
            index={zoomIndex}
            onIndexChange={(index) => {
              setZoomIndex(index);
              setActiveIndex(index);
            }}
            onClose={() => setZoomIndex(null)}
          />
        )}

        <StickyAddToCart
          target={actionsRef}
          name={product.name}
          variantName={selectedVariant?.name ?? null}
          image={activeImg ?? gallery[0] ?? null}
          price={selling}
          compareAt={discount > 0 ? base : null}
          disabled={outOfStock}
          onAdd={handleAddToCart}
        />
      </main>
    );
  }

  return (
    <main className="shop-main pdp-page">
      <nav className="shop-breadcrumb">
        <Link href="/shop">Shop</Link>
        <span>/</span>
        {product.category && product.category.status === "active" ? (
          <>
            <span className="shop-breadcrumb-cat">{product.category.name}</span>
            <span>/</span>
          </>
        ) : null}
        <span className="shop-breadcrumb-current">{product.name}</span>
      </nav>

      <div className="pdp-grid">
        {/* Gallery */}
        <ProductGallery
          images={gallery}
          alt={product.name}
          activeIndex={activeIndex}
          onActiveIndexChange={setActiveIndex}
          onZoom={setZoomIndex}
          classPrefix="pdp"
          sizes="(max-width: 860px) 100vw, 560px"
        />

        {/* Info */}
        <div className="pdp-info">
          {product.category && product.category.status === "active" && (
            <span className="pdp-category">{product.category.name}</span>
          )}

          {outOfStock ? (
            <div className="mb-2 inline-block text-xs font-bold uppercase tracking-wider bg-zinc-200 text-zinc-600 px-2 py-1 rounded-sm">
              Sold Out
            </div>
          ) : isLowStock ? (
            <div className="mb-2 inline-block text-xs font-bold uppercase tracking-wider bg-orange-100 text-orange-700 px-2 py-1 rounded-sm">
              Only {lowStockAmount} left in stock!
            </div>
          ) : null}

          {/* Final sale. Shown regardless of whether the store has switched
              returns on: it is a statement about THIS product, and a shopper
              is entitled to it before they pay rather than after. */}
          {product.returnable === false && (
            <div className="mb-2 ml-2 inline-block rounded-sm bg-zinc-100 px-2 py-1 text-xs font-bold uppercase tracking-wider text-zinc-600">
              Final sale · no returns
            </div>
          )}

          {offerMarker && (
            <div className="mb-2 ml-2 inline-block">
              <span className="sm-offer-badge">{offerMarker}</span>
            </div>
          )}

          <h1 className="pdp-name">{product.name}</h1>

          <a href="#reviews" className="pdp-rating-top">
            <RatingStars value={averageRating} size={16} />
            {reviewCount > 0 ? (
              <span className="pdp-rating-top-text">
                <strong>{averageRating.toFixed(1)}</strong> · {reviewCount}{" "}
                {reviewCount === 1 ? "review" : "reviews"}
              </span>
            ) : (
              <span className="pdp-rating-top-text">No reviews yet</span>
            )}
          </a>

          <div className="pdp-price">
            <span className="pdp-price-sell">{formatPrice(selling)}</span>
            {discount > 0 && (
              <>
                <span className="pdp-price-base">{formatPrice(base)}</span>
                <span className="pdp-price-off">{discount}% OFF</span>
              </>
            )}
          </div>

          <div style={{ marginTop: 14 }}>
            <ShareButtons title={product.name} />
          </div>

          {optionPicker}

          {hasVariants && !optionPicker && (
            <div className="pdp-variants">
              <label className="pdp-variants-label">Options</label>
              <div className="pdp-variant-options">
                {product.variants.map((v) => {
                  const disabled =
                    v.track_inventory && !v.allow_backorder && v.stock <= 0;
                  const hasSale = hasSpecialPrice(v);
                  const vSelling = variantSellingWithFallback(v);
                  // Show the struck-through original only when it's genuinely
                  // higher than what the customer pays for this variant.
                  const showWas = v.base_price > vSelling;
                  return (
                    <button
                      key={v.id}
                      className={`pdp-variant${variantId === v.id ? " active" : ""}${
                        disabled ? " disabled" : ""
                      }${hasSale ? " has-sale" : ""}`}
                      onClick={() => !disabled && selectVariant(v)}
                      disabled={disabled}
                      aria-label={`${v.name} — ${formatPrice(vSelling)}${
                        hasSale ? ", best value" : ""
                      }${disabled ? ", sold out" : ""}`}
                    >
                      {hasSale && (
                        <span className="pdp-variant-badge">Best value</span>
                      )}
                      <span className="pdp-variant-name">{v.name}</span>
                      <span className="pdp-variant-price">
                        {formatPrice(vSelling)}
                        {showWas && (
                          <span className="pdp-variant-was">
                            {formatPrice(v.base_price)}
                          </span>
                        )}
                      </span>
                      {disabled && (
                        <span className="pdp-variant-oos">Sold out</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <ProductDeliveryEstimator
            productId={product.id}
            variantId={selectedVariant?.id ?? null}
            quantity={qty}
            outOfStock={outOfStock}
          />

          <div className="pdp-qty">
            <label className="pdp-qty-label">Quantity</label>
            <div className="pdp-stepper">
              <button
                type="button"
                className="pdp-stepper-btn"
                onClick={() => setQuantity(Math.max(1, qty - 1))}
                disabled={outOfStock || qty <= 1}
                aria-label="Decrease quantity"
              >
                −
              </button>
              <span className="pdp-stepper-value" aria-live="polite">
                {qty}
              </span>
              <button
                type="button"
                className="pdp-stepper-btn"
                onClick={() => setQuantity(Math.min(maxQty, qty + 1))}
                disabled={outOfStock || qty >= maxQty}
                aria-label="Increase quantity"
              >
                +
              </button>
            </div>
          </div>

          <div className="pdp-actions" ref={actionsRef}>
            <button
              className="pdp-btn pdp-btn-cart"
              onClick={handleAddToCart}
              disabled={outOfStock}
            >
              {outOfStock ? "Out of stock" : "Add to Cart"}
            </button>
            <button
              className="pdp-btn pdp-btn-buy"
              onClick={handleBuyNow}
              disabled={outOfStock}
            >
              Buy Now
            </button>
          </div>

          {product.description && (
            <div className="pdp-description">
              <h2>Description</h2>
              <p>{product.description}</p>
            </div>
          )}
        </div>
      </div>

      {/* Reviews */}
      <ReviewsSection
        productId={product.id}
        productSlug={product.slug}
        reviews={reviews}
      />

      {/* You may also like */}
      <RelatedProducts
        products={related}
        storeLowStockThreshold={storeLowStockThreshold}
      />

      {/* Zoom lightbox */}
      {zoomIndex !== null && gallery.length > 0 && (
        <ProductLightbox
          images={gallery}
          alt={product.name}
          index={zoomIndex}
          onIndexChange={(index) => {
            setZoomIndex(index);
            setActiveIndex(index);
          }}
          onClose={() => setZoomIndex(null)}
        />
      )}

      <StickyAddToCart
        target={actionsRef}
        name={product.name}
        variantName={selectedVariant?.name ?? null}
        image={activeImg ?? gallery[0] ?? null}
        price={selling}
        compareAt={discount > 0 ? base : null}
        disabled={outOfStock}
        onAdd={handleAddToCart}
      />
    </main>
  );
}
