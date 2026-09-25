import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  requests: [] as Record<string, unknown>[],
  constructed: [] as Record<string, unknown>[],
  next: null as null | (() => Promise<unknown>),
}));

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  return {
    ...actual,
    GoogleGenAI: class {
      models = {
        generateContent: (params: Record<string, unknown>) => {
          state.requests.push(params);
          return state.next ? state.next() : Promise.reject(new Error("unset"));
        },
      };
      constructor(opts: Record<string, unknown>) {
        state.constructed.push(opts);
      }
    },
  };
});

import {
  classifyProviderError,
  createVertexModelClient,
  getVertexConfig,
} from "./gemini-vertex";
import type { StructuredRequest } from "./provider";
import {
  RATE_LIMIT_BACKOFF,
  rateLimitDelayMs,
  sleepUnlessAborted,
} from "./rate-limit-backoff";

const request: StructuredRequest = {
  stage: "intent",
  modelKey: "gemini-3.1-pro",
  providerModel: "gemini-3.1-pro-preview",
  system: "system text",
  content: [
    { type: "text", text: "brief" },
    { type: "image", mediaType: "image/webp", base64: "AAAA" },
  ],
  schema: {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {},
  },
  maxTokens: 16000,
  effort: "high",
};

function response(overrides: Record<string, unknown> = {}) {
  return {
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text: '{"decision":"proceed"}' }] },
      },
    ],
    usageMetadata: {
      promptTokenCount: 1200,
      cachedContentTokenCount: 800,
      candidatesTokenCount: 40,
      thoughtsTokenCount: 300,
    },
    ...overrides,
  };
}

const signal = () => new AbortController().signal;

beforeEach(() => {
  state.requests = [];
  state.constructed = [];
  state.next = null;
});

describe("Gemini on Vertex client", () => {
  it("reads config only from server environment", () => {
    expect(getVertexConfig({})).toBeNull();
    expect(getVertexConfig({ GCP_PROJECT_ID: "p" })).toEqual({
      projectId: "p",
      region: "global",
    });
    expect(
      getVertexConfig({
        GCP_PROJECT_ID: "p",
        THEME_STUDIO_GCP_PROJECT_ID: "studio",
        THEME_STUDIO_VERTEX_LOCATION: "us-central1",
      }),
    ).toEqual({ projectId: "studio", region: "us-central1" });
  });

  it("sends a tool-free structured request with images and high thinking", async () => {
    state.next = () => Promise.resolve(response());
    const client = createVertexModelClient({
      projectId: "p",
      region: "global",
    });
    const result = await client.generate(request, signal());
    expect(result).toMatchObject({
      kind: "ok",
      value: { decision: "proceed" },
    });
    expect(state.constructed[0]).toMatchObject({
      enterprise: true,
      project: "p",
      location: "global",
    });
    const sent = state.requests[0] as {
      model: string;
      contents: { parts: unknown[] }[];
      config: Record<string, unknown>;
    };
    expect(sent.model).toBe("gemini-3.1-pro-preview");
    expect(sent.contents[0].parts).toEqual([
      { text: "brief" },
      { inlineData: { mimeType: "image/webp", data: "AAAA" } },
    ]);
    expect(sent.config).toMatchObject({
      systemInstruction: "system text",
      maxOutputTokens: 16000,
      responseMimeType: "application/json",
      responseJsonSchema: request.schema,
      thinkingConfig: { thinkingLevel: "HIGH" },
    });
    expect(sent.config).not.toHaveProperty("tools");
  });

  it("reports cached tokens as a subset and thinking separately", async () => {
    state.next = () => Promise.resolve(response());
    const client = createVertexModelClient({
      projectId: "p",
      region: "global",
    });
    const result = await client.generate(request, signal());
    expect(result.usage).toEqual({
      inputTokens: 1200,
      cachedTokens: 800,
      outputTokens: 40,
      thinkingTokens: 300,
    });
    state.next = () =>
      Promise.resolve(
        response({
          usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 99 },
        }),
      );
    expect((await client.generate(request, signal())).usage.cachedTokens).toBe(
      10,
    );
  });

  it("ignores thought parts when reading the answer", async () => {
    state.next = () =>
      Promise.resolve(
        response({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  { text: "thinking about it", thought: true },
                  { text: '{"a":1}' },
                ],
              },
            },
          ],
        }),
      );
    const client = createVertexModelClient({
      projectId: "p",
      region: "global",
    });
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "ok",
      value: { a: 1 },
    });
  });

  it("maps safety blocks, truncation, bad JSON and unexplained stops", async () => {
    const client = createVertexModelClient({
      projectId: "p",
      region: "global",
    });
    state.next = () =>
      Promise.resolve(
        response({
          candidates: [],
          promptFeedback: { blockReason: "PROHIBITED_CONTENT" },
        }),
      );
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "refused",
      category: "PROHIBITED_CONTENT",
    });
    state.next = () =>
      Promise.resolve(
        response({
          candidates: [
            {
              finishReason: "SAFETY",
              safetyRatings: [
                { category: "HARM_CATEGORY_HARASSMENT", blocked: true },
              ],
            },
          ],
        }),
      );
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "refused",
      category: "HARM_CATEGORY_HARASSMENT",
    });
    state.next = () =>
      Promise.resolve(
        response({ candidates: [{ finishReason: "MAX_TOKENS" }] }),
      );
    expect((await client.generate(request, signal())).kind).toBe("truncated");
    state.next = () =>
      Promise.resolve(
        response({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: "not json" }] },
            },
          ],
        }),
      );
    expect((await client.generate(request, signal())).kind).toBe(
      "invalid_json",
    );
    state.next = () =>
      Promise.resolve(response({ candidates: [{ finishReason: "OTHER" }] }));
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "error",
      code: "provider_unavailable",
    });
  });

  it("classifies provider errors into the closed vocabulary", async () => {
    const withStatus = (s: number) =>
      Object.assign(new Error("x"), { status: s });
    expect(classifyProviderError(withStatus(429))).toBe("rate_limited");
    expect(classifyProviderError(withStatus(403))).toBe("provider_auth");
    expect(classifyProviderError(new Error("invalid_grant: reauth"))).toBe(
      "provider_auth",
    );
    expect(classifyProviderError(withStatus(404))).toBe("provider_rejected");
    expect(classifyProviderError(withStatus(504))).toBe("provider_timeout");
    expect(classifyProviderError(withStatus(503))).toBe("provider_unavailable");
    const aborted = new AbortController();
    aborted.abort();
    expect(classifyProviderError(withStatus(503), aborted.signal)).toBe(
      "cancelled",
    );

    state.next = () => Promise.reject(withStatus(403));
    const client = createVertexModelClient({
      projectId: "p",
      region: "global",
    });
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "error",
      code: "provider_auth",
    });
  });
});

