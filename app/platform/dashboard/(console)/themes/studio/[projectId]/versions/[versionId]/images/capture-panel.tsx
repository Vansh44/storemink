"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Camera, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { queueThemeStudioCaptureAction } from "@/app/actions/theme-studio-actions";
import type { ThemeStudioCaptureView } from "@/lib/theme-studio/capture";

// Track 3.6: capture the catalog card and screenshots from the preview.
//
// The pictures are taken by a separate headless-Chromium job, so pressing the
// button only queues the capture; the panel then says where it stands. A
// capture costs no model spend and becomes a new version.

/** What a failed capture's code means, in operator words. */
export const CAPTURE_ERROR_TEXT: Record<string, string> = {
  base_changed: "The version changed before the capture started.",
  base_invalid: "The version could no longer be read.",
  operator_removed: "The operator who asked for it has been removed.",
  preview_failed: "The preview store couldn't be built for this version.",
  lease_expired: "The capture job stopped responding twice.",
  project_state_changed:
    "Another version became current while the pictures were being taken.",
  capture_incomplete: "The capture job didn't return every picture.",
  capture_too_large: "A picture was larger than the capture limit.",
  capture_unusable: "A picture couldn't be cropped to its slot.",
  capture_asset_conflict: "A picture clashed with a stored file.",
  capture_package_invalid:
    "The theme with the captured pictures no longer passed its checks.",
  capture_timeout: "The preview took too long to load in the capture job.",
  capture_network: "The capture job couldn't reach the preview.",
  capture_browser_error: "The capture job's browser failed.",
  qa_probe_missing: "The preview's QA checks did not finish loading.",
  qa_measure_failed: "The preview's browser measurements failed.",
};

export function captureErrorText(code: string | null): string {
  if (!code) return "The capture failed.";
  if (code.startsWith("preview_status_")) {
    return `The preview answered with HTTP ${code.slice("preview_status_".length)} instead of the storefront.`;
  }
  return CAPTURE_ERROR_TEXT[code] ?? "The capture failed.";
}

export interface CatalogSlotSummary {
  id: string;
  label: string;
  url: string | null;
  placeholder: boolean;
  captured: boolean;
}

export function CapturePanel({
  projectId,
  versionId,
  revision,
  packageDigest,
  isCurrent,
  canEdit,
  captureEnabled,
  blockers,
  latest,
  resultVersionNumber,
  slots,
}: {
  projectId: string;
  versionId: string;
  revision: number;
  packageDigest: string;
  /** Only the project's current version can be captured. */
  isCurrent: boolean;
  /** The project is ready or a candidate. */
  canEdit: boolean;
  /** True only after the separate browser worker and scheduler are deployed. */
  captureEnabled: boolean;
  blockers: string[];
  /** The project's most recent capture, if any. */
  latest: ThemeStudioCaptureView | null;
  resultVersionNumber: number | null;
  slots: CatalogSlotSummary[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  if (slots.length === 0) return null;
  const active = latest?.status === "queued" || latest?.status === "running";
  const reason = !captureEnabled
    ? "Catalog capture is unavailable until its browser worker is deployed. You can upload these pictures instead."
    : !isCurrent
      ? "Only the current version can be captured."
      : active
        ? null
        : !canEdit
          ? "Pictures can be captured only while the project is ready or a candidate."
          : (blockers[0] ?? null);

  const capture = () =>
    startTransition(async () => {
      const result = await queueThemeStudioCaptureAction({
        projectId,
        versionId,
        expectedRevision: revision,
        expectedPackageDigest: packageDigest,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) {
        toast.error(result.error ?? "The capture couldn't be queued.");
        return;
      }
      toast.success("Queued. The capture job takes the pictures shortly.");
      router.refresh();
    });

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-1">
          <h2 className="text-sm font-semibold text-slate-900">
            Catalog pictures
          </h2>
          <p className="text-sm text-slate-600">
            The theme catalog shows a card and desktop and phone screenshots.
            They are pictures of the storefront itself, so they are taken from
            this version&apos;s preview store in a real browser and saved as a
            new version. Capture them once the theme&apos;s images are final.
          </p>
          {latest ? (
            <p
              className={`text-sm ${
                latest.status === "failed"
                  ? "text-red-700"
                  : latest.status === "succeeded"
                    ? "text-emerald-700"
                    : "text-slate-700"
              }`}
            >
              {latest.status === "queued"
                ? "Queued: the capture job picks it up within a few minutes."
                : latest.status === "running"
                  ? "Capturing now."
                  : latest.status === "failed"
                    ? `Last capture failed: ${captureErrorText(latest.errorCode)}`
                    : latest.resultVersionId
                      ? null
                      : "Captured."}
              {latest.status === "succeeded" && latest.resultVersionId ? (
                <>
                  Captured into{" "}
                  <Link
                    href={`/dashboard/themes/studio/${projectId}/versions/${latest.resultVersionId}/images`}
                    className="underline"
                  >
                    version {resultVersionNumber ?? ""}
                  </Link>
                  .
                </>
              ) : null}
            </p>
          ) : null}
          {reason ? <p className="text-sm text-amber-700">{reason}</p> : null}
        </div>
        <button
          type="button"
          onClick={capture}
          disabled={pending || active || reason !== null}
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Camera className="h-4 w-4" />
          )}
          {slots.some((s) => s.captured)
            ? "Capture again"
            : "Capture catalog pictures"}
        </button>
      </div>
      <ul className="mt-3 flex flex-wrap gap-3">
        {slots.map((slot) => (
          <li key={slot.id} className="w-40 space-y-1 text-xs text-slate-600">
            <div className="flex h-24 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
              {slot.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={slot.url}
                  alt={slot.label}
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <span className="text-slate-400">No picture</span>
              )}
            </div>
            <p>
              {slot.label} ·{" "}
              {slot.placeholder
                ? "placeholder"
                : slot.captured
                  ? "captured"
                  : "uploaded"}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
