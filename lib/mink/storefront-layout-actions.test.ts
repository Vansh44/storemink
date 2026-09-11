/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { EMPTY_CONFIG, type PageSectionItem } from "@/lib/sections/registry";
import { hashMinkActionPayload } from "./action-integrity";
import {
  digestMinkStorefrontSections,
  validateMinkStorefrontLayoutPatch,
} from "./storefront-layout-contract";
import { digestMinkStorefrontValue } from "./storefront-code-contract";

const state = vi.hoisted(() => ({
  selects: {} as Record<string, any[][]>,
  executeRows: [] as any[],
  inserts: [] as Array<{ table: string; values: any }>,
  updates: [] as Array<{ table: string; values: any }>,
  updateReturns: {} as Record<string, any[][]>,
  /** Tables locked with `for update`, in acquisition order. */
  locked: [] as string[],
}));

function lockedTable(query: any): string | null {
  const text = ((query?.queryChunks ?? []) as any[])
    .map((chunk) => (Array.isArray(chunk?.value) ? chunk.value.join("") : ""))
    .join(" ")
    .replace(/\s+/g, " ");
  if (!/for update/i.test(text)) return null;
  return /from\s+public\.([a-z_]+)/i.exec(text)?.[1] ?? "unknown";
}

function take(queue: any[][] | undefined) {
  if (!queue?.length) return [];
  return queue.length === 1 ? queue[0] : queue.shift();
}

function chain(
  tableName = "",
  mode: "select" | "update" | "insert" = "select",
) {
  let table = tableName;
  let values: any = {};
  const proxy: any = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") {
          return (resolve: (value: any) => void) =>
            resolve(
              mode === "select"
                ? take(state.selects[table])
                : mode === "update"
                  ? take(state.updateReturns[table])
                  : [
                      {
                        status: "pending",
                        resultId: null,
                        resultVersion: null,
                        approvedAt: null,
                        executedAt: null,
                        ...values,
                      },
                    ],
            );
        }
        return (...args: any[]) => {
          if (property === "from" && args[0]) table = getTableName(args[0]);
          if (property === "values") {
            values = args[0];
            state.inserts.push({ table, values });
          }
          if (property === "set") {
            values = args[0];
            state.updates.push({ table, values });
          }
          return proxy;
        };
      },
    },
  );
  return proxy;
}

const db = {
  execute: async (query: any) => {
    const table = lockedTable(query);
    if (table) state.locked.push(table);
    // Routed BY TABLE, not positionally: `for update` lock statements share
    // this path, so a positional queue would hand the gate's answer to
    // whichever lock happened to run first.
    if (table === "mink_action_tool_access") {
      return { rows: take(state.selects.mink_action_tool_access) };
    }
    return state.executeRows.shift() ?? { rows: [] };
  },
  select: () => chain(),
  insert: (table: any) => chain(getTableName(table), "insert"),
  update: (table: any) => chain(getTableName(table), "update"),
};

vi.mock("@/lib/db/client", () => ({ withService: (fn: any) => fn(db) }));

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const DRAFT_ID = "33333333-3333-4333-8333-333333333333";
const APPROVAL_ID = "44444444-4444-4444-8444-444444444444";
const PAGE_VERSION = "2026-09-11 12:00:00.123456+00";
const NEXT_VERSION = "2026-09-11 12:01:00.654321+00";

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
const PROPOSED = [section("a"), section("c", "rich_text", "<p>New</p>")];
const CURRENT_DIGEST = digestMinkStorefrontSections(CURRENT);
const PROPOSED_DIGEST = digestMinkStorefrontSections(PROPOSED);

/** The digest the proposal module stores: over the VALIDATED patch. */
function patchDigest(
  target: {
    page_slug: string;
    expected_page_version: string;
    expected_sections_digest: string;
  },
  sections: PageSectionItem[],
) {
  const validated = validateMinkStorefrontLayoutPatch({
    schemaVersion: 1,
    operation: "replace_page_sections",
    target: {
      pageSlug: target.page_slug,
      expectedPageVersion: target.expected_page_version,
      expectedSectionsDigest: target.expected_sections_digest,
    },
    sections,
  });
  if (!validated.ok) throw new Error(validated.issues.join(" "));
  return digestMinkStorefrontValue(validated.value);
}

