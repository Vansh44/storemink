"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, PlayCircle } from "lucide-react";
import {
  openThemeStudioPreviewAction,
  startThemeStudioAcceptanceAction,
  submitThemeStudioBrowserEvidenceAction,
} from "@/app/actions/theme-studio-actions";

// The Theme Studio acceptance runner.
//
// Starts a run (the server stage happens inside that request), then — when the
// server returns a plan — drives the browser stage: each review surface is
// loaded at each acceptance viewport in a VISIBLE, exactly-sized frame, the
// preview's probe is asked to measure, and the raw results are submitted. The
// frame stays on screen because browsers throttle hidden cross-origin frames,
// which would stall measurement and distort the timings.
//
// ★ This page computes no verdict. It relays measurements; the server decides.

type ViewportKey = "desktop" | "tablet" | "mobile";
type Viewports = Record<ViewportKey, { width: number; height: number }>;
const VIEWPORT_ORDER: ViewportKey[] = ["desktop", "tablet", "mobile"];
const VIEWPORT_LABEL: Record<ViewportKey, string> = {
  desktop: "Laptop",
  tablet: "iPad",
  mobile: "Mobile",
};

interface PlanPage {
  surface: string;
  label: string;
  path: string;
}

interface Plan {
  runId: string;
  nonce: string;
  origin: string;
  enterToken: string;
  pages: PlanPage[];
  viewports: Viewports;
}

/** Entry tokens last ten minutes; renew a little before that. */
const TOKEN_REFRESH_MS = 8 * 60 * 1000;
/** How long one page may take to load and measure (axe included). */
const SAMPLE_TIMEOUT_MS = 120_000;

type Phase = "idle" | "server" | "browser" | "submitting";

function enterUrl(origin: string, token: string, path: string): string {
  const url = new URL("/api/theme-studio/preview/enter", origin);
  url.searchParams.set("token", token);
  url.searchParams.set("path", path);
  return url.toString();
}

