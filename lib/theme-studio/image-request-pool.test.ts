import { expect, it } from "vitest";
import { ImageRequestPool, imageRequestPool } from "./image-request-pool";

it("shares three permits across clients for the same provider, with FIFO waits", async () => {
  const pool = imageRequestPool("project", "global", "model");
  expect(imageRequestPool("project", "global", "model")).toBe(pool);
  expect(imageRequestPool("other", "global", "model")).not.toBe(pool);
  const starts: number[] = [];
  const release: (() => void)[] = [];
  const runs = Array.from({ length: 6 }, (_, i) =>
    pool.run(async () => {
      starts.push(i);
      await new Promise<void>((resolve) => {
        release[i] = resolve;
      });
    }, new AbortController().signal),
  );
  await Promise.resolve();
  await Promise.resolve();
  expect(starts).toEqual([0, 1, 2]);
  release[0]();
  await runs[0];
  await Promise.resolve();
  expect(starts).toEqual([0, 1, 2, 3]);
  release[1]();
  release[2]();
  release[3]();
  await Promise.all(runs.slice(0, 4));
  await Promise.resolve();
  expect(starts).toEqual([0, 1, 2, 3, 4, 5]);
  release[4]();
  release[5]();
  await Promise.all(runs);
});

it("removes aborted waiters and releases a permit even when the SDK never settles", async () => {
  const pool = new ImageRequestPool(1);
  const first = new AbortController();
  const queued = new AbortController();
  const a = pool.run(() => new Promise(() => {}), first.signal);
  const b = pool.run(async () => {
    throw new Error("must not start");
  }, queued.signal);
  const c = pool.run(async () => "survived", new AbortController().signal);
  const checkA = expect(a).rejects.toThrow("first");
  const checkB = expect(b).rejects.toThrow("queued");
  queued.abort(new Error("queued"));
  first.abort(new Error("first"));
  await Promise.all([checkA, checkB]);
  await expect(c).resolves.toBe("survived");
});

it("pauses queued work during a shared cooldown, probes with one request, then restores capacity gradually", async () => {
  const pool = new ImageRequestPool(3);
  let resume!: () => void;
  pool.coolDown(
    new Promise<void>((resolve) => {
      resume = resolve;
    }),
  );
  const starts: number[] = [];
  const release: (() => void)[] = [];
  const runs = Array.from({ length: 9 }, (_, i) =>
    pool.run(async (epoch) => {
      starts.push(i);
      await new Promise<void>((resolve) => {
        release[i] = resolve;
      });
      pool.recovered(epoch);
    }, new AbortController().signal),
  );
  await Promise.resolve();
  expect(starts).toEqual([]);
  resume();
  const tick = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  await tick();
  expect(starts).toEqual([0]);
  for (let i = 0; i < 3; i++) {
    release[i]();
    await runs[i];
    await tick();
  }
  expect(starts).toEqual([0, 1, 2, 3, 4]);
  for (let i = 3; i < 6; i++) {
    release[i]();
    await runs[i];
    await tick();
  }
  expect(starts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  release.slice(6).forEach((resolve) => resolve());
  await Promise.all(runs);
});

it("does not let stale successes or a cancelled waiter bypass overlapping cooldowns", async () => {
  const pool = new ImageRequestPool(3);
  let a!: () => void;
  let b!: () => void;
  pool.coolDown(
    new Promise<void>((resolve) => {
      a = resolve;
    }),
  );
  pool.coolDown(
    new Promise<void>((resolve) => {
      b = resolve;
    }),
  );
  for (let i = 0; i < 6; i++) pool.recovered(0);
  const cancelled = new AbortController();
  const skipped = pool.run(async () => "bad", cancelled.signal);
  const assertion = expect(skipped).rejects.toThrow("cancelled");
  cancelled.abort(new Error("cancelled"));
  await assertion;
  let started = false;
  const good = pool.run(async () => {
    started = true;
    return "ok";
  }, new AbortController().signal);
  a();
  await Promise.resolve();
  await Promise.resolve();
  expect(started).toBe(false);
  b();
  await expect(good).resolves.toBe("ok");
});
