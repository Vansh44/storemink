// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { CatalogItem } from "./catalog-index";
import {
  POS_CART_MAX_AGE_MS,
  POS_CART_SCHEMA_VERSION,
  clearAllPosCarts,
  parseStoredPosCart,
  posCartKey,
  readPosCartRaw,
  restoreCartLines,
  serializePosCart,
  writePosCart,
  type StoredPosCart,
} from "./cart-storage";

const NOW = 1_760_000_000_000;

function item(over: Partial<CatalogItem> = {}): CatalogItem {
  return {
    productId: "p1",
    variantId: null,
    name: "Amul Taaza Toned Milk",
    variantName: null,
    sku: "SKU100100015",
    barcode: "8901234567890",
    price: 79,
    image: "/milk.webp",
    stock: 4,
    trackInventory: true,
    allowBackorder: false,
    taxClassId: "tax-5",
    categoryId: "cat-dairy",
    ...over,
  };
}

function stored(over: Partial<StoredPosCart> = {}): StoredPosCart {
  return {
    v: POS_CART_SCHEMA_VERSION,
    savedAt: NOW,
    exchangeReturnId: null,
    discount: 0,
    gstin: "",
    lines: [{ productId: "p1", variantId: null, quantity: 2 }],
    ...over,
  };
}

const raw = (value: unknown) => JSON.stringify(value);
const ctx = { now: NOW, exchangeReturnId: null };

describe("parseStoredPosCart", () => {
  it("reads back a basket saved moments ago", () => {
    const out = parseStoredPosCart(raw(stored({ discount: 20, gstin: "x" })), {
      now: NOW + 5_000,
      exchangeReturnId: null,
    });
    expect(out?.lines).toEqual([
      { productId: "p1", variantId: null, quantity: 2 },
    ]);
    expect(out?.discount).toBe(20);
    expect(out?.gstin).toBe("x");
  });

  it("round-trips what serializePosCart writes", () => {
    const payload = serializePosCart({
      lines: [
        { productId: "p1", variantId: "v9", quantity: 3, lineDiscount: 15 },
        { productId: "p2", variantId: null, quantity: 1, lineDiscount: 0 },
      ],
      discount: 40,
      gstin: " 27aaaaa0000a1z5 ",
      exchangeReturnId: "ret-1",
      now: NOW,
    });
    const out = parseStoredPosCart(raw(payload), {
      now: NOW,
      exchangeReturnId: "ret-1",
    });
    expect(out?.lines).toEqual([
      { productId: "p1", variantId: "v9", quantity: 3, lineDiscount: 15 },
      { productId: "p2", variantId: null, quantity: 1 },
    ]);
    expect(out?.gstin).toBe("27aaaaa0000a1z5");
    expect(out?.discount).toBe(40);
  });

  it("ignores a basket older than the trading-day window", () => {
    expect(
      parseStoredPosCart(raw(stored()), {
        now: NOW + POS_CART_MAX_AGE_MS + 1,
        exchangeReturnId: null,
      }),
    ).toBeNull();
    // The boundary itself is still usable.
    expect(
      parseStoredPosCart(raw(stored()), {
        now: NOW + POS_CART_MAX_AGE_MS,
        exchangeReturnId: null,
      }),
    ).not.toBeNull();
  });

  it("ignores a basket saved in the future, so a corrected clock cannot pin one open", () => {
    expect(
      parseStoredPosCart(raw(stored({ savedAt: NOW + 60_000 })), ctx),
    ).toBeNull();
  });

  // ★ The exchange guard: a replacement basket is priced against one specific
  // completed return, so it must never come back as an ordinary sale.
  it("refuses a basket whose exchange context no longer matches", () => {
    const payload = raw(stored({ exchangeReturnId: "ret-1" }));
    expect(parseStoredPosCart(payload, ctx)).toBeNull();
    expect(
      parseStoredPosCart(payload, { now: NOW, exchangeReturnId: "ret-2" }),
    ).toBeNull();
    expect(
      parseStoredPosCart(payload, { now: NOW, exchangeReturnId: "ret-1" }),
    ).not.toBeNull();
  });

  it("refuses an ordinary basket while an exchange is being settled", () => {
    expect(
      parseStoredPosCart(raw(stored()), {
        now: NOW,
        exchangeReturnId: "ret-1",
      }),
    ).toBeNull();
  });

  it("refuses anything malformed rather than trusting part of it", () => {
    for (const bad of [
      null,
      "",
      "not json",
      raw(42),
      raw({}),
      raw(stored({ v: POS_CART_SCHEMA_VERSION + 1 })),
      raw(stored({ savedAt: Number.NaN })),
      raw(stored({ lines: [] })),
      raw(stored({ lines: [{ productId: "", variantId: null, quantity: 1 }] })),
      raw(
        stored({ lines: [{ productId: "p1", variantId: null, quantity: 0 }] }),
      ),
      raw(
        stored({
          lines: [{ productId: "p1", variantId: null, quantity: 1.5 }],
        }),
      ),
      raw(
        stored({ lines: [{ productId: "p1", variantId: null, quantity: -2 }] }),
      ),
      raw(stored({ lines: Array(201).fill({ productId: "p1", quantity: 1 }) })),
    ]) {
      expect(parseStoredPosCart(bad as string | null, ctx)).toBeNull();
    }
  });

  it("drops a negative order discount instead of storing a credit", () => {
    expect(
      parseStoredPosCart(raw(stored({ discount: -50 })), ctx)?.discount,
    ).toBe(0);
  });
});

