import { and, asc, desc, eq } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { blogs, categories, products, stores } from "@/drizzle/schema";
import { requireSectionAccess, getActingStoreId } from "../lib/access";
import { listPages, ensureHomepage } from "@/app/actions/page-actions";
import { getStoreBrand } from "@/lib/store/brand";
import { getDraftChromeForEditor } from "@/lib/chrome/queries";
import { DEFAULT_CHROME } from "@/lib/chrome/types";
import { themeDesignDefaults } from "@/lib/chrome/design";
import { getThemeDefinition } from "@/lib/themes";
import { readThemeSelection } from "@/lib/themes/meta";
import { BuilderClient } from "./builder-client";
import type { BlogOption, CategoryOption, ProductOption } from "./section-form";
import "./builder.css";

// The website builder is a full-viewport experience opened in a new tab. It
// still lives under /dashboard so the proxy auth gate applies.
export default async function BuilderPage() {
  await requireSectionAccess("builder", "view");

  const storeId = await getActingStoreId();

  const [homepage, pages, storeData, brand] = await Promise.all([
    ensureHomepage(),
    listPages(),
    withService(async (db) => {
      const productRows = await db
        .select({
          id: products.id,
          name: products.name,
          slug: products.slug,
          image_url: products.imageUrl,
          featured: products.featured,
        })
        .from(products)
        .where(eq(products.storeId, storeId))
        .orderBy(asc(products.sortOrder), asc(products.name));
      const categoryRows = await db
        .select({
          id: categories.id,
          name: categories.name,
          slug: categories.slug,
          image_url: categories.imageUrl,
        })
        .from(categories)
        .where(eq(categories.storeId, storeId))
        .orderBy(asc(categories.sortOrder), asc(categories.name));
      const blogRows = await db
        .select({ id: blogs.id, title: blogs.title, slug: blogs.slug })
        .from(blogs)
        .where(and(eq(blogs.storeId, storeId), eq(blogs.status, "published")))
        .orderBy(desc(blogs.publishedAt));
      return { productRows, categoryRows, blogRows };
    }).catch(() => ({
      productRows: [] as ProductOption[],
      categoryRows: [] as CategoryOption[],
      blogRows: [] as { id: string; title: string; slug: string }[],
    })),
    getStoreBrand(),
  ]);

  // The header + footer the merchant edits. Loaded here rather than fetched by
  // the client so the builder opens with its chrome already in hand — the
  // outline shows Header and Footer rows immediately, with no second spinner.
  const chrome = (await getDraftChromeForEditor(storeId)) ?? DEFAULT_CHROME;

  // What the pinned preset supplies for each overridable design token. The
  // panel needs it to show a real fallback rather than an empty box — a colour
  // input has no null, so without this a merchant cannot tell "I have not
  // chosen" from "I chose exactly this".
  const [storeRow] = await withService((db) =>
    db
      .select({ settings: stores.settings })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1),
  );
  const themeSelection = readThemeSelection(storeRow?.settings);
  const themeDefaults = themeDesignDefaults(
    themeSelection
      ? getThemeDefinition(themeSelection.id, themeSelection.version).preset
          .design
      : null,
  );

  const blogOptions: BlogOption[] = storeData.blogRows.map((b) => ({
    id: b.id,
    name: b.title,
    slug: b.slug,
  }));

  // The homepage sentinel (slug "") is pinned first in the builder; listPages
  // excludes it, so prepend it explicitly.
  const initialPages = homepage ? [homepage, ...pages] : pages;

  return (
    <BuilderClient
      initialPages={initialPages}
      products={storeData.productRows as ProductOption[]}
      categories={storeData.categoryRows as CategoryOption[]}
      blogs={blogOptions}
      storeName={brand.name}
      initialChrome={chrome}
      themeDefaults={themeDefaults}
      initialBrand={{
        name: brand.name,
        primaryColor: brand.primaryColor,
        logoUrl: brand.logoUrl,
      }}
    />
  );
}
