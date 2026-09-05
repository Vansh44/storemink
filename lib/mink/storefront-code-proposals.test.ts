import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { MinkActorContext } from "./types";
import {
  digestMinkStorefrontValue,
  validateMinkStorefrontCodePatch,
} from "./storefront-code-contract";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  createDraft: vi.fn(),
  getDraft: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((run: (db: unknown) => unknown) =>
    run({ execute: mocks.execute }),
  ),
}));
vi.mock("./drafts", () => ({
  createMinkDraftProposal: mocks.createDraft,
  getMinkDraft: mocks.getDraft,
}));

import {
  createMinkStorefrontCodeProposal,
  getMinkStorefrontCodePreview,
} from "./storefront-code-proposals";

const VERSION = "2026-09-04T10:20:30.123456+00:00";
const DRAFT_ID = "11111111-1111-4111-8111-111111111111";
const SECTION = {
  id: "section-1",
  type: "custom_code",
  enabled: true,
  config: {
    html: '<section class="hero"><h2>Current</h2></section>',
    css: ".hero { padding: 2rem; }",
    js: "",
    height_mode: "auto",
    fixed_height: 480,
  },
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
    title: "Home",
    slug: "",
    sections: [SECTION],
    updated_at: VERSION,
    settings: { features: { "pages.customCode": true } },
    ...overrides,
  };
}

function patch(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    operation: "replace_custom_code",
    target: {
      pageSlug: "home",
      sectionId: SECTION.id,
      expectedPageVersion: VERSION,
      expectedSectionDigest: digestMinkStorefrontValue(SECTION),
    },
    code: {
      html: '<section class="hero"><h2>New arrivals</h2></section>',
      css: ".hero { padding: 3rem; }",
      js: "document.querySelector('.hero')?.classList.add('ready');",
      heightMode: "auto",
      fixedHeight: 480,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execute.mockResolvedValue({ rows: [targetRow()] });
  mocks.createDraft.mockResolvedValue({
    type: "proposal",
    draftId: DRAFT_ID,
    title: "Storefront code for Home",
    destinationLabel: "Home · custom code",
    expectedCredits: 5,
    chargedCredits: 5,
    creditSource: "plan",
  });
});

describe("Phase 7B storefront code proposals", () => {
  it("stores a bounded private proposal only after an exact tenant-scoped checkpoint match", async () => {
    const result = await createMinkStorefrontCodeProposal({
      actor: ACTOR,
      patch: patch(),
      explanation: "A responsive hero using the current Echos visual system.",
    });

    expect(result).toMatchObject({
      type: "storefront_code_proposal",
      draftId: DRAFT_ID,
      status: "private_preview",
      expectedCredits: 5,
      changedFields: ["html", "css", "js"],
    });
    expect(result).not.toHaveProperty("before");
    expect(result).not.toHaveProperty("content");
    expect(mocks.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: ACTOR,
        kind: "storefront_custom_code",
        destinationType: "storefront_section",
        destinationPath: "/dashboard/builder?page=home&section=section-1",
      }),
    );
    const compiled = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]);
    expect(
      compiled.params.filter((value) => value === ACTOR.storeId),
    ).toHaveLength(2);
    expect(compiled.params).toContain("");
    expect(compiled.sql).not.toContain(ACTOR.storeId);
  });

  it("rejects stale targets, non-code sections, and disabled custom-code plans before charging", async () => {
    await expect(
      createMinkStorefrontCodeProposal({
        actor: ACTOR,
        patch: {
          ...patch(),
          target: {
            ...patch().target,
            expectedPageVersion: "2026-09-04T10:20:31.000000+00:00",
          },
        },
        explanation: "Stale target test.",
      }),
    ).rejects.toThrow("changed");

    mocks.execute.mockResolvedValueOnce({
      rows: [
        targetRow({
          sections: [
            {
              id: SECTION.id,
              type: "rich_text",
              enabled: true,
              config: { html: "<p>Existing copy</p>", width: "contained" },
            },
          ],
        }),
      ],
    });
    await expect(
      createMinkStorefrontCodeProposal({
        actor: ACTOR,
        patch: patch(),
        explanation: "Wrong section test.",
      }),
    ).rejects.toThrow("existing custom-code section");

    mocks.execute.mockResolvedValueOnce({
      rows: [
        targetRow({ settings: { features: { "pages.customCode": false } } }),
      ],
    });
    await expect(
      createMinkStorefrontCodeProposal({
        actor: ACTOR,
        patch: patch(),
        explanation: "Entitlement test.",
      }),
    ).rejects.toThrow("not enabled");
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("rejects unsafe code and missing manage permission without reading store data", async () => {
    await expect(
      createMinkStorefrontCodeProposal({
        actor: ACTOR,
        patch: {
          ...patch(),
          code: { ...patch().code, js: "fetch('https://attacker.example')" },
        },
        explanation: "Unsafe network test.",
      }),
    ).rejects.toThrow("network APIs");
    await expect(
      createMinkStorefrontCodeProposal({
        actor: { ...ACTOR, permissions: { builder: ["view"] } },
        patch: patch(),
        explanation: "Permission test.",
      }),
    ).rejects.toThrow("Manage permission");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.createDraft).not.toHaveBeenCalled();
  });

  it("revalidates stored patch integrity and reports a stale builder target without executing code", async () => {
    const validated = validateMinkStorefrontCodePatch(patch());
    if (!validated.ok) throw new Error(validated.issues.join(" "));
    mocks.getDraft.mockResolvedValue({
      id: DRAFT_ID,
      kind: "storefront_custom_code",
      title: "Storefront code for Home",
      destinationLabel: "Home · custom code",
      destinationPath: "/dashboard/builder?page=home&section=section-1",
      before: {
        page_slug: "home",
        section_id: SECTION.id,
        expected_page_version: VERSION,
        expected_section_digest: digestMinkStorefrontValue(SECTION),
        patch_digest: digestMinkStorefrontValue(SECTION.config),
        html: SECTION.config.html,
        css: SECTION.config.css,
        js: SECTION.config.js,
        height_mode: SECTION.config.height_mode,
        fixed_height: String(SECTION.config.fixed_height),
        explanation: "Current Website Builder code before this proposal.",
      },
      content: {
        page_slug: "home",
        section_id: SECTION.id,
        expected_page_version: VERSION,
        expected_section_digest: digestMinkStorefrontValue(SECTION),
        patch_digest: validated.value.patchDigest,
        html: validated.value.patch.code.html,
        css: validated.value.patch.code.css,
        js: validated.value.patch.code.js,
        height_mode: validated.value.patch.code.heightMode,
        fixed_height: String(validated.value.patch.code.fixedHeight),
        explanation: "A responsive hero.",
      },
    });
    mocks.execute.mockResolvedValueOnce({
      rows: [targetRow({ updated_at: "2026-09-04T10:21:00.000000+00:00" })],
    });

    const preview = await getMinkStorefrontCodePreview(ACTOR, DRAFT_ID);
    expect(preview).toMatchObject({
      id: DRAFT_ID,
      targetState: "stale",
      authority: {
        canPreview: true,
        canSaveBuilderDraft: false,
        canPublish: false,
      },
      sandbox: {
        iframe: { sandboxAttribute: "allow-scripts", opaqueOrigin: true },
      },
    });
  });
});
