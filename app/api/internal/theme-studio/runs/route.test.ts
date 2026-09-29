import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runStudio = vi.fn();
const runQa = vi.fn();
vi.mock("@/lib/theme-studio/visual-qa", () => ({
  runThemeStudioVisualQaWorker: runQa,
}));
vi.mock("@/lib/theme-studio/worker", () => ({
  runThemeStudioWorker: runStudio,
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));

const URL = "https://storemink.com/api/internal/theme-studio/runs";

describe("Theme Studio model worker route", () => {
  const original = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
    runQa.mockReset().mockResolvedValue({
      claimed: 0,
      passed: 0,
      revisionQueued: 0,
      failed: 0,
    });
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

  it("starts two run lanes and visual QA concurrently", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request(URL, { headers: { authorization: "Bearer cron-secret" } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      runs: [{ claimed: 1 }, { claimed: 1 }],
      qa: { claimed: 0 },
    });
    expect(runStudio).toHaveBeenCalledTimes(2);
    expect(runQa).toHaveBeenCalledTimes(1);
    const options = runStudio.mock.calls[0][0];
    expect(options.maxRuns).toBe(1);
    expect(options.skipVisualQa).toBe(true);
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

it("starts every lane before awaiting, and waits for paid work even if another lane fails", async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = "s";
  let finish!: () => void;
  runStudio.mockRejectedValueOnce(new Error("db down")).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ claimed: 1 });
      }),
  );
  runQa.mockResolvedValue({ claimed: 0 });
  try {
    const { POST } = await import("./route");
    let completed = false;
    const pending = POST(
      new Request(URL, {
        method: "POST",
        headers: { authorization: "Bearer s" },
      }),
    ).then((response) => {
      completed = true;
      return response;
    });
    await Promise.resolve();
    expect(runStudio).toHaveBeenCalledTimes(2);
    expect(runQa).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
    finish();
    expect((await pending).status).toBe(503);
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});
