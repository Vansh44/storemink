/* eslint-disable @next/next/no-img-element */
/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { MediaPickerDialog } from "./media-picker-dialog";
import NextLink from "next/link";
import { useState, useEffect, useCallback, useRef, useTransition } from "react";
import { toast } from "sonner";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import ImageExtension from "@tiptap/extension-image";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Heading1,
  Heading2,
  Heading3,
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  List,
  ListOrdered,
  Quote,
  Code,
  Minus,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Link as LinkIcon,
  Image as ImageIcon,
  ArrowLeft,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  createBlog,
  updateBlog,
  autosaveBlog,
} from "@/app/actions/blog-actions";
import type { BlogFormData } from "@/app/actions/blog-actions";
import type { Blog } from "./page";
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";

// ── Helpers ───────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function calcReadingTime(html: string): number {
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const count = text.split(" ").filter(Boolean).length;
  return Math.max(1, Math.ceil(count / 200));
}

// ── Types ─────────────────────────────────────────────────────

type Props = {
  open: boolean;
  blog: Blog | null;
  onClose: () => void;
  onSaved: () => void;
  /** This store's blog categories/tags (managed in /dashboard/blogs/settings). */
  categoryOptions: string[];
  tagOptions: string[];
  /** Server-computed public prefix of this store's own GCS objects. */
  mediaUrlPrefix: string;
};

// ── Component ─────────────────────────────────────────────────

const ToolbarButton = ({
  onClick,
  active,
  title: btnTitle,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    title={btnTitle}
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "6px",
      borderRadius: "4px",
      border: "none",
      cursor: "pointer",
      background: active ? "#e8f0fe" : "transparent",
      color: active ? "#1a73e8" : "#444746",
      transition: "background 0.2s",
    }}
    onMouseEnter={(e) => {
      if (!active) e.currentTarget.style.background = "#f0f4f9";
    }}
    onMouseLeave={(e) => {
      if (!active) e.currentTarget.style.background = "transparent";
    }}
    onMouseDown={(e) => e.preventDefault()}
  >
    {children}
  </button>
);

