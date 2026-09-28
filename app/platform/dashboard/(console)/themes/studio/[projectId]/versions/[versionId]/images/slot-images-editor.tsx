"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ImageUp, Loader2, RefreshCw, Save, X } from "lucide-react";
import { toast } from "sonner";
import {
  queueThemeStudioImagesAction,
  replaceThemeStudioSlotImagesAction,
} from "@/app/actions/theme-studio-actions";
import {
  THEME_IMAGE_PROBLEM_LABEL,
  redrawEstimate,
  type SlotDrawHistory,
} from "@/lib/theme-studio/image-history";
import type { ThemeStudioSlotView } from "@/lib/theme-studio/slot-images";

// The slot-image editor. Uploads go straight to the slot-image route, which
// crops and stores them without changing any version; they are STAGED here
// with alt text and provenance, and saved together as one new version.
// Nothing here decides validity — the server re-checks every field.
//
// Track 3.5: each slot also shows what an image run is asked to draw for it
// (the brief) and how its current image came to be (attempts, the check's
// verdict, cost), and a placeholder or generated image can be ticked for a
// REDRAW — a run of just those slots, matched to the theme's existing
// art-direction image. An uploaded image is never offered: it is the
// operator's to replace.

type Source = "operator-owned" | "licensed";

interface Staged {
  assetId: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  alt: string;
  source: Source;
  licenseNote: string;
}

const SOURCE_LABEL: Record<string, string> = {
  generated: "Generated",
  "operator-owned": "Operator-owned",
  licensed: "Licensed",
  "legacy-bundled": "Bundled",
};

function ratio(width: number | null, height: number | null): string {
  if (!width || !height) return "";
  const r = width / height;
  const known: [number, string][] = [
    [1, "1:1"],
    [4 / 3, "4:3"],
    [3 / 4, "3:4"],
    [16 / 10, "16:10"],
    [16 / 9, "16:9"],
    [21 / 9, "21:9"],
    [3 / 2, "3:2"],
    [2 / 3, "2:3"],
    [9 / 19, "9:19"],
  ];
  const match = known.find(([value]) => Math.abs(value - r) / value < 0.02);
  return match ? match[1] : `${r.toFixed(2)}:1`;
}

function kb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function usd(microUsd: number): string {
  return `~$${(microUsd / 1_000_000).toFixed(microUsd < 10_000 ? 3 : 2)}`;
}

function problems(list: SlotDrawHistory["problems"]): string {
  return list.map((p) => THEME_IMAGE_PROBLEM_LABEL[p]).join(", ");
}

/** One line on how a slot's image came to be, and its tone. */
export function historyLine(history: SlotDrawHistory): {
  text: string;
  tone: "ok" | "warn" | "bad";
} {
  const twice = history.attempts > 1 ? " after a redraw" : "";
  // The reviewer writes whole sentences; the line adds its own full stop.
  const trimmed = history.note.trim().replace(/[.\s]+$/, "");
  const note = trimmed ? ` — ${trimmed}` : "";
  switch (history.status) {
    case "generated":
      if (history.review === "passed") {
        return { text: `Drawn and checked${twice}.`, tone: "ok" };
      }
      if (history.review === "flagged") {
        return {
          text: `Drawn${twice}; kept with ${problems(history.problems)}${note}.`,
          tone: "warn",
        };
      }
      return { text: `Drawn${twice}; not checked.`, tone: "warn" };
    case "rejected":
      return {
        text: `Failed its check twice (${problems(history.problems)})${note}. The placeholder was kept.`,
        tone: "bad",
      };
    case "refused":
      return {
        text: `The image model refused it${history.reason ? ` (${history.reason})` : ""}.`,
        tone: "bad",
      };
    default:
      return {
        text: `Not drawn${history.reason ? ` (${history.reason})` : ""}.`,
        tone: "bad",
      };
  }
}

const TONE: Record<"ok" | "warn" | "bad", string> = {
  ok: "text-emerald-700",
  warn: "text-amber-700",
  bad: "text-red-700",
};

