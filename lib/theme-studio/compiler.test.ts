import { describe, expect, it } from "vitest";
import {
  prepareDraft,
  productSlotBrief,
  productSlotId,
  reservedBriefIssues,
  slotSpec,
} from "./compiler";
import { createFakeModelClient, runFakeProvider } from "./fake-provider";
import type { ThemeIntent } from "./contracts";

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

describe("catalog picture slots in storefront content", () => {
  const input = {
    name: "Clay & Co",
    brief: "A calm ceramics shop.",
    industries: ["home" as const],
    catalogSizes: ["small" as const],
    requiredFeatures: [],
    referenceCount: 0,
  };
  async function draftAndIntent() {
    const intent = runFakeProvider(input);
    if (!intent.ok) throw new Error("fake intent failed");
    const result = await createFakeModelClient(input).generate(
      { stage: "draft", content: [] } as never,
      new AbortController().signal,
    );
    if (result.kind !== "ok") throw new Error("fake draft failed");
    return {
      intent: intent.value as ThemeIntent,
      draft: structuredClone(result.value) as Record<string, unknown>,
    };
  }

  it("accepts the offline draft as written", async () => {
    const { intent, draft } = await draftAndIntent();
    expect(prepareDraft(draft, intent).issues).toEqual([]);
  });

  it("refuses a section image that names a catalog screenshot slot, with a repairable reason", async () => {
    const { intent, draft } = await draftAndIntent();
    // Draft sections carry their config as a JSON string (closed schema).
    const sections = (
      draft.pages as { sections: { configJson: string }[] }[]
    ).flatMap((page) => page.sections);
    const withImage = sections.find((section) =>
      Object.entries(JSON.parse(section.configJson)).some(
        ([key, value]) => key.endsWith("_url") && value !== "",
      ),
    );
    expect(withImage).toBeDefined();
    const config = JSON.parse(withImage!.configJson) as Record<string, unknown>;
    const key = Object.keys(config).find(
      (k) => k.endsWith("_url") && config[k] !== "",
    )!;
    config[key] = "theme-asset://screenshot-desktop";
    withImage!.configJson = JSON.stringify(config);
    const { issues } = prepareDraft(draft, intent);
    expect(issues).toEqual([
      expect.stringContaining(
        '"screenshot-desktop", a catalog picture of the finished storefront',
      ),
    ]);
  });

  it("refuses a product or category that names the catalog preview slot", async () => {
    const { intent, draft } = await draftAndIntent();
    const categories = draft.categories as Record<string, unknown>[];
    const imageKey = Object.keys(categories[0]).find((k) => /image/i.test(k))!;
    categories[0][imageKey] = "preview";
    // One precise sentence, not also "needs an imageSlot".
    expect(prepareDraft(draft, intent).issues).toEqual([
      expect.stringContaining('"preview", a catalog picture'),
    ]);
  });
});

describe("reserved catalog slot names", () => {
  it("reserves the catalog slots and screenshot-* names, and nothing inherited from Object", () => {
    const issues = reservedBriefIssues({
      assetBriefs: [
        { id: "preview" },
        { id: "screenshot-hero" },
        { id: "constructor" },
        { id: "home-hero" },
      ],
    });
    expect(issues).toHaveLength(2);
    expect(issues[0]).toContain('"preview"');
    expect(issues[1]).toContain('"screenshot-hero"');
  });

  it("gives a brief named after an Object.prototype key its own spec, not a system slot's", () => {
    const intent = {
      assetBriefs: [
        { id: "constructor", purpose: "Hero", aspectRatio: "21:9" },
      ],
    } as unknown as ThemeIntent;
    expect(slotSpec("constructor", intent).aspectRatio).toBe("21:9");
  });
});
