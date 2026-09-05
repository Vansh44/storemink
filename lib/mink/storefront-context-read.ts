import "server-only";

import { sql } from "drizzle-orm";
import { can } from "@/app/dashboard/lib/permissions";
import { DEFAULT_CHROME, sanitizeChromeForSave } from "@/lib/chrome/types";
import { withService } from "@/lib/db/client";
import { resolveStoreSettings } from "@/lib/settings/registry";
import {
  summarizeSection,
  MAX_PAGE_SECTIONS,
  validatePageSlug,
  validateSections,
  type CustomCodeConfig,
  type PageSectionItem,
} from "@/lib/sections/registry";
import { brandFromSettings } from "@/lib/store/brand";
import { getThemeDefinition } from "@/lib/themes";
import { readThemeSelection } from "@/lib/themes/meta";
import { designToCssVars } from "@/lib/themes/types";
import { MinkToolInputError } from "./errors";
import {
  digestMinkStorefrontValue,
  MINK_STOREFRONT_CODE_CHUNK_CHARS,
  MINK_STOREFRONT_SANDBOX_CONTRACT,
} from "./storefront-code-contract";
import type { MinkActorContext } from "./types";

const MAX_PAGES = 40;
const MAX_SECTION_CONFIG_CHARS = 24_000;
const MAX_SUMMARY_CHARS = 240;
const MAX_CODE_OFFSET = 64 * 1024;

type PageRow = {
  slug: string;
  title: string;
  status: string;
  seo_title: string;
  seo_description: string;
  seo_noindex: boolean;
  sections: unknown;
  published_sections: unknown;
  published_at: string | null;
  updated_at: string;
};

type PageListRow = Pick<
  PageRow,
  "slug" | "title" | "status" | "published_at" | "updated_at"
> & {
  draft_section_count: number | null;
  published_section_count: number | null;
  has_unpublished_changes: boolean;
};

export interface MinkStorefrontSectionSummary {
  id: string;
  position: number;
  type: PageSectionItem["type"];
  enabled: boolean;
  summary: string;
  style?: PageSectionItem["style"];
  sectionDigest: string;
  configCharacters: number;
  customCode?: {
    htmlCharacters: number;
    cssCharacters: number;
    jsCharacters: number;
    htmlDigest: string;
    cssDigest: string;
    jsDigest: string;
    heightMode: "auto" | "fixed";
    fixedHeight: number;
  };
}

export async function readMinkStorefrontPages(actor: MinkActorContext) {
  assertBuilderView(actor);
  const result = await withService((db) =>
    db.execute(sql`
      select
        slug,
        title,
        status,
        case
          when jsonb_typeof(sections) = 'array'
            and jsonb_array_length(sections) <= ${MAX_PAGE_SECTIONS}
          then jsonb_array_length(sections)
          else null
        end as draft_section_count,
        case
          when jsonb_typeof(published_sections) = 'array'
            and jsonb_array_length(published_sections) <= ${MAX_PAGE_SECTIONS}
          then jsonb_array_length(published_sections)
          else null
        end as published_section_count,
        sections is distinct from published_sections as has_unpublished_changes,
        published_at,
        updated_at
      from store_pages
      where store_id = ${actor.storeId}
      order by case when slug = '' then 0 else 1 end, lower(title), slug
      limit ${MAX_PAGES + 1}
    `),
  );
  const rows = result.rows as PageListRow[];
  const pages = rows.slice(0, MAX_PAGES).map((row) => {
    const sectionArraysValid =
      row.draft_section_count !== null && row.published_section_count !== null;
    return {
      pageSlug: publicPageSlug(row.slug),
      title: boundedText(row.title, 120),
      status: boundedText(row.status, 30),
      draftSectionCount: row.draft_section_count,
      publishedSectionCount: row.published_section_count,
      hasUnpublishedChanges: sectionArraysValid
        ? row.has_unpublished_changes
        : null,
      requiresRepair: !sectionArraysValid,
      updatedAt: row.updated_at,
      publishedAt: row.published_at,
      dashboardPath: `/dashboard/builder?page=${encodeURIComponent(publicPageSlug(row.slug))}`,
    };
  });
  return {
    pages,
    truncated: rows.length > MAX_PAGES,
    contentTrust: "untrusted_storefront_data" as const,
    scope: "current_store" as const,
    dataAsOf: new Date().toISOString(),
    dashboardPath: "/dashboard/builder",
  };
}

