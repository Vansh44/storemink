import { expect, it, vi } from "vitest";
import { abortable } from "./abortable";

it("settles on cancellation even when the SDK ignores its signal", async () => {
  const controller = new AbortController();
  let rejectLate!: (reason: unknown) => void;
  const promise = abortable(
    () =>
      new Promise((_, reject) => {
        rejectLate = reject;
      }),
    controller.signal,
  );
  await Promise.resolve();
  const check = expect(promise).rejects.toThrow("deadline");
  controller.abort(new Error("deadline"));
  await check;
  rejectLate(new Error("late SDK failure"));
});

it("never starts an already cancelled call", async () => {
  const operation = vi.fn();
  await expect(
    abortable(operation, AbortSignal.abort(new Error("cancelled"))),
  ).rejects.toThrow("cancelled");
  expect(operation).not.toHaveBeenCalled();
});

it("returns successful results and catches synchronous adapter failures", async () => {
  const signal = new AbortController().signal;
  await expect(abortable(async () => 42, signal)).resolves.toBe(42);
  await expect(
    abortable(() => {
      throw new Error("adapter");
    }, signal),
  ).rejects.toThrow("adapter");
});
