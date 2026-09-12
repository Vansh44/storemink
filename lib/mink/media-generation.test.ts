import { beforeEach, describe, expect, it, vi } from "vitest";
import { MINK_MEDIA_NEGATIVE_PROMPT } from "./media-generation-contract";

const generateImages = vi.fn();
const constructed: Record<string, unknown>[] = [];

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateImages };
    constructor(options: Record<string, unknown>) {
      constructed.push(options);
    }
  },
  PersonGeneration: { DONT_ALLOW: "DONT_ALLOW", ALLOW_ADULT: "ALLOW_ADULT" },
  SafetyFilterLevel: {
    BLOCK_LOW_AND_ABOVE: "BLOCK_LOW_AND_ABOVE",
    BLOCK_MEDIUM_AND_ABOVE: "BLOCK_MEDIUM_AND_ABOVE",
  },
}));
vi.mock("@/lib/db/client", () => ({ withService: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

const { generateMinkMediaImage } = await import("./media-generation");
const { MinkRequestError, MinkToolInputError } = await import("./errors");

const config = {
  projectId: "project-1" as string | null,
  imageModel: "imagen-4.0-generate-001",
  imageLocation: "us-central1",
};

const request = {
  schemaVersion: 1 as const,
  purpose: "hero" as const,
  prompt: "A warm overhead still life of loose grains on linen.",
  alt: "Grains and pulses on linen",
};

const PIXEL = Buffer.from("hello").toString("base64");

beforeEach(() => {
  generateImages.mockReset();
});

describe("asking Imagen for one storefront image", () => {
  it("★★ FIXES EVERY SAFETY LEVER IN CODE, NOT IN THE REQUEST", () => {
    // These are properties of the FEATURE, not of one call. If they could be
    // passed in, a merchant reviewing one image would not be reviewing the
    // same guarantees as on every other — and `personGeneration` in particular
    // has a tempting middle setting (ALLOW_ADULT) that is precisely the one
    // that invents a face nobody released.
    generateImages.mockResolvedValue({
      generatedImages: [
        { image: { imageBytes: PIXEL, mimeType: "image/jpeg" } },
      ],
    });
    return generateMinkMediaImage(config as never, request).then(() => {
      const sent = generateImages.mock.calls[0][0].config;
      expect(sent.personGeneration).toBe("DONT_ALLOW");
      expect(sent.safetyFilterLevel).toBe("BLOCK_LOW_AND_ABOVE");
      expect(sent.addWatermark).toBe(true);
      expect(sent.includeRaiReason).toBe(true);
      expect(sent.negativePrompt).toBe(MINK_MEDIA_NEGATIVE_PROMPT);
      expect(sent.numberOfImages).toBe(1);
      // ★ The aspect comes from the purpose. A model choosing 9:16 for a hero
      //   produces an image the renderer crops through its subject.
      expect(sent.aspectRatio).toBe("16:9");
    });
  });

  it("decodes the image the provider returned", async () => {
    generateImages.mockResolvedValue({
      generatedImages: [
        { image: { imageBytes: PIXEL, mimeType: "image/png" } },
      ],
    });
    const image = await generateMinkMediaImage(config as never, request);
    expect(image.bytes.toString()).toBe("hello");
    expect(image.mimeType).toBe("image/png");
  });

  it("★★ HANDS BACK THE PROVIDER'S OWN REFUSAL REASON", async () => {
    // A filtered image is a refusal WITH a reason, and the reason is the only
    // thing that lets a merchant rephrase rather than guess. Reporting it as a
    // generic failure spends their credit and tells them nothing.
    generateImages.mockResolvedValue({
      generatedImages: [{ raiFilteredReason: "58061214: prominent people" }],
    });
    await expect(
      generateMinkMediaImage(config as never, request),
    ).rejects.toThrow(/58061214: prominent people/);
    await expect(
      generateMinkMediaImage(config as never, request),
    ).rejects.toBeInstanceOf(MinkToolInputError);
  });

  it("★ SAYS SOMETHING DIFFERENT WHEN THERE IS NO REASON AT ALL", async () => {
    // An empty response with no reason is a different fact from a refusal, and
    // inventing a reason would send the merchant rewriting a prompt that was
    // never the problem.
    generateImages.mockResolvedValue({ generatedImages: [] });
    await expect(
      generateMinkMediaImage(config as never, request),
    ).rejects.toThrow(/returned no image/);
  });

  it("★★ A PROVIDER FAILURE IS NEVER REPORTED AS A MERCHANT MISTAKE", async () => {
    // The commonest cause is Imagen not being enabled on the project, which is
    // an operator problem. Surfacing it as a refused prompt has merchants
    // rewriting descriptions against an outage.
    generateImages.mockRejectedValue(new Error("404 model not found"));
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
    expect(generateImages).not.toHaveBeenCalled();
  });

  it("★★ ASKS THE SDK FOR EXACTLY ONE ATTEMPT, AT THE IMAGE REGION", async () => {
    // A retry is a second charge for the same request, and the caller has
    // already been billed a credit for this proposal.
    // ⚠ The location is the IMAGE one, never the chat model's: that is
    //   `global` by default, where Imagen is not served, and the resulting 404
    //   reads like an outage rather than a missing region.
    constructed.length = 0;
    generateImages.mockResolvedValue({
      generatedImages: [{ image: { imageBytes: PIXEL } }],
    });
    const image = await generateMinkMediaImage(config as never, request);
    expect(image.mimeType).toBe("image/jpeg");
    expect(constructed[0]).toMatchObject({
      location: "us-central1",
      httpOptions: { retryOptions: { attempts: 1 } },
    });
  });
});
