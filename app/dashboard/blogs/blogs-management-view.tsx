"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import Image from "next/image";
import Link from "next/link";
import {
  Check,
  Eye,
  FileText,
  ImageIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Send,
  Settings,
  Star,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  deleteBlog,
  publishBlog,
  unpublishBlog,
  approveCustomerBlog,
  rejectCustomerBlog,
  bulkSetBlogStatus,
  bulkSetBlogFeatured,
  bulkDeleteBlogs,
  getBlogForEditor,
} from "@/app/actions/blog-actions";
import { useRowSelection } from "@/app/dashboard/lib/use-row-selection";
import {
  BulkActionBar,
  RowCheckbox,
  SelectAllCheckbox,
} from "@/app/dashboard/components/bulk-actions";
import { ListPagination } from "@/app/dashboard/components/list-pagination";
import dynamic from "next/dynamic";
import type { Blog, BlogCounts, BlogFilter } from "./page";

// Lazy-load the editor dialog so its heavy TipTap/ProseMirror bundle downloads
// on first open instead of with the Blogs page. ssr:false (client-only); the
// mount latch in the component keeps it mounted after first open so the close
// animation still runs.
const BlogEditorDialog = dynamic(
  () => import("./blog-editor-dialog").then((m) => m.BlogEditorDialog),
  { ssr: false },
);

type Props = {
  blogs: Blog[];
  canManage?: boolean;
  counts: BlogCounts;
  total: number;
  page: number;
  pageSize: number;
  query: string;
  filter: BlogFilter;
  /** This store's blog categories/tags (managed in /dashboard/blogs/settings). */
  categoryOptions: string[];
  tagOptions: string[];
  /** Server-computed public prefix of this store's own GCS objects. */
  mediaUrlPrefix: string;
};

