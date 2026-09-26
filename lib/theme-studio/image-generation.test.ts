import { describe, expect, it, vi } from "vitest";
import { PLACEHOLDER_LICENSE_NOTE, productSlotId } from "./compiler";
import {
  validateThemePackageV2,
  type ThemeIntent,
  type ThemePackageV2,
} from "./contracts";
import { createFakeModelClient } from "./fake-provider";
import { createFakeImageClient } from "./image-fake";
import { runThemeImageGeneration } from "./image-generation";
import {
  GENERATED_LICENSE_NOTE,
  applyGeneratedImages,
  directionFromPackage,
  generatableSlots,
  nearestImageRatio,
} from "./image-generation-core";
import {
  ZERO_IMAGE_USAGE,
  type ThemeImageRequest,
  type ThemeImageResult,
  type ThemeStudioImageClient,
} from "./image-provider";
import { runThemeGeneration } from "./pipeline";
import { describeSlots } from "./slot-images-core";

/** Every image run here pushes a dozen real images through sharp, which on a
 *  loaded parallel suite runs past the default 5s (slot-images.test.ts sets
 *  the same ceiling for the same reason). */
const IMAGE_RUN_TIMEOUT_MS = 20_000;

let built: Promise<{ pkg: ThemePackageV2; intent: ThemeIntent }> | null = null;

/** The offline theme, built once; every test gets its own copy. */
async function fixture(): Promise<{
  pkg: ThemePackageV2;
  intent: ThemeIntent;
}> {
  built ??= buildFixture();
  return structuredClone(await built);
}

async function buildFixture(): Promise<{
  pkg: ThemePackageV2;
  intent: ThemeIntent;
}> {
  const base = {
    name: "Clay & Co",
    brief: "A calm ceramics shop. It should feel handmade.",
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
      promptVersion: "theme-studio-v1",
      messages: [{ kind: "brief", body: base.brief }],
      references: [],
    },
    new AbortController().signal,
  );
  if (outcome.kind !== "version") throw new Error(outcome.kind);
  return { pkg: outcome.package, intent: outcome.intent };
}

/** The fake theme has a hero slot and one slot per product; this adds a
 *  product slot no product uses, a category and an editorial slot (each a
 *  placeholder with a brief), so ordering and concurrency have more to act
 *  on. */
async function richFixture(): Promise<{
  pkg: ThemePackageV2;
  intent: ThemeIntent;
}> {
  const { pkg, intent } = await fixture();
  const rich = structuredClone(pkg);
  const template = rich.assets.find(
    (a) => a.licenseNote === PLACEHOLDER_LICENSE_NOTE && a.kind === "hero",
  )!;
  const extra = [
    {
      id: "product-mug",
      kind: "product" as const,
      w: 1280,
      h: 1600,
      ratio: "4:5",
    },
    {
      id: "category-bowls",
      kind: "category" as const,
      w: 1600,
      h: 1600,
      ratio: "1:1",
    },
    {
      id: "content-studio",
      kind: "content" as const,
      w: 1600,
      h: 1067,
      ratio: "3:2",
    },
  ];
  for (const e of extra) {
    rich.assets.push({
      ...template,
      id: e.id,
      path: `theme-asset://${e.id}`,
      kind: e.kind,
      width: e.w,
      height: e.h,
      alt: `${e.id} alt`,
    });
  }
  return {
    pkg: rich,
    intent: {
      ...intent,
      assetBriefs: [
        ...intent.assetBriefs,
        ...extra.map((e) => ({
          id: e.id,
          purpose: e.kind,
          subject: `A ${e.id}`,
          aspectRatio: e.ratio,
          artDirection: "",
          source: "generate" as const,
        })),
      ],
    },
  };
}

