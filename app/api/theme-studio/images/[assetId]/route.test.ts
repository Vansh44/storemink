import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  asset: null as null | { bytes: Buffer; mediaType: string },
}));
const { read } = vi.hoisted(() => ({
  read: vi.fn<(...args: unknown[]) => Promise<typeof state.asset>>(
    async () => state.asset,
  ),
}));
vi.mock("@/lib/theme-studio/repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/theme-studio/repository")>();
  return { ...actual, getThemeStudioSlotImageBytes: read };
});
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));

import { GET } from "./route";

const assetId = "55555555-5555-4555-8555-555555555555";
const get = (id = assetId) =>
  GET(new Request(`https://x.storemink.com/api/theme-studio/images/${id}`), {
    params: Promise.resolve({ assetId: id }),
  });

describe("slot image route", () => {
  beforeEach(() => {
    state.asset = {
      bytes: Buffer.from("RIFF0000WEBP"),
      mediaType: "image/webp",
    };
  });

  it("serves an operator image publicly, immutable and locked down", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(read).toHaveBeenCalledWith(assetId);
  });

  it("404s a malformed id without a lookup, and an unknown or non-image one", async () => {
    expect((await get("nope")).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
    state.asset = null;
    expect((await get()).status).toBe(404);
  });
});
