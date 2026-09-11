"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { DEFAULT_CHROME, type StoreChrome } from "@/lib/chrome/types";
import { resolveStorefrontAppearance } from "@/lib/chrome/types";
import type { ThemeLayout } from "@/lib/themes/types";
import {
  DESIGN_FONT_NAMES,
  DESIGN_PALETTE_TOKENS,
  DESIGN_SHAPE_KEYS,
  designOverrideCssVars,
  type StorefrontDesignOverrides,
} from "@/lib/chrome/design";

/** Every token the design layer can write, used to work out which inline
 *  properties this component owns — and therefore which to put back. */
const ALL_DESIGN_TOKENS: StorefrontDesignOverrides = {
  palette: Object.fromEntries(DESIGN_PALETTE_TOKENS.map((t) => [t, "#000000"])),
  fonts: { body: DESIGN_FONT_NAMES[0], display: DESIGN_FONT_NAMES[0] },
  shape: Object.fromEntries(DESIGN_SHAPE_KEYS.map((k) => [k, 0])),
};

const ChromeContext = createContext<StoreChrome | null>(null);

/**
 * The current store's header + footer configuration.
 *
 * Supersedes MenuProvider, which carried only the link lists. The chrome now
 * also decides whether the search box, cart, newsletter, contact strip, social
 * row and badges render at all, so Header and Footer read this one object
 * instead of reaching into three different sources.
 *
 * In the builder's preview iframe it also listens for `sm-chrome` postMessages
 * so header/footer edits paint instantly, the same way DraftCanvas handles
 * page sections. Without that, editing the header would need a full iframe
 * reload per keystroke and the builder would feel broken next to the rest of
 * its own UI.
 */
export function ChromeProvider({
  chrome,
  themeLayout,
  themeVars,
  live = false,
  children,
}: {
  chrome: StoreChrome;
  themeLayout?: ThemeLayout;
  /** The pinned theme's own CSS variables, so clearing an override can put the
   *  theme value back rather than falling through to the globals.css default. */
  themeVars?: Record<string, string>;
  /** Preview mode: accept live updates from the builder. */
  live?: boolean;
  children: React.ReactNode;
}) {
  const [value, setValue] = useState<StoreChrome>(chrome);
  // The brand colour as last pushed by the builder, if at all — see the design
  // effect below for why it has to be remembered rather than re-read.
  const livePrimary = useRef<string | null>(null);

  useEffect(() => {
    if (!live) return;
    const appearance = resolveStorefrontAppearance(
      themeLayout,
      value.appearance,
    );
    const root = document.querySelector<HTMLElement>(".storefront-root");
    if (!root) return;
    for (const prefix of [
      "sm-header-",
      "sm-card-",
      "sm-pdp-",
      "sm-cart-",
      "sm-footer-",
    ]) {
      for (const cls of Array.from(root.classList)) {
        if (cls.startsWith(prefix)) root.classList.remove(cls);
      }
    }
    root.classList.remove("sm-card-quickadd", "sm-storefront-grocery");
    root.classList.add(
      `sm-header-${appearance.header}`,
      `sm-card-${appearance.card}`,
      `sm-pdp-${appearance.productDetail}`,
      `sm-cart-${appearance.cart}`,
      `sm-footer-${appearance.footer}`,
    );
    if (appearance.cardQuickAdd) root.classList.add("sm-card-quickadd");
    if (
      appearance.card === "grocery" ||
      appearance.productDetail === "grocery" ||
      appearance.cart === "grocery"
    ) {
      root.classList.add("sm-storefront-grocery");
    }
  }, [live, themeLayout, value.appearance]);

  // The merchant's palette, type and corners, repainted as they edit.
  //
  // ★ IT RESTORES, IT DOES NOT ONLY SET. Clearing an override has to put the
  // theme's value back; simply stopping writing the property would leave the
  // last override stuck (the layout wrote it inline server-side), so "Reset"
  // would look broken. `managed` is the full token namespace precisely so a
  // cleared token is still visited.
  useEffect(() => {
    if (!live) return;
    const root = document.querySelector<HTMLElement>(".storefront-root");
    if (!root) return;
    const overrides = designOverrideCssVars(value.design);
    const managed = designOverrideCssVars(ALL_DESIGN_TOKENS);
    for (const key of Object.keys(managed)) {
      if (overrides[key] !== undefined) {
        root.style.setProperty(key, overrides[key]);
        continue;
      }
      // ★★ --brand-primary IS SHARED with the `sm-brand` message below, which
      // the builder sends on every brand-colour keystroke. Restoring it from
      // the server-rendered theme value would silently undo a colour the
      // merchant had just picked, so the live value wins when there is no
      // accent override.
      const fallback =
        key === "--brand-primary" && livePrimary.current
          ? livePrimary.current
          : themeVars?.[key];
      if (fallback) root.style.setProperty(key, fallback);
      else root.style.removeProperty(key);
    }
  }, [live, themeVars, value.design]);

  // Adopt server-rendered chrome when it changes (navigation, or a
  // router.refresh after publish) — otherwise the preview keeps rendering a
  // stale copy. Adjusted DURING RENDER rather than in an effect: React handles
  // this case specially (it re-renders immediately without committing the
  // discarded output), whereas a setState in an effect paints the stale value
  // first. Same pattern as inspector-panel's tab reset.
  const [prevChrome, setPrevChrome] = useState(chrome);
  if (chrome !== prevChrome) {
    setPrevChrome(chrome);
    setValue(chrome);
  }

  useEffect(() => {
    if (!live) return;
    const onMessage = (e: MessageEvent) => {
      // Same-origin only. The preview iframe is served from the store's own
      // host, so anything from elsewhere is not the builder.
      if (e.origin !== window.location.origin) return;
      const data = e.data as {
        type?: string;
        chrome?: StoreChrome;
        brand?: { primaryColor?: string; logoUrl?: string | null };
      } | null;
      if (data?.type === "sm-chrome" && data.chrome) setValue(data.chrome);
      // Brand colour is a CSS variable written inline on .storefront-root by
      // the layout, so a live change is one setProperty — no re-render, and
      // the whole theme skin (buttons, links, accents) repaints with it.
      if (data?.type === "sm-brand" && data.brand?.primaryColor) {
        const root = document.querySelector<HTMLElement>(".storefront-root");
        // Remembered so a later design edit restores THIS, not the value the
        // server rendered before the merchant touched the picker.
        livePrimary.current = data.brand.primaryColor;
        root?.style.setProperty("--brand-primary", data.brand.primaryColor);
      }
    };
    window.addEventListener("message", onMessage);
    // Tell the builder we're ready for draft pushes — it may have mounted
    // first and sent its state before this listener existed.
    window.parent?.postMessage(
      { type: "sm-chrome-ready" },
      window.location.origin,
    );
    return () => window.removeEventListener("message", onMessage);
  }, [live]);

  return (
    <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>
  );
}

/** Falls back to the defaults outside a provider, so no consumer can crash. */
export function useChrome(): StoreChrome {
  return useContext(ChromeContext) ?? DEFAULT_CHROME;
}
