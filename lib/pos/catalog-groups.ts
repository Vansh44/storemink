import { isOutOfStock, type CatalogItem } from "./catalog-index";

/**
 * What one tile on the register's idle grid stands for.
 *
 * ★★ GROUPING IS A PRESENTATION CONCERN AND NOTHING MORE. `CatalogItem` stays
 * one row per sellable SKU, `itemKey` stays `productId:variantId`, a cart line
 * stays a SKU and `placePosSale` is untouched — so this cannot change what is
 * charged, what is reserved, or what the IndexedDB cache holds (no
 * SCHEMA_VERSION bump, so no till is forced to re-sync to get it).
 *
 * ★ WHY THE GRID NEEDED IT. The catalogue query is a LEFT JOIN, so a product
 * with three variants is three rows and a product with none is one — there is
 * no parent row to show. A flat grid therefore rendered every variant as its
 * own card: on a catalogue of 74 products with 64 variants that is 115 tiles,
 * and at twenty products with five variants each it is a hundred tiles for
 * twenty things a cashier is looking for. The parent card here is DERIVED from
 * the variant rows for exactly that reason.
 *
 * ⚠ Search and scanning deliberately do NOT go through this. Both already
 * resolve an exact SKU, and putting a picker in front of a scanned barcode or
 * a typed "black medium" would add a tap to the fastest paths in the shop.
 */
export type GridEntry =
  | { kind: "sku"; key: string; item: CatalogItem }
  | {
      kind: "group";
      key: string;
      productId: string;
      name: string;
      image: string | null;
      /** Only the variants this tile stands for — see the layout rule below. */
      variants: CatalogItem[];
      /** Summed at THIS register's location; null when nothing is tracked. */
      stock: number | null;
      /** Lowest and highest variant price, equal when they all match. */
      minPrice: number;
      maxPrice: number;
      /** True only when every variant behind the tile is unsellable. */
      soldOut: boolean;
    };

/**
 * A tile is sold out only when EVERYTHING behind it is.
 *
 * ★ One in-stock variant makes the product sellable, so greying the tile would
 * hide a sale. It reuses `isOutOfStock` rather than re-deriving the rule,
 * because the grid's greying and the sold-out-last ordering have to agree or
 * the greyed tiles are not the ones at the end.
 */
function groupSoldOut(variants: CatalogItem[]): boolean {
  return variants.every(isOutOfStock);
}

/**
 * Summed stock for a tile, or null when no variant behind it is tracked.
 *
 * ⚠ NULL AND ZERO ARE DIFFERENT ANSWERS. Null means "not counted" and must not
 * render as "0 in stock", which would tell a cashier a made-to-order product
 * had run out. A mix of tracked and untracked variants sums the tracked ones:
 * the figure is then a floor, which is the safe direction to be wrong in.
 */
function groupStock(variants: CatalogItem[]): number | null {
  const tracked = variants.filter((v) => v.trackInventory);
  if (tracked.length === 0) return null;
  return tracked.reduce((sum, v) => sum + (v.stock ?? 0), 0);
}

function toGroup(productId: string, variants: CatalogItem[]): GridEntry {
  const prices = variants.map((v) => v.price);
  const withImage = variants.find((v) => v.image);
  return {
    kind: "group",
    key: `g:${productId}`,
    productId,
    name: variants[0].name,
    image: withImage?.image ?? null,
    variants,
    stock: groupStock(variants),
    minPrice: Math.min(...prices),
    maxPrice: Math.max(...prices),
    soldOut: groupSoldOut(variants),
  };
}

/**
 * Fold an ordered SKU list into the tiles the grid should show.
 *
 * The input is already in the order the grid wants — `applyLayout` has run, so
 * a manager's arrangement and the sold-out-last shift are both applied. This
 * only merges runs of variants that belong to one product, keeping each tile
 * at the position of its first variant so the manager's order survives.
 *
 * ★★ THE LAYOUT DOUBLES AS THE PER-PRODUCT ESCAPE HATCH, which is why no new
 * setting was added (owner's decision, 2026-09-11). `pos_layouts` entries are
 * SKU-level, so a manager can already say which variants belong on the grid:
 *
 *   nothing laid out          -> every variant product gets one grouped tile
 *   ONE variant laid out      -> that variant is its own tile
 *   TWO OR MORE laid out      -> one grouped tile, holding just those
 *
 * ⚠ THE THRESHOLD IS "TWO OR MORE", NOT "ALL", AND THAT IS DELIBERATE. With
 * "all", a manager who had laid out all five variants would get a grouped tile
 * until somebody added a sixth — at which point the layout held five of six
 * and the tile would silently explode into five separate cards. A rule that
 * changes because an unrelated product edit happened is one nobody can
 * predict. "Two or more" is stable across that, and still lets a manager pin a
 * single variant on its own.
 */
export function groupForGrid(items: CatalogItem[]): GridEntry[] {
  const countByProduct = new Map<string, number>();
  for (const item of items) {
    if (!item.variantId) continue;
    countByProduct.set(
      item.productId,
      (countByProduct.get(item.productId) ?? 0) + 1,
    );
  }

  const out: GridEntry[] = [];
  const groupAt = new Map<string, number>();
  for (const item of items) {
    // A variant-less product, or a lone variant a manager pinned: its own tile.
    if (!item.variantId || (countByProduct.get(item.productId) ?? 0) < 2) {
      out.push({
        kind: "sku",
        key: `s:${item.productId}:${item.variantId ?? ""}`,
        item,
      });
      continue;
    }
    const at = groupAt.get(item.productId);
    if (at === undefined) {
      groupAt.set(item.productId, out.length);
      out.push(toGroup(item.productId, [item]));
      continue;
    }
    // Merge into the tile already placed, so the manager's position holds even
    // when a product's variants are not adjacent in the layout.
    const existing = out[at];
    if (existing.kind === "group") {
      out[at] = toGroup(existing.productId, [...existing.variants, item]);
    }
  }
  return out;
}

/** What the tile shows for price: one figure, or a range when they differ. */
export function groupPriceLabel(
  entry: Extract<GridEntry, { kind: "group" }>,
  money: (n: number) => string,
): string {
  return entry.minPrice === entry.maxPrice
    ? money(entry.minPrice)
    : `${money(entry.minPrice)} – ${money(entry.maxPrice)}`;
}
