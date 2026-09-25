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

    state.next = () => Promise.reject(withStatus(429));
    const client = createVertexModelClient({
      projectId: "p",
      region: "global",
    });
    expect(await client.generate(request, signal())).toMatchObject({
      kind: "error",
      code: "rate_limited",
    });
  });
});
