/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDbMock } from "./_test-helpers";

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  // page-actions pulls in lib/settings/resolve → lib/store/resolve which
  // wraps reads at module load.
  unstable_cache: (fn: unknown) => fn,
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/site", () => ({
  getStoreOriginById: vi.fn(async () => "https://store-1.storemink.com"),
}));
vi.mock("@/lib/seo/store-indexing", () => ({
  notifyStoreContentPublished: vi.fn(),
}));
vi.mock("@/app/dashboard/lib/access", () => ({
  getManagerUserId: vi.fn(),
  getActingStoreId: vi.fn(async () => "store-1"),
}));
vi.mock("@/lib/settings/resolve", () => ({
  getStoreSetting: vi.fn(async () => true),
}));
vi.mock("@/lib/sanitize", () => ({
  sanitizeBlogContent: vi.fn((html: string) =>
    html.replace(/<script[\s\S]*?<\/script>/gi, ""),
  ),
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
  createPage,
  updatePageMeta,
  savePageDraft,
  publishPage,
  deletePage,
} from "./page-actions";
import { getManagerUserId } from "@/app/dashboard/lib/access";
import { getStoreSetting } from "@/lib/settings/resolve";

const richSection = (html = "<p>Hi</p>") => ({
  id: crypto.randomUUID(),
  type: "rich_text",
  enabled: true,
  config: { html, width: "contained" },
});

const codeSection = (id = crypto.randomUUID()) => ({
  id,
  type: "custom_code",
  enabled: true,
  config: {
    html: "<div>x</div>",
    css: "",
    js: "",
    height_mode: "auto",
    fixed_height: 320,
  },
});

// page-actions.ts — the website builder's write side. Everything runs in the
// SERVICE scope (the draft `sections` column is sealed from anon/authenticated
// at the DB layer), so getManagerUserId("builder") is the trust boundary and
// every query carries an explicit store_id filter.
describe("page-actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbHolder.current = makeDbMock({ returning: [{ id: "new" }] });
    vi.mocked(getManagerUserId).mockResolvedValue("user-1");
    vi.mocked(getStoreSetting).mockResolvedValue(true);
  });

  // Every action must fail closed without builder.manage — the service scope
  // bypasses RLS, so this app-layer gate is the only trust boundary.
  describe("auth gate", () => {
    it("rejects each mutation when unauthorised", async () => {
      vi.mocked(getManagerUserId).mockResolvedValue(null);
      expect((await createPage("about", "About")).error).toMatch(
        /not authenticated/i,
      );
      expect((await savePageDraft("p1", [])).error).toMatch(
        /not authenticated/i,
      );
      expect((await publishPage("p1")).error).toMatch(/not authenticated/i);
      expect((await deletePage("p1")).error).toMatch(/not authenticated/i);
    });
  });

  describe("createPage", () => {
    it("rejects a reserved slug", async () => {
      const r = await createPage("shop", "Shop");
      expect(r.error).toMatch(/reserved/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    it("rejects a duplicate slug", async () => {
      // Uniqueness pre-check finds an existing row.
      dbHolder.current = makeDbMock({ selectQueue: [[{ id: "existing" }]] });
      const r = await createPage("about", "About");
      expect(r.error).toMatch(/already exists/i);
      expect(dbHolder.current.calls.insert).toHaveLength(0);
    });

    it("inserts a normalised draft page scoped to the store", async () => {
      dbHolder.current = makeDbMock({
        returning: [{ id: "new" }],
        selectQueue: [[]], // slug is free
      });
      const r = await createPage("About-Us", "");
      expect(r.success).toBe(true);
      expect(r.data?.id).toBe("new");
      const insert = dbHolder.current.calls.values[0];
      expect(insert.slug).toBe("about-us");
      expect(insert.title).toBe("about-us"); // falls back to slug
      expect(insert.storeId).toBe("store-1");
      expect(insert.status).toBe("draft");
    });
  });

  describe("savePageDraft", () => {
    it("sanitizes rich_text before storing", async () => {
      dbHolder.current = makeDbMock({
        returning: [{ updated_at: "t1" }],
        selectQueue: [[{ slug: "about", updated_at: "t0" }]],
      });
      await savePageDraft("p1", [
        richSection("<p>Hi</p><script>evil()</script>"),
      ]);
      const update = dbHolder.current.calls.set[0];
      expect(update.sections[0].config.html).toContain("<p>Hi</p>");
      expect(update.sections[0].config.html).not.toContain("<script");
    });

    it("refuses newly-added custom_code when the store setting is off", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ slug: "about", updated_at: "t0", sections: [] }]],
      });
      vi.mocked(getStoreSetting).mockResolvedValue(false);
      const r = await savePageDraft("p1", [codeSection()]);
      expect(r.error).toMatch(/cannot be added or changed/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("keeps an unchanged custom_code section saveable after downgrade", async () => {
      const retained = codeSection("paid-section");
      dbHolder.current = makeDbMock({
        returning: [{ updated_at: "t1" }],
        selectQueue: [
          [{ slug: "about", updated_at: "t0", sections: [retained] }],
        ],
      });
      vi.mocked(getStoreSetting).mockResolvedValue(false);

      const r = await savePageDraft("p1", [retained, richSection()]);

      expect(r.success).toBe(true);
      expect(dbHolder.current.calls.set[0].sections[0]).toEqual(retained);
    });

    it("does not let a downgraded store edit retained custom code", async () => {
      const retained = codeSection("paid-section");
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ slug: "about", updated_at: "t0", sections: [retained] }],
        ],
      });
      vi.mocked(getStoreSetting).mockResolvedValue(false);

      const changed = {
        ...retained,
        config: { ...retained.config, html: "<div>changed</div>" },
      };
      const r = await savePageDraft("p1", [changed]);

      expect(r.error).toMatch(/cannot be added or changed/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("rejects a stale save (updated_at mismatch) with the stale flag", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [[{ slug: "about", updated_at: "t1" }]],
      });
      const r = await savePageDraft("p1", [richSection()], "t0");
      expect(r.error).toMatch(/changed somewhere else/i);
      expect(r.data?.stale).toBe(true);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("returns the fresh updated_at token (autosave round trip)", async () => {
      dbHolder.current = makeDbMock({
        returning: [{ updated_at: "t9" }],
        selectQueue: [[{ slug: "about", updated_at: "t9" }]],
      });
      const r = await savePageDraft("p1", [richSection()], "t9");
      expect(r.success).toBe(true);
      expect(r.data?.updated_at).toBe("t9");
    });

    it("saves INCOMPLETE sections (draft mode skips completeness)", async () => {
      dbHolder.current = makeDbMock({
        returning: [{ updated_at: "t1" }],
        selectQueue: [[{ slug: "about", updated_at: "t0" }]],
      });
      const r = await savePageDraft("p1", [
        {
          id: "half",
          type: "featured_products",
          enabled: true,
          config: { source: "manual", product_ids: [] }, // mid-edit state
        },
      ]);
      expect(r.success).toBe(true);
      expect(dbHolder.current.calls.update).toHaveLength(1);
    });
  });

  describe("publishPage", () => {
    it("copies the draft into published_sections and stamps published_at", async () => {
      dbHolder.current = makeDbMock({
        returning: [{ updated_at: "t1", published_at: "tp" }],
        selectQueue: [
          [{ slug: "about", sections: [richSection()], updated_at: "t0" }],
        ],
      });
      const r = await publishPage("p1");
      expect(r.success).toBe(true);
      const update = dbHolder.current.calls.set[0];
      expect(update.status).toBe("published");
      expect(update.publishedAt).toBeTruthy();
      expect(update.publishedSections).toHaveLength(1);
    });

    it("rejects a stale publish (token mismatch)", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ slug: "about", sections: [richSection()], updated_at: "t2" }],
        ],
      });
      const r = await publishPage("p1", "t1");
      expect(r.error).toMatch(/changed somewhere else/i);
      expect(r.data?.stale).toBe(true);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    // ★★ AN EMPTY CUSTOM-CODE BLOCK USED TO MAKE THE PAGE UNPUBLISHABLE.
    // Draft-mode autosave stores one happily, and once `pages.customCode`
    // lapses the builder locks it — so strict re-validation refused the whole
    // page and the retention logic below it, which exists to let such sections
    // stay, was never reached. Reported from production, where Mink's layout
    // proposal and the builder's own Publish button both dead-ended on it.
    const emptyCode = (id = "legacy-code") => ({
      id,
      type: "custom_code",
      enabled: true,
      config: {
        html: "",
        css: "",
        js: "",
        height_mode: "auto",
        fixed_height: 320,
      },
    });

    it("★★ publishes past a locked, unchanged, empty custom_code section", async () => {
      const stored = [emptyCode(), richSection()];
      dbHolder.current = makeDbMock({
        returning: [{ updated_at: "t1", published_at: "tp" }],
        selectQueue: [[{ slug: "about", sections: stored, updated_at: "t0" }]],
      });
      vi.mocked(getStoreSetting).mockResolvedValue(false);

      const r = await publishPage("p1");

      expect(r.success).toBe(true);
      // It is published as it stands, not silently dropped from the page.
      expect(dbHolder.current.calls.set[0].publishedSections).toHaveLength(2);
    });

    it("★ but still refuses it while the merchant CAN fix it", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [{ slug: "about", sections: [emptyCode()], updated_at: "t0" }],
        ],
      });
      vi.mocked(getStoreSetting).mockResolvedValue(true);

      const r = await publishPage("p1");

      expect(r.error).toMatch(/HTML, CSS or JavaScript/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("★ and the exemption reaches custom code only", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [
            {
              slug: "about",
              updated_at: "t0",
              sections: [
                emptyCode(),
                {
                  id: "half",
                  type: "featured_products",
                  enabled: true,
                  config: { source: "manual", product_ids: [] },
                },
              ],
            },
          ],
        ],
      });
      vi.mocked(getStoreSetting).mockResolvedValue(false);

      const r = await publishPage("p1");

      expect(r.error).toMatch(/at least one product/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });

    it("STRICTLY re-validates on publish (incomplete draft is rejected)", async () => {
      dbHolder.current = makeDbMock({
        selectQueue: [
          [
            {
              slug: "about",
              updated_at: "t0",
              sections: [
                {
                  id: "half",
                  type: "featured_products",
                  enabled: true,
                  config: { source: "manual", product_ids: [] },
                },
              ],
            },
          ],
        ],
      });
      const r = await publishPage("p1");
      expect(r.error).toMatch(/at least one product/i);
      expect(dbHolder.current.calls.update).toHaveLength(0);
    });
  });

  describe("deletePage", () => {
    it("refuses to delete the homepage sentinel", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ slug: "" }]] });
      const r = await deletePage("home");
      expect(r.error).toMatch(/homepage can't be deleted/i);
      expect(dbHolder.current.calls.delete).toHaveLength(0);
    });

    it("deletes a normal page scoped to the store", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ slug: "about" }]] });
      const r = await deletePage("p1");
      expect(r.success).toBe(true);
      expect(dbHolder.current.calls.delete).toHaveLength(1);
      expect(dbHolder.current.calls.where).toHaveLength(2);
    });
  });

  describe("updatePageMeta", () => {
    it("keeps the homepage sentinel slug immutable", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ slug: "" }]] });
      await updatePageMeta("home", { slug: "new-home", title: "Home" });
      const update = dbHolder.current.calls.set[0];
      expect(update.slug).toBeUndefined(); // slug change ignored for homepage
      expect(update.title).toBe("Home");
    });

    it("rejects renaming to a reserved slug", async () => {
      dbHolder.current = makeDbMock({ selectQueue: [[{ slug: "about" }]] });
      const r = await updatePageMeta("p1", { slug: "cart" });
      expect(r.error).toMatch(/reserved/i);
    });
  });
});
