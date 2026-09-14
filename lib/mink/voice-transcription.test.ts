import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ token: vi.fn(), getClient: vi.fn() }));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    getClient = h.getClient;
  },
}));

import { transcribeMinkVoice } from "./voice-transcription";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GCP_PROJECT_ID", "storemink-test");
  vi.stubEnv("MINK_CHIRP_LOCATION", "");
  vi.stubEnv("SARVAM_API_KEY", "sarvam-secret");
  h.token.mockResolvedValue({ token: "adc-token" });
  h.getClient.mockResolvedValue({ getAccessToken: h.token });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Mink voice providers", () => {
  it("asks Chirp 3 to detect the language automatically", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              alternatives: [{ transcript: "hello store" }],
              languageCode: "en-IN",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    await expect(
      transcribeMinkVoice(
        "chirp_3",
        Buffer.from("wav"),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: "hello store", languageCode: "en-IN" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      "us-speech.googleapis.com/v2/projects/storemink-test",
    );
    expect(init.headers).toMatchObject({ Authorization: "Bearer adc-token" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      config: { languageCodes: ["auto"], model: "chirp_3" },
    });
  });

  it("sends WAV to Saaras v4 with automatic language detection", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ transcript: "नमस्ते", language_code: "hi-IN" }),
        { status: 200 },
      ),
    );
    await expect(
      transcribeMinkVoice(
        "saaras_v4",
        Buffer.from("wav"),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ text: "नमस्ते", languageCode: "hi-IN" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.sarvam.ai/speech-to-text");
    expect(init.headers).toEqual({ "api-subscription-key": "sarvam-secret" });
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("model")).toBe("saaras:v4");
    expect((init.body as FormData).get("language_code")).toBe("unknown");
  });
});
