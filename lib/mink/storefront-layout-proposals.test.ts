import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { EMPTY_CONFIG, type PageSectionItem } from "@/lib/sections/registry";
import type { MinkActorContext } from "./types";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  createDraft: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((run: (db: unknown) => unknown) =>
    run({ execute: mocks.execute }),
  ),
}));
vi.mock("./drafts", () => ({ createMinkDraftProposal: mocks.createDraft }));

import { digestMinkStorefrontSections } from "./storefront-layout-contract";
import {
  createMinkStorefrontLayoutProposal,
  readStoredLayoutSections,
  validateStoredLayoutProposal,
} from "./storefront-layout-proposals";

const VERSION = "2026-09-11 10:20:30.123456+00";
const DRAFT_ID = "11111111-1111-4111-8111-111111111111";

const section = (
  id: string,
  type: "rich_text" | "custom_code" = "rich_text",
  html = "<p>Hello</p>",
): PageSectionItem =>
  ({
    id,
    type,
    enabled: true,
    config: { ...EMPTY_CONFIG[type], html },
  }) as PageSectionItem;

const CURRENT = [section("a"), section("b")];

const ACTOR: MinkActorContext = {
  storeId: "store-1",
  adminId: "admin-1",
  email: "owner@example.com",
  roleSlug: "designer",
  permissions: { builder: ["view", "manage"] },
  isSuperadmin: false,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request-1",
  runId: "run-1",
  draftingEnabled: true,
};

function targetRow(overrides: Record<string, unknown> = {}) {
  return {
    title: "Home",
    slug: "",
    sections: CURRENT,
    updated_at: VERSION,
    ...overrides,
  };
}

function patch(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    operation: "replace_page_sections",
    target: {
      pageSlug: "home",
      expectedPageVersion: VERSION,
      expectedSectionsDigest: digestMinkStorefrontSections(CURRENT),
    },
    sections: [section("a"), section("c", "rich_text", "<p>New</p>")],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockResolvedValue({ rows: [targetRow()] });
  mocks.createDraft.mockResolvedValue({
    type: "proposal",
    draftId: DRAFT_ID,
    title: "Layout for Home",
    destinationLabel: "Home · layout",
    expectedCredits: 3,
    chargedCredits: 3,
    creditSource: "plan",
  });
});