export function AcceptanceRunner({
  projectId,
  versionId,
  canRun,
  blockedReason,
}: {
  projectId: string;
  versionId: string;
  canRun: boolean;
  blockedReason: string | null;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [frame, setFrame] = useState<{
    src: string;
    viewport: ViewportKey;
    width: number;
    height: number;
    label: string;
    index: number;
    total: number;
  } | null>(null);
  const [scale, setScale] = useState(1);
  const holder = useRef<HTMLDivElement>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const waiter = useRef<{
    origin: string;
    nonce: string;
    /** Which page this is: a reply for another page is ignored. */
    sample: number;
    acked: boolean;
    resolve: (value: Record<string, unknown> | null) => void;
  } | null>(null);

  // One listener for the whole run; it hands each message to whichever page
  // is currently being measured, and ignores everything else.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const current = waiter.current;
      if (!current || event.origin !== current.origin) return;
      if (event.source !== iframe.current?.contentWindow) return;
      const data = event.data as {
        type?: string;
        nonce?: string;
        sample?: number;
        result?: Record<string, unknown>;
      } | null;
      if (!data || data.nonce !== current.nonce) return;
      if (data.sample !== current.sample) return;
      if (data.type === "sm-acceptance-ack") current.acked = true;
      if (data.type === "sm-acceptance-result" && data.result) {
        waiter.current = null;
        current.resolve(data.result);
      }
      if (data.type === "sm-acceptance-error") {
        waiter.current = null;
        current.resolve(null);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const element = holder.current;
    if (!element || !frame) return;
    const measure = () =>
      setScale(Math.min(1, element.clientWidth / frame.width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame]);

  /** Load one page in the frame and wait for its probe's measurements. */
  const measurePage = useCallback(
    (plan: Plan, sample: number): Promise<Record<string, unknown> | null> =>
      new Promise((resolve) => {
        const state = {
          origin: plan.origin,
          nonce: plan.nonce,
          sample,
          acked: false,
          resolve,
        };
        waiter.current = state;
        const started = Date.now();
        // Ask repeatedly until the probe acknowledges: the page may still be
        // hydrating when it first loads.
        const ask = window.setInterval(() => {
          if (waiter.current !== state) {
            window.clearInterval(ask);
            return;
          }
          if (Date.now() - started > SAMPLE_TIMEOUT_MS) {
            window.clearInterval(ask);
            waiter.current = null;
            resolve(null);
            return;
          }
          if (!state.acked) {
            iframe.current?.contentWindow?.postMessage(
              { type: "sm-acceptance-run", nonce: plan.nonce, sample },
              plan.origin,
            );
          }
        }, 1000);
      }),
    [],
  );

  async function run() {
    setError(null);
    setNotice(null);
    setPhase("server");
    const started = await startThemeStudioAcceptanceAction({
      projectId,
      versionId,
    });
    if (!started.ok) {
      setPhase("idle");
      setError(started.error ?? "The check could not start.");
      return;
    }
    if (started.status !== "awaiting_browser" || !started.plan) {
      setPhase("idle");
      setNotice(
        started.status === "blocked"
          ? "The security scan failed. The project is now blocked."
          : "Server checks failed before a preview could be measured.",
      );
      router.refresh();
      return;
    }

    const plan: Plan = started.plan;
    let token = plan.enterToken;
    let mintedAt = Date.now();
    const samples: Record<string, unknown>[] = [];
    const total = VIEWPORT_ORDER.length * plan.pages.length;
    let index = 0;
    setPhase("browser");
    for (const viewport of VIEWPORT_ORDER) {
      const size = plan.viewports[viewport];
      for (const page of plan.pages) {
        index += 1;
        if (Date.now() - mintedAt > TOKEN_REFRESH_MS) {
          const renewed = await openThemeStudioPreviewAction({
            projectId,
            versionId,
          });
          if (renewed.ok && renewed.preview) {
            token = renewed.preview.enterToken;
            mintedAt = Date.now();
          }
        }
        // A cache-busting query keeps two loads of one URL distinct frames.
        const src = `${enterUrl(plan.origin, token, page.path)}&m=${index}`;
        setFrame({
          src,
          viewport,
          width: size.width,
          height: size.height,
          label: `${page.label} · ${VIEWPORT_LABEL[viewport]}`,
          index,
          total,
        });
        const result = await measurePage(plan, index);
        if (result) {
          samples.push({ ...result, viewport, surface: page.surface });
        }
      }
    }
    setFrame(null);
    if (samples.length === 0) {
      setPhase("idle");
      setError(
        "The preview never answered, so nothing could be measured. The frame may have been blocked by the browser; try again.",
      );
      router.refresh();
      return;
    }
    setPhase("submitting");
    const submitted = await submitThemeStudioBrowserEvidenceAction({
      projectId,
      runId: plan.runId,
      nonce: plan.nonce,
      evidence: { userAgent: navigator.userAgent, samples },
    });
    setPhase("idle");
    if (!submitted.ok) {
      setError(submitted.error ?? "The browser results could not be saved.");
    } else {
      setNotice(
        submitted.status === "passed"
          ? "Every required gate passed. This version is now a candidate."
          : "Some required gates did not pass. The details are below.",
      );
    }
    router.refresh();
  }

  const busy = phase !== "idle";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || !canRun}
          className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <PlayCircle className="h-4 w-4" />
          )}
          {phase === "server"
            ? "Running server checks…"
            : phase === "browser"
              ? "Measuring in this browser…"
              : phase === "submitting"
                ? "Saving results…"
                : "Run acceptance checks"}
        </button>
        {!canRun && blockedReason ? (
          <p className="text-sm text-slate-500">{blockedReason}</p>
        ) : null}
      </div>
      {phase === "server" ? (
        <p className="text-sm text-slate-500">
          Checking the package, building the preview store and fetching its
          pages. The first check of a version can take a minute.
        </p>
      ) : null}
      {error ? (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          {notice}
        </p>
      ) : null}
      {frame ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-600">
            Measuring <span className="font-medium">{frame.label}</span> (
            {frame.index} of {frame.total}). Keep this tab open and visible.
          </p>
          <div ref={holder} className="w-full">
            <div
              className="relative mx-auto overflow-hidden rounded-xl border border-slate-300 bg-white"
              style={{
                width: frame.width * scale,
                height: frame.height * scale,
              }}
            >
              <iframe
                ref={iframe}
                key={frame.src}
                title={`Acceptance measurement, ${frame.label}`}
                src={frame.src}
                width={frame.width}
                height={frame.height}
                style={{
                  width: frame.width,
                  height: frame.height,
                  transform: `scale(${scale})`,
                  transformOrigin: "0 0",
                  border: 0,
                }}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
