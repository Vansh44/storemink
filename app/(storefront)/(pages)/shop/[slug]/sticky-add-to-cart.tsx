"use client";

import { useEffect, useState, type RefObject } from "react";
import Image from "next/image";
import { formatPrice } from "@/lib/pricing";

// ---------------------------------------------------------------------------
// The phone add-to-cart bar that appears once the page's own Add to Cart has
// scrolled out of view — the single most copied pattern in paid Shopify
// themes, because on a phone the buy button is otherwise a long scroll back
// up from the reviews.
//
// ★ THEME OPT-IN (`layout.stickyAddToCart`). It adds chrome to every product
//   page, so an existing store gets it only when its theme asks. The bar is
//   always rendered and CSS shows it only under the `sm-sticky-atc` root
//   class at phone widths — the `QuickAddButton` pattern: a few DOM nodes and
//   one IntersectionObserver, no network.
// ★ IT APPEARS ONLY ONCE THE SHOPPER HAS SCROLLED PAST the real button, never
//   while that button is still on screen above it (two buy buttons at once
//   reads as a mistake), and never before reaching it.
// ★ IT BUYS WHAT THE PAGE IS SHOWING: the selected variant and quantity live
//   in the page's controller, and this calls the same handler.
// ---------------------------------------------------------------------------

export function StickyAddToCart({
  target,
  name,
  variantName,
  image,
  price,
  compareAt,
  disabled,
  onAdd,
}: {
  target: RefObject<HTMLElement | null>;
  name: string;
  variantName: string | null;
  image: string | null;
  price: number;
  compareAt: number | null;
  disabled: boolean;
  onAdd: () => void;
}) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = target.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      setShown(!entry.isIntersecting && entry.boundingClientRect.top < 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [target]);

  return (
    <>
      <div
        className={`sm-sticky-atc${shown ? " is-shown" : ""}`}
        aria-hidden={!shown}
        inert={!shown}
      >
        {image ? (
          <span className="sm-sticky-atc-thumb">
            <Image src={image} alt="" fill sizes="44px" />
          </span>
        ) : null}
        <span className="sm-sticky-atc-text">
          <span className="sm-sticky-atc-name">{name}</span>
          <span className="sm-sticky-atc-price">
            {variantName ? `${variantName} · ` : ""}
            {formatPrice(price)}
            {compareAt !== null && compareAt > price ? (
              <s className="sm-sticky-atc-was">{formatPrice(compareAt)}</s>
            ) : null}
          </span>
        </span>
        <button
          type="button"
          className="sm-sticky-atc-btn"
          onClick={onAdd}
          disabled={disabled}
        >
          {disabled ? "Sold out" : "Add to cart"}
        </button>
      </div>
      {/* Room under the last content so the bar never covers the footer's
          final line when a shopper scrolls to the very end. */}
      <div className="sm-sticky-atc-spacer" aria-hidden />
    </>
  );
}
