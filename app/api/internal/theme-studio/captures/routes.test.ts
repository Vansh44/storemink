import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claim = vi.fn();
const finish = vi.fn();
vi.mock("@/lib/theme-studio/capture", () => ({
  MAX_CAPTURE_BYTES: 1024,
  MAX_QA_SCREENSHOT_BYTES: 1024,
  claimThemeStudioCapture: (...args: unknown[]) => claim(...args),
  finishThemeStudioCapture: (...args: unknown[]) => finish(...args),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

import { POST as claimRoute } from "./claim/route";
import { POST as finishRoute } from "./[captureId]/route";

beforeEach(() => vi.stubEnv("CRON_SECRET", "s3cret"));
afterEach(() => vi.unstubAllEnvs());

const auth = { authorization: "Bearer s3cret" };
const params = { params: Promise.resolve({ captureId: "c-1" }) };
const post = (body: unknown, headers: Record<string, string> = auth) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("claiming a capture", () => {
  it("refuses a caller without the cron secret, and with no secret configured", async () => {
    expect((await claimRoute(post({}, {}))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect(
      (await claimRoute(post({}, { authorization: "Bearer " }))).status,
    ).toBe(401);
    expect(claim).not.toHaveBeenCalled();
  });

  it("says 204 when nothing is queued, and hands over a claim when something is", async () => {
    claim.mockResolvedValueOnce(null);
    expect((await claimRoute(post({}))).status).toBe(204);
    claim.mockResolvedValueOnce({ captureId: "c-1", leaseToken: "l" });
    const response = await claimRoute(post({}));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      captureId: "c-1",
      leaseToken: "l",
    });
  });

  it("answers 503 when claiming throws", async () => {
    claim.mockRejectedValueOnce(new Error("db down"));
    expect((await claimRoute(post({}))).status).toBe(503);
  });
});

describe("finishing a capture", () => {
  it("refuses a caller without the cron secret", async () => {
    expect((await finishRoute(post({}, {}), params)).status).toBe(401);
    expect(finish).not.toHaveBeenCalled();
  });

  it("refuses a malformed or oversized body before anything is processed", async () => {
    expect((await finishRoute(post("not json"), params)).status).toBe(400);
    expect((await finishRoute(post({ images: [] }), params)).status).toBe(400);
    expect(
      (
        await finishRoute(
          post({ leaseToken: "l", images: [{ slotId: 1, base64: "x" }] }),
          params,
        )
      ).status,
    ).toBe(400);
    // Past the ceiling: three maximum pictures plus 64 KiB of headroom.
    const huge = "a".repeat(200 * 1024);
    expect(
      (
        await finishRoute(
          post({ leaseToken: "l", images: [{ slotId: "p", base64: huge }] }),
          params,
        )
      ).status,
    ).toBe(400);
    expect(finish).not.toHaveBeenCalled();
  });

  it("decodes the pictures and passes them on with the lease", async () => {
    finish.mockResolvedValueOnce({ status: "succeeded", versionId: "v" });
    const response = await finishRoute(
      post({
        leaseToken: "l",
        images: [
          { slotId: "preview", base64: Buffer.from("jpg").toString("base64") },
        ],
      }),
      params,
    );
    expect(response.status).toBe(200);
    expect(finish).toHaveBeenCalledWith({
      captureId: "c-1",
      leaseToken: "l",
      images: [
        { slotId: "preview", bytes: new Uint8Array(Buffer.from("jpg")) },
      ],
      error: undefined,
    });
  });

  it("passes on a reported error, and says 409 to a job that lost its lease", async () => {
    finish.mockResolvedValueOnce({ status: "lost" });
    const response = await finishRoute(
      post({ leaseToken: "l", error: "capture_timeout" }),
      params,
    );
    expect(response.status).toBe(409);
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ error: "capture_timeout", images: undefined }),
    );
  });
});
