"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Link from "next/link";
import Script from "next/script";
import { usePathname } from "next/navigation";

const CONSENT_KEY = "sm.storefront-tracking-consent.v1";
const CONSENT_EVENT = "sm:storefront-tracking-consent-change";

interface TrackingConsent {
  version: 1;
  analytics: boolean;
  marketing: boolean;
  decidedAt: string;
}

export type StorefrontEventType =
  | "page_view"
  | "product_view"
  | "add_to_cart"
  | "checkout_start";

type TrackStorefrontEvent = (
  type: StorefrontEventType,
  details?: { productId?: string },
) => void;

const TrackingContext = createContext<TrackStorefrontEvent>(() => {});

export function useStorefrontTracking(): TrackStorefrontEvent {
  return useContext(TrackingContext);
}

declare global {
  interface Window {
    dataLayer?: unknown[][];
    gtag?: (...args: unknown[]) => void;
    fbq?: ((...args: unknown[]) => void) & {
      callMethod?: (...args: unknown[]) => void;
      queue?: unknown[][];
      loaded?: boolean;
      version?: string;
      push?: (...args: unknown[]) => void;
    };
    _fbq?: Window["fbq"];
  }
}

function parseConsent(
  serialized: string | null | undefined,
): TrackingConsent | null {
  try {
    const parsed = JSON.parse(
      serialized ?? "null",
    ) as Partial<TrackingConsent> | null;
    if (
      parsed?.version !== 1 ||
      typeof parsed.analytics !== "boolean" ||
      typeof parsed.marketing !== "boolean"
    ) {
      return null;
    }
    return {
      version: 1,
      analytics: parsed.analytics,
      marketing: parsed.marketing,
      decidedAt:
        typeof parsed.decidedAt === "string" ? parsed.decidedAt : "unknown",
    };
  } catch {
    return null;
  }
}

function readConsentSnapshot(): string | null {
  try {
    return localStorage.getItem(CONSENT_KEY);
  } catch {
    return null;
  }
}

function subscribeToConsent(onStoreChange: () => void) {
  function handleStorage(event: StorageEvent) {
    if (event.key === CONSENT_KEY) onStoreChange();
  }

  window.addEventListener("storage", handleStorage);
  window.addEventListener(CONSENT_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(CONSENT_EVENT, onStoreChange);
  };
}

