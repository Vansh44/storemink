import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runStudio = vi.fn();
vi.mock("@/lib/theme-studio/worker", () => ({
  runThemeStudioWorker: runStudio,
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

const URL = "https://storemink.com/api/internal/theme-studio/runs";

describe("Theme Studio model worker route", () => {
  const original = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
    runStudio.mockReset().mockResolvedValue({
      claimed: 1,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      requeued: 0,
      reaped: 0,
    });
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it("fails closed without the exact bearer token", async () => {
    const { GET, POST } = await import("./route");
    const missing = await GET(new Request(URL));
    const wrong = await POST(
      new Request(URL, {
        method: "POST",
        headers: { authorization: "Bearer nope" },
      }),
    );
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    delete process.env.CRON_SECRET;
    const unset = await GET(
      new Request(URL, { headers: { authorization: "Bearer " } }),
    );
    expect(unset.status).toBe(401);
    expect(runStudio).not.toHaveBeenCalled();
  });

  it("runs exactly one run, including model-provider runs", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(URL, { headers: { authorization: "Bearer cron-secret" } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, claimed: 1 });
    expect(runStudio).toHaveBeenCalledTimes(1);
    const options = runStudio.mock.calls[0][0];
    expect(options.maxRuns).toBe(1);
    expect(options.providers).toContain("vertex-gemini");
  });

  it("answers 503 so the scheduler retries a thrown pass", async () => {
    runStudio.mockRejectedValueOnce(new Error("db down"));
    const { POST } = await import("./route");
    const response = await POST(
      new Request(URL, {
        method: "POST",
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("db down");
  });
});
