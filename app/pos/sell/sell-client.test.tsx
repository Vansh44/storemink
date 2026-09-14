// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
const catalog = vi.hoisted(() => ({
  ready: true,
  version: 1,
  syncing: false,
  count: 1,
  all: vi.fn(),
  search: vi.fn(),
  scan: vi.fn(() => []),
  resync: vi.fn(),
  applySold: vi.fn(),
  byId: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/app/actions/pos-sale-actions", () => ({
  // Placeholder shape only — the operative value is set in `beforeEach`, the
  // one place that may reference ITEM (a `vi.mock` factory is hoisted above
  // it). Kept a VALID shape rather than a bare `vi.fn()`: the component reads
  // `res.error` inside a timer callback, so an undefined result would surface
  // as an unhandled rejection attributed to whichever test happened to be
  // running. See the beforeEach note for why an empty list is not the default.
  lookupProducts: vi.fn(async () => ({ items: [] })),
  placePosSale: vi.fn(),
  resolvePosCustomerByPhone: vi.fn(),
  startPosGatewayPayment: vi.fn(),
  confirmPosGatewayPayment: vi.fn(),
  verifyManagerPin: vi.fn(),
}));
vi.mock("@/app/actions/pos-layout-actions", () => ({
  getPosLayout: vi.fn(async () => ({ items: [], canEdit: false })),
  resetPosLayout: vi.fn(),
  savePosLayout: vi.fn(),
}));
vi.mock("@/app/actions/pos-park-actions", () => ({
  listParkedSales: vi.fn(async () => ({ sales: [] })),
  parkSale: vi.fn(),
}));
vi.mock("@/lib/pos/use-catalog", () => ({ useCatalog: () => catalog }));
vi.mock("@/lib/pos/barcode-camera", () => ({
  isCameraScanSupported: () => false,
}));
vi.mock("@/lib/pos/keyboard-wedge", () => ({
  createKeyboardWedge: () => ({ handleKey: () => ({ type: "ignored" }) }),
  isEditableTarget: () => false,
  isTouchPrimary: () => true,
  subscribeTouchPrimary: () => () => undefined,
}));
vi.mock("@/lib/payments/razorpay-client", () => ({
  openRazorpayModal: vi.fn(),
}));
vi.mock("./layout-editor", () => ({ LayoutEditMode: () => null }));
vi.mock("./tender-panel", () => ({ TenderPanel: () => null }));
vi.mock("./parked-panel", () => ({ ParkedPanel: () => null }));
vi.mock("./receipt-overlay", () => ({ ReceiptOverlay: () => null }));
vi.mock("./camera-scanner", () => ({ CameraScanner: () => null }));

import {
  SellClient,
  shouldBlockPosScan,
  shouldRefocusPosSearch,
} from "./sell-client";
import {
  lookupProducts,
  type PosCatalogItem,
  type RegisterConfig,
} from "@/app/actions/pos-sale-actions";
import type { PosExchangeContext } from "@/app/actions/pos-return-actions";

const ITEM: PosCatalogItem = {
  productId: "p1",
  variantId: null,
  name: "Multigrain Bread",
  variantName: null,
  sku: "BREAD-1",
  barcode: "8901",
  price: 52,
  image: "/bread.jpg",
  stock: 5,
  trackInventory: true,
  allowBackorder: false,
  taxClassId: null,
  categoryId: null,
};

const CONFIG: RegisterConfig = {
  storeId: "store-1",
  locationId: "loc-1",
  locationName: "Shop",
  operatorName: "Priya",
  role: "manager",
  taxEnabled: false,
  gstEnabled: false,
  pricesIncludeTax: true,
  taxRates: {},
  defaultTaxClassId: null,
  currency: "INR",
  canDiscount: false,
  canOverridePrice: false,
  onlinePayments: false,
  gatewayKeyId: null,
  offers: [],
  offerPolicy: {
    onSalePrice: "best",
    maxTotalDiscountPercent: 50,
    autoApply: false,
  },
  storeName: "Echoes",
};

const storedCartKeys = () =>
  Object.keys(sessionStorage).filter((k) => k.startsWith("sm-pos-cart-v"));

