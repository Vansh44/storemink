import { describe, expect, it } from "vitest";
import {
  THEME_STUDIO_MODELS,
  THEME_STUDIO_MODEL_KEYS,
  parseThemeStudioModelKey,
  resolveThemeStudioModel,
  themeStudioModelOptions,
} from "./models";

describe("Theme Studio model registry", () => {
  it("exposes exactly the three task-scoped model choices", () => {
    expect(THEME_STUDIO_MODELS.map((model) => model.key)).toEqual([
      "opus-5",
      "opus-5.5",
      "fable-5",
    ]);
    expect(new Set(THEME_STUDIO_MODEL_KEYS).size).toBe(3);
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
    expect(parseThemeStudioModelKey("opus-5")).toBe("opus-5");
    expect(parseThemeStudioModelKey("opus-5.5")).toBe("opus-5.5");
    expect(parseThemeStudioModelKey("fable-5")).toBe("fable-5");
    expect(parseThemeStudioModelKey("claude-opus-5")).toBeNull();
    expect(parseThemeStudioModelKey("gemini-3.7-flash")).toBeNull();
    expect(parseThemeStudioModelKey(5)).toBeNull();
  });

  it("resolves provider ids only after allowlisting and honors a scoped override", () => {
    expect(resolveThemeStudioModel("opus-5", {})).toMatchObject({
      key: "opus-5",
      providerModel: "claude-opus-5",
    });
    expect(
      resolveThemeStudioModel("opus-5.5", {
        THEME_STUDIO_CLAUDE_OPUS_55_MODEL: "claude-opus-5-5@verified",
      }),
    ).toMatchObject({
      key: "opus-5.5",
      providerModel: "claude-opus-5-5@verified",
    });
    expect(() =>
      resolveThemeStudioModel("opus-5", {
        THEME_STUDIO_CLAUDE_OPUS_5_MODEL: "gemini-3.7-flash",
      }),
    ).toThrow("must stay within the claude-opus-5 model family");
  });
});
