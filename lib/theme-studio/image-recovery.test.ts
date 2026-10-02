import { describe, expect, it, vi } from "vitest";
import {
  imageCheckpointUsage,
  imageReviewRecoveryDelayMs,
  resumableImageClient,
  resumableImageReview,
  type ImageCheckpoint,
  type ImageCheckpointStore,
} from "./image-recovery";
import {
  ZERO_IMAGE_USAGE,
  type ThemeImageRequest,
  type ThemeStudioImageClient,
} from "./image-provider";
import { ZERO_USAGE } from "./provider";
import type { ThemeImageReviewInput } from "./image-review";

function memory() {
  const records = new Map<string, ImageCheckpoint>();
  const store: ImageCheckpointStore = {
    read: async (key) => records.get(key) ?? null,
    write: async (key, value) => {
      if (!records.has(key)) records.set(key, structuredClone(value));
    },
  };
  return { records, store };
}
const signal = () => new AbortController().signal;
const request = (id: string): ThemeImageRequest => ({
  briefId: id,
  purpose: "product",
  aspectRatio: "1:1",
  prompt: "One cup",
  references: [],
});
const input: ThemeImageReviewInput = {
  purpose: "product",
  brief: { subject: "One cup", artDirection: "", aspectRatio: "1:1" },
  candidate: "candidate",
  anchor: "anchor",
  set: "set",
  attempt: 1,
};