export async function readMinkStorefrontPageContext(
  actor: MinkActorContext,
  input: { pageSlug: unknown },
) {
  assertBuilderView(actor);
  const pageSlug = readExactPageSlug(input.pageSlug);
  const row = await readPage(actor.storeId, storedPageSlug(pageSlug));
  const sections = validatedPageSections(row.sections, pageSlug, "draft");
  const publishedSections = validatedPageSections(
    row.published_sections,
    pageSlug,
    "published",
  );
  return {
    page: {
      pageSlug,
      title: boundedText(row.title, 120),
      status: boundedText(row.status, 30),
      seo: {
        title: boundedText(row.seo_title, 180),
        description: boundedText(row.seo_description, 500),
        noindex: row.seo_noindex === true,
      },
      pageVersion: row.updated_at,
      publishedAt: row.published_at,
      hasUnpublishedChanges:
        digestMinkStorefrontValue(sections) !==
        digestMinkStorefrontValue(publishedSections),
      draftSectionCount: sections.length,
      publishedSectionCount: publishedSections.length,
    },
    sections: sections.map(sectionSummary),
    contentTrust: "untrusted_storefront_data" as const,
    scope: "current_store" as const,
    dataAsOf: new Date().toISOString(),
    dashboardPath: `/dashboard/builder?page=${encodeURIComponent(pageSlug)}`,
  };
}

export async function readMinkStorefrontSectionContext(
  actor: MinkActorContext,
  input: {
    pageSlug: unknown;
    sectionId: unknown;
    codeField?: unknown;
    codeOffset?: unknown;
  },
) {
  assertBuilderView(actor);
  const pageSlug = readExactPageSlug(input.pageSlug);
  const sectionId = readExactSectionId(input.sectionId);
  const codeField = readCodeField(input.codeField);
  const codeOffset = readCodeOffset(input.codeOffset);
  if (!codeField && codeOffset > 0) {
    throw new MinkToolInputError(
      "code_field is required when code_offset is greater than zero.",
    );
  }
  const row = await readPage(actor.storeId, storedPageSlug(pageSlug));
  const sections = validatedPageSections(row.sections, pageSlug, "draft");
  const section = sections.find((candidate) => candidate.id === sectionId);
  if (!section) {
    throw new MinkToolInputError(
      `No section with exact id ${JSON.stringify(sectionId)} exists on page ${JSON.stringify(pageSlug)}.`,
    );
  }
  if (section.type !== "custom_code" && (codeField || codeOffset > 0)) {
    throw new MinkToolInputError(
      "code_field and code_offset are available only for a custom_code section.",
    );
  }

  const summary = sectionSummary(section, sections.indexOf(section));
  const base = {
    pageSlug,
    pageVersion: row.updated_at,
    section: summary,
    contentTrust: "untrusted_storefront_data" as const,
    scope: "current_store" as const,
    dataAsOf: new Date().toISOString(),
    dashboardPath: `/dashboard/builder?page=${encodeURIComponent(pageSlug)}&section=${encodeURIComponent(sectionId)}`,
  };
  if (section.type === "custom_code") {
    const config = section.config as CustomCodeConfig;
    if (!codeField) {
      return {
        ...base,
        config: {
          heightMode: config.height_mode,
          fixedHeight: config.fixed_height,
        },
        codeContentIncluded: false,
      };
    }
    const source = config[codeField];
    if (codeOffset > source.length) {
      throw new MinkToolInputError(
        `code_offset exceeds the ${codeField} field length of ${source.length}.`,
      );
    }
    const content = source.slice(
      codeOffset,
      codeOffset + MINK_STOREFRONT_CODE_CHUNK_CHARS,
    );
    const nextOffset = codeOffset + content.length;
    return {
      ...base,
      config: {
        heightMode: config.height_mode,
        fixedHeight: config.fixed_height,
      },
      codeContentIncluded: true,
      codeChunk: {
        field: codeField,
        offset: codeOffset,
        content,
        totalCharacters: source.length,
        hasMore: nextOffset < source.length,
        nextOffset: nextOffset < source.length ? nextOffset : null,
        fieldDigest: digestMinkStorefrontValue(source),
      },
    };
  }

  const serializedConfig = JSON.stringify(section.config);
  return {
    ...base,
    config:
      serializedConfig.length <= MAX_SECTION_CONFIG_CHARS
        ? section.config
        : undefined,
    configCharacters: serializedConfig.length,
    configTruncated: serializedConfig.length > MAX_SECTION_CONFIG_CHARS,
  };
}

