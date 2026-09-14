import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  end: vi.fn(async () => undefined),
  drizzle: vi.fn(() => ({ scope: "db" })),
}));

vi.mock("server-only", () => ({}));
vi.mock("pg", () => ({
  Pool: class {
    connect = mocks.connect;
    end = mocks.end;
  },
}));
vi.mock("drizzle-orm/node-postgres", () => ({
  drizzle: mocks.drizzle,
}));
vi.mock("./pg-types", () => ({ postgresStringTimestampTypes: {} }));

import { closePool, withService } from "./client";

function client(query: (sql: string) => Promise<unknown>) {
  return { query: vi.fn(query), release: vi.fn() };
}

beforeEach(async () => {
  await closePool();
  vi.clearAllMocks();
});

describe("database scope connection recovery", () => {
  it("destroys and retries a stale pooled socket that fails before work starts", async () => {
    const reset = Object.assign(new Error("socket reset"), {
      code: "ECONNRESET",
    });
    const stale = client(async (sql) => {
      if (sql === "BEGIN") throw reset;
      return {};
    });
    const healthy = client(async () => ({}));
    mocks.connect.mockResolvedValueOnce(stale).mockResolvedValueOnce(healthy);
    const work = vi.fn(async (db) => db);

    await expect(withService(work)).resolves.toEqual({ scope: "db" });

    expect(stale.release).toHaveBeenCalledWith(true);
    expect(healthy.release).toHaveBeenCalledWith();
    expect(work).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it("never replays work after the transaction callback has started", async () => {
    const reset = Object.assign(new Error("socket reset"), {
      code: "08006",
    });
    const connected = client(async () => ({}));
    mocks.connect.mockResolvedValue(connected);
    const work = vi.fn(async () => {
      throw reset;
    });

    await expect(withService(work)).rejects.toBe(reset);

    expect(work).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(connected.release).toHaveBeenCalledWith(true);
  });
});
