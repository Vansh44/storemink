import { describe, expect, it } from "vitest";
import { validateCreditPacks, CREDIT_PACK_LIMITS } from "./credits";

// The operator form and saveMinkCreditPacks run THIS function, so a form that
// accepts what the action refuses is impossible by construction.
describe("validateCreditPacks", () => {
  const ok = { id: "a", name: "Small", credits: 25, priceInr: 59 };

  it("accepts an arbitrary number of packs", () => {
    const packs = Array.from(
      { length: CREDIT_PACK_LIMITS.maxPacks },
      (_, i) => ({
        ...ok,
        id: `p${i}`,
        name: `Pack ${i}`,
      }),
    );
    expect(validateCreditPacks(packs)).toEqual([]);
  });

  it("refuses an empty catalogue", () => {
    // A store with no packs cannot top up at all once its allowance is spent.
    expect(validateCreditPacks([])).toEqual([
      { index: -1, message: "Keep at least one credit pack." },
    ]);
  });

  it("caps the catalogue so the cards stay comparable", () => {
    const packs = Array.from(
      { length: CREDIT_PACK_LIMITS.maxPacks + 1 },
      (_, i) => ({ ...ok, id: `p${i}` }),
    );
    expect(validateCreditPacks(packs)[0].index).toBe(-1);
  });

  it("allows at most one highlighted pack", () => {
    expect(
      validateCreditPacks([
        { ...ok, id: "a", popular: true },
        { ...ok, id: "b", popular: true },
      ]),
    ).toContainEqual({
      index: -1,
      message: "Only one pack can be highlighted.",
    });
    expect(
      validateCreditPacks([
        { ...ok, id: "a", popular: true },
        { ...ok, id: "b" },
      ]),
    ).toEqual([]);
  });

  it("refuses a duplicate id", () => {
    // Two rows with one id collapse into a single upsert, silently dropping a
    // pack the operator believes they just saved.
    expect(validateCreditPacks([ok, { ...ok }])[0]).toMatchObject({
      index: 1,
      message: "Duplicate pack id.",
    });
  });

  it("refuses a blank or oversized name", () => {
    expect(validateCreditPacks([{ ...ok, name: "   " }])[0].index).toBe(0);
    expect(
      validateCreditPacks([
        { ...ok, name: "x".repeat(CREDIT_PACK_LIMITS.nameMaxLength + 1) },
      ])[0].index,
    ).toBe(0);
  });

  it("refuses a non-positive, fractional or oversized size and price", () => {
    for (const credits of [0, -1, 2.5, CREDIT_PACK_LIMITS.maxCredits + 1]) {
      expect(validateCreditPacks([{ ...ok, credits }])).not.toEqual([]);
    }
    for (const priceInr of [0, -1, 2.5, CREDIT_PACK_LIMITS.maxPriceInr + 1]) {
      expect(validateCreditPacks([{ ...ok, priceInr }])).not.toEqual([]);
    }
  });

  it("mirrors the database CHECKs in migration 0116", () => {
    // If these drift, the form accepts a pack the database then rejects with a
    // constraint violation the operator cannot act on.
    expect(CREDIT_PACK_LIMITS).toMatchObject({
      nameMaxLength: 40,
      minCredits: 1,
      maxCredits: 1_000_000,
      minPriceInr: 1,
      maxPriceInr: 500_000,
    });
  });
});
