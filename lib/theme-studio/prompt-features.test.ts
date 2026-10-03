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
  });
  expect(themePromptFeatures("theme-studio-v19")).toEqual({
    targetedRepair: true,
    nativeFraming: true,
    nativeCommerce: false,
    compactInitial: false,
    variety: false,
  });
  expect(themePromptFeatures(THEME_STUDIO_PROMPT_VERSION)).toEqual({
    targetedRepair: true,
    nativeFraming: true,
    nativeCommerce: true,
    compactInitial: true,
    variety: true,
  });
  expect(themePromptFeatures("theme-studio-v22")).toEqual(
    themePromptFeatures(THEME_STUDIO_PROMPT_VERSION),
  );
  expect(themePromptFeatures("invalid").compactInitial).toBe(false);
});

it("enables variety only for v21 and later", () => {
  expect(themePromptFeatures("theme-studio-v20").variety).toBe(false);
  expect(themePromptFeatures("theme-studio-v21").variety).toBe(true);
});
