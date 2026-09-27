import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const P = "11111111-1111-4111-8111-111111111111";
const V = "22222222-2222-4222-8222-222222222222";
const S = "33333333-3333-4333-8333-333333333333";
const A = "55555555-5555-4555-8555-555555555555";

const state = vi.hoisted(() => ({
  store: null as null | { slug: string; settings: unknown },
  mayPreview: true,
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (run: (db: unknown) => unknown) =>
    run({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (state.store ? [state.store] : []),
          }),
        }),
      }),
    }),
  ),
}));
vi.mock("@/lib/theme-studio/preview-access", () => ({
  actorMayPreview: vi.fn(async () => state.mayPreview),
}));

import { GET } from "./route";
import {
  PREVIEW_COOKIE,
  signPreviewToken,
  verifyPreviewToken,
} from "@/lib/theme-studio/preview-token";

function request(
  token: string,
  opts: { host?: string; path?: string; dest?: string } = {},
) {
  const url = new URL("http://internal:3000/api/theme-studio/preview/enter");
  url.searchParams.set("token", token);
  if (opts.path !== undefined) url.searchParams.set("path", opts.path);
  return new NextRequest(url, {
    headers: {
      host: opts.host ?? "studio-preview-abc.storemink.com",
      ...(opts.dest ? { "sec-fetch-dest": opts.dest } : {}),
    },
  });
}

const enter = () =>
  signPreviewToken("enter", { storeId: S, versionId: V, actorId: A }, 600);

describe("preview enter route", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "test-secret");
    state.store = {
      slug: "studio-preview-abc",
      settings: { demo: true, studioPreview: { projectId: P, versionId: V } },
    };
    state.mayPreview = true;
  });

  it("exchanges a valid entry token for a version-bound grant and a relative redirect", async () => {
    const res = await GET(request(enter(), { path: "/shop" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/shop");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const cookie = res.cookies.get(PREVIEW_COOKIE);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("lax");
    const grant = verifyPreviewToken(cookie!.value, "grant");
    expect(grant).toMatchObject({ sid: S, vid: V, aid: A });
  });

  it("gives a framed request a Partitioned SameSite=None cookie", async () => {
    const res = await GET(request(enter(), { dest: "iframe" }));
    const cookie = res.cookies.get(PREVIEW_COOKIE);
    expect(cookie?.sameSite).toBe("none");
    expect(cookie?.secure).toBe(true);
    expect(cookie?.partitioned).toBe(true);
  });

  it("refuses a grant used as an entry token, and a forged one", async () => {
    const grant = signPreviewToken(
      "grant",
      { storeId: S, versionId: V, actorId: A },
      600,
    );
    expect((await GET(request(grant))).status).toBe(403);
    expect((await GET(request("abc.def"))).status).toBe(403);
  });

  it("refuses a token for another host, another version, or a non-preview store", async () => {
    expect(
      (
        await GET(
          request(enter(), { host: "studio-preview-zzz.storemink.com" }),
        )
      ).status,
    ).toBe(403);
    state.store = {
      slug: "studio-preview-abc",
      settings: {
        demo: true,
        studioPreview: {
          projectId: P,
          versionId: "66666666-6666-4666-8666-666666666666",
        },
      },
    };
    expect((await GET(request(enter()))).status).toBe(403);
    state.store = { slug: "studio-preview-abc", settings: {} };
    expect((await GET(request(enter()))).status).toBe(403);
  });

  it("refuses when the actor is no longer allowed to preview", async () => {
    state.mayPreview = false;
    expect((await GET(request(enter()))).status).toBe(403);
  });

  it("never redirects off the preview host", async () => {
    const res = await GET(request(enter(), { path: "//evil.example" }));
    expect(res.headers.get("location")).toBe("/");
  });
});
