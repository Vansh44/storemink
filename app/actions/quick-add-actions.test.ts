/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDbMock } from "./_test-helpers";

const holder = vi.hoisted(() => ({ db: null as any, fail: false }));
vi.mock("@/lib/db/client", () => ({
  withAnon: vi.fn(async (fn: any) => {
    if (holder.fail) throw new Error("db down");
    return fn(holder.db);
  }),
}));
const getCurrentStoreOrNull = vi.fn();
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreOrNull: () => getCurrentStoreOrNull(),
}));

import { getQuickAddProduct } from "./quick-add-actions";

const ID = "11111111-1111-4111-8111-111111111111";

describe("getQuickAddProduct", () => {
  beforeEach(() => {
    holder.fail = false;
    getCurrentStoreOrNull.mockResolvedValue({ id: "store-1" });
    holder.db = makeDbMock({
      selectQueue: [
        [
          {
            id: ID,
            slug: "shirt",
            name: "Shirt",
            image_url: null,
            category: null,
            options: [{ name: " Size ", values: ["S", "M"] }],
          },
        ],
        [{ id: "v1", name: "S", option_values: ["S"] }],
      ],
    }).db;
  });

  it("refuses a malformed id before touching the store or the database", async () => {
    expect(await getQuickAddProduct("not-a-uuid")).toBeNull();
    expect(getCurrentStoreOrNull).not.toHaveBeenCalled();
  });

  it("finds nothing on a host that is not a store", async () => {
    getCurrentStoreOrNull.mockResolvedValue(null);
    expect(await getQuickAddProduct(ID)).toBeNull();
  });

  it("returns normalised options with the variants", async () => {
    const product = await getQuickAddProduct(ID);
    expect(product?.options).toEqual([{ name: "Size", values: ["S", "M"] }]);
    expect(product?.variants).toHaveLength(1);
  });

  it("drops stored options it would refuse to render", async () => {
    holder.db = makeDbMock({
      selectQueue: [
        [
          {
            id: ID,
            slug: "s",
            name: "S",
            image_url: null,
            category: null,
            options: [{ name: "Size", values: ["S", "s"] }],
          },
        ],
        [],
      ],
    }).db;
    expect((await getQuickAddProduct(ID))?.options).toEqual([]);
  });

  it("answers null rather than throwing when the read fails", async () => {
    holder.fail = true;
    expect(await getQuickAddProduct(ID)).toBeNull();
  });
});
