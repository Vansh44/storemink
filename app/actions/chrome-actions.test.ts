/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock, sqlParamValues } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/notifications/record", () => ({
  emitEvent: vi.fn(),
  recordEvent: vi.fn(),
}));
vi.mock("@/lib/db/errors", () => ({
  dbErrorMessage: vi.fn((_e: any, fallback: string) => fallback),
  isUniqueViolation: vi.fn(() => false),
}));

const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_i: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));
vi.mock("@/lib/themes/runtime-registry", () => ({
  resolveThemeDefinition: vi.fn(async (id: unknown, version?: unknown) => {
    const { getThemeDefinition } = await import("@/lib/themes");
    return getThemeDefinition(id, version);
  }),
}));

import {
  saveChromeDraft,
  publishChrome,
  revertChromeDraft,
} from "./chrome-actions";
import { getManagerUserId } from "@/app/dashboard/lib/access";
import { revalidateTag } from "next/cache";
import { emitEvent } from "@/lib/notifications/record";
import { TAGS } from "@/lib/storefront/tags";
import { storeChrome } from "@/drizzle/schema";

const DRAFT = { header: { showSearch: true }, footer: { columns: [] } };

// chrome-actions.ts edits the site-wide header + footer from inside the website
// builder (§11). Same trust boundary and draft → publish contract as
// page-actions: gated on `builder`, store-scoped from the HOST, service-scope
// writes because the `draft` column is revoked from anon at the DB layer.
describe("chrome-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock();
    vi.mocked(getManagerUserId).mockResolvedValue("admin-1");
  });

  describe("saveChromeDraft", () => {
    it("rejects a caller without the builder permission", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);

      const result = await saveChromeDraft(DRAFT);

      expect(result.error).toMatch(/not authenticated/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    it("upserts the draft keyed on store_id and returns a fresh token", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[]],
        returning: [{ updated_at: "2026-08-06T10:00:00Z" }],
      });

      const result = await saveChromeDraft(DRAFT);

      expect(result.success).toBe(true);
      expect(result.data?.updatedAt).toBe("2026-08-06T10:00:00Z");
      expect(dbHolder.current.calls.insert[0]).toBe(storeChrome);
      expect(dbHolder.current.calls.onConflict[0]).toMatchObject({
        target: storeChrome.storeId,
      });
    });

    it("writes only the draft column, never published", async () => {
      // The storefront reads `published`; an autosave that touched it would put
      // half-typed edits live on every page of the store.
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      await saveChromeDraft(DRAFT);

      expect(dbHolder.current.calls.values[0]).not.toHaveProperty("published");
      expect(dbHolder.current.calls.onConflict[0].set).not.toHaveProperty(
        "published",
      );
    });

    it("scopes the write to the acting store from the host", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      await saveChromeDraft(DRAFT);

      expect(dbHolder.current.calls.values[0].storeId).toBe("store-1");
    });

    it("saves without a token when the caller sends none", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ draft: {}, published: {}, updated_at: "OLD" }]],
      });

      const result = await saveChromeDraft(DRAFT);

      expect(result.success).toBe(true);
    });

    it("refuses to clobber a save made in another tab", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ draft: {}, published: {}, updated_at: "NEWER" }]],
      });

      const result = await saveChromeDraft(DRAFT, "STALE");

      expect(result.error).toMatch(/changed somewhere else/i);
      // `stale` lets the autosave hook tell a hard block from a transient
      // failure — one blocks, the other retries.
      expect(result.data?.stale).toBe(true);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    it("proceeds when the token matches the stored row", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ draft: {}, published: {}, updated_at: "TOKEN" }]],
        returning: [{ updated_at: "TOKEN2" }],
      });

      const result = await saveChromeDraft(DRAFT, "TOKEN");

      expect(result.success).toBe(true);
      expect(result.data?.updatedAt).toBe("TOKEN2");
    });

    it("proceeds when a token is sent but no row exists yet", async () => {
      // First-ever save on a store: there is nothing to be stale against.
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      const result = await saveChromeDraft(DRAFT, "TOKEN");

      expect(result.success).toBe(true);
    });

    it("treats a failed row read as no row rather than throwing", async () => {
      // readRow guards with `.catch(() => [])`, which only sees an ASYNC
      // rejection — the shape a real pool failure takes.
      dbHolder.current = makeDbMock();
      dbHolder.current.db.select = vi.fn(() => {
        const s: any = {
          from: () => s,
          where: () => s,
          limit: () => Promise.reject(new Error("read failed")),
        };
        return s;
      });

      const result = await saveChromeDraft(DRAFT);

      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.insert[0]).toBe(storeChrome);
    });

    it("never fails on incomplete input", async () => {
      // A merchant halfway through typing a link label has an invalid href;
      // refusing that save would lose their work.
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      const result = await saveChromeDraft({ header: { links: [{}] } });

      expect(result.success).toBe(true);
    });

    it("returns a message when the write fails", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      dbHolder.current = makeDbMock({
        selectQueue: [[]],
        failInsertFor: [storeChrome],
      });

      const result = await saveChromeDraft(DRAFT);

      expect(result.error).toBe("Could not save.");
      expect(result.success).toBeUndefined();
      spy.mockRestore();
    });

    it("returns success with an undefined token when the upsert returns no row", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]], returning: [] });

      const result = await saveChromeDraft(DRAFT);

      expect(result.success).toBe(true);
      expect(result.data?.updatedAt).toBeUndefined();
    });
  });

  describe("publishChrome", () => {
    const ROW = {
      draft: DRAFT,
      published: { header: {}, footer: {} },
      updated_at: "TOKEN",
    };

    it("rejects a caller without the builder permission", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);

      const result = await publishChrome();

      expect(result.error).toMatch(/not authenticated/i);
    });

    it("refuses when the store has never saved chrome", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      const result = await publishChrome();

      expect(result.error).toMatch(/nothing to publish/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("refuses a stale publish", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[ROW]] });

      const result = await publishChrome("OLD");

      expect(result.error).toMatch(/changed somewhere else/i);
      expect(result.data?.stale).toBe(true);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("copies draft → published and stamps published_at", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[ROW]] });

      const result = await publishChrome("TOKEN");

      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.update[0]).toBe(storeChrome);
      expect(dbHolder.current.calls.set[0]).toHaveProperty("published");
      expect(dbHolder.current.calls.set[0]).toHaveProperty("publishedAt");
      expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
        "store-1",
      );
    });

    // ★★ LEGIBILITY IS A PUBLISH GATE, NOT A SAVE GATE. A half-picked palette
    // mid-edit is a normal intermediate state and must not fail autosave, but
    // putting unreadable body text in front of shoppers is not recoverable by
    // the merchant noticing later — and the storefront has no other defence.
    // `selectByTable`, not the positional queue: publishChrome reads
    // store_chrome AND stores, and a positional queue cannot say which is which.
    it("refuses to publish a colour scheme that cannot be read", async () => {
      dbHolder.current = makeDbMock({
        selectByTable: {
          store_chrome: [
            [
              {
                draft: {
                  ...DRAFT,
                  design: { palette: { ink: "#999999", cream: "#aaaaaa" } },
                },
                published: {},
                updated_at: "TOKEN",
              },
            ],
          ],
          stores: [[{ settings: {} }]],
        },
      });

      const result = await publishChrome("TOKEN");

      expect(result.error).toMatch(/not readable/i);
      // `data` is Record<string, unknown>, so match the array itself rather
      // than indexing into an unknown.
      expect(result.data?.contrastIssues).toEqual([
        expect.stringMatching(/body text/i),
      ]);
      // Nothing went live.
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("publishes a legible colour scheme", async () => {
      dbHolder.current = makeDbMock({
        selectByTable: {
          store_chrome: [
            [
              {
                draft: {
                  ...DRAFT,
                  design: {
                    palette: { ink: "#111111", cream: "#ffffff" },
                    fonts: { body: "jost" },
                  },
                },
                published: {},
                updated_at: "TOKEN",
              },
            ],
          ],
          stores: [[{ settings: {} }]],
        },
      });

      const result = await publishChrome("TOKEN");

      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.set[0].published).toMatchObject({
        design: {
          palette: { ink: "#111111", cream: "#ffffff" },
          fonts: { body: "jost", display: null },
        },
      });
    });

    it("publishes without a token when the caller sends none", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[ROW]] });

      const result = await publishChrome();

      expect(result.success).toBe(true);
    });

    it("re-sanitises the draft on the way out", async () => {
      // The stored draft was written by an earlier sanitiser or a migration,
      // and this is the value the public will actually render.
      dbHolder.current = makeDbMock({
        selectQueue: [
          [
            {
              draft: { header: null, junk: "x" },
              published: {},
              updated_at: "T",
            },
          ],
        ],
      });

      const result = await publishChrome();

      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.set[0].published).not.toHaveProperty(
        "junk",
      );
    });

    it("busts the chrome cache tag so the new header is visible at once", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[ROW]] });

      await publishChrome();

      expect(revalidateTag).toHaveBeenCalledWith(TAGS.chrome, "max");
    });

    it("emits page.published so the change lands in the activity trail", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[ROW]] });

      await publishChrome();

      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "page.published",
          storeId: "store-1",
          actor: { type: "admin", id: "admin-1" },
          subject: { type: "page", id: "chrome", label: "Header & footer" },
        }),
      );
    });

    it("does not revalidate or emit when the write fails", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      dbHolder.current = makeDbMock({
        selectQueue: [[ROW]],
        failUpdateFor: [storeChrome],
      });

      const result = await publishChrome();

      expect(result.error).toBe("Could not publish.");
      expect(revalidateTag).not.toHaveBeenCalled();
      expect(emitEvent).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("revertChromeDraft", () => {
    it("rejects a caller without the builder permission", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);

      const result = await revertChromeDraft();

      expect(result.error).toMatch(/not authenticated/i);
    });

    it("refuses when there is no row at all", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });

      const result = await revertChromeDraft();

      expect(result.error).toMatch(/no published version/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("refuses when the row has never been published", async () => {
      // Reverting to null would blank the store's navigation entirely.
      dbHolder.current = makeDbMock({
        selectQueue: [[{ draft: DRAFT, published: null, updated_at: "T" }]],
      });

      const result = await revertChromeDraft();

      expect(result.error).toMatch(/no published version/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("copies published back over the draft and returns the normalized chrome", async () => {
      const published = { header: { showSearch: false }, footer: {} };
      dbHolder.current = makeDbMock({
        selectQueue: [[{ draft: DRAFT, published, updated_at: "T" }]],
      });

      const result = await revertChromeDraft();

      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toEqual({ draft: published });
      expect(result.data?.chrome).toBeTruthy();
      expect(sqlParamValues(dbHolder.current.calls.where[0])).toContain(
        "store-1",
      );
    });

    it("leaves the published column untouched", async () => {
      // Revert discards the working copy; it must not disturb what is live.
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ draft: DRAFT, published: { header: {} }, updated_at: "T" }],
        ],
      });

      await revertChromeDraft();

      expect(dbHolder.current.calls.set[0]).not.toHaveProperty("published");
    });

    it("returns a message when the write fails", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ draft: DRAFT, published: { header: {} }, updated_at: "T" }],
        ],
        failUpdateFor: [storeChrome],
      });

      const result = await revertChromeDraft();

      expect(result.error).toBe("Could not revert.");
      spy.mockRestore();
    });
  });
});
