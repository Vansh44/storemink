import { describe, expect, it } from "vitest";
import {
  MINK_MEDIA_NEGATIVE_PROMPT,
  MINK_MEDIA_PROMPT_MAX_CHARS,
  MINK_MEDIA_PURPOSES,
  MINK_MEDIA_PURPOSE_SPECS,
  aspectRatioFor,
  validateMinkMediaGenerationRequest,
} from "./media-generation-contract";

const valid = {
  schemaVersion: 1,
  purpose: "hero",
  prompt: "A warm overhead still life of loose grains and pulses on linen.",
  alt: "Grains and pulses arranged on a linen cloth",
};

describe("Phase 9E generation request", () => {
  it("accepts a complete request and normalises its text", () => {
    const result = validateMinkMediaGenerationRequest({
      ...valid,
      prompt: `  ${valid.prompt}  `,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prompt).toBe(valid.prompt);
    expect(result.value.purpose).toBe("hero");
  });

  it("refuses an unknown key rather than ignoring it", () => {
    // A caller that sent `negativePrompt` believes it took effect. Silently
    // dropping it is how a merchant is told a guarantee applied that did not.
    const result = validateMinkMediaGenerationRequest({
      ...valid,
      negativePrompt: "no logos",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain("negativePrompt");
  });

  it("refuses a purpose it does not know, naming the ones it does", () => {
    const result = validateMinkMediaGenerationRequest({
      ...valid,
      purpose: "wallpaper",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain("hero");
  });

  it("refuses a prompt too thin to be worth a real image", () => {
    const result = validateMinkMediaGenerationRequest({
      ...valid,
      prompt: "rice",
    });
    expect(result.ok).toBe(false);
  });

  it("bounds a long prompt", () => {
    const result = validateMinkMediaGenerationRequest({
      ...valid,
      prompt: "a".repeat(MINK_MEDIA_PROMPT_MAX_CHARS + 1),
    });
    expect(result.ok).toBe(false);
  });

  it("requires alt text, because nothing else will ever ask for it", () => {
    const result = validateMinkMediaGenerationRequest({ ...valid, alt: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain("screen reader");
  });

  it("reports every problem at once so one retry can fix them all", () => {
    const result = validateMinkMediaGenerationRequest({
      schemaVersion: 1,
      purpose: "nope",
      prompt: "x",
      alt: "",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the shape a purpose pins", () => {
  it("gives every purpose an aspect ratio Imagen accepts", () => {
    const supported = new Set(["1:1", "3:4", "4:3", "16:9", "9:16"]);
    for (const purpose of MINK_MEDIA_PURPOSES) {
      expect(supported.has(aspectRatioFor(purpose))).toBe(true);
      expect(MINK_MEDIA_PURPOSE_SPECS[purpose].label).toBeTruthy();
      expect(MINK_MEDIA_PURPOSE_SPECS[purpose].placement).toBeTruthy();
    }
  });

  it("takes the aspect from the purpose, never from the caller", () => {
    // ★ Pinned because the temptation is to add an `aspectRatio` field. A
    //   model choosing 9:16 for a hero produces an image the renderer then
    //   crops through the middle of its subject.
    const result = validateMinkMediaGenerationRequest({
      ...valid,
      aspectRatio: "9:16",
    });
    expect(result.ok).toBe(false);
  });
});

describe("the always-applied negative prompt", () => {
  it("covers the failure modes that make an image unusable", () => {
    // Not a style preference: invented lettering reads as a real sign, and an
    // invented logo is somebody's trademark or a fake of the merchant's own.
    for (const needle of ["text", "logo", "watermark", "people"]) {
      expect(MINK_MEDIA_NEGATIVE_PROMPT).toContain(needle);
    }
  });
});
