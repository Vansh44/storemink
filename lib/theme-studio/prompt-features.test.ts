import { expect, it } from "vitest";
import {
  THEME_STUDIO_PROMPT_VERSION,
  themePromptFeatures,
} from "./prompt-features";

it("preserves old paid request shapes and carries capabilities into future prompt revisions", () => {
  expect(themePromptFeatures("theme-studio-v18")).toEqual({
    targetedRepair: false,
    nativeFraming: false,
    nativeCommerce: false,
    compactInitial: false,
    variety: false,
    stableAssetIds: false,
  });
  expect(themePromptFeatures("theme-studio-v19")).toEqual({
    targetedRepair: true,
    nativeFraming: true,
    nativeCommerce: false,
    compactInitial: false,
    variety: false,
    stableAssetIds: false,
  });
  expect(themePromptFeatures(THEME_STUDIO_PROMPT_VERSION)).toEqual({
    targetedRepair: true,
    nativeFraming: true,
    nativeCommerce: true,
    compactInitial: true,
    variety: true,
    stableAssetIds: true,
  });
  expect(themePromptFeatures("theme-studio-v23")).toEqual(
    themePromptFeatures(THEME_STUDIO_PROMPT_VERSION),
  );
  expect(themePromptFeatures("invalid").compactInitial).toBe(false);
});

it("enables variety only for v21 and later", () => {
  expect(themePromptFeatures("theme-studio-v20").variety).toBe(false);
  expect(themePromptFeatures("theme-studio-v21").variety).toBe(true);
});

it("asks revisions to keep slot ids only from v22, so v21 requests replay unchanged", () => {
  expect(themePromptFeatures("theme-studio-v21").stableAssetIds).toBe(false);
  expect(themePromptFeatures("theme-studio-v22").stableAssetIds).toBe(true);
});
