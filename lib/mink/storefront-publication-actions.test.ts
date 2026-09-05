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

vi.mock("@/lib/db/client", () => ({ withService: (fn: any) => fn(db) }));

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const DRAFT_ID = "33333333-3333-4333-8333-333333333333";
const SAVE_APPROVAL_ID = "44444444-4444-4444-8444-444444444444";
const PUBLISH_APPROVAL_ID = "55555555-5555-4555-8555-555555555555";
const AUDIT_ID = "66666666-6666-4666-8666-666666666666";
const ROLLBACK_APPROVAL_ID = "77777777-7777-4777-8777-777777777770";
const PRE_SAVE_VERSION = "2026-09-04 12:00:00.123456+00";
const SAVE_VERSION = "2026-09-04 12:01:00.654321+00";
const PUBLISH_VERSION = "2026-09-04 12:02:00.111111+00";
const ROLLBACK_VERSION = "2026-09-04 12:03:00.222222+00";
const PUBLISHED_AT = "2026-09-04 11:00:00.123456+00";
const NEW_PUBLISHED_AT = "2026-09-04T12:02:00.000Z";
const OLD_SECTION = {
  id: "hero-code",
  type: "custom_code" as const,
  enabled: true,
  config: {
    html: '<section class="hero"><h2>Old</h2></section>',
    css: ".hero { color: black; }",
    js: "",
    height_mode: "auto" as const,
    fixed_height: 400,
  },
};
const NEW_SECTION = {
  ...OLD_SECTION,
  config: {
    ...OLD_SECTION.config,
    html: '<section class="hero"><h2>New</h2><button type="button">Shop now</button></section>',
    css: ".hero { color: purple; max-width: 100%; }",
  },
};
const OLD_DIGEST = digestMinkStorefrontValue(OLD_SECTION);
const PATCH_DIGEST = digestMinkStorefrontValue({
  schemaVersion: 1,
  operation: "replace_custom_code",
  target: {
    pageSlug: "home",
    sectionId: OLD_SECTION.id,
    expectedPageVersion: PRE_SAVE_VERSION,
    expectedSectionDigest: OLD_DIGEST,
  },
  code: {
    html: NEW_SECTION.config.html,
    css: NEW_SECTION.config.css,
    js: NEW_SECTION.config.js,
    heightMode: NEW_SECTION.config.height_mode,
    fixedHeight: NEW_SECTION.config.fixed_height,
  },
});

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

function draft() {
  const shared = {
    page_slug: "home",
    section_id: OLD_SECTION.id,
    expected_page_version: PRE_SAVE_VERSION,
    expected_section_digest: OLD_DIGEST,
    height_mode: "auto",
    fixed_height: "400",
    explanation: "Refresh the hero.",
  };
  return {
    id: DRAFT_ID,
    kind: "storefront_custom_code",
    status: "proposed",
    currentVersion: 0,
    before: {
      ...shared,
      patch_digest: digestMinkStorefrontValue(OLD_SECTION.config),
      html: OLD_SECTION.config.html,
      css: OLD_SECTION.config.css,
      js: OLD_SECTION.config.js,
    },
    content: {
      ...shared,
      patch_digest: PATCH_DIGEST,
      html: NEW_SECTION.config.html,
      css: NEW_SECTION.config.css,
      js: NEW_SECTION.config.js,
    },
  };
}

function page(version = SAVE_VERSION) {
  return {
    id: PAGE_ID,
    slug: "",
    title: "Home",
    status: "published",
    sections: [NEW_SECTION],
    publishedSections: [OLD_SECTION],
    publishedAt: PUBLISHED_AT,
    updatedAt: version,
    settings: { features: { "pages.customCode": true } },
  };
}

function publishedNewPage() {
  return {
    ...page(PUBLISH_VERSION),
    publishedSections: [NEW_SECTION],
    publishedAt: "2026-09-04 12:02:00+00",
  };
}

