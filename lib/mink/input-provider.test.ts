import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ count: vi.fn(), generate: vi.fn() }));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { countTokens: h.count, generateContent: h.generate };
  },
}));
import { extractMinkInput } from "./input-provider";
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
  it("does not retry provider failures", async () => {
    h.generate.mockRejectedValue(new Error("provider failed"));
    await expect(run()).rejects.toThrow();
    expect(h.generate).toHaveBeenCalledTimes(1);
  });
});
