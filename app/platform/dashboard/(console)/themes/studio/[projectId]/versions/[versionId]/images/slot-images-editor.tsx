"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ImageUp, Loader2, Save, X } from "lucide-react";
import { toast } from "sonner";
import { replaceThemeStudioSlotImagesAction } from "@/app/actions/theme-studio-actions";
import type { ThemeStudioSlotView } from "@/lib/theme-studio/slot-images";

// The slot-image editor. Uploads go straight to the slot-image route, which
// crops and stores them without changing any version; they are STAGED here
// with alt text and provenance, and saved together as one new version.
// Nothing here decides validity — the server re-checks every field.

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
}) {
  const router = useRouter();
  const [staged, setStaged] = useState<Record<string, Staged>>({});
  const [uploading, setUploading] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [onlyPlaceholders, setOnlyPlaceholders] = useState(
    slots.some((slot) => slot.placeholder),
  );
  const [pending, startTransition] = useTransition();
  // The licence note typed last, offered for the next image: most uploads in
  // one sitting come from the same place.
  const lastLicense = useRef<{ source: Source; note: string } | null>(null);

  const visible = onlyPlaceholders
    ? slots.filter((slot) => slot.placeholder || staged[slot.id])
    : slots;
  const stagedCount = Object.keys(staged).length;

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
        <div className="flex items-center gap-3">
          {!canEdit && blockedReason ? (
            <span className="text-sm text-slate-500">{blockedReason}</span>
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
