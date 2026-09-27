import { afterEach, describe, expect, it, vi } from "vitest";

const withService = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("capture gate reached the database");
  }),
);

vi.mock("@/lib/db/client", () => ({ withService }));

import { queueThemeStudioCapture } from "./capture";

describe("Theme Studio catalog capture deployment gate", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a direct queue call before touching the database", async () => {
    vi.stubEnv("THEME_STUDIO_CAPTURE_ENABLED", "false");

    await expect(
      queueThemeStudioCapture(
        { id: "11111111-1111-4111-8111-111111111111", email: "op@test.dev" },
        {
          projectId: "22222222-2222-4222-8222-222222222222",
          versionId: "33333333-3333-4333-8333-333333333333",
          expectedRevision: 1,
          expectedPackageDigest: "d".repeat(64),
          idempotencyKey: "capture-test-key-01",
        },
      ),
    ).rejects.toThrow(/browser worker is deployed/i);
    expect(withService).not.toHaveBeenCalled();
  });
});
