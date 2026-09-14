/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/seo/store-indexing", () => ({
  notifyStoreContentPublished: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getManagerIdentity: vi.fn(),
  getActingStoreId: vi.fn(async () => "a0000000-0000-4000-8000-000000000001"),
}));
vi.mock("@/lib/store/brand", () => ({
  getStoreBrand: vi.fn(async () => ({
    name: "WholeSip",
    domain: "wholesip.com",
  })),
}));
vi.mock("@/lib/store/resolve", () => ({
  getCurrentStoreId: vi.fn(async () => "a0000000-0000-4000-8000-000000000001"),
  FALLBACK_STORE_ID: "a0000000-0000-4000-8000-000000000001",
}));
vi.mock("@/lib/storage/cleanup", () => ({
  // ★ `vi.fn(impl)`, NOT `vi.fn().mockReturnValue(...)` — the latter is wiped
  //   by the config's `mockReset: true`, and a wiped `extractMediaUrlsFromHtml`
  //   returns undefined into a `for…of`, which fails as "not iterable" rather
  //   than as the assertion the test was written for.
  deleteStorageUrls: vi.fn(async () => undefined),
  extractMediaUrlsFromHtml: vi.fn((): string[] => []),
}));
vi.mock("@/lib/storage/gcs", () => ({
  gcsPathFromUrl: (url: string) => {
    const m = /storage\.googleapis\.com\/[^/]+\/(.+)$/.exec(url || "");
    return m ? m[1] : null;
  },
}));
vi.mock("@/lib/notifications/record", () => ({
  emitEvent: vi.fn(),
  recordEvent: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/settings/resolve", () => ({
  getStoreSettings: vi.fn(async () => ({
    "blogs.customerSubmissions": true,
    "blogs.requireApproval": true,
    "pages.customCode": true,
  })),
}));
vi.mock("@/lib/auth/server-user", () => ({ getServerUser: vi.fn() }));
vi.mock("@/lib/blog-taxonomy", () => ({ fetchBlogTaxonomy: vi.fn() }));

// The ported data layer: with* runners invoke the callback with the mock db.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock("@/lib/db/client", () => ({
  withUser: vi.fn((_identity: any, fn: any) => fn(dbHolder.current.db)),
  withService: vi.fn((fn: any) => fn(dbHolder.current.db)),
  withAnon: vi.fn((fn: any) => fn(dbHolder.current.db)),
}));

import {
  createBlog,
  updateBlog,
  deleteBlog,
  publishBlog,
  unpublishBlog,
  submitCustomerBlog,
  approveCustomerBlog,
  rejectCustomerBlog,
  revertCustomerBlogToDraft,
  deleteCustomerBlog,
  deleteUploadedImage,
  bulkSetBlogStatus,
  bulkSetBlogFeatured,
  bulkDeleteBlogs,
} from "./blog-actions";
import { getManagerIdentity } from "@/app/dashboard/lib/access";
import { getServerUser } from "@/lib/auth/server-user";
import { fetchBlogTaxonomy } from "@/lib/blog-taxonomy";
import { getStoreSettings } from "@/lib/settings/resolve";
import {
  resolveStoreSettings,
  type StoreSettingValues,
} from "@/lib/settings/registry";

/**
 * Registry defaults, with only the keys a test actually cares about overridden.
 *
 * `StoreSettingValues` is exhaustive over SETTING_KEYS, so a hand-written
 * literal here breaks every time ANY new setting is added anywhere in the
 * platform — which says nothing about blogs. Deriving the base from the
 * registry keeps these tests about the two flags they're testing.
 */
function settingsWith(
  overrides: Partial<StoreSettingValues>,
): StoreSettingValues {
  return { ...resolveStoreSettings(null, "pro"), ...overrides };
}
import { deleteStorageUrls } from "@/lib/storage/cleanup";
import { emitEvent } from "@/lib/notifications/record";

/** True when an emitEvent call for `type` was made. Approval/rejection mail is
 *  delivered by the notification system now, not a bespoke sender. */
function emitted(type: string): boolean {
  return vi
    .mocked(emitEvent)
    .mock.calls.some(([input]) => input?.type === type);
}

const blogForm = {
  title: "Hello",
  slug: "",
  excerpt: "x",
  content: "<p>body</p>",
  cover_image_url: "",
  author: "Tester",
  categories: ["Nutrition"],
  tags: ["Protein"],
  status: "draft" as const,
  featured: false,
  seo_title: "",
  seo_description: "",
  reading_time: 0,
};

