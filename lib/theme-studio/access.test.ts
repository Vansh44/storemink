import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: null as null | { email?: string | null },
  rows: [] as unknown[],
  fail: false,
}));

vi.mock("@/lib/auth/server-user", () => ({
  getServerUser: vi.fn(async () => state.user),
}));
vi.mock("@/lib/db/client", () => ({
  withService: vi.fn(async (run: (db: unknown) => unknown) => {
    if (state.fail) throw new Error("db down");
    return run({
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => state.rows }) }),
      }),
    });
  }),
}));

import { getThemeStudioActor } from "./access";

describe("Theme Studio actor gate", () => {
  beforeEach(() => {
    state.user = { email: "Owner@StoreMink.com" };
    state.rows = [];
    state.fail = false;
  });

  it("admits a superadmin and carries the platform_admins id", async () => {
    state.rows = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        email: "owner@storemink.com",
        role: "superadmin",
      },
    ];
    await expect(getThemeStudioActor()).resolves.toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      email: "owner@storemink.com",
    });
  });

  it("refuses a platform member, a stranger and an anonymous request", async () => {
    state.rows = [{ id: "x", email: "m@storemink.com", role: "member" }];
    await expect(getThemeStudioActor()).resolves.toBeNull();
    state.rows = [];
    await expect(getThemeStudioActor()).resolves.toBeNull();
    state.user = null;
    await expect(getThemeStudioActor()).resolves.toBeNull();
  });

  it("fails closed when the operator table can't be read", async () => {
    state.fail = true;
    await expect(getThemeStudioActor()).resolves.toBeNull();
  });
});
