/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreId: vi.fn(async () => "a0000000-0000-4000-8000-000000000001"),
  FALLBACK_STORE_ID: "a0000000-0000-4000-8000-000000000001",
}));

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) =>
    Promise.resolve(fn(dbHolder.current.db)),
  ),
  withService: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
  withAnon: vi.fn((fn: any) => Promise.resolve(fn(dbHolder.current.db))),
}));

import {
  toggleBlogReaction,
  getBlogReactionCounts,
  submitBlogComment,
  deleteBlogComment,
} from "./blog-social";
import { getServerUser } from "@/lib/auth/server-user";
import { revalidatePath } from "next/cache";
import { demoStoreRefusal } from "@/lib/store/demo-guard";

const DEMO =
  "This is a theme preview, so orders, accounts and forms are turned off.";
// Demo stores refuse every public write (lib/store/demo-guard.ts); a real
// store is the default here.
vi.mock("@/lib/store/demo-guard", () => ({
  demoStoreRefusal: vi.fn(async () => null),
}));

const serverUser = {
  id: "user-1",
  email: "ada@example.com",
  phone: null,
  phoneConfirmed: true,
  metadata: {},
};

// The tally reads blog_likes and counts reaction strings in JS.
const reactionRows = [
  { reaction: "like" },
  { reaction: "love" },
  { reaction: "like" },
];
const tallied = { like: 2, love: 1, haha: 0, wow: 0, celebrate: 0 };
const zeroed = { like: 0, love: 0, haha: 0, wow: 0, celebrate: 0 };

// blog-social.ts powers the anonymous reaction bar (service scope) and
// login-gated comments (customer identity → withUser). BLOG_REACTIONS is used
// with its real values — like / love / haha / wow / celebrate.
describe("blog-social", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({ selectQueue: [reactionRows] });
    vi.mocked(getServerUser).mockResolvedValue(serverUser as any);
  });

  describe("toggleBlogReaction", () => {
    it("rejects a missing blogId", async () => {
      const result = await toggleBlogReaction("", "v1", "like", true);
      expect(result.error).toMatch(/missing reaction context/i);
    });

    it("rejects a missing visitorId", async () => {
      const result = await toggleBlogReaction("b1", "", "like", true);
      expect(result.error).toMatch(/missing reaction context/i);
    });

    it("rejects an unknown reaction", async () => {
      const result = await toggleBlogReaction(
        "b1",
        "v1",
        "thumbsup" as any,
        true,
      );
      expect(result.error).toMatch(/unknown reaction/i);
    });

    it("upserts when active and returns tallied counts", async () => {
      const result = await toggleBlogReaction("b1", "v1", "like", true);
      expect(result.error).toBeUndefined();
      expect(dbHolder.current.calls.insert).toHaveLength(1);
      // ignoreDuplicates → onConflictDoNothing on (blog,visitor,reaction).
      expect(dbHolder.current.calls.onConflict).toHaveLength(1);
      expect(result.counts).toEqual(tallied);
    });

    it("returns an error when the upsert fails", async () => {
      dbHolder.current.db.insert = vi.fn(() => {
        throw new Error("boom");
      });
      const result = await toggleBlogReaction("b1", "v1", "like", true);
      expect(result.error).toMatch(/couldn.?t save/i);
      expect(result.counts).toEqual(zeroed);
    });

    it("deletes when inactive and returns tallied counts", async () => {
      const result = await toggleBlogReaction("b1", "v1", "love", false);
      expect(result.error).toBeUndefined();
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(result.counts).toEqual(tallied);
    });

    it("returns an error when the delete fails", async () => {
      dbHolder.current.db.delete = vi.fn(() => {
        throw new Error("boom");
      });
      const result = await toggleBlogReaction("b1", "v1", "love", false);
      expect(result.error).toMatch(/couldn.?t remove/i);
      expect(result.counts).toEqual(zeroed);
    });
  });

  describe("getBlogReactionCounts", () => {
    it("tallies reaction rows into counts", async () => {
      const counts = await getBlogReactionCounts("b1");
      expect(counts).toEqual(tallied);
    });

    it("returns all zeroes when there are no rows", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });
      const counts = await getBlogReactionCounts("b1");
      expect(counts).toEqual(zeroed);
    });
  });

  const commentForm = {
    blog_id: "b1",
    slug: "hello",
    body: "Great post!",
  };

  describe("submitBlogComment", () => {
    beforeEach(() => {
      // select #1 = the customer profile lookup.
      dbHolder.current = makeDbMock({
        selectQueue: [[{ firstName: "Ada", lastName: "Lovelace" }]],
      });
    });

    it("refuses on a theme demo store", async () => {
      vi.mocked(demoStoreRefusal).mockResolvedValueOnce(DEMO);
      const result = await submitBlogComment(commentForm);
      expect(result.error).toBe(DEMO);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    it("rejects an empty body", async () => {
      const result = await submitBlogComment({ ...commentForm, body: "   " });
      expect(result.error).toMatch(/write something/i);
    });

    it("rejects a body over 2000 characters", async () => {
      const result = await submitBlogComment({
        ...commentForm,
        body: "a".repeat(2001),
      });
      expect(result.error).toMatch(/too long/i);
    });

    it("rejects when not signed in", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await submitBlogComment(commentForm);
      expect(result.error).toMatch(/sign in/i);
    });

    it("rejects when the customer profile is missing", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });
      const result = await submitBlogComment(commentForm);
      expect(result.error).toMatch(/profile/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    it("snapshots the author name from the customer profile", async () => {
      const result = await submitBlogComment(commentForm);
      expect(result.success).toBe(true);
      const inserted = dbHolder.current.calls.values[0];
      expect(inserted.authorName).toBe("Ada Lovelace");
      expect(inserted.blogId).toBe("b1");
      expect(inserted.userId).toBe("user-1");
      expect(inserted.body).toBe("Great post!");
    });

    it("returns the message on an insert error", async () => {
      dbHolder.current.db.insert = vi.fn(() => {
        throw new Error("boom");
      });
      const result = await submitBlogComment(commentForm);
      expect(result.error).toBe("boom");
    });

    it("revalidates the blog page on success", async () => {
      await submitBlogComment(commentForm);
      expect(revalidatePath).toHaveBeenCalledWith("/blogs/hello");
    });
  });

  describe("deleteBlogComment", () => {
    it("rejects when not signed in", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await deleteBlogComment("cmt-1", "hello");
      expect(result.error).toMatch(/sign in/i);
    });

    it("returns the message on a delete error", async () => {
      dbHolder.current.db.delete = vi.fn(() => {
        throw new Error("boom");
      });
      const result = await deleteBlogComment("cmt-1", "hello");
      expect(result.error).toBe("boom");
    });

    it("deletes the comment and revalidates", async () => {
      const result = await deleteBlogComment("cmt-1", "hello");
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(revalidatePath).toHaveBeenCalledWith("/blogs/hello");
    });
  });
});
