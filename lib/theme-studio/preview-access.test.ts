import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The gate reads cookies and the host from next/headers and asks the database
// two questions: is the grant's actor a superadmin, and (Track 3.6) is the
// capture a capture cookie names running now.
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      jar.has(name) ? { name, value: jar.get(name)! } : undefined,
  }),
  headers: async () => new Map([["host", "studio-preview-ab.localhost:3000"]]),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  // Request memoisation would carry one test's answer into the next.
  cache: <T>(fn: T) => fn,
}));
const rows: { capture: unknown[]; admin: unknown[] } = {
  capture: [],
  admin: [],
};
const queried: string[] = [];
const wheres: unknown[] = [];
vi.mock("@/lib/db/client", () => ({
  withService: async (fn: (db: unknown) => unknown) => {
    let table = "";
    const chain: Record<string, unknown> = {};
    for (const key of ["select", "limit"]) {
      chain[key] = () => chain;
    }
    chain.where = (condition: unknown) => {
      wheres.push(condition);
      return chain;
    };
    chain.from = (t: { [k: symbol]: unknown }) => {
      const name = String(
        Object.getOwnPropertySymbols(t)
          .map((s) => t[s])
          .find((v) => typeof v === "string") ?? "",
      );
      table = name;
      return chain;
    };
    chain.then = (resolve: (v: unknown) => void) => {
      queried.push(table);
      resolve(table.includes("captures") ? rows.capture : rows.admin);
    };
    return fn(chain);
  },
}));
vi.mock("./access", () => ({ getThemeStudioActor: vi.fn(async () => null) }));

import {
  signPreviewToken,
  CAPTURE_COOKIE,
  PREVIEW_COOKIE,
} from "./preview-token";
import { studioPreviewAllowed } from "./preview-access";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const STORE = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const CAPTURE = "33333333-3333-4333-8333-333333333333";
const ADMIN = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  vi.stubEnv("THEME_STUDIO_PREVIEW_SECRET", "explicit-secret");
  jar.clear();
  rows.capture = [];
  rows.admin = [];
  queried.length = 0;
  wheres.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

const captureCookie = (versionId = VERSION) =>
  signPreviewToken(
    "capture",
    { storeId: STORE, versionId, actorId: CAPTURE },
    60,
  );

describe("the preview gate and the capture job", () => {
  it("opens the preview to a capture cookie while its capture is running", async () => {
    jar.set(CAPTURE_COOKIE, captureCookie());
    rows.capture = [{ id: CAPTURE }];
    expect(await studioPreviewAllowed(STORE, VERSION)).toBe(true);
    expect(queried).toEqual(["theme_studio_captures"]);
  });

  it("asks the database for THIS capture, running, on this version, with a live lease", async () => {
    jar.set(CAPTURE_COOKIE, captureCookie());
    rows.capture = [{ id: CAPTURE }];
    await studioPreviewAllowed(STORE, VERSION);
    const { sql, params } = new PgDialect().sqlToQuery(wheres[0] as SQL);
    expect(sql).toContain('"theme_studio_captures"."id" = $');
    expect(sql).toContain('"theme_studio_captures"."version_id" = $');
    expect(sql).toContain('"theme_studio_captures"."status" = $');
    expect(sql).toContain('"theme_studio_captures"."lease_expires_at" > now()');
    expect(params).toEqual([CAPTURE, VERSION, "running"]);
  });

  it("refuses it once the capture is no longer running", async () => {
    jar.set(CAPTURE_COOKIE, captureCookie());
    rows.capture = [];
    expect(await studioPreviewAllowed(STORE, VERSION)).toBe(false);
  });

  it("refuses a capture cookie minted for another version without asking the database", async () => {
    jar.set(
      CAPTURE_COOKIE,
      captureCookie("55555555-5555-4555-8555-555555555555"),
    );
    rows.capture = [{ id: CAPTURE }];
    expect(await studioPreviewAllowed(STORE, VERSION)).toBe(false);
    expect(queried).toEqual([]);
  });

  it("never takes a grant token in the capture cookie, nor a capture token as a grant", async () => {
    const grant = signPreviewToken(
      "grant",
      { storeId: STORE, versionId: VERSION, actorId: CAPTURE },
      60,
    );
    jar.set(CAPTURE_COOKIE, grant);
    rows.capture = [{ id: CAPTURE }];
    expect(await studioPreviewAllowed(STORE, VERSION)).toBe(false);
    jar.clear();
    jar.set(PREVIEW_COOKIE, captureCookie());
    rows.admin = [{ role: "superadmin" }];
    expect(await studioPreviewAllowed(STORE, VERSION)).toBe(false);
  });

  it("still admits an operator's own grant", async () => {
    jar.set(
      PREVIEW_COOKIE,
      signPreviewToken(
        "grant",
        { storeId: STORE, versionId: VERSION, actorId: ADMIN },
        60,
      ),
    );
    rows.admin = [{ role: "superadmin" }];
    expect(await studioPreviewAllowed(STORE, VERSION)).toBe(true);
  });
});