export async function readMinkStorefrontDesignContext(actor: MinkActorContext) {
  assertBuilderView(actor);
  return withService(async (db) => {
    const result = await db.execute(sql`
      select
        store.name,
        store.settings,
        chrome.store_id as chrome_store_id,
        chrome.draft,
        chrome.published,
        chrome.published_at,
        chrome.updated_at
      from stores as store
      left join store_chrome as chrome on chrome.store_id = store.id
      where store.id = ${actor.storeId}
      limit 1
    `);
    const row = result.rows[0] as
      | {
          name: string;
          settings: unknown;
          chrome_store_id: string | null;
          draft: unknown;
          published: unknown;
          published_at: string | null;
          updated_at: string | null;
        }
      | undefined;
    if (!row) throw new Error("Store not found");
    const settings = isRecord(row.settings) ? row.settings : {};
    const brand = brandFromSettings(settings, row.name, "");
    const themeSelection = readThemeSelection(settings);
    const theme = themeSelection
      ? getThemeDefinition(themeSelection.id, themeSelection.version)
      : null;
    const draftChrome = row.chrome_store_id
      ? sanitizeChromeForSave(row.draft)
      : DEFAULT_CHROME;
    const publishedChrome = row.published
      ? sanitizeChromeForSave(row.published)
      : null;
    const resolvedSettings = resolveStoreSettings(
      settings,
      actor.effectivePlan,
    );
    return {
      brand: {
        name: boundedText(brand.name, 120),
        logoUrl: brand.logoUrl ? boundedText(brand.logoUrl, 1_024) : null,
        primaryColor: boundedText(brand.primaryColor, 40),
        tagline: brand.tagline ? boundedText(brand.tagline, 240) : null,
      },
      theme: theme
        ? {
            id: theme.id,
            name: theme.name,
            version: theme.release.version,
            engine: theme.engine,
            designTokens: designToCssVars(
              theme.preset.design,
              brand.primaryColor,
            ),
            layout: theme.preset.design.layout ?? {},
          }
        : {
            id: null,
            name: null,
            version: null,
            engine: null,
            designTokens: { "--brand-primary": brand.primaryColor },
            layout: {},
          },
      chrome: {
        draft: draftChrome,
        published: publishedChrome,
        chromeVersion: row.updated_at,
        publishedAt: row.published_at,
        hasUnpublishedChanges:
          publishedChrome === null ||
          digestMinkStorefrontValue(draftChrome) !==
            digestMinkStorefrontValue(publishedChrome),
      },
      capabilities: {
        customCodeEnabled: resolvedSettings["pages.customCode"] === true,
      },
      sandboxContract: {
        ...MINK_STOREFRONT_SANDBOX_CONTRACT,
        authority: {
          ...MINK_STOREFRONT_SANDBOX_CONTRACT.authority,
          canCreatePrivateProposal:
            actor.draftingEnabled === true &&
            can(actor.permissions, "builder", "manage", actor.isSuperadmin),
          canPreviewGeneratedCode:
            actor.draftingEnabled === true &&
            can(actor.permissions, "builder", "manage", actor.isSuperadmin),
        },
      },
      contentTrust: "untrusted_storefront_data" as const,
      scope: "current_store" as const,
      dataAsOf: new Date().toISOString(),
      dashboardPath: "/dashboard/builder",
    };
  });
}

