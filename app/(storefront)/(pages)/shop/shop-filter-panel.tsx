"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { formatPrice } from "@/lib/pricing";
import type { ShopQuery } from "@/lib/storefront/shop-filters";

// ---------------------------------------------------------------------------
// The shop's filter panel — a side drawer on a computer, a bottom sheet on a
// phone (CSS decides; the markup is one dialog).
//
// ★ CHANGES ARE A DRAFT UNTIL "SHOW N PRODUCTS". Applying each keystroke would
// re-sort the grid behind the panel while somebody is still typing "1500" —
// three filters in a row, the middle two meaningless. The button quotes how
// many products the draft would show, so nobody commits to an empty page
// blind; closing the panel any other way discards the draft.
//
// ★ PORTALLED INTO `.storefront-root`, the quick-add dialog's rule: the
// theme's palette and radii are inline variables there, and document.body
// would render the panel in the fallback look.
// ---------------------------------------------------------------------------

function toBound(raw: string): number | null {
  if (raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

export function ShopFilterPanel({
  value,
  span,
  inStockCount,
  countFor,
  onApply,
  onClose,
}: {
  value: ShopQuery;
  /** Cheapest and dearest price in scope, for the placeholders. */
  span: { min: number; max: number } | null;
  inStockCount: number;
  /** How many products a draft would show. */
  countFor: (draft: ShopQuery) => number;
  onApply: (next: ShopQuery) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [inStock, setInStock] = useState(value.inStock);
  const [min, setMin] = useState(value.min === null ? "" : String(value.min));
  const [max, setMax] = useState(value.max === null ? "" : String(value.max));
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  let lo = toBound(min);
  let hi = toBound(max);
  if (lo !== null && hi !== null && lo > hi) [lo, hi] = [hi, lo];
  const draft: ShopQuery = { ...value, inStock, min: lo, max: hi };
  const count = countFor(draft);

  // Escape closes, Tab stays inside, the page behind does not scroll, and
  // focus starts on the panel (the caller returns it to "Filter").
  useEffect(() => {
    const dialog = dialogRef.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, []);

  const root =
    document.querySelector<HTMLElement>(".storefront-root") ?? document.body;

  return createPortal(
    <div className="shop-filter-layer">
      <div className="shop-filter-backdrop" onClick={onClose} aria-hidden />
      <div
        ref={dialogRef}
        className="shop-filter-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="shop-filter-head">
          <h2 id={titleId}>Filter</h2>
          <button
            type="button"
            className="shop-filter-close"
            onClick={onClose}
            aria-label="Close filters"
          >
            <X size={20} aria-hidden />
          </button>
        </div>

        <div className="shop-filter-body">
          <fieldset className="shop-filter-group">
            <legend>Availability</legend>
            <label className="shop-filter-check">
              <input
                type="checkbox"
                checked={inStock}
                onChange={(e) => setInStock(e.target.checked)}
              />
              <span>In stock only</span>
              <span className="shop-filter-muted">({inStockCount})</span>
            </label>
          </fieldset>

          <fieldset className="shop-filter-group">
            <legend>Price</legend>
            {span && (
              <p className="shop-filter-muted shop-filter-hint">
                Prices here run from {formatPrice(span.min)} to{" "}
                {formatPrice(span.max)}.
              </p>
            )}
            <div className="shop-filter-range">
              <label>
                <span>From</span>
                <span className="shop-filter-money">
                  <span aria-hidden>₹</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    aria-label="Minimum price in rupees"
                    value={min}
                    placeholder={span ? String(span.min) : "0"}
                    onChange={(e) => setMin(e.target.value)}
                  />
                </span>
              </label>
              <label>
                <span>To</span>
                <span className="shop-filter-money">
                  <span aria-hidden>₹</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    aria-label="Maximum price in rupees"
                    value={max}
                    placeholder={span ? String(span.max) : ""}
                    onChange={(e) => setMax(e.target.value)}
                  />
                </span>
              </label>
            </div>
          </fieldset>
        </div>

        <div className="shop-filter-foot">
          <button
            type="button"
            className="shop-filter-reset"
            onClick={() => {
              setInStock(false);
              setMin("");
              setMax("");
            }}
          >
            Clear
          </button>
          <button
            type="button"
            className="shop-filter-apply"
            onClick={() => {
              onApply(draft);
              onClose();
            }}
          >
            Show {count} {count === 1 ? "product" : "products"}
          </button>
        </div>
      </div>
    </div>,
    root,
  );
}
