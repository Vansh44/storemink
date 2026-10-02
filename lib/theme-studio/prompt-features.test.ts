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
  });
  expect(themePromptFeatures("theme-studio-v19")).toEqual({
    targetedRepair: true,
    nativeFraming: true,
    nativeCommerce: false,
    compactInitial: false,
  });
  expect(themePromptFeatures(THEME_STUDIO_PROMPT_VERSION)).toEqual({
    targetedRepair: true,
    nativeFraming: true,
    nativeCommerce: true,
    compactInitial: true,
  });
  expect(themePromptFeatures("theme-studio-v21")).toEqual(
    themePromptFeatures(THEME_STUDIO_PROMPT_VERSION),
  );
  expect(themePromptFeatures("invalid").compactInitial).toBe(false);
});
