/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import type { SchemeDesign } from "@/lib/themes/schemes";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  ArrowLeft,
  ExternalLink,
  FileText,
  Loader2,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Redo2,
  Settings,
  Settings2,
  Smartphone,
  Tablet,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";
import { arrayMove } from "@dnd-kit/sortable";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { slugify } from "@/lib/slug";
import {
  createPage,
  deletePage,
  getPageDraft,
  publishPage,
  unpublishPage,
  updatePageMeta,
  type PageDraft,
  type PageListItem,
} from "@/app/actions/page-actions";
import type { ThemeDesignDefaults } from "@/lib/chrome/design";
import { saveChromeDraft, publishChrome } from "@/app/actions/chrome-actions";
import type { StoreChrome } from "@/lib/chrome/types";
import { saveBrandAppearance } from "@/app/actions/store-branding";
import type { BrandAppearance } from "./chrome-form";
import { useAutosave, type SaveStatus } from "./use-autosave";
import {
  EMPTY_CONFIG,
  type AnySectionConfig,
  type HomepageSectionType,
  type SectionStyle,
} from "@/lib/homepage/section-types";
import type { PageSectionItem } from "@/lib/sections/registry";
import {
  SectionForm,
  fieldClass,
  labelClass,
  type BlogOption,
  type CategoryOption,
  type ProductOption,
} from "./section-form";
import { OutlinePanel } from "./outline-panel";
import { InspectorPanel, PageSettingsForm } from "./inspector-panel";
import { SectionLibrary } from "./section-library";
import { useHistory, type HistoryEntry } from "./use-history";
import { useBuilderShortcuts } from "./use-builder-shortcuts";

type Options = {
  products: ProductOption[];
  categories: CategoryOption[];
  blogs: BlogOption[];
};

type Viewport = "desktop" | "tablet" | "mobile";

const VIEWPORT_WIDTH: Record<Viewport, string> = {
  desktop: "100%",
  tablet: "768px",
  mobile: "375px",
};