beforeEach(() => {
  vi.clearAllMocks();
  // The register now keeps its in-progress basket in sessionStorage, which is
  // shared across tests in this file — an uncleared basket would restore into
  // the next test and pass or fail it for the wrong reason (the ordering trap
  // `test:shuffle` exists to catch).
  sessionStorage.clear();
  // Shared hoisted object: a test that opens the register on a cold catalogue
  // must not leave the next one cold.
  catalog.ready = true;
  catalog.all.mockReturnValue([ITEM]);
  catalog.search.mockReturnValue([ITEM]);
  catalog.byId.mockImplementation((productId: string) =>
    productId === ITEM.productId ? ITEM : null,
  );
  // ★★ THE SERVER FALLBACK RETURNS THE CATALOGUE, and it must, because a
  // register opened on a COLD catalogue arms a real 150ms timer
  // (sell-client.tsx: the `if (catalog.ready) return;` effect) that calls this
  // action and pushes its result into `serverItems`. The factory default of
  // `{ items: [] }` models "the shop sells nothing", so ~150ms after any cold
  // render the product grid EMPTIED — and every later `getByRole(/multigrain
  // bread/i)` in that test threw. That is a wall-clock dependency, not an
  // ordering one: the tests passed only while three render/click cycles
  // finished inside 150ms, and went red on a loaded parallel worker. It is
  // exactly the flake `test:shuffle` reports and cannot reproduce in
  // isolation. Set here, AFTER clearAllMocks, per the restore-defaults rule.
  vi.mocked(lookupProducts).mockResolvedValue({ items: [ITEM] });
});

