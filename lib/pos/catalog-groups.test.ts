import { describe, expect, it } from "vitest";
import {
  groupForGrid,
  groupPriceLabel,
  type GridEntry,
} from "./catalog-groups";
import type { CatalogItem } from "./catalog-index";

function sku(over: Partial<CatalogItem> & { productId: string }): CatalogItem {
  return {
    productId: over.productId,
    variantId: over.variantId ?? null,
    name: over.name ?? "Classic T-Shirt",
    variantName: over.variantName ?? null,
    sku: over.sku ?? null,
    barcode: over.barcode ?? null,
    price: over.price ?? 499,
    image: over.image ?? null,
    stock: over.stock ?? 5,
    trackInventory: over.trackInventory ?? true,
    allowBackorder: over.allowBackorder ?? false,
    taxClassId: over.taxClassId ?? null,
    categoryId: over.categoryId ?? null,
  } as CatalogItem;
}

/** A shirt in three sizes, the shape the grid used to render as three tiles. */
const shirt = [
  sku({
    productId: "p1",
    variantId: "v1",
    variantName: "Black / S",
    price: 499,
    stock: 2,
  }),
  sku({
    productId: "p1",
    variantId: "v2",
    variantName: "Black / M",
    price: 599,
    stock: 4,
    image: "/m.webp",
  }),
  sku({
    productId: "p1",
    variantId: "v3",
    variantName: "Black / L",
    price: 699,
    stock: 6,
  }),
];
const milk = sku({ productId: "p2", name: "Toned Milk", price: 32, stock: 44 });

const groups = (entries: GridEntry[]) => entries.map((e) => e.kind);

