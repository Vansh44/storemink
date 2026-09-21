import { and, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { blogs as blogsTable, users } from "@/drizzle/schema";
import { requireSectionAccess, getActingStoreId } from "../lib/access";
import {
  DASHBOARD_PAGE_SIZE,
  pickPage,
  pickParam,
  sanitizeSearch,
} from "../lib/list-params";
import { RealtimeRefresher } from "../components/realtime-refresher";
import { fetchBlogTaxonomy } from "@/lib/blog-taxonomy";
import { gcsConfigured, gcsPublicUrl } from "@/lib/storage/gcs";
import { storeStoragePrefix } from "@/lib/storage/paths";
import { BlogsManagementView } from "./blogs-management-view";

export interface Blog {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  content: string | null;
  cover_image_url: string | null;
  author: string | null;
  status: "draft" | "published" | "pending_review";
  tags: string[];
  categories: string[] | null;
  featured: boolean;
  seo_title: string | null;
  seo_description: string | null;
  reading_time: number | null;
  created_by: string | null;
  updated_by: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  submitted_by: string | null;
  is_customer_submission: boolean;
  // Joined field
  submitter_name?: string | null;
}

export type BlogFilter =
  | "all"
  | "published"
  | "drafts"
  | "featured"
  | "pending";
const FILTER_TABS: BlogFilter[] = [
  "all",
  "published",
  "drafts",
  "featured",
  "pending",
];

export interface BlogCounts {
  all: number;
  published: number;
  drafts: number;
  featured: number;
  pending: number;
}

// Everything except the heavy `content` HTML — the list never renders it, and
// the editor re-fetches the full post (getBlogForEditor) when opening one.
// Aliased select preserving the snake_case shape the view expects.
const LIST_COLUMNS = {
  id: blogsTable.id,
  title: blogsTable.title,
  slug: blogsTable.slug,
  excerpt: blogsTable.excerpt,
  cover_image_url: blogsTable.coverImageUrl,
  author: blogsTable.author,
  status: blogsTable.status,
  tags: blogsTable.tags,
  categories: blogsTable.categories,
  featured: blogsTable.featured,
  seo_title: blogsTable.seoTitle,
  seo_description: blogsTable.seoDescription,
  reading_time: blogsTable.readingTime,
  created_by: blogsTable.createdBy,
  updated_by: blogsTable.updatedBy,
  published_at: blogsTable.publishedAt,
  created_at: blogsTable.createdAt,
  updated_at: blogsTable.updatedAt,
  submitted_by: blogsTable.submittedBy,
  is_customer_submission: blogsTable.isCustomerSubmission,
};

export default async function BlogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await requireSectionAccess("blogs", "view");
  const canManage = access.can("blogs", "manage");

  const sp = await searchParams;
  const page = pickPage(sp.page);
  const q = pickParam(sp.q);
  const filterParam = pickParam(sp.filter) as BlogFilter;
  const filter = FILTER_TABS.includes(filterParam) ? filterParam : "all";
  const pageSize = DASHBOARD_PAGE_SIZE;
  const offset = (page - 1) * pageSize;

  const storeId = await getActingStoreId();

  const conds = [eq(blogsTable.storeId, storeId)];
  if (filter === "published") conds.push(eq(blogsTable.status, "published"));
  else if (filter === "drafts") conds.push(eq(blogsTable.status, "draft"));
  else if (filter === "pending")
    conds.push(eq(blogsTable.status, "pending_review"));
  else if (filter === "featured") conds.push(eq(blogsTable.featured, true));

  const term = sanitizeSearch(q);
  if (term) {
    const pat = `%${term}%`;
    conds.push(
      or(
        ilike(blogsTable.title, pat),
        ilike(blogsTable.slug, pat),
        ilike(blogsTable.excerpt, pat),
        ilike(blogsTable.author, pat),
      )!,
    );
  }
  const whereExpr = and(...conds);

  let rows: Omit<Blog, "content" | "submitter_name">[];
  let total: number;
  let statusRows: { status: string; n: number }[];
  let featuredCount: number;
  let taxonomy: Awaited<ReturnType<typeof fetchBlogTaxonomy>>;
  try {
    [{ rows, total, statusRows, featuredCount }, taxonomy] = await Promise.all([
      withService(async (db) => {
        const rows = await db
          .select(LIST_COLUMNS)
          .from(blogsTable)
          .where(whereExpr)
          .orderBy(desc(blogsTable.createdAt))
          .limit(pageSize)
          .offset(offset);
        const countRows = await db
          .select({ n: count() })
          .from(blogsTable)
          .where(whereExpr);
        // One grouped count for the status tabs instead of a head-count
        // per tab; featured is a separate dimension.
        const statusRows = await db
          .select({ status: blogsTable.status, n: count() })
          .from(blogsTable)
          .where(eq(blogsTable.storeId, storeId))
          .groupBy(blogsTable.status);
        const featuredRows = await db
          .select({ n: count() })
          .from(blogsTable)
          .where(
            and(eq(blogsTable.storeId, storeId), eq(blogsTable.featured, true)),
          );
        return {
          rows: rows as Omit<Blog, "content" | "submitter_name">[],
          total: countRows[0]?.n ?? 0,
          statusRows,
          featuredCount: featuredRows[0]?.n ?? 0,
        };
      }),
      // This store's category/tag options for the editor dialog.
      fetchBlogTaxonomy(storeId),
    ]);
  } catch (err) {
    console.error("BlogsPage load error:", err);
    return (
      <div className="max-w-md border border-destructive/20 bg-destructive/5 p-6 text-sm text-destructive">
        <div className="mb-1 flex items-center gap-2 font-semibold">
          <span>⚠️</span> Failed to load blogs
        </div>
        <p className="leading-relaxed text-destructive/80">
          Make sure you have the correct permissions and the blogs table exists
          in your database.
        </p>
      </div>
    );
  }

  const counts: BlogCounts = {
    all: 0,
    published: 0,
    drafts: 0,
    featured: featuredCount,
    pending: 0,
  };
  for (const row of statusRows) {
    counts.all += row.n;
    if (row.status === "published") counts.published = row.n;
    else if (row.status === "draft") counts.drafts = row.n;
    else if (row.status === "pending_review") counts.pending = row.n;
  }

  // Resolve submitter names for the customer submissions ON THIS PAGE only.
  const blogsWithSubmitters = rows.map((r) => ({
    ...r,
    content: null,
  })) as Blog[];
  const submitterIds = [
    ...new Set(
      blogsWithSubmitters
        .filter((b) => b.submitted_by)
        .map((b) => b.submitted_by as string),
    ),
  ];

  if (submitterIds.length > 0) {
    // Use the service scope: `users` RLS only lets a customer read their own
    // row, so the admin session can't resolve submitter names.
    try {
      const customers = await withService((db) =>
        db
          .select({
            id: users.id,
            first_name: users.firstName,
            last_name: users.lastName,
          })
          .from(users)
          .where(inArray(users.id, submitterIds)),
      );
      const nameMap = new Map(
        customers.map((c) => [
          c.id,
          [c.first_name, c.last_name].filter(Boolean).join(" ") || "Unknown",
        ]),
      );
      blogsWithSubmitters.forEach((blog) => {
        if (blog.submitted_by) {
          blog.submitter_name = nameMap.get(blog.submitted_by) ?? null;
        }
      });
    } catch (err) {
      console.error("BlogsPage submitter lookup error:", err);
    }
  }

  return (
    <>
      <RealtimeRefresher tables={["blogs"]} />
      <BlogsManagementView
        blogs={blogsWithSubmitters}
        canManage={canManage}
        counts={counts}
        total={total}
        page={page}
        pageSize={pageSize}
        query={q}
        filter={filter}
        categoryOptions={taxonomy.categories.map((c) => c.name)}
        tagOptions={taxonomy.tags.map((t) => t.name)}
        mediaUrlPrefix={
          gcsConfigured ? gcsPublicUrl(storeStoragePrefix(storeId)) : ""
        }
      />
    </>
  );
}
