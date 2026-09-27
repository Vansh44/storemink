import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  actor: null as null | { id: string; email: string },
  allowed: true,
  target: null as null | {
    slot: { id: string };
    target: { width: number; height: number; aspect: number };
    byteLimit: number;
  },
}));

vi.mock("@/lib/theme-studio/access", () => ({
  getThemeStudioActor: vi.fn(async () => state.actor),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: state.allowed })),
}));
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
const { store } = vi.hoisted(() => ({
  store: vi.fn<
    (...args: unknown[]) => Promise<{ id: string; duplicate: boolean }>
  >(async () => ({
    id: "66666666-6666-4666-8666-666666666666",
    duplicate: false,
  })),
}));
vi.mock("@/lib/theme-studio/slot-images", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/theme-studio/slot-images")>();
  return {
    ...actual,
    slotUploadTarget: vi.fn(async () => state.target),
    storeThemeStudioSlotImage: store,
  };
});

import sharp from "sharp";
import { POST } from "./route";

const projectId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";

function post(
  body: BodyInit | null,
  {
    slot = "home-hero",
    origin = "https://storemink.com",
    version = versionId,
  } = {},
) {
  return POST(
    new Request(
      `https://storemink.com/api/platform/theme-studio/projects/${projectId}/slot-images?versionId=${version}&slot=${slot}`,
      {
        method: "POST",
        body,
        headers: { origin, host: "storemink.com" },
      },
    ),
    { params: Promise.resolve({ projectId }) },
  );
}

const photo = (width: number, height: number) =>
  sharp({
    create: { width, height, channels: 3, background: "#aa7744" },
  })
    .jpeg()
    .toBuffer();

describe("slot image upload route", () => {
  beforeEach(() => {
    state.actor = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "owner@storemink.com",
    };
    state.allowed = true;
    state.target = {
      slot: { id: "home-hero" },
      target: { width: 1600, height: 1200, aspect: 4 / 3 },
      byteLimit: 500 * 1024,
    };
  });

  it("refuses anyone who isn't a superadmin, and a cross-origin request", async () => {
    state.actor = null;
    expect((await post(await photo(1600, 1200))).status).toBe(403);
    state.actor = { id: "x", email: "y" };
    expect(
      (await post(await photo(1600, 1200), { origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect(store).not.toHaveBeenCalled();
  });

  it("404s a malformed slot or version, or a slot the version lacks", async () => {
    expect((await post(await photo(1600, 1200), { slot: "../x" })).status).toBe(
      404,
    );
    expect(
      (await post(await photo(1600, 1200), { version: "nope" })).status,
    ).toBe(404);
    state.target = null;
    expect((await post(await photo(1600, 1200))).status).toBe(404);
    expect(store).not.toHaveBeenCalled();
  });

  it("rate-limits uploads", async () => {
    state.allowed = false;
    expect((await post(await photo(1600, 1200))).status).toBe(429);
  });

  it("refuses an image too small for the slot, with the reason", async () => {
    const res = await post(await photo(900, 300));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("too_small");
    expect(store).not.toHaveBeenCalled();
  });

  it("stores a cropped WebP and returns where it is served", async () => {
    const res = await post(await photo(2400, 1200));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      url: "/api/theme-studio/images/66666666-6666-4666-8666-666666666666",
      width: 1600,
      height: 1200,
    });
    const stored = store.mock.calls[0][1] as {
      slotId: string;
      image: { mediaType: string; width: number };
    };
    expect(stored.slotId).toBe("home-hero");
    expect(stored.image.mediaType).toBe("image/webp");
  });
});
