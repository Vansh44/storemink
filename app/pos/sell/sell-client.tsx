"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useRouter } from "next/navigation";
import {
  Loader2,
  Search,
  Trash2,
  Plus,
  Minus,
  X,
  Camera,
  Package,
  Database,
  LayoutGrid,
  ShoppingCart,
  ChevronRight,
} from "lucide-react";
import {
  confirmPosGatewayPayment,
  lookupProducts,
  placePosSale,
  createPosCheckoutCustomer,
  resolvePosCustomerByPhone,
  startPosGatewayPayment,
  verifyManagerPin,
  type PosCatalogItem,
  type PosCustomer,
  type PosTender,
  type RegisterConfig,
} from "@/app/actions/pos-sale-actions";
import { openRazorpayModal } from "@/lib/payments/razorpay-client";
// posLock/endSession moved to the rail (app/pos/pos-nav.tsx) — locking is the
// same act on every screen, and it was hand-rolled identically in two places.
import { isCameraScanSupported } from "@/lib/pos/barcode-camera";
import {
  createKeyboardWedge,
  isEditableTarget,
  isTouchPrimary,
  subscribeTouchPrimary,
} from "@/lib/pos/keyboard-wedge";
import { useCatalog } from "@/lib/pos/use-catalog";
import {
  applyLayout,
  isOutOfStock,
  itemKey,
  layoutCoverage,
  type LayoutEntry,
} from "@/lib/pos/catalog-index";
import {
  groupForGrid,
  groupPriceLabel,
  type GridEntry,
} from "@/lib/pos/catalog-groups";
import {
  getPosLayout,
  resetPosLayout,
  savePosLayout,
} from "@/app/actions/pos-layout-actions";
import { LayoutEditMode } from "./layout-editor";
import { TenderPanel } from "./tender-panel";
import { ParkedPanel } from "./parked-panel";
import {
  listParkedSales,
  parkSale,
  type ParkedSale,
} from "@/app/actions/pos-park-actions";
import { ReceiptOverlay } from "./receipt-overlay";
import { CameraScanner } from "./camera-scanner";
import { posTotals } from "@/lib/pos/totals";
import { applyOffers } from "@/lib/offers/apply";
import type { PosExchangeContext } from "@/app/actions/pos-return-actions";
import { cartLineFrom, type CartLine } from "@/lib/pos/cart-line";
import {
  clearPosCart,
  parseStoredPosCart,
  readPosCartRaw,
  restoreCartLines,
  serializePosCart,
  writePosCart,
  type StoredPosCart,
} from "@/lib/pos/cart-storage";

// Re-exported from its own module now: `cartLineFrom` is the single builder, so
// the resume and restore paths cannot omit a field the way an `as CartLine`
// cast let them (see lib/pos/cart-line.ts).
export type { CartLine };

const lineKey = (p: string, v: string | null) => `${p}:${v ?? ""}`;

/** Camera support is fixed for the life of the page — nothing to subscribe to. */
const subscribeNever = () => () => {};

export function shouldRefocusPosSearch(input: {
  reportedTouchPrimary: boolean;
  liveTouchPrimary: boolean;
  overlayOpen: boolean;
}) {
  return (
    !input.reportedTouchPrimary && !input.liveTouchPrimary && !input.overlayOpen
  );
}

/**
 * Which overlays must swallow a hardware scan — and it is not all of them.
 *
 * ★★ THE VARIANT PICKER LETS A SCAN THROUGH, deliberately. Every other overlay
 * owns a decision a stray burst of digits would corrupt: an amount being
 * tendered, a barcode two SKUs share, a layout being edited. The picker is the
 * one case where a scan is the cashier taking a FASTER route to the same end —
 * they have the item in hand, so reading its barcode settles the variant
 * better than tapping does. Swallowing it would leave the digits going nowhere
 * on the one screen whose entire purpose is choosing a SKU.
 *
 * Pure and exported for the same reason `shouldRefocusPosSearch` is: the rule
 * is a single boolean that is easy to get wrong and impossible to see in a
 * rendered DOM.
 */
export function shouldBlockPosScan(input: {
  tendering: boolean;
  disambiguating: boolean;
  cameraOpen: boolean;
  layoutOpen: boolean;
  receiptOpen: boolean;
  variantPickerOpen: boolean;
}): boolean {
  return (
    input.tendering ||
    input.disambiguating ||
    input.cameraOpen ||
    input.layoutOpen ||
    input.receiptOpen
  );
}

/** ₹ for the grid and the picker — the cart has its own formatting. */
const money = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** A search result is already an exact SKU, so it becomes a tile as-is. */
const skuEntry = (item: PosCatalogItem): GridEntry => ({
  kind: "sku",
  key: `s:${item.productId}:${item.variantId ?? ""}`,
  item,
});

