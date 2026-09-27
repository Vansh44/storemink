"use client";

import { useState } from "react";
import { ChevronDown, GripVertical, Plus, X } from "lucide-react";
import type { ChromeLink, FooterGroup, StoreChrome } from "@/lib/chrome/types";
import { NAV_LIMITS } from "@/lib/chrome/nav";
import { ImageUpload } from "@/components/ui/image-upload";
import {
  contrastIssuesFor,
  DESIGN_FONT_NAMES,
  DESIGN_PALETTE_TOKENS,
  DESIGN_PILL_MAX,
  DESIGN_RADIUS_MAX,
  DESIGN_SHAPE_KEYS,
  type DesignFont,
  type DesignPaletteToken,
  type DesignShapeKey,
  type StorefrontDesignOverrides,
  type ThemeDesignDefaults,
} from "@/lib/chrome/design";

// ---------------------------------------------------------------------------
// Header + footer editors, inside the builder's inspector.
//
// These replace /dashboard/navigation, which was a separate dashboard page with
// a separate form and no preview: you edited your footer blind, saved, then
// navigated to the storefront to see what you'd done. Here every keystroke
// paints in the preview iframe beside it.
//
// Deliberately NOT a section canvas. The merchant controls what each block
// SAYS and whether it appears; the arrangement stays theme-controlled. A footer
// you can drag arbitrary blocks into is a footer merchants can make look
// broken, and it is the one surface that appears on every page of the store.
// ---------------------------------------------------------------------------

// A collapsible group, matching the inspector's field-group treatment so the
// chrome editor doesn't look like a different product bolted on.
function Group({
  title,
  hint,
  children,
  defaultOpen = true,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="sm-b-group">
      <button
        type="button"
        className="sm-b-group-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span>{title}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && (
        <div className="sm-b-group-body">
          {hint && <p className="sm-b-hint">{hint}</p>}
          {children}
        </div>
      )}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="sm-b-toggle">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="sm-b-toggle-label">{label}</span>
        {hint && <span className="sm-b-toggle-hint">{hint}</span>}
      </span>
    </label>
  );
}

/** One editable label→href list. Used by the header and by each footer column. */
function LinkList({
  links,
  onChange,
  addLabel = "Add link",
}: {
  links: ChromeLink[];
  onChange: (next: ChromeLink[]) => void;
  addLabel?: string;
}) {
  const set = (i: number, patch: Partial<ChromeLink>) =>
    onChange(links.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= links.length) return;
    const next = [...links];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="sm-b-linklist">
      {links.map((link, i) => (
        <div key={i} className="sm-b-linkrow">
          <span className="sm-b-linkgrip" aria-hidden>
            <GripVertical className="h-3.5 w-3.5" />
          </span>
          <div className="sm-b-linkfields">
            <input
              className="sm-b-input"
              value={link.label}
              placeholder="Label"
              onChange={(e) => set(i, { label: e.target.value })}
            />
            <input
              className="sm-b-input sm-b-input-mono"
              value={link.href}
              placeholder="/shop"
              onChange={(e) => set(i, { href: e.target.value })}
            />
          </div>
          <div className="sm-b-linkactions">
            <button
              type="button"
              onClick={() => move(i, -1)}
              disabled={i === 0}
              aria-label="Move up"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => move(i, 1)}
              disabled={i === links.length - 1}
              aria-label="Move down"
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => onChange(links.filter((_, n) => n !== i))}
              aria-label="Remove link"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        className="sm-b-addbtn"
        onClick={() => onChange([...links, { label: "", href: "" }])}
      >
        <Plus className="h-3.5 w-3.5" />
        {addLabel}
      </button>
      {links.length === 0 && (
        <p className="sm-b-hint">
          No links yet. Visitors will still reach your pages from the footer and
          from links inside your content.
        </p>
      )}
    </div>
  );
}

const NAV_LEVEL_CAP = [
  NAV_LIMITS.topLevel,
  NAV_LIMITS.children,
  NAV_LIMITS.grandchildren,
];

