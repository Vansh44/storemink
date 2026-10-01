import { describe, expect, it, vi } from "vitest";
import {
  generationRecoveryDelayMs,
  resumableGenerationClient,
  type SavedModelResponse,
} from "./generation-recovery";
import { ZERO_USAGE, type StructuredRequest } from "./provider";

const request: StructuredRequest = {
  stage: "intent",
  modelKey: "gemini-3.8-flash",
  providerModel: "gemini-3.8-flash",
  system: "system",
  content: [{ type: "text", text: "brief" }],
  schema: {},
  effort: "high",
};
const response: SavedModelResponse = {
  kind: "ok",
  value: { design: "saved" },
  usage: { ...ZERO_USAGE, inputTokens: 120, outputTokens: 50 },
};
function memoryStore() {
  const saved = new Map<string, SavedModelResponse>();
  return {
    saved,
    async read(key: string) {
      return structuredClone(saved.get(key) ?? null);
    },
    async write(key: string, value: SavedModelResponse) {
      saved.set(key, structuredClone(value));
    },
  };
}
const signal = () => new AbortController().signal;

describe("durable generation recovery", () => {
  it("bounds delayed retries separately from the worker's crash budget", () => {
    expect(
      [0, 1, 2, 3].map((n) => generationRecoveryDelayMs(n, () => 1)),
    ).toEqual([300_000, 600_000, 1_200_000, 1_200_000]);
    expect(generationRecoveryDelayMs(0, () => 0)).toBe(225_000);
    expect(generationRecoveryDelayMs(4)).toBeNull();
    expect(generationRecoveryDelayMs(5)).toBeNull();
  });

  it("replays the same request and usage after a worker restart", async () => {
    const generate = vi.fn(async () => structuredClone(response));
    const provider = { provider: "vertex-gemini" as const, generate };
    const store = memoryStore();
    await resumableGenerationClient(provider, store).generate(
      request,
      signal(),
    );
    expect(
      await resumableGenerationClient(provider, store).generate(
        request,
        signal(),
      ),
    ).toEqual(response);
    expect(generate).toHaveBeenCalledOnce();
    expect([...store.saved.keys()][0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not reuse a response for changed inputs or a different model", async () => {
    const generate = vi.fn(async () => response);
    const provider = { provider: "vertex-gemini" as const, generate };
    const store = memoryStore();
    for (const next of [
      request,
      { ...request, system: "new" },
      { ...request, providerModel: "dated-model" },
    ]) {
      await resumableGenerationClient(provider, store).generate(next, signal());
    }
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it("keeps identical repair calls distinct and replays each by its ordinal", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ kind: "invalid_json", usage: ZERO_USAGE })
      .mockResolvedValueOnce(response);
    const provider = { provider: "vertex-gemini" as const, generate };
    const store = memoryStore();
    const first = resumableGenerationClient(provider, store);
    expect((await first.generate(request, signal())).kind).toBe("invalid_json");
    expect((await first.generate(request, signal())).kind).toBe("ok");
    const resumed = resumableGenerationClient(provider, store);
    expect((await resumed.generate(request, signal())).kind).toBe(
      "invalid_json",
    );
    expect((await resumed.generate(request, signal())).kind).toBe("ok");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("never saves a provider error, so the refused call is retried", async () => {
    const generate = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "error",
        code: "rate_limited",
        usage: ZERO_USAGE,
      })
      .mockResolvedValueOnce(response);
    const provider = { provider: "vertex-gemini" as const, generate };
    const store = memoryStore();
    await resumableGenerationClient(provider, store).generate(
      request,
      signal(),
    );
    expect(store.saved.size).toBe(0);
    expect(
      await resumableGenerationClient(provider, store).generate(
        request,
        signal(),
      ),
    ).toEqual(response);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("honors cancellation even while reading an existing response", async () => {
    const controller = new AbortController();
    const generate = vi.fn();
    const client = resumableGenerationClient(
      { provider: "vertex-gemini", generate },
      {
        async read() {
          controller.abort();
          return response;
        },
        write: vi.fn(),
      },
    );
    await expect(client.generate(request, controller.signal)).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });

  it("stops before another paid call if a checkpoint cannot be saved", async () => {
    const generate = vi.fn(async () => response);
    const client = resumableGenerationClient(
      { provider: "vertex-gemini", generate },
      {
        async read() {
          return null;
        },
        async write() {
          throw new Error("lost lease");
        },
      },
    );
    await expect(client.generate(request, signal())).rejects.toThrow(
      "lost lease",
    );
    expect(generate).toHaveBeenCalledOnce();
  });
});
