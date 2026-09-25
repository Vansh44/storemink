import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runWorker = vi.fn();
const schedule = vi.fn();
const reconcile = vi.fn();
vi.mock("@/lib/mink/memories", () => ({
  purgeExpiredMinkMemories: vi.fn(async () => ({ rows: [] })),
}));
vi.mock("@/lib/mink/watches", () => ({
  scheduleMinkWatches: schedule,
  reconcileMinkWatches: reconcile,
}));

vi.mock("@/lib/mink/workflows", () => ({
  runMinkWorkflowWorker: runWorker,
}));
const runStudio = vi.fn();
vi.mock("@/lib/theme-studio/worker", () => ({
  runThemeStudioWorker: runStudio,
}));

describe("Mink workflow cron", () => {
  const original = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
    schedule.mockReset().mockResolvedValue(0);
    reconcile.mockReset().mockResolvedValue(0);
    runStudio.mockReset().mockResolvedValue({
      claimed: 1,
      succeeded: 1,
      failed: 0,
      cancelled: 0,
      requeued: 0,
      reaped: 0,
    });
    runWorker.mockReset().mockResolvedValue({
      claims: 3,
      stepsCompleted: 3,
      workflowsCompleted: 1,
      workflowsCancelled: 0,
      retriesScheduled: 0,
      workflowsFailed: 0,
      notificationsDelivered: 1,
    });
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  it("fails closed without the exact cron bearer token", async () => {
    const { GET, POST } = await import("./route");
    const missing = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows"),
    );
    const wrong = await POST(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      }),
    );
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(runWorker).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("answers 503 rather than an unhandled 500 when the heartbeat throws", async () => {
    // ★ THE CRON CONTRACT prune-logs and seo-refresh already follow: a thrown
    // pass is 503 so Cloud Scheduler's retries engage. A workflow that
    // exhausted its OWN retries is still 200 with ok:false — that is the queue
    // working, not an outage.
    runWorker.mockRejectedValueOnce(new Error("connection terminated"));
    const { POST } = await import("./route");
    const response = await POST(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        method: "POST",
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(503);
    expect(reconcile).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it("reports a workflow that exhausted its own retries as 200, not an outage", async () => {
    runWorker.mockResolvedValueOnce({
      claims: 1,
      stepsCompleted: 0,
      workflowsCompleted: 0,
      workflowsCancelled: 0,
      retriesScheduled: 0,
      workflowsFailed: 1,
      notificationsDelivered: 0,
    });
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: false });
  });

  it("runs one bounded heartbeat for either supported cron method", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      claims: 3,
      workflowsCompleted: 1,
      notificationsDelivered: 1,
    });
    expect(runWorker).toHaveBeenCalledTimes(1);
  });
  it("still runs manual workflows and delivery after a watch scheduling failure", async () => {
    schedule.mockRejectedValueOnce(new Error("watch scheduler unavailable"));
    const { GET } = await import("./route");
    const response = await GET(
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(response.status).toBe(503);
    expect(runWorker).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("drains Theme Studio runs, and a Studio failure never fails Mink", async () => {
    const { GET } = await import("./route");
    const request = () =>
      new Request("https://storemink.com/api/cron/mink-workflows", {
        headers: { authorization: "Bearer cron-secret" },
      });
    const ok = await GET(request());
    expect(ok.status).toBe(200);
    expect(runStudio).toHaveBeenCalledTimes(1);
    // A paid model run can take many minutes; it must never execute on this
    // shared per-minute heartbeat, only on the dedicated worker route.
    expect(runStudio.mock.calls[0][0].providers).toEqual(["fake"]);
    expect((await ok.json()).themeStudio).toMatchObject({ succeeded: 1 });

    runStudio.mockRejectedValueOnce(new Error("studio down"));
    const isolated = await GET(request());
    expect(isolated.status).toBe(200);
    expect(runWorker).toHaveBeenCalledTimes(2);
  });
});