/**
 * The header menu: the same rows as LinkList, but each row can hold sub-links,
 * and those their own — three levels, the ceiling the storefront renders.
 *
 * ★ Only a TOP-LEVEL item with sub-links offers an image, because that is the
 *   only place one appears (the tile in the desktop panel). Offering it
 *   anywhere else would be a field that silently does nothing — the cleaner
 *   drops it on save.
 * ★ A row with sub-links may leave its link empty: it then only opens its
 *   menu. The placeholder says so, rather than letting the merchant find out
 *   that an empty leaf was dropped on save.
 */
export function NavTreeList({
  links,
  onChange,
  depth = 0,
}: {
  links: ChromeLink[];
  onChange: (next: ChromeLink[]) => void;
  depth?: number;
}) {
  const set = (i: number, patch: Partial<ChromeLink>) =>
    onChange(links.map((l, n) => (n === i ? { ...l, ...patch } : l)));

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= links.length) return;
    const next = [...links];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  // Removing the last sub-link also removes the image it was for, so the row
  // goes back to exactly the plain link it started as.
  const setChildren = (i: number, children: ChromeLink[]) =>
    onChange(
      links.map((l, n) => {
        if (n !== i) return l;
        if (children.length) return { ...l, children };
        return { label: l.label, href: l.href };
      }),
    );

  const cap = NAV_LEVEL_CAP[depth];
  const noun = depth === 0 ? "menu link" : "sub-link";

  return (
    <div className={`sm-b-linklist${depth ? " sm-b-subnav" : ""}`}>
      {links.map((link, i) => {
        const hasChildren = !!link.children?.length;
        return (
          <div key={i} className="sm-b-navnode">
            <div className="sm-b-linkrow">
              <span className="sm-b-linkgrip" aria-hidden>
                <GripVertical className="h-3.5 w-3.5" />
              </span>
              <div className="sm-b-linkfields">
                <input
                  className="sm-b-input"
                  value={link.label}
                  placeholder="Label"
                  aria-label={`${depth ? "Sub-link" : "Menu link"} ${i + 1} label`}
                  onChange={(e) => set(i, { label: e.target.value })}
                />
                <input
                  className="sm-b-input sm-b-input-mono"
                  value={link.href}
                  placeholder={hasChildren ? "Optional: /shop" : "/shop"}
                  aria-label={`${depth ? "Sub-link" : "Menu link"} ${i + 1} link`}
                  onChange={(e) => set(i, { href: e.target.value })}
                />
              </div>
              <div className="sm-b-linkactions">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === links.length - 1}
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => onChange(links.filter((_, n) => n !== i))}
                  aria-label={`Remove ${link.label || noun}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {hasChildren && (
              <NavTreeList
                links={link.children!}
                depth={depth + 1}
                onChange={(children) => setChildren(i, children)}
              />
            )}

            {depth === 0 && hasChildren && (
              <div className="sm-b-subnav sm-b-navimage">
                <span className="sm-b-hint">
                  Menu image (optional) — shown beside these links on larger
                  screens.
                </span>
                <ImageUpload
                  key={link.image_url ?? "none"}
                  folder="navigation"
                  defaultImage={link.image_url || undefined}
                  onUploadSuccess={(url) => set(i, { image_url: url })}
                />
                {link.image_url && (
                  <button
                    type="button"
                    className="sm-b-addbtn"
                    onClick={() =>
                      onChange(
                        links.map((l, n) =>
                          n === i
                            ? {
                                label: l.label,
                                href: l.href,
                                children: l.children,
                              }
                            : l,
                        ),
                      )
                    }
                  >
                    Remove image
                  </button>
                )}
              </div>
            )}

            {depth + 1 < NAV_LEVEL_CAP.length &&
              (link.children?.length ?? 0) < NAV_LEVEL_CAP[depth + 1] && (
                <button
                  type="button"
                  className="sm-b-addbtn sm-b-addsub"
                  onClick={() =>
                    set(i, {
                      children: [
                        ...(link.children ?? []),
                        { label: "", href: "" },
                      ],
                    })
                  }
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add sub-link{link.label ? ` under ${link.label}` : ""}
                </button>
              )}
          </div>
        );
      })}
      {links.length < cap && (
        <button
          type="button"
          className="sm-b-addbtn"
          onClick={() => onChange([...links, { label: "", href: "" }])}
        >
          <Plus className="h-3.5 w-3.5" />
          Add {noun}
        </button>
      )}
      {depth === 0 && links.length === 0 && (
        <p className="sm-b-hint">
          No links yet. Visitors will still reach your pages from the footer and
          from links inside your content.
        </p>
      )}
    </div>
  );
}

export function HeaderForm({
  chrome,
  onChange,
}: {
  chrome: StoreChrome;
  onChange: (next: StoreChrome) => void;
}) {
  const h = chrome.header;
  const patch = (p: Partial<typeof h>) =>
    onChange({ ...chrome, header: { ...h, ...p } });

  return (
    <>
      <Group
        title="Menu"
        hint="The links across the top of every page. Give a link sub-links to open a menu from it; give those sub-links their own to lay the menu out in columns."
      >
        <NavTreeList links={h.links} onChange={(links) => patch({ links })} />
      </Group>

      <Group title="What appears">
        <Toggle
          label="Search"
          hint="A search box in the header."
          checked={h.showSearch}
          onChange={(showSearch) => patch({ showSearch })}
        />
        <Toggle
          label="Account"
          hint="Sign in and order history."
          checked={h.showAccount}
          onChange={(showAccount) => patch({ showAccount })}
        />
        <Toggle
          label="Cart"
          hint="Turn off for a catalogue-only store that takes enquiries instead of orders."
          checked={h.showCart}
          onChange={(showCart) => patch({ showCart })}
        />
        <Toggle
          label="Stay visible when scrolling"
          checked={h.sticky}
          onChange={(sticky) => patch({ sticky })}
        />
      </Group>

      <Group title="Logo" defaultOpen={false}>
        <p className="sm-b-hint">
          Your logo and store name come from your brand, so they stay the same
          everywhere — invoices and emails included.{" "}
          <a href="/dashboard/branding" target="_blank" rel="noopener">
            Edit branding
          </a>
        </p>
      </Group>
    </>
  );
}

export function FooterForm({
  chrome,
  onChange,
}: {
  chrome: StoreChrome;
  onChange: (next: StoreChrome) => void;
}) {
  const f = chrome.footer;
  const patch = (p: Partial<typeof f>) =>
    onChange({ ...chrome, footer: { ...f, ...p } });

  const setGroup = (i: number, next: Partial<FooterGroup>) =>
    patch({
      groups: f.groups.map((g, n) => (n === i ? { ...g, ...next } : g)),
    });

  return (
    <>
      <Group
        title="Link columns"
        hint="Each column becomes one list in the footer."
      >
        {f.groups.map((group, i) => (
          <div key={i} className="sm-b-column">
            <div className="sm-b-column-head">
              <input
                className="sm-b-input sm-b-input-strong"
                value={group.title}
                placeholder="Column title"
                onChange={(e) => setGroup(i, { title: e.target.value })}
              />
              <button
                type="button"
                onClick={() =>
                  patch({ groups: f.groups.filter((_, n) => n !== i) })
                }
                aria-label="Remove column"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <LinkList
              links={group.links}
              onChange={(links) => setGroup(i, { links })}
            />
          </div>
        ))}
        {f.groups.length < 6 && (
          <button
            type="button"
            className="sm-b-addbtn"
            onClick={() =>
              patch({ groups: [...f.groups, { title: "", links: [] }] })
            }
          >
            <Plus className="h-3.5 w-3.5" />
            Add column
          </button>
        )}
      </Group>

      <Group title="Newsletter" defaultOpen={false}>
        <Toggle
          label="Show the sign-up bar"
          checked={f.newsletter.enabled}
          onChange={(enabled) =>
            patch({ newsletter: { ...f.newsletter, enabled } })
          }
        />
        {f.newsletter.enabled && (
          <>
            <label className="sm-b-field">
              <span>Heading</span>
              <input
                className="sm-b-input"
                value={f.newsletter.heading}
                onChange={(e) =>
                  patch({
                    newsletter: { ...f.newsletter, heading: e.target.value },
                  })
                }
              />
            </label>
            <label className="sm-b-field">
              <span>Subtext</span>
              <input
                className="sm-b-input"
                value={f.newsletter.subtext}
                onChange={(e) =>
                  patch({
                    newsletter: { ...f.newsletter, subtext: e.target.value },
                  })
                }
              />
            </label>
            <label className="sm-b-field">
              <span>Button</span>
              <input
                className="sm-b-input"
                value={f.newsletter.buttonLabel}
                onChange={(e) =>
                  patch({
                    newsletter: {
                      ...f.newsletter,
                      buttonLabel: e.target.value,
                    },
                  })
                }
              />
            </label>
            <label className="sm-b-field">
              <span>Consent text</span>
              <input
                className="sm-b-input"
                value={f.newsletter.consentText}
                onChange={(e) =>
                  patch({
                    newsletter: {
                      ...f.newsletter,
                      consentText: e.target.value,
                    },
                  })
                }
              />
            </label>
          </>
        )}
      </Group>

      <Group title="Blocks" defaultOpen={false}>
        <Toggle
          label="Contact details"
          hint="Email, phone and hours from your branding."
          checked={f.contact.enabled}
          onChange={(enabled) => patch({ contact: { enabled } })}
        />
        <Toggle
          label="Social links"
          hint="Only the profiles you've set in branding appear."
          checked={f.social.enabled}
          onChange={(enabled) => patch({ social: { enabled } })}
        />
        <Toggle
          label="Trust badges"
          checked={f.badges.enabled}
          onChange={(enabled) => patch({ badges: { enabled } })}
        />
      </Group>

      <Group
        title="Legal row"
        defaultOpen={false}
        hint="The small print along the very bottom."
      >
        <LinkList
          links={f.legal}
          onChange={(legal) => patch({ legal })}
          addLabel="Add legal link"
        />
      </Group>
    </>
  );
}

const PALETTE_LABELS: Record<DesignPaletteToken, string> = {
  cream: "Page background",
  creamDeep: "Alternate background",
  surface: "Cards and inputs",
  ink: "Headings and body text",
  inkSoft: "Muted text",
  inkFaint: "Faint text",
  border: "Hairlines and borders",
  accent: "Accent",
};

const FONT_LABELS: Record<DesignFont, string> = {
  inter: "Inter",
  fraunces: "Fraunces",
  spaceGrotesk: "Space Grotesk",
  jakarta: "Plus Jakarta Sans",
  jost: "Jost",
  instrumentSerif: "Instrument Serif",
  outfit: "Outfit",
  roboto: "Roboto",
  stickNoBills: "Stick No Bills",
};

const SHAPE_LABELS: Record<DesignShapeKey, string> = {
  card: "Cards",
  control: "Buttons and inputs",
  sm: "Small controls",
  pill: "Pills and chips",
};

/**
 * Palette, type and corners — the store's own skin over its theme.
 *
 * ★ EVERY CONTROL HAS AN EXPLICIT "USE THEME" STATE, and an unset one shows
 * the value the storefront will really use rather than an empty box. Without
 * that a merchant cannot tell "I have not chosen" from "I chose this exact
 * colour", and cannot get back to the theme once they have nudged a picker —
 * a colour input has no null.
 */
function DesignForm({
  design,
  themeDefaults,
  onChange,
}: {
  design: StorefrontDesignOverrides;
  themeDefaults: ThemeDesignDefaults;
  onChange: (next: StorefrontDesignOverrides) => void;
}) {
  const setPalette = (token: DesignPaletteToken, value: string | null) => {
    const palette = { ...design.palette };
    if (value === null) delete palette[token];
    else palette[token] = value;
    onChange({ ...design, palette });
  };
  const setShape = (key: DesignShapeKey, value: number | null) => {
    const shape = { ...design.shape };
    if (value === null) delete shape[key];
    else shape[key] = value;
    onChange({ ...design, shape });
  };

  // Judged on the RESOLVED pair, so changing the page background flags body
  // text inherited from the theme that was never touched here. Shown while
  // editing rather than only on Publish, where it would be a dead end.
  const issues = contrastIssuesFor(design, themeDefaults);

  return (
    <>
      <Group
        title="Colours"
        hint="Leave a colour on its theme value, or set your own. Publishes with the website."
      >
        {DESIGN_PALETTE_TOKENS.map((token) => {
          const overridden = design.palette[token];
          const themeValue = themeDefaults.palette[token] ?? "#ffffff";
          return (
            <div className="sm-b-field" key={token}>
              <span>{PALETTE_LABELS[token]}</span>
              <div className="sm-b-colorrow">
                <input
                  type="color"
                  className="sm-b-color"
                  value={overridden ?? themeValue}
                  onChange={(e) => setPalette(token, e.target.value)}
                  aria-label={PALETTE_LABELS[token]}
                />
                <input
                  className="sm-b-input sm-b-input-mono"
                  value={overridden ?? ""}
                  placeholder={`Theme ${themeValue}`}
                  onChange={(e) =>
                    setPalette(token, e.target.value.trim() || null)
                  }
                  aria-label={`${PALETTE_LABELS[token]} hex`}
                />
                {overridden ? (
                  <button
                    type="button"
                    className="sm-b-reset"
                    onClick={() => setPalette(token, null)}
                    title="Use the theme colour"
                  >
                    Reset
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        {issues.length > 0 ? (
          <p className="sm-b-warn" role="status">
            {issues.join(" ")} You can keep editing, but this cannot be
            published until it is readable.
          </p>
        ) : null}
      </Group>

      <Group title="Type" defaultOpen={false}>
        {(["body", "display"] as const).map((slot) => (
          <label className="sm-b-field" key={slot}>
            <span>{slot === "body" ? "Body text" : "Headings"}</span>
            <select
              className="sm-b-input"
              value={design.fonts[slot] ?? "theme"}
              onChange={(e) =>
                onChange({
                  ...design,
                  fonts: {
                    ...design.fonts,
                    [slot]:
                      e.target.value === "theme"
                        ? null
                        : (e.target.value as DesignFont),
                  },
                })
              }
            >
              <option value="theme">Theme default</option>
              {DESIGN_FONT_NAMES.map((font) => (
                <option key={font} value={font}>
                  {FONT_LABELS[font]}
                </option>
              ))}
            </select>
          </label>
        ))}
      </Group>

      <Group title="Corners" defaultOpen={false}>
        {DESIGN_SHAPE_KEYS.map((key) => {
          const overridden = design.shape[key];
          const themeValue = themeDefaults.shape[key] ?? 0;
          const max = key === "pill" ? DESIGN_PILL_MAX : DESIGN_RADIUS_MAX;
          return (
            <div className="sm-b-field" key={key}>
              <span>{SHAPE_LABELS[key]}</span>
              <div className="sm-b-colorrow">
                <input
                  type="range"
                  min={0}
                  max={max}
                  value={overridden ?? themeValue}
                  onChange={(e) => setShape(key, Number(e.target.value))}
                  aria-label={SHAPE_LABELS[key]}
                />
                <span className="sm-b-hint">
                  {overridden !== undefined
                    ? `${overridden}px`
                    : `Theme ${themeValue}px`}
                </span>
                {overridden !== undefined ? (
                  <button
                    type="button"
                    className="sm-b-reset"
                    onClick={() => setShape(key, null)}
                    title="Use the theme radius"
                  >
                    Reset
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </Group>
    </>
  );
}

export interface BrandAppearance {
  name: string;
  primaryColor: string;
  logoUrl: string | null;
}

/**
 * Brand — the third global "section".
 *
 * Deliberately narrow: the colour and logo that decide how the WEBSITE looks.
 * Contact details, social profiles and the legal name stay in
 * /dashboard/branding because they are store identity — they print on invoices
 * and go out in email, so they are not a website decision and should not be
 * edited from a screen whose Publish button is about the website.
 */
export function BrandForm({
  brand,
  onChange,
  chrome,
  onChromeChange,
  themeDefaults,
}: {
  brand: BrandAppearance;
  onChange: (next: BrandAppearance) => void;
  chrome: StoreChrome;
  onChromeChange: (next: StoreChrome) => void;
  themeDefaults: ThemeDesignDefaults;
}) {
  const appearance = chrome.appearance;
  const patchAppearance = (patch: Partial<typeof appearance>) =>
    onChromeChange({
      ...chrome,
      appearance: { ...appearance, ...patch },
    });

  return (
    <>
      <Group title="Colour" hint="Used for buttons, links and accents.">
        <div className="sm-b-colorrow">
          <input
            type="color"
            className="sm-b-color"
            value={brand.primaryColor}
            onChange={(e) =>
              onChange({ ...brand, primaryColor: e.target.value })
            }
            aria-label="Primary colour"
          />
          <input
            className="sm-b-input sm-b-input-mono"
            value={brand.primaryColor}
            onChange={(e) =>
              onChange({ ...brand, primaryColor: e.target.value })
            }
            aria-label="Primary colour hex"
          />
        </div>
      </Group>

      <DesignForm
        design={chrome.design}
        themeDefaults={themeDefaults}
        onChange={(design) => onChromeChange({ ...chrome, design })}
      />

      <Group
        title="Storefront layout"
        hint="Use the theme default, or override individual surfaces. Changes publish with the website."
      >
        <label className="sm-b-field">
          <span>Header</span>
          <select
            className="sm-b-input"
            value={appearance.header}
            onChange={(e) =>
              patchAppearance({
                header: e.target.value as typeof appearance.header,
              })
            }
          >
            <option value="theme">Theme default</option>
            <option value="classic">Classic left logo</option>
            <option value="market">Market search bar</option>
            <option value="centered">Centered logo</option>
            <option value="minimal">Minimal</option>
          </select>
        </label>
        <label className="sm-b-field">
          <span>Product cards</span>
          <select
            className="sm-b-input"
            value={appearance.card}
            onChange={(e) =>
              patchAppearance({
                card: e.target.value as typeof appearance.card,
              })
            }
          >
            <option value="theme">Theme default</option>
            <option value="classic">Classic</option>
            <option value="quick_add">Classic with quick add</option>
            <option value="overlay">Editorial overlay</option>
            <option value="framed">Framed</option>
            <option value="grocery">Grocery</option>
          </select>
        </label>
        <label className="sm-b-field">
          <span>Product page</span>
          <select
            className="sm-b-input"
            value={appearance.productDetail}
            onChange={(e) =>
              patchAppearance({
                productDetail: e.target
                  .value as typeof appearance.productDetail,
              })
            }
          >
            <option value="theme">Theme default</option>
            <option value="classic">Classic</option>
            <option value="editorial">Editorial</option>
            <option value="grocery">Grocery</option>
          </select>
        </label>
        <label className="sm-b-field">
          <span>Cart</span>
          <select
            className="sm-b-input"
            value={appearance.cart}
            onChange={(e) =>
              patchAppearance({
                cart: e.target.value as typeof appearance.cart,
              })
            }
          >
            <option value="theme">Theme default</option>
            <option value="classic">Classic</option>
            <option value="compact">Compact</option>
            <option value="grocery">Grocery</option>
          </select>
        </label>
        <label className="sm-b-field">
          <span>Footer</span>
          <select
            className="sm-b-input"
            value={appearance.footer}
            onChange={(e) =>
              patchAppearance({
                footer: e.target.value as typeof appearance.footer,
              })
            }
          >
            <option value="theme">Theme default</option>
            <option value="rich">Rich columns</option>
            <option value="editorial">Editorial</option>
            <option value="minimal">Minimal</option>
          </select>
        </label>
      </Group>

      <Group title="Logo" defaultOpen={false}>
        <label className="sm-b-field">
          <span>Image URL</span>
          <input
            className="sm-b-input sm-b-input-mono"
            value={brand.logoUrl ?? ""}
            placeholder="https://…"
            onChange={(e) =>
              onChange({ ...brand, logoUrl: e.target.value || null })
            }
          />
        </label>
        <p className="sm-b-hint">
          Leave empty to show your store name as text. Upload images in the{" "}
          <a href="/dashboard/media" target="_blank" rel="noopener">
            media library
          </a>
          .
        </p>
      </Group>

      <Group title="Everything else" defaultOpen={false}>
        <p className="sm-b-hint">
          Your store name, contact details, social profiles and legal name are
          store identity — they also appear on invoices and in email, so they
          live in{" "}
          <a href="/dashboard/branding" target="_blank" rel="noopener">
            branding
          </a>
          .
        </p>
      </Group>
    </>
  );
}
