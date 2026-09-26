import { describe, expect, it } from "vitest";
import { PLACEHOLDER_LICENSE_NOTE } from "./compiler";
import type { ThemePackageV2 } from "./contracts";
import { hex, placeholderPackage } from "./_test-helpers";
import {
  SLOT_IMAGE_MIN_WIDTH,
  applySlotReplacements,
  carryOverSlotImages,
  describeSlots,
  slotByteLimit,
  slotTargetSize,
  validateSlotReplacements,
  type SlotImageRow,
} from "./slot-images-core";

const ASSET = "00000000-0000-4000-8000-000000000001";

function row(overrides: Partial<SlotImageRow> = {}): SlotImageRow {
  return {
    id: ASSET,
    purpose: "image",
    sha256: hex("upload"),
    width: 1600,
    height: 1200,
    ...overrides,
  };
}

function replacement(slotId = "slot-1") {
  return {
    slotId,
    assetId: ASSET,
    alt: "A bowl of fresh berries",
    source: "operator-owned" as const,
    licenseNote: "Photographed by StoreMink",
  };
}

describe("slot descriptions", () => {
  it("lists every slot with its placeholder state and where it renders", () => {
    const pkg = placeholderPackage();
    const slots = describeSlots(pkg);
    expect(slots).toHaveLength(pkg.assets.length);
    expect(slots.every((slot) => slot.placeholder)).toBe(true);
    const preview = slots.find((slot) => slot.catalogPreview);
    expect(preview?.usage).toContain("Theme catalog card");
    expect(
      slots.some((slot) => slot.usage.some((u) => u.startsWith("Product · "))),
    ).toBe(true);
    expect(slots.filter((slot) => slot.catalogScreenshot).length).toBe(
      pkg.definition.catalog.screenshots.length,
    );
  });

  it("targets a long edge of 1600px and never below 800px wide", () => {
    expect(slotTargetSize({ width: 1600, height: 1200 })).toEqual({
      width: 1600,
      height: 1200,
      aspect: 1600 / 1200,
    });
    const tall = slotTargetSize({ width: 9, height: 19 })!;
    expect(tall.width).toBeGreaterThanOrEqual(SLOT_IMAGE_MIN_WIDTH);
    expect(tall.width / tall.height).toBeCloseTo(9 / 19, 2);
    expect(slotTargetSize({ width: null, height: 10 })).toBeNull();
  });

  it("holds the catalog card to the tighter byte limit", () => {
    expect(slotByteLimit({ catalogPreview: true })).toBe(250 * 1024);
    expect(slotByteLimit({ catalogPreview: false })).toBe(500 * 1024);
  });
});

describe("replacement input", () => {
  it("accepts a complete replacement and normalises whitespace", () => {
    const parsed = validateSlotReplacements([
      { ...replacement(), alt: "  A  bowl of berries " },
    ]);
    expect(parsed.ok && parsed.value[0].alt).toBe("A bowl of berries");
  });

  it.each([
    [[], /at least one/],
    [[{ ...replacement(), assetId: "nope" }], /unknown slot or upload/],
    [[replacement(), replacement()], /chosen twice/],
    [[{ ...replacement(), alt: "x" }], /alt text/],
    [[{ ...replacement(), source: "generated" }], /came from/],
    [[{ ...replacement(), licenseNote: "" }], /licence note/],
    [[{ ...replacement(), licenseNote: PLACEHOLDER_LICENSE_NOTE }], /reserved/],
  ])("refuses %j", (input, message) => {
    const parsed = validateSlotReplacements(input);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(message);
  });
});

