import { describe, it, expect, vi } from "vitest";
import { readMinkBoundedBytes, readMinkBoundedJson } from "./bounded-json";
describe("bounded Mink JSON", () => {
  it("cancels a stalled body when its processing deadline expires", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream({ cancel: cancelled });
    const controller = new AbortController();
    const promise = readMinkBoundedJson(
      { body } as Request,
      100,
      controller.signal,
    );
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(cancelled).toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });
  it("accepts bounded objects without trusting a length header", async () => {
    expect(
      await readMinkBoundedJson(
        new Request("https://example.test", {
          method: "POST",
          body: '{"ok":true}',
        }),
        20,
      ),
    ).toEqual({ ok: true });
  });
  it("refuses oversized bodies with missing or forged content length", async () => {
    await expect(
      readMinkBoundedJson(
        new Request("https://example.test", {
          method: "POST",
          headers: { "Content-Length": "1" },
          body: JSON.stringify({ text: "x".repeat(200) }),
        }),
        20,
      ),
    ).rejects.toMatchObject({ status: 413 });
  });
  it.each(["[]", "null", "no-json"])(
    "rejects malformed/nonobject input %s",
    async (body) => {
      await expect(
        readMinkBoundedJson(
          new Request("https://example.test", { method: "POST", body }),
          100,
        ),
      ).rejects.toMatchObject({ status: 400 });
    },
  );
});

describe("bounded Mink bytes", () => {
  it("reads raw bytes and refuses an oversized stream", async () => {
    await expect(
      readMinkBoundedBytes(
        new Request("https://example.test", {
          method: "POST",
          body: new Uint8Array([1, 2, 3]),
        }),
        3,
      ),
    ).resolves.toEqual(Buffer.from([1, 2, 3]));
    await expect(
      readMinkBoundedBytes(
        new Request("https://example.test", {
          method: "POST",
          body: new Uint8Array([1, 2, 3, 4]),
        }),
        3,
      ),
    ).rejects.toMatchObject({ status: 413 });
  });
});