export function SlotImagesEditor({
  projectId,
  versionId,
  versionNumber,
  nextVersionNumber,
  packageDigest,
  revision,
  canEdit,
  blockedReason,
  slots,
  anchorReusable,
  prices,
}: {
  projectId: string;
  versionId: string;
  versionNumber: number;
  nextVersionNumber: number;
  packageDigest: string;
  revision: number;
  canEdit: boolean;
  blockedReason: string | null;
  slots: ThemeStudioSlotView[];
  /** A redraw matches the existing art-direction image instead of drawing one. */
  anchorReusable: boolean;
  /** List prices for the redraw estimate; null for the test provider. */
  prices: { imageUsd: number; reviewUsd: number } | null;
}) {
  const router = useRouter();
  const [staged, setStaged] = useState<Record<string, Staged>>({});
  const [uploading, setUploading] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [onlyPlaceholders, setOnlyPlaceholders] = useState(
    slots.some((slot) => slot.placeholder),
  );
  const [pending, startTransition] = useTransition();
  const [redraw, setRedraw] = useState<Set<string>>(new Set());
  const [confirmingRedraw, setConfirmingRedraw] = useState(false);
  // The licence note typed last, offered for the next image: most uploads in
  // one sitting come from the same place.
  const lastLicense = useRef<{ source: Source; note: string } | null>(null);

  const visible = onlyPlaceholders
    ? slots.filter((slot) => slot.placeholder || staged[slot.id])
    : slots;
  const stagedCount = Object.keys(staged).length;
  const redrawCount = redraw.size;
  const estimate =
    prices && redrawCount > 0
      ? redrawEstimate(redrawCount, anchorReusable, prices)
      : null;

  function toggleRedraw(slotId: string, on: boolean) {
    setConfirmingRedraw(false);
    setRedraw((prev) => {
      const next = new Set(prev);
      if (on) next.add(slotId);
      else next.delete(slotId);
      return next;
    });
  }

  function startRedraw() {
    startTransition(async () => {
      const result = await queueThemeStudioImagesAction({
        projectId,
        versionId,
        expectedRevision: revision,
        expectedPackageDigest: packageDigest,
        idempotencyKey: crypto.randomUUID(),
        // Package order, so the run's message lists them as the page does.
        slotIds: slots.map((s) => s.id).filter((id) => redraw.has(id)),
      });
      if (!result.ok) {
        toast.error(result.error ?? "The redraw couldn't be queued.");
        return;
      }
      toast.success("Redrawing. The run appears on the project.");
      setRedraw(new Set());
      router.push(`/dashboard/themes/studio/${projectId}`);
    });
  }

  async function upload(slot: ThemeStudioSlotView, file: File) {
    setUploading(slot.id);
    setErrors((prev) => ({ ...prev, [slot.id]: "" }));
    try {
      const url = new URL(
        `/api/platform/theme-studio/projects/${projectId}/slot-images`,
        window.location.origin,
      );
      url.searchParams.set("versionId", versionId);
      url.searchParams.set("slot", slot.id);
      const response = await fetch(url, {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      const body = (await response.json().catch(() => ({}))) as {
        id?: string;
        url?: string;
        width?: number;
        height?: number;
        bytes?: number;
        error?: string;
      };
      if (!response.ok || !body.id || !body.url) {
        setErrors((prev) => ({
          ...prev,
          [slot.id]: body.error ?? "The image couldn't be uploaded.",
        }));
        return;
      }
      const license = lastLicense.current;
      // An upload replaces the slot; drawing it as well would be two answers.
      toggleRedraw(slot.id, false);
      setStaged((prev) => ({
        ...prev,
        [slot.id]: {
          assetId: body.id!,
          url: body.url!,
          width: body.width ?? 0,
          height: body.height ?? 0,
          bytes: body.bytes ?? 0,
          alt: prev[slot.id]?.alt ?? slot.alt,
          source: prev[slot.id]?.source ?? license?.source ?? "operator-owned",
          licenseNote: prev[slot.id]?.licenseNote ?? license?.note ?? "",
        },
      }));
    } catch {
      setErrors((prev) => ({
        ...prev,
        [slot.id]: "The upload didn't reach the server. Try again.",
      }));
    } finally {
      setUploading(null);
    }
  }

  function update(slotId: string, patch: Partial<Staged>) {
    setStaged((prev) => {
      const current = prev[slotId];
      if (!current) return prev;
      const next = { ...current, ...patch };
      if (patch.licenseNote !== undefined || patch.source !== undefined) {
        lastLicense.current = { source: next.source, note: next.licenseNote };
      }
      return { ...prev, [slotId]: next };
    });
  }

  function unstage(slotId: string) {
    setStaged((prev) => {
      const next = { ...prev };
      delete next[slotId];
      return next;
    });
  }

  function save() {
    startTransition(async () => {
      const result = await replaceThemeStudioSlotImagesAction({
        projectId,
        versionId,
        expectedRevision: revision,
        expectedPackageDigest: packageDigest,
        replacements: Object.entries(staged).map(([slotId, image]) => ({
          slotId,
          assetId: image.assetId,
          alt: image.alt,
          source: image.source,
          licenseNote: image.licenseNote,
        })),
      });
      if (!result.ok || !result.id) {
        toast.error(result.error ?? "The images couldn't be saved.");
        return;
      }
      toast.success(
        `Saved as version ${result.versionNumber ?? nextVersionNumber}.`,
      );
      setStaged({});
      router.push(
        `/dashboard/themes/studio/${projectId}/versions/${result.id}/images`,
      );
    });
  }

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
        <label className="inline-flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={onlyPlaceholders}
            onChange={(event) => setOnlyPlaceholders(event.target.checked)}
          />
          Show only slots with a placeholder
        </label>
        <div className="flex flex-wrap items-center gap-3">
          {!canEdit && blockedReason ? (
            <span className="text-sm text-slate-500">{blockedReason}</span>
          ) : null}
          {redrawCount > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="max-w-md text-xs text-slate-600">
                {stagedCount > 0
                  ? "Save or discard your uploads before redrawing."
                  : estimate
                    ? `${estimate.images} image${estimate.images === 1 ? "" : "s"}${anchorReusable ? "" : " (with a new art-direction image)"}, about $${estimate.expectedUsd.toFixed(2)}, at most $${estimate.mostUsd.toFixed(2)} if each needs every redraw.`
                    : "The test provider redraws at no cost."}
              </span>
              {confirmingRedraw ? (
                <>
                  <button
                    type="button"
                    onClick={() => setConfirmingRedraw(false)}
                    disabled={pending}
                    className="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={startRedraw}
                    disabled={pending}
                    className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                  >
                    {pending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                    Confirm redraw
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmingRedraw(true)}
                  disabled={!canEdit || stagedCount > 0 || pending}
                  className="inline-flex items-center gap-2 rounded-lg border border-violet-300 bg-violet-50 px-4 py-2 text-sm font-medium text-violet-800 hover:bg-violet-100 disabled:opacity-50"
                >
                  <RefreshCw className="h-4 w-4" />
                  Redraw {redrawCount} image{redrawCount === 1 ? "" : "s"}
                </button>
              )}
            </div>
          ) : null}
          <button
            type="button"
            onClick={save}
            disabled={!canEdit || stagedCount === 0 || pending || !!uploading}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {stagedCount === 0
              ? "Upload images to save a new version"
              : `Save ${stagedCount} image${stagedCount === 1 ? "" : "s"} as version ${nextVersionNumber}`}
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 px-6 py-8 text-center text-sm text-slate-500">
          Every slot in version {versionNumber} already has a real image.
        </p>
      ) : null}

      <ul className="space-y-3">
        {visible.map((slot) => {
          const image = staged[slot.id];
          const error = errors[slot.id];
          return (
            <li
              key={slot.id}
              className="rounded-xl border border-slate-200 bg-white p-4"
            >
              <div className="flex flex-wrap gap-4">
                <div className="flex gap-3">
                  <figure className="w-32 space-y-1">
                    <div className="flex h-24 w-32 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
                      {slot.url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={slot.url}
                          alt={slot.alt}
                          className="max-h-full max-w-full object-contain"
                        />
                      ) : (
                        <span className="text-xs text-slate-400">No image</span>
                      )}
                    </div>
                    <figcaption className="text-center text-xs text-slate-500">
                      Current
                    </figcaption>
                  </figure>
                  {image ? (
                    <figure className="w-32 space-y-1">
                      <div className="flex h-24 w-32 items-center justify-center overflow-hidden rounded-lg border-2 border-emerald-400 bg-slate-50">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={image.url}
                          alt={image.alt}
                          className="max-h-full max-w-full object-contain"
                        />
                      </div>
                      <figcaption className="text-center text-xs text-emerald-700">
                        New · {image.width}×{image.height} · {kb(image.bytes)}
                      </figcaption>
                    </figure>
                  ) : null}
                </div>

                <div className="min-w-[16rem] flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-slate-900">
                      {slot.id}
                    </span>
                    <span className="text-xs text-slate-500">
                      {slot.kind} · {ratio(slot.width, slot.height)}
                      {slot.catalogPreview ? " · max 250 KB" : ""}
                    </span>
                    {slot.placeholder ? (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                        placeholder
                      </span>
                    ) : (
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                        {SOURCE_LABEL[slot.source] ?? slot.source}
                      </span>
                    )}
                  </div>
                  {slot.usage.length ? (
                    <p className="text-xs text-slate-500">
                      Shown on: {slot.usage.slice(0, 4).join("; ")}
                      {slot.usage.length > 4
                        ? ` and ${slot.usage.length - 4} more`
                        : ""}
                    </p>
                  ) : null}
                  {slot.history ? (
                    <p className="text-xs">
                      <span className={TONE[historyLine(slot.history).tone]}>
                        {historyLine(slot.history).text}
                      </span>
                      <span className="text-slate-500">
                        {" "}
                        {slot.history.redraw ? "Redraw · " : ""}
                        {usd(slot.history.costMicroUsd)} estimated
                      </span>
                    </p>
                  ) : null}
                  {slot.brief ? (
                    <details className="text-xs text-slate-600">
                      <summary className="cursor-pointer text-slate-500 hover:text-slate-900">
                        What the image model is asked for
                      </summary>
                      <dl className="mt-1 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1">
                        <dt className="text-slate-400">Subject</dt>
                        <dd>{slot.brief.subject}</dd>
                        {slot.brief.artDirection ? (
                          <>
                            <dt className="text-slate-400">Direction</dt>
                            <dd>{slot.brief.artDirection}</dd>
                          </>
                        ) : null}
                        <dt className="text-slate-400">Shape</dt>
                        <dd>{slot.brief.aspectRatio}</dd>
                      </dl>
                    </details>
                  ) : null}

                  {image ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="space-y-1 text-xs text-slate-600 sm:col-span-2">
                        Alt text
                        {slot.catalogScreenshot
                          ? " (at least 15 characters)"
                          : ""}
                        <input
                          value={image.alt}
                          maxLength={200}
                          onChange={(event) =>
                            update(slot.id, { alt: event.target.value })
                          }
                          className="block w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
                        />
                      </label>
                      <label className="space-y-1 text-xs text-slate-600">
                        Source
                        <select
                          value={image.source}
                          onChange={(event) =>
                            update(slot.id, {
                              source: event.target.value as Source,
                            })
                          }
                          className="block w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
                        >
                          <option value="operator-owned">
                            Ours (photographed or made by us)
                          </option>
                          <option value="licensed">Licensed</option>
                        </select>
                      </label>
                      <label className="space-y-1 text-xs text-slate-600">
                        Licence note
                        <input
                          value={image.licenseNote}
                          maxLength={300}
                          placeholder={
                            image.source === "licensed"
                              ? "e.g. Unsplash licence, photo by …"
                              : "e.g. Photographed by StoreMink, 2026"
                          }
                          onChange={(event) =>
                            update(slot.id, {
                              licenseNote: event.target.value,
                            })
                          }
                          className="block w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900"
                        />
                      </label>
                    </div>
                  ) : null}

                  {error ? (
                    <p className="text-xs text-red-700">{error}</p>
                  ) : null}

                  <div className="flex flex-wrap items-center gap-2">
                    <label
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 ${
                        !canEdit || uploading
                          ? "pointer-events-none opacity-50"
                          : ""
                      }`}
                    >
                      {uploading === slot.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ImageUp className="h-3.5 w-3.5" />
                      )}
                      {image ? "Replace upload" : "Upload image"}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/avif"
                        className="sr-only"
                        disabled={!canEdit || !!uploading}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = "";
                          if (file) void upload(slot, file);
                        }}
                      />
                    </label>
                    {slot.redrawable && !image ? (
                      <label className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-slate-700">
                        <input
                          type="checkbox"
                          checked={redraw.has(slot.id)}
                          disabled={!canEdit}
                          onChange={(event) =>
                            toggleRedraw(slot.id, event.target.checked)
                          }
                        />
                        {slot.placeholder ? "Draw" : "Redraw"}
                      </label>
                    ) : null}
                    {image ? (
                      <button
                        type="button"
                        onClick={() => unstage(slot.id)}
                        className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-slate-500 hover:text-slate-900"
                      >
                        <X className="h-3.5 w-3.5" /> Don&apos;t use
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
