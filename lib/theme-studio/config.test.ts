import { describe, expect, it } from "vitest";
import { getThemeStudioConfig, isImplementedProvider } from "./config";

describe("Theme Studio config", () => {
  it("defaults to the offline provider with generation on", () => {
    expect(getThemeStudioConfig({})).toMatchObject({
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

  it("refuses an unknown provider and accepts the two implemented ones", () => {
    expect(
      getThemeStudioConfig({ THEME_STUDIO_PROVIDER: "openai" }).provider,
    ).toBeNull();
    const gemini = getThemeStudioConfig({
      THEME_STUDIO_PROVIDER: "vertex-gemini",
    }).provider;
    expect(gemini).toBe("vertex-gemini");
    expect(isImplementedProvider(gemini)).toBe(true);
    // The retired provider name is refused, not silently mapped.
    expect(
      getThemeStudioConfig({ THEME_STUDIO_PROVIDER: "anthropic-vertex" })
        .provider,
    ).toBeNull();
    expect(isImplementedProvider("fake")).toBe(true);
    expect(isImplementedProvider(null)).toBe(false);
  });

  it("parses per-model switches and the daily spend cap", () => {
    const config = getThemeStudioConfig({
      THEME_STUDIO_DISABLED_MODELS:
        "gemini-3.1-pro, gemini-3.1-pro-preview ,nonsense",
      THEME_STUDIO_DAILY_SPEND_USD: "12.5",
    });
    // Only allowlisted KEYS disable anything; a raw provider id is ignored.
    expect([...config.disabledModels]).toEqual(["gemini-3.1-pro"]);
    expect(config.dailySpendMicroUsd).toBe(12_500_000);
    expect(getThemeStudioConfig({}).dailySpendMicroUsd).toBe(25_000_000);
    expect(
      getThemeStudioConfig({ THEME_STUDIO_DAILY_SPEND_USD: "-3" })
        .dailySpendMicroUsd,
    ).toBe(25_000_000);
  });
});
