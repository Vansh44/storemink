import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ service: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withService: h.service }));

import { getMinkVoiceProvider } from "./voice-settings";

beforeEach(() => {
  vi.resetAllMocks();
  h.service.mockImplementation((fn) =>
    fn({
      select: () => ({
        from: () => ({ where: () => ({ limit: h.limit }) }),
      }),
    }),
  );
});

describe("global Mink voice setting", () => {
  it("returns the stored global provider", async () => {
    h.limit.mockResolvedValue([{ provider: "saaras_v4" }]);
    await expect(getMinkVoiceProvider()).resolves.toBe("saaras_v4");
  });

  it("defaults to Chirp 3 when the singleton row is absent", async () => {
    h.limit.mockResolvedValue([]);
    await expect(getMinkVoiceProvider()).resolves.toBe("chirp_3");
  });

  it("does not silently change providers when the settings read fails", async () => {
    h.limit.mockRejectedValue(new Error("database unavailable"));
    await expect(getMinkVoiceProvider()).rejects.toThrow(
      "database unavailable",
    );
  });
});