/** An image client scripted per brief id; everything else draws normally. */
function scripted(
  overrides: Record<string, Partial<ThemeImageResult>>,
  seen: ThemeImageRequest[] = [],
): ThemeStudioImageClient {
  const fake = createFakeImageClient();
  return {
    provider: "fake",
    async generateImage(request, signal) {
      seen.push(request);
      const override = overrides[request.briefId];
      if (override?.kind === "refused" || override?.kind === "error") {
        return {
          usage: { inputTokens: 10, outputTokens: 20 },
          ...override,
        } as ThemeImageResult;
      }
      const result = await fake.generateImage(request, signal);
      return result.kind === "ok"
        ? { ...result, usage: { inputTokens: 100, outputTokens: 1680 } }
        : result;
    },
  };
}

describe("choosing what to draw", () => {
  it("draws every placeholder art slot and never the catalog card or screenshots", async () => {
    const { pkg, intent } = await fixture();
    const slots = generatableSlots(pkg, intent);
    expect(slots.length).toBeGreaterThan(0);
    const described = new Map(describeSlots(pkg).map((s) => [s.id, s]));
    for (const slot of slots) {
      const d = described.get(slot.slotId)!;
      expect(d.placeholder).toBe(true);
      expect(d.catalogPreview || d.catalogScreenshot).toBe(false);
      expect(["hero", "product", "category", "content"]).toContain(
        slot.purpose,
      );
    }
    const ids = slots.map((s) => s.slotId);
    expect(ids).not.toContain("preview");
    expect(ids).not.toContain("screenshot-desktop");
  });

  it("takes the subject and ratio from the version's brief", async () => {
    const { pkg, intent } = await fixture();
    const [first] = generatableSlots(pkg, intent);
    const brief = intent.assetBriefs.find((b) => b.id === first.slotId)!;
    expect(first.brief.subject).toBe(brief.subject);
    expect(first.brief.aspectRatio).toBe(brief.aspectRatio);
  });

  it("describes a slot with no brief by its alt text", async () => {
    const { pkg, intent } = await fixture();
    const [first] = generatableSlots(pkg, { ...intent, assetBriefs: [] });
    const alt = pkg.assets.find((a) => a.id === first.slotId)!.alt;
    expect(first.brief.subject).toBe(alt);
  });

  it("never redraws a slot an operator already filled", async () => {
    const { pkg, intent } = await fixture();
    const [first] = generatableSlots(pkg, intent);
    const filled = structuredClone(pkg);
    const asset = filled.assets.find((a) => a.id === first.slotId)!;
    asset.source = "operator-owned";
    asset.licenseNote = "Our own photography.";
    expect(generatableSlots(filled, intent).map((s) => s.slotId)).not.toContain(
      first.slotId,
    );
  });

  it("asks for the accepted ratio nearest a slot's own shape", () => {
    expect(nearestImageRatio(16 / 10)).toBe("3:2");
    expect(nearestImageRatio(9 / 19)).toBe("9:16");
    expect(nearestImageRatio(1)).toBe("1:1");
    expect(nearestImageRatio(2.4)).toBe("21:9");
  });

  it("reads the theme's direction from the version, with the brand colour as a fallback accent", async () => {
    const { pkg, intent } = await fixture();
    const direction = directionFromPackage(pkg, intent);
    expect(direction.themeName).toBe(pkg.definition.name);
    expect(direction.summary).toBe(intent.summary);
    expect(direction.palette.page).toBe(
      pkg.definition.preset.design.palette.cream,
    );
    const noAccent = structuredClone(pkg);
    delete noAccent.definition.preset.design.palette.accent;
    expect(directionFromPackage(noAccent, intent).palette.accent).toBe(
      pkg.definition.preset.brand.primaryColor,
    );
  });
});