describe("durable image recovery", () => {
  it("replays exact original bytes after interruption despite a different parallel slot order", async () => {
    const { store, records } = memory();
    let draws = 0;
    const client: ThemeStudioImageClient = {
      provider: "fake",
      generateImage: async () => ({
        kind: "ok",
        mediaType: "image/png",
        bytes: new Uint8Array([++draws]),
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
    };
    const first = resumableImageClient(client, "model", "v1", store);
    const a = await first.generateImage(request("a"), signal());
    const b = await first.generateImage(request("b"), signal());
    const resumed = resumableImageClient(client, "model", "v1", store);
    expect(await resumed.generateImage(request("b"), signal())).toEqual(b);
    expect(await resumed.generateImage(request("a"), signal())).toEqual(a);
    expect(draws).toBe(2);
    expect(imageCheckpointUsage([...records.values()]).totals).toEqual({
      inputTokens: 20,
      outputTokens: 40,
    });
  });

  it("distinguishes paid retakes and invalidates changed prompts, models, and exact reference bytes", async () => {
    const { store } = memory();
    const generateImage = vi.fn(async () => ({
      kind: "ok" as const,
      mediaType: "image/png" as const,
      bytes: new Uint8Array([1]),
      usage: ZERO_IMAGE_USAGE,
    }));
    const client: ThemeStudioImageClient = { provider: "fake", generateImage };
    const first = resumableImageClient(client, "model", "v1", store);
    await first.generateImage(request("a"), signal());
    await first.generateImage(request("a"), signal());
    const resumed = resumableImageClient(client, "model", "v1", store);
    await resumed.generateImage(request("a"), signal());
    await resumed.generateImage(request("a"), signal());
    expect(generateImage).toHaveBeenCalledTimes(2);
    await resumableImageClient(
      client,
      "other-model",
      "v1",
      store,
    ).generateImage(request("a"), signal());
    await resumableImageClient(client, "model", "v2", store).generateImage(
      request("a"),
      signal(),
    );
    await resumableImageClient(client, "model", "v1", store).generateImage(
      {
        ...request("a"),
        references: [
          { role: "set", mediaType: "image/png", base64: "different" },
        ],
      },
      signal(),
    );
    expect(generateImage).toHaveBeenCalledTimes(5);
  });

  it("commits a late completed draw and its spend even when cancellation arrives", async () => {
    const { store, records } = memory();
    const controller = new AbortController();
    const client: ThemeStudioImageClient = {
      provider: "fake",
      generateImage: async () => {
        controller.abort();
        return {
          kind: "ok",
          mediaType: "image/png",
          bytes: new Uint8Array([1]),
          usage: { inputTokens: 2, outputTokens: 3 },
        };
      },
    };
    await resumableImageClient(client, "model", "v1", store).generateImage(
      request("a"),
      controller.signal,
    );
    expect(records.size).toBe(1);
    expect(imageCheckpointUsage([...records.values()]).totals.inputTokens).toBe(
      2,
    );
    await expect(
      resumableImageClient(client, "model", "v1", store).generateImage(
        request("a"),
        controller.signal,
      ),
    ).rejects.toThrow();
  });

  it.each(["error", "refused"] as const)(
    "journals returned usage once for a %s response across reclaims",
    async (kind) => {
      const { store, records } = memory();
      const response =
        kind === "error"
          ? {
              kind,
              code: "provider_timeout" as const,
              usage: { inputTokens: 11, outputTokens: 7 },
            }
          : {
              kind,
              reason: "IMAGE_SAFETY",
              usage: { inputTokens: 11, outputTokens: 7 },
            };
      const generateImage = vi.fn(async () => response);
      const client: ThemeStudioImageClient = {
        provider: "fake",
        generateImage,
      };
      await resumableImageClient(client, "model", "v1", store).generateImage(
        request("a"),
        signal(),
      );
      await resumableImageClient(client, "model", "v1", store).generateImage(
        request("a"),
        signal(),
      );
      expect(generateImage).toHaveBeenCalledTimes(1);
      expect(imageCheckpointUsage([...records.values()]).totals).toEqual({
        inputTokens: 11,
        outputTokens: 7,
      });
    },
  );

  it("keeps identical parallel slot reviews separate for accurate paid usage", async () => {
    const { store, records } = memory();
    const generate = vi.fn(async () => ({
      kind: "ok" as const,
      value: { problems: [], note: "" },
      usage: { ...ZERO_USAGE, inputTokens: 5 },
    }));
    const reviewer = {
      client: { provider: "fake" as const, generate },
      providerModel: "model",
    };
    const review = resumableImageReview(store, 0);
    await Promise.all([
      review(reviewer, input, signal(), "a"),
      review(reviewer, input, signal(), "b"),
    ]);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(imageCheckpointUsage([...records.values()]).reviews).toHaveLength(2);
  });

  it("retries an unavailable review independently and counts each paid review once", async () => {
    const { store, records } = memory();
    const usage = { ...ZERO_USAGE, inputTokens: 5, outputTokens: 3 };
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ kind: "invalid_json", usage })
      .mockResolvedValue({
        kind: "ok",
        value: { problems: [], note: "" },
        usage,
      });
    const reviewer = {
      client: { provider: "fake" as const, generate },
      providerModel: "model",
    };
    const initial = resumableImageReview(store, 0);
    expect(await initial(reviewer, input, signal(), "cup")).toMatchObject({
      kind: "unavailable",
    });
    // A reclaim of this pass must not repeat a paid failed review.
    await initial(reviewer, input, signal(), "cup");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(
      await resumableImageReview(store, 1)(reviewer, input, signal(), "cup"),
    ).toMatchObject({ kind: "reviewed", problems: [] });
    await resumableImageReview(store, 2)(reviewer, input, signal(), "cup");
    expect(generate).toHaveBeenCalledTimes(2);
    expect(imageCheckpointUsage([...records.values()]).reviews).toHaveLength(2);
    expect(
      imageCheckpointUsage([...records.values()]).reviewCostMicroUsd,
    ).toBeGreaterThan(0);
  });

  it.each(["candidate", "anchor", "set"] as const)(
    "does not reuse evidence when %s bytes change",
    async (field) => {
      const { store } = memory();
      const generate = vi.fn(async () => ({
        kind: "ok" as const,
        value: { problems: [], note: "" },
        usage: ZERO_USAGE,
      }));
      const reviewer = {
        client: { provider: "fake" as const, generate },
        providerModel: "model",
      };
      const review = resumableImageReview(store, 0);
      await review(reviewer, input, signal(), "cup");
      await review(
        reviewer,
        { ...input, [field]: "other-bytes" },
        signal(),
        "cup",
      );
      expect(generate).toHaveBeenCalledTimes(2);
    },
  );

  it("bounds delayed review retries separately from worker crash attempts", () => {
    expect([0, 1, 2].map(imageReviewRecoveryDelayMs)).toEqual([
      60_000,
      120_000,
      null,
    ]);
  });
});
