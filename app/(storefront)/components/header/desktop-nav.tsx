/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { navPanelKind, type NavLink } from "@/lib/chrome/nav";
import styles from "./Header.module.css";

// ---------------------------------------------------------------------------
// The header's desktop and tablet menu.
//
// ★ A PLAIN LINK RENDERS EXACTLY AS IT ALWAYS DID — the same <Link> in the
//   same <nav>, with the same key (the nav gains only an aria-label). Only an
//   item with children changes, so a store that never nests a menu looks
//   exactly as it did, and this needs no theme opt-in.
// ★ AN ITEM WITH CHILDREN IS A DISCLOSURE BUTTON, not a link. A link that
//   opens a panel on hover and navigates on click cannot be used on a tablet,
//   where there is no hover: the first tap would leave the page. The item's own
//   href becomes "View all" inside the panel.
// ★ HOVER OPENS IT ONLY FOR A MOUSE (pointerType), with a short grace on the
//   way out so the cursor can cross the gap into the panel. Touch and pen get
//   the click, and a keyboard gets Enter, Escape and focus leaving the item.
// ★ The full-width panel is positioned against the HEADER, which is fixed and
//   so is its containing block — hence .navItem is only `position: relative`
//   for the short dropdown.
// ---------------------------------------------------------------------------

const HOVER_GRACE_MS = 150;

export function DesktopNav({ links }: { links: readonly NavLink[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const pathname = usePathname();
  const [openedAt, setOpenedAt] = useState(pathname);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const triggers = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();

  // Arriving on a new page closes the panel. Derived during render rather than
  // in an effect, which is React's pattern for resetting state on a prop.
  if (openedAt !== pathname) {
    setOpenedAt(pathname);
    if (open !== null) setOpen(null);
  }

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(null), HOVER_GRACE_MS);
  };

  useEffect(() => cancelClose, []);

  // A press anywhere outside the menu closes it.
  useEffect(() => {
    if (open === null) return;
    const onDown = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <nav className={styles.navLinks} ref={navRef} aria-label="Main">
      {links.map((link, index) => {
        const key = `${link.href}|${link.label}`;
        const kind = navPanelKind(link);
        if (kind === "none") {
          return (
            <Link key={key} href={link.href}>
              {link.label}
            </Link>
          );
        }
        const isOpen = open === index;
        const panelId = `${baseId}-panel-${index}`;
        const close = () => setOpen(null);
        return (
          <div
            key={key}
            className={`${styles.navItem}${
              kind === "dropdown" ? ` ${styles.navItemDropdown}` : ""
            }`}
            onPointerEnter={(event) => {
              if (event.pointerType !== "mouse") return;
              cancelClose();
              setOpen(index);
            }}
            onPointerLeave={(event) => {
              if (event.pointerType === "mouse" && isOpen) scheduleClose();
            }}
            onBlur={(event) => {
              // Tabbing out of the item (not into its panel) closes it.
              const next = event.relatedTarget as Node | null;
              if (isOpen && !event.currentTarget.contains(next)) close();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && isOpen) {
                event.preventDefault();
                close();
                triggers.current[index]?.focus();
              }
            }}
          >
            <button
              type="button"
              ref={(el) => {
                triggers.current[index] = el;
              }}
              className={styles.navTrigger}
              aria-expanded={isOpen}
              aria-controls={panelId}
              onClick={() => {
                cancelClose();
                setOpen(isOpen ? null : index);
              }}
            >
              {link.label}
              <ChevronDown
                size={15}
                strokeWidth={2.2}
                aria-hidden
                className={styles.navChevron}
              />
            </button>
            <div
              id={panelId}
              hidden={!isOpen}
              className={
                kind === "mega" ? styles.megaPanel : styles.dropdownPanel
              }
            >
              {kind === "mega" ? (
                <MegaPanel link={link} onNavigate={close} />
              ) : (
                <ul className={styles.dropdownList}>
                  {link.children!.map((child) => (
                    <li key={`${child.href}|${child.label}`}>
                      <Link href={child.href} onClick={close}>
                        {child.label}
                      </Link>
                    </li>
                  ))}
                  {link.href && (
                    <li className={styles.navViewAll}>
                      <Link href={link.href} onClick={close}>
                        View all {link.label}
                      </Link>
                    </li>
                  )}
                </ul>
              )}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * Columns, then the feature image. A child with its own links is a column
 * with a heading; children without are gathered into one column of plain
 * links, so a menu mixing both does not spread single links across the
 * screen as empty headings.
 */
function MegaPanel({
  link,
  onNavigate,
}: {
  link: NavLink;
  onNavigate: () => void;
}) {
  const children = link.children ?? [];
  const singles = children.filter((c) => !c.children?.length);
  const columns = children.filter((c) => c.children?.length);
  const tileHref = link.href || columns[0]?.href || singles[0]?.href || "";

  return (
    <div className={styles.megaInner}>
      <div className={styles.megaColumns}>
        {singles.length > 0 && (
          <ul className={styles.megaColumn}>
            {singles.map((child) => (
              <li key={`${child.href}|${child.label}`}>
                <Link
                  href={child.href}
                  className={styles.megaHeading}
                  onClick={onNavigate}
                >
                  {child.label}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {columns.map((column) => (
          <div
            key={`${column.href}|${column.label}`}
            className={styles.megaColumn}
          >
            {column.href ? (
              <Link
                href={column.href}
                className={styles.megaHeading}
                onClick={onNavigate}
              >
                {column.label}
              </Link>
            ) : (
              <p className={styles.megaHeading}>{column.label}</p>
            )}
            <ul>
              {column.children!.map((grand) => (
                <li key={`${grand.href}|${grand.label}`}>
                  <Link href={grand.href} onClick={onNavigate}>
                    {grand.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {link.href && (
          <Link
            href={link.href}
            className={`${styles.navViewAll} ${styles.megaViewAll}`}
            onClick={onNavigate}
          >
            View all {link.label}
          </Link>
        )}
      </div>
      {link.image_url &&
        // The caption names the link: an image link with alt="" and nothing
        // else inside it is a link a screen reader announces as nothing.
        (tileHref ? (
          <Link
            href={tileHref}
            onClick={onNavigate}
            className={styles.megaFeature}
          >
            <img src={link.image_url} alt="" loading="lazy" />
            <span className={styles.megaFeatureCaption}>{link.label}</span>
          </Link>
        ) : (
          <div className={styles.megaFeature}>
            <img src={link.image_url} alt="" loading="lazy" />
            <span className={styles.megaFeatureCaption}>{link.label}</span>
          </div>
        ))}
    </div>
  );
}
