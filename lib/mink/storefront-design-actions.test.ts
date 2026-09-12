/* eslint-disable @typescript-eslint/no-explicit-any */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import type { StorefrontDesignOverrides } from "@/lib/chrome/design";
import { getThemeDefinition } from "@/lib/themes";
import { hashMinkActionPayload } from "./action-integrity";
import {
  digestMinkStorefrontDesign,
  validateMinkStorefrontDesignPatch,
} from "./storefront-design-contract";
import { digestMinkStorefrontValue } from "./storefront-code-contract";

const state = vi.hoisted(() => ({
  selects: {} as Record<string, any[][]>,
  /** The one raw read: stores LEFT JOIN store_chrome. */
  targetRows: [] as any[],
  inserts: [] as Array<{ table: string; values: any }>,
  updates: [] as Array<{ table: string; values: any }>,
  updateReturns: {} as Record<string, any[][]>,
  insertReturns: {} as Record<string, any[][]>,
  locked: [] as string[],
}));

function sqlText(query: any): string {
  return ((query?.queryChunks ?? []) as any[])
    .map((chunk) => (Array.isArray(chunk?.value) ? chunk.value.join("") : ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

function lockedTable(text: string): string | null {
  if (!/for update/i.test(text)) return null;
  return /from\s+public\.([a-z_]+)/i.exec(text)?.[1] ?? "unknown";
}

function take(queue: any[][] | undefined) {
  if (!queue?.length) return [];
  return queue.length === 1 ? queue[0] : queue.shift();
}

function insertResult(table: string, values: any) {
  const armed = take(state.insertReturns[table]) ?? [];
  if (armed.length) return armed;
  return [
    {
      status: "pending",
      resultId: null,
      resultVersion: null,
      approvedAt: null,
      executedAt: null,
      ...values,
    },
  ];
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
                  : insertResult(table, values),
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
    const text = sqlText(query);
    const table = lockedTable(text);
    if (table) {
      state.locked.push(table);
      // ★ Routed BY TABLE, not positionally: every `for update` lock shares
      //   this path, so a positional queue would hand the operator gate's
      //   answer to whichever lock happened to run first.
      return table === "mink_action_tool_access"
        ? { rows: take(state.selects.mink_action_tool_access) }
        : { rows: [] };
    }
    if (/from stores/i.test(text)) return { rows: state.targetRows };
    return { rows: [] };
  },
  select: () => chain(),
  insert: (table: any) => chain(getTableName(table), "insert"),
  update: (table: any) => chain(getTableName(table), "update"),
};

vi.mock("@/lib/db/client", () => ({ withService: (fn: any) => fn(db) }));

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const DRAFT_ID = "33333333-3333-4333-8333-333333333333";
const APPROVAL_ID = "44444444-4444-4444-8444-444444444444";
const CHROME_VERSION = "2026-09-12 12:00:00.123456+00";
const NEXT_VERSION = "2026-09-12 12:01:00.654321+00";

const CURRENT: StorefrontDesignOverrides = {
  palette: { ink: "#101010" },
  fonts: { body: null, display: null },
  shape: {},
};
const PROPOSED: StorefrontDesignOverrides = {
  palette: { ink: "#101010", cream: "#fffdf8" },
  fonts: { body: "jost", display: null },
  shape: { card: 4 },
};
const CURRENT_DIGEST = digestMinkStorefrontDesign(CURRENT);
const PROPOSED_DIGEST = digestMinkStorefrontDesign(PROPOSED);

/** The digest the proposal module stores: over the VALIDATED patch. */
function patchDigest(design: StorefrontDesignOverrides) {
  const validated = validateMinkStorefrontDesignPatch(
    {
      schemaVersion: 1,
      operation: "replace_design_overrides",
      target: { expectedDesignDigest: CURRENT_DIGEST },
      design,
    },
    null,
  );
  if (!validated.ok) throw new Error(validated.issues.join(" "));
  return digestMinkStorefrontValue(validated.value);
}

function draft() {
  return {
    id: DRAFT_ID,
    kind: "storefront_design",
    status: "proposed",
    currentVersion: 0,
    before: {
      expected_design_digest: CURRENT_DIGEST,
      patch_digest: CURRENT_DIGEST,
      design_json: JSON.stringify(CURRENT),
      explanation: "Current storefront design before this proposal.",
    },
    content: {
      expected_design_digest: CURRENT_DIGEST,
      patch_digest: patchDigest(PROPOSED),
      design_json: JSON.stringify(PROPOSED),
      explanation: "Warm the page background and set a display face.",
    },
  };
}

function targetRow(design = CURRENT, chromeRow = true) {
  return {
    settings: {},
    chrome_store_id: chromeRow ? STORE_ID : null,
    draft: chromeRow ? { design } : null,
    updated_at: chromeRow ? CHROME_VERSION : null,
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

const values = (digest: string, count: number) => ({
  design_digest: digest,
  override_count: String(count),
});

function approvalRow(
  status: "pending" | "executed" = "pending",
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
) {
  const before = values(CURRENT_DIGEST, 1);
  const after = values(PROPOSED_DIGEST, 3);
  return {
    id: APPROVAL_ID,
    storeId: STORE_ID,
    adminId: "admin-1",
    draftId: DRAFT_ID,
    productId: null,
    resourceType: "storefront_chrome",
    resourceId: STORE_ID,
    resourceVersion: CHROME_VERSION,
    resourceLabel: "Storefront design",
    locationId: null,
    variantId: null,
    resultId: status === "executed" ? STORE_ID : null,
    resultVersion: status === "executed" ? NEXT_VERSION : null,
    sourceApprovalId: null,
    toolName: "apply_storefront_design",
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
      resourceId: STORE_ID,
      resourceVersion: CHROME_VERSION,
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

function armExecute(overrides: { design?: StorefrontDesignOverrides } = {}) {
  state.selects.mink_action_approvals = [[approvalRow()]];
  state.selects.mink_action_tool_access = [[{ enabled: true }]];
  state.selects.mink_drafts = [[draft()]];
  state.targetRows = [targetRow(overrides.design ?? CURRENT)];
  state.insertReturns.store_chrome = [
    [{ storeId: STORE_ID, updatedAt: NEXT_VERSION }],
  ];
  state.updateReturns.mink_action_approvals = [[{ id: APPROVAL_ID }]];
}

beforeEach(() => {
  state.selects = {};
  state.targetRows = [];
  state.locked = [];
  state.inserts = [];
  state.updates = [];
  state.updateReturns = {};
  state.insertReturns = {};
});

describe("Mink Phase 9C storefront design actions", () => {
  it("creates a five-minute approval bound to both design digests", async () => {
    state.selects.mink_drafts = [[draft()]];
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    state.targetRows = [targetRow()];

    const { previewMinkStorefrontDesignAction } =
      await import("./storefront-design-actions");
    const approval = await previewMinkStorefrontDesignAction({
      actor: actor(),
      draftId: DRAFT_ID,
      expectedDraftVersion: 0,
      idempotencyKey: "66666666-6666-4666-8666-666666666666",
    });

    expect(approval).toMatchObject({
      toolName: "apply_storefront_design",
      operation: "apply",
      draftVersion: 0,
      resource: { type: "storefront_chrome", id: STORE_ID },
      before: { design_digest: CURRENT_DIGEST },
      after: { design_digest: PROPOSED_DIGEST },
    });
    expect(Date.parse(approval.expiresAt) - Date.now()).toBeLessThanOrEqual(
      5 * 60 * 1_000,
    );
  });

  it("fails closed when the per-store design gate is off", async () => {
    state.selects.mink_drafts = [[draft()]];
    state.selects.mink_action_tool_access = [[{ enabled: false }]];
    state.targetRows = [targetRow()];
    const { previewMinkStorefrontDesignAction } =
      await import("./storefront-design-actions");
    await expect(
      previewMinkStorefrontDesignAction({
        actor: actor(),
        draftId: DRAFT_ID,
        expectedDraftVersion: 0,
        idempotencyKey: "66666666-6666-4666-8666-666666666666",
      }),
    ).rejects.toThrow(/has not enabled/i);
    expect(state.inserts).toHaveLength(0);
  });

  it("refuses without drafting or Builder Manage, before touching the database", async () => {
    const { previewMinkStorefrontDesignAction } =
      await import("./storefront-design-actions");
    for (const bad of [
      actor({ draftingEnabled: false }),
      actor({ permissions: { builder: ["view"] } }),
    ]) {
      await expect(
        previewMinkStorefrontDesignAction({
          actor: bad,
          draftId: DRAFT_ID,
          expectedDraftVersion: 0,
          idempotencyKey: "66666666-6666-4666-8666-666666666666",
        }),
      ).rejects.toThrow(/permission/i);
    }
    expect(state.locked).toHaveLength(0);
  });

  it("★★ REPLACES ONLY design, CARRYING THE REST OF THE CHROME THROUGH", async () => {
    // The header, footer and appearance variants share this jsonb value, and
    // the builder autosaves it on a keystroke — so a whole-row write would
    // silently revert a footer edit made between preview and approval.
    const chrome = targetRow();
    (chrome.draft as any).header = {
      links: [{ label: "Sale", href: "/sale" }],
    };
    (chrome.draft as any).appearance = { footer: "minimal" };
    state.selects.mink_action_approvals = [[approvalRow()]];
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    state.selects.mink_drafts = [[draft()]];
    state.targetRows = [chrome];
    state.insertReturns.store_chrome = [
      [{ storeId: STORE_ID, updatedAt: NEXT_VERSION }],
    ];
    state.updateReturns.mink_action_approvals = [[{ id: APPROVAL_ID }]];

    const { executeMinkStorefrontDesignAction } =
      await import("./storefront-design-actions");
    const result = await executeMinkStorefrontDesignAction({
      actor: actor(),
      draftId: DRAFT_ID,
      approvalId: APPROVAL_ID,
    });

    expect(result.repeated).toBe(false);
    expect(result.approval.status).toBe("executed");

    const written = state.inserts.find(
      (entry) => entry.table === "store_chrome",
    )?.values;
    expect(written.draft.design).toEqual(PROPOSED);
    expect(written.draft.header.links).toContainEqual({
      label: "Sale",
      href: "/sale",
    });
    expect(written.draft.appearance.footer).toBe("minimal");
    // ★★ A DRAFT SAVE: `published` and `published_at` are absent from the
    //    statement, so publishing stays the merchant's separate step.
    expect(Object.keys(written).sort()).toEqual([
      "draft",
      "storeId",
      "updatedAt",
    ]);

    const audit = state.inserts.find(
      (entry) => entry.table === "mink_action_audit",
    )?.values;
    expect(audit).toMatchObject({
      resourceType: "storefront_chrome",
      resourceId: STORE_ID,
      resultId: STORE_ID,
      toolName: "apply_storefront_design",
      outcome: "executed",
      resourceVersionBefore: CHROME_VERSION,
      resourceVersionAfter: NEXT_VERSION,
    });
    expect(audit.detail).toContain("published storefront was not changed");

    // ★ The chrome row is locked BEFORE the draft is re-read: the builder
    //   autosaves it constantly, so taking it first is what stops a keystroke
    //   landing between the digest check and the merge.
    expect(state.locked).toEqual([
      "mink_action_approvals",
      "mink_action_tool_access",
      "store_chrome",
      "mink_drafts",
    ]);
  });

  it("replays an executed approval without writing a second time", async () => {
    state.selects.mink_action_approvals = [[approvalRow("executed")]];
    state.selects.mink_action_audit = [[{ id: "audit-1" }]];
    state.selects.mink_drafts = [[draft()]];
    state.targetRows = [targetRow()];
    const { executeMinkStorefrontDesignAction } =
      await import("./storefront-design-actions");
    const result = await executeMinkStorefrontDesignAction({
      actor: actor(),
      draftId: DRAFT_ID,
      approvalId: APPROVAL_ID,
    });
    expect(result).toMatchObject({ repeated: true, auditId: "audit-1" });
    expect(
      state.inserts.find((entry) => entry.table === "store_chrome"),
    ).toBeUndefined();
  });

  it("conflicts instead of writing when the design moved after preview", async () => {
    armExecute({
      design: {
        palette: { ink: "#222222" },
        fonts: { body: null, display: null },
        shape: {},
      },
    });
    const { executeMinkStorefrontDesignAction } =
      await import("./storefront-design-actions");
    await expect(
      executeMinkStorefrontDesignAction({
        actor: actor(),
        draftId: DRAFT_ID,
        approvalId: APPROVAL_ID,
      }),
    ).rejects.toThrow(/design changed/i);
    expect(
      state.inserts.find((entry) => entry.table === "store_chrome"),
    ).toBeUndefined();
    const audit = state.inserts.find(
      (entry) => entry.table === "mink_action_audit",
    )?.values;
    expect(audit).toMatchObject({ outcome: "conflicted", resultId: null });
  });

  it("★ AN UNRELATED CHROME EDIT DOES NOT KILL THE APPROVAL", async () => {
    // The lock is the DESIGN digest, not the row clock — a footer keystroke
    // between preview and approval moves `updated_at` and must not conflict.
    const moved = targetRow();
    moved.updated_at = NEXT_VERSION;
    (moved.draft as any).header = { links: [{ label: "Sale", href: "/sale" }] };
    state.selects.mink_action_approvals = [[approvalRow()]];
    state.selects.mink_action_tool_access = [[{ enabled: true }]];
    state.selects.mink_drafts = [[draft()]];
    state.targetRows = [moved];
    state.insertReturns.store_chrome = [
      [{ storeId: STORE_ID, updatedAt: NEXT_VERSION }],
    ];
    state.updateReturns.mink_action_approvals = [[{ id: APPROVAL_ID }]];

    const { executeMinkStorefrontDesignAction } =
      await import("./storefront-design-actions");
    const result = await executeMinkStorefrontDesignAction({
      actor: actor(),
      draftId: DRAFT_ID,
      approvalId: APPROVAL_ID,
    });
    expect(result.repeated).toBe(false);
  });

  it("conflicts on an expired approval rather than saving late", async () => {
    armExecute();
    state.selects.mink_action_approvals = [
      [approvalRow("pending", new Date(Date.now() - 1_000).toISOString())],
    ];
    const { executeMinkStorefrontDesignAction } =
      await import("./storefront-design-actions");
    await expect(
      executeMinkStorefrontDesignAction({
        actor: actor(),
        draftId: DRAFT_ID,
        approvalId: APPROVAL_ID,
      }),
    ).rejects.toThrow(/expired/i);
    const audit = state.inserts.find(
      (entry) => entry.table === "mink_action_audit",
    )?.values;
    expect(audit).toMatchObject({ outcome: "expired", resultId: null });
  });

  it("★ NAMES A THEME SWITCH RATHER THAN CALLING IT A CHANGED PROPOSAL", async () => {
    // Contrast is judged against the RESOLVED pair, so switching theme between
    // preview and approval can make a stored palette illegible without the
    // proposal changing at all. Reporting "your proposal changed" would send
    // the merchant looking for an edit nobody made.
    const basket = getThemeDefinition("basket");
    // Ink set to the theme's OWN page colour: a 1:1 ratio, so the failure
    // comes from the theme underneath rather than from a second override.
    const illegible = {
      palette: { ink: basket!.preset.design.palette.cream },
      fonts: { body: null, display: null },
      shape: {},
    };
    armExecute();
    state.selects.mink_drafts = [
      [
        {
          ...draft(),
          content: {
            ...draft().content,
            patch_digest: patchDigest(illegible),
            design_json: JSON.stringify(illegible),
          },
        },
      ],
    ];
    state.targetRows = [
      {
        ...targetRow(),
        settings: { theme: { presetId: "basket" } },
      },
    ];
    const { executeMinkStorefrontDesignAction } =
      await import("./storefront-design-actions");
    await expect(
      executeMinkStorefrontDesignAction({
        actor: actor(),
        draftId: DRAFT_ID,
        approvalId: APPROVAL_ID,
      }),
    ).rejects.toThrow(/hard to read/i);
    expect(
      state.inserts.find((entry) => entry.table === "store_chrome"),
    ).toBeUndefined();
    const audit = state.inserts.find(
      (entry) => entry.table === "mink_action_audit",
    )?.values;
    expect(audit).toMatchObject({ outcome: "conflicted" });
    expect(audit.detail).toContain("failed re-validation");
  });

  it("refuses an approval whose request hash was tampered with", async () => {
    armExecute();
    state.selects.mink_action_approvals = [
      [{ ...approvalRow(), requestHash: "f".repeat(64) }],
    ];
    const { executeMinkStorefrontDesignAction } =
      await import("./storefront-design-actions");
    await expect(
      executeMinkStorefrontDesignAction({
        actor: actor(),
        draftId: DRAFT_ID,
        approvalId: APPROVAL_ID,
      }),
    ).rejects.toThrow(/integrity/i);
    expect(
      state.inserts.find((entry) => entry.table === "store_chrome"),
    ).toBeUndefined();
  });
});