describe("product photographs", () => {
  it("gives every product its own slot, made from the range's photography brief", async () => {
    const { pkg } = await fixture();
    const products = pkg.definition.preset.sampleData!.products;
    expect(products.length).toBeGreaterThanOrEqual(8);
    const paths = products.map((p) => p.image_url);
    expect(new Set(paths).size).toBe(products.length);
    for (const product of products) {
      expect(product.image_url).toBe(
        `theme-asset://${productSlotId("product-photo", product.slug)}`,
      );
      const asset = pkg.assets.find((a) => a.path === product.image_url)!;
      expect(asset.kind).toBe("product");
      expect(asset.alt).toBe(product.name);
      // The range brief's 4:5, not the hero's 16:9.
      expect(asset.width! / asset.height!).toBeCloseTo(4 / 5, 2);
    }
    // The range brief is a recipe, not an image of its own.
    expect(pkg.assets.map((a) => a.id)).not.toContain("product-photo");
  });

  it("describes a product's slot by that product, staged by the range brief", async () => {
    const { pkg, intent } = await fixture();
    const range = intent.assetBriefs.find((b) => b.id === "product-photo")!;
    const product = pkg.definition.preset.sampleData!.products[1];
    const slot = generatableSlots(pkg, intent).find(
      (s) => `theme-asset://${s.slotId}` === product.image_url,
    )!;
    expect(slot.purpose).toBe("product");
    expect(slot.brief.subject).toBe(`${product.name}. ${product.description}`);
    expect(slot.brief.artDirection).toBe(
      `Range staging: ${range.subject}. ${range.artDirection}`,
    );
    expect(slot.brief.purpose).toBe(range.purpose);
    expect(slot.brief.aspectRatio).toBe("4:5");
  });

  it("describes a slot several products still share by its brief, never by one of them", async () => {
    const { pkg, intent } = await richFixture();
    const shared = structuredClone(pkg);
    const products = shared.definition.preset.sampleData!.products;
    products[0].image_url = "theme-asset://product-mug";
    products[1].image_url = "theme-asset://product-mug";
    const slot = generatableSlots(shared, intent).find(
      (s) => s.slotId === "product-mug",
    )!;
    expect(slot.brief.subject).toBe("A product-mug");
  });
});