export function BuilderClient({
  initialPages,
  products,
  categories,
  blogs,
  storeName,
  initialChrome,
  initialBrand,
  themeDefaults,
  schemeDesign,
}: Options & {
  initialPages: PageListItem[];
  storeName: string;
  initialChrome: StoreChrome;
  initialBrand: BrandAppearance;
  /** What the pinned theme supplies for each overridable design token, so the
   *  panel can show a real fallback instead of an empty box. */
  themeDefaults: ThemeDesignDefaults;
  /** What the section colour schemes are built from (lib/themes/schemes). */
  schemeDesign: SchemeDesign;
}) {
  const [pages, setPages] = useState(initialPages);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The site-wide header + footer. Held beside the page draft rather than
  // inside it: chrome belongs to the STORE, so it survives page switches and
  // is saved on its own row (app/actions/chrome-actions.ts).
  const [chrome, setChrome] = useState<StoreChrome>(initialChrome);
  // Which global area the inspector is editing, if any. Mutually exclusive
  // with selectedSectionId — one inspector, one subject.
  const [chromeTarget, setChromeTarget] = useState<
    "header" | "footer" | "brand" | null
  >(null);
  const [chromeDirty, setChromeDirty] = useState(false);
  // Brand appearance (colour + logo). Lives beside chrome for the same reason:
  // it belongs to the STORE, not to whichever page happens to be open.
  const [brand, setBrand] = useState<BrandAppearance>(initialBrand);
  // The message handler is registered once; a ref keeps it reading the LATEST
  // chrome without tearing down and re-adding the listener on every keystroke.
  // Synced in an effect, not during render — a render-phase ref write is not
  // safe under concurrent rendering (React may render and discard).
  const chromeRef = useRef(chrome);
  useEffect(() => {
    chromeRef.current = chrome;
  }, [chrome]);
  const [draft, setDraft] = useState<PageDraft | null>(null);
  // Starts TRUE whenever there is a page to auto-open, so the very first
  // (server-rendered, pre-hydration) paint says "Opening…" rather than
  // "Select a page" — which told the merchant to do something the builder was
  // already doing, and on a slow connection read as broken. React state cannot
  // fix that frame; only the initial value can. loadDraft clears it on both
  // the success and failure paths, so it can never stick.
  const [loadingDraft, setLoadingDraft] = useState(initialPages.length > 0);
  // Preview iframe lifecycle: the element is REUSED across page switches
  // (navigation via contentWindow.location.replace) so the outgoing page
  // stays visible under a loading veil — no blank flash, no scroll jank, and
  // no parent-history entries. frameSrc is only ever set for a (re)mount;
  // frameKey bumps only as a remount fallback when replace() throws.
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [frameKey, setFrameKey] = useState(0);
  const [previewLoading, setPreviewLoading] = useState(false);
  const frameSrcRef = useRef<string | null>(null);
  const veilTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [viewport, setViewport] = useState<Viewport>("desktop");
  // Left panel collapse (icon rail), persisted per browser.
  const [leftCollapsed, setLeftCollapsed] = useState(
    () =>
      typeof window !== "undefined" &&
      window.localStorage.getItem("sm-builder-left-collapsed") === "1",
  );
  const toggleLeftPanel = () =>
    setLeftCollapsed((c) => {
      window.localStorage.setItem("sm-builder-left-collapsed", c ? "0" : "1");
      return !c;
    });
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(
    null,
  );
  // Event handlers (shortcuts, history records) need the CURRENT selection
  // without re-subscribing; synced every render.
  const selectedSectionIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedSectionIdRef.current = selectedSectionId;
  }, [selectedSectionId]);
  // Sections the preview reported as not rendering (empty/no data).
  const [hiddenSectionIds, setHiddenSectionIds] = useState<Set<string>>(
    new Set(),
  );
  // Canvas hover → outline highlight sync.
  const [canvasHoverId, setCanvasHoverId] = useState<string | null>(null);
  // Where the next added section goes: undefined = append (outline button),
  // null = top of page, string = after that section (canvas "+ add" buttons).
  const insertAfterRef = useRef<string | null | undefined>(undefined);
  const [isPending, startTransition] = useTransition();
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Dialogs.
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [newPageOpen, setNewPageOpen] = useState(false);
  const [codeEditorOpen, setCodeEditorOpen] = useState(false);
  const [deletePageOpen, setDeletePageOpen] = useState(false);
  const [deleteSectionOpen, setDeleteSectionOpen] = useState(false);
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false);

  const options: Options = { products, categories, blogs };

  // Autosave plumbing: the hook reads the LATEST sections + stale-tab token
  // from refs so a completing save never races a render. The ref is the
  // synchronous source of truth (written in setDraftSynced, never during
  // render); `draft` state mirrors it for rendering.
  const draftRef = useRef<PageDraft | null>(null);
  const tokenRef = useRef<string>("");

  const setDraftSynced = useCallback(
    (updater: (d: PageDraft | null) => PageDraft | null) => {
      draftRef.current = updater(draftRef.current);
      setDraft(draftRef.current);
    },
    [],
  );

  // Full preview refresh (RSC round-trip). Only needed when server-rendered
  // state changes: publish and slug renames. Live section edits paint through
  // the instant client-side path below (sm-draft → DraftCanvas).
  const pingPreview = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (win)
      win.postMessage({ type: "sm-preview-refresh" }, window.location.origin);
  }, []);

  const { status, markDirty, flush, unblock } = useAutosave({
    pageId: draft?.id ?? null,
    getSections: () => draftRef.current?.sections ?? [],
    tokenRef,
    // The canvas already shows the latest draft (sm-draft) — a refresh after
    // every save would only redo the same render the slow way.
    onSaved: () => {},
  });

  // Undo/redo over draft.sections. `record` snapshots the pre-mutation state
  // inside setSections; typing bursts on one section coalesce to one entry.
  const {
    record,
    undo: historyUndo,
    redo: historyRedo,
    reset: resetHistory,
    canUndo,
    canRedo,
  } = useHistory();

  const postToPreview = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(msg, window.location.origin);
  }, []);

  const clearVeil = useCallback(() => {
    if (veilTimerRef.current) {
      clearTimeout(veilTimerRef.current);
      veilTimerRef.current = null;
    }
    setPreviewLoading(false);
  }, []);

  // Point the preview at a page. Reuses the live iframe via location.replace
  // when possible; falls back to a fresh mount (first load, or after the
  // iframe was unmounted). The veil clears on iframe load / sm-preview-ready,
  // with a timeout so it can never get stuck.
  const navigatePreview = useCallback((slug: string) => {
    const url = `/${slug}?preview=1`;
    setPreviewLoading(true);
    if (veilTimerRef.current) clearTimeout(veilTimerRef.current);
    veilTimerRef.current = setTimeout(() => setPreviewLoading(false), 4000);
    const win = iframeRef.current?.contentWindow;
    if (win && frameSrcRef.current) {
      try {
        win.location.replace(url);
        return;
      } catch {
        setFrameKey((k) => k + 1); // remount below
      }
    }
    frameSrcRef.current = url;
    setFrameSrc(url);
  }, []);

  // Canvas → builder messages (BuilderOverlay inside the preview iframe).
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data as {
        type?: string;
        id?: string | null;
        afterId?: string | null;
        ids?: string[];
      };
      switch (data?.type) {
        // A fresh iframe announces itself. Answer with the current draft
        // chrome — the merchant's unsaved header edits must survive a page
        // switch or a preview reload, and without this the iframe would keep
        // rendering the PUBLISHED chrome while the outline showed the draft.
        case "sm-chrome-ready":
          postToPreview({ type: "sm-chrome", chrome: chromeRef.current });
          break;
        case "sm-select":
          if (typeof data.id === "string") setSelectedSectionId(data.id);
          break;
        case "sm-hover":
          setCanvasHoverId(data.id ?? null);
          break;
        case "sm-add-at":
          insertAfterRef.current = data.afterId ?? null;
          setLibraryOpen(true);
          break;
        case "sm-visible": {
          // Enabled sections the page did NOT render (empty → no DOM node).
          const visible = new Set(data.ids ?? []);
          const hidden = new Set(
            (draftRef.current?.sections ?? [])
              .filter((s) => s.enabled && !visible.has(s.id))
              .map((s) => s.id),
          );
          setHiddenSectionIds(hidden);
          break;
        }
        case "sm-preview-ready":
          clearVeil();
          break;
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [postToPreview, clearVeil]);

  const loadDraft = useCallback(
    async (id: string) => {
      setLoadingDraft(true);
      const d = await getPageDraft(id);
      setLoadingDraft(false);
      if (!d) {
        toast.error("Could not open that page.");
        return;
      }
      tokenRef.current = d.updated_at;
      setDraftSynced(() => d);
      setSelectedId(id);
      setSelectedSectionId(null);
      resetHistory();
      navigatePreview(d.slug);
    },
    [setDraftSynced, navigatePreview, resetHistory],
  );

  // Open the homepage by default so the builder never starts on an empty
  // canvas (the sentinel slug "" is pinned first, but match by slug so a
  // future ordering change can't silently open the wrong page).
  const hasAutoSelected = useRef(false);
  useEffect(() => {
    if (hasAutoSelected.current || initialPages.length === 0) return;
    hasAutoSelected.current = true;
    const home = initialPages.find((p) => p.slug === "") ?? initialPages[0];
    loadDraft(home.id);
  }, [initialPages, loadDraft]);

  // Instant preview: push the latest draft sections into the iframe's
  // DraftCanvas after every mutation. rAF-throttled latest-wins (the send
  // reads draftRef at fire time); custom_code edits throttle harder so the
  // sandboxed iframe doesn't remount srcDoc on every keystroke.
  const draftPostRaf = useRef<number | null>(null);
  const draftPostTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const postDraftToPreview = useCallback(
    (delayMs = 0) => {
      const send = () =>
        postToPreview({
          type: "sm-draft",
          sections: draftRef.current?.sections ?? [],
        });
      if (delayMs > 0) {
        if (draftPostTimer.current) clearTimeout(draftPostTimer.current);
        draftPostTimer.current = setTimeout(() => {
          draftPostTimer.current = null;
          send();
        }, delayMs);
        return;
      }
      if (draftPostRaf.current != null) return;
      draftPostRaf.current = requestAnimationFrame(() => {
        draftPostRaf.current = null;
        send();
      });
    },
    [postToPreview],
  );

  // --- Local section mutations (autosaved) ---
  const setSections = useCallback(
    (
      updater: (s: PageSectionItem[]) => PageSectionItem[],
      kind: "content" | "structural" = "structural",
      opts?: { previewDelayMs?: number },
    ) => {
      const d = draftRef.current;
      if (d) {
        record(
          {
            sections: d.sections,
            selectedSectionId: selectedSectionIdRef.current,
          },
          kind === "content"
            ? `${selectedSectionIdRef.current ?? "page"}:content`
            : undefined,
        );
      }
      setDraftSynced((d) => (d ? { ...d, sections: updater(d.sections) } : d));
      markDirty(kind);
      postDraftToPreview(opts?.previewDelayMs ?? 0);
    },
    [record, setDraftSynced, markDirty, postDraftToPreview],
  );

  // Undo/redo application: bypasses setSections (must not re-record), but
  // saves + paints through the same paths as any other mutation.
  const applyHistoryEntry = useCallback(
    (entry: HistoryEntry) => {
      setDraftSynced((d) => (d ? { ...d, sections: entry.sections } : d));
      const valid =
        entry.selectedSectionId &&
        entry.sections.some((s) => s.id === entry.selectedSectionId)
          ? entry.selectedSectionId
          : null;
      setSelectedSectionId(valid);
      markDirty("structural"); // immediate save through the autosave chain
      postDraftToPreview();
    },
    [setDraftSynced, markDirty, postDraftToPreview],
  );

  const handleUndo = useCallback(() => {
    const d = draftRef.current;
    if (!d) return;
    const entry = historyUndo({
      sections: d.sections,
      selectedSectionId: selectedSectionIdRef.current,
    });
    if (entry) applyHistoryEntry(entry);
  }, [historyUndo, applyHistoryEntry]);

  const handleRedo = useCallback(() => {
    const d = draftRef.current;
    if (!d) return;
    const entry = historyRedo({
      sections: d.sections,
      selectedSectionId: selectedSectionIdRef.current,
    });
    if (entry) applyHistoryEntry(entry);
  }, [historyRedo, applyHistoryEntry]);

  const selectedSection =
    draft?.sections.find((s) => s.id === selectedSectionId) ?? null;

  const updateSelectedConfig = (config: AnySectionConfig) => {
    if (!selectedSectionId) return;
    setSections(
      (s) =>
        s.map((it) => (it.id === selectedSectionId ? { ...it, config } : it)),
      "content",
      // Typing in the code editor shouldn't remount the sandbox per keystroke.
      { previewDelayMs: selectedSection?.type === "custom_code" ? 500 : 0 },
    );
  };

  const updateSelectedStyle = (style: SectionStyle) => {
    if (!selectedSectionId) return;
    setSections(
      (s) =>
        s.map((it) => (it.id === selectedSectionId ? { ...it, style } : it)),
      "content",
    );
  };

  const toggleSection = (id: string) =>
    setSections((s) =>
      s.map((it) => (it.id === id ? { ...it, enabled: !it.enabled } : it)),
    );

  const duplicateSection = () => {
    const src = selectedSection;
    if (!src) return;
    const copy: PageSectionItem = structuredClone(src);
    copy.id = crypto.randomUUID();
    if (copy.style?.anchor) delete copy.style.anchor; // anchors must stay unique
    setSections((s) => {
      const i = s.findIndex((it) => it.id === src.id);
      const next = [...s];
      next.splice(i + 1, 0, copy);
      return next;
    });
    setSelectedSectionId(copy.id);
  };

  const deleteSection = () => {
    if (!selectedSectionId) return;
    setSections((s) => s.filter((it) => it.id !== selectedSectionId));
    setSelectedSectionId(null);
  };

  const reorderSections = (activeId: string, overId: string) =>
    setSections((s) => {
      const from = s.findIndex((it) => it.id === activeId);
      const to = s.findIndex((it) => it.id === overId);
      if (from < 0 || to < 0) return s;
      return arrayMove(s, from, to);
    });

  // Chrome edits: push to the preview instantly, save on a debounce.
  //
  // Its own debounce rather than the page autosave chain — chrome lives on a
  // different row and a different action, and threading it through the page's
  // single-flight token would let a header edit lose a section edit.
  const chromeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateChrome = useCallback(
    (next: StoreChrome) => {
      setChrome(next);
      setChromeDirty(true);
      postToPreview({ type: "sm-chrome", chrome: next });
      if (chromeTimer.current) clearTimeout(chromeTimer.current);
      chromeTimer.current = setTimeout(async () => {
        const res = await saveChromeDraft(next);
        if (res.error) {
          toast.error(res.error);
          return;
        }
        setChromeDirty(false);
      }, 400);
    },
    [postToPreview],
  );

  // Brand: same instant-preview + debounce shape as chrome. The colour is
  // pushed as a CSS variable rather than a re-render, so it repaints the whole
  // storefront skin without a round trip.
  const brandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const updateBrand = useCallback(
    (next: BrandAppearance) => {
      setBrand(next);
      postToPreview({ type: "sm-brand", brand: next });
      if (brandTimer.current) clearTimeout(brandTimer.current);
      brandTimer.current = setTimeout(async () => {
        const res = await saveBrandAppearance({
          primaryColor: next.primaryColor,
          logoUrl: next.logoUrl,
        });
        if (res.error) toast.error(res.error);
      }, 500);
    },
    [postToPreview],
  );

  // Flush a pending chrome save before publishing, or Publish would ship the
  // last SAVED chrome and silently drop whatever was typed in the last 400ms.
  const flushChrome = useCallback(async (): Promise<boolean> => {
    if (chromeTimer.current) {
      clearTimeout(chromeTimer.current);
      chromeTimer.current = null;
    }
    if (!chromeDirty) return true;
    const res = await saveChromeDraft(chrome);
    if (res.error) {
      toast.error(res.error);
      return false;
    }
    setChromeDirty(false);
    return true;
  }, [chrome, chromeDirty]);

  const addSection = (type: HomepageSectionType) => {
    const item: PageSectionItem = {
      id: crypto.randomUUID(),
      type,
      enabled: true,
      config: structuredClone(EMPTY_CONFIG[type]) as AnySectionConfig,
    };
    const insertAfter = insertAfterRef.current;
    insertAfterRef.current = undefined;
    setLibraryOpen(false);
    setSections((s) => {
      if (insertAfter === undefined) return [...s, item]; // append (outline)
      if (insertAfter === null) return [item, ...s]; // top of page
      const i = s.findIndex((it) => it.id === insertAfter);
      const next = [...s];
      next.splice(i < 0 ? s.length : i + 1, 0, item);
      return next;
    });
    setSelectedSectionId(item.id);
    if (type === "custom_code") setCodeEditorOpen(true);
  };

  // --- Page-level actions ---
  const handlePublish = () => {
    if (!draft) return;
    startTransition(async () => {
      const flushed = await flush();
      if (!flushed) {
        toast.error("Couldn't save your latest changes — publish aborted.");
        return;
      }
      // One Publish means one website: the page AND the site-wide chrome go
      // live together. Publishing a page that references a nav link the
      // visitor cannot see yet is the split this redesign exists to remove.
      if (!(await flushChrome())) return;
      const chromeRes = await publishChrome();
      if (chromeRes.error) {
        toast.error(chromeRes.error);
        return;
      }
      const result = await publishPage(draft.id, tokenRef.current);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Page published");
      const nextToken = result.data?.updated_at;
      if (typeof nextToken === "string") tokenRef.current = nextToken;
      const publishedAt =
        (result.data?.published_at as string) ?? new Date().toISOString();
      setDraftSynced((d) =>
        d
          ? {
              ...d,
              status: "published",
              updated_at: tokenRef.current,
              published_at: publishedAt,
            }
          : d,
      );
      setPages((ps) =>
        ps.map((p) =>
          p.id === draft.id
            ? { ...p, status: "published", published_at: publishedAt }
            : p,
        ),
      );
      pingPreview();
    });
  };

  const handleUnpublish = () => {
    if (!draft) return;
    startTransition(async () => {
      const result = await unpublishPage(draft.id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Page unpublished");
      setPages((ps) =>
        ps.map((p) => (p.id === draft.id ? { ...p, status: "draft" } : p)),
      );
      // Unpublish stamps updated_at — re-pull so the stale-tab token stays valid.
      const fresh = await getPageDraft(draft.id);
      if (fresh) {
        tokenRef.current = fresh.updated_at;
        setDraftSynced(() => fresh);
      }
    });
  };

  const handleSavePageMeta = async (fields: {
    title: string;
    slug: string;
    seo_title: string;
    seo_description: string;
    seo_noindex: boolean;
  }): Promise<boolean> => {
    if (!draft) return false;
    const result = await updatePageMeta(draft.id, fields);
    if (result.error) {
      toast.error(result.error);
      return false;
    }
    // updatePageMeta stamps updated_at — re-pull to refresh the token, the
    // (possibly renamed) slug for the preview URL, and the pages list row.
    const fresh = await getPageDraft(draft.id);
    if (fresh) {
      tokenRef.current = fresh.updated_at;
      setDraftSynced(() => fresh);
      setPages((ps) =>
        ps.map((p) =>
          p.id === draft.id
            ? { ...p, title: fresh.title, slug: fresh.slug }
            : p,
        ),
      );
      navigatePreview(fresh.slug);
    }
    return true;
  };

  const handleDeletePage = () => {
    if (!draft) return;
    startTransition(async () => {
      const result = await deletePage(draft.id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Page deleted");
      setDeletePageOpen(false);
      setPages((ps) => ps.filter((p) => p.id !== draft.id));
      setDraftSynced(() => null);
      setSelectedId(null);
      setSelectedSectionId(null);
    });
  };

  // --- Keyboard shortcuts ---
  useBuilderShortcuts({
    suspended:
      newPageOpen ||
      codeEditorOpen ||
      deletePageOpen ||
      deleteSectionOpen ||
      pageSettingsOpen ||
      status === "blocked",
    handlers: {
      undo: handleUndo,
      redo: handleRedo,
      save: () => {
        void flush().then((ok) => {
          if (ok) toast.success("Saved");
        });
      },
      escape: () => {
        if (libraryOpen) {
          setLibraryOpen(false);
          insertAfterRef.current = undefined;
        } else {
          setSelectedSectionId(null);
        }
      },
      moveSelection: (dir) => {
        if (libraryOpen) return;
        const secs = draftRef.current?.sections ?? [];
        if (secs.length === 0) return;
        const idx = secs.findIndex(
          (s) => s.id === selectedSectionIdRef.current,
        );
        const next =
          idx < 0
            ? dir === 1
              ? 0
              : secs.length - 1
            : Math.max(0, Math.min(secs.length - 1, idx + dir));
        const id = secs[next].id;
        setSelectedSectionId(id);
        postToPreview({ type: "sm-scroll-to", id });
      },
      duplicate: duplicateSection,
      requestDelete: () => {
        if (!libraryOpen && selectedSectionIdRef.current)
          setDeleteSectionOpen(true);
      },
    },
  });

  return (
    <div className={`sm-builder ${leftCollapsed ? "is-left-collapsed" : ""}`}>
      {/* Top bar */}
      <header className="sm-builder-topbar">
        <div className="sm-builder-topbar-left">
          <Link
            href="/dashboard"
            className="sm-builder-back"
            title="Back to dashboard"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <button
            className="sm-builder-iconbtn"
            onClick={toggleLeftPanel}
            title={leftCollapsed ? "Show pages & sections" : "Hide panel"}
          >
            {leftCollapsed ? (
              <PanelLeftOpen className="h-4 w-4" />
            ) : (
              <PanelLeftClose className="h-4 w-4" />
            )}
          </button>
          <span className="sm-builder-brand">{storeName}</span>
          <span className="sm-builder-sep">/</span>
          <span className="sm-builder-title">
            {draft
              ? draft.slug === ""
                ? "Home"
                : draft.title || draft.slug
              : "Website Builder"}
          </span>
          {draft && (
            <button
              className="sm-builder-iconbtn"
              onClick={() => setPageSettingsOpen(true)}
              title="Page settings (title, slug, SEO)"
            >
              <Settings2 className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="sm-builder-viewports">
          <ViewportButton
            active={viewport === "desktop"}
            onClick={() => setViewport("desktop")}
            icon={<Monitor className="h-4 w-4" />}
            label="Desktop"
          />
          <ViewportButton
            active={viewport === "tablet"}
            onClick={() => setViewport("tablet")}
            icon={<Tablet className="h-4 w-4" />}
            label="Tablet"
          />
          <ViewportButton
            active={viewport === "mobile"}
            onClick={() => setViewport("mobile")}
            icon={<Smartphone className="h-4 w-4" />}
            label="Mobile"
          />
        </div>

        {draft && (
          <div className="sm-builder-topbar-right">
            <button
              className="sm-builder-iconbtn"
              onClick={handleUndo}
              disabled={!canUndo}
              title="Undo (⌘Z)"
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              className="sm-builder-iconbtn"
              onClick={handleRedo}
              disabled={!canRedo}
              title="Redo (⇧⌘Z)"
            >
              <Redo2 className="h-4 w-4" />
            </button>
            <SaveStatusIndicator status={status} onRetry={() => flush()} />
            <span
              className={`sm-builder-status ${draft.status === "published" ? "is-live" : ""}`}
            >
              {draft.status === "published" ? "Live" : "Draft"}
            </span>
            <Link
              href={`/${draft.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="sm-builder-iconbtn"
              title="Open live page"
            >
              <ExternalLink className="h-4 w-4" />
            </Link>
            <Link
              href="/dashboard/builder/settings"
              className="sm-builder-iconbtn"
              title="Website settings"
            >
              <Settings className="h-4 w-4" />
            </Link>
            {draft.status === "published" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleUnpublish}
                disabled={isPending}
              >
                Unpublish
              </Button>
            ) : null}
            <Button size="sm" onClick={handlePublish} disabled={isPending}>
              Publish
            </Button>
          </div>
        )}
      </header>

      <div className="sm-builder-body">
        {leftCollapsed ? (
          <div className="sm-builder-rail">
            <button
              className="sm-builder-iconbtn"
              onClick={toggleLeftPanel}
              title="Show pages & sections"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
            <button
              className="sm-builder-iconbtn"
              onClick={() => {
                insertAfterRef.current = undefined;
                setLibraryOpen(true);
              }}
              title="Add section"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <OutlinePanel
            pages={pages}
            selectedPageId={selectedId}
            onSelectPage={loadDraft}
            onNewPage={() => setNewPageOpen(true)}
            sections={draft?.sections ?? null}
            selectedSectionId={selectedSectionId}
            canvasHoverId={canvasHoverId}
            hiddenSectionIds={hiddenSectionIds}
            chromeTarget={chromeTarget}
            onSelectChrome={(t) => {
              // One inspector, one subject: selecting the header clears any
              // selected section, and vice versa.
              setChromeTarget(t);
              setSelectedSectionId(null);
            }}
            onSelectSection={(id) => {
              setChromeTarget(null);
              setSelectedSectionId(id);
              postToPreview({ type: "sm-scroll-to", id });
            }}
            onHoverSection={(id) => postToPreview({ type: "sm-highlight", id })}
            onToggleSection={toggleSection}
            onReorder={reorderSections}
            loading={loadingDraft}
            onAddSection={() => {
              insertAfterRef.current = undefined;
              setLibraryOpen(true);
            }}
          />
        )}

        {/* Center: preview. The iframe stays mounted through page switches —
            the outgoing page remains visible under the veil (no blank flash). */}
        <main className="sm-builder-preview">
          {draft || loadingDraft ? (
            <div
              className="sm-builder-frame-wrap"
              style={{ width: VIEWPORT_WIDTH[viewport] }}
            >
              {frameSrc ? (
                <iframe
                  key={frameKey}
                  ref={iframeRef}
                  src={frameSrc}
                  className="sm-builder-frame"
                  title="Page preview"
                  onLoad={clearVeil}
                />
              ) : null}
              {(previewLoading || loadingDraft) && (
                <div className="sm-builder-frame-veil">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
              )}
            </div>
          ) : (
            <div className="sm-builder-preview-empty">
              <FileText className="h-8 w-8 opacity-30" />
              <p>Select a page to start editing, or create a new one.</p>
            </div>
          )}
        </main>

        <InspectorPanel
          draft={draft}
          section={selectedSection}
          options={options}
          onConfigChange={updateSelectedConfig}
          onStyleChange={updateSelectedStyle}
          onDuplicate={duplicateSection}
          onDelete={deleteSection}
          onClearSelection={() => setSelectedSectionId(null)}
          onOpenCodeEditor={() => setCodeEditorOpen(true)}
          onOpenPageSettings={() => setPageSettingsOpen(true)}
          chromeTarget={chromeTarget}
          chrome={chrome}
          onChromeChange={updateChrome}
          brand={brand}
          themeDefaults={themeDefaults}
          schemeDesign={schemeDesign}
          onBrandChange={updateBrand}
          onClearChrome={() => setChromeTarget(null)}
          loading={loadingDraft}
        />
      </div>

      <div className="sm-builder-smallscreen">
        <p>
          The website builder needs a larger screen.
          <br />
          Please open it on a tablet or desktop.
        </p>
      </div>

      {/* Page settings (title / slug / SEO) — topbar-triggered dialog */}
      <Dialog open={pageSettingsOpen} onOpenChange={setPageSettingsOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>Page settings</DialogTitle>
            <DialogDescription>
              Title, address and search-engine details for this page.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <PageSettingsForm
              key={draft.id}
              draft={draft}
              onSave={handleSavePageMeta}
              onDeletePage={() => {
                setPageSettingsOpen(false);
                setDeletePageOpen(true);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Add-section library (slide-over next to the outline) */}
      <SectionLibrary
        open={libraryOpen}
        onAdd={addSection}
        onClose={() => {
          setLibraryOpen(false);
          insertAfterRef.current = undefined;
        }}
      />

      {/* Code editor (custom_code) — the wide surface the inspector can't be.
          Writes through to the draft live; autosave picks it up. */}
      <Dialog open={codeEditorOpen} onOpenChange={setCodeEditorOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-[920px]">
          <DialogHeader>
            <DialogTitle>Custom code</DialogTitle>
            <DialogDescription>
              Runs in a secure sandbox on your page. Changes save automatically.
            </DialogDescription>
          </DialogHeader>
          {selectedSection?.type === "custom_code" && (
            <div className="space-y-5 py-2">
              <SectionForm
                type="custom_code"
                config={selectedSection.config}
                setConfig={updateSelectedConfig}
                products={products}
                categories={categories}
                blogs={blogs}
              />
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setCodeEditorOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete page confirm */}
      <Dialog open={deletePageOpen} onOpenChange={setDeletePageOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Delete this page?</DialogTitle>
            <DialogDescription>
              “{draft?.title || draft?.slug}” and its sections will be deleted
              permanently. Visitors will get a 404 at /{draft?.slug}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeletePageOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleDeletePage}
              disabled={isPending}
              className="bg-[var(--dash-red,#d33a45)] hover:bg-[#b32e38]"
            >
              Delete page
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete section confirm (keyboard Delete) */}
      <Dialog open={deleteSectionOpen} onOpenChange={setDeleteSectionOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Delete this section?</DialogTitle>
            <DialogDescription>
              You can bring it back with Undo (⌘Z) while the builder stays open.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteSectionOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                deleteSection();
                setDeleteSectionOpen(false);
              }}
              className="bg-[var(--dash-red,#d33a45)] hover:bg-[#b32e38]"
            >
              Delete section
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New page */}
      <NewPageDialog
        open={newPageOpen}
        onClose={() => setNewPageOpen(false)}
        onCreated={(id, item) => {
          setPages((ps) => [item, ...ps]);
          setNewPageOpen(false);
          loadDraft(id);
        }}
      />

      {/* Controlled open with no onOpenChange: not dismissible by Esc/outside
          click — the user must pick an explicit way forward. */}
      <Dialog open={status === "blocked"}>
        <DialogContent className="sm:max-w-[460px]" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>This page changed somewhere else</DialogTitle>
            <DialogDescription>
              It was edited from another tab or by a teammate. Reload to
              continue from their version, or keep yours: copy your changes as a
              backup, or overwrite theirs with what you have here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-col gap-2 sm:flex-col">
            <Button className="w-full" onClick={() => window.location.reload()}>
              Reload builder (use their version)
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    JSON.stringify(draftRef.current?.sections ?? [], null, 2),
                  );
                  toast.success("Your sections were copied as JSON.");
                } catch {
                  toast.error("Couldn't copy to the clipboard.");
                }
              }}
            >
              Copy my changes
            </Button>
            <Button
              variant="outline"
              className="w-full text-[var(--dash-red,#d33a45)]"
              disabled={isPending}
              onClick={() => {
                if (!draft) return;
                startTransition(async () => {
                  // Re-pull only for a fresh stale-tab token; the LOCAL
                  // sections stay and win — that's the point of taking over.
                  const fresh = await getPageDraft(draft.id);
                  if (!fresh) {
                    toast.error("Could not reach the page — try reloading.");
                    return;
                  }
                  tokenRef.current = fresh.updated_at;
                  const ok = await unblock();
                  if (ok) toast.success("Took over — your version is saved.");
                  else toast.error("Still couldn't save. Reload the builder.");
                });
              }}
            >
              Take over (overwrite with my version)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ViewportButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      className={`sm-builder-viewport ${active ? "active" : ""}`}
      onClick={onClick}
      title={label}
    >
      {icon}
    </button>
  );
}

function SaveStatusIndicator({
  status,
  onRetry,
}: {
  status: SaveStatus;
  onRetry: () => void;
}) {
  if (status === "error") {
    return (
      <button className="sm-builder-savestate is-error" onClick={onRetry}>
        Couldn&apos;t save — retry
      </button>
    );
  }
  const label =
    status === "saving" || status === "dirty"
      ? "Saving…"
      : status === "blocked"
        ? "Paused"
        : "Saved";
  return (
    <span
      className={`sm-builder-savestate ${status === "saved" ? "is-saved" : ""}`}
    >
      {status === "saving" || status === "dirty" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : null}
      {label}
    </span>
  );
}

function NewPageDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, item: PageListItem) => void;
}) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  // Once the user edits the slug by hand, stop auto-deriving it from the title.
  const slugEdited = useRef(false);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setTitle("");
      setSlug("");
      slugEdited.current = false;
    }
  }, [open]);

  const submit = () => {
    startTransition(async () => {
      const result = await createPage(slug, title);
      if (result.error || !result.data?.id) {
        toast.error(result.error ?? "Could not create the page.");
        return;
      }
      const id = result.data.id as string;
      const cleanSlug = slug.trim().toLowerCase();
      onCreated(id, {
        id,
        slug: cleanSlug,
        title: title.trim() || cleanSlug,
        status: "draft",
        updated_at: new Date().toISOString(),
        published_at: null,
      });
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>New page</DialogTitle>
          <DialogDescription>
            Give it a title and a URL slug. You can change these later.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <label className={labelClass}>Title</label>
            <input
              className={fieldClass}
              value={title}
              onChange={(e) => {
                const next = e.target.value;
                setTitle(next);
                if (!slugEdited.current) setSlug(slugify(next));
              }}
              placeholder="About Us"
              autoFocus
            />
          </div>
          <div>
            <label className={labelClass}>URL slug</label>
            <div className="flex items-center gap-1 text-sm">
              <span className="text-muted-foreground">/</span>
              <input
                className={fieldClass}
                value={slug}
                onChange={(e) => {
                  slugEdited.current = true;
                  setSlug(e.target.value);
                }}
                placeholder="about-us"
              />
            </div>
            <p className="text-muted-foreground mt-1 text-[11px]">
              Lowercase letters, numbers and hyphens.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending || !slug.trim()}>
            {isPending ? "Creating…" : "Create page"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
