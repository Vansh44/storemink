import { beforeEach, describe, expect, it, vi } from "vitest";

const generateContent = vi.fn();
const constructed: Record<string, unknown>[] = [];

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
    constructor(options: Record<string, unknown>) {
      constructed.push(options);
    }
  },
  HarmBlockThreshold: {
    BLOCK_LOW_AND_ABOVE: "BLOCK_LOW_AND_ABOVE",
  },
  HarmCategory: {
    HARM_CATEGORY_HARASSMENT: "HARM_CATEGORY_HARASSMENT",
    HARM_CATEGORY_HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH",
    HARM_CATEGORY_SEXUALLY_EXPLICIT: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
    HARM_CATEGORY_DANGEROUS_CONTENT: "HARM_CATEGORY_DANGEROUS_CONTENT",
  },
  Modality: { TEXT: "TEXT", IMAGE: "IMAGE" },
  ProminentPeople: { BLOCK_PROMINENT_PEOPLE: "BLOCK_PROMINENT_PEOPLE" },
}));
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

const { generateMinkMediaImage } = await import("./media-generation");
const { MinkRequestError, MinkToolInputError } = await import("./errors");

const config = {
  projectId: "project-1" as string | null,
  imageModel: "gemini-3.1-flash-image",
  imageLocation: "global",
};

const request = {
  schemaVersion: 2 as const,
  purpose: "hero" as const,
  prompt: "A warm overhead still life of loose grains on linen.",
  referenceImageUrls: [],
  alt: "Grains and pulses on linen",
};

const PRODUCT_REFERENCE = {
  url: "https://storage.googleapis.com/bucket/products/milk.webp",
  fileUri: "gs://bucket/products/milk.webp",
  mimeType: "image/webp" as const,
  source: "product" as const,
};

const PIXEL = Buffer.from("hello").toString("base64");

beforeEach(() => {
  generateContent.mockReset();
});

function imageResponse(
  mimeType = "image/jpeg",
  data: string | undefined = PIXEL,
) {
  return {
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ inlineData: { data, mimeType } }] },
      },
    ],
  };
}

describe("asking Gemini for one storefront image", () => {
  it("★★ FIXES EVERY SAFETY LEVER IN CODE, NOT IN THE REQUEST", () => {
    // These are properties of the FEATURE, not of one call. If they could be
    // passed in, a merchant reviewing one image would not be reviewing the
    // same guarantees as on every other — and `personGeneration` in particular
    // has a tempting middle setting (ALLOW_ADULT) that is precisely the one
    // that invents a face nobody released.
    generateContent.mockResolvedValue(imageResponse());
    return generateMinkMediaImage(config as never, request).then(() => {
      const call = generateContent.mock.calls[0][0];
      const sent = call.config;
      expect(sent.responseModalities).toEqual(["TEXT", "IMAGE"]);
      expect(sent.candidateCount).toBe(1);
      expect(sent.imageConfig.personGeneration).toBe("ALLOW_NONE");
      expect(sent.imageConfig.prominentPeople).toBe("BLOCK_PROMINENT_PEOPLE");
      expect(sent.safetySettings).toHaveLength(4);
      expect(
        sent.safetySettings.every(
          (setting: { threshold: string }) =>
            setting.threshold === "BLOCK_LOW_AND_ABOVE",
        ),
      ).toBe(true);
      const instruction = call.contents[0].parts[0].text;
      expect(instruction).toContain(request.prompt);
      for (const exclusion of ["headlines", "watermarks", "people"]) {
        expect(instruction).toContain(exclusion);
      }
      // ★ The aspect comes from the purpose. A model choosing 9:16 for a hero
      //   produces an image the renderer crops through its subject.
      expect(sent.imageConfig.aspectRatio).toBe("21:9");
      expect(sent.imageConfig.imageSize).toBe("2K");
      expect(sent.imageConfig.outputCompressionQuality).toBe(95);
      expect(instruction).toContain("ultra-wide campaign scene");
      expect(instruction).toContain("not a product cutout pasted");
      expect(instruction).toContain("commercial quality");
    });
  });

  it("sends verified product images as model-visible references", async () => {
    generateContent.mockResolvedValue(imageResponse());
    await generateMinkMediaImage(
      config as never,
      { ...request, referenceImageUrls: [PRODUCT_REFERENCE.url] },
      [PRODUCT_REFERENCE],
    );

    const parts = generateContent.mock.calls[0][0].contents[0].parts;
    expect(parts[0].text).toContain("authentic current-store product image");
    expect(parts).toContainEqual({
      fileData: {
        fileUri: PRODUCT_REFERENCE.fileUri,
        mimeType: PRODUCT_REFERENCE.mimeType,
      },
    });
  });

  it("decodes the image the provider returned", async () => {
    generateContent.mockResolvedValue(imageResponse("image/png"));
    const image = await generateMinkMediaImage(config as never, request);
    expect(image.bytes.toString()).toBe("hello");
    expect(image.mimeType).toBe("image/png");
  });

  it("★★ HANDS BACK THE PROVIDER'S OWN REFUSAL REASON", async () => {
    // A filtered image is a refusal WITH a reason, and the reason is the only
    // thing that lets a merchant rephrase rather than guess. Reporting it as a
    // generic failure spends their credit and tells them nothing.
    generateContent.mockResolvedValue({
      promptFeedback: {
        blockReasonMessage: "The prompt requested prominent people",
      },
    });
    await expect(
      generateMinkMediaImage(config as never, request),
    ).rejects.toThrow(/requested prominent people/);
    await expect(
      generateMinkMediaImage(config as never, request),
    ).rejects.toBeInstanceOf(MinkToolInputError);
  });

  it("★ SAYS SOMETHING DIFFERENT WHEN THERE IS NO REASON AT ALL", async () => {
    // An empty response with no reason is a different fact from a refusal, and
    // inventing a reason would send the merchant rewriting a prompt that was
    // never the problem.
    generateContent.mockResolvedValue({ candidates: [] });
    await expect(
      generateMinkMediaImage(config as never, request),
    ).rejects.toThrow(/returned no image/);
  });

  it("★★ A PROVIDER FAILURE IS NEVER REPORTED AS A MERCHANT MISTAKE", async () => {
    // The commonest cause is the image model not being enabled on the project, which is
    // an operator problem. Surfacing it as a refused prompt has merchants
    // rewriting descriptions against an outage.
    generateContent.mockRejectedValue(new Error("404 model not found"));
    const error = await generateMinkMediaImage(config as never, request).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(MinkRequestError);
    expect(error.status).toBe(503);
    // ⚠ The provider's own words name models, regions and quotas. They belong
    //   in the log, never in a merchant-facing message.
    expect(error.message).not.toContain("404");
  });

  it("refuses before calling the provider when no project is configured", async () => {
    await expect(
      generateMinkMediaImage({ ...config, projectId: null } as never, request),
    ).rejects.toThrow(/GCP_PROJECT_ID/);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("★★ ASKS THE SDK FOR EXACTLY ONE ATTEMPT, AT THE IMAGE REGION", async () => {
    // A retry is a second charge for the same request, and the caller has
    // already been billed a credit for this proposal.
    // ⚠ The image location remains independently configurable even though its
    // current default is the same global endpoint as chat.
    constructed.length = 0;
    generateContent.mockResolvedValue(imageResponse(undefined));
    const image = await generateMinkMediaImage(config as never, request);
    expect(image.mimeType).toBe("image/jpeg");
    expect(constructed[0]).toMatchObject({
      location: "global",
      httpOptions: { retryOptions: { attempts: 1 } },
    });
  });
});