export function MerchantTracking({
  storeName,
  ga4MeasurementId,
  metaPixelId,
  firstPartyEnabled,
  children,
}: {
  storeName: string;
  ga4MeasurementId: string | null;
  metaPixelId: string | null;
  firstPartyEnabled: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const savedConsent = useSyncExternalStore<string | null | undefined>(
    subscribeToConsent,
    readConsentSnapshot,
    () => undefined,
  );
  const [sessionConsent, setSessionConsent] = useState<TrackingConsent | null>(
    null,
  );
  const consent = sessionConsent ?? parseConsent(savedConsent);
  const hasConsent = consent !== null;
  const analyticsConsent = consent?.analytics ?? false;
  const marketingConsent = consent?.marketing ?? false;
  const [managing, setManaging] = useState(false);
  const [analyticsChoice, setAnalyticsChoice] = useState(false);
  const [marketingChoice, setMarketingChoice] = useState(false);
  const [gaReady, setGaReady] = useState(false);
  const [metaReady, setMetaReady] = useState(false);
  const lastFirstPartyPath = useRef<string | null>(null);

  // A consent decision made in another tab is authoritative. Provider scripts
  // may already have populated globals even after React removes their tags, so
  // actively send the matching revoke/grant command on every consent change.
  useEffect(() => {
    if (!hasConsent) return;
    window.gtag?.("consent", "update", {
      analytics_storage: analyticsConsent ? "granted" : "denied",
    });
    window.fbq?.("consent", marketingConsent ? "grant" : "revoke");
  }, [analyticsConsent, hasConsent, marketingConsent]);

  // sessionConsent exists only for browsers that reject localStorage writes.
  // If a real cross-tab storage event later arrives, stop shadowing that
  // persisted choice with the page-local fallback.
  useEffect(() => {
    const clearFallback = (event: StorageEvent) => {
      if (event.key === CONSENT_KEY) setSessionConsent(null);
    };
    window.addEventListener("storage", clearFallback);
    return () => window.removeEventListener("storage", clearFallback);
  }, []);

  const track = useCallback<TrackStorefrontEvent>(
    (type, details) => {
      if (!firstPartyEnabled || !consent?.analytics) return;
      const payload = JSON.stringify({
        eventId: crypto.randomUUID(),
        type,
        path: window.location.pathname,
        ...(details?.productId ? { productId: details.productId } : {}),
      });
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(
            "/api/t",
            new Blob([payload], { type: "application/json" }),
          );
          return;
        }
      } catch {
        // Fall through to keepalive fetch. Collection must never interrupt a
        // shopper action if the browser blocks either transport.
      }
      void fetch("/api/t", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    },
    [consent?.analytics, firstPartyEnabled],
  );

  useEffect(() => {
    if (!firstPartyEnabled || !consent?.analytics) return;
    if (lastFirstPartyPath.current === pathname) return;
    lastFirstPartyPath.current = pathname;
    track("page_view");
    if (/^\/shop\/[^/]+$/.test(pathname)) track("product_view");
    if (pathname === "/checkout") track("checkout_start");
  }, [consent?.analytics, firstPartyEnabled, pathname, track]);

  useEffect(() => {
    if (!gaReady || !ga4MeasurementId || !consent?.analytics) return;
    window.gtag?.("event", "page_view", {
      page_path: pathname,
      page_location: window.location.href,
      page_title: document.title,
    });
  }, [consent?.analytics, ga4MeasurementId, gaReady, pathname]);

  useEffect(() => {
    if (!metaReady || !metaPixelId || !consent?.marketing) return;
    window.fbq?.("track", "PageView");
  }, [consent?.marketing, metaPixelId, metaReady, pathname]);

  function saveChoice(analytics: boolean, marketing: boolean) {
    const next: TrackingConsent = {
      version: 1,
      analytics: Boolean(ga4MeasurementId || firstPartyEnabled) && analytics,
      marketing: Boolean(metaPixelId) && marketing,
      decidedAt: new Date().toISOString(),
    };
    try {
      localStorage.setItem(CONSENT_KEY, JSON.stringify(next));
      // A successful persisted choice must remain governed by the external
      // store so a later storage event can revoke it.
      setSessionConsent(null);
      window.dispatchEvent(new Event(CONSENT_EVENT));
    } catch {
      // Privacy-safe failure: the state applies for this page, but a browser
      // that blocks storage is asked again next time rather than assumed opted in.
      setSessionConsent(next);
    }
    setAnalyticsChoice(next.analytics);
    setMarketingChoice(next.marketing);
    setManaging(false);
  }

  const gaAllowed = Boolean(ga4MeasurementId && consent?.analytics);
  const metaAllowed = Boolean(metaPixelId && consent?.marketing);
  const showDialog = consent === null || managing;
  const hasOptionalTracking = Boolean(
    firstPartyEnabled || ga4MeasurementId || metaPixelId,
  );

  function beginManaging() {
    setAnalyticsChoice(consent?.analytics ?? false);
    setMarketingChoice(consent?.marketing ?? false);
    setManaging(true);
  }

  return (
    <TrackingContext.Provider value={track}>
      {children}
      {gaAllowed && ga4MeasurementId ? (
        <>
          <Script
            id={`sm-ga4-init-${ga4MeasurementId}`}
            strategy="afterInteractive"
            onReady={() => setGaReady(true)}
          >{`
window.dataLayer = window.dataLayer || [];
window.gtag = window.gtag || function(){window.dataLayer.push(arguments);};
window.gtag('consent', 'default', {
  analytics_storage: 'granted',
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied'
});
window.gtag('js', new Date());
window.gtag('config', '${ga4MeasurementId}', { send_page_view: false });
`}</Script>
          <Script
            id={`sm-ga4-library-${ga4MeasurementId}`}
            src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ga4MeasurementId)}`}
            strategy="afterInteractive"
          />
        </>
      ) : null}

      {metaAllowed && metaPixelId ? (
        <Script
          id={`sm-meta-pixel-${metaPixelId}`}
          strategy="afterInteractive"
          onReady={() => setMetaReady(true)}
        >{`
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
window.fbq('init', '${metaPixelId}');
`}</Script>
      ) : null}

      {hasOptionalTracking && showDialog ? (
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="sm-privacy-title"
          className="fixed inset-x-3 bottom-3 z-[100] mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white p-5 text-slate-950 shadow-2xl sm:inset-x-6"
        >
          <h2 id="sm-privacy-title" className="text-base font-semibold">
            Your privacy choices
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            {storeName} uses optional analytics and marketing tools only with
            your permission. You can shop normally if you reject them. Read the{" "}
            <Link href="/privacy-policy" className="font-semibold underline">
              privacy policy
            </Link>
            .
          </p>

          {managing ? (
            <div className="mt-4 space-y-3 border-y border-slate-100 py-4">
              {ga4MeasurementId || firstPartyEnabled ? (
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-slate-950"
                    checked={analyticsChoice}
                    onChange={(event) =>
                      setAnalyticsChoice(event.target.checked)
                    }
                  />
                  <span>
                    <strong className="block">Analytics</strong>
                    <span className="text-slate-600">
                      Allow{" "}
                      {firstPartyEnabled ? "StoreMink" : "Google Analytics"} to
                      measure visits and shopping steps
                      {ga4MeasurementId && firstPartyEnabled
                        ? ", and send analytics to Google Analytics"
                        : ""}
                      .
                    </span>
                  </span>
                </label>
              ) : null}
              {metaPixelId ? (
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 accent-slate-950"
                    checked={marketingChoice}
                    onChange={(event) =>
                      setMarketingChoice(event.target.checked)
                    }
                  />
                  <span>
                    <strong className="block">Marketing</strong>
                    <span className="text-slate-600">
                      Allow Meta Pixel for advertising measurement and
                      audiences.
                    </span>
                  </span>
                </label>
              ) : null}
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold"
              onClick={() => saveChoice(false, false)}
            >
              Reject optional
            </button>
            {managing ? (
              <button
                type="button"
                className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
                onClick={() => saveChoice(analyticsChoice, marketingChoice)}
              >
                Save choices
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold"
                  onClick={beginManaging}
                >
                  Manage choices
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
                  onClick={() => saveChoice(true, true)}
                >
                  Accept all
                </button>
              </>
            )}
          </div>
        </section>
      ) : hasOptionalTracking && consent ? (
        <button
          type="button"
          data-sm-privacy-pill=""
          className="fixed bottom-3 right-3 z-[70] rounded-full border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-md"
          onClick={beginManaging}
        >
          Privacy choices
        </button>
      ) : null}
    </TrackingContext.Provider>
  );
}