const customerForm = {
  title: "My Post",
  excerpt: "",
  content: "<p>body</p>",
  cover_image_url: "",
  categories: ["Recipes"],
  tags: ["Indian Food"],
};

const ada = { first_name: "Ada", last_name: "Lovelace" };
const serverUser = {
  id: "user-1",
  email: "ada@example.com",
  emailConfirmed: true,
  phone: null,
  phoneConfirmed: true,
  metadata: {},
};

// blog-actions.ts is the largest action file — admin CRUD, the customer
// submission workflow, and the approve/reject email notifications. Admin +
// customer writes run through withUser (RLS-enforced); the direct-publish
// promotion and contact lookups run through withService.
describe("blog-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({ returning: [{ id: "b1" }] });
    vi.mocked(getManagerIdentity).mockResolvedValue({
      uid: "user-1",
      email: "admin@example.com",
    });
    vi.mocked(getServerUser).mockResolvedValue(serverUser);
    // The store's blog taxonomy — customer submissions are validated
    // against these per-store lists (blog_taxonomy.sql).
    vi.mocked(fetchBlogTaxonomy).mockResolvedValue({
      categories: [{ id: "c1", name: "Recipes" }],
      tags: [{ id: "t1", name: "Indian Food" }],
    });
  });

  describe("bulk operations", () => {
    it("bulkSetBlogStatus rejects when not authorised", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const r = await bulkSetBlogStatus(["b1"], "published");
      expect(r.error).toMatch(/not authenticated/i);
    });

    it("bulkSetBlogStatus rejects an empty selection", async () => {
      const r = await bulkSetBlogStatus([], "published");
      expect(r.error).toMatch(/nothing selected/i);
    });

    it("bulkSetBlogStatus publishes the selected ids", async () => {
      const r = await bulkSetBlogStatus(["b1", "b2"], "published");
      expect(r.success).toBe(true);
      const set = dbHolder.current.calls.set[0];
      expect(set.status).toBe("published");
      // published_at is set when publishing.
      expect(set.publishedAt).toBeTruthy();
      expect(dbHolder.current.calls.where).toHaveLength(1);
    });

    it("bulkSetBlogStatus clears published_at when unpublishing", async () => {
      await bulkSetBlogStatus(["b1"], "draft");
      expect(dbHolder.current.calls.set[0]).toMatchObject({
        status: "draft",
        publishedAt: null,
      });
    });

    it("bulkSetBlogStatus surfaces a DB error", async () => {
      dbHolder.current.db.update = vi.fn(() => {
        throw new Error("boom");
      });
      const r = await bulkSetBlogStatus(["b1"], "published");
      expect(r.error).toBe("boom");
    });

    it("bulkSetBlogFeatured updates the featured flag for the ids", async () => {
      const r = await bulkSetBlogFeatured(["b1", "b2"], true);
      expect(r.success).toBe(true);
      expect(dbHolder.current.calls.set[0]).toMatchObject({ featured: true });
      expect(dbHolder.current.calls.where).toHaveLength(1);
    });

    it("bulkDeleteBlogs deletes the ids and cleans up storage", async () => {
      const r = await bulkDeleteBlogs(["b1", "b2"]);
      expect(r.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(deleteStorageUrls).toHaveBeenCalled();
    });

    it("bulkDeleteBlogs rejects when not authorised", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const r = await bulkDeleteBlogs(["b1"]);
      expect(r.error).toMatch(/not authenticated/i);
    });

    it("bulkDeleteBlogs surfaces a DB error", async () => {
      dbHolder.current.db.delete = vi.fn(() => {
        throw new Error("nope");
      });
      const r = await bulkDeleteBlogs(["b1"]);
      expect(r.error).toBe("nope");
    });
  });

  describe("createBlog", () => {
    // Auth gate.
    it("rejects when caller lacks blogs.manage", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await createBlog(blogForm);
      expect(result.error).toMatch(/not authenticated/i);
    });

    // Reading time is computed from the content's word count, max 1 min.
    it("computes reading_time from content", async () => {
      await createBlog({
        ...blogForm,
        content: "<p>" + "word ".repeat(400) + "</p>",
      });
      // 400 words at 200 wpm = 2.
      expect(dbHolder.current.calls.values[0].readingTime).toBe(2);
    });

    // Drafts get published_at = null; published rows get a timestamp.
    it("publishes immediately when status=published", async () => {
      await createBlog({ ...blogForm, status: "published" });
      expect(dbHolder.current.calls.values[0].publishedAt).not.toBeNull();
    });

    it("uses a slug derived from the title", async () => {
      await createBlog({ ...blogForm, title: "Hello World" });
      expect(dbHolder.current.calls.values[0].slug).toBe("hello-world");
    });

    // A concurrent insert wins the slug between pre-check and insert → the
    // unique violation triggers a retry with the next slug in a NEW txn.
    it("retries with a bumped slug on a unique-violation insert", async () => {
      const realInsert = dbHolder.current.db.insert;
      let attempts = 0;
      dbHolder.current.db.insert = vi.fn((t: any) => {
        if (attempts++ === 0)
          throw Object.assign(new Error("Failed query"), {
            cause: Object.assign(new Error("dup"), { code: "23505" }),
          });
        return realInsert(t);
      });
      const result = await createBlog({ ...blogForm, title: "Hello" });
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.values[0].slug).toBe("hello-2");
    });
  });

  describe("updateBlog", () => {
    // Auth gate.
    it("rejects unauthorised callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await updateBlog("b1", blogForm);
      expect(result.error).toMatch(/not authenticated/i);
    });

    // Approving a customer submission via the editor (status flip
    // pending_review → published) triggers the "your blog is live" email.
    // Selects: #1 resolveSlug, #2 current blog, #3 the author's contact.
    it("emails the author when promoting a customer submission to published", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [],
          [
            {
              status: "pending_review",
              published_at: null,
              submitted_by: "cust-1",
              is_customer_submission: true,
              cover_image_url: null,
              content: null,
            },
          ],
          [{ email: "ada@example.com", firstName: "Ada" }],
        ],
      });
      await updateBlog("b1", { ...blogForm, status: "published" });
      expect(emitted("blog.approved")).toBe(true);
    });

    // Updating a regular published post should NOT trigger the customer email.
    it("does not email when updating a non-customer submission", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [],
          [
            {
              status: "draft",
              published_at: null,
              submitted_by: null,
              is_customer_submission: false,
              cover_image_url: null,
              content: null,
            },
          ],
        ],
      });
      await updateBlog("b1", { ...blogForm, status: "published" });
      expect(emitted("blog.approved")).toBe(false);
    });
  });

  describe("publishBlog / unpublishBlog", () => {
    it("publishBlog rejects unauthorised callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      expect((await publishBlog("b1")).error).toMatch(/not authenticated/i);
    });

    // Sets status + stamps published_at.
    it("publishBlog updates status and stamps published_at", async () => {
      const r = await publishBlog("b1");
      expect(r.success).toBe(true);
      const set = dbHolder.current.calls.set[0];
      expect(set.status).toBe("published");
      expect(set.publishedAt).not.toBeNull();
    });

    // No matching row (RLS or already deleted) → a friendly error.
    it("publishBlog errors when the blog is not found", async () => {
      dbHolder.current = makeDbMock({ returning: [] });
      const r = await publishBlog("b1");
      expect(r.error).toMatch(/not found/i);
    });

    // Clears published_at on unpublish.
    it("unpublishBlog clears published_at", async () => {
      await unpublishBlog("b1");
      const set = dbHolder.current.calls.set[0];
      expect(set.status).toBe("draft");
      expect(set.publishedAt).toBeNull();
    });
  });

  describe("deleteBlog", () => {
    // Auth gate.
    it("rejects unauthorised callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      expect((await deleteBlog("b1")).error).toMatch(/not authenticated/i);
    });

    // Happy path — the action deletes the row (storage cleanup is async and
    // best-effort).
    it("deletes the blog and returns success", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ cover_image_url: null, content: null }]],
      });
      const result = await deleteBlog("b1");
      expect(result.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
    });
  });

  // submitCustomerBlog — the public-facing endpoint used by signed-in
  // users from /blogs/write. Inserts the row with status
  // pending_review, populated via the customer's profile name.
  // Selects: #1 the customer profile, #2 resolveSlug.
  describe("submitCustomerBlog", () => {
    beforeEach(() => {
      dbHolder.current = makeDbMock({
        returning: [{ id: "b1" }],
        selectQueue: [[ada], []],
      });
    });

    // Anonymous visitors are blocked from this action.
    it("rejects unauthenticated callers", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await submitCustomerBlog(customerForm);
      expect(result.error).toMatch(/sign in/i);
    });

    // Without a users row the action stops — a signed-in admin can't
    // accidentally hit this endpoint.
    it("rejects when customer profile is missing", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[]] });
      const result = await submitCustomerBlog(customerForm);
      expect(result.error).toMatch(/profile/i);
    });

    // Title, content, categories, tags are all required by validation.
    it("requires a title", async () => {
      const result = await submitCustomerBlog({ ...customerForm, title: " " });
      expect(result.error).toMatch(/title/i);
    });

    it("requires content", async () => {
      const result = await submitCustomerBlog({
        ...customerForm,
        content: " ",
      });
      expect(result.error).toMatch(/content/i);
    });

    it("requires at least one category when the store has categories", async () => {
      const result = await submitCustomerBlog({
        ...customerForm,
        categories: [],
      });
      expect(result.error).toMatch(/category/i);
    });

    it("requires at least one tag when the store has tags", async () => {
      const result = await submitCustomerBlog({ ...customerForm, tags: [] });
      expect(result.error).toMatch(/tag/i);
    });

    // Client input is untrusted — names outside the store's taxonomy are
    // dropped, and if nothing valid remains the submission is rejected.
    it("rejects when every submitted category is unknown to the store", async () => {
      const result = await submitCustomerBlog({
        ...customerForm,
        categories: ["Made Up"],
      });
      expect(result.error).toMatch(/category/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    it("drops unknown names but keeps valid ones", async () => {
      await submitCustomerBlog({
        ...customerForm,
        categories: ["Recipes", "Made Up"],
        tags: ["Indian Food", "Nope"],
      });
      const inserted = dbHolder.current.calls.values[0];
      expect(inserted.categories).toEqual(["Recipes"]);
      expect(inserted.tags).toEqual(["Indian Food"]);
    });

    // A store that has not defined any taxonomy doesn't block submissions on
    // the (hidden) pickers.
    it("allows empty categories/tags when the store defines none", async () => {
      vi.mocked(fetchBlogTaxonomy).mockResolvedValue({
        categories: [],
        tags: [],
      });
      const result = await submitCustomerBlog({
        ...customerForm,
        categories: [],
        tags: [],
      });
      expect(result.success).toBe(true);
      const inserted = dbHolder.current.calls.values[0];
      expect(inserted.categories).toEqual([]);
      expect(inserted.tags).toEqual([]);
    });

    // Happy path — inserts as pending_review with the user as submitter.
    it("inserts with status=pending_review and is_customer_submission=true", async () => {
      await submitCustomerBlog(customerForm);
      const inserted = dbHolder.current.calls.values[0];
      expect(inserted.status).toBe("pending_review");
      expect(inserted.isCustomerSubmission).toBe(true);
      expect(inserted.submittedBy).toBe("user-1");
      // Author name is composed from the customer's first + last name.
      expect(inserted.author).toBe("Ada Lovelace");
      // Approval flow ON (default): no service-scope promotion happens.
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    // Store setting: submissions switched off → the action refuses outright.
    it("rejects when the store has customer submissions disabled", async () => {
      vi.mocked(getStoreSettings).mockResolvedValueOnce(
        settingsWith({
          "blogs.customerSubmissions": false,
          "blogs.requireApproval": true,
        }),
      );
      const result = await submitCustomerBlog(customerForm);
      expect(result.error).toMatch(/disabled/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    // Store setting: approval flow off → the pending insert is promoted to
    // published via the service scope (RLS blocks customers from inserting
    // published rows directly).
    it("publishes immediately when the store does not require approval", async () => {
      vi.mocked(getStoreSettings).mockResolvedValueOnce(
        settingsWith({
          "blogs.customerSubmissions": true,
          "blogs.requireApproval": false,
        }),
      );
      const result = await submitCustomerBlog(customerForm);
      expect(result.success).toBe(true);

      // Insert still goes in as pending_review (RLS-compatible)…
      expect(dbHolder.current.calls.values[0].status).toBe("pending_review");

      // …then the service scope flips it live.
      const promote = dbHolder.current.calls.set[0];
      expect(promote.status).toBe("published");
      expect(promote.publishedAt).toBeTruthy();
    });
  });

  // approveCustomerBlog — admin-only. Flips pending_review → published and
  // emails the author.
  describe("approveCustomerBlog", () => {
    // Auth gate.
    it("rejects unauthorised callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await approveCustomerBlog("b1");
      expect(result.error).toMatch(/not authenticated/i);
    });

    // The author is told via the notification system, which needs the
    // customerId to know who to reach — without it the event has no audience.
    it("notifies the author after approval", async () => {
      dbHolder.current = makeDbMock({
        returning: [{ title: "T", slug: "t", submitted_by: "cust-1" }],
      });
      await approveCustomerBlog("b1");
      expect(emitted("blog.approved")).toBe(true);
      expect(vi.mocked(emitEvent).mock.calls.at(-1)?.[0]).toMatchObject({
        type: "blog.approved",
        customerId: "cust-1",
        payload: { title: "T", url: "/blogs/t" },
      });
    });

    // No matching pending row → a friendly error, no email.
    it("errors when the blog is no longer pending review", async () => {
      dbHolder.current = makeDbMock({ returning: [] });
      const result = await approveCustomerBlog("b1");
      expect(result.error).toMatch(/no longer pending/i);
      expect(emitted("blog.approved")).toBe(false);
    });
  });

  // rejectCustomerBlog — admin-only. Deletes the pending row and emails
  // the author with a rejection notice.
  describe("rejectCustomerBlog", () => {
    // Auth gate.
    it("rejects unauthorised callers", async () => {
      vi.mocked(getManagerIdentity).mockResolvedValue(null);
      const result = await rejectCustomerBlog("b1");
      expect(result.error).toMatch(/not authenticated/i);
    });

    // Verify the rejection email path triggers when there's a submitter.
    // Selects: #1 the pending row, #2 the author's contact.
    it("emails the author after rejection", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ title: "T", submitted_by: "cust-1" }],
          [{ email: "ada@example.com", firstName: "Ada" }],
        ],
      });
      await rejectCustomerBlog("b1");
      expect(emitted("blog.rejected")).toBe(true);
    });
  });

  // revertCustomerBlogToDraft — the author moves their own submission back
  // out of the review queue.
  describe("revertCustomerBlogToDraft", () => {
    // Anonymous visitors blocked.
    it("rejects unauthenticated callers", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await revertCustomerBlogToDraft("b1");
      expect(result.error).toMatch(/not authenticated/i);
    });

    // When no row matches the ownership + status filter the action fails
    // loudly (better than silently doing nothing).
    it("returns error when no matching pending row exists", async () => {
      dbHolder.current = makeDbMock({ returning: [] });
      const result = await revertCustomerBlogToDraft("b1");
      expect(result.error).toMatch(/couldn.?t move/i);
    });
  });

  // deleteCustomerBlog — author withdraws their own draft / pending row.
  describe("deleteCustomerBlog", () => {
    // Anonymous visitors blocked.
    it("rejects unauthenticated callers", async () => {
      vi.mocked(getServerUser).mockResolvedValue(null);
      const result = await deleteCustomerBlog("b1");
      expect(result.error).toMatch(/not authenticated/i);
    });

    // When no row is removed (e.g. it was already published or doesn't belong
    // to the caller) the action surfaces a friendly error.
    it("returns error when no row was removed", async () => {
      dbHolder.current = makeDbMock({ returning: [] });
      const result = await deleteCustomerBlog("b1");
      expect(result.error).toMatch(/couldn.?t delete/i);
    });
  });
});

