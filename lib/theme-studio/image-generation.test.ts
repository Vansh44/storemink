import { describe, expect, it, vi } from "vitest";
import { PLACEHOLDER_LICENSE_NOTE, productSlotId } from "./compiler";
import {
  validateThemePackageV2,
  type ThemeIntent,
  type ThemePackageV2,
} from "./contracts";
import { createFakeModelClient } from "./fake-provider";
import {
  createFakeImageClient,
  createFakeImageReviewClient,
} from "./image-fake";
import {
  runThemeImageGeneration,
  type ThemeImageReviewer,
} from "./image-generation";
import {
  THEME_ANCHOR_REDRAWS,
  THEME_IMAGE_PROBLEM_TEXT,
  THEME_IMAGE_REDRAWS,
} from "./image-review";
import {
  ZERO_USAGE,
  type StructuredRequest,
  type StructuredResult,
} from "./provider";
import { prepareSlotImage } from "./slot-images";
import {
  GENERATED_LICENSE_NOTE,
  applyGeneratedImages,
  directionFromPackage,
  generatableSlots,
  imageRunEstimate,
  nearestImageRatio,
  productSetReferenceSha,
  redrawableSlotIds,
  type GeneratableSlot,
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

  it("states a run's likely cost and its ceiling with every image redrawn", () => {
    // 6 slots + the anchor = 7 images at $0.135, each reviewed at $0.01;
    // at most every slot drawn three times and the anchor four.
    expect(imageRunEstimate(6)).toEqual({
      images: 7,
      expectedUsd: 1.02,
      mostUsd: 3.19,
    });
    expect(imageRunEstimate(0).images).toBe(1);
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
  it("reuses only reviewed exact-byte product references, preserving uploaded artwork and redraw exclusions", async () => {
    const { pkg, intent } = await fixture();
    const products = generatableSlots(pkg, intent).filter(
      (s) => s.purpose === "product",
    );
    const hashes = products.map((_, i) => String(i + 1).repeat(64));
    const applied = applyGeneratedImages(
      pkg,
      products.map((slot, i) => ({
        slotId: slot.slotId,
        sha256: hashes[i],
        width: slot.target.width,
        height: slot.target.height,
      })),
      2,
      "fake",
    );
    if (!applied.ok) throw new Error(applied.error);
    expect(productSetReferenceSha(applied.value, [], [])).toBeNull();
    expect(productSetReferenceSha(applied.value, [], [hashes[1]])).toBe(
      hashes[1],
    );
    expect(
      productSetReferenceSha(applied.value, [products[1].slotId], [hashes[1]]),
    ).toBeNull();
    applied.value.assets.find((a) => a.id === products[0].slotId)!.source =
      "operator-owned";
    expect(productSetReferenceSha(applied.value, [], [])).toBe(hashes[0]);
  });
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
      { pkg, intent, reviewer: null },
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
      (slots.length + 1) * (100 * 2 + 1680 * 120),
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
      { pkg, intent, reviewer: null },
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
      { pkg, intent, reviewer: null },
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
      { pkg, intent, reviewer: null },
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

  it("redraws a refused anchor, then draws nothing else if every attempt is refused", async () => {
    const { pkg, intent } = await fixture();
    const seen: ThemeImageRequest[] = [];
    const result = await runThemeImageGeneration(
      scripted({ anchor: { kind: "refused", reason: "IMAGE_SAFETY" } }, seen),
      { pkg, intent, reviewer: null },
      new AbortController().signal,
    );
    const attempts = 1 + THEME_ANCHOR_REDRAWS;
    expect(seen).toHaveLength(attempts);
    // Each redraw says it was blocked.
    expect(seen[1].prompt).toContain(
      "blocked by the image model's safety filter",
    );
    expect(result.anchorFailure).toEqual({
      kind: "refused",
      reason: "IMAGE_SAFETY",
    });
    expect(result.images).toEqual([]);
    expect(result.outcomes.every((o) => o.status === "skipped")).toBe(true);
    // Every call is still recorded.
    expect(result.telemetry.calls).toHaveLength(attempts);
    expect(result.telemetry.totals).toEqual({
      inputTokens: 10 * attempts,
      outputTokens: 20 * attempts,
    });
  });

  // Production: a fashion hero and lookbook asked for models and were refused
  // by the people filter. A refusal is not billed, so it is redrawn people-free.
  it("redraws a people-filter refusal without people, and keeps the redraw", async () => {
    const { pkg, intent } = await fixture();
    const [first] = generatableSlots(pkg, intent);
    const fake = createFakeImageClient();
    const seen: ThemeImageRequest[] = [];
    const client: ThemeStudioImageClient = {
      provider: "fake",
      async generateImage(request, signal) {
        seen.push(request);
        if (
          request.briefId === first.slotId &&
          !request.prompt.includes("Redraw:")
        ) {
          return {
            kind: "refused",
            reason: "Your current PersonGeneration setting filtered the image.",
            usage: ZERO_IMAGE_USAGE,
          };
        }
        return fake.generateImage(request, signal);
      },
    };
    const result = await runThemeImageGeneration(
      client,
      { pkg, intent, reviewer: null },
      new AbortController().signal,
    );
    const drawn = seen.filter((r) => r.briefId === first.slotId);
    expect(drawn).toHaveLength(2);
    expect(drawn[1].prompt).toContain("blocked because it showed a person");
    expect(
      result.outcomes.find((o) => o.slotId === first.slotId),
    ).toMatchObject({ status: "generated", attempts: 2 });
  });

  it("a refused or failed slot keeps its placeholder while the rest are drawn", async () => {
    const { pkg, intent } = await fixture();
    const slots = generatableSlots(pkg, intent);
    const [first] = slots;
    const result = await runThemeImageGeneration(
      scripted({ [first.slotId]: { kind: "refused", reason: "SAFETY" } }),
      { pkg, intent, reviewer: null },
      new AbortController().signal,
    );
    expect(result.outcomes.find((o) => o.slotId === first.slotId)).toEqual({
      slotId: first.slotId,
      status: "refused",
      attempts: 1 + THEME_IMAGE_REDRAWS,
      reason: "SAFETY",
    });
    expect(result.images.map((i) => i.slotId)).not.toContain(first.slotId);
    expect(result.images).toHaveLength(slots.length - 1);
    // Every refused call is still counted.
    expect(result.telemetry.calls).toHaveLength(
      slots.length + 1 + THEME_IMAGE_REDRAWS,
    );
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
      { pkg, intent, reviewer: null },
      new AbortController().signal,
      { prepare },
    );
    expect(result.outcomes.find((o) => o.slotId === first.slotId)).toEqual({
      slotId: first.slotId,
      status: "unusable",
      attempts: 1,
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
      { pkg, intent, reviewer: null },
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
      { pkg, intent, reviewer: null },
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
      { pkg, intent, reviewer: null },
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
      { pkg: filled, intent, reviewer: null },
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
        { pkg, intent, reviewer: null },
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

/** A reviewer scripted by what it is shown: `decide` gets the review header
 *  text and the attempt, and names the problems. */
function scriptedReviewer(
  decide: (text: string, attempt: number) => string[],
  seen: StructuredRequest[] = [],
  result?: (request: StructuredRequest) => StructuredResult | null,
): ThemeImageReviewer {
  return {
    providerModel: "gemini-3.8-flash",
    client: {
      provider: "fake",
      async generate(request) {
        seen.push(request);
        const scripted = result?.(request);
        if (scripted) return scripted;
        const text = (request.content[0] as { text: string }).text;
        const attempt = text.includes("It is a redraw") ? 2 : 1;
        const problems = decide(text, attempt);
        return {
          kind: "ok",
          value: {
            problems,
            note: problems.length ? `Seen: ${problems[0]}.` : "",
          },
          usage: {
            inputTokens: 1800,
            cachedTokens: 0,
            outputTokens: 30,
            thinkingTokens: 100,
          },
        };
      },
    },
  };
}

const HERO = "The store's own products in use";
const ANCHOR = "A signature still life";

/** The stored crop the fake image client would produce for a request. */
async function cropOf(request: ThemeImageRequest, slot: GeneratableSlot) {
  const drawn = await createFakeImageClient().generateImage(
    request,
    new AbortController().signal,
  );
  if (drawn.kind !== "ok") throw new Error("fake failed");
  const prepared = await prepareSlotImage(
    drawn.bytes,
    slot.target,
    slot.byteLimit,
  );
  if (!prepared.ok) throw new Error("crop failed");
  return prepared.value;
}

describe("reviewing each image", { timeout: IMAGE_RUN_TIMEOUT_MS }, () => {
  it("continues drawing while reviews are pending without exceeding either concurrency limit", async () => {
    const { pkg, intent } = await richFixture();
    const fake = createFakeImageClient();
    const draws: string[] = [];
    let activeDraws = 0;
    let peakDraws = 0;
    let activeReviews = 0;
    let peakReviews = 0;
    const releases: (() => void)[] = [];
    const controller = new AbortController();
    const work = runThemeImageGeneration(
      {
        provider: "fake",
        async generateImage(request, signal) {
          draws.push(request.briefId);
          peakDraws = Math.max(peakDraws, ++activeDraws);
          try {
            return await fake.generateImage(request, signal);
          } finally {
            activeDraws--;
          }
        },
      },
      {
        pkg,
        intent,
        reviewer: {
          providerModel: "fake",
          client: {
            provider: "fake",
            async generate(request) {
              const text = (request.content[0] as { text: string }).text;
              if (!text.includes(ANCHOR)) {
                peakReviews = Math.max(peakReviews, ++activeReviews);
                await new Promise<void>((resolve) => {
                  releases.push(resolve);
                });
                activeReviews--;
              }
              return {
                kind: "ok",
                value: { problems: [], note: "" },
                usage: ZERO_USAGE,
              };
            },
          },
        },
      },
      controller.signal,
      { concurrency: 2, reviewConcurrency: 2 },
    );
    try {
      // Previously two reviews held both image lanes, leaving only three
      // draws (anchor + two slots). Separate stages allow four slot draws.
      await vi.waitFor(
        () => {
          expect(draws.length).toBeGreaterThanOrEqual(5);
          expect(peakReviews).toBe(2);
        },
        {
          timeout: 5000,
        },
      );
      expect(peakDraws).toBeLessThanOrEqual(2);
      expect(peakReviews).toBe(2);
    } finally {
      controller.abort();
      releases.forEach((resolve) => resolve());
      await work;
    }
  });

  it("keeps a less flawed earlier candidate and never makes a flagged product the set reference", async () => {
    const { pkg, intent } = await fixture();
    const slots = generatableSlots(pkg, intent);
    const products = slots.filter((s) => s.purpose === "product");
    const seen: ThemeImageRequest[] = [];
    const result = await runThemeImageGeneration(
      scripted({}, seen),
      {
        pkg,
        intent,
        reviewer: scriptedReviewer((text, attempt) => {
          if (text.includes(`Subject: ${products[0].brief.subject}`))
            return ["poor_crop"];
          if (text.includes(HERO))
            return attempt === 1 ? ["off_style"] : ["off_style", "poor_crop"];
          return [];
        }),
      },
      new AbortController().signal,
    );
    const hero = slots.find((s) => s.slotId === "home-hero")!;
    const first = seen.find((r) => r.briefId === hero.slotId)!;
    expect(
      result.images.find((i) => i.slotId === hero.slotId)?.image.sha256,
    ).toBe((await cropOf(first, hero)).sha256);
    expect(result.outcomes.find((o) => o.slotId === hero.slotId)).toMatchObject(
      { review: "flagged", problems: ["off_style"] },
    );
    expect(
      seen
        .find((r) => r.briefId === products[1].slotId)
        ?.references.map((r) => r.role),
    ).toEqual(["anchor"]);
    expect(
      seen
        .find((r) => r.briefId === products[2].slotId)
        ?.references.map((r) => r.role),
    ).toEqual(["anchor", "set"]);
  });

  it("reviews every kept image once, and counts the reviews in the run's cost", async () => {
    const { pkg, intent } = await fixture();
    const slots = generatableSlots(pkg, intent);
    const result = await runThemeImageGeneration(
      createFakeImageClient(),
      { pkg, intent, reviewer: scriptedReviewer(() => []) },
      new AbortController().signal,
    );
    expect(result.telemetry.reviews).toHaveLength(slots.length + 1);
    expect(result.telemetry.reviews.every((r) => r.outcome === "passed")).toBe(
      true,
    );
    for (const outcome of result.outcomes) {
      expect(outcome).toMatchObject({
        status: "generated",
        attempts: 1,
        review: "passed",
      });
    }
    const imageCost = result.telemetry.calls.reduce(
      (s, c) => s + c.estimatedCostMicroUsd,
      0,
    );
    expect(result.telemetry.reviewCostMicroUsd).toBeGreaterThan(0);
    expect(result.telemetry.estimatedCostMicroUsd).toBe(
      imageCost + result.telemetry.reviewCostMicroUsd,
    );
    expect(result.telemetry.reviewPromptVersion).toBe(
      "theme-studio-image-review-v5",
    );
  });

  it("redraws a rejected image once, telling the image model why", async () => {
    const { pkg, intent } = await fixture();
    const seen: ThemeImageRequest[] = [];
    const result = await runThemeImageGeneration(
      scripted({}, seen),
      {
        pkg,
        intent,
        reviewer: scriptedReviewer((text, attempt) =>
          text.includes(HERO) && attempt === 1 ? ["text_or_logo"] : [],
        ),
      },
      new AbortController().signal,
    );
    const hero = seen.filter((r) => r.briefId === "home-hero");
    expect(hero).toHaveLength(2);
    expect(hero[0].prompt).not.toContain("Redraw:");
    expect(hero[1].prompt).toContain(THEME_IMAGE_PROBLEM_TEXT.text_or_logo);
    expect(hero[1].prompt).toContain("Seen: text_or_logo.");
    expect(result.outcomes.find((o) => o.slotId === "home-hero")).toEqual({
      slotId: "home-hero",
      status: "generated",
      attempts: 2,
      review: "passed",
    });
  });

  it("keeps the placeholder when a blocking problem survives the redraw", async () => {
    const { pkg, intent } = await fixture();
    const slots = generatableSlots(pkg, intent);
    const result = await runThemeImageGeneration(
      createFakeImageClient(),
      {
        pkg,
        intent,
        reviewer: scriptedReviewer((text) =>
          text.includes(HERO) ? ["person"] : [],
        ),
      },
      new AbortController().signal,
    );
    expect(result.outcomes.find((o) => o.slotId === "home-hero")).toEqual({
      slotId: "home-hero",
      status: "rejected",
      attempts: 1 + THEME_IMAGE_REDRAWS,
      problems: ["person"],
      note: "Seen: person.",
    });
    expect(result.images.map((i) => i.slotId)).not.toContain("home-hero");
    expect(result.images).toHaveLength(slots.length - 1);
  });

  it("keeps a redraw whose only problem is minor, with the problem noted", async () => {
    const { pkg, intent } = await fixture();
    const slot = generatableSlots(pkg, intent).find(
      (s) => s.slotId === "home-hero",
    )!;
    const seen: ThemeImageRequest[] = [];
    const result = await runThemeImageGeneration(
      scripted({}, seen),
      {
        pkg,
        intent,
        reviewer: scriptedReviewer((text) =>
          text.includes(HERO) ? ["poor_crop"] : [],
        ),
      },
      new AbortController().signal,
    );
    expect(result.outcomes.find((o) => o.slotId === "home-hero")).toEqual({
      slotId: "home-hero",
      status: "generated",
      attempts: 1 + THEME_IMAGE_REDRAWS,
      review: "flagged",
      problems: ["poor_crop"],
      note: "Seen: poor_crop.",
    });
    // Equal reported problems keep the earlier paid candidate.
    const redraw = seen.filter((r) => r.briefId === "home-hero")[0];
    const kept = result.images.find((i) => i.slotId === "home-hero")!.image;
    expect(kept.sha256).toBe((await cropOf(redraw, slot)).sha256);
  });

  it("falls back to the earlier image when the redraw is worse", async () => {
    const { pkg, intent } = await fixture();
    const slot = generatableSlots(pkg, intent).find(
      (s) => s.slotId === "home-hero",
    )!;
    const seen: ThemeImageRequest[] = [];
    const result = await runThemeImageGeneration(
      scripted({}, seen),
      {
        pkg,
        intent,
        reviewer: scriptedReviewer((text, attempt) =>
          text.includes(HERO) ? [attempt === 1 ? "off_style" : "person"] : [],
        ),
      },
      new AbortController().signal,
    );
    expect(result.outcomes.find((o) => o.slotId === "home-hero")).toEqual({
      slotId: "home-hero",
      status: "generated",
      attempts: 1 + THEME_IMAGE_REDRAWS,
      review: "flagged",
      problems: ["off_style"],
      note: "Seen: off_style.",
    });
    const first = seen.filter((r) => r.briefId === "home-hero")[0];
    const kept = result.images.find((i) => i.slotId === "home-hero")!.image;
    expect(kept.sha256).toBe((await cropOf(first, slot)).sha256);
  });

  it("keeps redrawing a refused redraw, then settles on what the first attempt earned", async () => {
    const { pkg, intent } = await fixture();
    const productIds = generatableSlots(pkg, intent)
      .filter((s) => s.purpose === "product")
      .map((s) => s.slotId);
    const fake = createFakeImageClient();
    const refusesRedraws: ThemeStudioImageClient = {
      provider: "fake",
      async generateImage(request, signal) {
        if (request.prompt.includes("Redraw:")) {
          return { kind: "refused", reason: "SAFETY", usage: ZERO_IMAGE_USAGE };
        }
        return fake.generateImage(request, signal);
      },
    };
    const products = pkg.definition.preset.sampleData!.products;
    const minor = products.find(
      (p) => `theme-asset://${productIds[1]}` === p.image_url,
    )!.name;
    const blocking = products.find(
      (p) => `theme-asset://${productIds[2]}` === p.image_url,
    )!.name;
    const result = await runThemeImageGeneration(
      refusesRedraws,
      {
        pkg,
        intent,
        reviewer: scriptedReviewer((text) =>
          text.includes(`Subject: ${minor}.`)
            ? ["staging_mismatch"]
            : text.includes(`Subject: ${blocking}.`)
              ? ["multiple_subjects"]
              : [],
        ),
      },
      new AbortController().signal,
    );
    expect(
      result.outcomes.find((o) => o.slotId === productIds[1]),
    ).toMatchObject({
      status: "generated",
      attempts: 1 + THEME_IMAGE_REDRAWS,
      review: "flagged",
    });
    expect(result.outcomes.find((o) => o.slotId === productIds[2])).toEqual({
      slotId: productIds[2],
      status: "rejected",
      attempts: 1 + THEME_IMAGE_REDRAWS,
      problems: ["multiple_subjects"],
      note: "Seen: multiple_subjects.",
    });
  });

  it("keeps an image the reviewer could not check, without redrawing it", async () => {
    const { pkg, intent } = await fixture();
    const slots = generatableSlots(pkg, intent);
    const seen: ThemeImageRequest[] = [];
    const result = await runThemeImageGeneration(
      scripted({}, seen),
      {
        pkg,
        intent,
        reviewer: scriptedReviewer(
          () => [],
          [],
          () => ({ kind: "error", code: "rate_limited", usage: ZERO_USAGE }),
        ),
      },
      new AbortController().signal,
    );
    expect(seen).toHaveLength(slots.length + 1);
    expect(result.images).toHaveLength(slots.length);
    expect(
      result.outcomes.every(
        (o) => o.status === "generated" && o.review === "unreviewed",
      ),
    ).toBe(true);
    expect(
      result.telemetry.reviews.every(
        (r) => r.outcome === "unavailable" && r.errorCode === "rate_limited",
      ),
    ).toBe(true);
  });

  it("draws nothing else when the anchor shows a person on every attempt", async () => {
    const { pkg, intent } = await fixture();
    const seen: ThemeImageRequest[] = [];
    const result = await runThemeImageGeneration(
      scripted({}, seen),
      {
        pkg,
        intent,
        reviewer: scriptedReviewer((text) =>
          text.includes(ANCHOR) ? ["person"] : [],
        ),
      },
      new AbortController().signal,
    );
    expect(seen.map((r) => r.purpose)).toEqual(
      Array(1 + THEME_ANCHOR_REDRAWS).fill("anchor"),
    );
    expect(result.anchorFailure).toEqual({
      kind: "rejected",
      problems: ["person"],
      note: "Seen: person.",
    });
    expect(result.images).toEqual([]);
    expect(result.outcomes.every((o) => o.status === "skipped")).toBe(true);
  });

  // The production failure: the anchor was turned down once as malformed and
  // once for an embossed mark, and all seventeen slots were skipped. It is a
  // hidden reference, so those are redrawn and then kept, and the run goes on.
  it("keeps an anchor whose only problems are minor for a hidden reference, and draws the set", async () => {
    const { pkg, intent } = await fixture();
    const slots = generatableSlots(pkg, intent);
    const seen: ThemeImageRequest[] = [];
    let anchorReviews = 0;
    const result = await runThemeImageGeneration(
      scripted({}, seen),
      {
        pkg,
        intent,
        reviewer: scriptedReviewer((text) => {
          if (!text.includes(ANCHOR)) return [];
          anchorReviews++;
          return anchorReviews === 1 ? ["malformed"] : ["text_or_logo"];
        }),
      },
      new AbortController().signal,
    );
    expect(seen.filter((r) => r.purpose === "anchor")).toHaveLength(
      1 + THEME_ANCHOR_REDRAWS,
    );
    // Each redraw carries what the check found.
    expect(seen[1].prompt).toContain(THEME_IMAGE_PROBLEM_TEXT.malformed);
    expect(seen[2].prompt).toContain(THEME_IMAGE_PROBLEM_TEXT.text_or_logo);
    expect(result.anchorFailure).toBeNull();
    expect(result.anchor).not.toBeNull();
    expect(result.images).toHaveLength(slots.length);
  });

  it("shows the reviewer each stored crop, with the anchor and, after the first product, the set shot", async () => {
    const { pkg, intent } = await fixture();
    const slots = generatableSlots(pkg, intent);
    const productIds = slots
      .filter((s) => s.purpose === "product")
      .map((s) => s.slotId);
    const reviews: StructuredRequest[] = [];
    const result = await runThemeImageGeneration(
      createFakeImageClient(),
      { pkg, intent, reviewer: scriptedReviewer(() => [], reviews) },
      new AbortController().signal,
    );
    const images = (r: StructuredRequest) =>
      r.content.flatMap((b) => (b.type === "image" ? [b.base64] : []));
    const reviewFor = (slotId: string) => {
      const product = pkg.definition.preset.sampleData!.products.find(
        (p) => p.image_url === `theme-asset://${slotId}`,
      );
      const needle = product ? `Subject: ${product.name}.` : HERO;
      return reviews.find((r) =>
        (r.content[0] as { text: string }).text.includes(needle),
      )!;
    };
    const anchorReview = reviews.find((r) =>
      (r.content[0] as { text: string }).text.includes(ANCHOR),
    )!;
    expect(images(anchorReview)).toHaveLength(1);
    const anchorStored = Buffer.from(result.anchor!.bytes).toString("base64");
    expect(images(anchorReview)[0]).toBe(anchorStored);
    expect(images(reviewFor("home-hero"))).toEqual([
      Buffer.from(
        result.images.find((i) => i.slotId === "home-hero")!.image.bytes,
      ).toString("base64"),
      anchorStored,
    ]);
    expect(images(reviewFor(productIds[0]))).toHaveLength(2);
    const leaderStored = Buffer.from(
      result.images.find((i) => i.slotId === productIds[0])!.image.bytes,
    ).toString("base64");
    for (const id of productIds.slice(1)) {
      const shown = images(reviewFor(id));
      expect(shown).toHaveLength(3);
      expect(shown[1]).toBe(anchorStored);
      expect(shown[2]).toBe(leaderStored);
    }
  });

  it("never makes a rejected product the set shot", async () => {
    const { pkg, intent } = await fixture();
    const productIds = generatableSlots(pkg, intent)
      .filter((s) => s.purpose === "product")
      .map((s) => s.slotId);
    const leaderName = pkg.definition.preset.sampleData!.products.find(
      (p) => p.image_url === `theme-asset://${productIds[0]}`,
    )!.name;
    const seen: ThemeImageRequest[] = [];
    const result = await runThemeImageGeneration(
      scripted({}, seen),
      {
        pkg,
        intent,
        reviewer: scriptedReviewer((text) =>
          text.includes(`Subject: ${leaderName}.`) ? ["wrong_subject"] : [],
        ),
      },
      new AbortController().signal,
    );
    expect(
      result.outcomes.find((o) => o.slotId === productIds[0])?.status,
    ).toBe("rejected");
    const roles = (id: string) =>
      seen
        .filter((r) => r.briefId === id)
        .map((r) => r.references.map((ref) => ref.role));
    expect(roles(productIds[0])).toEqual(
      Array(1 + THEME_IMAGE_REDRAWS).fill(["anchor"]),
    );
    expect(roles(productIds[1])).toEqual([["anchor"]]);
    for (const id of productIds.slice(2)) {
      expect(roles(id)).toEqual([["anchor", "set"]]);
    }
  });

  it("passes every image with the offline reviewer, and its drill redraws once", async () => {
    const { pkg, intent } = await fixture();
    const drilled = structuredClone(intent);
    drilled.assetBriefs = drilled.assetBriefs.map((b) =>
      b.id === "home-hero"
        ? { ...b, subject: `${b.subject} [[fake-review:poor_crop]]` }
        : b,
    );
    const result = await runThemeImageGeneration(
      createFakeImageClient(),
      {
        pkg,
        intent: drilled,
        reviewer: {
          client: createFakeImageReviewClient(),
          providerModel: "fake",
        },
      },
      new AbortController().signal,
    );
    expect(result.outcomes.find((o) => o.slotId === "home-hero")).toMatchObject(
      { status: "generated", attempts: 2, review: "passed" },
    );
    expect(
      result.outcomes
        .filter((o) => o.slotId !== "home-hero")
        .every((o) => o.status === "generated" && o.attempts === 1),
    ).toBe(true);
  });
});

describe("redrawing chosen slots", { timeout: IMAGE_RUN_TIMEOUT_MS }, () => {
  /** The fixture after a full run: every art slot holds a generated image. */
  async function drawnFixture() {
    const { pkg, intent } = await fixture();
    const result = await runThemeImageGeneration(
      createFakeImageClient(),
      { pkg, intent, reviewer: null },
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
      "m",
    );
    if (!applied.ok) throw new Error(applied.error);
    return { pkg: applied.value, intent, result };
  }

  it("offers placeholders and generated images for a redraw, never an upload or the catalog pictures", async () => {
    const { pkg } = await drawnFixture();
    const uploaded = structuredClone(pkg);
    const hero = uploaded.assets.find((a) => a.id === "home-hero")!;
    hero.source = "operator-owned";
    hero.licenseNote = "Our photo.";
    const ids = redrawableSlotIds(uploaded);
    expect(ids).not.toContain("home-hero");
    expect(ids).not.toContain("preview");
    expect(ids).not.toContain("screenshot-desktop");
    const products = pkg.definition.preset.sampleData!.products;
    for (const p of products) {
      expect(ids).toContain(p.image_url.replace("theme-asset://", ""));
    }
    // A full run draws nothing (no placeholders are left) …
    const { intent } = await fixture();
    expect(generatableSlots(pkg, intent)).toEqual([]);
    // … and a named redraw draws exactly the named slots it may draw.
    const named = generatableSlots(uploaded, intent, [
      ids[0],
      "home-hero",
      "preview",
      "nope",
    ]).map((s) => s.slotId);
    expect(named).toEqual([ids[0]]);
  });

  it("matches the stored art-direction image and product photo instead of drawing new ones", async () => {
    const { pkg, intent, result: first } = await drawnFixture();
    const productIds = generatableSlots(pkg, intent, redrawableSlotIds(pkg))
      .filter((s) => s.purpose === "product")
      .map((s) => s.slotId);
    const anchor = first.anchor!.bytes;
    const set = first.images.find((i) => i.slotId === productIds[0])!.image
      .bytes;
    const seen: ThemeImageRequest[] = [];
    const reviews: StructuredRequest[] = [];
    const redraw = await runThemeImageGeneration(
      scripted({}, seen),
      {
        pkg,
        intent,
        reviewer: scriptedReviewer(() => [], reviews),
        only: [productIds[1], productIds[2], "home-hero"],
        seed: {
          anchor: { bytes: anchor, mediaType: "image/webp" },
          set: { bytes: set, mediaType: "image/webp" },
        },
      },
      new AbortController().signal,
    );
    // No new anchor: three images for three slots.
    expect(seen.map((r) => r.briefId).sort()).toEqual(
      [productIds[1], productIds[2], "home-hero"].sort(),
    );
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
    for (const request of seen) {
      expect(request.references[0]).toEqual({
        role: "anchor",
        mediaType: "image/webp",
        base64: b64(anchor),
      });
    }
    for (const id of [productIds[1], productIds[2]]) {
      expect(seen.find((r) => r.briefId === id)!.references[1]).toEqual({
        role: "set",
        mediaType: "image/webp",
        base64: b64(set),
      });
    }
    expect(
      seen.find((r) => r.briefId === "home-hero")!.references,
    ).toHaveLength(1);
    // The reviewer compares against the same stored pictures.
    for (const review of reviews) {
      const shown = review.content.flatMap((b) =>
        b.type === "image" ? [b.base64] : [],
      );
      expect(shown[1]).toBe(b64(anchor));
    }
    // Nothing new to store for the anchor; only the redrawn slots come back.
    expect(redraw.anchor).toBeNull();
    expect(redraw.images.map((i) => i.slotId).sort()).toEqual(
      [productIds[1], productIds[2], "home-hero"].sort(),
    );
    expect(redraw.outcomes).toHaveLength(3);
  });

  it("draws a fresh art-direction image for a redraw with nothing to reuse", async () => {
    const { pkg, intent } = await drawnFixture();
    const seen: ThemeImageRequest[] = [];
    const redraw = await runThemeImageGeneration(
      scripted({}, seen),
      { pkg, intent, reviewer: null, only: ["home-hero"], seed: null },
      new AbortController().signal,
    );
    expect(seen.map((r) => r.purpose)).toEqual(["anchor", "hero"]);
    expect(redraw.anchor).not.toBeNull();
  });
});

describe("the direction's reference imagery", () => {
  it("is read from every screenshot's analysis, de-duplicated and bounded", async () => {
    const { referenceImagery } = await import("./image-generation-core");
    const reading = (imagery: string[]) => ({ imagery }) as never;
    const intent = {
      referenceAnalysis: [
        reading(["Warm oak rooms", "  White {pack} shots "]),
        reading([
          "warm oak rooms",
          ...Array.from({ length: 10 }, (_, i) => `Line ${i}`),
        ]),
      ],
    } as unknown as Parameters<typeof referenceImagery>[0];
    const lines = referenceImagery(intent);
    expect(lines.slice(0, 2)).toEqual(["Warm oak rooms", "White pack shots"]);
    expect(lines).toHaveLength(8);
  });
});

it(
  "keeps other paid images when a slot provider unexpectedly throws",
  async () => {
    const { pkg, intent } = await fixture();
    const slots = generatableSlots(pkg, intent);
    const failed = slots.find((slot) => slot.purpose === "product")!.slotId;
    const fake = createFakeImageClient();
    const result = await runThemeImageGeneration(
      {
        provider: "fake",
        generateImage: (request, signal) => {
          if (request.briefId === failed)
            throw new Error("unexpected SDK failure");
          return fake.generateImage(request, signal);
        },
      },
      { pkg, intent, reviewer: null },
      new AbortController().signal,
    );
    expect(result.images).toHaveLength(slots.length - 1);
    expect(
      result.outcomes.find((slot) => slot.slotId === failed),
    ).toMatchObject({ status: "failed", code: "provider_unavailable" });
    expect(result.anchor).not.toBeNull();
  },
  IMAGE_RUN_TIMEOUT_MS,
);
