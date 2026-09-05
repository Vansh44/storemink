/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { hashMinkActionPayload } from "./action-integrity";
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

/**
 * Recover the literal text of a Drizzle `sql` template so a test can assert
 * WHICH row a raw `for update` statement locked. Only the string chunks are
 * needed — the interpolated ids are irrelevant to lock ordering.
 */
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
    return state.executeRows.shift() ?? { rows: [] };
  },
  select: () => chain(),
  insert: (table: any) => chain(getTableName(table), "insert"),
  update: (table: any) => chain(getTableName(table), "update"),
};

vi.mock("@/lib/db/client", () => ({
  withService: (fn: any) => fn(db),
}));

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const DRAFT_ID = "33333333-3333-4333-8333-333333333333";
const APPROVAL_ID = "44444444-4444-4444-8444-444444444444";
const AUDIT_ID = "55555555-5555-4555-8555-555555555555";
const PAGE_VERSION = "2026-09-04 12:00:00.123456+00";
const NEXT_VERSION = "2026-09-04 12:01:00.654321+00";
const SECTION = {
  id: "hero-code",
  type: "custom_code" as const,
  enabled: true,
  config: {
    html: '<section class="hero">Old</section>',
    css: ".hero { color: black; }",
    js: "",
    height_mode: "auto" as const,
    fixed_height: 400,
  },
};
const PROPOSED = {
  html: '<section class="hero">New</section>',
  css: ".hero { color: purple; }",
  js: "",
  height_mode: "auto" as const,
  fixed_height: 400,
};
const SECTION_DIGEST = digestMinkStorefrontValue(SECTION);
const PROPOSED_SECTION_DIGEST = digestMinkStorefrontValue({
  ...SECTION,
  config: PROPOSED,
});

function draft() {
  const shared = {
    page_slug: "home",
    section_id: SECTION.id,
    expected_page_version: PAGE_VERSION,
    expected_section_digest: SECTION_DIGEST,
    height_mode: "auto",
    fixed_height: "400",
    explanation: "Refresh the hero treatment.",
  };
  const proposalPatch = {
    schemaVersion: 1,
    operation: "replace_custom_code",
    target: {
      pageSlug: "home",
      sectionId: SECTION.id,
      expectedPageVersion: PAGE_VERSION,
      expectedSectionDigest: SECTION_DIGEST,
    },
    code: {
      html: PROPOSED.html,
      css: PROPOSED.css,
      js: PROPOSED.js,
      heightMode: PROPOSED.height_mode,
      fixedHeight: PROPOSED.fixed_height,
    },
  };
  return {
    id: DRAFT_ID,
    kind: "storefront_custom_code",
    status: "proposed",
    currentVersion: 0,
    before: {
      ...shared,
      patch_digest: digestMinkStorefrontValue(SECTION.config),
      html: SECTION.config.html,
      css: SECTION.config.css,
      js: SECTION.config.js,
    },
    content: {
      ...shared,
      patch_digest: digestMinkStorefrontValue(proposalPatch),
      html: PROPOSED.html,
      css: PROPOSED.css,
      js: PROPOSED.js,
    },
  };
}

