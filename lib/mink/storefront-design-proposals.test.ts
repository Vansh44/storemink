import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { EMPTY_DESIGN_OVERRIDES } from "@/lib/chrome/design";
import type { StorefrontDesignOverrides } from "@/lib/chrome/design";
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
vi.mock("@/lib/themes/runtime-registry", () => ({
  resolveThemeDefinitionWithDb: vi.fn(
    async (_db: unknown, id: unknown, version?: unknown) => {
      const { getThemeDefinition } = await import("@/lib/themes");
      return getThemeDefinition(id, version);
    },
  ),
}));
vi.mock("./drafts", () => ({ createMinkDraftProposal: mocks.createDraft }));

import { digestMinkStorefrontDesign } from "./storefront-design-contract";
import {
  createMinkStorefrontDesignProposal,
  readStoredDesign,
  validateStoredDesignProposal,
} from "./storefront-design-proposals";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";

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
    settings: { theme: { presetId: "basket", presetVersion: "0.1.0" } },
    chrome_store_id: "store-1",
    draft: { design: CURRENT },
    ...overrides,
  };
}

function patch(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    operation: "replace_design_overrides",
    target: { expectedDesignDigest: digestMinkStorefrontDesign(CURRENT) },
    design: PROPOSED,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockResolvedValue({ rows: [targetRow()] });
  mocks.createDraft.mockResolvedValue({
    type: "proposal",
    draftId: DRAFT_ID,
    title: "Storefront design",
    destinationLabel: "Storefront design · Basket",
    expectedCredits: 2,
    chargedCredits: 2,
    creditSource: "plan",
  });
});

