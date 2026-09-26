import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  actor: null as null | { id: string; email: string },
  allowed: true,
}));

vi.mock("@/lib/theme-studio/access", () => ({
  getThemeStudioActor: vi.fn(async () => state.actor),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: state.allowed })),
}));
const { add } = vi.hoisted(() => ({
  add: vi.fn<
    (...args: unknown[]) => Promise<{ id: string; duplicate: boolean }>
  >(async () => ({ id: "asset-1", duplicate: false })),
}));
vi.mock("@/lib/theme-studio/repository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/theme-studio/repository")>();
  return { ...actual, addThemeStudioReference: add };
});
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));

import sharp from "sharp";
import { POST } from "./route";

const projectId = "22222222-2222-4222-8222-222222222222";

function post(body: BodyInit | null, headers: Record<string, string> = {}) {
  return POST(
    new Request(
      `https://storemink.com/api/platform/theme-studio/projects/${projectId}/references`,
      {
        method: "POST",
        body,
        headers: {
          origin: "https://storemink.com",
          host: "storemink.com",
          ...headers,
        },
      },
    ),
    { params: Promise.resolve({ projectId }) },
  );
}

const png = () =>
  sharp({
    create: { width: 20, height: 10, channels: 3, background: "#abcdef" },
  })
    .png()
    .toBuffer();

describe("reference upload route", () => {
  beforeEach(() => {
    state.actor = {
      id: "11111111-1111-4111-8111-111111111111",
      email: "owner@storemink.com",
    };
    state.allowed = true;
  });

  it("refuses anyone who isn't a superadmin, before reading the body", async () => {
    state.actor = null;
    const response = await post(await png());
    expect(response.status).toBe(403);
    expect(add).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin browser request", async () => {
    const response = await post(await png(), {
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
    expect(add).not.toHaveBeenCalled();
  });

  it("refuses a non-image body without storing anything", async () => {
    const response = await post(
      Buffer.from("<svg><script>alert(1)</script></svg>"),
    );
    expect(response.status).toBe(400);
    expect(add).not.toHaveBeenCalled();
  });

  it("refuses an oversized declared body", async () => {
    const response = await post(await png(), {
      "content-length": String(11 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
  });

  it("rate-limits per operator", async () => {
    state.allowed = false;
    expect((await post(await png())).status).toBe(429);
  });

  it("stores only the sanitized re-encode", async () => {
    const response = await post(await png());
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [, id, stored] = add.mock.calls[0] as unknown as [
      unknown,
      string,
      { mediaType: string; originalMediaType: string },
    ];
    expect(id).toBe(projectId);
    expect(stored.mediaType).toBe("image/webp");
    expect(stored.originalMediaType).toBe("image/png");
  });
});
