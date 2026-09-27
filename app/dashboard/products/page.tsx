import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
} from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { categories, productVariants, products } from "@/drizzle/schema";
import { PRODUCT_COLUMNS } from "./columns";
import { requireSectionAccess, getActingStoreId } from "../lib/access";
import {
  DASHBOARD_PAGE_SIZE,
  pickPage,
  pickParam,
  sanitizeSearch,
} from "../lib/list-params";
import { ProductsManagementView } from "./products-management-view";
import { RealtimeRefresher } from "../components/realtime-refresher";
import { storeHasAnalyticsFeature } from "@/lib/analytics/store-entitlement";
import { getStorePlanContext } from "@/lib/plans/entitlements";

export type ProductFilter = "all" | "published" | "drafts" | "featured";
const PRODUCT_FILTERS: ProductFilter[] = [
  "all",
  "published",
  "drafts",
  "featured",
];

export interface ProductCounts {
  all: number;
  published: number;
  drafts: number;
  featured: number;
}

export interface ProductVariant {
  id: string;
  product_id: string;
  name: string;
  base_price: number;
  selling_price: number;
  cost_price: number | null;
  special_price: number | null;
  stock: number;
  sku: string | null;
  /** Merchant-entered supplier barcode (pos_06) — what the register scans. */
  barcode: string | null;
  requires_shipping: boolean | null;
  weight_grams: number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  image_url: string | null;
  images: string[] | null;
  sort_order: number;
  /** Positional values on the product's options; empty without options. */
  option_values?: string[];
  created_at: string;
}

export interface ProductCategoryRef {
  id: string;
  name: string;
  slug: string;
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category_id: string | null;
  base_price: number;
  selling_price: number;
  cost_price: number | null;
  image_url: string | null;
  images: string[];
  status: "draft" | "published";
  featured: boolean;
  sort_order: number;
  card_color: string | null;
  /** Raw stored option axes; read through normalizeOptions before use. */
  options?: unknown;
  seo_title: string | null;
  seo_description: string | null;
  published_at: string | null;
  track_inventory: boolean;
  stock: number;
  low_stock_threshold: number | null;
  allow_backorder: boolean;
  sku: string | null;
  barcode: string | null;
  tax_class_id: string | null;
  hsn_code: string | null;
  // Return policy (returns_01_product_policy.sql)
  returnable: boolean;
  return_window_days: number | null;
  requires_shipping: boolean;
  weight_grams: number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  created_at: string;
  updated_at: string;
  // Joined
  category: ProductCategoryRef | null;
  variants: ProductVariant[];
}

export interface CategoryOption {
  id: string;
  name: string;
  slug: string;
  status: "active" | "hidden";
}

export interface TaxClassOption {
  id: string;
  name: string;
  rate: number;
}

export interface CardColorOption {
  id: string;
  name: string;
  hex: string;
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireSectionAccess("products", "view");
  const canManage = access.can("products", "manage");

  const sp = await searchParams;
  const page = pickPage(sp.page);
  const q = pickParam(sp.q);
  const categoryFilter = pickParam(sp.category) || "all";
  const filterParam = pickParam(sp.filter) as ProductFilter;
  const filter = PRODUCT_FILTERS.includes(filterParam) ? filterParam : "all";
  const pageSize = DASHBOARD_PAGE_SIZE;
  const from = (page - 1) * pageSize;

  const storeId = await getActingStoreId();
  const planContext = await getStorePlanContext(storeId);
  const canUseGrossMargin = await storeHasAnalyticsFeature(
    storeId,
    "grossMargin",
  );

  const conds = [eq(products.storeId, storeId)];
  if (filter === "published") conds.push(eq(products.status, "published"));
  else if (filter === "drafts") conds.push(eq(products.status, "draft"));
  else if (filter === "featured") conds.push(eq(products.featured, true));

  if (categoryFilter === "uncategorized")
    conds.push(isNull(products.categoryId));
  else if (categoryFilter !== "all")
    conds.push(eq(products.categoryId, categoryFilter));

  const term = sanitizeSearch(q);
  if (term) {
    const pat = `%${term}%`;
    conds.push(or(ilike(products.name, pat), ilike(products.slug, pat))!);
  }
  const whereExpr = and(...conds);

