"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { PredictiveSearch } from "./predictive-search";
import styles from "./Header.module.css";

// ---------------------------------------------------------------------------
// Search on a phone: a button in the header that opens a full-width sheet.
//
// ★ THE HEADER BOX IS HIDDEN BELOW 768px, and search used to live only inside
// the menu drawer — two taps and a scroll away, and shown even when the
// merchant had switched search off. Shopify's themes put a search icon in the
// phone header; this is that. It renders only where the box does not
// (CSS), and only when the merchant's own showSearch is on (Header).
//
// ★ PORTALLED INTO `.storefront-root`, NOT rendered inside the header. The
// header gains `backdrop-filter` once the page scrolls, and a filtered element
// becomes the containing block for every `position: fixed` child — the Help
// assistant's 8px-sliver bug. `.storefront-root` also carries the theme's
// inline tokens, which document.body would not.
//
// ★ FOCUS: opening focuses the input (the keyboard comes up because the tap
// was the shopper's own); closing — the X, the backdrop, Escape or a
// navigation — returns focus to the button that opened it.
// ---------------------------------------------------------------------------

export function PhoneSearch() {
  const [open, setOpen] = useState(false);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      // The input's own Escape clears the text first and marks the event
      // handled; only an Escape nobody claimed closes the sheet.
      if (event.key === "Escape" && !event.defaultPrevented) {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.phoneSearchBtn}
        aria-label="Search"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setRoot(
            buttonRef.current?.closest<HTMLElement>(".storefront-root") ??
              document.body,
          );
          setOpen(true);
        }}
      >
        <svg
          width="21"
          height="21"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="11" cy="11" r="8"></circle>
          <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
        </svg>
      </button>
      {open &&
        root &&
        createPortal(
          <div className={styles.searchSheetLayer}>
            <div
              className={styles.searchSheetBackdrop}
              onClick={close}
              aria-hidden
            />
            <div
              className={styles.searchSheet}
              role="dialog"
              aria-modal="true"
              aria-label="Search the store"
            >
              <PredictiveSearch
                variant="sheet"
                autoFocus
                onNavigate={() => setOpen(false)}
                onEscape={close}
              />
              <button
                type="button"
                className={styles.searchSheetClose}
                onClick={close}
                aria-label="Close search"
              >
                <X size={22} strokeWidth={2.2} aria-hidden />
              </button>
            </div>
          </div>,
          root,
        )}
    </>
  );
}