function draftSaveValues(section: typeof NEW_SECTION) {
  return {
    page_slug: "home",
    page_title: "Home",
    section_id: section.id,
    section_digest: digestMinkStorefrontValue(section),
    html: section.config.html,
    css: section.config.css,
    js: section.config.js,
    height_mode: section.config.height_mode,
    fixed_height: String(section.config.fixed_height),
  };
}

function saveApproval() {
  return {
    id: SAVE_APPROVAL_ID,
    storeId: STORE_ID,
    adminId: "admin-1",
    draftId: DRAFT_ID,
    productId: null,
    resourceType: "storefront_section",
    resourceId: PAGE_ID,
    resourceVersion: PRE_SAVE_VERSION,
    resourceLabel: "Home · custom code",
    locationId: null,
    variantId: null,
    resultId: PAGE_ID,
    resultVersion: SAVE_VERSION,
    sourceApprovalId: null,
    toolName: "apply_storefront_code",
    operation: "apply",
    status: "executed",
    draftVersion: 0,
    productVersion: null,
    beforeJson: draftSaveValues(OLD_SECTION),
    afterJson: draftSaveValues(NEW_SECTION),
    requestHash: "a".repeat(64),
    idempotencyKey: "77777777-7777-4777-8777-777777777777",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    approvedAt: SAVE_VERSION,
    executedAt: SAVE_VERSION,
  };
}

function evidence() {
  const viewport = (name: "desktop" | "mobile", width: number) => ({
    viewport: name,
    width,
    passed: true,
    issues: [],
    runtimeErrorCount: 0,
    cspViolationCount: 0,
    horizontalOverflow: false,
  });
  return {
    schemaVersion: 1,
    patchDigest: PATCH_DIGEST,
    checkedAt: new Date().toISOString(),
    browser: { family: "chromium", major: 140, supported: true },
    viewports: {
      desktop: viewport("desktop", 1280),
      mobile: viewport("mobile", 390),
    },
  };
}

function snapshot(
  source: "old" | "new",
  browserValidation: ReturnType<typeof evidence> | null,
) {
  const sections = source === "old" ? [OLD_SECTION] : [NEW_SECTION];
  const target = sections[0];
  return {
    schema_version: 1,
    page_slug: "home",
    page_title: "Home",
    page_status: "published",
    published_at: source === "old" ? PUBLISHED_AT : null,
    sections_digest: digestMinkStorefrontValue(sections),
    target_section_id: OLD_SECTION.id,
    target_section_digest: digestMinkStorefrontValue(target),
    sections,
    browser_validation: browserValidation,
  };
}

function publicationApproval(
  status: "pending" | "executed" = "pending",
  operation: "apply" | "rollback" = "apply",
) {
  const before = snapshot("old", null);
  const after = snapshot("new", operation === "apply" ? evidence() : null);
  const sourceApprovalId = SAVE_APPROVAL_ID;
  return {
    id: PUBLISH_APPROVAL_ID,
    storeId: STORE_ID,
    adminId: "admin-1",
    draftId: DRAFT_ID,
    productId: null,
    resourceType: "storefront_page",
    resourceId: PAGE_ID,
    resourceVersion: SAVE_VERSION,
    resourceLabel: "Home · storefront page",
    locationId: null,
    variantId: null,
    resultId: status === "executed" ? PAGE_ID : null,
    resultVersion: status === "executed" ? PUBLISH_VERSION : null,
    sourceApprovalId,
    toolName: "publish_storefront_code",
    operation,
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
      sourceApprovalId,
      operation,
      resourceId: PAGE_ID,
      resourceVersion: SAVE_VERSION,
      before,
      after,
      toolVersion: 1,
    }),
    idempotencyKey: "88888888-8888-4888-8888-888888888888",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    approvedAt: status === "executed" ? PUBLISH_VERSION : null,
    executedAt: status === "executed" ? PUBLISH_VERSION : null,
  };
}

