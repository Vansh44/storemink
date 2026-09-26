"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { NavLink } from "@/lib/chrome/nav";
import styles from "./Header.module.css";

// ---------------------------------------------------------------------------
// The phone drawer's menu: one level on screen at a time, drilling down.
//
// ★ DRILL-DOWN, NOT AN ACCORDION. Three levels of expanding rows in a 320px
//   drawer push the last top-level item off the screen the moment one section
//   opens, and nothing on screen says it is still there. Shopify's own themes
//   drill for the same reason.
// ★ A plain top-level link renders as it always has, so a flat menu looks
//   exactly as before; only an item with children becomes a row with a chevron.
// ★ The parent is remounted on every open (Header keys it), so a shopper who
//   closed the drawer three levels deep reopens it at the top.
// ★ Focus follows the level: drilling in lands on Back, going back lands on
//   the row that was opened, so a screen-reader user is never left on an
//   element that has just been removed.
// ---------------------------------------------------------------------------

export function DrawerNav({
  links,
  onNavigate,
}: {
  links: readonly NavLink[];
  onNavigate: () => void;
}) {
  const [path, setPath] = useState<number[]>([]);
  const [returnTo, setReturnTo] = useState<number | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const rows = useRef<(HTMLElement | null)[]>([]);

  let list: readonly NavLink[] = links;
  let parent: NavLink | null = null;
  for (const index of path) {
    parent = list[index] ?? null;
    list = parent?.children ?? [];
  }

  useEffect(() => {
    if (path.length) backRef.current?.focus();
    else if (returnTo !== null) rows.current[returnTo]?.focus();
  }, [path, returnTo]);

  return (
    <nav
      className={styles.drawerNav}
      aria-label={parent ? parent.label : "Menu"}
    >
      {parent && (
        <div
          key={`head-${path.join(".")}`}
          className={`${styles.drawerLevelHead} ${styles.drawerLevelIn}`}
        >
          <button
            ref={backRef}
            type="button"
            className={styles.drawerBack}
            onClick={() => {
              setReturnTo(path[path.length - 1]);
              setPath(path.slice(0, -1));
            }}
          >
            <ChevronLeft size={18} strokeWidth={2.2} aria-hidden />
            Back
          </button>
          <p className={styles.drawerLevelTitle}>{parent.label}</p>
          {parent.href && (
            <Link
              href={parent.href}
              className={styles.drawerViewAll}
              onClick={onNavigate}
            >
              View all {parent.label}
            </Link>
          )}
        </div>
      )}
      {list.map((link, index) =>
        link.children?.length ? (
          <button
            key={`${path.join(".")}-${link.href}|${link.label}`}
            ref={(el) => {
              rows.current[index] = el;
            }}
            type="button"
            className={`${styles.drawerNavParent} ${
              path.length ? styles.drawerLevelIn : ""
            }`}
            aria-haspopup="true"
            onClick={() => {
              setReturnTo(null);
              setPath([...path, index]);
            }}
          >
            <span>{link.label}</span>
            <ChevronRight size={18} strokeWidth={2.2} aria-hidden />
          </button>
        ) : (
          <Link
            key={`${path.join(".")}-${link.href}|${link.label}`}
            ref={(el) => {
              rows.current[index] = el;
            }}
            href={link.href}
            className={path.length ? styles.drawerLevelIn : undefined}
            onClick={onNavigate}
          >
            {link.label}
          </Link>
        ),
      )}
    </nav>
  );
}
