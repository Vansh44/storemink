import { expect, it, vi } from "vitest";
import { guardLegacyImageRetries } from "./db-migration-guards.mjs";

it("blocks the historical checkpoint upgrade while legacy image work remains", async () => {
  const query = vi.fn(async () => ({ rows: [{ unfinished: 1 }] }));
  await expect(
    guardLegacyImageRetries(
      { query },
      "20261002_0147_theme_studio_image_checkpoints",
    ),
  ).rejects.toThrow("Checkpoint upgrade refused");
  expect(query.mock.calls[0][0]).toContain("share row exclusive");
});
it("allows a drained upgrade and leaves other migrations unaffected", async () => {
  const query = vi.fn(async () => ({ rows: [{ unfinished: 0 }] }));
  await guardLegacyImageRetries(
    { query },
    "20261002_0147_theme_studio_image_checkpoints",
  );
  expect(query).toHaveBeenCalledTimes(2);
  query.mockClear();
  await guardLegacyImageRetries(
    { query },
    "20261002_0149_theme_studio_provider_capacity",
  );
  expect(query).not.toHaveBeenCalled();
});
it("refuses to lower retry allowance below an unfinished legacy run's existing claims", async () => {
  const query = vi.fn(async () => ({ rows: [{ unfinished: 1 }] }));
  await expect(
    guardLegacyImageRetries(
      { query },
      "20261002_0150_theme_studio_recovery_safety",
    ),
  ).rejects.toThrow("multiple claims and no checkpoints");
  expect(query.mock.calls[1][0]).toContain("attempt_count>1");
});