export function BlogEditorDialog({
  open,
  blog,
  onClose,
  onSaved,
  categoryOptions,
  tagOptions,
  mediaUrlPrefix,
}: Props) {
  const isEditing = !!blog;
  const [isPending, startTransition] = useTransition();
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const autosaveTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [mediaPickerTarget, setMediaPickerTarget] = useState<
    "cover" | "editor" | null
  >(null);

  // ── Form state ──────────────────────────────────────────────
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [author, setAuthor] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState<
    "draft" | "published" | "pending_review"
  >("draft");
  const [featured, setFeatured] = useState(false);
  const [seoTitle, setSeoTitle] = useState("");
  const [seoDescription, setSeoDescription] = useState("");
  const [coverImageUrl, setCoverImageUrl] = useState("");
  const [readingTime, setReadingTime] = useState(0);

  // ── TipTap ──────────────────────────────────────────────────
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Link.configure({ openOnClick: false }),
      ImageExtension,
      Underline,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Placeholder.configure({ placeholder: "Start writing your blog post…" }),
    ],
    content: "",
    editorProps: {
      attributes: {
        class: "blog-editor-content",
      },
    },
    onUpdate({ editor: ed }) {
      setHasUnsaved(true);
      setReadingTime(calcReadingTime(ed.getHTML()));
    },
  });

  const resetForm = useCallback(() => {
    setTitle("");
    setSlug("");
    setExcerpt("");
    setAuthor("");
    setCategories([]);
    setTags([]);
    setStatus("draft");
    setFeatured(false);
    setSeoTitle("");
    setSeoDescription("");
    setCoverImageUrl("");
    setReadingTime(0);
    setHasUnsaved(false);
    editor?.commands.clearContent();
  }, [editor]);

  // ── Populate form when editing ──────────────────────────────
  useEffect(() => {
    if (open && blog) {
      setTitle(blog.title);
      setSlug(blog.slug);
      setExcerpt(blog.excerpt ?? "");
      setAuthor(blog.author ?? "");
      setCategories(blog.categories ?? []);
      setTags(blog.tags ?? []);
      setStatus(blog.status);
      setFeatured(blog.featured);
      setSeoTitle(blog.seo_title ?? "");
      setSeoDescription(blog.seo_description ?? "");
      setCoverImageUrl(blog.cover_image_url ?? "");
      setReadingTime(blog.reading_time ?? 0);
      editor?.commands.setContent(blog.content ?? "");
    } else if (open && !blog) {
      resetForm();
    }
  }, [open, blog, editor, resetForm]);

  // ── Unsaved changes warning ─────────────────────────────────
  useUnsavedChangesWarning(hasUnsaved);

  // ── Autosave (every 30s, only while editing existing blog) ──
  useEffect(() => {
    if (!open || !isEditing) return;
    autosaveTimer.current = setInterval(() => {
      if (hasUnsaved && blog) {
        const content = editor?.getHTML() ?? "";
        autosaveBlog(blog.id, {
          title,
          content,
          excerpt,
          author,
          categories,
          tags,
          seo_title: seoTitle,
          seo_description: seoDescription,
          cover_image_url: coverImageUrl,
        }).then((res) => {
          if (res.success) {
            setHasUnsaved(false);
          }
        });
      }
    }, 30_000);
    return () => {
      if (autosaveTimer.current) clearInterval(autosaveTimer.current);
    };
  }, [
    open,
    isEditing,
    hasUnsaved,
    blog,
    editor,
    title,
    excerpt,
    author,
    categories,
    tags,
    seoTitle,
    seoDescription,
    coverImageUrl,
  ]);

  // ── Title → slug auto-gen ───────────────────────────────────
  const handleTitleChange = useCallback(
    (val: string) => {
      setTitle(val);
      setHasUnsaved(true);
      if (!isEditing) {
        setSlug(slugify(val));
      }
    },
    [isEditing],
  );

  // ── Build form data ─────────────────────────────────────────
  const buildFormData = (): BlogFormData => ({
    title,
    slug,
    excerpt,
    content: editor?.getHTML() ?? "",
    cover_image_url: coverImageUrl,
    author,
    categories,
    tags,
    status,
    featured,
    seo_title: seoTitle,
    seo_description: seoDescription,
    reading_time: readingTime,
  });

  // ── Save ────────────────────────────────────────────────────
  const handleSave = () => {
    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }

    startTransition(async () => {
      const data = buildFormData();
      const result = isEditing
        ? await updateBlog(blog!.id, data)
        : await createBlog(data);

      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(isEditing ? "Blog updated" : "Blog created");
        setHasUnsaved(false);
        onSaved();
      }
    });
  };

  if (!editor) return null;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            if (hasUnsaved) {
              if (window.confirm("You have unsaved changes. Discard them?")) {
                setHasUnsaved(false);
                onClose();
              }
            } else {
              onClose();
            }
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="fixed inset-0 top-0 left-0 z-50 flex max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-none border-none bg-[#f2f4f7] p-0 text-[#000000] ring-0 sm:max-w-none data-open:zoom-in-100 data-closed:zoom-out-100"
          style={{ maxHeight: "100vh", width: "100vw", height: "100vh" }}
        >
          {/* Editor Top Bar */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "12px 20px",
              borderBottom: "1px solid rgba(0,0,0,0.08)",
              background: "#ffffff",
              flexShrink: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button
                onClick={() => {
                  if (hasUnsaved) {
                    if (
                      window.confirm("You have unsaved changes. Discard them?")
                    ) {
                      setHasUnsaved(false);
                      onClose();
                    }
                  } else {
                    onClose();
                  }
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  padding: "8px",
                  borderRadius: "50%",
                  transition: "background 0.2s",
                  color: "#5f6368",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = "rgba(0,0,0,0.04)")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                <ArrowLeft size={20} />
              </button>
              <DialogHeader style={{ gap: 0 }}>
                <DialogTitle style={{ fontSize: 16, fontWeight: 700 }}>
                  {isEditing ? "Edit Blog" : "New Blog"}
                </DialogTitle>
                <DialogDescription
                  style={{ fontSize: 12, opacity: 0.6, margin: 0 }}
                >
                  {hasUnsaved ? "Unsaved changes" : "All changes saved"}
                  {readingTime > 0 && ` · ${readingTime} min read`}
                </DialogDescription>
              </DialogHeader>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                className="dash-btn dash-btn-ghost"
                onClick={() => {
                  if (hasUnsaved) {
                    if (
                      window.confirm("You have unsaved changes. Discard them?")
                    ) {
                      setHasUnsaved(false);
                      onClose();
                    }
                  } else {
                    onClose();
                  }
                }}
              >
                Cancel
              </button>
              <button
                className="dash-btn dash-btn-primary"
                onClick={handleSave}
                disabled={isPending}
              >
                {isPending
                  ? "Saving…"
                  : isEditing
                    ? "Update Blog"
                    : "Create Blog"}
              </button>
            </div>
          </div>

          {/* Main content - two columns */}
          <div
            style={{
              display: "flex",
              flex: 1,
              overflow: "hidden",
              minHeight: 0,
            }}
          >
            {/* Left: Editor */}
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                borderRight: "1px solid rgba(0,0,0,0.08)",
                background: "#f8f9fa",
              }}
            >
              {/* Toolbar */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "8px 16px",
                  background: "#edf2fa",
                  borderRadius: "24px",
                  margin: "12px 24px 0",
                  flexWrap: "wrap",
                  flexShrink: 0,
                  boxShadow: "0 1px 2px 0 rgba(0,0,0,0.05)",
                }}
              >
                <ToolbarButton
                  onClick={() =>
                    editor.chain().focus().toggleHeading({ level: 1 }).run()
                  }
                  active={editor.isActive("heading", { level: 1 })}
                  title="Heading 1"
                >
                  <Heading1 size={18} />
                </ToolbarButton>
                <ToolbarButton
                  onClick={() =>
                    editor.chain().focus().toggleHeading({ level: 2 }).run()
                  }
                  active={editor.isActive("heading", { level: 2 })}
                  title="Heading 2"
                >
                  <Heading2 size={18} />
                </ToolbarButton>
                <ToolbarButton
                  onClick={() =>
                    editor.chain().focus().toggleHeading({ level: 3 }).run()
                  }
                  active={editor.isActive("heading", { level: 3 })}
                  title="Heading 3"
                >
                  <Heading3 size={18} />
                </ToolbarButton>

                <div
                  style={{
                    width: 1,
                    height: 20,
                    background: "#c7c7c7",
                    margin: "0 6px",
                  }}
                />

                <ToolbarButton
                  onClick={() => editor.chain().focus().toggleBold().run()}
                  active={editor.isActive("bold")}
                  title="Bold"
                >
                  <Bold size={18} />
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => editor.chain().focus().toggleItalic().run()}
                  active={editor.isActive("italic")}
                  title="Italic"
                >
                  <Italic size={18} />
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => editor.chain().focus().toggleUnderline().run()}
                  active={editor.isActive("underline")}
                  title="Underline"
                >
                  <UnderlineIcon size={18} />
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => editor.chain().focus().toggleStrike().run()}
                  active={editor.isActive("strike")}
                  title="Strikethrough"
                >
                  <Strikethrough size={18} />
                </ToolbarButton>

                <div
                  style={{
                    width: 1,
                    height: 20,
                    background: "#c7c7c7",
                    margin: "0 6px",
                  }}
                />

                <ToolbarButton
                  onClick={() =>
                    editor.chain().focus().toggleBulletList().run()
                  }
                  active={editor.isActive("bulletList")}
                  title="Bullet List"
                >
                  <List size={18} />
                </ToolbarButton>
                <ToolbarButton
                  onClick={() =>
                    editor.chain().focus().toggleOrderedList().run()
                  }
                  active={editor.isActive("orderedList")}
                  title="Ordered List"
                >
                  <ListOrdered size={18} />
                </ToolbarButton>

                <div
                  style={{
                    width: 1,
                    height: 20,
                    background: "#c7c7c7",
                    margin: "0 6px",
                  }}
                />

                <ToolbarButton
                  onClick={() =>
                    editor.chain().focus().toggleBlockquote().run()
                  }
                  active={editor.isActive("blockquote")}
                  title="Blockquote"
                >
                  <Quote size={18} />
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => editor.chain().focus().toggleCodeBlock().run()}
                  active={editor.isActive("codeBlock")}
                  title="Code Block"
                >
                  <Code size={18} />
                </ToolbarButton>
                <ToolbarButton
                  onClick={() =>
                    editor.chain().focus().setHorizontalRule().run()
                  }
                  title="Horizontal Rule"
                >
                  <Minus size={18} />
                </ToolbarButton>

                <div
                  style={{
                    width: 1,
                    height: 20,
                    background: "#c7c7c7",
                    margin: "0 6px",
                  }}
                />

                <ToolbarButton
                  onClick={() =>
                    editor.chain().focus().setTextAlign("left").run()
                  }
                  active={editor.isActive({ textAlign: "left" })}
                  title="Align Left"
                >
                  <AlignLeft size={18} />
                </ToolbarButton>
                <ToolbarButton
                  onClick={() =>
                    editor.chain().focus().setTextAlign("center").run()
                  }
                  active={editor.isActive({ textAlign: "center" })}
                  title="Align Center"
                >
                  <AlignCenter size={18} />
                </ToolbarButton>
                <ToolbarButton
                  onClick={() =>
                    editor.chain().focus().setTextAlign("right").run()
                  }
                  active={editor.isActive({ textAlign: "right" })}
                  title="Align Right"
                >
                  <AlignRight size={18} />
                </ToolbarButton>

                <div
                  style={{
                    width: 1,
                    height: 20,
                    background: "#c7c7c7",
                    margin: "0 6px",
                  }}
                />

                <ToolbarButton
                  onClick={() => {
                    const url = window.prompt("Link URL:");
                    if (url) {
                      editor.chain().focus().setLink({ href: url }).run();
                    }
                  }}
                  active={editor.isActive("link")}
                  title="Insert Link"
                >
                  <LinkIcon size={18} />
                </ToolbarButton>
                <ToolbarButton
                  onClick={() => setMediaPickerTarget("editor")}
                  title="Insert Image"
                >
                  <ImageIcon size={18} />
                </ToolbarButton>
              </div>

              {/* Editor content */}
              <div
                style={{
                  flex: 1,
                  overflow: "auto",
                  padding: "24px",
                }}
              >
                <style>{`
                  .blog-editor-content {
                    min-height: 1056px;
                    outline: none;
                    font-size: 15px;
                    line-height: 1.6;
                    color: #1f1f1f;
                    background: #ffffff;
                    width: 816px;
                    max-width: 100%;
                    margin: 0 auto 40px;
                    padding: 96px;
                    box-shadow: 0 1px 3px 1px rgba(0,0,0,0.15);
                    font-family: Arial, sans-serif;
                  }
                  .blog-editor-content h1 { font-size: 26pt; font-weight: 400; margin: 18pt 0 6pt; line-height: 1.2; font-family: Arial, sans-serif; }
                  .blog-editor-content h2 { font-size: 20pt; font-weight: 400; margin: 18pt 0 6pt; line-height: 1.2; font-family: Arial, sans-serif; }
                  .blog-editor-content h3 { font-size: 16pt; font-weight: 400; margin: 14pt 0 4pt; line-height: 1.2; font-family: Arial, sans-serif; color: #434343; }
                  .blog-editor-content p { margin: 0 0 11pt; }
                  .blog-editor-content ul, .blog-editor-content ol { padding-left: 36pt; margin: 0 0 11pt; }
                  .blog-editor-content li { margin-bottom: 4pt; }
                  .blog-editor-content blockquote {
                    border-left: 3px solid #cccccc;
                    padding-left: 14px;
                    margin: 14px 0;
                    color: #666666;
                  }
                  .blog-editor-content pre {
                    background: #f1f3f4;
                    color: #202124;
                    padding: 12px 16px;
                    border-radius: 4px;
                    overflow-x: auto;
                    margin: 14px 0;
                    font-family: "Consolas", "Courier New", monospace;
                    font-size: 10.5pt;
                    border: 1px solid #dadce0;
                  }
                  .blog-editor-content code {
                    background: rgba(0,0,0,0.05);
                    padding: 2px 4px;
                    border-radius: 3px;
                    font-family: "Consolas", "Courier New", monospace;
                    font-size: 0.9em;
                  }
                  .blog-editor-content pre code {
                    background: none;
                    padding: 0;
                    border-radius: 0;
                    color: inherit;
                  }
                  .blog-editor-content a { color: #1155cc; text-decoration: underline; }
                  .blog-editor-content img {
                    max-width: 100%;
                    height: auto;
                    margin: 16px 0;
                  }
                  .blog-editor-content img.ProseMirror-selectednode {
                    outline: 3px solid #1a73e8;
                    outline-offset: 2px;
                    border-radius: 2px;
                  }
                  .blog-editor-content hr {
                    border: none;
                    border-top: 1px solid #dadce0;
                    margin: 24px 0;
                  }
                  .blog-editor-content .is-editor-empty:first-child::before {
                    content: attr(data-placeholder);
                    float: left;
                    color: #9aa0a6;
                    pointer-events: none;
                    height: 0;
                  }
                `}</style>
                <EditorContent editor={editor} />
              </div>
            </div>

            {/* Right sidebar: Settings */}
            <div
              style={{
                width: 360,
                flexShrink: 0,
                overflow: "auto",
                background: "#ffffff",
                padding: "20px",
              }}
            >
              {/* Basic Info */}
              <SectionTitle>Basic Info</SectionTitle>

              <FieldGroup label="Title">
                <input
                  type="text"
                  value={title}
                  onChange={(e) => handleTitleChange(e.target.value)}
                  placeholder="Blog post title"
                  style={inputStyle}
                />
              </FieldGroup>

              <FieldGroup label="Slug">
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => {
                    setSlug(e.target.value);
                    setHasUnsaved(true);
                  }}
                  placeholder="url-friendly-slug"
                  style={{
                    ...inputStyle,
                    fontFamily: "var(--font-dash-mono), monospace",
                    fontSize: 12,
                  }}
                />
              </FieldGroup>

              <FieldGroup label="Excerpt">
                <textarea
                  value={excerpt}
                  onChange={(e) => {
                    setExcerpt(e.target.value);
                    setHasUnsaved(true);
                  }}
                  placeholder="Brief summary of the blog post…"
                  rows={3}
                  style={{ ...inputStyle, resize: "vertical" }}
                />
              </FieldGroup>

              <FieldGroup label="Author">
                <input
                  type="text"
                  value={author}
                  onChange={(e) => {
                    setAuthor(e.target.value);
                    setHasUnsaved(true);
                  }}
                  placeholder="Author name"
                  style={inputStyle}
                />
              </FieldGroup>

              <FieldGroup label="Categories">
                {categoryOptions.length === 0 && categories.length === 0 && (
                  <p style={{ fontSize: 12, color: "#8b93a3", marginTop: 4 }}>
                    No categories yet — add them in{" "}
                    <NextLink href="/dashboard/blogs/settings">
                      Blog settings
                    </NextLink>
                    .
                  </p>
                )}
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                    marginTop: 4,
                  }}
                >
                  {/* Store options + any names already on this post (so legacy
                      values stay visible and deselectable after a rename/delete). */}
                  {Array.from(new Set([...categoryOptions, ...categories])).map(
                    (cat) => {
                      const isSelected = categories.includes(cat);
                      return (
                        <button
                          key={cat}
                          type="button"
                          onClick={() => {
                            setCategories((prev) =>
                              isSelected
                                ? prev.filter((c) => c !== cat)
                                : [...prev, cat],
                            );
                            setHasUnsaved(true);
                          }}
                          style={{
                            padding: "4px 10px",
                            borderRadius: 100,
                            fontSize: 12,
                            fontWeight: isSelected ? 600 : 500,
                            border: isSelected
                              ? "1px solid transparent"
                              : "1px solid rgba(0,0,0,0.15)",
                            background: isSelected
                              ? "rgba(0,0,0,0.12)"
                              : "transparent",
                            color: isSelected ? "#000000" : "rgba(0,0,0,0.7)",
                            cursor: "pointer",
                            transition: "all 0.15s",
                          }}
                        >
                          {cat}
                        </button>
                      );
                    },
                  )}
                </div>
              </FieldGroup>

              {/* Cover Image */}
              <div style={{ margin: "16px 0 0" }}>
                <SectionTitle>Cover Image</SectionTitle>
                {coverImageUrl ? (
                  <div
                    style={{
                      position: "relative",
                      borderRadius: 8,
                      overflow: "hidden",
                      marginBottom: 8,
                      border: "1px solid rgba(0,0,0,0.08)",
                    }}
                  >
                    <img
                      src={coverImageUrl}
                      alt="Cover"
                      style={{
                        width: "100%",
                        height: 140,
                        objectFit: "cover",
                        display: "block",
                      }}
                    />
                    <button
                      onClick={() => {
                        setCoverImageUrl("");
                        setHasUnsaved(true);
                      }}
                      style={{
                        position: "absolute",
                        top: 6,
                        right: 6,
                        background: "rgba(0,0,0,0.6)",
                        color: "#fff",
                        border: "none",
                        borderRadius: 4,
                        padding: "2px 6px",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ) : null}
                <button
                  className="dash-btn dash-btn-ghost"
                  style={{ width: "100%", fontSize: 12 }}
                  onClick={() => setMediaPickerTarget("cover")}
                >
                  {coverImageUrl ? "Change Image" : "📷 Choose Cover Image"}
                </button>
              </div>

              {/* Publishing */}
              <div style={{ margin: "20px 0 0" }}>
                <SectionTitle>Publishing</SectionTitle>

                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 12,
                  }}
                >
                  <label
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      width: 56,
                    }}
                  >
                    Status
                  </label>
                  <div
                    style={{
                      flex: 1,
                      display: "flex",
                      gap: 4,
                      background: "rgba(0,0,0,0.06)",
                      padding: 4,
                      borderRadius: 8,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setStatus("draft");
                        setHasUnsaved(true);
                      }}
                      style={{
                        flex: 1,
                        fontSize: 11,
                        padding: "6px 12px",
                        border: "none",
                        borderRadius: 6,
                        background:
                          status === "draft" ? "#ffffff" : "transparent",
                        color:
                          status === "draft" ? "#000000" : "rgba(0,0,0,0.6)",
                        fontWeight: status === "draft" ? 600 : 500,
                        boxShadow:
                          status === "draft"
                            ? "0 1px 3px rgba(0,0,0,0.1)"
                            : "none",
                        cursor: "pointer",
                        transition: "all 0.2s",
                      }}
                    >
                      Draft
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setStatus("published");
                        setHasUnsaved(true);
                      }}
                      style={{
                        flex: 1,
                        fontSize: 11,
                        padding: "6px 12px",
                        border: "none",
                        borderRadius: 6,
                        background:
                          status === "published" ? "#ffffff" : "transparent",
                        color:
                          status === "published"
                            ? "#000000"
                            : "rgba(0,0,0,0.6)",
                        fontWeight: status === "published" ? 600 : 500,
                        boxShadow:
                          status === "published"
                            ? "0 1px 3px rgba(0,0,0,0.1)"
                            : "none",
                        cursor: "pointer",
                        transition: "all 0.2s",
                      }}
                    >
                      Published
                    </button>
                  </div>
                </div>

                {blog?.status === "pending_review" && (
                  <div
                    style={{
                      fontSize: 11,
                      lineHeight: 1.5,
                      color: "#b45309",
                      background: "rgba(245,158,11,0.12)",
                      border: "1px solid rgba(245,158,11,0.3)",
                      borderRadius: 6,
                      padding: "8px 10px",
                      marginBottom: 12,
                    }}
                  >
                    Community submission pending review — set status to{" "}
                    <strong>Published</strong> and save to approve it (the
                    author is emailed automatically).
                  </div>
                )}

                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={featured}
                    onChange={(e) => {
                      setFeatured(e.target.checked);
                      setHasUnsaved(true);
                    }}
                    style={{ accentColor: "var(--dash-accent)" }}
                  />
                  Featured post
                </label>
              </div>

              {/* Tags */}
              <div style={{ margin: "20px 0 0" }}>
                <SectionTitle>Tags</SectionTitle>
                {tagOptions.length === 0 && tags.length === 0 && (
                  <p style={{ fontSize: 12, color: "#8b93a3", marginTop: 4 }}>
                    No tags yet — add them in{" "}
                    <NextLink href="/dashboard/blogs/settings">
                      Blog settings
                    </NextLink>
                    .
                  </p>
                )}
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    flexWrap: "wrap",
                    marginTop: 4,
                  }}
                >
                  {/* Store options + any names already on this post. */}
                  {Array.from(new Set([...tagOptions, ...tags])).map((tag) => {
                    const isSelected = tags.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => {
                          setTags((prev) =>
                            isSelected
                              ? prev.filter((t) => t !== tag)
                              : [...prev, tag],
                          );
                          setHasUnsaved(true);
                        }}
                        style={{
                          padding: "4px 10px",
                          borderRadius: 6,
                          fontSize: 12,
                          fontWeight: isSelected ? 600 : 500,
                          border: isSelected
                            ? "1px solid transparent"
                            : "1px solid rgba(0,0,0,0.15)",
                          background: isSelected
                            ? "rgba(0,0,0,0.12)"
                            : "transparent",
                          color: isSelected ? "#000000" : "rgba(0,0,0,0.7)",
                          cursor: "pointer",
                          transition: "all 0.15s",
                        }}
                      >
                        {tag}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* SEO */}
              <div style={{ margin: "20px 0 0" }}>
                <SectionTitle>SEO</SectionTitle>
                <FieldGroup label="SEO Title">
                  <input
                    type="text"
                    value={seoTitle}
                    onChange={(e) => {
                      setSeoTitle(e.target.value);
                      setHasUnsaved(true);
                    }}
                    placeholder="SEO-optimized title"
                    style={inputStyle}
                  />
                  <CharCount current={seoTitle.length} max={60} />
                </FieldGroup>

                <FieldGroup label="SEO Description">
                  <textarea
                    value={seoDescription}
                    onChange={(e) => {
                      setSeoDescription(e.target.value);
                      setHasUnsaved(true);
                    }}
                    placeholder="Meta description for search engines"
                    rows={3}
                    style={{ ...inputStyle, resize: "vertical" }}
                  />
                  <CharCount current={seoDescription.length} max={160} />
                </FieldGroup>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Media Picker */}
      <MediaPickerDialog
        mediaUrlPrefix={mediaUrlPrefix}
        open={!!mediaPickerTarget}
        onClose={() => setMediaPickerTarget(null)}
        onSelect={(url) => {
          if (mediaPickerTarget === "cover") {
            setCoverImageUrl(url);
            setHasUnsaved(true);
          } else if (mediaPickerTarget === "editor") {
            editor?.chain().focus().setImage({ src: url }).run();
          }
          setMediaPickerTarget(null);
        }}
      />
    </>
  );
}

// ── Sub-components ────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        marginBottom: 10,
        color: "rgba(0,0,0,0.45)",
      }}
    >
      {children}
    </div>
  );
}

function FieldGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label
        style={{
          display: "block",
          fontSize: 12,
          fontWeight: 500,
          marginBottom: 4,
          color: "rgba(0,0,0,0.7)",
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function CharCount({ current, max }: { current: number; max: number }) {
  const isOver = current > max;
  return (
    <div
      style={{
        fontSize: 10,
        textAlign: "right",
        marginTop: 2,
        color: isOver ? "var(--dash-red)" : "rgba(0,0,0,0.35)",
      }}
    >
      {current}/{max}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 10px",
  borderRadius: 6,
  border: "1px solid rgba(0,0,0,0.1)",
  background: "#f8f9fb",
  fontSize: 13,
  color: "#1a1a1a",
  outline: "none",
  fontFamily: "inherit",
  transition: "border-color 0.15s",
};
