import { randomUUID } from "crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { and, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { dbErrorMessage } from "@/lib/db/errors";
import {
  categories,
  productVariants,
  products,
  storeMenus,
  storePages,
  stores,
} from "@/drizzle/schema";
import { STORE_TAG } from "@/lib/store/resolve";
import { TAGS } from "@/lib/storefront/tags";
import { sanitizeBlogContent } from "@/lib/sanitize";
import { resolveOptionRows } from "@/lib/products/options";
import {
  validateSections,
  type PageSectionItem,
  type RichTextConfig,
} from "@/lib/sections/registry";
import { resolveThemeDefinition } from "./runtime-registry";
import type { StoredThemeInstallation } from "./meta";
import type { ThemeDefinition } from "./types";

// ---------------------------------------------------------------------------
// applyTheme — seed (or re-seed) a store with a theme package: settings/brand,
// sample categories + products (+variants), menus, and pages (published).
//
// Design:
//  • SERVICE-ROLE scope (withService, BYPASSRLS), every write explicitly
//    store-scoped (same trust model as page-actions). Callers are trusted
//    server code only: createStore at signup, and the platform-operator
//    seedDemoStore action.
//  • BEST-EFFORT per entity with an errors accumulator — entities are
//    independent (a store with products but a failed page is still coherent),
//    and every write is an idempotent upsert keyed on (store_id, slug), so
//    re-running applyTheme heals a partial apply. Each independent write runs
//    in its OWN withService transaction so one failure can't roll back the rest.
//  • reset:true (demo stores only — refuses unless settings.demo === true)
//    clears the store's catalog/menus/pages first so demos stay theme-pristine.
// ---------------------------------------------------------------------------

export interface ApplyThemeResult {
  success: boolean;
  errors: string[];
}

export interface ApplyThemeOptions {
  publish: boolean;
  actorUserId?: string | null;
  reset?: boolean;
  /**
   * Publish the theme's SAMPLE products (default: seed them as drafts).
   *
   * Only the demo stores want them live. For a real merchant they are
   * placeholders that say so in their own copy — "Tomatoes (500 g) (Sample)",
   * "replace it with your own" — and publishing them means every store on
   * this theme serves the same handful of identical product pages under a
   * different subdomain. That is a near-duplicate cluster that competes with
   * the merchant's own products, and a shop whose live catalogue announces
   * itself as placeholder is worse for a visitor than one that is empty.
   *
   * As drafts they still appear in the dashboard, fully written, one click
   * from live — which is what makes them useful as a starting point.
   */
  publishSampleProducts?: boolean;
}

export async function applyTheme(
  storeId: string,
  themeId: unknown,
  options: ApplyThemeOptions,
): Promise<ApplyThemeResult> {
  return applyThemeDefinition(
    storeId,
    await resolveThemeDefinition(themeId),
    options,
  );
}

/**
 * Seed a store from a theme DEFINITION the caller already holds. applyTheme
 * resolves one from the registry; a Theme Studio preview passes a draft
 * version's definition, which the registry never serves.
 */