describe("the image run", { timeout: IMAGE_RUN_TIMEOUT_MS }, () => {
  it("draws the anchor first, then matches every later product to the first product shot", async () => {
    const { pkg, intent } = await fixture();
    const seen: ThemeImageRequest[] = [];
    const result = await runThemeImageGeneration(
      scripted({}, seen),
      { pkg, intent },
      new AbortController().signal,
    );
    const slots = generatableSlots(pkg, intent);
    const productIds = slots
      .filter((s) => s.purpose === "product")
      .map((s) => s.slotId);
    expect(productIds.length).toBeGreaterThanOrEqual(8);
    expect(seen[0].purpose).toBe("anchor");
    expect(seen).toHaveLength(slots.length + 1);
    const roles = (id: string) =>
      seen.find((r) => r.briefId === id)!.references.map((r) => r.role);
    // The leader is matched to the anchor only; every other product to both.
    expect(roles(productIds[0])).toEqual(["anchor"]);
    for (const id of productIds.slice(1)) {
      expect(roles(id)).toEqual(["anchor", "set"]);
    }
    for (const slot of slots.filter((s) => s.purpose !== "product")) {
      expect(roles(slot.slotId)).toEqual(["anchor"]);
    }
    // The set shot is the leader's own full-quality image.
    const fake = createFakeImageClient();
    const leader = await fake.generateImage(
      seen.find((r) => r.briefId === productIds[0])!,
      new AbortController().signal,
    );
    if (leader.kind !== "ok") throw new Error("fake failed");
    const setRef = seen
      .find((r) => r.briefId === productIds[1])!
      .references.find((r) => r.role === "set")!;
    expect(setRef.base64).toBe(Buffer.from(leader.bytes).toString("base64"));
    expect(result.anchorFailure).toBeNull();
    expect(result.anchor).not.toBeNull();
    expect(result.images.map((i) => i.slotId)).toEqual(
      slots.map((s) => s.slotId),
    );
    expect(result.outcomes.every((o) => o.status === "generated")).toBe(true);
    // Each image is cropped to its slot's exact shape and fits its size limit.
    for (const { slotId, image } of result.images) {
      const slot = slots.find((s) => s.slotId === slotId)!;
      expect(image.width / image.height).toBeCloseTo(slot.target.aspect, 2);
      expect(image.bytes.byteLength).toBeLessThanOrEqual(slot.byteLimit);
      expect(image.mediaType).toBe("image/webp");
    }
    expect(result.telemetry.estimatedCostMicroUsd).toBe(
      (slots.length + 1) * (100 * 0.5 + 1680 * 60),
    );
  });

  it("makes the next kept product the set shot when the first is refused", async () => {
    const { pkg, intent } = await fixture();
    const productIds = generatableSlots(pkg, intent)
      .filter((s) => s.purpose === "product")
      .map((s) => s.slotId);
    const seen: ThemeImageRequest[] = [];
    const result = await runThemeImageGeneration(
      scripted(
        { [productIds[0]]: { kind: "refused", reason: "SAFETY" } },
        seen,
      ),
      { pkg, intent },
      new AbortController().signal,
    );
    const roles = (id: string) =>
      seen.find((r) => r.briefId === id)!.references.map((r) => r.role);
    expect(roles(productIds[0])).toEqual(["anchor"]);
    expect(roles(productIds[1])).toEqual(["anchor"]);
    for (const id of productIds.slice(2)) {
      expect(roles(id)).toEqual(["anchor", "set"]);
    }
    expect(
      result.outcomes.find((o) => o.slotId === productIds[0])?.status,
    ).toBe("refused");
  });

  it("matches products to the anchor alone when no product shot comes back", async () => {
    const { pkg, intent } = await fixture();
    const productIds = generatableSlots(pkg, intent)
      .filter((s) => s.purpose === "product")
      .map((s) => s.slotId);
    const seen: ThemeImageRequest[] = [];
    await runThemeImageGeneration(
      scripted(
        Object.fromEntries(
          productIds.map((id) => [
            id,
            { kind: "error" as const, code: "provider_unavailable" as const },
          ]),
        ),
        seen,
      ),
      { pkg, intent },
      new AbortController().signal,
    );
    for (const id of productIds) {
      expect(
        seen.find((r) => r.briefId === id)!.references.map((r) => r.role),
      ).toEqual(["anchor"]);
    }
  });

  it("starts the other slots while the first product shot is still being drawn", async () => {
    const { pkg, intent } = await richFixture();
    const slots = generatableSlots(pkg, intent);
    const leader = slots.find((s) => s.purpose === "product")!.slotId;
    const others = new Set(
      slots.filter((s) => s.purpose !== "product").map((s) => s.slotId),
    );
    const fake = createFakeImageClient();
    const order: string[] = [];
    const client: ThemeStudioImageClient = {
      provider: "fake",
      async generateImage(request, signal) {
        order.push(`start:${request.briefId}`);
        if (request.briefId === leader) {
          await new Promise((r) => setTimeout(r, 200));
        }
        const result = await fake.generateImage(request, signal);
        order.push(`end:${request.briefId}`);
        return result;
      },
    };
    await runThemeImageGeneration(
      client,
      { pkg, intent },
      new AbortController().signal,
    );
    const leaderEnd = order.indexOf(`end:${leader}`);
    const otherStarts = order
      .map((e, i) =>
        e.startsWith("start:") && others.has(e.slice(6)) ? i : -1,
      )
      .filter((i) => i >= 0);
    expect(otherStarts.length).toBe(others.size);
    expect(Math.min(...otherStarts)).toBeLessThan(leaderEnd);
    // No other product starts before the leader is back.
    const productStarts = order
      .map((e, i) =>
        e.startsWith("start:") &&
        !others.has(e.slice(6)) &&
        e.slice(6) !== leader &&
        e !== "start:anchor"
          ? i
          : -1,
      )
      .filter((i) => i >= 0);
    expect(Math.min(...productStarts)).toBeGreaterThan(leaderEnd);
  });

  it("draws nothing else when the anchor is refused, and records the spent call", async () => {
    const { pkg, intent } = await fixture();
    const seen: ThemeImageRequest[] = [];
    const result = await runThemeImageGeneration(
      scripted({ anchor: { kind: "refused", reason: "IMAGE_SAFETY" } }, seen),
      { pkg, intent },
      new AbortController().signal,
    );
    expect(seen).toHaveLength(1);
    expect(result.anchorFailure).toEqual({
      kind: "refused",
      reason: "IMAGE_SAFETY",
    });
    expect(result.images).toEqual([]);
    expect(result.outcomes.every((o) => o.status === "skipped")).toBe(true);
    expect(result.telemetry.calls).toHaveLength(1);
    expect(result.telemetry.totals).toEqual({
      inputTokens: 10,
      outputTokens: 20,
    });
  });

  it("a refused or failed slot keeps its placeholder while the rest are drawn", async () => {
    const { pkg, intent } = await fixture();
    const slots = generatableSlots(pkg, intent);
    const [first] = slots;
    const result = await runThemeImageGeneration(
      scripted({ [first.slotId]: { kind: "refused", reason: "SAFETY" } }),
      { pkg, intent },
      new AbortController().signal,
    );
    expect(result.outcomes.find((o) => o.slotId === first.slotId)).toEqual({
      slotId: first.slotId,
      status: "refused",
      reason: "SAFETY",
    });
    expect(result.images.map((i) => i.slotId)).not.toContain(first.slotId);
    expect(result.images).toHaveLength(slots.length - 1);
    // The refused call is still counted: it may have been billed.
    expect(result.telemetry.calls).toHaveLength(slots.length + 1);
  });

  it("an image the crop cannot use is recorded as unusable", async () => {
    const { pkg, intent } = await fixture();
    const [first] = generatableSlots(pkg, intent);
    const prepare = vi.fn(async (bytes: Uint8Array, target, limit: number) => {
      const { prepareSlotImage } = await import("./slot-images");
      if (
        target.aspect === 4 / 3 &&
        limit > 0 &&
        prepare.mock.calls.length === 1
      ) {
        return prepareSlotImage(bytes, target, limit); // the anchor
      }
      return { ok: false as const, code: "too_small" as const };
    });
    const result = await runThemeImageGeneration(
      createFakeImageClient(),
      { pkg, intent },
      new AbortController().signal,
      { prepare },
    );
    expect(result.outcomes.find((o) => o.slotId === first.slotId)).toEqual({
      slotId: first.slotId,
      status: "unusable",
      code: "too_small",
    });
    expect(result.images).toEqual([]);
  });

  it("never draws more at once than its concurrency", async () => {
    const { pkg, intent } = await richFixture();
    expect(generatableSlots(pkg, intent).length).toBeGreaterThanOrEqual(4);
    let active = 0;
    let peak = 0;
    const fake = createFakeImageClient();
    const client: ThemeStudioImageClient = {
      provider: "fake",
      async generateImage(request, signal) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return fake.generateImage(request, signal);
      },
    };
    await runThemeImageGeneration(
      client,
      { pkg, intent },
      new AbortController().signal,
      { concurrency: 2 },
    );
    expect(peak).toBe(2);
  });

  it("returns images in package order whatever order they finish in", async () => {
    const { pkg, intent } = await richFixture();
    const slots = generatableSlots(pkg, intent);
    const fake = createFakeImageClient();
    const client: ThemeStudioImageClient = {
      provider: "fake",
      async generateImage(request, signal) {
        // The first slot finishes last.
        if (request.briefId === slots[0].slotId) {
          await new Promise((r) => setTimeout(r, 1500));
        }
        return fake.generateImage(request, signal);
      },
    };
    const result = await runThemeImageGeneration(
      client,
      { pkg, intent },
      new AbortController().signal,
    );
    expect(result.images.map((i) => i.slotId)).toEqual(
      slots.map((s) => s.slotId),
    );
  });

  it("asks for the ratio of each slot's own shape", async () => {
    const { pkg, intent } = await richFixture();
    const byId = new Map(
      generatableSlots(pkg, intent).map((s) => [s.slotId, s.brief.aspectRatio]),
    );
    expect(byId.get("product-mug")).toBe("4:5");
    expect(byId.get("category-bowls")).toBe("1:1");
    expect(byId.get("content-studio")).toBe("3:2");
  });

  it("never draws a slot shown as a catalog screenshot, even an art slot", async () => {
    const { pkg, intent } = await richFixture();
    const shown = structuredClone(pkg);
    shown.definition.catalog.screenshots[0] = {
      ...shown.definition.catalog.screenshots[0],
      src: "theme-asset://product-mug",
    };
    expect(generatableSlots(shown, intent).map((s) => s.slotId)).not.toContain(
      "product-mug",
    );
  });

  it("stops drawing new slots once the run is aborted", async () => {
    const { pkg, intent } = await fixture();
    const controller = new AbortController();
    const fake = createFakeImageClient();
    const client: ThemeStudioImageClient = {
      provider: "fake",
      async generateImage(request, signal) {
        const result = await fake.generateImage(request, signal);
        if (request.purpose === "anchor") controller.abort();
        return result;
      },
    };
    const result = await runThemeImageGeneration(
      client,
      { pkg, intent },
      controller.signal,
    );
    expect(result.images).toEqual([]);
    expect(result.outcomes.every((o) => o.status === "skipped")).toBe(true);
  });

  it("has nothing to do, and calls nothing, when no placeholder remains", async () => {
    const { pkg, intent } = await fixture();
    const client = { provider: "fake" as const, generateImage: vi.fn() };
    const filled = structuredClone(pkg);
    for (const asset of filled.assets) asset.licenseNote = "Our own.";
    const none = await runThemeImageGeneration(
      client,
      { pkg: filled, intent },
      new AbortController().signal,
    );
    expect(client.generateImage).not.toHaveBeenCalled();
    expect(none.telemetry.calls).toEqual([]);
    expect(none.telemetry.totals).toEqual(ZERO_IMAGE_USAGE);
  });
});