  let list: Product[];
  let total: number;
  let counts: ProductCounts;
  let categoryOptions: CategoryOption[];
  let missingCostCount = 0;
  try {
    const result = await withService(async (db) => {
      const rows = await db
        .select({
          ...PRODUCT_COLUMNS,
          cat_id: categories.id,
          cat_name: categories.name,
          cat_slug: categories.slug,
        })
        .from(products)
        .leftJoin(categories, eq(products.categoryId, categories.id))
        .where(whereExpr)
        .orderBy(asc(products.sortOrder), desc(products.createdAt))
        .limit(pageSize)
        .offset(from);
      const countRows = await db
        .select({ n: count() })
        .from(products)
        .where(whereExpr);
      // One grouped count for the status tabs; featured is its own dimension.
      const statusRows = await db
        .select({ status: products.status, n: count() })
        .from(products)
        .where(eq(products.storeId, storeId))
        .groupBy(products.status);
      const featuredRows = await db
        .select({ n: count() })
        .from(products)
        .where(and(eq(products.storeId, storeId), eq(products.featured, true)));
      const missingCostRows = canUseGrossMargin
        ? await db
            .select({ n: count() })
            .from(products)
            .where(
              and(eq(products.storeId, storeId), isNull(products.costPrice)),
            )
        : [{ n: 0 }];
      const categoryRows = await db
        .select({
          id: categories.id,
          name: categories.name,
          slug: categories.slug,
          status: categories.status,
        })
        .from(categories)
        .where(eq(categories.storeId, storeId))
        .orderBy(asc(categories.sortOrder), asc(categories.name));

      // The list view only shows a variant COUNT (editing re-fetches the full
      // product + variants via /dashboard/products/[id]), so pull just variant
      // ids for the products on this page.
      const pageIds = rows.map((r) => r.id);
      const variantIds = pageIds.length
        ? await db
            .select({
              id: productVariants.id,
              product_id: productVariants.productId,
            })
            .from(productVariants)
            .where(inArray(productVariants.productId, pageIds))
        : [];

      return {
        rows,
        total: countRows[0]?.n ?? 0,
        statusRows,
        featuredCount: featuredRows[0]?.n ?? 0,
        missingCostCount: missingCostRows[0]?.n ?? 0,
        categoryRows,
        variantIds,
      };
    });

    const variantsByProduct = new Map<string, { id: string }[]>();
    for (const v of result.variantIds) {
      const listForProduct = variantsByProduct.get(v.product_id) ?? [];
      listForProduct.push({ id: v.id });
      variantsByProduct.set(v.product_id, listForProduct);
    }

    list = result.rows.map((row) => {
      const { cat_id, cat_name, cat_slug, ...productFields } = row;
      return {
        ...productFields,
        category: cat_id
          ? { id: cat_id, name: cat_name!, slug: cat_slug! }
          : null,
        variants: variantsByProduct.get(row.id) ?? [],
      };
    }) as unknown as Product[];
    total = result.total;
    missingCostCount = result.missingCostCount;

    counts = {
      all: 0,
      published: 0,
      drafts: 0,
      featured: result.featuredCount,
    };
    for (const row of result.statusRows) {
      counts.all += row.n;
      if (row.status === "published") counts.published = row.n;
      else if (row.status === "draft") counts.drafts = row.n;
    }

    categoryOptions = result.categoryRows as CategoryOption[];
  } catch (err) {
    console.error("ProductsPage load error:", err);
    return (
      <div className="max-w-md border border-destructive/20 bg-destructive/5 p-6 text-sm text-destructive">
        <div className="mb-1 flex items-center gap-2 font-semibold">
          <span>⚠️</span> Failed to load products
        </div>
        <p className="leading-relaxed text-destructive/80">
          Make sure the <code>products</code>, <code>categories</code> and{" "}
          <code>product_variants</code> tables exist and you have the correct
          permissions.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Live updates: reflect stock changes from checkout + other admins' edits. */}
      <RealtimeRefresher tables={["products", "product_variants"]} />
      <ProductsManagementView
        products={list}
        categories={categoryOptions}
        canManage={canManage}
        counts={counts}
        total={total}
        page={page}
        pageSize={pageSize}
        query={q}
        filter={filter}
        categoryFilter={categoryFilter}
        canUseGrossMargin={canUseGrossMargin}
        missingCostCount={missingCostCount}
        canCreateProduct={
          canManage &&
          (planContext.limits.maxProducts === null ||
            counts.all < planContext.limits.maxProducts)
        }
        productLimit={planContext.limits.maxProducts}
      />
    </>
  );
}