function draft() {
  const shared = {
    page_slug: "home",
    expected_page_version: PAGE_VERSION,
    expected_sections_digest: CURRENT_DIGEST,
    explanation: "Swap the second block for a fresh introduction.",
  };
  return {
    id: DRAFT_ID,
    kind: "storefront_layout",
    status: "proposed",
    currentVersion: 0,
    before: {
      ...shared,
      patch_digest: CURRENT_DIGEST,
      sections_json: JSON.stringify(CURRENT),
    },
    content: {
      ...shared,
      patch_digest: patchDigest(shared, PROPOSED),
      sections_json: JSON.stringify(PROPOSED),
    },
  };
}

function page(version = PAGE_VERSION, sections = CURRENT) {
  return {
    id: PAGE_ID,
    slug: "",
    title: "Home",
    sections,
    updatedAt: version,
  };
}

function actor(overrides: Record<string, unknown> = {}) {
  return {
    storeId: STORE_ID,
    adminId: "admin-1",
    isSuperadmin: false,
    draftingEnabled: true,
    effectivePlan: "pro",
    permissions: { builder: ["manage"] },
    ...overrides,
  } as any;
}

function actionValues(digest: string, count: number) {
  return {
    page_slug: "home",
    page_title: "Home",
    sections_digest: digest,
    section_count: String(count),
  };
}

function approvalRow(
  status: "pending" | "executed" = "pending",
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
) {
  const before = actionValues(CURRENT_DIGEST, CURRENT.length);
  const after = actionValues(PROPOSED_DIGEST, PROPOSED.length);
  return {
    id: APPROVAL_ID,
    storeId: STORE_ID,
    adminId: "admin-1",
    draftId: DRAFT_ID,
    productId: null,
    resourceType: "storefront_page",
    resourceId: PAGE_ID,
    resourceVersion: PAGE_VERSION,
    resourceLabel: "Home · layout",
    locationId: null,
    variantId: null,
    resultId: status === "executed" ? PAGE_ID : null,
    resultVersion: status === "executed" ? NEXT_VERSION : null,
    sourceApprovalId: null,
    toolName: "apply_storefront_layout",
    operation: "apply",
    status,
    draftVersion: 0,
    productVersion: null,
    beforeJson: before,
    afterJson: after,
    requestHash: hashMinkActionPayload({
      storeId: STORE_ID,
      adminId: "admin-1",
      draftId: DRAFT_ID,
      draftVersion: 0,
      resourceId: PAGE_ID,
      resourceVersion: PAGE_VERSION,
      before,
      after,
      toolVersion: 1,
    }),
    idempotencyKey: "55555555-5555-4555-8555-555555555555",
    expiresAt,
    approvedAt: status === "executed" ? NEXT_VERSION : null,
    executedAt: status === "executed" ? NEXT_VERSION : null,
  };
}

function armExecute(overrides: { page?: any; approval?: any } = {}) {
  state.selects.mink_action_approvals = [[overrides.approval ?? approvalRow()]];
  state.selects.mink_action_tool_access = [[{ enabled: true }]];
  state.selects.mink_drafts = [[draft()]];
  state.selects.store_pages = [[overrides.page ?? page()]];
  state.updateReturns.store_pages = [
    [{ id: PAGE_ID, updatedAt: NEXT_VERSION }],
  ];
  state.updateReturns.mink_action_approvals = [[{ id: APPROVAL_ID }]];
}

beforeEach(() => {
  state.selects = {};
  state.executeRows = [];
  state.locked = [];
  state.inserts = [];
  state.updates = [];
  state.updateReturns = {};
});