function page(version = PAGE_VERSION) {
  return {
    id: PAGE_ID,
    slug: "",
    title: "Home",
    sections: [SECTION],
    updatedAt: version,
    settings: { features: { "pages.customCode": true } },
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

function actionValues(config: typeof PROPOSED, digest: string) {
  return {
    page_slug: "home",
    page_title: "Home",
    section_id: SECTION.id,
    section_digest: digest,
    html: config.html,
    css: config.css,
    js: config.js,
    height_mode: config.height_mode,
    fixed_height: String(config.fixed_height),
  };
}

function approvalRow(
  status: "pending" | "executed" = "pending",
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
) {
  const before = actionValues(SECTION.config, SECTION_DIGEST);
  const after = actionValues(PROPOSED, PROPOSED_SECTION_DIGEST);
  return {
    id: APPROVAL_ID,
    storeId: STORE_ID,
    adminId: "admin-1",
    draftId: DRAFT_ID,
    productId: null,
    resourceType: "storefront_section",
    resourceId: PAGE_ID,
    resourceVersion: PAGE_VERSION,
    resourceLabel: "Home · custom code",
    locationId: null,
    variantId: null,
    resultId: status === "executed" ? PAGE_ID : null,
    resultVersion: status === "executed" ? NEXT_VERSION : null,
    sourceApprovalId: null,
    toolName: "apply_storefront_code",
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

beforeEach(() => {
  state.selects = {};
  state.executeRows = [];
  state.locked = [];
  state.inserts = [];
  state.updates = [];
  state.updateReturns = {};
});

describe("Mink Phase 7C storefront draft actions", () => {
  it("creates a five-minute exact-target approval from an immutable proposal", async () => {
    state.selects.mink_drafts = [[draft()]];
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    state.selects.store_pages = [[page()]];

    const { previewMinkStorefrontCodeAction } =
      await import("./storefront-code-actions");
    const approval = await previewMinkStorefrontCodeAction({
      actor: actor(),
      draftId: DRAFT_ID,
      expectedDraftVersion: 0,
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
    });

    expect(approval).toMatchObject({
      toolName: "apply_storefront_code",
      operation: "apply",
      draftVersion: 0,
      resource: { type: "storefront_section", id: PAGE_ID },
      before: { section_digest: SECTION_DIGEST },
      after: { section_digest: PROPOSED_SECTION_DIGEST },
    });
    expect(Date.parse(approval.expiresAt) - Date.now()).toBeLessThanOrEqual(
      5 * 60 * 1_000,
    );
    const inserted = state.inserts.find(
      (entry) => entry.table === "mink_action_approvals",
    )?.values;
    expect(inserted).toMatchObject({
      storeId: STORE_ID,
      adminId: "admin-1",
      resourceType: "storefront_section",
      resourceId: PAGE_ID,
      resourceVersion: PAGE_VERSION,
      productId: null,
      locationId: null,
      variantId: null,
      resultId: null,
    });
  });

  it("fails closed when the per-store Builder draft-save gate is off", async () => {
    state.selects.mink_drafts = [[draft()]];
    state.selects.mink_action_tool_access = [[{ enabled: false }]];
    const { previewMinkStorefrontCodeAction } =
      await import("./storefront-code-actions");
    await expect(
      previewMinkStorefrontCodeAction({
        actor: actor(),
        draftId: DRAFT_ID,
        expectedDraftVersion: 0,
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
      }),
    ).rejects.toThrow(/not enabled/i);
    expect(state.selects.store_pages).toBeUndefined();
  });

  it("rejects a stale page checkpoint before creating an approval", async () => {
    state.selects.mink_drafts = [[draft()]];
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    state.selects.store_pages = [[page(NEXT_VERSION)]];
    const { previewMinkStorefrontCodeAction } =
      await import("./storefront-code-actions");
    await expect(
      previewMinkStorefrontCodeAction({
        actor: actor(),
        draftId: DRAFT_ID,
        expectedDraftVersion: 0,
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
      }),
    ).rejects.toThrow(/changed/i);
    expect(
      state.inserts.filter((entry) => entry.table === "mink_action_approvals"),
    ).toHaveLength(0);
  });

  it("rejects an actor without Builder Manage before database access", async () => {
    const { previewMinkStorefrontCodeAction } =
      await import("./storefront-code-actions");
    await expect(
      previewMinkStorefrontCodeAction({
        actor: actor({ permissions: { builder: ["view"] } }),
        draftId: DRAFT_ID,
        expectedDraftVersion: 0,
        idempotencyKey: "55555555-5555-4555-8555-555555555555",
      }),
    ).rejects.toThrow(/permission/i);
    expect(state.executeRows).toEqual([]);
    expect(state.inserts).toEqual([]);
  });

  it("saves only sections and actor identity, then records one audit", async () => {
    state.selects.mink_action_approvals = [[approvalRow()]];
    state.selects.mink_drafts = [[draft()]];
    state.selects.store_pages = [[page()]];
    state.executeRows = [
      { rows: [] },
      { rows: [{ enabled: true }] },
      { rows: [] },
      { rows: [] },
    ];
    state.updateReturns.store_pages = [
      [{ id: PAGE_ID, updatedAt: NEXT_VERSION }],
    ];
    state.updateReturns.mink_action_approvals = [[{ id: APPROVAL_ID }]];

    const { executeMinkStorefrontCodeAction } =
      await import("./storefront-code-actions");
    const result = await executeMinkStorefrontCodeAction({
      actor: actor(),
      draftId: DRAFT_ID,
      approvalId: APPROVAL_ID,
    });

    expect(result).toMatchObject({
      repeated: false,
      auditId: expect.any(String),
    });
    const pageUpdate = state.updates.find(
      (entry) => entry.table === "store_pages",
    )?.values;
    expect(Object.keys(pageUpdate).sort()).toEqual(["sections", "updatedBy"]);
    expect(pageUpdate.sections[0]).toEqual({ ...SECTION, config: PROPOSED });
    expect(pageUpdate).not.toHaveProperty("publishedSections");
    expect(pageUpdate).not.toHaveProperty("status");
    expect(pageUpdate).not.toHaveProperty("publishedAt");
    expect(
      state.inserts.filter((entry) => entry.table === "mink_action_audit"),
    ).toHaveLength(1);
  });

  // ★★ THE CANONICAL LOCK ORDER, AND THE REASON IT IS PINNED HERE.
  // Every Mink action phase takes its own approval row, then tool access, then
  // the draft, then the resource. Phase 7D's publication preview must lock THIS
  // approval as its source, so if either side reverses the approval/draft pair,
  // approving a save while a second tab reviews publication deadlocks and
  // Postgres aborts one of them. Nothing about the returned values changes when
  // the order is wrong, so only an ordering assertion can catch it.
  it("locks its approval before the draft, keeping one global order", async () => {
    state.selects.mink_action_approvals = [[approvalRow()]];
    state.selects.mink_drafts = [[draft()]];
    state.selects.store_pages = [[page()]];
    state.executeRows = [
      { rows: [] },
      { rows: [{ enabled: true }] },
      { rows: [] },
      { rows: [] },
    ];
    state.updateReturns.store_pages = [
      [{ id: PAGE_ID, updatedAt: NEXT_VERSION }],
    ];
    state.updateReturns.mink_action_approvals = [[{ id: APPROVAL_ID }]];

    const { executeMinkStorefrontCodeAction } =
      await import("./storefront-code-actions");
    await executeMinkStorefrontCodeAction({
      actor: actor(),
      draftId: DRAFT_ID,
      approvalId: APPROVAL_ID,
    });

    expect(state.locked).toEqual([
      "mink_action_approvals",
      "mink_action_tool_access",
      "mink_drafts",
      "store_pages",
    ]);
  });

  it("replays an executed approval without another page write or audit", async () => {
    state.selects.mink_action_approvals = [[approvalRow("executed")]];
    state.selects.mink_action_audit = [[{ id: AUDIT_ID }]];

    const { executeMinkStorefrontCodeAction } =
      await import("./storefront-code-actions");
    const result = await executeMinkStorefrontCodeAction({
      actor: actor(),
      draftId: DRAFT_ID,
      approvalId: APPROVAL_ID,
    });

    expect(result).toEqual(
      expect.objectContaining({
        repeated: true,
        auditId: AUDIT_ID,
      }),
    );
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  it("expires atomically and records one terminal audit without a page write", async () => {
    state.selects.mink_action_approvals = [
      [approvalRow("pending", new Date(Date.now() - 1_000).toISOString())],
    ];
    state.executeRows = [{ rows: [] }, { rows: [{ enabled: true }] }];

    const { executeMinkStorefrontCodeAction } =
      await import("./storefront-code-actions");
    await expect(
      executeMinkStorefrontCodeAction({
        actor: actor(),
        draftId: DRAFT_ID,
        approvalId: APPROVAL_ID,
      }),
    ).rejects.toThrow(/expired/i);

    expect(
      state.updates.find((entry) => entry.table === "mink_action_approvals")
        ?.values,
    ).toMatchObject({ status: "expired" });
    expect(
      state.inserts.find((entry) => entry.table === "mink_action_audit")
        ?.values,
    ).toMatchObject({ outcome: "expired", resultId: null });
    expect(
      state.updates.filter((entry) => entry.table === "store_pages"),
    ).toHaveLength(0);
  });
});
