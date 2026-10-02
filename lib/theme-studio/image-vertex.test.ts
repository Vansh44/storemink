import {
  HarmBlockThreshold,
  Modality,
  ProminentPeople,
  type GenerateContentResponse,
} from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { estimateImageCostMicroUsd } from "./cost";
import { createFakeImageClient, FAKE_IMAGE_LONG_EDGE } from "./image-fake";
import { getThemeStudioImageConfig } from "./image-models";
import {
  assertThemeImageRequest,
  type ThemeImageRequest,
} from "./image-provider";
import {
  createVertexImageClient,
  parseThemeImageResponse,
  themeImageConfig,
  themeImageParts,
} from "./image-vertex";

const REQUEST: ThemeImageRequest = {
  purpose: "product",
  briefId: "product-mug",
  aspectRatio: "4:5",
  prompt: "A stoneware mug.",
  references: [{ role: "anchor", mediaType: "image/webp", base64: "QUJD" }],
};

const CONFIG = {
  projectId: "p",
  location: "global",
  modelKey: "gemini-3-pro-image" as const,
  providerModel: "gemini-3-pro-image",
};

const IMAGE = Buffer.from("fake-jpeg").toString("base64");

function response(parts: object): GenerateContentResponse {
  return parts as unknown as GenerateContentResponse;
}
const okResponse = response({
  candidates: [
    {
      finishReason: "STOP",
      content: {
        parts: [
          { text: "Here is the image." },
          { inlineData: { mimeType: "image/jpeg", data: IMAGE } },
        ],
      },
    },
  ],
  usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 1690 },
});

function status(code: number) {
  return Object.assign(new Error(`HTTP ${code}`), { status: code });
}

const signal = () => new AbortController().signal;

describe("the image model registry", () => {
  it("is off without a project, and defaults to the Pro image model on the global endpoint", () => {
    expect(getThemeStudioImageConfig({})).toBeNull();
    expect(getThemeStudioImageConfig({ GCP_PROJECT_ID: "p" })).toEqual(CONFIG);
  });

  it("an override may pin a version of the same model and nothing else", () => {
    expect(
      getThemeStudioImageConfig({
        GCP_PROJECT_ID: "p",
        THEME_STUDIO_IMAGE_MODEL: "gemini-3-pro-image-001",
      })?.providerModel,
    ).toBe("gemini-3-pro-image-001");
    // The cheaper Flash image model is a different model, never a version.
    for (const other of ["gemini-3.1-flash-image", "gemini-3-pro-image-lite"]) {
      expect(() =>
        getThemeStudioImageConfig({
          GCP_PROJECT_ID: "p",
          THEME_STUDIO_IMAGE_MODEL: other,
        }),
      ).toThrow(/model family/);
    }
  });
});

describe("the fixed provider configuration", () => {
  it("pins every safety value to Mink's verified call", () => {
    const config = themeImageConfig(REQUEST);
    expect(config.responseModalities).toEqual([Modality.TEXT, Modality.IMAGE]);
    expect(config.candidateCount).toBe(1);
    expect(config.safetySettings).toHaveLength(4);
    for (const setting of config.safetySettings ?? []) {
      expect(setting.threshold).toBe(HarmBlockThreshold.BLOCK_LOW_AND_ABOVE);
    }
    expect(config.imageConfig).toEqual({
      aspectRatio: "4:5",
      imageSize: "2K",
      personGeneration: "ALLOW_NONE",
      prominentPeople: ProminentPeople.BLOCK_PROMINENT_PEOPLE,
      outputMimeType: "image/jpeg",
      outputCompressionQuality: 95,
    });
  });

  it("sends the prompt, then each reference after a label naming its role", () => {
    expect(themeImageParts(REQUEST)).toEqual([
      { text: "A stoneware mug." },
      { text: "ANCHOR:" },
      { inlineData: { mimeType: "image/webp", data: "QUJD" } },
    ]);
  });
});

describe("reading a response", () => {
  it("returns the first inline image and the usage", () => {
    const result = parseThemeImageResponse(okResponse);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(Buffer.from(result.bytes).toString()).toBe("fake-jpeg");
    expect(result.mediaType).toBe("image/jpeg");
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 1690 });
  });

  it("a blocked prompt or a named stop without an image is a refusal with its reason", () => {
    expect(
      parseThemeImageResponse(
        response({ promptFeedback: { blockReason: "SAFETY" } }),
      ),
    ).toMatchObject({ kind: "refused", reason: "SAFETY" });
    expect(
      parseThemeImageResponse(
        response({
          candidates: [
            { finishReason: "IMAGE_SAFETY", content: { parts: [] } },
          ],
        }),
      ),
    ).toMatchObject({ kind: "refused", reason: "IMAGE_SAFETY" });
  });

  it("no image and no reason is a failure, never an empty success", () => {
    expect(
      parseThemeImageResponse(
        response({
          candidates: [
            { finishReason: "STOP", content: { parts: [{ text: "hi" }] } },
          ],
        }),
      ),
    ).toMatchObject({ kind: "error", code: "provider_unavailable" });
  });

  it("refuses an image type the pipeline cannot open", () => {
    expect(
      parseThemeImageResponse(
        response({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [{ inlineData: { mimeType: "image/gif", data: IMAGE } }],
              },
            },
          ],
        }),
      ),
    ).toMatchObject({ kind: "error", code: "provider_rejected" });
  });
});