export function BlogsManagementView({
  blogs,
  canManage = true,
  counts,
  total,
  page,
  pageSize,
  query,
  filter,
  categoryOptions,
  tagOptions,
  mediaUrlPrefix,
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [navigating, startNavigation] = useTransition();
  const [search, setSearch] = useState(query);
  const [deleteTarget, setDeleteTarget] = useState<Blog | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Blog | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingBlog, setEditingBlog] = useState<Blog | null>(null);
  const [openingEditor, setOpeningEditor] = useState(false);
  // Latch: mount the lazy editor dialog on first open, then keep it mounted so
  // its close animation can play (and TipTap isn't re-fetched on reopen). The
  // "adjust state during render" pattern (same as the blog listing's page
  // reset) avoids a state-update-in-effect.
  const [editorEverOpened, setEditorEverOpened] = useState(false);
  if (editorOpen && !editorEverOpened) {
    setEditorEverOpened(true);
  }

  // ── URL-driven filter + search ────────────────────────────
  const hrefFor = (next: {
    q?: string;
    filter?: BlogFilter;
    page?: number;
  }): string => {
    const q = (next.q ?? query).trim();
    const f = next.filter ?? filter;
    const changedFacet = next.q !== undefined || next.filter !== undefined;
    const p = next.page ?? (changedFacet ? 1 : page);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (f !== "all") params.set("filter", f);
    if (p > 1) params.set("page", String(p));
    const qs = params.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

  const go = (next: Parameters<typeof hrefFor>[0]) =>
    startNavigation(() => router.push(hrefFor(next)));

  useEffect(() => {
    if (search.trim() === query.trim()) return;
    const handle = setTimeout(() => {
      startNavigation(() => router.push(hrefFor({ q: search })));
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  // ── Bulk selection (scoped to the current page) ───────────
  const visibleIds = useMemo(() => blogs.map((b) => b.id), [blogs]);
  const selection = useRowSelection(visibleIds);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const runBulk = (
    action: () => Promise<{ error?: string; success?: boolean }>,
    successMsg: string,
  ) => {
    startTransition(async () => {
      const result = await action();
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(successMsg);
        selection.clear();
        setBulkDeleteOpen(false);
        router.refresh();
      }
    });
  };

  // ── Actions ───────────────────────────────────────────────
  const handleDelete = () => {
    if (!deleteTarget) return;
    startTransition(async () => {
      const result = await deleteBlog(deleteTarget.id);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Blog deleted");
        setDeleteTarget(null);
        router.refresh();
      }
    });
  };

  const handleTogglePublish = (blog: Blog) => {
    startTransition(async () => {
      const action = blog.status === "published" ? unpublishBlog : publishBlog;
      const result = await action(blog.id);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(
          blog.status === "published" ? "Blog unpublished" : "Blog published",
        );
        router.refresh();
      }
    });
  };

  const handleApprove = (blog: Blog) => {
    startTransition(async () => {
      const result = await approveCustomerBlog(blog.id);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Blog approved and published!");
        router.refresh();
      }
    });
  };

  const handleReject = () => {
    if (!rejectTarget) return;
    startTransition(async () => {
      const result = await rejectCustomerBlog(rejectTarget.id);
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success("Blog rejected and deleted");
        setRejectTarget(null);
        router.refresh();
      }
    });
  };

  // The list omits the heavy `content` HTML, so fetch the full post before
  // opening the editor for an existing one. Never open with a half-loaded
  // object — saving that would blank the body. New posts open immediately.
  const openEditor = async (blog?: Blog) => {
    if (!blog) {
      setEditingBlog(null);
      setEditorOpen(true);
      return;
    }
    setOpeningEditor(true);
    const full = await getBlogForEditor(blog.id);
    setOpeningEditor(false);
    if (!full) {
      toast.error("Could not load this post. Please try again.");
      return;
    }
    setEditingBlog(full as unknown as Blog);
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditingBlog(null);
  };

  const handleEditorSaved = () => {
    closeEditor();
    router.refresh();
  };

  // ── Helpers ───────────────────────────────────────────────
  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "—";
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const tabs: {
    key: BlogFilter;
    label: string;
    count: number;
    alert?: boolean;
  }[] = [
    { key: "all", label: "All", count: counts.all },
    { key: "published", label: "Published", count: counts.published },
    { key: "drafts", label: "Drafts", count: counts.drafts },
    { key: "featured", label: "Featured", count: counts.featured },
    {
      key: "pending",
      label: "Pending",
      count: counts.pending,
      alert: counts.pending > 0,
    },
  ];

  // ── Render ────────────────────────────────────────────────
  return (
    <div className="dash-page-enter" aria-busy={openingEditor}>
      {/* Page Header */}
      <header className="dash-page-header row">
        <div>
          <h1>Blogs</h1>
          <p>Create, edit, and manage your blog posts</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/dashboard/blogs/settings"
            className="dash-btn dash-btn-ghost"
          >
            <Settings className="h-4 w-4" />
            Settings
          </Link>
          {canManage && (
            <button
              className="dash-btn dash-btn-primary shrink-0"
              disabled={openingEditor}
              onClick={() => openEditor()}
            >
              <Plus className="h-4 w-4" />
              New blog
            </button>
          )}
        </div>
      </header>

      {/* Toolbar: Tabs + Search */}
      <div className="dash-toolbar">
        <div className="dash-filter-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`dash-filter-tab${filter === tab.key ? " active" : ""}${
                tab.alert ? " has-alert" : ""
              }`}
              onClick={() => go({ filter: tab.key })}
            >
              {tab.label}
              <span className="dash-tab-count">{tab.count}</span>
            </button>
          ))}
        </div>

        <label className="dash-search-bar">
          <Search className="h-4 w-4 shrink-0 opacity-50" />
          <input
            type="text"
            placeholder="Search title, tags, categories..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>

      {/* Blog Table */}
      <div className="dash-card">
        <div className="dash-card-header">
          <div>
            <div className="dash-card-title">Blog posts</div>
            <div className="dash-card-sub">
              {total} {total === 1 ? "post" : "posts"}
              {navigating ? " · updating…" : ""}
            </div>
          </div>
        </div>

        {blogs.length === 0 ? (
          <div className="dash-empty">
            <span className="dash-empty-icon">
              <FileText className="h-5 w-5" />
            </span>
            <div className="dash-empty-title">
              {search || filter !== "all"
                ? "No blogs match your filters"
                : "No blogs yet"}
            </div>
            <p className="dash-empty-text">
              {search || filter !== "all"
                ? "Try adjusting your search or filter criteria."
                : "Create your first blog post to get started."}
            </p>
            {!search && filter === "all" && canManage && (
              <button
                className="dash-btn dash-btn-primary"
                onClick={() => openEditor()}
              >
                <Plus className="h-4 w-4" />
                New blog
              </button>
            )}
          </div>
        ) : (
          <table className="dash-table dash-table-wide">
            <thead>
              <tr>
                {canManage && (
                  <th className="dash-checkbox-cell">
                    <SelectAllCheckbox
                      checked={selection.allSelected}
                      indeterminate={selection.someSelected}
                      onChange={selection.toggleAll}
                    />
                  </th>
                )}
                <th className="w-14">Cover</th>
                <th>Title</th>
                <th>Categories</th>
                <th>Author</th>
                <th>Status</th>
                <th>Published</th>
                <th>Tags</th>
                {canManage && <th className="dash-col-actions">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {blogs.map((blog) => (
                <tr
                  key={blog.id}
                  className={
                    selection.isSelected(blog.id) ? "is-selected" : undefined
                  }
                >
                  {canManage && (
                    <td className="dash-col-actions dash-checkbox-cell">
                      <RowCheckbox
                        checked={selection.isSelected(blog.id)}
                        onToggle={() => selection.toggle(blog.id)}
                        label={`Select ${blog.title}`}
                      />
                    </td>
                  )}
                  {/* Cover */}
                  <td>
                    {blog.cover_image_url ? (
                      <div className="dash-thumb">
                        <Image
                          src={blog.cover_image_url}
                          alt={blog.title}
                          fill
                          sizes="48px"
                          className="object-cover"
                        />
                      </div>
                    ) : (
                      <div className="dash-thumb dash-thumb-empty">
                        <ImageIcon className="h-4 w-4" />
                      </div>
                    )}
                  </td>

                  {/* Title */}
                  <td>
                    <div className="dash-cell-title inline-flex items-center gap-1.5">
                      {blog.title}
                      {blog.featured && (
                        <Star
                          className="h-3.5 w-3.5 fill-[var(--dash-amber)] text-[var(--dash-amber)]"
                          aria-label="Featured"
                        />
                      )}
                    </div>
                    <div className="dash-cell-sub mono">/{blog.slug}</div>
                  </td>

                  {/* Category */}
                  <td>
                    {blog.categories && blog.categories.length > 0 ? (
                      <div className="dash-chip-row">
                        {blog.categories.map((c) => (
                          <span key={c} className="dash-chip">
                            {c}
                          </span>
                        ))}
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>

                  {/* Author */}
                  <td className="text-muted">
                    {blog.author || "—"}
                    {blog.is_customer_submission && blog.submitter_name && (
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className="dash-cell-sub">
                          {blog.submitter_name}
                        </span>
                        <span className="dash-badge dash-badge-violet">
                          Community
                        </span>
                      </div>
                    )}
                  </td>

                  {/* Status */}
                  <td>
                    <span
                      className={`dash-badge ${
                        blog.status === "published"
                          ? "dash-badge-green"
                          : blog.status === "pending_review"
                            ? "dash-badge-violet"
                            : "dash-badge-amber"
                      }`}
                    >
                      {blog.status === "published"
                        ? "Published"
                        : blog.status === "pending_review"
                          ? "Pending"
                          : "Draft"}
                    </span>
                  </td>

                  {/* Published date */}
                  <td className="text-dim font-mono-dash">
                    {formatDate(blog.published_at)}
                  </td>

                  {/* Tags */}
                  <td>
                    <div className="dash-chip-row max-w-[180px]">
                      {blog.tags.length > 0
                        ? blog.tags.slice(0, 3).map((tag) => (
                            <span key={tag} className="dash-chip">
                              {tag}
                            </span>
                          ))
                        : "—"}
                      {blog.tags.length > 3 && (
                        <span className="dash-chip">
                          +{blog.tags.length - 3}
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Actions */}
                  {canManage && (
                    <td className="dash-col-actions">
                      <DropdownMenu>
                        <DropdownMenuTrigger className="dash-row-menu">
                          <MoreHorizontal className="h-4 w-4" />
                          <span className="sr-only">Actions</span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="min-w-[180px]"
                        >
                          {blog.status === "pending_review" ? (
                            <>
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={() => openEditor(blog)}
                              >
                                <Pencil className="mr-2 h-4 w-4" />
                                Review &amp; edit
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="cursor-pointer text-[var(--dash-green)] focus:text-[var(--dash-green)]"
                                onClick={() => handleApprove(blog)}
                                disabled={isPending}
                              >
                                <Check className="mr-2 h-4 w-4" />
                                Approve
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                variant="destructive"
                                className="cursor-pointer"
                                onClick={() => setRejectTarget(blog)}
                              >
                                <X className="mr-2 h-4 w-4" />
                                Reject
                              </DropdownMenuItem>
                            </>
                          ) : (
                            <>
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={() => openEditor(blog)}
                              >
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={() => handleTogglePublish(blog)}
                                disabled={isPending}
                              >
                                {blog.status === "published" ? (
                                  <>
                                    <Undo2 className="mr-2 h-4 w-4" />
                                    Unpublish
                                  </>
                                ) : (
                                  <>
                                    <Send className="mr-2 h-4 w-4" />
                                    Publish
                                  </>
                                )}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="cursor-pointer"
                                onClick={() =>
                                  window.open(`/blogs/${blog.slug}`, "_blank")
                                }
                              >
                                <Eye className="mr-2 h-4 w-4" />
                                Preview
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                className="cursor-pointer"
                                onClick={() => setDeleteTarget(blog)}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <ListPagination
          page={page}
          total={total}
          pageSize={pageSize}
          busy={navigating}
          onPage={(p) => go({ page: p })}
        />
      </div>

      {/* Bulk action bar (appears while rows are selected) */}
      {canManage && (
        <BulkActionBar
          count={selection.count}
          onClear={selection.clear}
          busy={isPending}
        >
          <button
            type="button"
            className="dash-bulk-btn"
            disabled={isPending}
            onClick={() =>
              runBulk(
                () => bulkSetBlogStatus(selection.selectedIds, "published"),
                "Selected blogs published",
              )
            }
          >
            <Send className="h-4 w-4" />
            Publish
          </button>
          <button
            type="button"
            className="dash-bulk-btn"
            disabled={isPending}
            onClick={() =>
              runBulk(
                () => bulkSetBlogStatus(selection.selectedIds, "draft"),
                "Selected blogs unpublished",
              )
            }
          >
            <Undo2 className="h-4 w-4" />
            Unpublish
          </button>
          <button
            type="button"
            className="dash-bulk-btn"
            disabled={isPending}
            onClick={() =>
              runBulk(
                () => bulkSetBlogFeatured(selection.selectedIds, true),
                "Selected blogs featured",
              )
            }
          >
            <Star className="h-4 w-4" />
            Feature
          </button>
          <button
            type="button"
            className="dash-bulk-btn"
            disabled={isPending}
            onClick={() =>
              runBulk(
                () => bulkSetBlogFeatured(selection.selectedIds, false),
                "Selected blogs unfeatured",
              )
            }
          >
            <Star className="h-4 w-4" />
            Unfeature
          </button>
          <button
            type="button"
            className="dash-bulk-btn dash-bulk-btn-danger"
            disabled={isPending}
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </button>
        </BulkActionBar>
      )}

      {/* Bulk delete confirmation */}
      <Dialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => !open && setBulkDeleteOpen(false)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>
              Delete {selection.count} blog{selection.count === 1 ? "" : "s"}
            </DialogTitle>
            <DialogDescription>
              This permanently deletes the selected blog
              {selection.count === 1 ? "" : "s"} and their images. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isPending}
              onClick={() =>
                runBulk(
                  () => bulkDeleteBlogs(selection.selectedIds),
                  `Deleted ${selection.count} blog${selection.count === 1 ? "" : "s"}`,
                )
              }
            >
              {isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Delete blog</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{deleteTarget?.title}
              &rdquo;? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <p className="text-muted-foreground font-mono-dash text-sm">
              /{deleteTarget?.slug}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isPending}
            >
              {isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Confirmation Dialog */}
      <Dialog
        open={rejectTarget !== null}
        onOpenChange={(open) => !open && setRejectTarget(null)}
      >
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Reject submission</DialogTitle>
            <DialogDescription>
              Are you sure you want to reject &ldquo;{rejectTarget?.title}
              &rdquo;
              {rejectTarget?.submitter_name
                ? ` by ${rejectTarget.submitter_name}`
                : ""}
              ? This will permanently delete the submission.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <p className="text-muted-foreground font-mono-dash text-sm">
              /{rejectTarget?.slug}
            </p>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRejectTarget(null)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleReject}
              disabled={isPending}
            >
              {isPending ? "Rejecting..." : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Blog Editor Dialog — mounted on first open (lazy TipTap bundle) */}
      {(editorOpen || editorEverOpened) && (
        <BlogEditorDialog
          mediaUrlPrefix={mediaUrlPrefix}
          open={editorOpen}
          blog={editingBlog}
          onClose={closeEditor}
          onSaved={handleEditorSaved}
          categoryOptions={categoryOptions}
          tagOptions={tagOptions}
        />
      )}
    </div>
  );
}
