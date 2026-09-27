import { describe, expect, it } from "vitest";
import { productSlotBrief, productSlotId } from "./compiler";

const ASSET_ID_RE = /^[a-z][a-z0-9-]{0,79}$/;

describe("product slot ids", () => {
  it("names a product's slot after its brief and slug, and reads the brief back", () => {
    const id = productSlotId("product-photo", "linen-shirt");
    expect(id).toBe("product-photo--linen-shirt");
    expect(productSlotBrief(id, ["home-hero", "product-photo"])).toBe(
      "product-photo",
    );
  });

  it("prefers the longest brief a slot starts with, and rejects a bare brief", () => {
    const id = productSlotId("photo--studio", "mug");
    expect(productSlotBrief(id, ["photo", "photo--studio"])).toBe(
      "photo--studio",
    );
    expect(productSlotBrief("product-photo", ["product-photo"])).toBeNull();
    expect(productSlotBrief("product-photo--", ["product-photo"])).toBeNull();
    expect(productSlotBrief("home-hero", ["product-photo"])).toBeNull();
  });

  it("keeps a long id within the asset id rule and distinct for slugs sharing a prefix", () => {
    const brief = "catalogue-product-photography-for-the-range";
    const a = productSlotId(brief, `${"handwoven-".repeat(6)}basket-large`);
    const b = productSlotId(brief, `${"handwoven-".repeat(6)}basket-small`);
    for (const id of [a, b]) {
      expect(id.length).toBeLessThanOrEqual(80);
      expect(id).toMatch(ASSET_ID_RE);
    }
    expect(a).not.toBe(b);
    // Deterministic, so a revision that keeps the product keeps the slot.
    expect(productSlotId(brief, `${"handwoven-".repeat(6)}basket-large`)).toBe(
      a,
    );
    expect(productSlotBrief(a, [brief])).toBe(brief);
    // A brief too long to keep whole is shortened the same way both ways.
    const long = `${"range-".repeat(11)}photos`;
    const c = productSlotId(long, "mug");
    expect(c.length).toBeLessThanOrEqual(80);
    expect(c).toMatch(ASSET_ID_RE);
    expect(productSlotBrief(c, ["home-hero", long])).toBe(long);
  });
});
