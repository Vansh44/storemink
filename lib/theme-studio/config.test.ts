import { describe, expect, it } from "vitest";
import { getThemeStudioConfig, isImplementedProvider } from "./config";

describe("Theme Studio config", () => {
  it("defaults to the offline provider with generation on", () => {
    expect(getThemeStudioConfig({})).toEqual({
      generationEnabled: true,
      provider: "fake",
    });
  });

  it("has an emergency stop independent of merchant Mink", () => {
    expect(
      getThemeStudioConfig({
        THEME_STUDIO_GENERATION_ENABLED: "false",
        MINK_AI_ENABLED: "true",
      }).generationEnabled,
    ).toBe(false);
    expect(
      getThemeStudioConfig({ MINK_AI_ENABLED: "false" }).generationEnabled,
    ).toBe(true);
  });

  it("refuses an unknown provider and one this build cannot execute", () => {
    expect(
      getThemeStudioConfig({ THEME_STUDIO_PROVIDER: "openai" }).provider,
    ).toBeNull();
    const anthropic = getThemeStudioConfig({
      THEME_STUDIO_PROVIDER: "anthropic-vertex",
    }).provider;
    expect(anthropic).toBe("anthropic-vertex");
    expect(isImplementedProvider(anthropic)).toBe(false);
    expect(isImplementedProvider("fake")).toBe(true);
    expect(isImplementedProvider(null)).toBe(false);
  });
});
