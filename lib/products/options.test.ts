import { describe, expect, it } from "vitest";
import {
  MAX_VARIANTS,
  allCombinations,
  composeVariantName,
  findVariant,
  generateVariantRows,
  initialVariant,
  normalizeOptions,
  optionValuesForName,
  selectValue,
  swatchAxis,
  usesOptionPickers,
  validateVariantCombos,
  valueStates,
  type ProductOption,
} from "./options";

const SIZE: ProductOption = { name: "Size", values: ["S", "M", "L"] };
const COLOUR: ProductOption = {
  name: "Colour",
  values: ["Black", "Tan"],
  swatches: { Black: "#111111", Tan: "#c19a6b" },
};

describe("normalizeOptions", () => {
  it("treats absent options as none", () => {
    expect(normalizeOptions(undefined)).toEqual({ options: [] });
    expect(normalizeOptions(null)).toEqual({ options: [] });
  });

  it("trims, drops blank rows and keeps valid swatches only", () => {
    const out = normalizeOptions([
      {
        name: "  Colour ",
        values: [" Black", "", "Tan "],
        swatches: { black: "#111", Tan: "red", Ghost: "#fff" },
      },
      { name: "", values: [] },
    ]);
    expect(out).toEqual({
      options: [
        {
          name: "Colour",
          values: ["Black", "Tan"],
          swatches: { Black: "#111" },
        },
      ],
    });
  });

  it("refuses duplicates, nameless options and empty options", () => {
    expect(normalizeOptions([{ name: "Size", values: ["M", "m"] }])).toEqual({
      error: '"Size" lists "m" twice.',
    });
    expect(normalizeOptions([{ name: "", values: ["S"] }])).toHaveProperty(
      "error",
    );
    expect(normalizeOptions([{ name: "Size", values: [] }])).toHaveProperty(
      "error",
    );
    expect(
      normalizeOptions([
        { name: "Size", values: ["S"] },
        { name: "size", values: ["M"] },
      ]),
    ).toHaveProperty("error");
  });

  it("refuses a value containing the name separator", () => {
    expect(
      normalizeOptions([{ name: "Size", values: ["S/M"] }]),
    ).toHaveProperty("error");
  });

  it("caps options and the combination count", () => {
    const four = ["A", "B", "C", "D"].map((n) => ({ name: n, values: ["x"] }));
    expect(normalizeOptions(four)).toHaveProperty("error");
    const big = [
      { name: "A", values: Array.from({ length: 11 }, (_, i) => `a${i}`) },
      { name: "B", values: Array.from({ length: 10 }, (_, i) => `b${i}`) },
    ];
    expect(11 * 10).toBeGreaterThan(MAX_VARIANTS);
    expect(normalizeOptions(big)).toHaveProperty("error");
  });
});

describe("combinations and names", () => {
  it("orders the first axis slowest", () => {
    expect(allCombinations([SIZE, COLOUR]).map(composeVariantName)).toEqual([
      "S / Black",
      "S / Tan",
      "M / Black",
      "M / Tan",
      "L / Black",
      "L / Tan",
    ]);
  });

  it("validates each variant has a unique, complete combination", () => {
    expect(validateVariantCombos([SIZE], [{ option_values: ["m"] }])).toEqual({
      values: [["M"]],
    });
    expect(
      validateVariantCombos([SIZE, COLOUR], [{ option_values: ["M"] }]),
    ).toHaveProperty("error");
    expect(
      validateVariantCombos([SIZE], [{ option_values: ["XL"] }]),
    ).toHaveProperty("error");
    expect(
      validateVariantCombos(
        [SIZE],
        [{ option_values: ["M"] }, { option_values: ["m"] }],
      ),
    ).toEqual({ error: 'Two variants are both "M".' });
  });
});

describe("optionValuesForName", () => {
  it("reads a composed name back into its combination", () => {
    expect(optionValuesForName([SIZE, COLOUR], " m /BLACK ")).toEqual([
      "M",
      "Black",
    ]);
    expect(optionValuesForName([SIZE, COLOUR], "M")).toBeNull();
    expect(optionValuesForName([SIZE, COLOUR], "XL / Black")).toBeNull();
    expect(optionValuesForName([], "M")).toBeNull();
  });
});