async function readPage(storeId: string, slug: string): Promise<PageRow> {
  const result = await withService((db) =>
    db.execute(sql`
      select
        slug,
        title,
        status,
        seo_title,
        seo_description,
        seo_noindex,
        sections,
        published_sections,
        published_at,
        updated_at
      from store_pages
      where store_id = ${storeId}
        and slug = ${slug}
      limit 1
    `),
  );
  const row = result.rows[0] as PageRow | undefined;
  if (!row) {
    throw new MinkToolInputError(
      `No storefront page matches exact slug ${JSON.stringify(publicPageSlug(slug))}.`,
    );
  }
  return row;
}

function validatedPageSections(
  value: unknown,
  pageSlug: string,
  copy: "draft" | "published",
): PageSectionItem[] {
  const result = validateSections(value, { mode: "draft" });
  if ("error" in result) {
    throw new MinkToolInputError(
      `The ${copy} sections for page ${JSON.stringify(pageSlug)} cannot be inspected safely. Repair the page in Website Builder first.`,
    );
  }
  return result.sections;
}

function sectionSummary(
  section: PageSectionItem,
  index: number,
): MinkStorefrontSectionSummary {
  const serializedConfig = JSON.stringify(section.config);
  const customCode =
    section.type === "custom_code"
      ? (section.config as CustomCodeConfig)
      : null;
  return {
    id: section.id,
    position: index + 1,
    type: section.type,
    enabled: section.enabled,
    summary: boundedText(summarizeSection(section), MAX_SUMMARY_CHARS),
    ...(section.style ? { style: section.style } : {}),
    sectionDigest: digestMinkStorefrontValue(section),
    configCharacters: serializedConfig.length,
    ...(customCode
      ? {
          customCode: {
            htmlCharacters: customCode.html.length,
            cssCharacters: customCode.css.length,
            jsCharacters: customCode.js.length,
            htmlDigest: digestMinkStorefrontValue(customCode.html),
            cssDigest: digestMinkStorefrontValue(customCode.css),
            jsDigest: digestMinkStorefrontValue(customCode.js),
            heightMode: customCode.height_mode,
            fixedHeight: customCode.fixed_height,
          },
        }
      : {}),
  };
}

function assertBuilderView(actor: MinkActorContext): void {
  if (!can(actor.permissions, "builder", "view", actor.isSuperadmin)) {
    throw new Error("Builder view permission is required.");
  }
}

function readExactPageSlug(value: unknown): string {
  if (value === "home") return "home";
  if (typeof value !== "string") {
    throw new MinkToolInputError(
      "page_slug must be home or an exact page slug.",
    );
  }
  const validated = validatePageSlug(value);
  if ("error" in validated || validated.slug !== value) {
    throw new MinkToolInputError(
      "page_slug must be home or an exact normalized page slug returned by list_storefront_pages.",
    );
  }
  return validated.slug;
}

function readExactSectionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new MinkToolInputError(
      "section_id must be an exact section id returned by get_storefront_page_context.",
    );
  }
  return value;
}

function readCodeField(value: unknown): "html" | "css" | "js" | null {
  if (value === undefined) return null;
  if (value === "html" || value === "css" || value === "js") return value;
  throw new MinkToolInputError("code_field must be html, css, or js.");
}

function readCodeOffset(value: unknown): number {
  if (value === undefined) return 0;
  if (
    !Number.isInteger(value) ||
    Number(value) < 0 ||
    Number(value) > MAX_CODE_OFFSET
  ) {
    throw new MinkToolInputError(
      `code_offset must be an integer from 0 to ${MAX_CODE_OFFSET}.`,
    );
  }
  return Number(value);
}

function publicPageSlug(value: string): string {
  return value === "" ? "home" : value;
}

function storedPageSlug(value: string): string {
  return value === "home" ? "" : value;
}

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