describe("waiting out a rate limit", () => {
  const rateLimited = () =>
    Promise.reject(
      Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429 }),
    );

  const sleeper = (result: boolean) =>
    vi.fn(async (ms: number, abort?: AbortSignal) => {
      void ms;
      void abort;
      return result;
    });

  function clientWith(sleep = sleeper(true)) {
    return {
      sleep,
      client: createVertexModelClient(
        { projectId: "p", region: "global" },
        { sleep, random: () => 1 },
      ),
    };
  }

  it("hands 429 to its own backoff, not the SDK's fast retry", () => {
    clientWith();
    const retry = (
      state.constructed[0] as {
        httpOptions: { retryOptions: { httpStatusCodes: number[] } };
      }
    ).httpOptions.retryOptions;
    expect(retry.httpStatusCodes).not.toContain(429);
    expect(retry.httpStatusCodes).toEqual(
      expect.arrayContaining([500, 503, 504]),
    );
  });

  it("waits and tries again, and a later success is an ordinary answer", async () => {
    let calls = 0;
    state.next = () =>
      ++calls < 3 ? rateLimited() : Promise.resolve(response());
    const { client, sleep } = clientWith();
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "ok",
      value: { decision: "proceed" },
    });
    expect(state.requests).toHaveLength(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([15_000, 30_000]);
  });

  it("gives up after five retries and says it was rate limited", async () => {
    state.next = rateLimited;
    const { client, sleep } = clientWith();
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "error",
      code: "rate_limited",
    });
    expect(state.requests).toHaveLength(6);
    const waits = sleep.mock.calls.map((c) => c[0]);
    expect(waits).toEqual([15_000, 30_000, 60_000, 120_000, 120_000]);
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
      RATE_LIMIT_BACKOFF.totalMs,
    );
  });

  it("counts retries, not just waiting time, so short jittered waits still stop", async () => {
    state.next = rateLimited;
    const sleep = sleeper(true);
    const client = createVertexModelClient(
      { projectId: "p", region: "global" },
      { sleep, random: () => 0 },
    );
    await client.generate(request, signal());
    // Half-length waits total 172.5s, well inside the time budget, so only
    // the retry count can be what stopped it.
    expect(state.requests).toHaveLength(6);
  });

  it("stops at once when the run is aborted mid-wait", async () => {
    state.next = rateLimited;
    const { client } = clientWith(sleeper(false));
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "error",
      code: "cancelled",
    });
    expect(state.requests).toHaveLength(1);
  });

  it("never waits on anything but a rate limit", async () => {
    state.next = () =>
      Promise.reject(Object.assign(new Error("x"), { status: 503 }));
    const { client, sleep } = clientWith();
    expect(await client.generate(request, signal())).toMatchObject({
      code: "provider_unavailable",
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(state.requests).toHaveLength(1);
  });
});

describe("rateLimitDelayMs", () => {
  it("doubles from 15s, caps at two minutes, and jitters down to half", () => {
    expect([0, 1, 2, 3, 4, 9].map((n) => rateLimitDelayMs(n, () => 1))).toEqual(
      [15_000, 30_000, 60_000, 120_000, 120_000, 120_000],
    );
    expect(rateLimitDelayMs(0, () => 0)).toBe(7_500);
    expect(rateLimitDelayMs(3, () => 0)).toBe(60_000);
  });
});

describe("sleepUnlessAborted", () => {
  it("resolves false as soon as the run is aborted", async () => {
    const controller = new AbortController();
    const waiting = sleepUnlessAborted(60_000, controller.signal);
    controller.abort();
    expect(await waiting).toBe(false);
    expect(await sleepUnlessAborted(1, controller.signal)).toBe(false);
    expect(await sleepUnlessAborted(1)).toBe(true);
  });
});
