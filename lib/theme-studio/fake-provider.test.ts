import { describe, expect, it } from "vitest";
import { validateThemeIntent } from "./contracts";
import { runFakeProvider } from "./fake-provider";

const base = {
  name: "Clay & Co",
  brief: "A calm ceramics shop. It should feel handmade.",
  industries: ["home" as const],
  catalogSizes: ["small" as const],
  requiredFeatures: [],
  referenceCount: 2,
};

describe("fake provider", () => {
  it("produces an intent the real contract accepts", () => {
    const result = runFakeProvider(base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(validateThemeIntent(result.value)).toEqual({
      ok: true,
      value: result.value,
    });
    expect(result.value.summary).toBe("Clay & Co: A calm ceramics shop.");
  });

  it("labels its output as fake so it can't be mistaken for analysis", () => {
    const result = runFakeProvider(base);
    expect(result.ok && result.value.assumptions[0]).toMatch(
      /no model was called/i,
    );
  });

  it("stays valid across the whole intake vocabulary and a maximal brief", () => {
    const result = runFakeProvider({
      ...base,
      brief: "x".repeat(12_000),
      industries: ["food-and-drink", "wellness", "home", "kids", "pets"],
      catalogSizes: ["one-product", "small", "medium", "large"],
      requiredFeatures: ["faq", "blogs", "quick-add"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary.length).toBeLessThanOrEqual(1_000);
      expect(result.value.pagePlans[0].sectionTypes).toContain("faq_accordion");
      expect(result.value.pagePlans[0].sectionTypes).toContain(
        "shop_by_category",
      );
    }
  });

  it("fails closed through the validator when asked for invalid output", () => {
    const result = runFakeProvider({ ...base, failWith: "invalid_output" });
    expect(result.ok).toBe(false);
  });
});
