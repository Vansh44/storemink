import { describe, expect, it, vi } from "vitest";
import {
  coordinatedProviderCapacity,
  providerCapacityKey,
  type CapacityStore,
} from "./provider-capacity";

describe("shared provider capacity", () => {
  it("waits without starting paid work and releases the permit after registering a cooldown", async () => {
    const events: string[] = [];
    let claims = 0;
    const store: CapacityStore = {
      async claim(_, id) {
        events.push("claim");
        return ++claims === 1 ? null : { id, epoch: 1 };
      },
      async renew() {
        return true;
      },
      async release(_, __, success) {
        events.push(`release:${success}`);
      },
      async pause() {
        events.push("pause");
      },
    };
    const capacity = coordinatedProviderCapacity(store, "key", {
      async sleep() {
        events.push("wait");
        return true;
      },
    });
    await expect(
      capacity.run(async (permit) => {
        events.push("paid");
        await permit.rateLimited(15000);
        return "429";
      }, new AbortController().signal),
    ).resolves.toBe("429");
    expect(events).toEqual([
      "claim",
      "wait",
      "claim",
      "paid",
      "pause",
      "release:false",
    ]);
  });
  it("fails closed before transport on database failure", async () => {
    const operation = vi.fn();
    const store = {
      claim: vi.fn().mockRejectedValue(new Error("DB down")),
    } as unknown as CapacityStore;
    await expect(
      coordinatedProviderCapacity(store, "key").run(
        operation,
        new AbortController().signal,
      ),
    ).rejects.toThrow("DB down");
    expect(operation).not.toHaveBeenCalled();
  });
  it("releases a claim that commits after cancellation", async () => {
    let resolve!: (v: { id: string; epoch: number }) => void;
    const release = vi.fn(async () => {});
    const store = {
      claim: () =>
        new Promise((r) => {
          resolve = r;
        }),
      release,
    } as unknown as CapacityStore;
    const controller = new AbortController();
    const run = coordinatedProviderCapacity(store, "key").run(
      vi.fn(),
      controller.signal,
    );
    controller.abort(new Error("cancelled"));
    await expect(run).rejects.toThrow("cancelled");
    resolve({ id: "late", epoch: 0 });
    await vi.waitFor(() =>
      expect(release).toHaveBeenCalledWith(
        "key",
        { id: "late", epoch: 0 },
        false,
      ),
    );
  });
  it("aborts in-flight transport when renewal is fenced out, while preserving paid responses on cleanup failure", async () => {
    const release = vi.fn(async () => {
      throw new Error("DB down");
    });
    const store: CapacityStore = {
      async claim(_, id) {
        return { id, epoch: 0 };
      },
      async renew() {
        return false;
      },
      release,
      async pause() {},
    };
    const capacity = coordinatedProviderCapacity(store, "key", {
      heartbeatMs: 5,
    });
    await expect(
      capacity.run(
        (permit) =>
          new Promise((_, reject) =>
            permit.signal.addEventListener("abort", () =>
              reject(permit.signal.reason),
            ),
          ),
        new AbortController().signal,
      ),
    ).rejects.toThrow("lease lost");
    expect(release).toHaveBeenCalledWith("key", expect.anything(), false);
    await expect(
      capacity.run(async (permit) => {
        permit.succeeded();
        return "paid bytes";
      }, new AbortController().signal),
    ).resolves.toBe("paid bytes");
  });
  it("separates project, region and model scopes without storing their names", () => {
    const key = providerCapacityKey("project", "global", "model");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toBe(providerCapacityKey("project", "us", "model"));
    expect(key).not.toBe(providerCapacityKey("project", "global", "other"));
  });
  it("returns paid bytes even when permit cleanup never answers", async () => {
    const cleanupError = vi.fn();
    const store: CapacityStore = {
      async claim(_, id) {
        return { id, epoch: 0 };
      },
      async renew() {
        return true;
      },
      release: () => new Promise(() => {}),
      async pause() {},
    };
    const result = await coordinatedProviderCapacity(store, "key", {
      onCleanupError: cleanupError,
    }).run(async (permit) => {
      permit.succeeded();
      return "paid bytes";
    }, new AbortController().signal);
    expect(result).toBe("paid bytes");
    expect(cleanupError).toHaveBeenCalledOnce();
  }, 10000);
});
