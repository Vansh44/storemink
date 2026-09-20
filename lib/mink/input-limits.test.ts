import { beforeEach, describe, it, expect, vi } from "vitest";
const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  withService: (fn: (db: unknown) => unknown) => fn({ execute: h.execute }),
}));
import { reserveMinkInput } from "./input-limits";
import { MINK_INPUT_FILES } from "./input-policy";
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
      ["mink-input-owner:echos:owner", 15, 60],
      ["mink-input-store:echos", 30, 3600],
      ["mink-input-day:echos", 100, 86400],
      ["mink-input-global", 500, 3600],
      ["mink-input-replay:echos:owner:request", 1, 3600],
    ]);
  });
  // ★★ ONE SEND MUST NEVER EXHAUST THE OWNER BUCKET. It used to: the bucket was
  // 5 and MINK_INPUT_FILES is 5, so a full send spent the minute and the retry
  // — which re-extracts every attachment — was refused outright. Asserted as a
  // RELATIONSHIP, because the literal above is the thing that drifts.
  it("leaves room for a full send plus a retry", async () => {
    await reserveMinkInput(actor, "request");
    const [, owner] = new PgDialect().sqlToQuery(
      h.execute.mock.calls[0][0],
    ).params;
    expect(owner).toBeGreaterThanOrEqual(MINK_INPUT_FILES * 2);
    expect(Number(owner) % MINK_INPUT_FILES).toBe(0);
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
