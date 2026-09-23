import { describe, expect, it } from "vitest";
import {
  THEME_STUDIO_MODELS,
  THEME_STUDIO_MODEL_KEYS,
  parseThemeStudioModelKey,
  resolveThemeStudioModel,
  themeStudioModelOptions,
} from "./models";

describe("Theme Studio model registry", () => {
  it("exposes exactly the two task-scoped Gemini choices, Flash first", () => {
    expect(THEME_STUDIO_MODELS.map((model) => model.key)).toEqual([
      "gemini-3.8-flash",
      "gemini-3.1-pro",
    ]);
    expect(new Set(THEME_STUDIO_MODEL_KEYS).size).toBe(2);
    expect(themeStudioModelOptions()).toEqual(
      THEME_STUDIO_MODELS.map(({ key, label, purpose }) => ({
        key,
        label,
        purpose,
      })),
    );
    expect(themeStudioModelOptions()).not.toHaveProperty("0.providerModel");
  });

  it("accepts stable UI keys and refuses raw provider or merchant model ids", () => {
    expect(parseThemeStudioModelKey("gemini-3.8-flash")).toBe(
      "gemini-3.8-flash",
    );
    expect(parseThemeStudioModelKey("gemini-3.1-pro")).toBe("gemini-3.1-pro");
    // The Pro key is not its provider id, so a raw id cannot be posted.
    expect(parseThemeStudioModelKey("gemini-3.1-pro-preview")).toBeNull();
    // Merchant Mink's model is not a Theme Studio model.
    expect(parseThemeStudioModelKey("gemini-3.7-flash")).toBeNull();
    expect(parseThemeStudioModelKey("gemini-3.1-flash-lite")).toBeNull();
    expect(parseThemeStudioModelKey(5)).toBeNull();
  });

  it("resolves provider ids only after allowlisting", () => {
    expect(resolveThemeStudioModel("gemini-3.8-flash", {})).toMatchObject({
      key: "gemini-3.8-flash",
      providerModel: "gemini-3.8-flash",
    });
    expect(resolveThemeStudioModel("gemini-3.1-pro", {})).toMatchObject({
      key: "gemini-3.1-pro",
      providerModel: "gemini-3.1-pro-preview",
    });
  });

  it("lets an override pin a version of the same model and nothing else", () => {
    for (const pinned of [
      "gemini-3.8-flash-001",
      "gemini-3.8-flash-09-2026",
      "gemini-3.8-flash-09-15",
    ]) {
      expect(
        resolveThemeStudioModel("gemini-3.8-flash", {
          THEME_STUDIO_GEMINI_38_FLASH_MODEL: pinned,
        }).providerModel,
      ).toBe(pinned);
    }
    for (const swapped of [
      "gemini-3.8-flash-lite",
      "gemini-3.7-flash",
      "gemini-3.8-flash-image",
      "gemini-3.8-flash@001",
    ]) {
      expect(() =>
        resolveThemeStudioModel("gemini-3.8-flash", {
          THEME_STUDIO_GEMINI_38_FLASH_MODEL: swapped,
        }),
      ).toThrow("must stay within the gemini-3.8-flash model family");
    }
    expect(
      resolveThemeStudioModel("gemini-3.1-pro", {
        THEME_STUDIO_GEMINI_31_PRO_MODEL: "gemini-3.1-pro-preview-09-2026",
      }).providerModel,
    ).toBe("gemini-3.1-pro-preview-09-2026");
  });
});
