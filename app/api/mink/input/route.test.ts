import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  actor: vi.fn(),
  config: vi.fn(),
  reserve: vi.fn(),
  validate: vi.fn(),
  extract: vi.fn(),
  log: vi.fn(),
}));
vi.mock("@/lib/mink/actor-context", () => ({ getMinkActorContext: h.actor }));
vi.mock("@/lib/mink/config", () => ({ getMinkConfig: h.config }));
vi.mock("@/lib/mink/input-limits", () => ({ reserveMinkInput: h.reserve }));
vi.mock("@/lib/mink/input-validation", async (original) => ({
  ...(await original<object>()),
  validateMinkInput: h.validate,
}));
vi.mock("@/lib/mink/input-provider", () => ({ extractMinkInput: h.extract }));
vi.mock("@/lib/observability/logger", () => ({ logInfo: h.log }));
import { GET, POST } from "./route";
import { MinkRequestError } from "@/lib/mink/errors";
const url = "https://echos.dev.storemink.com/api/mink/input";
const payload = {
  name: "private.png",
  data: "YQ==",
  confirmed: true,
  requestKey: "11111111-1111-4111-8111-111111111111",
};
const req = (body: unknown = payload, headers = {}) =>
  new Request(url, {
    method: "POST",
    headers: {
      origin: new URL(url).origin,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MINK_MULTIMODAL_ENABLED", "true");
  h.config.mockReturnValue({ enabled: true, model: "model" });
  h.actor.mockResolvedValue({ storeId: "echos", adminId: "owner" });
  h.validate.mockResolvedValue({ kind: "image" });
  h.extract.mockResolvedValue({
    text: "Reviewed source",
    usage: { promptTokenCount: 42 },
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("multimodal endpoint authority", () => {
  it("requires the global gate before provider work", async () => {
    h.config.mockReturnValue({ enabled: false });
    expect((await POST(req())).status).toBe(404);
    expect(h.extract).not.toHaveBeenCalled();
    expect(await (await GET()).json()).toEqual({ enabled: false });
  });
  it("does not require a separate multimodal feature switch", async () => {
    vi.stubEnv("MINK_MULTIMODAL_ENABLED", "false");
    expect((await POST(req())).status).toBe(200);
    expect(await (await GET()).json()).toEqual({ enabled: true });
  });
  it("rejects foreign origins before auth", async () => {
    expect(
      (await POST(req(payload, { origin: "https://evil.example" }))).status,
    ).toBe(403);
    expect(h.actor).not.toHaveBeenCalled();
  });
  it("honours auth/invite denial", async () => {
    h.actor.mockRejectedValue(new MinkRequestError("denied", "Denied", 403));
    expect((await POST(req())).status).toBe(403);
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it("requires consent and forbids forged ownership", async () => {
    for (const extra of [{ confirmed: false }, { storeId: "other" }])
      expect((await POST(req({ ...payload, ...extra }))).status).toBe(400);
    expect(h.extract).not.toHaveBeenCalled();
  });
  it("uses trusted identities, private caching and content-free logs", async () => {
    const response = await POST(req());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(h.reserve).toHaveBeenCalledWith(
      { storeId: "echos", adminId: "owner" },
      payload.requestKey,
    );
    expect(JSON.stringify(h.log.mock.calls)).not.toMatch(
      /private.png|YQ==|Reviewed source/,
    );
  });
  it("fails closed on quota database outage before decoding/provider", async () => {
    h.reserve.mockRejectedValue(new Error("private database values"));
    const response = await POST(req());
    expect(response.status).toBe(503);
    expect(h.validate).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("private database");
  });
  it("enforces actual bytes with absent/forged content length", async () => {
    expect(
      (
        await POST(
          req(
            { ...payload, data: "x".repeat(7_100_001) },
            { "content-length": "1" },
          ),
        )
      ).status,
    ).toBe(413);
    expect(h.reserve).not.toHaveBeenCalled();
  });
  it("does not expose provider errors", async () => {
    h.extract.mockRejectedValue(new Error("secret attachment data"));
    const response = await POST(req());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret attachment");
    expect(JSON.stringify(h.log.mock.calls)).not.toContain("secret attachment");
  });
});