describe("Mink Phase 9B storefront layout actions", () => {
  it("creates a five-minute exact-page approval bound to both list digests", async () => {
    state.selects.mink_drafts = [[draft()]];
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    state.selects.store_pages = [[page()]];

    const { previewMinkStorefrontLayoutAction } =
      await import("./storefront-layout-actions");
    const approval = await previewMinkStorefrontLayoutAction({
      actor: actor(),
      draftId: DRAFT_ID,
      expectedDraftVersion: 0,
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
    });

    expect(approval).toMatchObject({
      toolName: "apply_storefront_layout",
      operation: "apply",
      draftVersion: 0,
      resource: { type: "storefront_page", id: PAGE_ID },
      before: { sections_digest: CURRENT_DIGEST, section_count: "2" },
      after: { sections_digest: PROPOSED_DIGEST, section_count: "2" },
      summary: {
        added: [{ id: "c", type: "rich_text" }],
        removed: [{ id: "b", type: "rich_text" }],
      },
    });
    expect(Date.parse(approval.expiresAt) - Date.now()).toBeLessThanOrEqual(
      5 * 60 * 1_000,
    );
    const inserted = state.inserts.find(
      (entry) => entry.table === "mink_action_approvals",
    )?.values;
    expect(inserted).toMatchObject({
      resourceType: "storefront_page",
      resourceId: PAGE_ID,
      resourceVersion: PAGE_VERSION,
      productId: null,
      locationId: null,
      variantId: null,
      resultId: null,
      sourceApprovalId: null,
    });
    // The approval must NOT carry the section lists: 128 KB per side, of
    // content the draft already holds twice.
    expect(JSON.stringify(inserted.beforeJson)).not.toContain("rich_text");
  });

  it("fails closed when the per-store layout-save gate is off, before reading the page", async () => {
    state.selects.mink_drafts = [[draft()]];
    state.selects.mink_action_tool_access = [[{ enabled: false }]];
    const { previewMinkStorefrontLayoutAction } =
      await import("./storefront-layout-actions");
    await expect(
      previewMinkStorefrontLayoutAction({
        actor: actor(),
        draftId: DRAFT_ID,
        expectedDraftVersion: 0,
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
      }),
    ).rejects.toThrow(/not enabled/i);
    expect(state.selects.store_pages).toBeUndefined();
  });

  it("refuses without drafting or Builder Manage, before touching the database", async () => {
    const { previewMinkStorefrontLayoutAction } =
      await import("./storefront-layout-actions");
    for (const override of [
      { draftingEnabled: false },
      { permissions: { builder: ["view"] } },
    ]) {
      await expect(
        previewMinkStorefrontLayoutAction({
          actor: actor(override),
          draftId: DRAFT_ID,
          expectedDraftVersion: 0,
          idempotencyKey: "55555555-5555-4555-8555-555555555555",
        }),
      ).rejects.toThrow(/permission/i);
    }
    expect(state.locked).toEqual([]);
  });

  it("writes only sections, never publication state, and audits the change", async () => {
    armExecute();
    const { executeMinkStorefrontLayoutAction } =
      await import("./storefront-layout-actions");
    const result = await executeMinkStorefrontLayoutAction({
      actor: actor(),
      draftId: DRAFT_ID,
      approvalId: APPROVAL_ID,
    });

    expect(result.repeated).toBe(false);
    expect(result.approval.status).toBe("executed");

    const pageUpdate = state.updates.find(
      (entry) => entry.table === "store_pages",
    )?.values;
    // ★★ THE WHOLE POINT OF THE PHASE: a DRAFT save. `published_sections`,
    //    `status` and `published_at` must be absent from this statement.
    expect(Object.keys(pageUpdate).sort()).toEqual(["sections", "updatedBy"]);
    expect(pageUpdate.sections).toEqual(PROPOSED);

    const audit = state.inserts.find(
      (entry) => entry.table === "mink_action_audit",
    )?.values;
    expect(audit).toMatchObject({
      resourceType: "storefront_page",
      toolName: "apply_storefront_layout",
      outcome: "executed",
      resourceVersionBefore: PAGE_VERSION,
      resourceVersionAfter: NEXT_VERSION,
    });
    expect(audit.detail).toContain("1 added");
    expect(audit.detail).toContain("1 removed");

    // Locks are taken in a fixed order: approval, then draft, then page.
    expect(state.locked).toEqual([
      "mink_action_approvals",
      "mink_action_tool_access",
      "mink_drafts",
      "store_pages",
    ]);
  });

  it("replays an executed approval without writing a second time", async () => {
    state.selects.mink_action_approvals = [[approvalRow("executed")]];
    state.selects.mink_action_audit = [[{ id: "audit-1" }]];
    state.selects.mink_drafts = [[draft()]];
    const { executeMinkStorefrontLayoutAction } =
      await import("./storefront-layout-actions");
    const result = await executeMinkStorefrontLayoutAction({
      actor: actor(),
      draftId: DRAFT_ID,
      approvalId: APPROVAL_ID,
    });
    expect(result).toMatchObject({ repeated: true, auditId: "audit-1" });
    expect(
      state.updates.find((e) => e.table === "store_pages"),
    ).toBeUndefined();
  });

  it("conflicts instead of writing when the page moved after preview", async () => {
    armExecute({ page: page(NEXT_VERSION) });
    const { executeMinkStorefrontLayoutAction } =
      await import("./storefront-layout-actions");
    await expect(
      executeMinkStorefrontLayoutAction({
        actor: actor(),
        draftId: DRAFT_ID,
        approvalId: APPROVAL_ID,
      }),
    ).rejects.toThrow(/changed/i);
    expect(
      state.updates.find((e) => e.table === "store_pages"),
    ).toBeUndefined();
    expect(
      state.inserts.find((e) => e.table === "mink_action_audit")?.values,
    ).toMatchObject({ outcome: "conflicted", resultId: null });
  });

  it("conflicts on an expired approval rather than saving late", async () => {
    armExecute({
      approval: approvalRow(
        "pending",
        new Date(Date.now() - 1_000).toISOString(),
      ),
    });
    const { executeMinkStorefrontLayoutAction } =
      await import("./storefront-layout-actions");
    await expect(
      executeMinkStorefrontLayoutAction({
        actor: actor(),
        draftId: DRAFT_ID,
        approvalId: APPROVAL_ID,
      }),
    ).rejects.toThrow(/expired/i);
    expect(
      state.updates.find((e) => e.table === "store_pages"),
    ).toBeUndefined();
    expect(
      state.inserts.find((e) => e.table === "mink_action_audit")?.values,
    ).toMatchObject({ outcome: "expired" });
  });

  it("refuses to write a layout that no longer preserves the page's custom code", async () => {
    // The page still hashes to what was approved, so only the dedicated guard
    // stands between an approved list and the merchant's own code vanishing.
    const withCode = [section("a"), section("code", "custom_code", "<b>x</b>")];
    const codeDraft = draft();
    codeDraft.before.sections_json = JSON.stringify(withCode);
    codeDraft.before.expected_sections_digest =
      digestMinkStorefrontSections(withCode);
    codeDraft.content.expected_sections_digest =
      digestMinkStorefrontSections(withCode);
    codeDraft.content.patch_digest = patchDigest(codeDraft.content, PROPOSED);

    const before = actionValues(
      digestMinkStorefrontSections(withCode),
      withCode.length,
    );
    const after = actionValues(PROPOSED_DIGEST, PROPOSED.length);
    const approval = {
      ...approvalRow(),
      beforeJson: before,
      afterJson: after,
      requestHash: hashMinkActionPayload({
        storeId: STORE_ID,
        adminId: "admin-1",
        draftId: DRAFT_ID,
        draftVersion: 0,
        resourceId: PAGE_ID,
        resourceVersion: PAGE_VERSION,
        before,
        after,
        toolVersion: 1,
      }),
    };
    state.selects.mink_action_approvals = [[approval]];
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    state.selects.mink_drafts = [[codeDraft]];
    state.selects.store_pages = [[page(PAGE_VERSION, withCode)]];

    const { executeMinkStorefrontLayoutAction } =
      await import("./storefront-layout-actions");
    await expect(
      executeMinkStorefrontLayoutAction({
        actor: actor(),
        draftId: DRAFT_ID,
        approvalId: APPROVAL_ID,
      }),
    ).rejects.toThrow(/changed/i);
    expect(
      state.updates.find((e) => e.table === "store_pages"),
    ).toBeUndefined();
    expect(
      state.inserts.find((e) => e.table === "mink_action_audit")?.values.detail,
    ).toContain("custom code");
  });

  it("refuses an approval whose request hash was tampered with", async () => {
    armExecute({ approval: { ...approvalRow(), requestHash: "f".repeat(64) } });
    const { executeMinkStorefrontLayoutAction } =
      await import("./storefront-layout-actions");
    await expect(
      executeMinkStorefrontLayoutAction({
        actor: actor(),
        draftId: DRAFT_ID,
        approvalId: APPROVAL_ID,
      }),
    ).rejects.toThrow(/integrity/i);
    expect(
      state.updates.find((e) => e.table === "store_pages"),
    ).toBeUndefined();
  });
});
