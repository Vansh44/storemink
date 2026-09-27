/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { formatPrice } from "@/lib/pricing";
import {
  normalizeProductQuery,
  PREDICTIVE_MIN_CHARS,
} from "@/lib/storefront/product-search";
import type { PredictiveResponse } from "@/lib/storefront/product-search";
import styles from "./Header.module.css";

// ---------------------------------------------------------------------------
// The header search box, with suggestions as the shopper types.
//
// ★ IT KEEPS THE OLD FORM'S CLASSES (searchBar / searchInput / searchIcon), so
// every header variant — market's white pill, minimal's underline, centered's
// width — styles it exactly as before. At rest it IS the old search box;
// Enter still goes to /shop?q=, which is also what a shopper gets with
// JavaScript still loading.
//
// ★ THE ARIA 1.2 COMBOBOX PATTERN: the input owns aria-expanded /
// aria-controls / aria-activedescendant and keeps focus the whole time, so a
// screen reader hears the highlighted suggestion while the shopper keeps
// typing. Arrow keys move through suggestions, Enter opens the highlighted one
// (or searches when none is), Escape closes the list and then clears the box.
//
// ★ A NEWER KEYSTROKE CANCELS AN OLDER REQUEST. Lookups are debounced and
// every one carries an AbortController, so a slow answer for "ca" can never
// land on top of the answer for "cand". Answers are remembered for the page's
// lifetime, so backspacing is instant.
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 150;
const REMEMBERED = 30;
const remembered = new Map<string, PredictiveResponse>();

function remember(query: string, body: PredictiveResponse) {
  remembered.set(query, body);
  if (remembered.size > REMEMBERED) {
    remembered.delete(remembered.keys().next().value as string);
  }
}

/** Test seam: the cache is module-level so it survives re-renders. */
export function forgetPredictiveSearches() {
  remembered.clear();
}

type Option = { id: string; href: string };

