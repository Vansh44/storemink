import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  actor: null as null | { id: string; email: string },
  asset: null as null | { bytes: Buffer; mediaType: string },
}));
vi.mock("@/lib/theme-studio/access", () => ({
  getThemeStudioActor: vi.fn(async () => state.actor),
}));
const { read } = vi.hoisted(() => ({
  read: vi.fn<(...args: unknown[]) => Promise<typeof state.asset>>(
    async () => state.asset,
  ),
}));
vi.mock("@/lib/theme-studio/repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/theme-studio/repository")>();
  return { ...actual, getThemeStudioReferenceBytes: read };
});
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));

import { GET } from "./route";

const assetId = "44444444-4444-4444-8444-444444444444";
const get = () =>
  GET(
    new Request(
      `https://storemink.com/api/platform/theme-studio/references/${assetId}`,
    ),
    {
      params: Promise.resolve({ assetId }),
    },
  );

describe("reference read route", () => {
  beforeEach(() => {
    state.actor = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "owner@storemink.com",
    };
    state.asset = {
      bytes: Buffer.from("RIFF0000WEBPdata"),
      mediaType: "image/webp",
    };
  });

  it("answers 404 to a non-superadmin without reading the asset", async () => {
    state.actor = null;
    expect((await get()).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it("serves a superadmin a private, locked-down image", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
  });

  it("answers 404 for an unknown asset", async () => {
    state.asset = null;
    expect((await get()).status).toBe(404);
  });
});
