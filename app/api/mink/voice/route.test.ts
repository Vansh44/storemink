import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  actor: vi.fn(),
  config: vi.fn(),
  reserve: vi.fn(),
  validate: vi.fn(),
  provider: vi.fn(),
  transcribe: vi.fn(),
  log: vi.fn(),
}));

vi.mock("@/lib/mink/actor-context", () => ({ getMinkActorContext: h.actor }));
vi.mock("@/lib/mink/config", () => ({ getMinkConfig: h.config }));
vi.mock("@/lib/mink/input-limits", () => ({ reserveMinkInput: h.reserve }));
vi.mock("@/lib/mink/input-validation", () => ({
  validateMinkInput: h.validate,
}));
vi.mock("@/lib/mink/voice-settings", () => ({
  getMinkVoiceProvider: h.provider,
}));
vi.mock("@/lib/mink/voice-transcription", () => ({
  transcribeMinkVoice: h.transcribe,
}));
vi.mock("@/lib/observability/logger", () => ({ logInfo: h.log }));

import { POST } from "./route";

const url = "https://echos.dev.storemink.com/api/mink/voice";
const requestKey = "11111111-1111-4111-8111-111111111111";
const req = (body: BodyInit = new Uint8Array([1]), headers = {}) =>
  new Request(url, {
    method: "POST",
    headers: {
      origin: new URL(url).origin,
      "Content-Type": "audio/wav",
      "X-Mink-Request-Key": requestKey,
      ...headers,
    },
    body,
  });

beforeEach(() => {
  vi.resetAllMocks();
  h.config.mockReturnValue({ enabled: true });
  h.actor.mockResolvedValue({ storeId: "echos", adminId: "owner" });
  h.validate.mockImplementation(async (input) => ({
    kind: "audio",
    bytes: input.bytes,
  }));
  h.provider.mockResolvedValue("saaras_v4");
  h.transcribe.mockResolvedValue({
    text: "नमस्ते StoreMink",
    languageCode: "hi-IN",
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("global Mink voice endpoint", () => {
  it("uses the single global provider and returns one transcript", async () => {
    const response = await POST(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: "नमस्ते StoreMink",
      languageCode: "hi-IN",
    });
    expect(h.provider).toHaveBeenCalledOnce();
    expect(h.transcribe).toHaveBeenCalledWith(
      "saaras_v4",
      expect.any(Buffer),
      expect.any(AbortSignal),
    );
    expect(h.reserve).toHaveBeenCalledWith(
      { storeId: "echos", adminId: "owner" },
      requestKey,
    );
  });

  it("rejects foreign origins and non-WAV input before provider work", async () => {
    expect(
      (await POST(req(undefined, { origin: "https://evil.example" }))).status,
    ).toBe(403);
    expect(
      (await POST(req(undefined, { "Content-Type": "audio/mpeg" }))).status,
    ).toBe(415);
    expect(h.provider).not.toHaveBeenCalled();
  });

  it("bounds streamed audio without trusting Content-Length", async () => {
    const response = await POST(
      req(new Uint8Array(960_045), { "Content-Length": "1" }),
    );
    expect(response.status).toBe(413);
    expect(h.validate).not.toHaveBeenCalled();
    expect(h.provider).not.toHaveBeenCalled();
  });

  it("does not expose provider errors, audio or transcript content in logs", async () => {
    h.transcribe.mockRejectedValue(new Error("secret provider response"));
    const response = await POST(req(new Uint8Array([7, 8, 9])));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret provider response");
    expect(JSON.stringify(h.log.mock.calls)).not.toMatch(
      /secret provider response|नमस्ते|7,8,9/,
    );
  });
});