export function SellClient({
  config,
  initialItems,
  exchange,
  exchangeError,
}: {
  config: RegisterConfig;
  initialItems: PosCatalogItem[];
  exchange?: PosExchangeContext | null;
  exchangeError?: string | null;
}) {
  const router = useRouter();
  // The local catalog: IndexedDB-backed, background-synced, seeded with the
  // server-rendered first page so the grid is populated before it warms up.
  const catalog = useCatalog(config.storeId, config.locationId, initialItems);
  // Grid contents from the SERVER fallback only. Once the cache is warm the
  // grid is derived from (query, index) during render — see `items` below.
  const [serverItems, setServerItems] =
    useState<PosCatalogItem[]>(initialItems);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  // A phone cannot show a useful product grid beside a 360px cart. Below the
  // desktop split breakpoint the register therefore becomes two explicit
  // panes. Adding products leaves the catalogue in place for fast multi-item
  // ringing; the cart count and total make the next step visible without
  // squeezing either pane into an unusable strip.
  const [mobilePane, setMobilePane] = useState<"products" | "cart">("products");
  const [discount, setDiscount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tendering, setTendering] = useState(false);
  const [saleId, setSaleId] = useState<string | null>(null);
  // Disambiguation when one barcode maps to several variants.
  const [choices, setChoices] = useState<PosCatalogItem[] | null>(null);
  // The variant picker. Kept SEPARATE from `choices` above, which disambiguates
  // a barcode two SKUs share: that one is a mistake to resolve, this one is a
  // choice to make, and they want different copy.
  const [variantsFor, setVariantsFor] = useState<Extract<
    GridEntry,
    { kind: "group" }
  > | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  // Customer is resolved once, by exact mobile, after Charge is selected.
  const [exchangeActive, setExchangeActive] =
    useState<PosExchangeContext | null>(exchange ?? null);
  // Offers this customer has already used up, learned from the phone lookup at
  // Charge. Empty until somebody is identified — a register opens with nobody
  // attached, so a per-customer cap cannot be known before then.
  const [exhaustedOfferIds, setExhaustedOfferIds] = useState<string[]>([]);
  // `null` until a customer is identified: nobody attached means no history to
  // check, which the engine treats as not-first.
  const [isFirstOrder, setIsFirstOrder] = useState<boolean | null>(null);
  const [customer, setCustomer] = useState<PosCustomer | null>(
    exchange?.customer ?? null,
  );
  const [gstin, setGstin] = useState("");
  const [receiptEmail, setReceiptEmail] = useState("");
  const [parked, setParked] = useState<ParkedSale[]>([]);
  const [parkedOpen, setParkedOpen] = useState(false);
  const [parking, setParking] = useState(false);
  const [parkLabel, setParkLabel] = useState("");

  const refreshParked = useCallback(async () => {
    const res = await listParkedSales();
    if (!res.error) setParked(res.sales);
  }, []);

  // ★ Loaded once on mount, not polled. A held cart is created BY this till or
  // by a colleague at the same counter, and both paths refresh explicitly —
  // polling the list would be a query every few seconds on the one screen whose
  // whole design goal is to open without waiting on the network.
  useEffect(() => {
    void refreshParked();
  }, [refreshParked]);

  // --- surviving a refresh (lib/pos/cart-storage.ts) ---------------------
  // The basket lives in this tab's sessionStorage as CHOICES, so a reload —
  // an F5, a stray kiosk gesture, the browser reclaiming a backgrounded tab —
  // no longer makes the cashier re-scan everything with the customer waiting.
  // Hold (park) remains the deliberate, durable, cross-till version.
  const [pendingRestore, setPendingRestore] = useState<StoredPosCart | null>(
    null,
  );
  // A ref, not state: it gates the WRITE below, and flipping it must not
  // itself trigger a save. `true` means "the restore question is answered" —
  // by restoring, by finding nothing, or by the cashier starting a new basket
  // first — and only then may this screen write over what is stored.
  const restoreSettled = useRef(false);
  const cartCount = cart.length;

  // Read once, before anything can be added. Declared ABOVE the writer so it
  // runs first in the mount commit: the writer would otherwise see an empty
  // cart and clear the very basket this is about to restore.
  useEffect(() => {
    if (restoreSettled.current) return;
    const stored = parseStoredPosCart(
      readPosCartRaw(config.storeId, config.locationId),
      {
        now: Date.now(),
        // The PROP, not `exchangeActive`: at mount they are the same value,
        // and the server is the authority on which return a refreshed
        // exchange is settling. A stored basket from a different context (or
        // from none) is discarded rather than tendered as an unrelated sale.
        exchangeReturnId: exchange?.returnId ?? null,
      },
    );
    if (!stored) {
      restoreSettled.current = true;
      return;
    }
    setPendingRestore(stored);
  }, [config.storeId, config.locationId, exchange?.returnId]);

  // Restore only once the catalogue can price it. `ready` means an index
  // exists — from the IndexedDB cache or a completed sync — so a miss at that
  // point is a genuine "not in the catalogue" rather than a cold cache, which
  // would drop lines that do exist and say so untruthfully.
  useEffect(() => {
    if (!pendingRestore || restoreSettled.current || !catalog.ready) return;

    // The cashier started ringing up before the catalogue warmed. Their live
    // basket wins outright: replacing it with an older stored one is the
    // wrong-basket-at-the-counter failure this feature must never cause.
    if (cartCount > 0) {
      restoreSettled.current = true;
      setPendingRestore(null);
      return;
    }

    const { lines, dropped } = restoreCartLines(pendingRestore, catalog.byId);
    restoreSettled.current = true;
    setPendingRestore(null);
    if (lines.length === 0) {
      clearPosCart(config.storeId, config.locationId);
      // "held" is Hold's word, and the two must stay distinguishable.
      setError(
        "The products from the sale in progress are no longer in the catalogue, so the register opened empty.",
      );
      return;
    }
    setCart(lines);
    setDiscount(pendingRestore.discount);
    setGstin(pendingRestore.gstin);
    // Said out loud, for the parked-resume reason: a basket that comes back
    // smaller without a word is how a customer is charged for less than they
    // picked up.
    if (dropped > 0) {
      setError(
        `${dropped} item${dropped === 1 ? " is" : "s are"} no longer in the catalogue and couldn't be restored.`,
      );
    }
  }, [
    pendingRestore,
    cartCount,
    catalog.ready,
    catalog.byId,
    config.storeId,
    config.locationId,
  ]);

  // One writer for every path that changes the basket — adding, removing,
  // re-quantifying, discounting, holding, completing, voiding. Clearing the
  // cart writes nothing and REMOVES the key, so a finished or held sale leaves
  // nothing behind to restore; there is no per-call-site "remember to save".
  useEffect(() => {
    if (!restoreSettled.current) return;
    if (cart.length === 0) {
      clearPosCart(config.storeId, config.locationId);
      return;
    }
    writePosCart(
      config.storeId,
      config.locationId,
      serializePosCart({
        lines: cart,
        discount,
        gstin,
        exchangeReturnId: exchangeActive?.returnId ?? null,
        now: Date.now(),
      }),
    );
  }, [
    cart,
    discount,
    gstin,
    exchangeActive,
    config.storeId,
    config.locationId,
  ]);
  // Manager-arranged till grid. Empty = not configured = show everything.
  const [layout, setLayout] = useState<LayoutEntry[]>([]);
  const [canEditLayout, setCanEditLayout] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [savingLayout, setSavingLayout] = useState(false);
  // Feature-detected on the CLIENT only — the server can't know whether this
  // browser can scan, and rendering a button that does nothing is worse than
  // hiding it. useSyncExternalStore (rather than an effect) gives the server a
  // `false` snapshot, so hydration matches and no cascading render occurs;
  // the capability never changes, hence the no-op subscribe.
  const cameraSupported = useSyncExternalStore(
    subscribeNever,
    isCameraScanSupported,
    () => false,
  );

  // Load the till arrangement once. A failure is non-fatal: getPosLayout
  // returns an empty layout, and the register shows the whole catalogue rather
  // than an empty grid.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getPosLayout();
      if (cancelled) return;
      setLayout(res.items);
      setCanEditLayout(res.canEdit);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A hardware scanner is a keyboard: it "types" the barcode then hits Enter.
  // Keeping this input focused means a scan lands in the cart with no clicks —
  // the single biggest factor in per-sale time.
  //
  // ★ BUT ONLY WHERE THERE IS A REAL KEYBOARD. On a touch-primary device the
  // same trick is the thing cashiers complain about: every tap on a product
  // blurs the box, focus is taken straight back, and iPadOS answers a
  // programmatic focus by opening the software keyboard over half the till. Tap
  // a product, get a keyboard. So sticky focus is switched off there and the
  // wedge below carries the scanner instead — a tablet does not lose scanning,
  // it stops being interrupted.
  const touchPrimary = useSyncExternalStore(
    subscribeTouchPrimary,
    isTouchPrimary,
    () => false,
  );
  const scanRef = useRef<HTMLInputElement>(null);
  // Every overlay is listed: each one owns an input of its own (tender amount,
  // customer mobile) and pulling focus out from under it 80 ms later would make
  // that field impossible to type in.
  const overlayOpen =
    tendering ||
    !!choices ||
    !!variantsFor ||
    cameraOpen ||
    layoutOpen ||
    !!saleId;
  /**
   * Overlays that must swallow a scan, which is NOT all of them.
   *
   * ★ THE VARIANT PICKER LETS A SCAN THROUGH, deliberately. Every other
   * overlay owns a decision the scan would corrupt — an amount being tendered,
   * a barcode two SKUs share. The picker is the one case where a scan is the
   * cashier choosing a FASTER route to the same end: they have the item in
   * hand, so reading its barcode settles the variant better than tapping does.
   * Swallowing it would leave the digits going nowhere on the screen whose
   * whole purpose is picking a SKU.
   */
  const scanBlocked = shouldBlockPosScan({
    tendering,
    disambiguating: !!choices,
    cameraOpen,
    layoutOpen,
    receiptOpen: !!saleId,
    variantPickerOpen: !!variantsFor,
  });
  const refocus = useCallback(() => {
    // During hydration useSyncExternalStore briefly exposes its server
    // snapshot (`false`). Re-check the live media query before focusing, or a
    // phone can receive one desktop-style focus and open its keyboard before
    // React publishes the touch-primary snapshot.
    if (
      !shouldRefocusPosSearch({
        reportedTouchPrimary: touchPrimary,
        liveTouchPrimary: isTouchPrimary(),
        overlayOpen,
      })
    ) {
      return;
    }
    scanRef.current?.focus({ preventScroll: true });
  }, [touchPrimary, overlayOpen]);
  useEffect(() => {
    refocus();
  }, [refocus, cart.length]);

  const addItem = useCallback((it: PosCatalogItem) => {
    const label = it.variantName ? `${it.name} (${it.variantName})` : it.name;
    // Clamp to stock at THIS location unless the SKU is untracked or
    // backorderable. The server re-checks; this only avoids ringing up what
    // can't be sold. Every rejection MUST say why — silently doing nothing
    // after a scan looks like the scanner is broken.
    const cap =
      it.trackInventory && !it.allowBackorder ? (it.stock ?? 0) : Infinity;
    if (cap < 1) {
      setError(`${label} is out of stock at this location.`);
      return;
    }
    setError(null);
    setCart((c) => {
      const key = lineKey(it.productId, it.variantId);
      const found = c.find((l) => l.key === key);
      if (found) {
        if (found.quantity + 1 > cap) {
          setError(`Only ${cap} of ${label} left at this location.`);
          return c;
        }
        return c.map((l) =>
          l.key === key ? { ...l, quantity: l.quantity + 1 } : l,
        );
      }
      return [...c, cartLineFrom(it, { quantity: 1 })];
    });
  }, []);

  /** One scanned/typed code resolved to zero, one, or several SKUs. */
  const resolveScan = useCallback(
    (found: PosCatalogItem[]): boolean => {
      if (found.length === 1) {
        addItem(found[0]);
        setQuery("");
        return true;
      }
      if (found.length > 1) {
        // Several SKUs share this code — make the cashier pick rather than
        // guessing (mislabelled supplier barcodes are common).
        setChoices(found);
        setQuery("");
        return true;
      }
      return false;
    },
    [addItem],
  );

  // Enter (or a hardware scanner's trailing Enter) = a scan.
  const runScan = useCallback(
    async (code: string) => {
      setError(null);
      // A scan settles the variant question outright, so the picker steps
      // aside rather than sitting over the cart the scan just changed.
      setVariantsFor(null);
      // Local first: this is the path that makes a scan land in the cart in
      // <50 ms with no network at all.
      if (catalog.ready && resolveScan(catalog.scan(code))) return;

      // A local MISS is not an answer — the product may have been created
      // since the last sync. Ask the server before telling the cashier no.
      setSearching(true);
      const res = await lookupProducts(code);
      setSearching(false);
      if (res.error) {
        setError(res.error);
        return;
      }
      if (!resolveScan(res.items)) setError(`Nothing found for "${code}".`);
    },
    [catalog, resolveScan],
  );

  // The scan path that needs NO focused input. On a desktop this never fires —
  // the search box holds focus, so `isEditableTarget` sends every key to it and
  // behaviour is exactly as before. On a tablet it is the whole scanner story:
  // the cashier taps products with their finger, focus lives wherever the last
  // tap left it, and a scan still drops into the cart.
  //
  // Swallowing the burst matters as much as reading it. After a tap the product
  // tile is the focused element, and both Space and Enter activate a focused
  // button — so an unhandled scan would ring up the tapped product a second
  // time instead of the scanned one.
  // Escape closes the variant picker. The other overlays predate this and
  // each has its own close control; adding it here would change their
  // behaviour, so this is scoped to the one screen it was added with.
  useEffect(() => {
    if (!variantsFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setVariantsFor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variantsFor]);

  useEffect(() => {
    const wedge = createKeyboardWedge();
    const onKey = (e: KeyboardEvent) => {
      if (scanBlocked) return;
      // A shortcut or a paste is not a scan.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      const res = wedge.handleKey(e.key, e.timeStamp);
      if (res.type === "ignored") return;
      e.preventDefault();
      if (res.type === "scan") void runScan(res.code);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scanBlocked, runScan]);

  // Browse-as-you-type. Against the local index the grid is DERIVED, not
  // stored: recomputing during render costs ~1 ms at a few thousand SKUs and
  // removes any chance of the grid disagreeing with the index. catalog.version
  // is the dependency that picks up a sync or a post-sale stock decrement.
  const trimmedQuery = query.trim();
  const items = useMemo(() => {
    // Searching ALWAYS spans the whole catalogue. The layout decides what the
    // IDLE grid shows; it must never decide what can be found and sold, or the
    // products a manager left off the till could never be rung up at all.
    if (trimmedQuery) {
      if (catalog.ready) return catalog.search(trimmedQuery);
      // The server path has no index to order it, so apply the same rule here —
      // otherwise the grid would reshuffle the moment the cache warms up.
      return [
        ...serverItems.filter((i) => !isOutOfStock(i)),
        ...serverItems.filter(isOutOfStock),
      ];
    }
    return applyLayout(catalog.ready ? catalog.all() : serverItems, layout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    catalog.ready,
    catalog.version,
    catalog.search,
    catalog.all,
    trimmedQuery,
    serverItems,
    layout,
  ]);

  /**
   * The tiles the idle grid shows.
   *
   * ★★ GROUPED ONLY WHEN IDLE. A search result and a scan both already resolve
   * an exact SKU, and putting a variant picker in front of a typed "black
   * medium" or a scanned barcode would add a tap to the two fastest paths in
   * the shop. `trimmedQuery` is therefore the switch, not a setting.
   */
  const entries = useMemo(
    () => (trimmedQuery ? items.map(skuEntry) : groupForGrid(items)),
    [items, trimmedQuery],
  );

  const coverage = useMemo(
    () => layoutCoverage(catalog.ready ? catalog.all() : serverItems, layout),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog.ready, catalog.version, catalog.all, serverItems, layout],
  );

  // The server path exists only until the cache warms up (and on a device
  // where IndexedDB is unavailable, where it stays the permanent path).
  useEffect(() => {
    if (catalog.ready) return;
    const t = setTimeout(
      async () => {
        setSearching(true);
        const res = await lookupProducts(trimmedQuery);
        setSearching(false);
        if (res.error) setError(res.error);
        else setServerItems(res.items);
      },
      trimmedQuery ? 220 : 150,
    );
    return () => clearTimeout(t);
  }, [trimmedQuery, catalog.ready]);

  const setLineDiscount = (key: string, value: number) =>
    setCart((c) =>
      c.map((l) =>
        l.key === key
          ? // Never let a markdown exceed the line — the server caps it too,
            // but a negative line total on screen is just wrong.
            {
              ...l,
              lineDiscount: Math.min(
                Math.max(0, value),
                l.unitPrice * l.quantity,
              ),
            }
          : l,
      ),
    );

  const setQty = (key: string, delta: number) =>
    setCart((c) =>
      c.flatMap((l) => {
        if (l.key !== key) return [l];
        const cap =
          l.trackInventory && !l.allowBackorder ? (l.stock ?? 0) : Infinity;
        const next = Math.min(l.quantity + delta, cap);
        return next <= 0 ? [] : [{ ...l, quantity: next }];
      }),
    );

  // A product with no class of its own falls back to the store default —
  // mirroring how placePosSale resolves the rate.
  const rateForClass = (id: string | null) => {
    const cls = id ?? config.defaultTaxClassId;
    return cls ? (config.taxRates[cls] ?? 0) : 0;
  };

  // Offers, priced with the SAME pure engine `placePosSale` charges with, over
  // the offer list shipped in RegisterConfig. The server re-resolves
  // authoritatively — this is the quote, so it must agree with the charge.
  //
  // ★ `exhaustedOfferIds` COMES FROM THE CUSTOMER LOOKUP. A register opens with
  // nobody attached, so per-customer caps cannot be resolved then; the moment a
  // customer is identified at Charge, the ids they have used up arrive with
  // their record and the quote re-prices. Without it the screen would quote an
  // offer the server then refuses, in front of the customer.
  const offerQuote = useMemo(() => {
    if (cart.length === 0) return null;
    return applyOffers({
      lines: cart.map((l) => ({
        id: l.key,
        productId: l.productId,
        variantId: l.variantId,
        categoryId: l.categoryId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineDiscount: l.lineDiscount,
      })),
      offers: config.offers.map((o) =>
        exhaustedOfferIds.includes(o.id) ? { ...o, exhausted: true } : o,
      ),
      context: {
        channel: "pos",
        locationId: config.locationId,
        customerId: customer?.id ?? null,
        groupIds: [],
        now: new Date(),
        code: null,
        // ★ FROM THE CUSTOMER LOOKUP, like `exhaustedOfferIds`. Without it the
        // screen would quote a total without the new-customer discount while
        // `placePosSale` charges with it — and `lib/pos/totals.ts` exists so
        // the screen and the sale agree on ONE total (CODEBASE §22), which a
        // favourable-to-the-customer divergence still breaks.
        // ★ GATED ON A CUSTOMER ACTUALLY BEING ATTACHED. Detaching one leaves
        // this state behind (as it does `exhaustedOfferIds`), and a stale
        // `true` with nobody attached would quote a new-customer discount the
        // server then refuses — the total would go UP at completion, which is
        // the one direction of divergence that is indefensible in front of a
        // customer. `placePosSale` resolves from the attached customer, so
        // mirroring that here keeps the quote and the charge identical.
        isFirstOrder: customer ? (isFirstOrder ?? null) : null,
        // `timeZone` arrives inside offerPolicy, so a time-window offer is
        // quoted against the STORE's clock rather than this till's.
        ...config.offerPolicy,
      },
    });
  }, [
    cart,
    config.offers,
    config.offerPolicy,
    config.locationId,
    customer,
    exhaustedOfferIds,
    isFirstOrder,
  ]);

  const offerByLine = useMemo(() => {
    const map = new Map<string, number>();
    for (const line of offerQuote?.lines ?? []) {
      map.set(line.id, line.offerDiscount);
    }
    return map;
  }, [offerQuote]);

  // The SAME pure helper placePosSale charges with — including tax. Quoting the
  // pre-tax subtotal here (as this screen used to) meant the cashier promised
  // the customer one number and the till charged another, so the change handed
  // back was wrong by exactly the tax.
  const totals = posTotals({
    lines: cart.map((l) => ({
      gross: l.unitPrice * l.quantity,
      lineDiscount: l.lineDiscount,
      offerDiscount: offerByLine.get(l.key) ?? 0,
      rate: rateForClass(l.taxClassId),
    })),
    requestedOrderDiscount: discount,
    pricesIncludeTax: config.pricesIncludeTax,
    taxEnabled: config.taxEnabled,
  });
  // The gift's name, resolved from the local catalogue by id. Falls back to
  // the offer's own name rather than an id, so a cashier is never shown a UUID.
  const giftLabel = useMemo(() => {
    const g = offerQuote?.gift;
    if (!g) return "";
    // `byId` already exists for exactly this: resolving ids to a cached SKU,
    // which is what resuming a held sale does.
    const match = catalog.byId(g.productId, g.variantId);
    return match?.name ?? `the gift from “${g.offerName}”`;
  }, [offerQuote?.gift, catalog]);

  const { subtotal, lineDiscountTotal, offerDiscountTotal, tax } = totals;
  const cappedDiscount = totals.orderDiscount;
  const estTotal = totals.total;
  const cartQuantity = cart.reduce((sum, line) => sum + line.quantity, 0);

  // ONE description of the cart, used both to ask a manager to approve and to
  // ring the sale. They must be byte-identical: the approval token is bound to
  // a fingerprint of exactly these fields, so building them twice is how an
  // approval would mysteriously stop fitting the sale it was given for.
  const saleLines = () =>
    cart.map((l) => ({
      productId: l.productId,
      variantId: l.variantId,
      quantity: l.quantity,
      lineDiscount: l.lineDiscount || undefined,
    }));

  // ★ A PARK MOVES NOTHING — no money, no stock, no order. It stores the
  // choices so far, which is what makes it safe to abandon.
  const handlePark = async () => {
    if (cart.length === 0) return;
    setParking(true);
    const res = await parkSale({
      label: parkLabel.trim() || null,
      lines: saleLines(),
      orderDiscount: cappedDiscount,
      customerId: customer?.id ?? null,
      customerGstin: gstin.trim() || null,
    });
    setParking(false);
    if (res.error) {
      setError(res.error);
      return;
    }

    // Cleared exactly like a completed sale: the counter is now free for the
    // next customer, which is the entire point of holding one.
    setCart([]);
    setDiscount(0);
    setCustomer(null);
    setGstin("");
    setReceiptEmail("");
    setParkLabel("");
    setError(null);
    setMobilePane("products");
    void refreshParked();
  };

  /**
   * Take one leg of the sale through the store's own gateway (Step 12).
   *
   * Three server round trips, and the middle one is the customer's: open an
   * order for the amount, let them pay, then ask the SERVER whether the money
   * landed. The modal's success callback is an input to that question, never
   * the answer — §34 states the same rule for every on-session payment.
   *
   * ★ THE PAYMENT ID COMES BACK FROM THE SERVER, not from the callback we were
   * handed. Identical today, but it means the tender the panel stages is the
   * one the server verified, and a future change to how confirmation resolves
   * cannot silently leave the client staging something else.
   */
  const takeOnlinePayment = async (
    amount: number,
  ): Promise<{ reference?: string; error?: string }> => {
    if (!config.onlinePayments || !config.gatewayKeyId) {
      return { error: "Online payments aren't switched on for this store." };
    }
    const amountPaise = Math.round(amount * 100);
    // The cart goes with it so the server can check the shelf BEFORE the
    // customer pays — see startPosGatewayPayment. Refusing here is free;
    // refusing after capture needs a dashboard refund.
    const started = await startPosGatewayPayment(amountPaise, saleLines());
    if ("error" in started) return { error: started.error };

    const outcome = await new Promise<{ reference?: string; error?: string }>(
      (resolve) => {
        void openRazorpayModal({
          keyId: started.keyId,
          rzpOrderId: started.rzpOrderId,
          amountPaise: started.amountPaise,
          name: config.storeName,
          description: `${config.locationName} · counter`,
          onSuccess: (r) => {
            void confirmPosGatewayPayment({
              rzpOrderId: r.razorpay_order_id,
              paymentId: r.razorpay_payment_id,
              signature: r.razorpay_signature,
              amountPaise: started.amountPaise,
            }).then((res) =>
              resolve(
                "error" in res
                  ? { error: res.error }
                  : { reference: res.paymentId },
              ),
            );
          },
          // Cancelling is ordinary at a counter — the customer changes their
          // mind, or the card is declined. Nothing has been staged, so the rest
          // of the sale is untouched and they can pay another way.
          onDismiss: () => resolve({ error: "Payment cancelled." }),
        }).then((opened) => {
          if (!opened) {
            resolve({
              error: "Couldn't open the payment window. Check the connection.",
            });
          }
        });
      },
    );
    return outcome;
  };

  const completeSale = async (
    tenders: PosTender[],
    approvalToken?: string,
  ): Promise<{ error?: string; needsApproval?: boolean }> => {
    const res = await placePosSale(saleLines(), tenders, {
      orderDiscount: cappedDiscount,
      approvalToken,
      customerId: customer?.id ?? null,
      customerGstin: gstin.trim() || null,
      receiptEmail: receiptEmail.trim() || null,
      exchangeReturnId: exchangeActive?.returnId ?? null,
    });
    if (res.error) {
      return { error: res.error, needsApproval: res.needsApproval };
    }
    // Reflect the sale in the local catalog at once — the next scan of the
    // same SKU shows the new on-hand without waiting for the 5-min sync.
    catalog.applySold(new Map(cart.map((l) => [itemKey(l), l.quantity])));
    setCart([]);
    setDiscount(0);
    setCustomer(null);
    setGstin("");
    // Cleared with everything else: the next customer is a different person,
    // and a receipt address left in the box would email them somebody else's.
    setReceiptEmail("");
    setTendering(false);
    setSaleId(res.orderId ?? null);
    setMobilePane("products");
    if (exchangeActive) {
      setExchangeActive(null);
      router.replace("/pos/sell", { scroll: false });
    } else {
      router.refresh();
    }
    return {};
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* The idle lock is mounted once in app/pos/layout.tsx, so it covers every
          POS screen rather than the two that remembered to ask for it. The
          exemption rule (superadmin only) moved there with it.

          ★ THIS HEADER CARRIES ONLY WHAT BELONGS TO THE REGISTER. It used to
          hold ten things: four links to other screens, the location, the
          operator, Lock, and these three. Below `sm` every label was hidden, so
          it degraded into a row of anonymous icons — which is what made the
          till confusing to look at. Navigation, location, operator and Lock all
          live in the rail now (app/pos/pos-nav.tsx), where they are the same on
          every screen; what is left is the state of THIS screen. */}
      <header className="flex h-12 shrink-0 items-center justify-end gap-2 border-b border-[var(--pos-border)] px-2 text-sm lg:h-11 lg:gap-3 lg:px-3">
        {/* Phones and portrait tablets get one full-width working pane at a
            time. Keeping this switch in the register header makes both panes
            reachable even when the cart or catalogue itself is scrolled. */}
        <div
          className="flex min-w-0 flex-1 rounded-xl bg-[var(--pos-surface-2)] p-1 lg:hidden"
          role="group"
          aria-label="Register view"
        >
          <button
            type="button"
            aria-pressed={mobilePane === "products"}
            onClick={() => setMobilePane("products")}
            className={`min-w-0 flex-1 rounded-lg px-3 py-1.5 font-medium transition-colors ${
              mobilePane === "products"
                ? "bg-[var(--pos-surface)] text-[var(--pos-ink)] shadow-sm"
                : "text-[var(--pos-ink-2)]"
            }`}
          >
            Products
          </button>
          <button
            type="button"
            aria-pressed={mobilePane === "cart"}
            aria-label={`Cart, ${
              cartQuantity === 0
                ? "empty"
                : `${cartQuantity} ${cartQuantity === 1 ? "item" : "items"}`
            }`}
            disabled={layoutOpen}
            onClick={() => setMobilePane("cart")}
            className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 font-medium transition-colors disabled:opacity-40 ${
              mobilePane === "cart"
                ? "bg-[var(--pos-surface)] text-[var(--pos-ink)] shadow-sm"
                : "text-[var(--pos-ink-2)]"
            }`}
          >
            <ShoppingCart className="h-4 w-4" strokeWidth={2} />
            Cart
            {cartQuantity > 0 && (
              <span
                aria-hidden="true"
                className="rounded-full bg-[var(--pos-accent)] px-1.5 text-[11px] font-bold leading-5 text-[var(--pos-on-accent)]"
              >
                {cartQuantity}
              </span>
            )}
          </button>
        </div>

        {/* Cache state, deliberately quiet. A cashier only needs it when
            something looks wrong — hence the click-to-refresh. */}
        <button
          type="button"
          onClick={catalog.resync}
          disabled={catalog.syncing}
          title={
            catalog.ready
              ? `${catalog.count} products cached on this device. Click to refresh.`
              : "Loading the catalog…"
          }
          className="hidden items-center gap-1.5 rounded-lg px-2 py-1 text-[var(--pos-ink-3)] transition-colors hover:bg-[var(--pos-surface-2)] hover:text-[var(--pos-ink-2)] disabled:opacity-60 lg:inline-flex"
        >
          {catalog.syncing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Database className="h-3.5 w-3.5" strokeWidth={2} />
          )}
          {catalog.ready ? catalog.count : "…"}
        </button>
        {/* "12 of 20" — a manager can see at a glance that eight products
            are reachable only by search or scan. Hidden until configured,
            since "20 of 20" is noise. */}
        {coverage.configured && (
          <span className="hidden text-[var(--pos-ink-3)] lg:inline">
            {coverage.shown} of {coverage.total} products
          </span>
        )}
        {canEditLayout && (
          <button
            type="button"
            onClick={() => {
              setMobilePane("products");
              setLayoutOpen(true);
            }}
            aria-label="Edit product layout"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--pos-surface-2)] font-medium transition-colors hover:bg-[var(--pos-surface-3)] lg:h-auto lg:w-auto lg:gap-1.5 lg:rounded-lg lg:px-3 lg:py-1.5"
          >
            <LayoutGrid className="h-4 w-4" strokeWidth={2} />
            <span className="hidden lg:inline">Edit layout</span>
          </button>
        )}
      </header>

      {(exchangeActive || exchangeError) && (
        <div
          className={`shrink-0 border-b px-4 py-2.5 text-sm ${
            exchangeActive
              ? "border-[var(--pos-ok-border)] bg-[var(--pos-ok-soft)] text-[var(--pos-ok)]"
              : "border-[var(--pos-danger-border)] bg-[var(--pos-danger-soft)] text-[var(--pos-danger)]"
          }`}
        >
          {exchangeActive
            ? `Exchange for ${exchangeActive.originalLabel}: ${exchangeActive.customer.name} is attached. Add the replacement, then settle its total.`
            : exchangeError}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Catalog */}
        <div
          className={`${
            mobilePane === "products" ? "flex" : "hidden"
          } min-w-0 flex-1 flex-col p-3 lg:flex`}
        >
          {layoutOpen ? (
            <LayoutEditMode
              catalog={catalog.ready ? catalog.all() : serverItems}
              initial={layout}
              saving={savingLayout}
              onClose={() => setLayoutOpen(false)}
              onSave={async (next) => {
                setSavingLayout(true);
                const res = await savePosLayout(next);
                setSavingLayout(false);
                if (res.error) {
                  setError(res.error);
                  return;
                }
                setLayout(next);
                setLayoutOpen(false);
              }}
              onReset={async () => {
                setSavingLayout(true);
                const res = await resetPosLayout();
                setSavingLayout(false);
                if (res.error) {
                  setError(res.error);
                  return;
                }
                setLayout([]);
                setLayoutOpen(false);
              }}
            />
          ) : (
            <>
              <div className="mb-3 flex min-w-0 shrink-0 gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--pos-ink-3)]" />
                  <input
                    ref={scanRef}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setError(null);
                    }}
                    // No autoFocus: on a tablet it opens the software keyboard
                    // the moment the register loads. The mount pass of the
                    // effect above focuses it where sticky focus applies.
                    onBlur={() => setTimeout(refocus, 80)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && query.trim()) {
                        e.preventDefault();
                        void runScan(query.trim());
                      }
                    }}
                    placeholder="Scan a barcode or search products…"
                    className="min-w-0 w-full rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] py-3 pl-9 pr-3 text-base outline-none placeholder:text-[var(--pos-ink-3)] focus:border-[var(--pos-border-strong)] sm:text-sm"
                  />
                  {searching && (
                    <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--pos-ink-3)]" />
                  )}
                </div>
                {/* Only rendered where the browser can actually scan — a dead
                button is worse than none. */}
                {cameraSupported && (
                  <button
                    type="button"
                    onClick={() => setCameraOpen(true)}
                    title="Scan with the camera"
                    className="flex shrink-0 items-center gap-2 rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] px-4 text-sm font-medium transition-colors hover:bg-[var(--pos-surface-2)]"
                  >
                    <Camera className="h-5 w-5" strokeWidth={2} />
                    <span className="hidden sm:inline">Scan</span>
                  </button>
                )}
              </div>

              {error && (
                <div className="mb-3 shrink-0 rounded-lg bg-[var(--pos-danger-soft)] px-3 py-2 text-sm text-[var(--pos-danger)]">
                  {error}
                </div>
              )}

              <div className="pos-scroll-area grid min-h-0 flex-1 auto-rows-max grid-cols-2 gap-2 overflow-y-auto overscroll-contain sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                {entries.map((entry) => {
                  const grouped = entry.kind === "group";
                  const it = grouped ? entry.variants[0] : entry.item;
                  const out = grouped ? entry.soldOut : isOutOfStock(it);
                  const name = grouped ? entry.name : it.name;
                  const image = grouped ? entry.image : it.image;
                  const stock = grouped ? entry.stock : it.stock;
                  const tracked = grouped
                    ? entry.stock !== null
                    : it.trackInventory;
                  const price = grouped
                    ? groupPriceLabel(entry, money)
                    : money(it.price);
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      disabled={out}
                      // One tap for a product that has nothing to choose;
                      // a picker only where there is a choice to make.
                      onClick={() =>
                        grouped ? setVariantsFor(entry) : addItem(it)
                      }
                      className="flex flex-col rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-2 text-left transition-colors hover:bg-[var(--pos-surface-2)] disabled:opacity-40"
                    >
                      {/* Photos make the grid scannable by eye for items without a
                      barcode (loose produce, bakery). A FIXED short height, not
                      aspect-square: on a wide till screen a square tile grew to
                      ~350px and pushed the price below the fold, so the cashier
                      scrolled to find what should be one tap away. */}
                      <div className="mb-2 h-24 w-full overflow-hidden rounded-lg bg-[var(--pos-surface)] sm:h-28">
                        {image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={image}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-[var(--pos-ink-3)]">
                            <Package className="h-8 w-8" strokeWidth={1.5} />
                          </div>
                        )}
                      </div>
                      <span className="line-clamp-2 text-sm font-medium">
                        {name}
                      </span>
                      {grouped ? (
                        <span className="text-xs text-[var(--pos-ink-2)]">
                          {entry.variants.length} options
                        </span>
                      ) : (
                        it.variantName && (
                          <span className="text-xs text-[var(--pos-ink-2)]">
                            {it.variantName}
                          </span>
                        )
                      )}
                      <span className="mt-auto pt-2 font-semibold">
                        {price}
                      </span>
                      <span className="text-[11px] text-[var(--pos-ink-3)]">
                        {out
                          ? "Out of stock"
                          : tracked
                            ? `${stock} in stock`
                            : ""}
                      </span>
                    </button>
                  );
                })}
                {entries.length === 0 && !searching && (
                  <p className="col-span-full py-10 text-center text-sm text-[var(--pos-ink-3)]">
                    No products match.
                  </p>
                )}
              </div>

              {cartQuantity > 0 && (
                <button
                  type="button"
                  onClick={() => setMobilePane("cart")}
                  className="mt-3 flex w-full shrink-0 items-center justify-between rounded-xl bg-[var(--pos-accent)] px-4 py-3 font-semibold text-[var(--pos-on-accent)] lg:hidden"
                  aria-label={`View cart, ${cartQuantity} ${
                    cartQuantity === 1 ? "item" : "items"
                  }, total ₹${estTotal.toLocaleString("en-IN")}`}
                >
                  <span className="flex items-center gap-2">
                    <ShoppingCart className="h-5 w-5" strokeWidth={2} />
                    View cart · {cartQuantity}
                  </span>
                  <span>₹{estTotal.toLocaleString("en-IN")}</span>
                </button>
              )}
            </>
          )}
        </div>

        {/* Cart */}
        <aside
          className={`${
            mobilePane === "cart" ? "flex" : "hidden"
          } min-w-0 flex-1 flex-col bg-[var(--pos-surface)] lg:flex lg:w-[360px] lg:flex-none lg:border-l lg:border-[var(--pos-border)]`}
        >
          <div className="pos-scroll-area min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
            {cart.length === 0 ? (
              <div className="py-16 text-center text-sm text-[var(--pos-ink-3)]">
                {/* ★ SAY THE BASKET IS COMING BACK. After a reload the cart
                    paints empty for as long as the catalogue takes to warm,
                    and "Scan a product to start a sale" on a till that is
                    about to refill itself reads as the items being lost —
                    which is the very thing being fixed. */}
                <p>
                  {pendingRestore
                    ? "Restoring the sale in progress…"
                    : "Scan or tap a product to start a sale."}
                </p>
                {!pendingRestore && (
                  <button
                    type="button"
                    onClick={() => setMobilePane("products")}
                    className="mt-4 rounded-xl bg-[var(--pos-surface-2)] px-4 py-2.5 font-medium text-[var(--pos-ink)] lg:hidden"
                  >
                    Browse products
                  </button>
                )}
              </div>
            ) : (
              cart.map((l) => (
                <div
                  key={l.key}
                  className="mb-2 rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-[var(--pos-surface-2)]">
                      {l.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={l.image}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-[var(--pos-ink-3)]">
                          <Package className="h-5 w-5" strokeWidth={1.5} />
                        </div>
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {l.name}
                      </div>
                      {l.variantName && (
                        <div className="text-xs text-[var(--pos-ink-2)]">
                          {l.variantName}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setCart((c) => c.filter((x) => x.key !== l.key))
                      }
                      className="rounded p-1 text-[var(--pos-ink-3)] hover:bg-[var(--pos-surface-2)] hover:text-[var(--pos-ink)]"
                      aria-label="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setQty(l.key, -1)}
                        className="rounded-lg bg-[var(--pos-surface-2)] p-1.5 hover:bg-[var(--pos-surface-3)]"
                        aria-label="Decrease"
                      >
                        <Minus className="h-4 w-4" />
                      </button>
                      <span className="w-8 text-center text-sm">
                        {l.quantity}
                      </span>
                      <button
                        type="button"
                        onClick={() => setQty(l.key, 1)}
                        className="rounded-lg bg-[var(--pos-surface-2)] p-1.5 hover:bg-[var(--pos-surface-3)]"
                        aria-label="Increase"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </div>
                    <span
                      className={
                        l.lineDiscount > 0
                          ? "text-sm text-[var(--pos-ink-3)] line-through"
                          : "font-semibold"
                      }
                    >
                      ₹{(l.unitPrice * l.quantity).toLocaleString("en-IN")}
                    </span>
                  </div>
                  {/* Per-line markdown — for the one damaged or expiring unit,
                      as opposed to a discount across the whole sale. Hidden
                      unless this operator may discount: a field that always
                      fails at the till, in front of a customer, is worse than
                      no field. The server is the actual boundary. */}
                  {config.canDiscount && (
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                      <label className="flex items-center gap-1.5 text-[var(--pos-ink-2)]">
                        Less ₹
                        <input
                          value={l.lineDiscount || ""}
                          inputMode="numeric"
                          onChange={(e) =>
                            setLineDiscount(
                              l.key,
                              Number(e.target.value.replace(/\D/g, "")) || 0,
                            )
                          }
                          placeholder="0"
                          className="w-16 rounded-lg border border-[var(--pos-border)] bg-[var(--pos-surface)] px-2 py-1 text-right text-[var(--pos-ink)] outline-none focus:border-[var(--pos-border-strong)]"
                        />
                      </label>
                      {l.lineDiscount > 0 && (
                        <span className="font-semibold text-[var(--pos-ink)]">
                          ₹
                          {(
                            l.unitPrice * l.quantity -
                            l.lineDiscount
                          ).toLocaleString("en-IN")}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="shrink-0 border-t border-[var(--pos-border)] p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="text-[var(--pos-ink-2)]">Subtotal</span>
              <span>₹{subtotal.toLocaleString("en-IN")}</span>
            </div>
            {lineDiscountTotal > 0 && (
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-[var(--pos-ink-2)]">Line discounts</span>
                <span>−₹{lineDiscountTotal.toLocaleString("en-IN")}</span>
              </div>
            )}
            {/* ★ NAMED, NOT JUST TOTALLED. The cashier is standing in front of
                the customer who is asking why the price changed, and "offer"
                is not an answer. One row per offer, by name, is. */}
            {offerDiscountTotal > 0 &&
              (offerQuote?.applied ?? []).map((offer) => (
                <div
                  key={offer.offerId}
                  className="mb-2 flex items-center justify-between gap-3 text-sm"
                >
                  <span className="truncate text-[var(--pos-ink-2)]">
                    {offer.offerName}
                  </span>
                  <span className="shrink-0">
                    −₹{offer.amount.toLocaleString("en-IN")}
                  </span>
                </div>
              ))}
            {/* ★★ A GIFT IS AN INSTRUCTION, NOT A NUMBER. It is worth ₹0, so
                nothing in the totals moves and `posTotals` agrees perfectly
                with the sale — which is exactly why this row is essential:
                without it the register would reserve a tumbler and print it on
                the receipt while the cashier, seeing no change on screen, hands
                the customer their bag and nothing else. That is worse than a
                total mismatch, because the shop has already given the stock
                away on paper.
                ★ The name comes from the local catalogue by id, so it costs no
                round trip; a gift the cache has not seen still shows, labelled
                by what it is. */}
            {offerQuote?.gift && (
              <div className="mb-2 flex items-start justify-between gap-3 rounded-md border border-[var(--pos-border)] px-2 py-1.5 text-sm">
                <span className="text-[var(--pos-ink-2)]">
                  <strong className="text-[var(--pos-ink)]">Hand over</strong>{" "}
                  {giftLabel}
                  {offerQuote.gift.quantity > 1
                    ? ` × ${offerQuote.gift.quantity}`
                    : ""}
                </span>
                <span className="shrink-0 text-[var(--pos-ink-2)]">Free</span>
              </div>
            )}
            {offerQuote?.cappedByCeiling && (
              <p className="mb-2 text-xs text-[var(--pos-ink-2)]">
                Capped at this store&rsquo;s maximum discount per order.
              </p>
            )}
            {config.canDiscount && (
              <label className="mb-2 flex items-center justify-between gap-2 text-sm">
                <span className="text-[var(--pos-ink-2)]">Discount ₹</span>
                <input
                  value={discount || ""}
                  inputMode="numeric"
                  onChange={(e) =>
                    setDiscount(Number(e.target.value.replace(/\D/g, "")) || 0)
                  }
                  placeholder="0"
                  className="w-24 rounded-lg border border-[var(--pos-border)] bg-[var(--pos-surface)] px-2 py-1 text-right outline-none focus:border-[var(--pos-border-strong)]"
                />
              </label>
            )}
            {tax > 0 && (
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="text-[var(--pos-ink-2)]">
                  Tax{config.pricesIncludeTax ? " (included)" : ""}
                </span>
                <span>₹{tax.toLocaleString("en-IN")}</span>
              </div>
            )}
            <div className="mb-3 flex items-center justify-between text-lg font-bold">
              <span>Total</span>
              <span>₹{estTotal.toLocaleString("en-IN")}</span>
            </div>
            <button
              type="button"
              disabled={cart.length === 0}
              onClick={() => setTendering(true)}
              className="w-full rounded-xl bg-emerald-600 py-3 font-semibold transition-colors hover:bg-emerald-500 disabled:opacity-40 text-white"
            >
              Charge ₹{estTotal.toLocaleString("en-IN")}
            </button>

            {/* Hold sits UNDER Charge and is quieter: the common act is taking
                money, and a hold button of equal weight next to it is one
                mis-tap away from a customer walking off unpaid. */}
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={cart.length === 0 || parking || !!exchangeActive}
                onClick={handlePark}
                className="flex-1 rounded-xl bg-[var(--pos-surface-2)] py-2.5 text-sm font-medium transition-colors hover:bg-[var(--pos-surface-3)] disabled:opacity-40"
              >
                {parking ? "Holding…" : "Hold sale"}
              </button>
              <button
                type="button"
                onClick={() => setParkedOpen(true)}
                className="rounded-xl bg-[var(--pos-surface-2)] px-4 py-2.5 text-sm font-medium transition-colors hover:bg-[var(--pos-surface-3)]"
              >
                Held
                {parked.length > 0 ? ` (${parked.length})` : ""}
              </button>
            </div>
          </div>
        </aside>
      </div>

      {/*
        Variant picker.
        ★ SEPARATE FROM THE DISAMBIGUATION OVERLAY BELOW, which looks similar
        and answers a different question. That one resolves a mistake — two
        SKUs sharing a supplier barcode — and its copy says so. This one is an
        ordinary choice, and it is the only screen between a grouped tile and
        the cart, so it shows everything needed to make that choice without a
        second look: option name, price, stock at this register, and the SKU.
      */}
      {variantsFor && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Choose an option for ${variantsFor.name}`}
          onClick={() => setVariantsFor(null)}
        >
          <div
            className="flex max-h-[88dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl bg-[var(--pos-surface)] shadow-[0_-8px_40px_rgba(0,0,0,0.35)] sm:rounded-2xl sm:shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            {/* The product, so a cashier who mis-tapped sees it immediately
                rather than reading the options to work out where they are. */}
            <div className="flex shrink-0 items-center gap-3 border-b border-[var(--pos-border)] p-4">
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl bg-[var(--pos-surface-2)]">
                {variantsFor.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={variantsFor.image}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[var(--pos-ink-3)]">
                    <Package className="h-6 w-6" strokeWidth={1.5} />
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-base font-semibold leading-tight">
                  {variantsFor.name}
                </h2>
                <p className="mt-0.5 text-xs text-[var(--pos-ink-2)]">
                  {variantsFor.variants.length} options ·{" "}
                  {groupPriceLabel(variantsFor, money)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setVariantsFor(null)}
                className="-mr-1 shrink-0 rounded-lg p-2 text-[var(--pos-ink-2)] transition-colors hover:bg-[var(--pos-surface-2)] hover:text-[var(--pos-ink)]"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Its own scroller: thirty variants must not push the close
                button off a till screen. */}
            <div className="pos-scroll-area min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
              <ul className="space-y-1.5">
                {variantsFor.variants.map((v) => {
                  const out = isOutOfStock(v);
                  return (
                    <li key={lineKey(v.productId, v.variantId)}>
                      <button
                        type="button"
                        disabled={out}
                        // One tap adds the exact SKU and closes: the picker is
                        // a step on the way to the cart, not a place to linger.
                        onClick={() => {
                          addItem(v);
                          setVariantsFor(null);
                        }}
                        className="group flex w-full items-center gap-3 rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-2.5 text-left transition-colors hover:border-[var(--pos-border-strong)] hover:bg-[var(--pos-surface-2)] disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-[var(--pos-border)] disabled:hover:bg-[var(--pos-surface)]"
                      >
                        {/* Variants routinely differ by colour or pack size,
                            which a name alone does not convey. `image` already
                            falls back to the product's, so every row has one. */}
                        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-[var(--pos-surface-2)]">
                          {v.image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={v.image}
                              alt=""
                              loading="lazy"
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-[var(--pos-ink-3)]">
                              <Package className="h-5 w-5" strokeWidth={1.5} />
                            </div>
                          )}
                        </div>

                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold">
                            {v.variantName ?? v.name}
                          </span>
                          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                            {/* Colour is spent only on the answer that stops a
                                sale. A quiet figure for everything else keeps
                                the row scannable. */}
                            {out ? (
                              <span className="rounded-md bg-[var(--pos-danger-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--pos-danger)]">
                                Sold out
                              </span>
                            ) : v.trackInventory ? (
                              <span className="text-[11px] text-[var(--pos-ink-2)]">
                                {v.stock} in stock
                              </span>
                            ) : (
                              <span className="text-[11px] text-[var(--pos-ink-3)]">
                                Stock not tracked
                              </span>
                            )}
                            {v.sku && (
                              <span className="truncate font-mono text-[10px] uppercase tracking-wide text-[var(--pos-ink-3)]">
                                {v.sku}
                              </span>
                            )}
                          </span>
                        </span>

                        <span className="flex shrink-0 items-center gap-1.5">
                          <span className="text-base font-semibold tabular-nums">
                            {money(v.price)}
                          </span>
                          <ChevronRight
                            className="h-4 w-4 text-[var(--pos-ink-3)] transition-colors group-hover:text-[var(--pos-ink-2)] group-disabled:opacity-0"
                            strokeWidth={2}
                          />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <p className="shrink-0 border-t border-[var(--pos-border)] px-4 py-2.5 text-center text-[11px] text-[var(--pos-ink-3)]">
              Scanning the item&apos;s barcode adds it without choosing here.
            </p>
          </div>
        </div>
      )}

      {/* Duplicate-barcode disambiguation */}
      {choices && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-[var(--pos-border)] bg-[var(--pos-surface)] shadow-2xl p-5">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="font-semibold">Which item?</h2>
              <button
                type="button"
                onClick={() => setChoices(null)}
                className="rounded p-1 text-[var(--pos-ink-2)] hover:bg-[var(--pos-surface-2)]"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mb-3 text-sm text-[var(--pos-ink-2)]">
              Several products share this code.
            </p>
            <div className="space-y-2">
              {choices.map((c) => (
                <button
                  key={lineKey(c.productId, c.variantId)}
                  type="button"
                  onClick={() => {
                    addItem(c);
                    setChoices(null);
                    setQuery("");
                  }}
                  className="flex w-full items-center justify-between rounded-xl border border-[var(--pos-border)] bg-[var(--pos-surface)] p-3 text-left hover:bg-[var(--pos-surface-2)]"
                >
                  <span>
                    <span className="block text-sm font-medium">{c.name}</span>
                    <span className="block text-xs text-[var(--pos-ink-2)]">
                      {c.variantName ?? c.sku}
                      {c.trackInventory ? ` · ${c.stock} in stock` : ""}
                    </span>
                  </span>
                  <span className="font-semibold">
                    ₹{c.price.toLocaleString("en-IN")}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* A camera scan takes the IDENTICAL path as a hardware scan, so
          duplicate-barcode disambiguation and "not found" behave the same. */}
      {cameraOpen && (
        <CameraScanner
          onScan={(code) => void runScan(code)}
          onClose={() => setCameraOpen(false)}
        />
      )}

      {parkedOpen && (
        <ParkedPanel
          sales={parked}
          cartHasItems={cart.length > 0}
          onResume={(sale) => {
            // ★ RESUMED AS CHOICES, RE-PRICED HERE. The catalogue is the source
            // of the name and unit price, so a cart held before a price change
            // comes back at today's — and placePosSale re-reads again at
            // completion, so nothing here is ever the basis for a charge.
            const restored = sale.lines.flatMap((l) => {
              const item = catalog.byId(l.productId, l.variantId);
              if (!item) return [];
              // ★ THE SAME BUILDER THE GRID USES. This used to hand-build a
              // partial line and finish it with `as CartLine`, which dropped
              // taxClassId and categoryId — so a resumed basket quoted a
              // TAX-FREE total while placePosSale charged tax, and every
              // category-scoped offer silently stopped applying to it.
              return [
                cartLineFrom(item, {
                  quantity: l.quantity,
                  lineDiscount: l.lineDiscount ?? 0,
                }),
              ];
            });
            const dropped = sale.lines.length - restored.length;
            setCart(restored);
            setDiscount(sale.orderDiscount || 0);
            setGstin(sale.customerGstin ?? "");
            // A product deleted while the cart was held. Said out loud —
            // silently shrinking a resumed basket is how a customer is charged
            // for less than they picked up.
            setError(
              dropped > 0
                ? `${dropped} item${dropped === 1 ? " is" : "s are"} no longer in the catalogue and couldn't be restored.`
                : null,
            );
          }}
          onChanged={refreshParked}
          onClose={() => setParkedOpen(false)}
        />
      )}

      {tendering && (
        <TenderPanel
          total={estTotal}
          onCancel={() => setTendering(false)}
          onComplete={completeSale}
          receiptEmail={receiptEmail}
          onReceiptEmail={setReceiptEmail}
          customer={customer}
          customerLocked={!!exchangeActive}
          onCustomer={setCustomer}
          onResolveCustomer={async (mobile, dial) => {
            const result = await resolvePosCustomerByPhone(mobile, dial);
            // ★ Re-price the moment the customer is known. Their per-customer
            // offer caps could not be resolved when the register opened, so
            // without this the till keeps quoting an offer the server will
            // refuse at completion — with the customer watching.
            setExhaustedOfferIds(result.exhaustedOfferIds ?? []);
            setIsFirstOrder(result.isFirstOrder ?? null);
            return result;
          }}
          onCreateCustomer={async (input) => {
            const result = await createPosCheckoutCustomer(input);
            // Same reason as the lookup above: the quote must know what the
            // charge will know.
            setExhaustedOfferIds(result.exhaustedOfferIds ?? []);
            setIsFirstOrder(result.isFirstOrder ?? null);
            return result;
          }}
          gstin={gstin}
          onGstin={setGstin}
          gstEnabled={config.gstEnabled}
          // Rides along with the resolved customer.
          storeCredit={customer?.storeCredit ?? null}
          // Passed only when the store has a live gateway, so the method never
          // renders as a control that would fail in front of a customer.
          onTakeOnline={config.onlinePayments ? takeOnlinePayment : undefined}
          onVerifyManager={(pin) =>
            verifyManagerPin(pin, {
              lines: saleLines(),
              orderDiscount: cappedDiscount,
            })
          }
        />
      )}

      {saleId && (
        <ReceiptOverlay orderId={saleId} onClose={() => setSaleId(null)} />
      )}
    </div>
  );
}
