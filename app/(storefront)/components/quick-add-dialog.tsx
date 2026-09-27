"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import Link from "next/link";
import { X } from "lucide-react";
import { toast } from "sonner";
import { formatPrice, variantEffectiveSelling } from "@/lib/pricing";
import { isSoldOut } from "@/lib/inventory/status";
import { initialVariant, usesOptionPickers } from "@/lib/products/options";
import {
  getQuickAddProduct,
  type QuickAddProduct,
  type QuickAddVariant,
} from "@/app/actions/quick-add-actions";
import { useCart } from "./cart/CartProvider";
import { OptionPicker } from "./option-picker";

// ---------------------------------------------------------------------------
// "+ Add" on a product that has variants: choose the size and colour without
// leaving the grid. It used to fall through to the product page, which turned
// the fastest way to buy on a phone into a page load for every item.
//
// ★ PORTALLED INTO `.storefront-root`, NOT document.body. The theme's palette,
//   type and radii are inline CSS variables on that element, so a dialog
//   mounted outside it renders in the WholeSip defaults. And it cannot render
//   in place: the card is a <Link>, so a dialog inside it would be a dialog
//   inside an anchor.
// ★ Its root STOPS PROPAGATION. React bubbles synthetic events through a
//   portal to the component tree, so without it every tap inside the dialog
//   would reach the card's link and navigate away.
// ---------------------------------------------------------------------------

function sellingOf(v: QuickAddVariant): number {
  const eff = variantEffectiveSelling(v);
  return eff > 0 ? eff : v.base_price;
}

export function QuickAddDialog({
  productId,
  anchor,
  onClose,
}: {
  productId: string;
  /** The button that opened it; focus returns there on close. */
  anchor: HTMLElement | null;
  onClose: () => void;
}) {
  const { addItem } = useCart();
  const [product, setProduct] = useState<QuickAddProduct | null>(null);
  const [failed, setFailed] = useState(false);
  const [variantId, setVariantId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    getQuickAddProduct(productId)
      .then((p) => {
        if (!live) return;
        if (!p) setFailed(true);
        else {
          setProduct(p);
          setVariantId(
            initialVariant(
              p.variants.map((v) => ({ ...v, available: !isSoldOut(v) })),
            )?.id ?? null,
          );
        }
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [productId]);

  // Escape closes, the page behind does not scroll, and focus moves into the
  // dialog and back to "+ Add" afterwards.
  // The latest onClose, so the effect below runs once per opening rather than
  // re-running (and bouncing focus) whenever the parent re-renders.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      anchor?.focus();
    };
  }, [anchor]);

  const pickable = useMemo(
    () =>
      (product?.variants ?? []).map((v) => ({
        ...v,
        available: !isSoldOut(v),
      })),
    [product],
  );
  const selected = pickable.find((v) => v.id === variantId) ?? null;
  const pickers =
    product !== null && usesOptionPickers(product.options, pickable);
  const image =
    (selected?.images ?? []).filter(Boolean)[0] ?? product?.image_url ?? null;
  const soldOut = !selected || !selected.available;

  const add = () => {
    if (!product || !selected || soldOut) return;
    addItem({
      productId: product.id,
      slug: product.slug,
      name: product.name,
      variantId: selected.id,
      variantName: selected.name,
      price: sellingOf(selected),
      basePrice: selected.base_price,
      image,
      category: product.category,
      trackInventory: selected.track_inventory,
      stock: selected.stock,
      allowBackorder: selected.allow_backorder,
    });
    toast.success(`${product.name} (${selected.name}) added to cart`, {
      duration: 1800,
    });
    onClose();
  };

  const root =
    anchor?.closest<HTMLElement>(".storefront-root") ?? document.body;

  return createPortal(
    <div
      className="sm-quickadd"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={product ? `Choose options for ${product.name}` : "Options"}
        tabIndex={-1}
        className="sm-quickadd-panel"
      >
        <button
          type="button"
          className="sm-quickadd-close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={18} aria-hidden />
        </button>

        {failed ? (
          <p className="sm-quickadd-msg">
            This product could not be loaded. Please try again.
          </p>
        ) : !product ? (
          <p className="sm-quickadd-msg" aria-live="polite">
            Loading options…
          </p>
        ) : (
          <>
            <div className="sm-quickadd-head">
              {image && (
                <div className="sm-quickadd-img">
                  <Image src={image} alt="" fill sizes="96px" />
                </div>
              )}
              <div className="min-w-0">
                <p className="sm-quickadd-name">{product.name}</p>
                {selected && (
                  <p className="sm-quickadd-price">
                    {formatPrice(sellingOf(selected))}
                    {selected.base_price > sellingOf(selected) && (
                      <span className="sm-quickadd-was">
                        {formatPrice(selected.base_price)}
                      </span>
                    )}
                  </p>
                )}
              </div>
            </div>

            {pickers ? (
              <OptionPicker
                options={product.options}
                variants={pickable}
                selectedId={variantId}
                onSelect={(v) => setVariantId(v.id)}
              />
            ) : (
              <div className="sm-opts">
                <fieldset className="sm-opt">
                  <legend className="sm-opt-legend">Options</legend>
                  <div className="sm-opt-values">
                    {pickable.map((v) => (
                      <button
                        key={v.id}
                        type="button"
                        aria-pressed={v.id === variantId}
                        className={`sm-opt-value${
                          v.id === variantId ? " is-active" : ""
                        }${v.available ? "" : " is-unavailable"}`}
                        onClick={() => setVariantId(v.id)}
                      >
                        {v.name}
                      </button>
                    ))}
                  </div>
                </fieldset>
              </div>
            )}

            <button
              type="button"
              className="sm-quickadd-add"
              disabled={soldOut}
              onClick={add}
            >
              {soldOut ? "Sold out" : "Add to cart"}
            </button>
            <Link
              href={`/shop/${product.slug}${
                selected ? `?variant=${selected.id}` : ""
              }`}
              className="sm-quickadd-details"
            >
              View full details
            </Link>
          </>
        )}
      </div>
    </div>,
    root,
  );
}
