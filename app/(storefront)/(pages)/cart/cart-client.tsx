"use client";

import Link from "next/link";
import Image from "next/image";
import { ImageIcon } from "lucide-react";

import { formatPrice, discountPercent } from "@/lib/pricing";
import { cartLineMax } from "@/lib/inventory/status";
import {
  useCart,
  lineKey,
  type CartItem,
} from "@/app/(storefront)/components/cart/CartProvider";
import CouponField from "@/app/(storefront)/components/cart/CouponField";
import { GroceryCart } from "./grocery-cart";

export default function CartClient({ grocery = false }: { grocery?: boolean }) {
  if (grocery) return <GroceryCart />;
  return <ClassicCart />;
}

function ClassicCart() {
  const {
    items,
    hydrated,
    setQuantity,
    removeItem,
    clear,
    subtotal,
    totalItems,
    appliedCoupon,
    couponValid,
    couponDiscount,
    total,
  } = useCart();

  // Avoid a flash of "empty" before localStorage is read on the client.
  if (!hydrated) {
    return (
      <main className="cart-main">
        <div className="cart-loading">Loading your cart…</div>
      </main>
    );
  }

  if (items.length === 0) {
    return (
      <main className="cart-main">
        <div className="cart-empty">
          <div className="cart-empty-icon" aria-hidden="true">
            🛒
          </div>
          <h1 className="cart-empty-title">Your cart is empty</h1>
          <p className="cart-empty-sub">
            Looks like you haven&apos;t added anything yet.
          </p>
          <Link href="/shop" className="cart-empty-cta sm-btn-primary">
            Continue shopping
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="cart-main">
      <div className="cart-head">
        <h1 className="cart-title">Shopping Cart</h1>
        <span className="cart-count">
          {totalItems} {totalItems === 1 ? "item" : "items"}
        </span>
      </div>

      <div className="cart-layout">
        {/* Line items */}
        <ul className="cart-items">
          {items.map((item) => {
            const key = lineKey(item.productId, item.variantId);
            return (
              <CartLine
                key={key}
                item={item}
                onDec={() => setQuantity(key, item.quantity - 1)}
                onInc={() => setQuantity(key, item.quantity + 1)}
                onRemove={() => removeItem(key)}
              />
            );
          })}
        </ul>

        {/* Summary */}
        <aside className="cart-summary">
          <h2 className="cart-summary-title">Order Summary</h2>
          <div className="cart-summary-row">
            <span>Subtotal</span>
            <span>{formatPrice(subtotal)}</span>
          </div>
          {appliedCoupon && couponValid && couponDiscount > 0 && (
            <div className="cart-summary-row cart-summary-discount">
              <span>Discount ({appliedCoupon.code})</span>
              <span>−{formatPrice(couponDiscount)}</span>
            </div>
          )}
          <div className="cart-summary-row cart-summary-muted">
            <span>Shipping &amp; taxes</span>
            <span>Calculated at checkout</span>
          </div>

          {/* Coupon */}
          <div className="cart-coupon">
            <CouponField />
          </div>

          <div className="cart-summary-divider" />
          <div className="cart-summary-row cart-summary-total">
            <span>Total</span>
            <span>{formatPrice(total)}</span>
          </div>
          <Link
            href="/checkout"
            className="cart-checkout-btn sm-btn-primary block text-center"
          >
            Proceed to Checkout
          </Link>
          <Link href="/shop" className="cart-continue-link">
            Continue shopping
          </Link>
          <button className="cart-clear-btn" onClick={clear}>
            Clear cart
          </button>
        </aside>
      </div>
    </main>
  );
}

function CartLine({
  item,
  onDec,
  onInc,
  onRemove,
}: {
  item: CartItem;
  onDec: () => void;
  onInc: () => void;
  onRemove: () => void;
}) {
  const discount = discountPercent(item.basePrice, item.price);
  const lineTotal = item.price * item.quantity;
  const max = cartLineMax(item);
  const atMax = item.quantity >= max;

  return (
    <li className="cart-item">
      <Link href={`/shop/${item.slug}`} className="cart-item-img">
        {item.image ? (
          <Image
            src={item.image}
            alt={item.name}
            fill
            sizes="96px"
            className="cart-item-img-el"
          />
        ) : (
          <span className="cart-item-img-placeholder">
            <ImageIcon size={22} strokeWidth={1.5} aria-hidden />
          </span>
        )}
      </Link>

      <div className="cart-item-body">
        <div className="cart-item-info">
          <Link href={`/shop/${item.slug}`} className="cart-item-name">
            {item.name}
          </Link>
          {item.variantName && (
            <span className="cart-item-variant">{item.variantName}</span>
          )}
          <div className="cart-item-price">
            <span className="cart-item-price-sell">
              {formatPrice(item.price)}
            </span>
            {discount > 0 && (
              <span className="cart-item-price-base">
                {formatPrice(item.basePrice)}
              </span>
            )}
          </div>
        </div>

        <div className="cart-item-controls">
          <div className="cart-stepper">
            <button
              type="button"
              className="cart-stepper-btn"
              onClick={onDec}
              aria-label="Decrease quantity"
            >
              −
            </button>
            <span className="cart-stepper-value">{item.quantity}</span>
            <button
              type="button"
              className="cart-stepper-btn"
              onClick={onInc}
              disabled={atMax}
              aria-label="Increase quantity"
            >
              +
            </button>
          </div>
          {atMax && <span className="cart-item-max">Max available: {max}</span>}
          <span className="cart-item-line-total">{formatPrice(lineTotal)}</span>
          <button
            type="button"
            className="cart-item-remove"
            onClick={onRemove}
            aria-label={`Remove ${item.name}`}
          >
            Remove
          </button>
        </div>
      </div>
    </li>
  );
}
