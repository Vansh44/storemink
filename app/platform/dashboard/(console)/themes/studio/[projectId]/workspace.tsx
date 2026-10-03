"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Archive,
  ClipboardCheck,
  Images,
  Eye,
  GitBranch,
  GitCompare,
  History,
  RotateCcw,
  X,
} from "lucide-react";
import {
  archiveThemeStudioProjectAction,
  cancelThemeStudioRunAction,
  restoreThemeStudioVersionAction,
  retryThemeStudioRunAction,
} from "@/app/actions/theme-studio-actions";
import type {
  ThemeStudioProjectDetail,
  ThemeStudioRunView,
} from "@/lib/theme-studio/repository";
import { THEME_IMAGE_PROBLEM_LABEL } from "@/lib/theme-studio/image-history";
import {
  MAJOR_AXES,
  type DistinctnessReport,
} from "@/lib/theme-studio/fingerprint";
import { StudioStatusBadge, currentQaFailed, studioDate } from "../studio-ui";
import { ThemeConversation } from "./conversation";

// The project workspace. Everything shown was read server-side behind the
// superadmin gate; every button calls an action that re-checks it. Reference
// images load through the gated, no-store reference route — there is no
// public URL for them to leak through.

const ERROR_TEXT: Record<string, string> = {
  invalid_output:
    "The model's output still failed validation after its repair attempts.",
  model_refused: "The model declined this request for safety reasons.",
  model_declined: "The model declined to build this theme.",
  output_truncated: "The model ran out of output space before finishing.",
  repair_not_supported:
    "Automatic repair stopped because the remaining findings require changes beyond the theme’s supported settings. Review the QA findings before retrying.",
  rate_limited:
    "The model provider still refused this request after automatic retries. Your existing version is unchanged. Retry this run when provider capacity is available.",
  provider_auth: "StoreMink couldn't authenticate with the model provider.",
  provider_rejected: "The model provider rejected the request.",
  provider_timeout: "The model provider took too long to respond.",
  run_timeout: "The run hit its time limit.",
  generation_disabled: "Generation was switched off before this run started.",
  model_disabled: "This model was switched off before this run started.",
  cancelled: "The run was cancelled.",
  provider_error: "The provider failed after its retries.",
  provider_unavailable: "No provider was available for this run.",
  lease_expired: "The run stopped responding and ran out of attempts.",
  input_missing: "The run's brief could not be found.",
  worker_error: "The worker failed while running this request.",
  image_checkpoint_unavailable:
    "Image recovery storage was unavailable. Retry this run to resume saved artwork.",
  image_review_unavailable:
    "Image review could not finish after automatic retries. Artwork is saved; retry this run to review it again.",
  project_state_changed: "The project changed while the run was working.",
  base_missing: "The version being revised could not be found.",
  base_changed:
    "The version being revised is not the one the run was queued against.",
  base_invalid: "The version being revised no longer passes validation.",
  images_anchor_refused:
    "The image model refused the art-direction image, so nothing else was drawn.",
  images_anchor_rejected:
    "The art-direction image failed its check on every attempt, so nothing else was drawn.",
  images_none: "No image came back, so no version was made.",
  images_package_invalid:
    "The theme with the new images no longer passed its checks.",
  images_asset_conflict: "A drawn image clashed with a stored file.",
  images_nothing_to_draw: "There was nothing left to draw.",
};

function errorText(code: string): string {
  return (
    ERROR_TEXT[code] ??
    (code.startsWith("images_anchor_")
      ? "The art-direction image could not be drawn, so nothing else was."
      : "The run failed.")
  );
}

/** One line about an image run: what came back and what it cost. */
function imageRunLine(images: NonNullable<ThemeStudioRunView["images"]>) {
  const parts = [
    `${images.generated + (images.pendingReview ?? 0)} drawn`,
    images.pendingReview
      ? `${images.pendingReview} saved, awaiting review`
      : null,
    images.rejected > 0
      ? `${images.rejected} failed the check and kept the placeholder`
      : null,
    images.failed > 0 ? `${images.failed} not drawn (refused or failed)` : null,
    images.skipped > 0 ? `${images.skipped} not reached` : null,
    images.redrawn > 0 ? `${images.redrawn} redrawn after a check` : null,
    images.flagged > 0 ? `${images.flagged} kept with a minor problem` : null,
    images.unreviewed > 0 ? `${images.unreviewed} unchecked` : null,
    `images ${formatCost(images.imageCostMicroUsd)} + checks ${formatCost(images.reviewCostMicroUsd)} estimated`,
  ];
  return parts.filter(Boolean).join(" · ");
}

