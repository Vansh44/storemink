import { beforeEach, describe, it, expect, vi } from "vitest";
const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  withService: (fn: (db: unknown) => unknown) => fn({ execute: h.execute }),
}));
import { reserveMinkInput } from "./input-limits";
import { PgDialect } from "drizzle-orm/pg-core";
import type { MinkActorContext } from "./types";
const actor = { storeId: "echos", adminId: "owner" } as MinkActorContext;
beforeEach(() => {
  vi.resetAllMocks();
  h.execute.mockResolvedValue({ rows: [{ allowed: true }] });
});
describe("fail-closed input budget", () => {
  it("reserves duplicate/owner/store/hour/day/platform limits", async () => {
    await reserveMinkInput(actor, "request");
    expect(h.execute).toHaveBeenCalledTimes(5);
    expect(
      h.execute.mock.calls.map(
        ([query]) => new PgDialect().sqlToQuery(query).params,
      ),
    ).toEqual([
      ["mink-input-owner:echos:owner", 5, 60],
      ["mink-input-store:echos", 30, 3600],
      ["mink-input-day:echos", 100, 86400],
      ["mink-input-global", 500, 3600],
      ["mink-input-replay:echos:owner:request", 1, 3600],
    ]);
  });
  it.each([false, null, undefined, "true"])(
    "only accepts boolean true, not %s",
    async (allowed) => {
      h.execute.mockResolvedValue({ rows: [{ allowed }] });
      await expect(reserveMinkInput(actor, "request")).rejects.toThrow();
      expect(h.execute).toHaveBeenCalledTimes(1);
    },
  );
  it("does not fail open on database errors", async () => {
    h.execute.mockRejectedValue(new Error("db unavailable"));
    await expect(reserveMinkInput(actor, "request")).rejects.toThrow();
  });
});