export async function applyThemeDefinition(
  storeId: string,
  theme: ThemeDefinition,
  {
    publish,
    actorUserId = null,
    reset = false,
    publishSampleProducts = false,
  }: ApplyThemeOptions,
): Promise<ApplyThemeResult> {
  const { preset } = theme;
  const errors: string[] = [];
  const fail = (step: string, message: string) => {
    console.error(`applyTheme(${theme.id}) ${step}:`, message);
    errors.push(`${step}: ${message}`);
  };

  // --- settings merge (template + brand accents; NEVER the store's name) ----
  let settings: Record<string, unknown>;
  try {
    const rows = await withService((db) =>
      db
        .select({ settings: stores.settings })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1),
    );
    if (!rows[0]) {
      return { success: false, errors: ["store lookup: not found"] };
    }
    settings = (rows[0].settings as Record<string, unknown>) ?? {};
  } catch (err) {
    return {
      success: false,
      errors: [`store lookup: ${dbErrorMessage(err, "failed")}`],
    };
  }

  if (reset && settings.demo !== true) {
    return {
      success: false,
      errors: ["reset refused: store is not a demo store (settings.demo)"],
    };
  }

  const existingBrand = (settings.brand as Record<string, unknown>) ?? {};
  const installation: StoredThemeInstallation = {
    presetId: theme.id,
    presetVersion: theme.release.version,
    engineId: theme.engine.id,
    engineVersion: theme.engine.version,
    appliedAt: new Date().toISOString(),
  };
  const mergedSettings = {
    ...settings,
    // `template` remains for old readers and old stores. `theme` is the new
    // pinned installation contract; future releases must not silently rewrite
    // a merchant's storefront merely because the catalog advanced.
    template: theme.id,
    theme: installation,
    brand: {
      ...existingBrand, // keeps the merchant's chosen name/logo
      primaryColor: preset.brand.primaryColor,
      tagline: existingBrand.tagline ?? preset.brand.tagline ?? null,
      blurb: existingBrand.blurb ?? preset.brand.blurb ?? null,
    },
  };
  try {
    await withService((db) =>
      db
        .update(stores)
        .set({ settings: mergedSettings })
        .where(eq(stores.id, storeId)),
    );
  } catch (err) {
    fail("settings", dbErrorMessage(err, "update failed"));
  }

  // --- reset (demo reseed) ---------------------------------------------------
  if (reset) {
    // products cascade their variants (FK); pages/menus/categories are flat.
    // Each delete runs in its own transaction so one failure can't abort the
    // rest (best-effort, mirroring the original per-request semantics).
    const resetTargets = [
      ["products", products],
      ["categories", categories],
      ["store_pages", storePages],
      ["store_menus", storeMenus],
    ] as const;
    for (const [label, table] of resetTargets) {
      try {
        await withService((db) =>
          db.delete(table).where(eq(table.storeId, storeId)),
        );
      } catch (err) {
        fail(`reset ${label}`, dbErrorMessage(err, "delete failed"));
      }
    }
  }

  // --- sample categories + products ------------------------------------------
  const categoryIdBySlug = new Map<string, string>();
  if (preset.sampleData) {
    for (const c of preset.sampleData.categories) {
      try {
        const [row] = await withService((db) =>
          db
            .insert(categories)
            .values({
              storeId,
              name: c.name,
              slug: c.slug,
              description: c.description ?? null,
              imageUrl: c.image_url ?? null,
              sortOrder: c.sort_order ?? 0,
              status: "active",
            })
            .onConflictDoUpdate({
              target: [categories.storeId, categories.slug],
              set: {
                name: c.name,
                description: c.description ?? null,
                imageUrl: c.image_url ?? null,
                sortOrder: c.sort_order ?? 0,
                status: "active",
              },
            })
            .returning({ id: categories.id, slug: categories.slug }),
        );
        if (!row) {
          fail(`category ${c.slug}`, "no row");
          continue;
        }
        categoryIdBySlug.set(row.slug, row.id);
      } catch (err) {
        fail(`category ${c.slug}`, dbErrorMessage(err, "upsert failed"));
      }
    }

    for (const p of preset.sampleData.products) {
      // Option axes seed exactly as the product editor saves them. A seed
      // whose combinations do not add up keeps its variants as a flat list
      // (and says so) rather than writing options the storefront would
      // refuse to render as pickers.
      const optionRows = resolveOptionRows(p.options, p.variants ?? []);
      if ("error" in optionRows) fail(`options ${p.slug}`, optionRows.error);
      const seedOptions = "error" in optionRows ? [] : optionRows.options;
      const seedVariants =
        "error" in optionRows
          ? (p.variants ?? []).map((v) => ({ ...v, option_values: [] }))
          : optionRows.variants;
      let productId: string;
      try {
        const [row] = await withService((db) =>
          db
            .insert(products)
            // sku / sku_no are NOT NULL but owned by the BEFORE-INSERT trigger
            // (identifiers_04_triggers.sql) — the app never sends them, so the
            // insert type is asserted past those two columns.
            .values({
              storeId,
              name: p.name,
              slug: p.slug,
              description: p.description,
              categoryId: categoryIdBySlug.get(p.category_slug) ?? null,
              basePrice: p.base_price,
              sellingPrice: p.selling_price,
              imageUrl: p.image_url,
              images: p.images ?? [],
              status: publishSampleProducts ? "published" : "draft",
              featured: p.featured ?? false,
              sortOrder: p.sort_order ?? 0,
              cardColor: p.card_color ?? null,
              options: seedOptions,
              publishedAt: publishSampleProducts
                ? new Date().toISOString()
                : null,
              createdBy: actorUserId,
              updatedBy: actorUserId,
            } as typeof products.$inferInsert)
            .onConflictDoUpdate({
              target: [products.storeId, products.slug],
              set: {
                name: p.name,
                description: p.description,
                categoryId: categoryIdBySlug.get(p.category_slug) ?? null,
                basePrice: p.base_price,
                sellingPrice: p.selling_price,
                imageUrl: p.image_url,
                images: p.images ?? [],
                // Re-applying keeps the same publish rule as the first apply:
                // an unconditional "published" here would put a merchant's
                // draft sample products live on any re-seed.
                status: publishSampleProducts ? "published" : "draft",
                featured: p.featured ?? false,
                sortOrder: p.sort_order ?? 0,
                cardColor: p.card_color ?? null,
                options: seedOptions,
                publishedAt: publishSampleProducts
                  ? new Date().toISOString()
                  : null,
                updatedBy: actorUserId,
              },
            })
            .returning({ id: products.id }),
        );
        if (!row) {
          fail(`product ${p.slug}`, "no row");
          continue;
        }
        productId = row.id;
      } catch (err) {
        fail(`product ${p.slug}`, dbErrorMessage(err, "upsert failed"));
        continue;
      }

      // Replace variants (mirrors product-actions' replaceVariants). Clear and
      // insert are separate transactions so a clear failure still lets the
      // insert run, matching the original per-request best-effort behaviour.
      try {
        await withService((db) =>
          db
            .delete(productVariants)
            .where(
              and(
                eq(productVariants.storeId, storeId),
                eq(productVariants.productId, productId),
              ),
            ),
        );
      } catch (err) {
        fail(`variants(clear) ${p.slug}`, dbErrorMessage(err, "delete failed"));
      }

      const variants = seedVariants.map((v, i) => ({
        storeId,
        productId,
        name: v.name,
        basePrice: v.base_price,
        sellingPrice: v.selling_price,
        specialPrice: v.special_price ?? null,
        stock: v.stock,
        // sku / variant_no are trigger-owned; a null sku lets the trigger fill it.
        sku: v.sku ?? null,
        sortOrder: v.sort_order ?? i,
        images: v.images ?? [],
        optionValues: v.option_values,
      }));
      if (variants.length > 0) {
        try {
          await withService((db) =>
            db
              .insert(productVariants)
              .values(variants as (typeof productVariants.$inferInsert)[]),
          );
        } catch (err) {
          fail(`variants ${p.slug}`, dbErrorMessage(err, "insert failed"));
        }
      }
    }
  }

  // --- menus -------------------------------------------------------------------
  try {
    await withService((db) =>
      db
        .insert(storeMenus)
        .values({
          storeId,
          header: preset.menus.header,
          footerGroups: preset.menus.footerGroups,
          footerLegal: preset.menus.footerLegal,
          updatedBy: actorUserId,
        })
        .onConflictDoUpdate({
          target: storeMenus.storeId,
          set: {
            header: preset.menus.header,
            footerGroups: preset.menus.footerGroups,
            footerLegal: preset.menus.footerLegal,
            updatedBy: actorUserId,
          },
        }),
    );
  } catch (err) {
    fail("menus", dbErrorMessage(err, "upsert failed"));
  }

  // --- pages ---------------------------------------------------------------------
  for (const page of preset.pages) {
    const sections = prepareSections(theme, page.slug);
    if ("error" in sections) {
      fail(`page ${page.slug || "(home)"}`, sections.error);
      continue;
    }
    const insertRow: typeof storePages.$inferInsert = {
      storeId,
      slug: page.slug,
      title: page.title,
      seoTitle: page.seo_title ?? "",
      seoDescription: page.seo_description ?? "",
      seoNoindex: false,
      sections: sections.sections,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    };
    const updateSet: Partial<typeof storePages.$inferInsert> = {
      title: page.title,
      seoTitle: page.seo_title ?? "",
      seoDescription: page.seo_description ?? "",
      seoNoindex: false,
      sections: sections.sections,
      updatedBy: actorUserId,
    };
    if (publish) {
      const publishedAt = new Date().toISOString();
      insertRow.publishedSections = sections.sections;
      insertRow.status = "published";
      insertRow.publishedAt = publishedAt;
      updateSet.publishedSections = sections.sections;
      updateSet.status = "published";
      updateSet.publishedAt = publishedAt;
    }
    try {
      await withService((db) =>
        db
          .insert(storePages)
          .values(insertRow)
          .onConflictDoUpdate({
            target: [storePages.storeId, storePages.slug],
            set: updateSet,
          }),
      );
    } catch (err) {
      fail(
        `page ${page.slug || "(home)"}`,
        dbErrorMessage(err, "upsert failed"),
      );
    }
  }

  // --- cache busting -----------------------------------------------------------
  revalidateTag(STORE_TAG, "max");
  revalidateTag(TAGS.pages, "max");
  revalidateTag(TAGS.products, "max");
  revalidateTag(TAGS.categories, "max");
  revalidateTag(TAGS.menus, "max");
  revalidatePath("/");

  return { success: errors.length === 0, errors };
}

/**
 * Validate a theme page's sections (strict publish mode), regenerate ids as
 * real UUIDs, and sanitize rich_text HTML — the same server rules every other
 * write path applies.
 */
function prepareSections(
  theme: ThemeDefinition,
  pageSlug: string,
): { sections: PageSectionItem[] } | { error: string } {
  const page = theme.preset.pages.find((p) => p.slug === pageSlug);
  if (!page) return { error: "page missing from theme" };

  const withIds = page.sections.map((s) => ({ ...s, id: randomUUID() }));
  const validated = validateSections(withIds, { mode: "publish" });
  if ("error" in validated) return validated;

  return {
    sections: validated.sections.map((s) =>
      s.type === "rich_text"
        ? {
            ...s,
            config: {
              ...(s.config as RichTextConfig),
              html: sanitizeBlogContent((s.config as RichTextConfig).html),
            },
          }
        : s,
    ),
  };
}
