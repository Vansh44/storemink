import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { withService } from "@/lib/db/client";
import type { MinkActorContext } from "./types";
import {
  readMinkStorefrontDesignContext,
  readMinkStorefrontPageContext,
  readMinkStorefrontPages,
  readMinkStorefrontSectionContext,
} from "./storefront-context-read";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("@/lib/db/client", () => ({
  withService: vi.fn((run: (db: unknown) => unknown) => run({ execute })),
}));

const ACTOR: MinkActorContext = {
  storeId: "store-1",
  adminId: "admin-1",
  email: "owner@example.com",
  roleSlug: "designer",
  permissions: { builder: ["view"] },
  isSuperadmin: false,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request-1",
};

const CUSTOM_SECTION = {
  id: "section-1",
  type: "custom_code",
  enabled: true,
  config: {
    html: `<section>${"x".repeat(8_100)}</section>`,
    css: ".hero { color: rebeccapurple; }",
    js: "document.querySelector('.hero')?.classList.add('ready');",
    height_mode: "auto",
    fixed_height: 480,
  },
};

function pageRow(overrides: Record<string, unknown> = {}) {
  return {
    slug: "",
    title: "Home",
    status: "published",
    seo_title: "Echos furniture",
    seo_description: "Shop the Echos collection.",
    seo_noindex: false,
    sections: [CUSTOM_SECTION],
    published_sections: [],
    published_at: "2026-09-01T10:00:00.000000+00:00",
    updated_at: "2026-09-04T10:20:30.123456+00:00",
    ...overrides,
  };
}

describe("Phase 7A storefront context reads", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists bounded current-store pages and maps the homepage sentinel to home", async () => {
    execute.mockResolvedValue({
      rows: [
        {
          slug: "",
          title: "Home",
          status: "published",
          draft_section_count: 1,
          published_section_count: 0,
          has_unpublished_changes: true,
          published_at: "2026-09-01T10:00:00.000000+00:00",
          updated_at: "2026-09-04T10:20:30.123456+00:00",
        },
        {
          slug: "about-us",
          title: "About us",
          status: "draft",
          draft_section_count: 2,
          published_section_count: 0,
          has_unpublished_changes: true,
          published_at: null,
          updated_at: "2026-09-04T10:20:30.123456+00:00",
        },
      ],
    });
    const output = await readMinkStorefrontPages(ACTOR);

    expect(withService).toHaveBeenCalledOnce();
    expect(output.pages[0]).toMatchObject({
      pageSlug: "home",
      draftSectionCount: 1,
      publishedSectionCount: 0,
      hasUnpublishedChanges: true,
      requiresRepair: false,
    });
    const compiled = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(compiled.sql).not.toContain("store-1");
    expect(compiled.params).toContain("store-1");
    expect(compiled.sql).toContain("where store_id =");
    expect(compiled.sql).not.toMatch(/select[\s\S]*\n\s+sections,/);
    expect(compiled.sql).toContain("jsonb_array_length(sections)");
    expect(compiled.params).toContain(41);
  });

  it("returns exact page versions and section digests without exposing custom code", async () => {
    execute.mockResolvedValue({ rows: [pageRow()] });
    const output = await readMinkStorefrontPageContext(ACTOR, {
      pageSlug: "home",
    });

    expect(output.page).toMatchObject({
      pageSlug: "home",
      pageVersion: "2026-09-04T10:20:30.123456+00:00",
      hasUnpublishedChanges: true,
    });
    expect(output.sections[0]).toMatchObject({
      id: "section-1",
      position: 1,
      type: "custom_code",
      customCode: { htmlCharacters: 8_119 },
    });
    expect(output.sections[0].sectionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(output)).not.toContain("<section>");
    const compiled = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(compiled.params).toContain("store-1");
    expect(compiled.params).toContain("");
  });

  it("reads custom code only in bounded, resumable chunks", async () => {
    execute.mockResolvedValue({ rows: [pageRow()] });
    const output = await readMinkStorefrontSectionContext(ACTOR, {
      pageSlug: "home",
      sectionId: "section-1",
      codeField: "html",
      codeOffset: 0,
    });

    expect(output).toMatchObject({
      codeContentIncluded: true,
      codeChunk: {
        field: "html",
        offset: 0,
        totalCharacters: 8_119,
        hasMore: true,
        nextOffset: 8_000,
      },
    });
    expect(
      (output as { codeChunk: { content: string } }).codeChunk.content,
    ).toHaveLength(8_000);
  });

  it("fails closed for malformed stored sections and denies direct permission bypass", async () => {
    execute.mockResolvedValue({
      rows: [pageRow({ sections: [{ id: "bad", type: "unknown" }] })],
    });
    await expect(
      readMinkStorefrontPageContext(ACTOR, { pageSlug: "home" }),
    ).rejects.toThrow("cannot be inspected safely");

    execute.mockClear();
    await expect(
      readMinkStorefrontPages({ ...ACTOR, permissions: {} }),
    ).rejects.toThrow("Builder view permission");
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns only safe brand/theme/chrome fields and an actor-aware sandbox contract", async () => {
    execute.mockResolvedValueOnce({
      rows: [
        {
          name: "Echos",
          settings: {
            brand: {
              name: "Echos",
              logoUrl: "/echos-logo.png",
              primaryColor: "#6d4aff",
              tagline: "Designed for living",
              email: "private@echos.example",
              phone: "+919999999999",
              social: { instagram: "secret-social-handle" },
            },
            theme: { presetId: "basket", presetVersion: "1.0.0" },
            features: { "pages.customCode": true },
            internalSecret: "never-return-this",
          },
          chrome_store_id: "store-1",
          draft: {
            header: {
              links: [{ label: "Shop", href: "/shop" }],
              showSearch: true,
              showAccount: true,
              showCart: true,
              sticky: true,
            },
          },
          published: null,
          published_at: null,
          updated_at: "2026-09-04T10:20:30.123456+00:00",
        },
      ],
    });

    const output = await readMinkStorefrontDesignContext(ACTOR);
    expect(output).toMatchObject({
      brand: {
        name: "Echos",
        primaryColor: "#6d4aff",
        tagline: "Designed for living",
      },
      theme: { id: "basket", version: "1.0.0" },
      capabilities: { customCodeEnabled: true },
      sandboxContract: {
        phase: "7B",
        mode: "private_proposal_preview",
        authority: {
          canCreatePrivateProposal: false,
          canPreviewGeneratedCode: false,
          canSaveCode: false,
          canPublish: false,
        },
      },
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("private@echos.example");
    expect(serialized).not.toContain("+919999999999");
    expect(serialized).not.toContain("secret-social-handle");
    expect(serialized).not.toContain("never-return-this");
    expect(execute).toHaveBeenCalledTimes(1);
    for (const [statement] of execute.mock.calls) {
      const compiled = new PgDialect().sqlToQuery(statement);
      expect(compiled.params).toContain("store-1");
      expect(compiled.sql).not.toContain("store-1");
    }
  });
});
