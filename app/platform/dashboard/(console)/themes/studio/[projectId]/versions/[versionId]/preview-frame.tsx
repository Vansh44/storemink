"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ExternalLink,
  Laptop,
  Loader2,
  RefreshCw,
  Smartphone,
  Tablet,
} from "lucide-react";
import { openThemeStudioPreviewAction } from "@/app/actions/theme-studio-actions";

type ViewportKey = "desktop" | "tablet" | "mobile";
type Viewports = Record<ViewportKey, { width: number; height: number }>;

interface Opened {
  origin: string;
  enterToken: string;
  pages: { surface: string; label: string; path: string }[];
  expiresAt: string;
  mintedAt: number;
}

const VIEWPORT_LABELS: Record<
  ViewportKey,
  { label: string; icon: typeof Laptop }
> = {
  desktop: { label: "Laptop", icon: Laptop },
  tablet: { label: "iPad", icon: Tablet },
  mobile: { label: "Mobile", icon: Smartphone },
};

/** Entry tokens last ten minutes; renew a little before that. */
const TOKEN_REFRESH_MS = 8 * 60 * 1000;

function enterUrl(opened: Opened, path: string): string {
  const url = new URL("/api/theme-studio/preview/enter", opened.origin);
  url.searchParams.set("token", opened.enterToken);
  url.searchParams.set("path", path);
  return url.toString();
}

export function PreviewFrame({
  projectId,
  versionId,
  viewports,
}: {
  projectId: string;
  versionId: string;
  viewports: Viewports;
}) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewport, setViewport] = useState<ViewportKey>("desktop");
  const [path, setPath] = useState("/");
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const holder = useRef<HTMLDivElement>(null);

  const accept = useCallback(
    (result: Awaited<ReturnType<typeof openThemeStudioPreviewAction>>) => {
      setLoading(false);
      if (!result.ok || !result.preview) {
        setError(result.error ?? "The preview couldn't be opened.");
        return null;
      }
      setError(null);
      const next = { ...result.preview, mintedAt: Date.now() };
      setOpened(next);
      return next;
    },
    [],
  );

  /** From an event handler: show progress, then open. */
  const open = useCallback(async (): Promise<Opened | null> => {
    setLoading(true);
    return accept(await openThemeStudioPreviewAction({ projectId, versionId }));
  }, [accept, projectId, versionId]);

  // A fresh token for every navigation keeps each frame load self-contained:
  // it does not depend on a cookie a browser may refuse inside a frame.
  const navigate = useCallback(
    async (nextPath: string) => {
      setPath(nextPath);
      let current = opened;
      if (!current || Date.now() - current.mintedAt > TOKEN_REFRESH_MS) {
        current = await open();
      }
      if (current) setFrameSrc(enterUrl(current, nextPath));
    },
    [open, opened],
  );

  // The first open starts in the loading state, so the effect only sets
  // state once the server has answered.
  useEffect(() => {
    let cancelled = false;
    void openThemeStudioPreviewAction({ projectId, versionId }).then(
      (result) => {
        if (cancelled) return;
        const first = accept(result);
        if (first) setFrameSrc(enterUrl(first, "/"));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [accept, projectId, versionId]);

  const size = viewports[viewport];
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const measure = () =>
      setScale(Math.min(1, element.clientWidth / size.width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [size.width]);

  async function popOut() {
    let current = opened;
    if (!current || Date.now() - current.mintedAt > TOKEN_REFRESH_MS) {
      current = await open();
    }
    if (current) window.open(enterUrl(current, path), "_blank", "noopener");
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Viewport"
          className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5"
        >
          {(Object.keys(VIEWPORT_LABELS) as ViewportKey[]).map((key) => {
            const { label, icon: Icon } = VIEWPORT_LABELS[key];
            return (
              <button
                key={key}
                type="button"
                aria-pressed={viewport === key}
                onClick={() => setViewport(key)}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition ${
                  viewport === key
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                <Icon className="h-4 w-4" /> {label}
                <span className="text-xs opacity-70">
                  {viewports[key].width}×{viewports[key].height}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void navigate(path)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
          >
            <RefreshCw className="h-4 w-4" /> Reload
          </button>
          <button
            type="button"
            onClick={() => void popOut()}
            disabled={loading && !opened}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
          >
            <ExternalLink className="h-4 w-4" /> Open full page
          </button>
        </div>
      </div>

      {opened ? (
        <nav aria-label="Preview pages" className="flex flex-wrap gap-1.5">
          {opened.pages.map((page) => (
            <button
              key={page.surface}
              type="button"
              aria-current={page.path === path ? "page" : undefined}
              onClick={() => void navigate(page.path)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                page.path === path
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 text-slate-700 hover:bg-slate-50"
              }`}
            >
              {page.label}
            </button>
          ))}
        </nav>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}

      <div ref={holder} className="w-full">
        <div
          className="relative mx-auto overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm"
          style={{
            width: size.width * scale,
            height: size.height * scale,
          }}
        >
          {frameSrc ? (
            <iframe
              key={viewport}
              title={`Theme preview, ${VIEWPORT_LABELS[viewport].label}`}
              src={frameSrc}
              width={size.width}
              height={size.height}
              style={{
                width: size.width,
                height: size.height,
                transform: `scale(${scale})`,
                transformOrigin: "0 0",
                border: 0,
              }}
            />
          ) : null}
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-white/70 text-sm text-slate-600">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Preparing the
              preview — the first open of a version builds its store.
            </div>
          ) : null}
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Links inside the preview work as they would in a live store. Checkout is
        switched off, and the preview closes itself a day after it was last
        opened.
      </p>
    </div>
  );
}