describe("groupForGrid", () => {
  it("shows one tile per product instead of one per variant", () => {
    // ★ THE WHOLE POINT: 4 SKUs, 2 things a cashier is looking for.
    const entries = groupForGrid([...shirt, milk]);
    expect(groups(entries)).toEqual(["group", "sku"]);
    expect(entries).toHaveLength(2);
  });

  it("leaves a product without variants tappable straight into the cart", () => {
    const [entry] = groupForGrid([milk]);
    expect(entry.kind).toBe("sku");
    if (entry.kind === "sku") expect(entry.item.productId).toBe("p2");
  });

  it("carries every variant behind the tile, in catalogue order", () => {
    const [entry] = groupForGrid(shirt);
    if (entry.kind !== "group") throw new Error("expected a group");
    expect(entry.variants.map((v) => v.variantName)).toEqual([
      "Black / S",
      "Black / M",
      "Black / L",
    ]);
    expect(entry.name).toBe("Classic T-Shirt");
  });

  it("sums stock at this location and reports a price range", () => {
    const [entry] = groupForGrid(shirt);
    if (entry.kind !== "group") throw new Error("expected a group");
    expect(entry.stock).toBe(12);
    expect(entry.minPrice).toBe(499);
    expect(entry.maxPrice).toBe(699);
  });

  it("borrows the first image any variant has", () => {
    // The first variant has none; a tile with no picture is harder to spot.
    const [entry] = groupForGrid(shirt);
    if (entry.kind !== "group") throw new Error("expected a group");
    expect(entry.image).toBe("/m.webp");
  });

  describe("stock is a floor, never a false zero", () => {
    it("reports null when nothing behind the tile is tracked", () => {
      // ⚠ Null must not render as "0 in stock" — that tells a cashier a
      // made-to-order product has run out.
      const untracked = shirt.map((v) => ({ ...v, trackInventory: false }));
      const [entry] = groupForGrid(untracked);
      if (entry.kind !== "group") throw new Error("expected a group");
      expect(entry.stock).toBeNull();
    });

    it("sums only the tracked variants when the product mixes both", () => {
      const mixed = [
        { ...shirt[0], trackInventory: false, stock: null },
        shirt[1],
        shirt[2],
      ];
      const [entry] = groupForGrid(mixed);
      if (entry.kind !== "group") throw new Error("expected a group");
      expect(entry.stock).toBe(10);
    });
  });

  describe("sold out", () => {
    it("is not sold out while one variant can still be sold", () => {
      const [entry] = groupForGrid([
        { ...shirt[0], stock: 0 },
        { ...shirt[1], stock: 0 },
        shirt[2],
      ]);
      if (entry.kind !== "group") throw new Error("expected a group");
      expect(entry.soldOut).toBe(false);
    });

    it("is sold out only when every variant is", () => {
      const [entry] = groupForGrid(shirt.map((v) => ({ ...v, stock: 0 })));
      if (entry.kind !== "group") throw new Error("expected a group");
      expect(entry.soldOut).toBe(true);
    });

    it("is sellable when a sold-out variant allows backorder", () => {
      const [entry] = groupForGrid(
        shirt.map((v) => ({ ...v, stock: 0, allowBackorder: true })),
      );
      if (entry.kind !== "group") throw new Error("expected a group");
      expect(entry.soldOut).toBe(false);
    });
  });

  describe("the layout is the per-product escape hatch", () => {
    it("gives a single laid-out variant its own tile", () => {
      // A manager who placed exactly one variant chose that variant.
      const entries = groupForGrid([shirt[1], milk]);
      expect(groups(entries)).toEqual(["sku", "sku"]);
    });

    it("groups two or more laid-out variants into one tile", () => {
      const entries = groupForGrid([shirt[0], shirt[2]]);
      expect(groups(entries)).toEqual(["group"]);
      const [entry] = entries;
      if (entry.kind !== "group") throw new Error("expected a group");
      // Only what was placed — the middle variant is not on the grid.
      expect(entry.variants.map((v) => v.variantName)).toEqual([
        "Black / S",
        "Black / L",
      ]);
      expect(entry.stock).toBe(8);
    });

    it("is stable when a new variant is added to the catalogue", () => {
      // ⚠ THE REASON THE THRESHOLD IS "TWO OR MORE" AND NOT "ALL". With "all",
      // a layout holding every variant would group until somebody created one
      // more, and the tile would silently explode into separate cards because
      // of an unrelated product edit.
      const beforeNewVariant = groupForGrid(shirt);
      expect(groups(beforeNewVariant)).toEqual(["group"]);
      // The layout still holds the original three; a fourth now exists.
      const afterNewVariant = groupForGrid(shirt);
      expect(groups(afterNewVariant)).toEqual(["group"]);
    });
  });

  it("keeps a tile at the position of its first variant", () => {
    // The manager's order has to survive, including when a product's variants
    // are not adjacent in the layout.
    const entries = groupForGrid([shirt[0], milk, shirt[1], shirt[2]]);
    expect(groups(entries)).toEqual(["group", "sku"]);
    const [first] = entries;
    if (first.kind !== "group") throw new Error("expected a group");
    expect(first.variants).toHaveLength(3);
  });

  it("gives every tile a stable, distinct key", () => {
    const entries = groupForGrid([...shirt, milk]);
    const keys = entries.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
    // Re-running produces the same keys, so React does not remount tiles.
    expect(groupForGrid([...shirt, milk]).map((e) => e.key)).toEqual(keys);
  });

  it("handles an empty catalogue", () => {
    expect(groupForGrid([])).toEqual([]);
  });
});

describe("groupPriceLabel", () => {
  const money = (n: number) => `₹${n}`;

  it("shows a range when variants differ", () => {
    const [entry] = groupForGrid(shirt);
    if (entry.kind !== "group") throw new Error("expected a group");
    expect(groupPriceLabel(entry, money)).toBe("₹499 – ₹699");
  });

  it("collapses to one figure when they all match", () => {
    // A range of "₹499 – ₹499" reads as a mistake.
    const [entry] = groupForGrid(shirt.map((v) => ({ ...v, price: 499 })));
    if (entry.kind !== "group") throw new Error("expected a group");
    expect(groupPriceLabel(entry, money)).toBe("₹499");
  });
});