describe("Phase 9B storefront layout proposals", () => {
  it("stores a bounded private proposal only after an exact tenant-scoped checkpoint match", async () => {
    const result = await createMinkStorefrontLayoutProposal({
      actor: ACTOR,
      patch: patch(),
      explanation: "Replace the second block with a fresh introduction.",
    });

    expect(result).toMatchObject({
      type: "storefront_layout_proposal",
      draftId: DRAFT_ID,
      status: "private_preview",
      expectedCredits: 3,
      sectionCount: 2,
      summary: {
        kept: [{ id: "a", type: "rich_text" }],
        added: [{ id: "c", type: "rich_text" }],
        removed: [{ id: "b", type: "rich_text" }],
        reordered: false,
      },
    });
    // The stored rows carry the sections; the artifact must not, or a whole
    // page's config would be replayed through conversation history.
    expect(result).not.toHaveProperty("sections");
    expect(mocks.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "storefront_layout",
        destinationType: "storefront_page",
        destinationPath: "/dashboard/builder?page=home",
      }),
    );

    // The homepage sentinel is the empty slug, and the store id must reach the
    // query as a bound parameter rather than interpolated text.
    const compiled = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]);
    expect(compiled.params).toContain(ACTOR.storeId);
    expect(compiled.params).toContain("");
    expect(compiled.sql).not.toContain(ACTOR.storeId);
  });

  it("refuses a stale page before charging a single credit", async () => {
    await expect(
      createMinkStorefrontLayoutProposal({
        actor: ACTOR,
        patch: {
          ...patch(),
          target: {
            ...patch().target,
            expectedPageVersion: "2026-09-11 10:20:31.000000+00",
          },
        },
        explanation: "Stale page version.",
      }),
    ).rejects.toThrow("changed");

    await expect(
      createMinkStorefrontLayoutProposal({
        actor: ACTOR,
        patch: {
          ...patch(),
          target: { ...patch().target, expectedSectionsDigest: "b".repeat(64) },
        },
        explanation: "Stale section digest.",
      }),
    ).rejects.toThrow("changed");
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("refuses a layout that would drop or edit the merchant's custom code", async () => {
    const withCode = [section("a"), section("code", "custom_code", "<b>x</b>")];
    mocks.execute.mockResolvedValue({
      rows: [targetRow({ sections: withCode })],
    });
    const target = {
      pageSlug: "home",
      expectedPageVersion: VERSION,
      expectedSectionsDigest: digestMinkStorefrontSections(withCode),
    };

    await expect(
      createMinkStorefrontLayoutProposal({
        actor: ACTOR,
        patch: { ...patch(), target, sections: [section("a")] },
        explanation: "Silently drops the custom code.",
      }),
    ).rejects.toThrow(/custom code/i);

    await expect(
      createMinkStorefrontLayoutProposal({
        actor: ACTOR,
        patch: {
          ...patch(),
          target,
          sections: [section("a"), section("code", "custom_code", "<b>y</b>")],
        },
        explanation: "Rewrites the custom code.",
      }),
    ).rejects.toThrow(/custom code/i);
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("refuses a no-op, so a merchant is never charged for an unchanged page", async () => {
    await expect(
      createMinkStorefrontLayoutProposal({
        actor: ACTOR,
        patch: { ...patch(), sections: CURRENT },
        explanation: "Identical layout.",
      }),
    ).rejects.toThrow("identical");
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("refuses without Builder Manage or drafting, before reading store data", async () => {
    await expect(
      createMinkStorefrontLayoutProposal({
        actor: { ...ACTOR, permissions: { builder: ["view"] } },
        patch: patch(),
        explanation: "No manage permission.",
      }),
    ).rejects.toThrow("permission");
    await expect(
      createMinkStorefrontLayoutProposal({
        actor: { ...ACTOR, draftingEnabled: false },
        patch: patch(),
        explanation: "Drafting off.",
      }),
    ).rejects.toThrow("not enabled");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("re-validates a stored proposal and refuses a tampered digest", async () => {
    const sections = [section("a"), section("c", "rich_text", "<p>New</p>")];
    const content = {
      page_slug: "home",
      expected_page_version: VERSION,
      expected_sections_digest: digestMinkStorefrontSections(CURRENT),
      patch_digest: "",
      sections_json: JSON.stringify(sections),
      explanation: "Stored.",
    };
    const read = validateStoredLayoutProposal({ ...content, patch_digest: "" });
    expect(read.sections).toHaveLength(2);
    expect(read.target.pageSlug).toBe("home");

    expect(() =>
      validateStoredLayoutProposal({
        ...content,
        patch_digest: "f".repeat(64),
      }),
    ).toThrow("integrity");
    expect(() =>
      validateStoredLayoutProposal({ ...content, sections_json: "not json" }),
    ).toThrow("unreadable");
  });

  it("reads a `before` snapshot leniently and a proposal strictly", () => {
    // A merchant mid-edit can hold a section the publish validator refuses.
    // Refusing to READ it would make every approval impossible for exactly
    // those stores; refusing to WRITE it is the point.
    const incomplete = [section("a", "rich_text", "")];
    const snapshot = { sections_json: JSON.stringify(incomplete) };
    expect(readStoredLayoutSections(snapshot, "draft")).toHaveLength(1);
    expect(() => readStoredLayoutSections(snapshot, "publish")).toThrow(
      "no longer valid",
    );
  });
  it("resolves a kept custom-code section from the page, not from the caller", async () => {
    // The end-to-end reason the reference form exists: a page with custom code
    // is proposable at all only because the server carries that section across
    // itself. Sending it back byte-for-byte is not an option — the Builder read
    // never shows its source.
    const code = section("code", "custom_code", "<b>secret</b>");
    const withCode = [section("a"), code];
    mocks.execute.mockResolvedValue({
      rows: [targetRow({ sections: withCode })],
    });

    const result = await createMinkStorefrontLayoutProposal({
      actor: ACTOR,
      patch: {
        ...patch(),
        target: {
          pageSlug: "home",
          expectedPageVersion: VERSION,
          expectedSectionsDigest: digestMinkStorefrontSections(withCode),
        },
        sections: [
          { id: "code", keep: true },
          section("d", "rich_text", "<p>Added below</p>"),
        ],
      },
      explanation: "Keep the code block and add an introduction under it.",
    });

    expect(result.summary).toMatchObject({
      kept: [{ id: "code", type: "custom_code" }],
      added: [{ id: "d", type: "rich_text" }],
      removed: [{ id: "a", type: "rich_text" }],
    });
    expect(mocks.createDraft).toHaveBeenCalledOnce();
  });

  it("refuses a keep reference to a section that is not on the page", async () => {
    await expect(
      createMinkStorefrontLayoutProposal({
        actor: ACTOR,
        patch: { ...patch(), sections: [{ id: "ghost", keep: true }] },
        explanation: "Keeps something that does not exist.",
      }),
    ).rejects.toThrow(/no section with id/i);
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });
});