describe("Phase 9C storefront design proposals", () => {
  it("stores a bounded private proposal only after an exact digest match", async () => {
    const result = await createMinkStorefrontDesignProposal({
      actor: ACTOR,
      patch: patch(),
      explanation: "Warm the page background and set a single display face.",
    });

    expect(result).toMatchObject({
      type: "storefront_design_proposal",
      draftId: DRAFT_ID,
      status: "private_preview",
      expectedCredits: 2,
    });
    expect(result.summary.palette).toEqual([
      expect.objectContaining({
        token: "cream",
        before: null,
        after: "#fffdf8",
      }),
    ]);
    expect(result.summary.fonts).toEqual([
      expect.objectContaining({ slot: "body", before: null, after: "jost" }),
    ]);
    // The stored draft carries the design; the artifact must not, or the whole
    // override set would be replayed through conversation history.
    expect(result).not.toHaveProperty("design");
    expect(mocks.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "storefront_design",
        destinationType: "storefront_chrome",
        destinationPath: "/dashboard/builder",
      }),
    );

    // The store id must reach the query as a bound parameter, never as text.
    const compiled = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]);
    expect(compiled.params).toContain(ACTOR.storeId);
    expect(compiled.sql).not.toContain(ACTOR.storeId);
  });

  it("refuses a stale design before charging a single credit", async () => {
    await expect(
      createMinkStorefrontDesignProposal({
        actor: ACTOR,
        patch: patch({ target: { expectedDesignDigest: "b".repeat(64) } }),
        explanation: "Stale digest.",
      }),
    ).rejects.toThrow("changed");
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("refuses a no-op, so a merchant is never charged for an unchanged design", async () => {
    await expect(
      createMinkStorefrontDesignProposal({
        actor: ACTOR,
        patch: patch({ design: CURRENT }),
        explanation: "Nothing changes.",
      }),
    ).rejects.toThrow(/identical/i);
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("★ NAMES an illegible palette rather than storing it", async () => {
    await expect(
      createMinkStorefrontDesignProposal({
        actor: ACTOR,
        patch: patch({
          design: {
            palette: { ink: "#eeeeee", cream: "#f5f5f5" },
            fonts: { body: null, display: null },
            shape: {},
          },
        }),
        explanation: "Grey on grey.",
      }),
    ).rejects.toThrow(/hard to read/i);
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("★ A STORE WITH NO CHROME ROW IS PROPOSED AGAINST ITS DEFAULTS, not refused", async () => {
    // The commonest state: nobody has opened the Brand panel, so there is no
    // row — and that is exactly the store most likely to ask for a redesign.
    mocks.execute.mockResolvedValue({
      rows: [targetRow({ chrome_store_id: null, draft: null })],
    });
    const result = await createMinkStorefrontDesignProposal({
      actor: ACTOR,
      patch: patch({
        target: {
          expectedDesignDigest: digestMinkStorefrontDesign(
            EMPTY_DESIGN_OVERRIDES,
          ),
        },
      }),
      explanation: "First design for a store that has never opened Brand.",
    });
    expect(result.type).toBe("storefront_design_proposal");
  });

  it("refuses an admin without Builder manage, and one without drafting", async () => {
    await expect(
      createMinkStorefrontDesignProposal({
        actor: { ...ACTOR, permissions: { builder: ["view"] } },
        patch: patch(),
        explanation: "No manage permission.",
      }),
    ).rejects.toThrow(/permission/i);
    await expect(
      createMinkStorefrontDesignProposal({
        actor: { ...ACTOR, draftingEnabled: false },
        patch: patch(),
        explanation: "Drafting is off.",
      }),
    ).rejects.toThrow(/drafting/i);
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });
});

describe("validateStoredDesignProposal", () => {
  const stored = (overrides: Record<string, string> = {}) => ({
    expected_design_digest: digestMinkStorefrontDesign(CURRENT),
    patch_digest: "",
    design_json: JSON.stringify(PROPOSED),
    explanation: "why",
    ...overrides,
  });

  it("re-validates on the way OUT and returns the recomputed digest", () => {
    const result = validateStoredDesignProposal(stored(), null);
    expect(result.design).toEqual(PROPOSED);
    expect(result.patchDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses a stored digest that disagrees with its own content", () => {
    expect(() =>
      validateStoredDesignProposal(
        stored({ patch_digest: "a".repeat(64) }),
        null,
      ),
    ).toThrow(/integrity/i);
  });

  it("★ REFUSES A PROPOSAL THE STORE'S CURRENT THEME HAS MADE ILLEGIBLE", () => {
    // Only `ink` is overridden, so `cream` resolves from the theme — swapping
    // the theme underneath a stored proposal can therefore turn a legible
    // palette into an unreadable one without the proposal changing at all.
    const inkOnly = JSON.stringify({
      palette: { ink: "#eeeeee" },
      fonts: { body: null, display: null },
      shape: {},
    });
    expect(() =>
      validateStoredDesignProposal(stored({ design_json: inkOnly }), {
        palette: { cream: "#f5f5f5" },
        fonts: { body: "var(--font-inter)", display: "var(--font-inter)" },
        shape: {},
      } as never),
    ).toThrow(/hard to read/i);
  });

  it("refuses unreadable JSON rather than treating it as an empty design", () => {
    expect(() =>
      validateStoredDesignProposal(stored({ design_json: "{" }), null),
    ).toThrow(/unreadable/i);
  });
});

describe("readStoredDesign", () => {
  it("sanitizes the merchant's own prior design instead of holding it to the publish bar", () => {
    // A snapshot may legitimately hold a palette the publish gate would refuse
    // — 9A made contrast a publish gate, not a save gate — so the `before` side
    // is sanitized rather than validated strictly.
    const illegible = JSON.stringify({
      palette: { ink: "#eeeeee", cream: "#f5f5f5" },
      fonts: { body: null, display: null },
      shape: {},
    });
    expect(readStoredDesign({ design_json: illegible })).toEqual({
      palette: { ink: "#eeeeee", cream: "#f5f5f5" },
      fonts: { body: null, display: null },
      shape: {},
    });
  });

  it("refuses an unreadable snapshot", () => {
    expect(() => readStoredDesign({ design_json: "nope" })).toThrow(
      /unreadable/i,
    );
  });
});
