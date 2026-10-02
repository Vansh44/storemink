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
  withUser: vi.fn((_identity: any, fn: any) => fn(dbHolder.current.db)),
  withService: vi.fn((fn: any) => fn(dbHolder.current.db)),
  withAnon: vi.fn((fn: any) => fn(dbHolder.current.db)),
}));

import { submitReview, deleteReview } from "./review-actions";
import { getServerUser } from "@/lib/auth/server-user";
import { demoStoreRefusal } from "@/lib/store/demo-guard";

const DEMO =
  "This is a theme preview, so orders, accounts and forms are turned off.";
// Demo stores refuse every public write (lib/store/demo-guard.ts); a real
// store is the default here.
vi.mock("@/lib/store/demo-guard", () => ({
  demoStoreRefusal: vi.fn(async () => null),
}));

const validReview = {
  product_id: "p1",
  slug: "almonds",
  rating: 5,
  comment: "Great",
};

const ada = { firstName: "Ada", lastName: "Lovelace" };

// review-actions.ts — product reviews are written by signed-in users (identity
// via the getServerUser seam, writes via withUser so own-row RLS applies).
// The unique (product_id, user_id) constraint makes this an upsert.
describe("review-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // select #1 = the customer-profile read for the author-name snapshot.
    dbHolder.current = makeDbMock({ selectQueue: [[ada]] });
    vi.mocked(getServerUser).mockResolvedValue({
      id: "user-1",
      email: "ada@example.com",
      emailConfirmed: true,
      phone: null,
      phoneConfirmed: false,
      metadata: {},
    });
  });

  describe("submitReview", () => {
    it("refuses on a theme demo store", async () => {
      vi.mocked(demoStoreRefusal).mockResolvedValueOnce(DEMO);
      const result = await submitReview(validReview);
      expect(result.error).toBe(DEMO);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    // Anonymous visitors must sign in to leave a review.
    it("rejects unauthenticated callers", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await submitReview(validReview);
      expect(result.error).toMatch(/sign in/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    // Star rating must be 1–5 — anything else is rejected.
    it("rejects a rating below 1", async () => {
      const result = await submitReview({ ...validReview, rating: 0 });
      expect(result.error).toMatch(/1 to 5/);
    });

    it("rejects a rating above 5", async () => {
      const result = await submitReview({ ...validReview, rating: 6 });
      expect(result.error).toMatch(/1 to 5/);
    });

    // A signed-in user without a users row can't write a review — the
    // join target for the author name is required.
    it("rejects when customer profile is missing", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });
      const result = await submitReview(validReview);
      expect(result.error).toMatch(/profile/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    // Happy path — upsert with the author name snapshotted onto the review.
    it("upserts the review with snapshotted author name", async () => {
      const result = await submitReview(validReview);
      expect(result.success).toBe(true);
      const inserted = dbHolder.current.calls.values[0];
      expect(inserted.authorName).toBe("Ada Lovelace");
      expect(inserted.productId).toBe("p1");
      expect(inserted.userId).toBe("user-1");
      expect(inserted.rating).toBe(5);
      // The conflict clause turns a duplicate submission into an edit.
      expect(dbHolder.current.calls.onConflict).toHaveLength(1);
      expect(dbHolder.current.calls.onConflict[0].set.rating).toBe(5);
    });

    // Fallback name when both first/last are missing/empty.
    it("falls back to 'Anonymous' when the customer's name is empty", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ firstName: "", lastName: null }]],
      });
      await submitReview(validReview);
      expect(dbHolder.current.calls.values[0].authorName).toBe("Anonymous");
    });

    // Float ratings (4.7) get truncated to int (4).
    it("truncates fractional ratings to integers", async () => {
      await submitReview({ ...validReview, rating: 4.7 });
      expect(dbHolder.current.calls.values[0].rating).toBe(4);
    });

    // DB failure surfaces the message.
    it("returns the error message when the upsert fails", async () => {
      dbHolder.current.db.insert = vi.fn(() => {
        throw new Error("boom");
      });
      const result = await submitReview(validReview);
      expect(result.error).toBe("boom");
    });
  });

  describe("deleteReview", () => {
    // Anonymous visitors blocked.
    it("rejects unauthenticated callers", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await deleteReview("r1", "almonds");
      expect(result.error).toMatch(/sign in/i);
      expect(dbHolder.current.calls.delete).toHaveLength(0);
    });

    // Happy path — the action triggers a delete on product_reviews
    // (RLS enforces ownership at the DB layer).
    it("issues a delete on product_reviews", async () => {
      const result = await deleteReview("r1", "almonds");
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
    });
  });
});