export function PredictiveSearch({
  variant = "bar",
  autoFocus = false,
  onNavigate,
  onEscape,
}: {
  /** "bar": the header box with a dropdown. "sheet": the phone search panel,
   * whose results fill the panel instead of floating. */
  variant?: "bar" | "sheet";
  autoFocus?: boolean;
  /** Called after any navigation the box starts (a suggestion or a search). */
  onNavigate?: () => void;
  /** Escape on an already-closed, empty box — the sheet closes itself. */
  onEscape?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const baseId = useId();
  const listId = `${baseId}-list`;
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const [value, setValue] = useState("");
  const [results, setResults] = useState<PredictiveResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [shownFor, setShownFor] = useState(pathname);

  // Arriving on a new page closes the list (derived during render).
  if (shownFor !== pathname) {
    setShownFor(pathname);
    if (open) setOpen(false);
  }

  const query = normalizeProductQuery(value);
  const searchable = query.length >= PREDICTIVE_MIN_CHARS;

  useEffect(() => {
    if (!searchable) return;
    const cached = remembered.get(query);
    if (cached) {
      // Deferred like the fetch below, so no state is set during the effect.
      const t = setTimeout(() => {
        setResults(cached);
        setLoading(false);
      }, 0);
      return () => clearTimeout(t);
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(
          `/api/storefront/search?q=${encodeURIComponent(query)}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as PredictiveResponse;
        remember(query, body);
        if (!controller.signal.aborted) setResults(body);
      } catch {
        // Aborted by a newer keystroke, or the lookup failed. A failed
        // suggestion is not worth surfacing: Enter still searches.
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchable]);

  // A press outside the box closes the list.
  useEffect(() => {
    if (!open || variant === "sheet") return;
    const onDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, variant]);

  // Only a result for the query now in the box is shown; an older one would
  // describe what the shopper has already typed past.
  const current = searchable && results?.query === query ? results : null;
  const options: Option[] = current
    ? [
        ...current.products.map((p, i) => ({
          id: `${baseId}-p${i}`,
          href: p.href,
        })),
        ...current.categories.map((c, i) => ({
          id: `${baseId}-c${i}`,
          href: c.href,
        })),
        { id: `${baseId}-all`, href: `/shop?q=${encodeURIComponent(query)}` },
      ]
    : [];
  const expanded = (variant === "sheet" || open) && current !== null;
  const activeOption = expanded ? options[active] : undefined;

  const go = (href: string) => {
    setOpen(false);
    setActive(-1);
    onNavigate?.();
    router.push(href);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (activeOption) return go(activeOption.href);
    const q = value.trim();
    go(q ? `/shop?q=${encodeURIComponent(q)}` : "/shop");
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!current || options.length === 0) return;
      event.preventDefault();
      setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => {
        const next = index + step;
        if (next < -1) return options.length - 1;
        if (next >= options.length) return -1;
        return next;
      });
      return;
    }
    if (event.key === "Escape") {
      if (expanded && variant === "bar") {
        event.preventDefault();
        setOpen(false);
        setActive(-1);
      } else if (value) {
        event.preventDefault();
        setValue("");
        setActive(-1);
      } else {
        onEscape?.();
      }
    }
  };

  let index = 0;
  const optionProps = (href: string) => {
    const option = options[index];
    const selected = index === active;
    index += 1;
    return {
      id: option.id,
      role: "option" as const,
      "aria-selected": selected,
      className: `${styles.predictiveOption} ${
        selected ? styles.predictiveActive : ""
      }`,
      // Keeps focus in the input, so the list survives the press.
      onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
      "data-href": href,
    };
  };

  const productCount = current?.products.length ?? 0;
  const status = !searchable
    ? ""
    : loading && !current
      ? "Searching…"
      : current
        ? current.total === 0
          ? `No products match “${query}”.`
          : `${current.total} product${current.total === 1 ? "" : "s"} found.`
        : "";

  return (
    <div
      ref={wrapRef}
      className={`${styles.searchWrap} ${
        variant === "sheet" ? styles.searchWrapSheet : ""
      }`}
    >
      <form
        className={
          variant === "sheet" ? styles.drawerSearchBar : styles.searchBar
        }
        onSubmit={submit}
        role="search"
      >
        <input
          ref={inputRef}
          type="text"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoFocus={autoFocus}
          placeholder="Search products..."
          className={styles.searchInput}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          aria-label="Search products"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={activeOption?.id}
        />
        <button type="submit" className={styles.searchIcon} aria-label="Search">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </button>
      </form>

      <p className={styles.srOnly} role="status" aria-live="polite">
        {expanded ? status : ""}
      </p>

      <div
        className={
          variant === "sheet"
            ? styles.predictiveSheetResults
            : styles.predictivePanel
        }
        hidden={!expanded}
      >
        <ul id={listId} role="listbox" aria-label="Search suggestions">
          {current && productCount > 0 && (
            <li role="presentation" className={styles.predictiveHeading}>
              Products
            </li>
          )}
          {current?.products.map((product) => (
            <li key={product.href} {...optionProps(product.href)}>
              <Link
                href={product.href}
                tabIndex={-1}
                className={styles.predictiveProduct}
                onClick={(e) => {
                  e.preventDefault();
                  go(product.href);
                }}
              >
                <span className={styles.predictiveThumb} aria-hidden>
                  {product.imageUrl && (
                    <img src={product.imageUrl} alt="" loading="lazy" />
                  )}
                </span>
                <span className={styles.predictiveText}>
                  <span className={styles.predictiveName}>{product.name}</span>
                  <span className={styles.predictivePrice}>
                    {formatPrice(product.price)}
                    {product.compareAt !== null && (
                      <s className={styles.predictiveCompare}>
                        {formatPrice(product.compareAt)}
                      </s>
                    )}
                  </span>
                </span>
              </Link>
            </li>
          ))}
          {current && current.categories.length > 0 && (
            <li role="presentation" className={styles.predictiveHeading}>
              Categories
            </li>
          )}
          {current?.categories.map((category) => (
            <li key={category.href} {...optionProps(category.href)}>
              <Link
                href={category.href}
                tabIndex={-1}
                className={styles.predictiveCategory}
                onClick={(e) => {
                  e.preventDefault();
                  go(category.href);
                }}
              >
                {category.name}
              </Link>
            </li>
          ))}
          {current && current.total === 0 && (
            <li role="presentation" className={styles.predictiveEmpty}>
              No products match “{query}”.
            </li>
          )}
          {current && (
            <li
              {...optionProps(`/shop?q=${encodeURIComponent(query)}`)}
              data-all
            >
              <Link
                href={`/shop?q=${encodeURIComponent(query)}`}
                tabIndex={-1}
                className={styles.predictiveAll}
                onClick={(e) => {
                  e.preventDefault();
                  go(`/shop?q=${encodeURIComponent(query)}`);
                }}
              >
                {current.total > productCount
                  ? `See all ${current.total} results for “${query}”`
                  : `Search for “${query}”`}
              </Link>
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
