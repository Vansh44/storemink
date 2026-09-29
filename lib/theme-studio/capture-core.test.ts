import { describe, expect, it } from "vitest";
import {
  CAPTURED_LICENSE_NOTE,
  applyCapturedImages,
  captureBlockers,
  captureShots,
} from "./capture-core";
import { PLACEHOLDER_LICENSE_NOTE } from "./compiler";
import { validateThemePackageV2, type ThemePackageV2 } from "./contracts";
import { createFakeModelClient } from "./fake-provider";
import { runThemeGeneration } from "./pipeline";

let built: Promise<ThemePackageV2> | null = null;

/** The offline theme: every slot a placeholder. Built once, copied per test. */
async function fixture(): Promise<ThemePackageV2> {
  built ??= (async () => {
    const base = {
      name: "Clay & Co",
      brief: "A calm ceramics shop.",
      industries: ["home" as const],
      catalogSizes: ["small" as const],
      requiredFeatures: [],
      referenceCount: 0,
    };
    const outcome = await runThemeGeneration(
      createFakeModelClient(base),
      {
        facts: {
          name: base.name,
          themeId: "clay-co",
          industries: ["home"],
          catalogSizes: ["small"],
          requiredFeatures: [],
          baseThemeName: null,
        },
        compile: {
          themeId: "clay-co",
          name: base.name,
          industries: ["home"],
          catalogSizes: ["small"],
          requiredFeatures: [],
          baseEngine: null,
          versionNumber: 1,
          modelKey: "gemini-3.8-flash",
          modelLabel: "Gemini 3.8 Flash",
          referenceDigests: [],
        },
        providerModel: "fake",
        promptVersion: "test",
        messages: [{ kind: "brief", body: base.brief }],
        references: [],
      },
      new AbortController().signal,
    );
    if (outcome.kind !== "version") throw new Error(outcome.kind);
    return outcome.package;
  })();
  return structuredClone(await built);
}

/** The fixture with every art slot holding a real (generated) image. */
async function drawn(): Promise<ThemePackageV2> {
  const pkg = await fixture();
  const catalog = new Set([
    pkg.definition.catalog.previewImage,
    ...pkg.definition.catalog.screenshots.map((s) => s.src),
  ]);
  for (const asset of pkg.assets) {
    if (!catalog.has(asset.path)) {
      asset.licenseNote = "Generated for this theme.";
    }
  }
  return pkg;
}

describe("what a capture photographs", () => {
  it("shoots the card and both screenshots, each rendered larger than its slot", async () => {
    const shots = captureShots(await fixture());
    expect(shots.map((s) => s.slotId)).toEqual([
      "preview",
      "screenshot-desktop",
      "screenshot-mobile",
    ]);
    const bySlot = new Map(shots.map((s) => [s.slotId, s]));
    expect(bySlot.get("preview")).toMatchObject({
      viewport: { width: 1280, height: 960 },
      deviceScaleFactor: 2,
      mobile: false,
      path: "/",
    });
    expect(bySlot.get("screenshot-desktop")).toMatchObject({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      mobile: false,
    });
    expect(bySlot.get("screenshot-mobile")).toMatchObject({
      viewport: { width: 390, height: 823 },
      deviceScaleFactor: 3,
      mobile: true,
    });
    // The crop step never upscales, so every render must cover its slot.
    for (const shot of shots) {
      expect(
        shot.viewport.width * shot.deviceScaleFactor,
      ).toBeGreaterThanOrEqual(shot.target.width);
      expect(
        shot.viewport.height * shot.deviceScaleFactor,
      ).toBeGreaterThanOrEqual(shot.target.height);
      expect(shot.viewport.width / shot.viewport.height).toBeCloseTo(
        shot.target.aspect,
        2,
      );
    }
    expect(bySlot.get("preview")!.byteLimit).toBeLessThan(
      bySlot.get("screenshot-desktop")!.byteLimit,
    );
  });

  it("names the pictures without calling them placeholders", async () => {
    const shots = captureShots(await fixture());
    expect(shots.map((s) => s.alt)).toEqual([
      "Clay & Co: the storefront home page",
      "Clay & Co storefront on desktop",
      "Clay & Co storefront on mobile",
    ]);
  });
});

describe("when a capture would be pointless", () => {
  it("blocks legacy packages whose categories have no images even when all art slots are drawn", async () => {
    const pkg = await drawn();
    const category = pkg.definition.preset.sampleData!.categories![0];
    delete category.image_url;
    expect(captureBlockers(pkg)).toEqual([
      `1 categories have no image slot. Revise the theme to add imagery for: ${category.name}.`,
    ]);
  });

  it("waits while any art slot is still a placeholder", async () => {
    const blockers = captureBlockers(await fixture());
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/still a placeholder/);
  });

  it("has nothing to say once the art is real, whatever the catalog pictures are", async () => {
    expect(captureBlockers(await drawn())).toEqual([]);
  });

  it("refuses a version with no catalog pictures to take", async () => {
    const pkg = await drawn();
    pkg.definition.catalog.previewImage = "/themes/x/card.webp";
    pkg.definition.catalog.screenshots = [];
    // No longer catalog pictures, those slots would count as art.
    for (const asset of pkg.assets) asset.licenseNote = "Real image.";
    expect(captureBlockers(pkg)).toEqual([
      "This version has no catalog card or screenshot to capture.",
    ]);
  });
});

describe("the next version's package", () => {
  it("puts the captured pictures in, as StoreMink's own, with real alt text", async () => {
    const pkg = await drawn();
    const shots = captureShots(pkg);
    const captured = shots.map((shot, i) => ({
      slotId: shot.slotId,
      row: {
        id: `asset-${i}`,
        purpose: "image",
        sha256: String(i).repeat(64).slice(0, 64),
        width: shot.target.width,
        height: shot.target.height,
      },
    }));
    const applied = applyCapturedImages(pkg, captured, 4);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    for (const { slotId, row } of captured) {
      const asset = applied.value.assets.find((a) => a.id === slotId)!;
      expect(asset).toMatchObject({
        sha256: row.sha256,
        source: "operator-owned",
        licenseNote: CAPTURED_LICENSE_NOTE,
      });
      expect(asset.licenseNote).not.toBe(PLACEHOLDER_LICENSE_NOTE);
    }
    expect(
      applied.value.definition.catalog.screenshots.map((s) => s.alt),
    ).toEqual([
      "Clay & Co storefront on desktop",
      "Clay & Co storefront on mobile",
    ]);
    expect(applied.value.definition.release.version).toBe("0.0.4");
    expect(applied.value.definition.release.notes.at(-1)).toBe(
      "Catalog pictures captured from the preview: preview, screenshot-desktop, screenshot-mobile.",
    );
    expect(
      validateThemePackageV2(JSON.parse(JSON.stringify(applied.value))).ok,
    ).toBe(true);
  });

  it("refuses a picture of the wrong shape and an empty capture", async () => {
    const pkg = await drawn();
    const [card] = captureShots(pkg);
    expect(
      applyCapturedImages(
        pkg,
        [
          {
            slotId: card.slotId,
            row: {
              id: "a",
              purpose: "image",
              sha256: "a".repeat(64),
              width: 1600,
              height: 1600,
            },
          },
        ],
        2,
      ).ok,
    ).toBe(false);
    expect(applyCapturedImages(pkg, [], 2).ok).toBe(false);
  });
});