describe("the Vertex client", () => {
  it("waits out a rate limit, which bills nothing, then returns the image", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(status(429))
      .mockResolvedValueOnce(okResponse);
    const sleep = vi.fn(async () => true);
    const client = createVertexImageClient(CONFIG, {
      send,
      sleep,
      random: () => 0,
    });
    const result = await client.generateImage(REQUEST, signal());
    expect(result.kind).toBe("ok");
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7_500, expect.anything());
  });

  it("never retries a failure that may have billed", async () => {
    for (const code of [500, 503, 400]) {
      const send = vi.fn().mockRejectedValue(status(code));
      const client = createVertexImageClient(CONFIG, { send });
      const result = await client.generateImage(REQUEST, signal());
      expect(result.kind).toBe("error");
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
  it("coordinates provider cooldowns across themes instead of sending new slots into a 429 storm", async () => {
    const release: (() => void)[] = [];
    const retried = new Set<string>();
    const client = createVertexImageClient(
      { ...CONFIG, projectId: "cooldown-fairness" },
      {
        random: () => 0,
        send: async (request) => {
          if (request.briefId !== "healthy" && !retried.has(request.briefId)) {
            retried.add(request.briefId);
            throw status(429);
          }
          return okResponse;
        },
        sleep: () =>
          new Promise<boolean>((resolve) => release.push(() => resolve(true))),
      },
    );
    const waiting = [0, 1, 2].map((i) =>
      client.generateImage({ ...REQUEST, briefId: `waiting-${i}` }, signal()),
    );
    try {
      await vi.waitFor(() => expect(release).toHaveLength(3));
      let healthyDone = false;
      const healthy = client
        .generateImage({ ...REQUEST, briefId: "healthy" }, signal())
        .then((result) => {
          healthyDone = result.kind === "ok";
          return result;
        });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(healthyDone).toBe(false);
      release.forEach((resolve) => resolve());
      await vi.waitFor(() => expect(healthyDone).toBe(true));
      await healthy;
    } finally {
      release.forEach((resolve) => resolve());
      await Promise.all(waiting);
    }
  });

  it("reports a cancelled run as cancelled", async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => {
      controller.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const client = createVertexImageClient(CONFIG, { send });
    expect(
      await client.generateImage(REQUEST, controller.signal),
    ).toMatchObject({ kind: "error", code: "cancelled" });
  });

  it("refuses to send a request the provider must never see", async () => {
    const send = vi.fn();
    const client = createVertexImageClient(CONFIG, { send });
    await expect(
      client.generateImage({ ...REQUEST, purpose: "anchor" }, signal()),
    ).rejects.toThrow(/no references/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the request guard", () => {
  it("refuses unknown purposes and ratios, empty prompts and too many references", () => {
    const bad: Partial<ThemeImageRequest>[] = [
      { purpose: "preview" as never },
      { aspectRatio: "16:10" as never },
      { prompt: "  " },
      {
        references: Array.from({ length: 4 }, () => REQUEST.references[0]),
      },
    ];
    for (const change of bad) {
      expect(() =>
        assertThemeImageRequest({ ...REQUEST, ...change }),
      ).toThrow();
    }
  });
});

describe("the fake image client", () => {
  it("returns the same PNG for the same request, at the requested ratio", async () => {
    const client = createFakeImageClient();
    const a = await client.generateImage(REQUEST, signal());
    const b = await client.generateImage(REQUEST, signal());
    const c = await client.generateImage(
      { ...REQUEST, briefId: "other" },
      signal(),
    );
    expect(a.kind).toBe("ok");
    if (a.kind !== "ok" || b.kind !== "ok" || c.kind !== "ok") return;
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(Buffer.from(a.bytes).equals(Buffer.from(c.bytes))).toBe(false);
    const sharp = (await import("sharp")).default;
    const meta = await sharp(Buffer.from(a.bytes)).metadata();
    expect(meta.format).toBe("png");
    expect(meta.height).toBe(FAKE_IMAGE_LONG_EDGE);
    expect(meta.width).toBe(Math.round((FAKE_IMAGE_LONG_EDGE * 4) / 5));
  });

  it("can be told to refuse or fail", async () => {
    const client = createFakeImageClient();
    expect(
      await client.generateImage(
        { ...REQUEST, prompt: "x [[fake-image:refuse]]" },
        signal(),
      ),
    ).toMatchObject({ kind: "refused" });
    expect(
      await client.generateImage(
        { ...REQUEST, prompt: "x [[fake-image:error]]" },
        signal(),
      ),
    ).toMatchObject({ kind: "error", code: "provider_unavailable" });
  });
});

describe("image cost", () => {
  it("a 2K Pro image is about 13.5 cents at the list price", () => {
    expect(
      estimateImageCostMicroUsd({ inputTokens: 0, outputTokens: 1120 }),
    ).toBe(134_400);
    expect(
      estimateImageCostMicroUsd({ inputTokens: 1_000, outputTokens: 1_120 }),
    ).toBe(136_400);
    expect(
      estimateImageCostMicroUsd({ inputTokens: -5, outputTokens: 0 }),
    ).toBe(0);
  });
});

it("enforces the image attempt deadline even when the SDK ignores abort", async () => {
  const deadline = new AbortController();
  const timer = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  try {
    const send = vi.fn(() => new Promise<never>(() => {}));
    const client = createVertexImageClient(CONFIG, { send });
    const pending = client.generateImage(REQUEST, signal());
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    deadline.abort(new Error("deadline"));
    await expect(pending).resolves.toMatchObject({
      kind: "error",
      code: "provider_timeout",
    });
    expect(send).toHaveBeenCalledOnce();
  } finally {
    timer.mockRestore();
  }
});
