"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { queueThemeStudioImagesAction } from "@/app/actions/theme-studio-actions";

// Queues an image run for one version (Track 3.2). The cost is stated before
// the click because every image is paid and a run is never retried on its own.
// Each image is checked by a vision model and redrawn once if it has a
// problem (Track 3.4), so the statement gives the likely cost and the most a
// run can cost.
export function GenerateImagesButton({
  projectId,
  versionId,
  revision,
  packageDigest,
  slots,
  estimate,
  blockedReason,
}: {
  projectId: string;
  versionId: string;
  revision: number;
  packageDigest: string;
  /** Placeholder slots the run would draw. */
  slots: number;
  /** List-price figures (imageRunEstimate), or null for the test provider. */
  estimate: { images: number; expectedUsd: number; mostUsd: number } | null;
  blockedReason: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);

  if (slots === 0) return null;
  const images = slots + 1;

  const start = () =>
    startTransition(async () => {
      const result = await queueThemeStudioImagesAction({
        projectId,
        versionId,
        expectedRevision: revision,
        expectedPackageDigest: packageDigest,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Images are being drawn. The run appears on the project.");
      router.push(`/dashboard/themes/studio/${projectId}`);
    });

  return (
    <section className="rounded-xl border border-violet-200 bg-violet-50/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-1">
          <h2 className="text-sm font-semibold text-slate-900">
            Generate images
          </h2>
          <p className="text-sm text-slate-600">
            Draw an image for each of the {slots} placeholder slot
            {slots === 1 ? "" : "s"}, all matched to one art-direction image so
            they read as a set. The images become a new version; this one stays
            as it is. Each image is checked, and one with a problem is redrawn
            once.{" "}
            {estimate
              ? `That is ${images} images, about $${estimate.expectedUsd.toFixed(2)} at list price, or at most $${estimate.mostUsd.toFixed(2)} if every image has to be redrawn.`
              : "The test provider draws placeholder pictures at no cost."}
          </p>
          {blockedReason ? (
            <p className="text-sm text-amber-700">{blockedReason}</p>
          ) : null}
        </div>
        {confirming ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:bg-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={start}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Draw {images} images
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={Boolean(blockedReason)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Sparkles className="h-4 w-4" />
            Generate images
          </button>
        )}
      </div>
    </section>
  );
}
