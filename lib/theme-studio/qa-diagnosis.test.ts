import { describe, expect, it } from "vitest";
import { gate } from "./acceptance-gates";
import {
  deterministicRepairs,
  qaProgress,
  qaImproved,
  parseQaRepairs,
} from "./qa-diagnosis";
const crop = (fraction: number) => [
  gate("browser.image_crops", [
    {
      code: "extreme_crop",
      where: "tablet768 · content",
      message: `Only ${fraction}% of the source frame remains visible (img.home-hero-img).`,
    },
  ]),
];
const scores = {
  artDirection: 4,
  distinctness: 4,
  commerceClarity: 4,
  typography: 3,
  imagery: 4,
  responsiveComposition: 4,
  detailQuality: 4,
  brandAdaptability: 4,
};
describe("QA diagnosis and progress", () => {
  it("routes hit areas to the renderer, contrast and image frames to settings", () => {
    const r = deterministicRepairs([
      gate("browser.tap_targets", [
        { code: "small_target", message: "9×9px (button.home-carousel-dot)." },
      ]),
      gate("browser.accessibility", [
        { code: "color-contrast", message: "Contrast" },
      ]),
      ...crop(24),
      gate("browser.accessibility", [
        { code: "button-name", message: "No name" },
      ]),
    ]);
    expect(r.map((x) => x.kind)).toEqual([
      "renderer",
      "settings",
      "settings",
      "renderer",
    ]);
    expect(r.some((x) => x.kind === "image")).toBe(false);
  });
  it("stops unchanged or worse frames, allows a meaningful improvement", () => {
    const p = qaProgress(crop(24));
    expect(qaImproved(qaProgress(crop(24)), p)).toBe(false);
    expect(qaImproved(qaProgress(crop(23)), p)).toBe(false);
    expect(qaImproved(qaProgress(crop(28)), p)).toBe(true);
    expect(qaImproved(qaProgress([]), p)).toBe(true);
    expect(qaImproved(qaProgress(crop(25)), p)).toBe(false); // noise
  });
  it("tracks vertical clipping severity and bare element targets", () => {
    const clipping = (px: number) =>
      qaProgress([
        gate("browser.clipped_text", [
          {
            code: "clipped_text",
            where: "phone360 · home",
            message: `Text is clipped by 0px horizontally and ${px}px vertically (h2).`,
          },
        ]),
      ]);
    expect(qaImproved(clipping(10), clipping(20))).toBe(true);
    expect(clipping(10).patterns[0]).toContain("h2");
  });
  it("does not count changing words or finding order as progress", () => {
    const a = gate("browser.clipped_text", [
      {
        code: "clipped_text",
        where: "phone360 · home",
        message: "Text clipped 8px (h2.home-title).",
      },
      {
        code: "clipped_text",
        where: "phone390 · home",
        message: "Text clipped 8px (h2.home-title).",
      },
    ]);
    const b = structuredClone(a);
    b.findings.reverse();
    b.findings[0].message = "Clipped text 8px (h2.home-title).";
    expect(qaProgress([a])).toEqual(qaProgress([b]));
    expect(qaImproved(qaProgress([b]), qaProgress([a]))).toBe(false);
    b.findings.pop();
    expect(qaImproved(qaProgress([b]), qaProgress([a]))).toBe(true);
  });
  it("tracks low-score deficits and rejection removal without accepting new rejections", () => {
    const p = qaProgress([], { scores, rejections: ["generic_surface"] });
    expect(
      qaImproved(
        qaProgress([], { scores, rejections: ["generic_surface"] }),
        p,
      ),
    ).toBe(false);
    expect(
      qaImproved(
        qaProgress([], {
          scores: { ...scores, typography: 4 },
          rejections: ["generic_surface"],
        }),
        p,
      ),
    ).toBe(true);
    expect(qaImproved(qaProgress([], { scores, rejections: [] }), p)).toBe(
      true,
    );
    expect(
      qaImproved(
        qaProgress([], {
          scores: { ...scores, typography: 5 },
          rejections: ["needs_custom_code"],
        }),
        p,
      ),
    ).toBe(false);
  });
  it("counts resolving an artwork target as progress even when overall scores stay the same", () => {
    const hero = { kind: "image" as const, target: "hero", reason: "Backdrop" };
    const product = {
      kind: "image" as const,
      target: "product",
      reason: "Warped handle",
    };
    const previous = qaProgress([], {
      scores,
      rejections: [],
      repairs: [hero, product],
    });
    expect(
      qaImproved(
        qaProgress([], { scores, rejections: [], repairs: [product] }),
        previous,
      ),
    ).toBe(true);
    expect(
      qaImproved(
        qaProgress([], { scores, rejections: [], repairs: [hero, product] }),
        previous,
      ),
    ).toBe(false);
    expect(
      qaImproved(
        qaProgress([], {
          scores,
          rejections: [],
          repairs: [{ ...product, target: "invented" }],
        }),
        previous,
      ),
    ).toBe(false);
  });
  it("validates closed routes and bounded targets", () => {
    expect(
      parseQaRepairs([
        { kind: "image", target: "hero", reason: "Subject is cropped" },
      ]),
    ).toHaveLength(1);
    expect(
      parseQaRepairs([{ kind: "deploy", target: null, reason: "Run code" }]),
    ).toBeNull();
    expect(
      parseQaRepairs([{ kind: "image", reason: "missing target" }]),
    ).toBeNull();
    expect(
      parseQaRepairs([
        { kind: "settings", target: "x", reason: "x".repeat(801) },
      ]),
    ).toBeNull();
  });
});
