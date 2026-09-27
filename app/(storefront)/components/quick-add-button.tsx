"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useCart, lineKey } from "./cart/CartProvider";
import { effectivePricing } from "@/lib/pricing";
import { cartLineMax, productIsSoldOut } from "@/lib/inventory/status";
import type { ShopCardProduct } from "./shop-card";
import { QuickAddDialog } from "./quick-add-dialog";

// The "+ Add" button on product cards (theme layout.card = "quick_add").
// Rendered by every ShopCard but hidden by CSS unless the storefront root has
// .sm-card-quickadd, so classic themes pay no visual cost.
//
// Products WITHOUT variants add straight to the cart. Products WITH variants
// open a small chooser (quick-add-dialog.tsx) with the same size and colour
// pickers as the product page, so buying from the grid never needs a page
// load. A product with every variant sold out still falls through to the card
// link, where the product page can say so properly.
export function QuickAddButton({ product }: { product: ShopCardProduct }) {
  const { addItem, items } = useCart();
  // The "+ Add" element while the chooser is open; null when it is closed.
  const [chooserAnchor, setChooserAnchor] = useState<HTMLElement | null>(null);
  const closeChooser = useCallback(() => setChooserAnchor(null), []);
  const pr = effectivePricing(product);

  const isOutOfStock = productIsSoldOut(product.variants ?? [], product);

  // Cap for this (variantless) line, and how many are already in the cart, so a
  // rapid-fire "+ Add" can't pile quantity past available stock.
  const max = cartLineMax({
    trackInventory: product.track_inventory,
    stock: product.stock,
    allowBackorder: product.allow_backorder,
  });
  const inCart =
    items.find(
      (i) => lineKey(i.productId, i.variantId) === lineKey(product.id, null),
    )?.quantity ?? 0;

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isOutOfStock) return; // bubble to the card link → detail page
    e.preventDefault();
    e.stopPropagation();
    if (pr.hasVariants) {
      setChooserAnchor(e.currentTarget);
      return;
    }
    if (inCart >= max) {
      toast.error(
        `Only ${max} of ${product.name} available — already in your cart.`,
        { duration: 2200 },
      );
      return;
    }
    addItem({
      productId: product.id,
      slug: product.slug,
      name: product.name,
      variantId: null,
      variantName: null,
      price: pr.selling,
      basePrice: pr.base,
      image: product.image_url,
      category: product.category ?? null,
      trackInventory: product.track_inventory,
      stock: product.stock,
      allowBackorder: product.allow_backorder,
    });
    toast.success(`${product.name} added to cart`, { duration: 1800 });
  };

  return (
    <>
      <div
        role="button"
        aria-haspopup={pr.hasVariants ? "dialog" : undefined}
        tabIndex={0}
        className="shop-card-add flex items-center justify-center cursor-pointer"
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick(e as unknown as React.MouseEvent<HTMLDivElement>);
          }
        }}
        aria-label={
          pr.hasVariants
            ? `Choose options for ${product.name}`
            : isOutOfStock
              ? `${product.name} is out of stock`
              : `Add ${product.name} to cart`
        }
        style={{
          opacity: isOutOfStock && !pr.hasVariants ? 0.5 : 1,
          cursor: isOutOfStock && !pr.hasVariants ? "not-allowed" : "pointer",
        }}
      >
        {isOutOfStock && !pr.hasVariants ? "Sold Out" : "+ Add"}
      </div>
      {chooserAnchor && (
        <QuickAddDialog
          productId={product.id}
          anchor={chooserAnchor}
          onClose={closeChooser}
        />
      )}
    </>
  );
}
