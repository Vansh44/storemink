import { describe, expect, it } from "vitest";
import { resolveMinkCreditPacks } from "./credit-pricing";

describe("resolveMinkCreditPacks", () => {
  it("overrides prices without changing pack sizes or order", () => {
    const packs = resolveMinkCreditPacks([
      { pack_id: "bulk", price_inr: 349 },
      { pack_id: "small", price_inr: 69 },
    ]);
    expect(
      packs.map(({ id, credits, priceInr }) => ({ id, credits, priceInr })),
    ).toEqual([
      { id: "small", credits: 25, priceInr: 69 },
      { id: "popular", credits: 60, priceInr: 129 },
      { id: "bulk", credits: 150, priceInr: 349 },
    ]);
  });

  it("ignores unknown rows", () => {
    expect(
      resolveMinkCreditPacks([{ pack_id: "surprise", price_inr: 1 }]).map(
        (pack) => pack.id,
      ),
    ).toEqual(["small", "popular", "bulk"]);
  });
});
