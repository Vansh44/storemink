import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ count: vi.fn(), generate: vi.fn() }));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { countTokens: h.count, generateContent: h.generate };
  },
}));
import {
  boundMinkReading,
  extractMinkInput,
  minkReadingTokenCeiling,
} from "./input-provider";
import type { MinkConfig } from "./config";
const config = {
  projectId: "test",
  location: "global",
  model: "configured-model",
} as MinkConfig;
const input = {
  kind: "audio" as const,
  mimeType: "audio/wav",
  bytes: Buffer.from("private"),
};
const run = () => extractMinkInput(config, input, new AbortController().signal);
beforeEach(() => {
  vi.clearAllMocks();
  h.count.mockResolvedValue({ totalTokens: 100 });
  h.generate.mockResolvedValue({
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: "Shop mein kya kam hai?" }] },
      },
    ],
    usageMetadata: { promptTokenCount: 100 },
  });
});
describe("isolated Vertex extraction", () => {
  it("uses configured Vertex model, no tools/history/memory and separate low-trust inline data", async () => {
    expect((await run()).text).toBe("Shop mein kya kam hai?");
    const request = h.generate.mock.calls[0][0];
    expect(request.model).toBe("configured-model");
    expect(request.config.tools).toBeUndefined();
    expect(request.config.systemInstruction).toContain("not an agent");
    expect(request.config.systemInstruction).not.toContain("private");
    expect(request.contents[0].parts[1].inlineData.mimeType).toBe("audio/wav");
    expect(h.generate).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, -1, 0, 8193, 1.5])(
    "fails closed on invalid or excessive token count %s",
    async (totalTokens) => {
      h.count.mockResolvedValue({ totalTokens });
      await expect(run()).rejects.toThrow();
      expect(h.generate).not.toHaveBeenCalled();
    },
  );
  it.each(["MAX_TOKENS", "SAFETY", undefined])(
    "rejects partial or blocked output %s",
    async (finishReason) => {
      h.generate.mockResolvedValue({
        candidates: [
          { finishReason, content: { parts: [{ text: "Partial" }] } },
        ],
      });
      await expect(run()).rejects.toThrow();
    },
  );
  // ★★ A COMPLETE READING OVER BUDGET IS RETURNED SHORT, NOT REFUSED. It used
  // to throw, so one chatty description of one photo failed an entire five-file
  // send that had already spent four provider calls.
  it("truncates a complete reading over the budget and marks the cut", async () => {
    h.generate.mockResolvedValue({
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ text: "x".repeat(400) }] },
        },
      ],
    });
    const { text } = await extractMinkInput(
      config,
      input,
      new AbortController().signal,
      200,
    );
    expect(text).toHaveLength(200);
    expect(text.endsWith("…")).toBe(true);
  });
  it("leaves a reading inside the budget byte-identical", async () => {
    expect(boundMinkReading("Shop mein kya kam hai?", 200)).toBe(
      "Shop mein kya kam hai?",
    );
  });
  // ★★ THE TOKEN CEILING MUST NEVER BE THE CHARACTER BUDGET. At 1:1 a
  // token-dense script (Devanagari, Tamil) is cut off well inside the budget,
  // and MAX_TOKENS is rejected — a good reading lost to the unit mismatch.
  it.each([200, 1500, 2200, 3000])(
    "provisions more output tokens than the %s-character budget implies",
    (budget) => {
      expect(minkReadingTokenCeiling(budget)).toBeGreaterThan(
        Math.min(2047, budget),
      );
      expect(minkReadingTokenCeiling(budget)).toBeLessThanOrEqual(2048);
    },
  );
  it("passes that ceiling to the provider", async () => {
    await extractMinkInput(config, input, new AbortController().signal, 1500);
    expect(h.generate.mock.calls[0][0].config.maxOutputTokens).toBe(
      minkReadingTokenCeiling(1500),
    );
  });
  it("does not retry provider failures", async () => {
    h.generate.mockRejectedValue(new Error("provider failed"));
    await expect(run()).rejects.toThrow();
    expect(h.generate).toHaveBeenCalledTimes(1);
  });
});