function rollbackApproval() {
  const before = {
    ...snapshot("new", evidence()),
    published_at: NEW_PUBLISHED_AT,
    browser_validation: null,
  };
  const after = snapshot("old", null);
  return {
    ...publicationApproval(),
    id: ROLLBACK_APPROVAL_ID,
    resourceVersion: PUBLISH_VERSION,
    sourceApprovalId: PUBLISH_APPROVAL_ID,
    operation: "rollback" as const,
    beforeJson: before,
    afterJson: after,
    requestHash: hashMinkActionPayload({
      storeId: STORE_ID,
      adminId: "admin-1",
      draftId: DRAFT_ID,
      draftVersion: 0,
      sourceApprovalId: PUBLISH_APPROVAL_ID,
      operation: "rollback",
      resourceId: PAGE_ID,
      resourceVersion: PUBLISH_VERSION,
      before,
      after,
      toolVersion: 1,
    }),
  };
}

beforeEach(() => {
  state.selects = {};
  state.executeRows = [];
  state.inserts = [];
  state.updates = [];
  state.updateReturns = {};
  state.locked = [];
});

describe("Mink Phase 7D storefront publication", () => {
  it("creates a separate approval only after exact save and browser checks", async () => {
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    state.selects.mink_drafts = [[draft()]];
    state.selects.mink_action_approvals = [[saveApproval()]];
    state.selects.mink_action_audit = [
      [
        {
          id: AUDIT_ID,
          outcome: "executed",
          resourceVersionAfter: SAVE_VERSION,
        },
      ],
    ];
    state.selects.store_pages = [[page()]];

    const { previewMinkStorefrontPublication } =
      await import("./storefront-publication-actions");
    const approval = await previewMinkStorefrontPublication({
      actor: actor(),
      draftId: DRAFT_ID,
      sourceApprovalId: SAVE_APPROVAL_ID,
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
      browserValidation: evidence(),
    });

    expect(approval).toMatchObject({
      toolName: "publish_storefront_code",
      operation: "apply",
      sourceApprovalId: SAVE_APPROVAL_ID,
      draftVersion: 0,
      checks: {
        staticChecksPassed: true,
        browserChecksPassed: true,
        desktopWidth: 1280,
        mobileWidth: 390,
      },
    });
    const inserted = state.inserts.find(
      (entry) => entry.table === "mink_action_approvals",
    )?.values;
    expect(inserted).toMatchObject({
      resourceType: "storefront_page",
      resourceId: PAGE_ID,
      resourceVersion: SAVE_VERSION,
      sourceApprovalId: SAVE_APPROVAL_ID,
      resultId: null,
    });
  });

  // ★★ SAME CANONICAL ORDER AS EVERY OTHER PHASE: approval -> draft -> page.
  // This preview is the only one in the codebase that locks a PRE-EXISTING
  // approval row (the completed Phase 7C save), so taking the draft first
  // inverted it against `executeMinkStorefrontCodeAction` and made the two
  // deadlockable. Values are identical either way, so this has to be asserted
  // as an order.
  it("locks the source approval before the draft, keeping one global order", async () => {
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    state.selects.mink_drafts = [[draft()]];
    state.selects.mink_action_approvals = [[saveApproval()]];
    state.selects.mink_action_audit = [
      [
        {
          id: AUDIT_ID,
          outcome: "executed",
          resourceVersionAfter: SAVE_VERSION,
        },
      ],
    ];
    state.selects.store_pages = [[page()]];

    const { previewMinkStorefrontPublication } =
      await import("./storefront-publication-actions");
    await previewMinkStorefrontPublication({
      actor: actor(),
      draftId: DRAFT_ID,
      sourceApprovalId: SAVE_APPROVAL_ID,
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
      browserValidation: evidence(),
    });

    expect(state.locked).toEqual([
      "mink_action_approvals",
      "mink_drafts",
      "store_pages",
    ]);
  });

  it("rejects stale, failed or wrong-patch browser evidence", async () => {
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    state.selects.mink_drafts = [[draft()]];
    state.selects.mink_action_approvals = [[saveApproval()]];
    state.selects.mink_action_audit = [
      [
        {
          id: AUDIT_ID,
          outcome: "executed",
          resourceVersionAfter: SAVE_VERSION,
        },
      ],
    ];
    state.selects.store_pages = [[page()]];
    const invalid = evidence();
    invalid.patchDigest = "f".repeat(64);
    const { previewMinkStorefrontPublication } =
      await import("./storefront-publication-actions");
    await expect(
      previewMinkStorefrontPublication({
        actor: actor(),
        draftId: DRAFT_ID,
        sourceApprovalId: SAVE_APPROVAL_ID,
        idempotencyKey: "99999999-9999-4999-8999-999999999999",
        browserValidation: invalid,
      }),
    ).rejects.toThrow(/exact code proposal/i);
    expect(
      state.inserts.filter((entry) => entry.table === "mink_action_approvals"),
    ).toHaveLength(0);
  });

  it("publishes only published columns and records an exact audit", async () => {
    state.selects.mink_action_approvals = [
      [publicationApproval()],
      [saveApproval()],
    ];
    state.selects.store_pages = [[page()]];
    state.selects.mink_drafts = [[draft()]];
    state.selects.mink_action_audit = [
      [
        {
          id: AUDIT_ID,
          outcome: "executed",
          resourceVersionAfter: SAVE_VERSION,
        },
      ],
    ];
    state.executeRows = [
      { rows: [] },
      { rows: [{ enabled: true }] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ];
    state.updateReturns.store_pages = [
      [{ id: PAGE_ID, updatedAt: PUBLISH_VERSION }],
    ];
    state.updateReturns.mink_action_approvals = [[{ id: PUBLISH_APPROVAL_ID }]];

    const { executeMinkStorefrontPublication } =
      await import("./storefront-publication-actions");
    const result = await executeMinkStorefrontPublication({
      actor: actor(),
      draftId: DRAFT_ID,
      approvalId: PUBLISH_APPROVAL_ID,
    });

    expect(result).toMatchObject({
      repeated: false,
      auditId: expect.any(String),
      approval: { operation: "apply", status: "executed" },
    });
    const pageUpdate = state.updates.find(
      (entry) => entry.table === "store_pages",
    )?.values;
    expect(pageUpdate).toMatchObject({
      publishedSections: [NEW_SECTION],
      status: "published",
      updatedBy: "admin-1",
    });
    expect(pageUpdate).not.toHaveProperty("sections");
    expect(
      state.inserts.find((entry) => entry.table === "mink_action_audit")
        ?.values,
    ).toMatchObject({
      toolName: "publish_storefront_code",
      operation: "apply",
      outcome: "executed",
      resourceType: "storefront_page",
      resultId: PAGE_ID,
    });
  });

  it("executes under the same approval-before-draft order", async () => {
    state.selects.mink_action_approvals = [
      [publicationApproval()],
      [saveApproval()],
    ];
    state.selects.store_pages = [[page()]];
    state.selects.mink_drafts = [[draft()]];
    state.selects.mink_action_audit = [
      [
        {
          id: AUDIT_ID,
          outcome: "executed",
          resourceVersionAfter: SAVE_VERSION,
        },
      ],
    ];
    state.executeRows = [
      { rows: [] },
      { rows: [{ enabled: true }] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ];
    state.updateReturns.store_pages = [
      [{ id: PAGE_ID, updatedAt: PUBLISH_VERSION }],
    ];
    state.updateReturns.mink_action_approvals = [[{ id: PUBLISH_APPROVAL_ID }]];

    const { executeMinkStorefrontPublication } =
      await import("./storefront-publication-actions");
    await executeMinkStorefrontPublication({
      actor: actor(),
      draftId: DRAFT_ID,
      approvalId: PUBLISH_APPROVAL_ID,
    });

    // Both approval rows come before the draft: this publication approval
    // first, then the Phase 7C save it is bound to.
    expect(state.locked).toEqual([
      "mink_action_approvals",
      "mink_action_tool_access",
      "mink_action_approvals",
      "mink_drafts",
      "store_pages",
    ]);
  });

  it("restores the exact prior live snapshot without changing the Builder draft", async () => {
    const source = publicationApproval("executed");
    const sourceBefore = snapshot("old", null);
    const sourceAfter = {
      ...snapshot("new", evidence()),
      published_at: NEW_PUBLISHED_AT,
    };
    state.selects.mink_action_approvals = [[rollbackApproval()], [source]];
    state.selects.store_pages = [[publishedNewPage()]];
    state.selects.mink_action_audit = [
      [
        {
          id: AUDIT_ID,
          outcome: "executed",
          beforeJson: sourceBefore,
          afterJson: sourceAfter,
          resourceVersionAfter: PUBLISH_VERSION,
        },
      ],
    ];
    state.executeRows = [
      { rows: [] },
      { rows: [{ enabled: true }] },
      { rows: [] },
      { rows: [] },
    ];
    state.updateReturns.store_pages = [
      [{ id: PAGE_ID, updatedAt: ROLLBACK_VERSION }],
    ];
    state.updateReturns.mink_action_approvals = [
      [{ id: ROLLBACK_APPROVAL_ID }],
    ];

    const { executeMinkStorefrontPublication } =
      await import("./storefront-publication-actions");
    const result = await executeMinkStorefrontPublication({
      actor: actor(),
      draftId: DRAFT_ID,
      approvalId: ROLLBACK_APPROVAL_ID,
    });

    expect(result).toMatchObject({
      repeated: false,
      approval: { operation: "rollback", status: "executed" },
    });
    const pageUpdate = state.updates.find(
      (entry) => entry.table === "store_pages",
    )?.values;
    expect(pageUpdate).toMatchObject({
      publishedSections: [OLD_SECTION],
      status: "published",
      publishedAt: PUBLISHED_AT,
      updatedBy: "admin-1",
    });
    expect(pageUpdate).not.toHaveProperty("sections");
    expect(
      state.inserts.find((entry) => entry.table === "mink_action_audit")
        ?.values,
    ).toMatchObject({
      operation: "rollback",
      outcome: "executed",
      beforeJson: { ...sourceAfter, browser_validation: null },
      afterJson: sourceBefore,
    });
  });

  it.each(["none", "version", "microseconds"])(
    "reviews rollback only while its live checkpoint is exact (changed: %s)",
    async (changed) => {
      const source = publicationApproval("executed");
      const before = snapshot("old", null);
      const after = {
        ...snapshot("new", evidence()),
        published_at: NEW_PUBLISHED_AT,
      };
      state.selects.mink_action_tool_access = [[{ enabled: true }]];
      state.selects.mink_action_approvals = [[source]];
      state.selects.mink_action_audit = [
        [
          {
            id: AUDIT_ID,
            outcome: "executed",
            beforeJson: before,
            afterJson: after,
            resourceVersionAfter: PUBLISH_VERSION,
          },
        ],
      ];
      state.selects.store_pages = [
        [
          {
            ...publishedNewPage(),
            updatedAt:
              changed === "version" ? ROLLBACK_VERSION : PUBLISH_VERSION,
            publishedAt:
              changed === "microseconds"
                ? "2026-09-04 12:02:00.000001+00"
                : "2026-09-04 12:02:00+00",
          },
        ],
      ];
      const { previewMinkStorefrontPublicationRollback } =
        await import("./storefront-publication-actions");
      const pending = previewMinkStorefrontPublicationRollback({
        actor: actor(),
        draftId: DRAFT_ID,
        sourceApprovalId: PUBLISH_APPROVAL_ID,
        idempotencyKey: "99999999-9999-4999-8999-999999999999",
      });
      if (changed !== "none") {
        await expect(pending).rejects.toThrow(
          /changed after this Mink publication/,
        );
        expect(state.inserts).toHaveLength(0);
      } else {
        await expect(pending).resolves.toMatchObject({
          operation: "rollback",
          sourceApprovalId: PUBLISH_APPROVAL_ID,
          before: { sections_digest: after.sections_digest },
          after: { sections_digest: before.sections_digest },
        });
      }
      expect(state.updates).toHaveLength(0);
    },
  );

  it("returns the original audit on replay without another page write", async () => {
    state.selects.mink_action_approvals = [[publicationApproval("executed")]];
    state.selects.mink_action_audit = [
      [
        {
          id: AUDIT_ID,
          outcome: "executed",
          afterJson: {
            ...snapshot("new", evidence()),
            published_at: NEW_PUBLISHED_AT,
          },
        },
      ],
    ];
    const { executeMinkStorefrontPublication } =
      await import("./storefront-publication-actions");
    await expect(
      executeMinkStorefrontPublication({
        actor: actor(),
        draftId: DRAFT_ID,
        approvalId: PUBLISH_APPROVAL_ID,
      }),
    ).resolves.toMatchObject({ repeated: true, auditId: AUDIT_ID });
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  it("fails closed before publication when the page version changed", async () => {
    state.selects.mink_action_approvals = [[publicationApproval()]];
    state.selects.store_pages = [[page(PUBLISH_VERSION)]];
    state.executeRows = [
      { rows: [] },
      { rows: [{ enabled: true }] },
      { rows: [] },
    ];
    const { executeMinkStorefrontPublication } =
      await import("./storefront-publication-actions");
    await expect(
      executeMinkStorefrontPublication({
        actor: actor(),
        draftId: DRAFT_ID,
        approvalId: PUBLISH_APPROVAL_ID,
      }),
    ).rejects.toThrow(/changed/i);
    expect(
      state.updates.filter((entry) => entry.table === "store_pages"),
    ).toHaveLength(0);
    expect(
      state.inserts.find((entry) => entry.table === "mink_action_audit")
        ?.values,
    ).toMatchObject({ outcome: "conflicted", resultId: null });
  });

  it("records expiry even when the earlier browser evidence is no longer fresh", async () => {
    const expired = publicationApproval();
    const after = expired.afterJson as ReturnType<typeof snapshot>;
    const staleAfter = {
      ...after,
      browser_validation: {
        ...after.browser_validation!,
        checkedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      },
    };
    expired.afterJson = staleAfter;
    expired.expiresAt = new Date(Date.now() - 60_000).toISOString();
    expired.requestHash = hashMinkActionPayload({
      storeId: expired.storeId,
      adminId: expired.adminId,
      draftId: expired.draftId,
      draftVersion: 0,
      sourceApprovalId: expired.sourceApprovalId,
      operation: expired.operation,
      resourceId: expired.resourceId,
      resourceVersion: expired.resourceVersion,
      before: expired.beforeJson,
      after: staleAfter,
      toolVersion: 1,
    });
    state.selects.mink_action_approvals = [[expired]];
    state.executeRows = [{ rows: [] }, { rows: [{ enabled: true }] }];

    const { executeMinkStorefrontPublication } =
      await import("./storefront-publication-actions");
    await expect(
      executeMinkStorefrontPublication({
        actor: actor(),
        draftId: DRAFT_ID,
        approvalId: PUBLISH_APPROVAL_ID,
      }),
    ).rejects.toThrow(/expired/i);
    expect(
      state.inserts.find((entry) => entry.table === "mink_action_audit")
        ?.values,
    ).toMatchObject({ outcome: "expired", resultId: null });
  });

  it("rejects an actor without Builder Manage before database access", async () => {
    const { previewMinkStorefrontPublication } =
      await import("./storefront-publication-actions");
    await expect(
      previewMinkStorefrontPublication({
        actor: actor({ permissions: { builder: ["view"] } }),
        draftId: DRAFT_ID,
        sourceApprovalId: SAVE_APPROVAL_ID,
        idempotencyKey: "99999999-9999-4999-8999-999999999999",
        browserValidation: evidence(),
      }),
    ).rejects.toThrow(/permission/i);
    expect(state.selects).toEqual({});
  });
});
