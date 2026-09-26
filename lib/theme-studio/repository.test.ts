import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));

import { withService } from "@/lib/db/client";
import {
  restoreThemeStudioVersion,
  reviseThemeStudioVersion,
  ThemeStudioError,
  validateProjectInput,
} from "./repository";

const valid = {
  name: "  Clay & Co  ",
  themeId: "Clay-Co",
  brief: "A calm ceramics shop.",
  industries: ["home"],
  catalogSizes: ["small"],
  requiredFeatures: ["faq"],
  baseThemeId: "studio",
  modelKey: "gemini-3.8-flash",
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
      modelKey: "gemini-3.8-flash",
    });
  });

  it("refuses a raw provider model id; only a stable key is accepted", () => {
    expect(refused({ modelKey: "gemini-3.1-pro-preview" })).toMatch(
      /listed models/,
    );
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

describe("revision and restore input", () => {
  const actor = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "owner@storemink.com",
  };
  const ok = {
    projectId: "22222222-2222-4222-8222-222222222222",
    versionId: "33333333-3333-4333-8333-333333333333",
    expectedRevision: 3,
    expectedPackageDigest: "a".repeat(64),
    body: "Make the hero bolder.",
    idempotencyKey: "revise_key_0123456789",
  };

  // Every refusal here happens before the database is opened.
  it("refuses malformed input without touching the database", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ projectId: "p1" }, /no longer exists/],
      [{ versionId: "v1" }, /no longer exists/],
      [{ idempotencyKey: "short" }, /malformed/],
      [{ body: "   " }, /Describe the change/],
      [{ body: "x".repeat(12_001) }, /Describe the change/],
    ];
    for (const [patch, message] of cases) {
      await expect(
        reviseThemeStudioVersion(actor, { ...ok, ...patch } as typeof ok),
      ).rejects.toThrow(message);
    }
    await expect(
      restoreThemeStudioVersion(actor, {
        projectId: ok.projectId,
        versionId: "nope",
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/no longer exists/);
    expect(withService).not.toHaveBeenCalled();
  });
});
