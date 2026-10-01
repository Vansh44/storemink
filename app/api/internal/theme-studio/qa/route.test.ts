import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { runQa } = vi.hoisted(() => ({ runQa: vi.fn() }));
vi.mock("@/lib/theme-studio/visual-qa", () => ({
  runThemeStudioVisualQaWorker: runQa,
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
import { POST } from "./route";

const request = (token?: string) =>
  new Request("https://storemink.com/api/internal/theme-studio/qa", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "secret");
  runQa.mockReset().mockResolvedValue({ claimed: 0 });
});
afterEach(() => vi.unstubAllEnvs());
describe("independent QA worker", () => {
  it("requires an exact configured bearer token", async () => {
    expect((await POST(request())).status).toBe(401);
    expect((await POST(request("wrong"))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(request("secret"))).status).toBe(401);
    expect(runQa).not.toHaveBeenCalled();
  });
  it("drains two lanes without waiting on a generation request", async () => {
    expect((await POST(request("secret"))).status).toBe(200);
    expect(runQa).toHaveBeenCalledTimes(2);
  });
  it("does not abandon the other lane on failure", async () => {
    let finish!: () => void;
    runQa
      .mockRejectedValueOnce(new Error("private detail"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ claimed: 1 });
          }),
      );
    let settled = false;
    const pending = POST(request("secret")).then((response) => {
      settled = true;
      return response;
    });
    await Promise.resolve();
    expect(runQa).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    finish();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
  });
});