describe("Sell cart", () => {
  it("does not restore scanner focus while live hardware is touch-primary", () => {
    expect(
      shouldRefocusPosSearch({
        reportedTouchPrimary: false,
        liveTouchPrimary: true,
        overlayOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldRefocusPosSearch({
        reportedTouchPrimary: false,
        liveTouchPrimary: false,
        overlayOpen: false,
      }),
    ).toBe(true);
  });

  it("keeps the selected product photo on the cart line", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });

    expect(container.querySelectorAll('img[src="/bread.jpg"]')).toHaveLength(2);
  });

  it("keeps phone products and cart in separate switchable panes", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });

    const productsPane = screen.getByRole("button", { name: "Products" });
    const cartPane = screen.getByRole("button", { name: "Cart, empty" });
    expect(productsPane).toHaveAttribute("aria-pressed", "true");
    expect(cartPane).toHaveAttribute("aria-pressed", "false");

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });

    expect(
      screen.getByRole("button", { name: "Cart, 1 item" }),
    ).toHaveTextContent("Cart1");
    const viewCart = screen.getByRole("button", {
      name: "View cart, 1 item, total ₹52",
    });
    expect(viewCart).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(viewCart);
    });

    expect(screen.getByRole("button", { name: "Products" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Cart, 1 item" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector("aside")?.className).toContain("flex");
  });

  it("keeps the phone search and intended scroll areas within the viewport", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });

    const search = screen.getByPlaceholderText(
      "Scan a barcode or search products…",
    );
    expect(search).toHaveClass("min-w-0", "text-base", "sm:text-sm");
    expect(search.parentElement).toHaveClass("min-w-0");
    expect(container.querySelectorAll(".pos-scroll-area")).toHaveLength(2);
  });

  // ★★ A REFRESH USED TO EMPTY THE TILL. `cart` was plain component state
  // written nowhere, so an F5 mid-sale made the cashier re-scan the basket
  // with the customer standing there. Unmounting and remounting is the closest
  // a jsdom test gets to a reload; sessionStorage survives it, exactly as it
  // survives one in the tab.
  it("restores the basket after a reload, re-priced from the catalogue", async () => {
    await act(async () => {
      render(<SellClient config={CONFIG} initialItems={[ITEM]} />);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });
    expect(
      screen.getByRole("button", { name: "Cart, 2 items" }),
    ).toBeInTheDocument();

    cleanup();

    // The catalogue has repriced since; the restored line must quote TODAY's
    // price, never the one stored with the choice.
    catalog.byId.mockImplementation(() => ({ ...ITEM, price: 60 }));
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });

    // findBy*, not getBy*: the restore arrives from an effect, so a
    // synchronous query can lose the race on a loaded machine and fail for
    // reasons that have nothing to do with the code.
    expect(
      await screen.findByRole("button", { name: "Cart, 2 items" }),
    ).toBeInTheDocument();
    expect(container.textContent).toContain("Multigrain Bread");
    // 2 x today's ₹60, not 2 x the ₹52 in force when the basket was built:
    // choices are stored, prices are re-read (lib/pos/cart-storage.ts).
    expect(container.textContent).toContain("₹120");
    expect(container.textContent).not.toContain("₹104");
    expect(container.textContent).not.toContain(
      "Scan or tap a product to start a sale.",
    );
  });

  it("starts empty when the register is opened fresh", async () => {
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });
    expect(container.textContent).toContain(
      "Scan or tap a product to start a sale.",
    );
  });

  // A completed or held sale must leave nothing behind: the counter is free
  // for the next customer, and their basket is not the previous one.
  it("forgets the basket once the cart is emptied", async () => {
    await act(async () => {
      render(<SellClient config={CONFIG} initialItems={[ITEM]} />);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });
    expect(storedCartKeys()).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(storedCartKeys()).toHaveLength(0);

    cleanup();
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });
    expect(container.textContent).toContain(
      "Scan or tap a product to start a sale.",
    );
  });

  // ★★ THE WRITER'S RESTORE GATE. Every path that changes the basket saves it,
  // and on mount the cart is empty — so without the gate that writer clears the
  // stored basket before the restore has had a chance to run. It survives one
  // refresh either way (the payload is already in memory by then), which is
  // what makes this worth a test of its own: the loss only shows on a SECOND
  // reload while the catalogue is still cold, and then the basket is gone for
  // good.
  it("keeps the stored basket while the catalogue is still warming up", async () => {
    await act(async () => {
      render(<SellClient config={CONFIG} initialItems={[ITEM]} />);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });
    cleanup();

    catalog.ready = false;
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });
    // Nothing can be priced yet, so nothing is shown — but the basket must
    // still be there, and the till must not claim the sale started empty.
    expect(storedCartKeys()).toHaveLength(1);
    expect(
      await screen.findByText("Restoring the sale in progress…"),
    ).toBeInTheDocument();
    expect(container.textContent).not.toContain(
      "Scan or tap a product to start a sale.",
    );

    cleanup();
    catalog.ready = true;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });
    // The basket is back — asserted on the cart counter, since the product
    // name also appears on its grid tile.
    expect(
      await screen.findByRole("button", { name: "Cart, 1 item" }),
    ).toBeInTheDocument();
  });

  // ★★ THE CASHIER IN FRONT OF THE CUSTOMER WINS. If the catalogue is still
  // warming when they start ringing up, the stored basket is abandoned rather
  // than swapped in underneath them — handing a cashier a different basket
  // mid-sale is the money error this whole feature must never cause.
  it("abandons the stored basket once the cashier has started a new one", async () => {
    await act(async () => {
      render(<SellClient config={CONFIG} initialItems={[ITEM]} />);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });
    expect(
      await screen.findByRole("button", { name: "Cart, 1 item" }),
    ).toBeInTheDocument();
    cleanup();

    // Opened cold: the stored basket cannot be priced yet.
    catalog.ready = false;
    await act(async () => {
      render(<SellClient config={CONFIG} initialItems={[ITEM]} />);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });

    // ★ CROSS THE COLD-CATALOGUE WINDOW ON PURPOSE. A cold register arms a
    // real 150ms timer that refreshes the grid from the server, and this test
    // used to race it: it passed only when all three cycles finished inside
    // that window, so a loaded worker turned it red with no code change.
    // Waiting for the fallback to land makes the sequence deterministic AND
    // closer to the real one — a cashier who rings up on a cold till has
    // almost certainly been served by the server path first.
    await waitFor(() => expect(lookupProducts).toHaveBeenCalled());

    // The catalogue warms up mid-sale, which is when the restore becomes
    // possible — and must not happen.
    catalog.ready = true;
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });

    expect(
      await screen.findByRole("button", { name: "Cart, 2 items" }),
    ).toBeInTheDocument();
  });

  // ★ A basket built for one register must not reappear on another: stock is
  // per location, and a browser can be shared between stores.
  it("does not restore another register's basket", async () => {
    await act(async () => {
      render(<SellClient config={CONFIG} initialItems={[ITEM]} />);
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });
    cleanup();

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient
          config={{ ...CONFIG, locationId: "loc-2" }}
          initialItems={[ITEM]}
        />,
      ));
    });
    expect(container.textContent).toContain(
      "Scan or tap a product to start a sale.",
    );
  });

  // ★★ THE EXCHANGE GUARD. A counter exchange is a replacement priced against
  // one specific completed return, with the original customer attached and
  // locked; letting its basket return as an ordinary sale would tender the
  // replacement as an unrelated one.
  it("does not restore an exchange basket into an ordinary sale", async () => {
    const exchange: PosExchangeContext = {
      returnId: "ret-1",
      originalLabel: "ORD100110006",
      returnedValue: 52,
      customer: {
        id: "cust-1",
        name: "Asha",
        phone: "9876543210",
        email: null,
        storeCredit: 0,
      },
    };

    await act(async () => {
      render(
        <SellClient
          config={CONFIG}
          initialItems={[ITEM]}
          exchange={exchange}
        />,
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /multigrain bread/i }),
      );
    });
    cleanup();

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <SellClient config={CONFIG} initialItems={[ITEM]} />,
      ));
    });
    expect(container.textContent).toContain(
      "Scan or tap a product to start a sale.",
    );
  });
});