describe("applying replacements", () => {
  it("produces a valid next version with the slot no longer a placeholder", () => {
    const pkg = placeholderPackage();
    const applied = applySlotReplacements(
      pkg,
      [replacement("slot-1")],
      new Map([[ASSET, row()]]),
      4,
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const slot = applied.value.assets.find((a) => a.id === "slot-1")!;
    expect(slot).toMatchObject({
      sha256: hex("upload"),
      source: "operator-owned",
      licenseNote: "Photographed by StoreMink",
      alt: "A bowl of fresh berries",
    });
    expect(applied.value.definition.release.version).toBe("0.0.4");
    expect(applied.value.definition.release.notes.at(-1)).toMatch(/slot-1/);
    // The input is not mutated.
    expect(pkg.assets.find((a) => a.id === "slot-1")!.licenseNote).toBe(
      PLACEHOLDER_LICENSE_NOTE,
    );
  });

  it("refuses a missing slot, a non-image upload and the wrong shape", () => {
    const pkg = placeholderPackage();
    const rows = new Map([[ASSET, row()]]);
    const missing = applySlotReplacements(pkg, [replacement("nope")], rows, 2);
    expect(!missing.ok && missing.error).toMatch(/no slot/);
    const reference = applySlotReplacements(
      pkg,
      [replacement()],
      new Map([[ASSET, row({ purpose: "reference" })]]),
      2,
    );
    expect(!reference.ok && reference.error).toMatch(/no longer exists/);
    const square = applySlotReplacements(
      pkg,
      [replacement()],
      new Map([[ASSET, row({ width: 1200, height: 1200 })]]),
      2,
    );
    expect(!square.ok && square.error).toMatch(/wrong shape/);
  });

  it("gives a replaced screenshot the new alt text, which must be 15+ characters", () => {
    const pkg = placeholderPackage();
    const desktop = pkg.definition.catalog.screenshots.find(
      (s) => s.viewport === "desktop",
    )!;
    const slotId = pkg.assets.find((a) => a.path === desktop.src)!.id;
    const short = applySlotReplacements(
      pkg,
      [{ ...replacement(slotId), alt: "Too short" }],
      new Map([[ASSET, row()]]),
      2,
    );
    expect(!short.ok && short.error).toMatch(/15 characters/);
    const ok = applySlotReplacements(
      pkg,
      [{ ...replacement(slotId), alt: "Storefront homepage on a laptop" }],
      new Map([[ASSET, row()]]),
      2,
    );
    expect(ok.ok).toBe(true);
    expect(
      ok.ok &&
        ok.value.definition.catalog.screenshots.find(
          (s) => s.src === desktop.src,
        )!.alt,
    ).toBe("Storefront homepage on a laptop");
  });
});

describe("carrying images into a revision", () => {
  function withImage(pkg: ThemePackageV2, slotId: string): ThemePackageV2 {
    const applied = applySlotReplacements(
      pkg,
      [replacement(slotId)],
      new Map([[ASSET, row()]]),
      2,
    );
    if (!applied.ok) throw new Error(applied.error);
    return applied.value;
  }

  it("keeps an uploaded image for a slot with the same id and shape", () => {
    const base = withImage(placeholderPackage(), "slot-1");
    const revised = placeholderPackage();
    const kept = carryOverSlotImages(revised, base);
    expect(kept.carried).toEqual(["slot-1"]);
    expect(kept.value.assets.find((a) => a.id === "slot-1")!.sha256).toBe(
      hex("upload"),
    );
    // Placeholders stay placeholders.
    expect(kept.value.assets.find((a) => a.id === "slot-2")!.licenseNote).toBe(
      PLACEHOLDER_LICENSE_NOTE,
    );
  });

  it("does not carry an image into a slot the revision reshaped", () => {
    const base = withImage(placeholderPackage(), "slot-1");
    const revised = placeholderPackage();
    revised.assets = revised.assets.map((a) =>
      a.id === "slot-1" ? { ...a, width: 1200, height: 1200 } : a,
    );
    expect(carryOverSlotImages(revised, base).carried).toEqual([]);
  });

  it("carries nothing from a base with no uploaded images", () => {
    const base = placeholderPackage();
    const revised = placeholderPackage();
    const kept = carryOverSlotImages(revised, base);
    expect(kept.carried).toEqual([]);
    expect(kept.value).toBe(revised);
  });
});
