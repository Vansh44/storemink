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
  return { ...actual, getThemeStudioPlaceholderBytes: read };
});
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));

import { GET } from "./route";

const assetId = "44444444-4444-4444-8444-444444444444";
const get = (id = assetId) =>
  GET(
    new Request(`https://x.storemink.com/api/theme-studio/placeholders/${id}`),
    {
      params: Promise.resolve({ assetId: id }),
    },
  );

describe("placeholder route", () => {
  beforeEach(() => {
    state.asset = {
      bytes: Buffer.from("RIFF0000WEBP"),
      mediaType: "image/webp",
    };
  });

  it("serves a placeholder publicly, immutable and locked down", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    // ★ It asks only for the placeholder purpose; the repository's purpose
    // filter is what keeps a reference's id from finding anything here.
    expect(read).toHaveBeenCalledWith(assetId);
  });

  it("answers 404 for an unknown or malformed id", async () => {
    state.asset = null;
    expect((await get()).status).toBe(404);
    read.mockClear();
    expect((await get("../etc")).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
});
