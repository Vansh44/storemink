import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));

import { ThemeStudioError, validateProjectInput } from "./repository";

const valid = {
  name: "  Clay & Co  ",
  themeId: "Clay-Co",
  brief: "A calm ceramics shop.",
  industries: ["home"],
  catalogSizes: ["small"],
  requiredFeatures: ["faq"],
  baseThemeId: "studio",
  modelKey: "opus-5",
};

function refused(input: Record<string, unknown>): string {
  try {
    validateProjectInput({ ...valid, ...input });
  } catch (error) {
    expect(error).toBeInstanceOf(ThemeStudioError);
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("Theme Studio project input", () => {
  it("normalizes a valid request", () => {
    expect(validateProjectInput(valid)).toEqual({
      name: "Clay & Co",
      themeId: "clay-co",
      brief: "A calm ceramics shop.",
      industries: ["home"],
      catalogSizes: ["small"],
      requiredFeatures: ["faq"],
      baseThemeId: "studio",
      modelKey: "opus-5",
    });
  });

  it("refuses a raw provider model id; only a stable key is accepted", () => {
    expect(refused({ modelKey: "claude-opus-5" })).toMatch(/listed models/);
    expect(refused({ modelKey: "gemini-3.7-flash" })).toMatch(/listed models/);
  });

  it("refuses malformed, demo-namespaced and oversized ids", () => {
    expect(refused({ themeId: "ab" })).toMatch(/3–80/);
    expect(refused({ themeId: "has space" })).toMatch(/3–80/);
    expect(refused({ themeId: "demo-anything" })).toMatch(/demo-/);
  });

  it("refuses unknown vocabulary rather than silently dropping it", () => {
    expect(refused({ industries: ["home", "casino"] })).toMatch(
      /unknown value/,
    );
    expect(refused({ industries: [] })).toMatch(/between 1 and 5/);
    expect(refused({ requiredFeatures: ["custom-code"] })).toMatch(
      /unknown value/,
    );
  });

  it("refuses a base theme that isn't bundled", () => {
    expect(refused({ baseThemeId: "made-up" })).toMatch(/base theme/);
    expect(
      validateProjectInput({ ...valid, baseThemeId: "" }).baseThemeId,
    ).toBeNull();
  });

  it("bounds the brief", () => {
    expect(refused({ brief: "   " })).toMatch(/design brief/);
    expect(refused({ brief: "x".repeat(12_001) })).toMatch(/design brief/);
  });
});