const REVISABLE = ["ready", "candidate", "approved"];

function newKey(): string {
  return crypto.randomUUID();
}

function formatCost(microUsd: number): string {
  return `~$${(microUsd / 1_000_000).toFixed(microUsd < 10_000 ? 4 : 2)}`;
}

/** The latest automated acceptance verdict for one version. */
export interface VersionAcceptance {
  status:
    | "running"
    | "awaiting_browser"
    | "passed"
    | "failed"
    | "blocked"
    | "error"
    | "expired";
  currentBuild: boolean;
}

const ACCEPTANCE_CHIP: Record<
  VersionAcceptance["status"],
  { label: string; tone: string }
> = {
  running: { label: "checking", tone: "bg-sky-50 text-sky-700" },
  awaiting_browser: { label: "checking", tone: "bg-sky-50 text-sky-700" },
  passed: { label: "checks passed", tone: "bg-emerald-50 text-emerald-700" },
  failed: { label: "checks failed", tone: "bg-red-50 text-red-700" },
  blocked: { label: "security block", tone: "bg-amber-50 text-amber-800" },
  error: { label: "check incomplete", tone: "bg-slate-100 text-slate-600" },
  expired: { label: "check incomplete", tone: "bg-slate-100 text-slate-600" },
};

export function ProjectWorkspace({
  project,
  modelLabel,
  generationEnabled,
  testProvider,
  referenceLimit,
  acceptance = {},
  repairDraft,
}: {
  project: ThemeStudioProjectDetail;
  modelLabel: string;
  generationEnabled: boolean;
  testProvider: boolean;
  referenceLimit: number;
  acceptance?: Record<string, VersionAcceptance>;
  repairDraft?: { body: string; versionId: string };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reviseFrom, setReviseFrom] = useState<string | null>(
    repairDraft?.versionId ?? null,
  );
  const reviseBox = useRef<HTMLTextAreaElement>(null);

  const activeRun = project.runs.find(
    (r) => r.status === "queued" || r.status === "running",
  );
  const latestRun = project.runs[0] ?? null;
  const packagedVersions = project.versions.filter((v) => v.hasPackage);
  const canRevise =
    !activeRun &&
    REVISABLE.includes(project.status) &&
    packagedVersions.length > 0;
  const reviseTarget =
    packagedVersions.find((v) => v.id === reviseFrom) ??
    packagedVersions.find((v) => v.id === project.currentVersionId) ??
    packagedVersions[0] ??
    null;
  const canRestore =
    !activeRun &&
    (project.status === "ready" ||
      project.status === "blocked" ||
      project.status === "candidate");
  const versionNumber = new Map(
    project.versions.map((v) => [v.id, v.versionNumber]),
  );
  const previewFor = new Map(project.previews.map((p) => [p.versionId, p]));

  // Poll only while something is running, and only while the tab is visible:
  // a Studio tab left open overnight must not refresh all night.
  useEffect(() => {
    if (project.status !== "generating" && !activeRun) return;
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(tick, 2500);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [project.status, activeRun, router]);

  function run(
    action: () => Promise<{ ok: boolean; error?: string }>,
    done?: string,
  ) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        toast.error(result.error ?? "That didn't work.");
        return;
      }
      if (done) toast.success(done);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
              {project.name}
            </h1>
            <StudioStatusBadge
              status={project.status}
              qaFailed={currentQaFailed(project)}
            />
          </div>
          <p className="mt-1 text-sm text-slate-500">
            <span className="font-mono">{project.themeId}</span> · {modelLabel}{" "}
            · created by {project.createdByEmail} on{" "}
            {studioDate(project.createdAt)}
          </p>
        </div>
        {project.status !== "archived" && !activeRun ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              if (
                !window.confirm("Archive this project? It can't be reopened.")
              )
                return;
              run(
                () =>
                  archiveThemeStudioProjectAction({
                    projectId: project.id,
                    expectedRevision: project.revision,
                  }),
                "Project archived.",
              );
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
          >
            <Archive className="h-4 w-4" /> Archive
          </button>
        ) : null}
      </header>

      {testProvider ? (
        <p className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
          Test provider: runs make no model call and do not look at your
          references. They produce a placeholder design intent so the workflow
          can be checked end to end.
        </p>
      ) : null}

      <ThemeConversation
        initialBody={repairDraft?.body}
        key={`${project.id}:${project.status === "blocked" ? "answer" : project.status === "draft" ? "create" : "revise"}`}
        project={project}
        generationEnabled={generationEnabled}
        referenceLimit={referenceLimit}
        target={reviseTarget}
        canRevise={canRevise}
        onSelectVersion={setReviseFrom}
        composerRef={reviseBox}
      />

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Runs</h2>
        {project.runs.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            Nothing has been queued yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {project.runs.map((r) => {
              const retryable =
                r.id === latestRun?.id &&
                (r.status === "failed" || r.status === "cancelled") &&
                (project.status === "failed" || project.status === "ready");
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                >
                  <div>
                    <p className="font-medium capitalize text-slate-900">
                      {r.kind} · {r.status}
                      {r.cancelRequested && r.status === "running"
                        ? " (cancelling)"
                        : ""}
                    </p>
                    <p className="text-xs text-slate-500">
                      {r.provider === "fake"
                        ? "Test provider"
                        : "Gemini on Vertex AI"}{" "}
                      · worker attempt {r.attemptCount}/{r.maxAttempts} · queued{" "}
                      {studioDate(r.createdAt)}
                      {r.finishedAt
                        ? ` · finished ${studioDate(r.finishedAt)}`
                        : ""}
                    </p>
                    {r.status === "queued" && r.retryNotBefore ? (
                      <p className="text-xs text-amber-700">
                        {r.kind === "images" ? (
                          <>
                            Artwork is saved. Image review retry{" "}
                            {r.imageReviewDeferrals}/2 is scheduled after{" "}
                            {studioDate(r.retryNotBefore)}; completed images
                            will be reused.
                          </>
                        ) : (
                          <>
                            Waiting for model provider capacity. Automatic
                            recovery {r.rateLimitDeferrals}/4 is scheduled after{" "}
                            {studioDate(r.retryNotBefore)}. Completed model
                            stages are saved; you can leave this page open or
                            return later.
                          </>
                        )}
                      </p>
                    ) : null}
                    {r.kind === "images" ? (
                      <p className="text-xs text-slate-700">
                        {r.imageSlotIds.length > 0
                          ? `Redraw of ${r.imageSlotIds.length} image${r.imageSlotIds.length === 1 ? "" : "s"}`
                          : "Every placeholder"}
                        {r.images ? ` · ${imageRunLine(r.images)}` : ""}
                      </p>
                    ) : null}
                    {r.usage && r.kind !== "images" ? (
                      <p className="text-xs text-slate-500">
                        {r.usage.inputTokens.toLocaleString("en-IN")} in ·{" "}
                        {r.usage.outputTokens.toLocaleString("en-IN")} out
                        {r.usage.thinkingTokens > 0
                          ? ` · ${r.usage.thinkingTokens.toLocaleString("en-IN")} thinking`
                          : ""}
                        {r.usage.cachedTokens > 0
                          ? ` · ${r.usage.cachedTokens.toLocaleString("en-IN")} cached`
                          : ""}{" "}
                        · {formatCost(r.usage.estimatedCostMicroUsd)} estimated
                        {r.usage.repairs > 0
                          ? ` · ${r.usage.repairs} repair(s)`
                          : ""}
                      </p>
                    ) : null}
                    {r.errorCode ? (
                      <p className="text-xs text-red-700">
                        {errorText(r.errorCode)}{" "}
                        <span className="font-mono">({r.errorCode})</span>
                        {r.refusalCategory
                          ? ` · category ${r.refusalCategory}`
                          : ""}
                      </p>
                    ) : null}
                    {r.images?.anchorRejection ? (
                      <p className="text-xs text-red-700">
                        Check found:{" "}
                        {r.images.anchorRejection.problems
                          .map((p) => THEME_IMAGE_PROBLEM_LABEL[p])
                          .join(", ") || "a problem"}
                        {r.images.anchorRejection.note
                          ? ` — ${r.images.anchorRejection.note}`
                          : ""}
                      </p>
                    ) : null}
                    {r.declineReason ? (
                      <p className="text-xs text-red-700">
                        Reason: {r.declineReason}
                      </p>
                    ) : null}
                    {r.questions.length > 0 ? (
                      <p className="text-xs text-amber-700">
                        Asked {r.questions.length} clarifying question
                        {r.questions.length === 1 ? "" : "s"}.
                      </p>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    {(r.status === "queued" || r.status === "running") &&
                    !r.cancelRequested ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(
                            () =>
                              cancelThemeStudioRunAction({
                                projectId: project.id,
                                runId: r.id,
                              }),
                            "Cancellation requested.",
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
                      >
                        <X className="h-3.5 w-3.5" /> Cancel
                      </button>
                    ) : null}
                    {retryable ? (
                      <button
                        type="button"
                        disabled={pending || !generationEnabled}
                        onClick={() =>
                          run(
                            () =>
                              retryThemeStudioRunAction({
                                projectId: project.id,
                                runId: r.id,
                                idempotencyKey: newKey(),
                              }),
                            "Retry queued.",
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                      >
                        <RotateCcw className="h-3.5 w-3.5" /> Retry
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Versions</h2>
        <p className="mt-1 text-xs text-slate-500">
          Versions are saved snapshots. Image updates and catalogue captures
          also create snapshots; they are not additional design revisions.
        </p>
        {project.currentVersionId &&
        (project.status === "ready" || project.status === "candidate") ? (
          <p className="mt-1 text-xs text-slate-500">
            {project.status === "ready" ? (
              <>
                Run the{" "}
                <Link
                  href={`/dashboard/themes/studio/${project.id}/versions/${project.currentVersionId}/acceptance`}
                  className="font-medium text-slate-700 underline underline-offset-2"
                >
                  acceptance checks
                </Link>{" "}
                on the current version. Once they pass you can publish it.
              </>
            ) : (
              <>
                The current version passed its checks and is ready to publish.{" "}
                <Link
                  href={`/dashboard/themes/studio/${project.id}/release`}
                  className="font-medium text-slate-700 underline underline-offset-2"
                >
                  Publish it
                </Link>
                .
              </>
            )}
          </p>
        ) : null}
        {project.status === "approved" || project.status === "published" ? (
          <p className="mt-1 text-xs text-slate-500">
            {project.status === "approved"
              ? "Publishing didn't finish. "
              : "This theme is published. "}
            <Link
              href={`/dashboard/themes/studio/${project.id}/release`}
              className="font-medium text-slate-700 underline underline-offset-2"
            >
              {project.status === "approved"
                ? "Retry publishing"
                : "Manage the live theme"}
            </Link>
          </p>
        ) : null}
        {project.versions.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            {project.status === "generating"
              ? "Your theme is being prepared. Generated drafts stay private while images, catalog screenshots and automatic QA finish. This page updates automatically."
              : "No version yet. A successful run creates an immutable version."}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {project.versions.map((v) => (
              <li key={v.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="text-sm font-medium text-slate-900">
                    Version {v.versionNumber}
                    {v.id === project.currentVersionId ? " · current" : ""}
                    {v.parentVersionId ? (
                      <span className="ml-1 font-normal text-slate-500">
                        ·{" "}
                        {v.origin === "asset_edit"
                          ? `images replaced (${v.editedSlots.length}) on version`
                          : "revised from version"}{" "}
                        {v.parentVersionNumber ??
                          versionNumber.get(v.parentVersionId) ??
                          "?"}
                      </span>
                    ) : null}
                    {previewFor.get(v.id)?.status === "ready" ? (
                      <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-normal text-emerald-700">
                        preview open
                      </span>
                    ) : null}
                    {v.qaStatus !== "not_required" ? (
                      <span
                        className={`ml-2 rounded-full px-2 py-0.5 text-xs font-normal ${
                          v.qaStatus === "passed"
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-amber-50 text-amber-800"
                        }`}
                      >
                        {v.qaStatus === "failed" && v.captureStatus === "failed"
                          ? "auto QA capture failed"
                          : `auto QA ${v.qaStatus}`}
                        {v.qaIteration > 0
                          ? ` · ${v.qaIteration} revision${v.qaIteration === 1 ? "" : "s"}`
                          : ""}
                      </span>
                    ) : null}
                    {acceptance[v.id] ? (
                      <span
                        className={`ml-2 rounded-full px-2 py-0.5 text-xs font-normal ${ACCEPTANCE_CHIP[acceptance[v.id].status].tone}`}
                      >
                        {ACCEPTANCE_CHIP[acceptance[v.id].status].label}
                        {acceptance[v.id].status === "passed" &&
                        !acceptance[v.id].currentBuild
                          ? " · earlier build"
                          : ""}
                      </span>
                    ) : null}
                  </p>
                  {v.hasPackage ? (
                    <div className="flex flex-wrap gap-1.5">
                      <Link
                        href={`/dashboard/themes/studio/${project.id}/versions/${v.id}`}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
                      >
                        <Eye className="h-3.5 w-3.5" /> Preview
                      </Link>
                      <Link
                        href={`/dashboard/themes/studio/${project.id}/versions/${v.id}/acceptance`}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
                      >
                        <ClipboardCheck className="h-3.5 w-3.5" /> Checks
                      </Link>
                      <Link
                        href={`/dashboard/themes/studio/${project.id}/versions/${v.id}/images`}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
                      >
                        <Images className="h-3.5 w-3.5" /> Images
                        {v.packageSummary?.placeholders ? (
                          <span className="rounded-full bg-amber-50 px-1.5 text-amber-800">
                            {v.packageSummary.placeholders}
                          </span>
                        ) : null}
                      </Link>
                      {v.parentVersionId ? (
                        <Link
                          href={`/dashboard/themes/studio/${project.id}/compare?from=${v.parentVersionId}&to=${v.id}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
                        >
                          <GitCompare className="h-3.5 w-3.5" /> Changes
                        </Link>
                      ) : null}
                      {project.currentVersionId &&
                      v.id !== project.currentVersionId ? (
                        <Link
                          href={`/dashboard/themes/studio/${project.id}/compare?from=${project.currentVersionId}&to=${v.id}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
                        >
                          <GitCompare className="h-3.5 w-3.5" /> vs current
                        </Link>
                      ) : null}
                      {canRevise ? (
                        <button
                          type="button"
                          onClick={() => {
                            setReviseFrom(v.id);
                            reviseBox.current?.focus();
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
                        >
                          <GitBranch className="h-3.5 w-3.5" /> Revise from here
                        </button>
                      ) : null}
                      {canRestore && v.id !== project.currentVersionId ? (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() =>
                            run(
                              () =>
                                restoreThemeStudioVersionAction({
                                  projectId: project.id,
                                  versionId: v.id,
                                  expectedRevision: project.revision,
                                }),
                              `Version ${v.versionNumber} is current again.`,
                            )
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                        >
                          <History className="h-3.5 w-3.5" /> Make current
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {v.distinctness ? (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                    <p className="font-medium">
                      Design distinctness:{" "}
                      {v.distinctness.score === null
                        ? "not compared"
                        : `${Math.round(v.distinctness.score * 100)}%`}
                      {v.designDirection ? ` · ${v.designDirection}` : ""}
                      {v.paletteFamily ? ` · ${v.paletteFamily}` : ""}
                    </p>
                    {v.distinctness.nearestThemeId ? (
                      <p className="mt-1">
                        Closest theme: {v.distinctness.nearestThemeId}.{" "}
                        {v.distinctness.changedAxes} of {MAJOR_AXES} major
                        design axes differ (at least 3 count as distinct).
                      </p>
                    ) : null}
                    {v.distinctness.status === "similar" ? (
                      <p className="mt-1 text-amber-800">
                        This design still resembles the catalogue. Review its
                        composition before publishing.
                      </p>
                    ) : null}
                    {v.distinctness.status === "reference-led" ? (
                      <p className="mt-1">
                        Reference design takes priority; distinctness is
                        advisory.
                      </p>
                    ) : null}
                    {v.distinctness.sharedAttributes.length ? (
                      <p className="mt-1">
                        Shared choices:{" "}
                        {v.distinctness.sharedAttributes.join(", ")}.
                      </p>
                    ) : null}
                    {v.distinctness.repairAttempted ? (
                      <p className="mt-1">
                        {varietyCorrectionNote(v.distinctness)}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs">
                      This compares theme settings and structure; acceptance and
                      visual QA remain separate.
                    </p>
                  </div>
                ) : null}
                {v.qaStatus === "failed" &&
                (v.qaFindings?.length ||
                  v.qaDiagnosis ||
                  v.qaRepairs?.length) ? (
                  <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                    <p className="font-medium">Automatic QA needs attention</p>
                    {v.qaDiagnosis ? (
                      <p className="mt-1">{v.qaDiagnosis}</p>
                    ) : null}
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      {v.qaRepairs?.map((repair, i) => (
                        <li key={`repair-${i}`}>
                          <strong>
                            {repair.kind === "renderer"
                              ? "Platform fix"
                              : repair.kind === "image"
                                ? "Image slot"
                                : "Theme settings"}
                            {repair.target ? ` · ${repair.target}` : ""}:
                          </strong>{" "}
                          {repair.reason}
                        </li>
                      ))}
                      {(v.qaFindings ?? []).map((finding, i) => (
                        <li key={i}>{finding}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <p className="mt-1 text-sm text-slate-700">{v.summary}</p>
                {v.packageSummary ? (
                  <div className="mt-2 space-y-1 text-xs text-slate-600">
                    <p>
                      {v.packageSummary.pages} pages ·{" "}
                      {v.packageSummary.sections} sections ·{" "}
                      {v.packageSummary.products} sample products
                    </p>
                    {v.packageSummary.missingCategoryImages > 0 ? (
                      <p className="text-amber-700">
                        {v.packageSummary.missingCategoryImages} categories have
                        no image slot. Revise this version to add the missing
                        category imagery.
                      </p>
                    ) : null}
                    {v.packageSummary.placeholders > 0 ? (
                      <p className="text-amber-700">
                        {v.packageSummary.catalogPlaceholders ===
                        v.packageSummary.placeholders
                          ? `${v.packageSummary.catalogPlaceholders} catalog pictures await browser capture. Open Images to capture them.`
                          : `${v.packageSummary.placeholders - v.packageSummary.catalogPlaceholders} artwork placeholders and ${v.packageSummary.catalogPlaceholders} catalog pictures remain. Open Images to finish them before publishing.`}
                      </p>
                    ) : null}
                    {v.captureStatus === "failed" ? (
                      <p className="text-red-700">
                        Catalog capture did not complete. Open Images to retry
                        the browser capture before reviewing this version.
                      </p>
                    ) : null}
                    {v.packageSummary.gaps.length > 0 ? (
                      <ul className="space-y-0.5">
                        {v.packageSummary.gaps.map((gap, i) => (
                          <li key={`${gap.code}-${i}`}>
                            <span
                              className={
                                gap.blocking
                                  ? "font-semibold text-red-700"
                                  : "text-slate-700"
                              }
                            >
                              {gap.blocking ? "Blocking gap" : "Gap"}
                            </span>
                            : {gap.requestedCapability}{" "}
                            <span className="font-mono text-slate-400">
                              ({gap.code})
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
                {v.assumptions.length > 0 ? (
                  <ul className="mt-2 list-disc pl-5 text-xs text-slate-500">
                    {v.assumptions.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-2 font-mono text-[11px] text-slate-400">
                  intent {v.intentDigest.slice(0, 16)} ·{" "}
                  {studioDate(v.createdAt)}
                  {v.hasPackage ? "" : " · design intent only"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Activity</h2>
        <ul className="mt-3 space-y-1.5 text-xs text-slate-600">
          {project.events.map((e) => (
            <li key={e.id} className="flex flex-wrap gap-x-2">
              <span className="text-slate-400">{studioDate(e.createdAt)}</span>
              <span className="font-medium text-slate-800">
                {e.eventType.replace(/_/g, " ")}
              </span>
              <span>{e.actorKind === "worker" ? "worker" : e.actorEmail}</span>
              {typeof e.detail.errorCode === "string" ? (
                <span className="font-mono text-red-700">
                  {e.detail.errorCode}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Whether the one automatic variety correction changed the design. */
export function varietyCorrectionNote(report: DistinctnessReport): string {
  const pct = (score: number) => `${Math.round(score * 100)}%`;
  if (report.beforeScore == null || report.score == null)
    return "One automatic variety correction was attempted.";
  return report.score > report.beforeScore
    ? `One automatic variety correction raised distinctness from ${pct(report.beforeScore)} to ${pct(report.score)}.`
    : "One automatic variety correction was attempted but did not make the design more distinct, so the original design was kept.";
}