describe("restoreCartLines", () => {
  // ★★ THE REGRESSION THIS EXISTS FOR: the parked-sale resume hand-built its
  // lines and cast them, dropping taxClassId and categoryId — so a restored
  // basket quoted a tax-free total while placePosSale charged tax.
  it("re-prices from the catalogue and carries the tax class and category", () => {
    const { lines, dropped } = restoreCartLines(
      stored({
        lines: [
          { productId: "p1", variantId: null, quantity: 2, lineDiscount: 9 },
        ],
      }),
      () => item({ price: 91 }),
    );
    expect(dropped).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      key: "p1:",
      unitPrice: 91,
      quantity: 2,
      lineDiscount: 9,
      taxClassId: "tax-5",
      categoryId: "cat-dairy",
      trackInventory: true,
      allowBackorder: false,
      stock: 4,
    });
  });

  it("asks the catalogue for the exact variant that was chosen", () => {
    const asked: [string, string | null][] = [];
    restoreCartLines(
      stored({ lines: [{ productId: "p7", variantId: "v3", quantity: 1 }] }),
      (productId, variantId) => {
        asked.push([productId, variantId]);
        return item({ productId, variantId });
      },
    );
    expect(asked).toEqual([["p7", "v3"]]);
  });

  it("drops and counts a product that has left the catalogue", () => {
    const { lines, dropped } = restoreCartLines(
      stored({
        lines: [
          { productId: "p1", variantId: null, quantity: 1 },
          { productId: "gone", variantId: null, quantity: 1 },
        ],
      }),
      (productId) => (productId === "gone" ? null : item({ productId })),
    );
    expect(lines.map((l) => l.productId)).toEqual(["p1"]);
    expect(dropped).toBe(1);
  });

  // The parked-resume rule: shrinking a basket without saying so is how a
  // customer is charged for less than they picked up. placePosSale reserves
  // atomically and reports the exact shortfall.
  it("does not silently clamp a quantity to what is left on the shelf", () => {
    const { lines } = restoreCartLines(
      stored({ lines: [{ productId: "p1", variantId: null, quantity: 9 }] }),
      () => item({ stock: 1 }),
    );
    expect(lines[0].quantity).toBe(9);
  });
});

describe("session storage wrappers", () => {
  it("scopes a basket to one register", () => {
    expect(posCartKey("store-a", "loc-1")).not.toBe(
      posCartKey("store-a", "loc-2"),
    );
    expect(posCartKey("store-a", "loc-1")).toContain(
      String(POS_CART_SCHEMA_VERSION),
    );
  });

  it("writes, reads back and clears everything on sign-out", () => {
    sessionStorage.clear();
    writePosCart("store-a", "loc-1", stored());
    writePosCart("store-b", "loc-9", stored());
    sessionStorage.setItem("unrelated", "keep me");

    expect(
      parseStoredPosCart(readPosCartRaw("store-a", "loc-1"), ctx),
    ).not.toBeNull();
    expect(readPosCartRaw("store-a", "loc-2")).toBeNull();

    clearAllPosCarts();
    expect(readPosCartRaw("store-a", "loc-1")).toBeNull();
    expect(readPosCartRaw("store-b", "loc-9")).toBeNull();
    // ★ Only ours: the till shares this origin with the drawer-width and
    // catalogue keys, and a sign-out must not wipe someone else's state.
    expect(sessionStorage.getItem("unrelated")).toBe("keep me");
  });

  it("degrades to a no-op when storage throws", () => {
    const original = window.sessionStorage;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("blocked by the kiosk profile");
      },
    });
    try {
      expect(readPosCartRaw("store-a", "loc-1")).toBeNull();
      expect(() => writePosCart("store-a", "loc-1", stored())).not.toThrow();
      expect(() => clearAllPosCarts()).not.toThrow();
    } finally {
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        value: original,
      });
    }
  });
});