describe(
  "the next version's package",
  { timeout: IMAGE_RUN_TIMEOUT_MS },
  () => {
    it("points each drawn slot at its image, marked generated and not a placeholder", async () => {
      const { pkg, intent } = await fixture();
      const result = await runThemeImageGeneration(
        createFakeImageClient(),
        { pkg, intent },
        new AbortController().signal,
      );
      const applied = applyGeneratedImages(
        pkg,
        result.images.map(({ slotId, image }) => ({
          slotId,
          sha256: image.sha256,
          width: image.width,
          height: image.height,
        })),
        2,
        "gemini-3.1-flash-image",
      );
      expect(applied.ok).toBe(true);
      if (!applied.ok) return;
      expect(
        validateThemePackageV2(JSON.parse(JSON.stringify(applied.value))).ok,
      ).toBe(true);
      for (const { slotId, image } of result.images) {
        const asset = applied.value.assets.find((a) => a.id === slotId)!;
        expect(asset).toMatchObject({
          sha256: image.sha256,
          source: "generated",
          licenseNote: GENERATED_LICENSE_NOTE,
        });
        expect(asset.licenseNote).not.toBe(PLACEHOLDER_LICENSE_NOTE);
      }
      expect(applied.value.definition.release.version).toBe("0.0.2");
      expect(applied.value.definition.release.notes.at(-1)).toContain(
        "Images generated with gemini-3.1-flash-image",
      );
      // The version filled is untouched.
      expect(
        pkg.assets.every((a) => a.licenseNote !== GENERATED_LICENSE_NOTE),
      ).toBe(true);
    });

    it("refuses an unknown slot, a wrong shape and an empty set", async () => {
      const { pkg } = await fixture();
      const slot = pkg.assets.find((a) => a.width && a.height)!;
      const image = {
        sha256: "b".repeat(64),
        width: slot.width!,
        height: slot.height!,
      };
      expect(applyGeneratedImages(pkg, [], 2, "m").ok).toBe(false);
      expect(
        applyGeneratedImages(pkg, [{ slotId: "nope", ...image }], 2, "m").ok,
      ).toBe(false);
      expect(
        applyGeneratedImages(
          pkg,
          [{ slotId: slot.id, ...image, height: image.height * 2 }],
          2,
          "m",
        ).ok,
      ).toBe(false);
    });
  },
);