describe("generateVariantRows", () => {
  type Row = {
    id?: string;
    name: string;
    option_values?: string[];
    stock: number;
  };
  const blank = (): Row => ({ name: "", stock: 0 });

  it("keeps legacy free-text rows that match the first option", () => {
    const rows = generateVariantRows(
      [SIZE],
      [
        { id: "s", name: "S", stock: 4 },
        { id: "x", name: "XXL", stock: 9 },
      ],
      blank,
    );
    expect(rows.map((r) => [r.id, r.name, r.stock])).toEqual([
      ["s", "S", 4],
      [undefined, "M", 0],
      [undefined, "L", 0],
    ]);
  });

  it("gives existing rows the FIRST value of a newly added option", () => {
    const rows = generateVariantRows(
      [SIZE, COLOUR],
      [{ id: "m", name: "M", option_values: ["M"], stock: 3 }],
      blank,
    );
    const kept = rows.find((r) => r.id === "m");
    expect(kept?.name).toBe("M / Black");
    expect(kept?.option_values).toEqual(["M", "Black"]);
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.id)).toHaveLength(1);
  });

  it("preserves every existing row when a value is added", () => {
    const before = generateVariantRows([SIZE], [], blank).map((r, i) => ({
      ...r,
      id: `v${i}`,
    }));
    const after = generateVariantRows(
      [{ name: "Size", values: ["S", "M", "L", "XL"] }],
      before,
      blank,
    );
    expect(after.map((r) => r.id)).toEqual(["v0", "v1", "v2", undefined]);
  });
});

describe("storefront selection", () => {
  const variants = [
    { id: "sb", option_values: ["S", "Black"], available: true },
    { id: "st", option_values: ["S", "Tan"], available: false },
    { id: "mb", option_values: ["M", "Black"], available: true },
    { id: "mt", option_values: ["M", "Tan"], available: true },
    // No L / Black exists at all.
    { id: "lt", option_values: ["L", "Tan"], available: true },
  ];

  it("uses pickers only when every variant has a valid combination", () => {
    expect(usesOptionPickers([SIZE, COLOUR], variants)).toBe(true);
    expect(
      usesOptionPickers([SIZE, COLOUR], [...variants, { option_values: [] }]),
    ).toBe(false);
    expect(usesOptionPickers([], variants)).toBe(false);
  });

  it("finds a combination and reports each value's state", () => {
    expect(findVariant(variants, ["M", "Tan"])?.id).toBe("mt");
    expect(valueStates([SIZE, COLOUR], variants, ["S", "Black"], 1)).toEqual([
      { value: "Black", exists: true, available: true },
      { value: "Tan", exists: true, available: false },
    ]);
    expect(valueStates([SIZE, COLOUR], variants, ["M", "Black"], 0)).toEqual([
      { value: "S", exists: true, available: true },
      { value: "M", exists: true, available: true },
      { value: "L", exists: false, available: false },
    ]);
  });

  it("moves to the nearest available variant instead of a dead end", () => {
    // S / Black selected; pick L → L / Black does not exist → L / Tan.
    expect(selectValue(variants, ["S", "Black"], 0, "L")?.id).toBe("lt");
    // M / Black selected; pick Tan → M / Tan exists and is available.
    expect(selectValue(variants, ["M", "Black"], 1, "Tan")?.id).toBe("mt");
  });

  it("selects a sold-out combination that exists rather than swapping another pick", () => {
    // S / Black selected; pick Tan → S / Tan exists but is sold out. The
    // shopper asked for S in Tan, so that is what the page shows, sold out.
    expect(selectValue(variants, ["S", "Black"], 1, "Tan")?.id).toBe("st");
  });

  it("prefers an available variant when the combination does not exist", () => {
    // L / Black does not exist; of the L variants, the available one wins.
    const lSoldOut = [
      ...variants,
      { id: "lx", option_values: ["L", "Grey"], available: false },
    ];
    expect(selectValue(lSoldOut, ["S", "Black"], 0, "L")?.id).toBe("lt");
  });

  it("opens on the requested variant, else the first available", () => {
    expect(initialVariant(variants, "mt")?.id).toBe("mt");
    expect(initialVariant(variants, "missing")?.id).toBe("sb");
    const firstSoldOut = [
      { id: "a", available: false },
      { id: "b", available: true },
    ];
    expect(initialVariant(firstSoldOut)?.id).toBe("b");
    expect(initialVariant([{ id: "a", available: false }])?.id).toBe("a");
  });

  it("names the swatch axis", () => {
    expect(swatchAxis([SIZE, COLOUR])).toBe(1);
    expect(swatchAxis([SIZE])).toBe(-1);
  });
});