// ---------------------------------------------------------------------------
// Parent-product-first catalogue (three fast entry methods).
// ---------------------------------------------------------------------------

const SHIRT_S: PosCatalogItem = {
  ...ITEM,
  productId: "p9",
  variantId: "v1",
  name: "Classic T-Shirt",
  variantName: "Black / S",
  sku: "TEE-BLK-S",
  barcode: "9001",
  price: 499,
  stock: 2,
};
const SHIRT_M: PosCatalogItem = {
  ...SHIRT_S,
  variantId: "v2",
  variantName: "Black / M",
  sku: "TEE-BLK-M",
  barcode: "9002",
  price: 599,
  stock: 4,
};

/** One "Remove" button per cart line. */
const cartLines = () => screen.queryAllByRole("button", { name: "Remove" });

describe("Sell catalogue: parent products, then variants", () => {
  beforeEach(() => {
    catalog.all.mockReturnValue([SHIRT_S, SHIRT_M, ITEM]);
  });

  it("shows one tile per product, not one per variant", () => {
    render(<SellClient config={CONFIG} initialItems={[]} />);
    // ★ THE POINT. Three SKUs, two things a cashier is looking for.
    expect(screen.getByText("Classic T-Shirt")).toBeVisible();
    expect(screen.getByText("2 options")).toBeVisible();
    expect(screen.queryByText("Black / S")).not.toBeInTheDocument();
    expect(screen.getByText("Multigrain Bread")).toBeVisible();
  });

  it("prices the tile as a range and sums the stock at this register", () => {
    render(<SellClient config={CONFIG} initialItems={[]} />);
    expect(screen.getByText("₹499 – ₹599")).toBeVisible();
    expect(screen.getByText("6 in stock")).toBeVisible();
  });

  it("opens a picker showing each variant's price, stock and SKU", () => {
    render(<SellClient config={CONFIG} initialItems={[]} />);
    fireEvent.click(screen.getByText("Classic T-Shirt"));

    const picker = screen.getByRole("dialog", {
      name: /choose an option for classic t-shirt/i,
    });
    expect(picker).toBeVisible();
    expect(screen.getByText("Black / S")).toBeVisible();
    // Price, stock and SKU are each their own element, so a cashier can answer
    // a customer without leaving the screen.
    expect(screen.getByText("2 in stock")).toBeVisible();
    expect(screen.getByText("TEE-BLK-S")).toBeVisible();
    expect(screen.getByText("4 in stock")).toBeVisible();
    expect(screen.getByText("TEE-BLK-M")).toBeVisible();
    expect(screen.getByText("₹499")).toBeVisible();
    expect(screen.getByText("₹599")).toBeVisible();
    // Nothing is in the cart yet: opening the picker is not a decision.
    expect(cartLines()).toHaveLength(0);
  });

  it("shows a picture for every option, falling back to the product's", () => {
    // ★ Variants routinely differ by colour or pack size, which a name alone
    // does not convey. The catalogue already resolves a variant's own image
    // with a fallback to the product's, so every row has one.
    catalog.all.mockReturnValue([
      { ...SHIRT_S, image: null },
      { ...SHIRT_M, image: "/tee-m.webp" },
    ]);
    render(<SellClient config={CONFIG} initialItems={[]} />);
    fireEvent.click(screen.getByText("Classic T-Shirt"));

    const dialog = screen.getByRole("dialog");
    const images = dialog.querySelectorAll("img");
    // One for the product in the header, one for the option that has a picture.
    expect(images.length).toBeGreaterThanOrEqual(2);
    expect(
      Array.from(images).some((i) => i.getAttribute("src") === "/tee-m.webp"),
    ).toBe(true);
    // The option with no picture of its own still gets a placeholder rather
    // than a ragged row.
    expect(dialog.querySelectorAll("svg").length).toBeGreaterThan(0);
  });

  it("tells the cashier a scan skips the picker", () => {
    // The fastest route is not discoverable from the screen otherwise.
    render(<SellClient config={CONFIG} initialItems={[]} />);
    fireEvent.click(screen.getByText("Classic T-Shirt"));
    expect(
      screen.getByText(/scanning the item's barcode adds it/i),
    ).toBeVisible();
  });

  it("adds only the chosen variant, and closes", async () => {
    render(<SellClient config={CONFIG} initialItems={[]} />);
    fireEvent.click(screen.getByText("Classic T-Shirt"));
    fireEvent.click(screen.getByText("Black / M"));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(cartLines()).toHaveLength(1);
    // The cart holds the variant, not the parent.
    expect(screen.getByText(/Black \/ M/)).toBeVisible();
  });

  it("adds a product with no variants in one tap, with no picker", () => {
    render(<SellClient config={CONFIG} initialItems={[]} />);
    fireEvent.click(screen.getByText("Multigrain Bread"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cartLines()).toHaveLength(1);
  });

  it("returns exact variants from a search, with no picker in the way", () => {
    // ★ Search already resolves an exact SKU, so grouping it would ADD a tap
    // to one of the two fastest paths in the shop.
    catalog.search.mockReturnValue([SHIRT_M]);
    render(<SellClient config={CONFIG} initialItems={[]} />);
    fireEvent.change(screen.getByPlaceholderText(/scan a barcode/i), {
      target: { value: "black m" },
    });
    expect(screen.getByText("Black / M")).toBeVisible();
    expect(screen.queryByText("2 options")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Black / M"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cartLines()).toHaveLength(1);
  });

  it("greys a tile only when every variant is gone", () => {
    catalog.all.mockReturnValue([
      { ...SHIRT_S, stock: 0 },
      { ...SHIRT_M, stock: 0 },
    ]);
    render(<SellClient config={CONFIG} initialItems={[]} />);
    expect(screen.getByText("Out of stock")).toBeVisible();
    fireEvent.click(screen.getByText("Classic T-Shirt"));
    // A disabled tile opens nothing.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("still sells the product when one variant remains", () => {
    catalog.all.mockReturnValue([{ ...SHIRT_S, stock: 0 }, SHIRT_M]);
    render(<SellClient config={CONFIG} initialItems={[]} />);
    fireEvent.click(screen.getByText("Classic T-Shirt"));
    expect(screen.getByRole("dialog")).toBeVisible();
    // The gone one is offered but not tappable.
    expect(screen.getByText("Black / S").closest("button")).toBeDisabled();
    expect(screen.getByText("Black / M").closest("button")).toBeEnabled();
  });

  it("closes on Escape without adding anything", () => {
    render(<SellClient config={CONFIG} initialItems={[]} />);
    fireEvent.click(screen.getByText("Classic T-Shirt"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cartLines()).toHaveLength(0);
  });

  describe("a scan is the one thing the picker does not swallow", () => {
    // The wedge reads a burst of keystrokes off `window`, which this harness
    // does not drive — so the rule is pinned where it lives, as a boolean,
    // exactly as `shouldRefocusPosSearch` above is.
    const overlays = {
      tendering: false,
      disambiguating: false,
      cameraOpen: false,
      layoutOpen: false,
      receiptOpen: false,
      variantPickerOpen: false,
    };

    it("lets a scan through while the variant picker is open", () => {
      // ★ The cashier has the item in hand: its barcode settles the variant
      // better than tapping does, and swallowing the digits would leave them
      // going nowhere on the screen whose purpose is choosing a SKU.
      expect(shouldBlockPosScan({ ...overlays, variantPickerOpen: true })).toBe(
        false,
      );
    });

    it.each([
      ["tendering", { tendering: true }],
      ["disambiguating a shared barcode", { disambiguating: true }],
      ["the camera scanner", { cameraOpen: true }],
      ["the layout editor", { layoutOpen: true }],
      ["a receipt", { receiptOpen: true }],
    ])("still swallows a scan during %s", (_label, over) => {
      // Each of these owns a decision a stray burst of digits would corrupt.
      expect(shouldBlockPosScan({ ...overlays, ...over })).toBe(true);
    });

    it("blocks when another overlay is open even with the picker up", () => {
      expect(
        shouldBlockPosScan({
          ...overlays,
          variantPickerOpen: true,
          tendering: true,
        }),
      ).toBe(true);
    });

    it("allows a scan with nothing open at all", () => {
      expect(shouldBlockPosScan(overlays)).toBe(false);
    });
  });

  it("opens the picker without touching the cart", () => {
    // Opening it is not a decision: nothing is added until a variant is
    // chosen, so a mis-tap costs one Escape and no correction at the till.
    render(<SellClient config={CONFIG} initialItems={[]} />);
    fireEvent.click(screen.getByText("Classic T-Shirt"));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(cartLines()).toHaveLength(0);
  });
});