// deleteUploadedImage — the customer editor prunes a cover it uploaded then
// replaced/removed before saving. Scoped to auth + the blog-covers/ folder so
// it can't be abused to delete other media.
describe("deleteUploadedImage", () => {
  const gcs = (path: string) => `https://storage.googleapis.com/bkt/${path}`;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerUser).mockResolvedValue({ id: "u1" } as any);
  });

  it("deletes a session cover under blog-covers/", async () => {
    await deleteUploadedImage(gcs("blog-covers/abc.webp"));
    expect(deleteStorageUrls).toHaveBeenCalledWith([
      gcs("blog-covers/abc.webp"),
    ]);
  });

  it("ignores media outside blog-covers/ (e.g. product images)", async () => {
    await deleteUploadedImage(gcs("products/x.webp"));
    expect(deleteStorageUrls).not.toHaveBeenCalled();
  });

  it("ignores non-GCS URLs", async () => {
    await deleteUploadedImage("https://cdn.other.com/blog-covers/x.webp");
    expect(deleteStorageUrls).not.toHaveBeenCalled();
  });

  it("does nothing for anonymous callers", async () => {
    vi.mocked(getServerUser).mockResolvedValue(null);
    await deleteUploadedImage(gcs("blog-covers/abc.webp"));
    expect(deleteStorageUrls).not.toHaveBeenCalled();
  });
});
