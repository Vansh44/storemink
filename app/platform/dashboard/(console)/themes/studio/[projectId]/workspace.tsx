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
  Loader2,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  archiveThemeStudioProjectAction,
  cancelThemeStudioRunAction,
  queueThemeStudioGenerationAction,
  removeThemeStudioReferenceAction,
  restoreThemeStudioVersionAction,
  retryThemeStudioRunAction,
  reviseThemeStudioVersionAction,
  submitThemeStudioDetailsAction,
} from "@/app/actions/theme-studio-actions";
import type { ThemeStudioProjectDetail } from "@/lib/theme-studio/repository";
import { StudioStatusBadge, studioDate } from "../studio-ui";

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
  rate_limited:
    "The model provider is rate-limiting requests. Try again shortly.",
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
  project_state_changed: "The project changed while the run was working.",
  base_missing: "The version being revised could not be found.",
  base_changed:
    "The version being revised is not the one the run was queued against.",
  base_invalid: "The version being revised no longer passes validation.",
};

const REVISABLE = ["ready", "candidate", "approved"];

const REFERENCE_ACCEPT = "image/jpeg,image/png,image/webp,image/avif";

function newKey(): string {
  return crypto.randomUUID();
}

function formatCost(microUsd: number): string {
  return `~$${(microUsd / 1_000_000).toFixed(microUsd < 10_000 ? 4 : 2)}`;
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024
    ? `${(n / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
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
}: {
  project: ThemeStudioProjectDetail;
  modelLabel: string;
  generationEnabled: boolean;
  testProvider: boolean;
  referenceLimit: number;
  acceptance?: Record<string, VersionAcceptance>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // One key per intent, reused if the same click is retried, so a double
  // submit finds its own run instead of queueing two.
  const queueKey = useRef<string>(newKey());
  const detailsKey = useRef<string>(newKey());
  const [details, setDetails] = useState("");
  const reviseKey = useRef<string>(newKey());
  const [revision, setRevision] = useState("");
  const [reviseFrom, setReviseFrom] = useState<string | null>(
    project.currentVersionId,
  );
  const reviseBox = useRef<HTMLTextAreaElement>(null);

  const activeRun = project.runs.find(
    (r) => r.status === "queued" || r.status === "running",
  );
  const latestRun = project.runs[0] ?? null;
  const awaitingDetails =
    project.status === "blocked" && (latestRun?.questions.length ?? 0) > 0;
  const referencesEditable = ["draft", "ready", "failed", "blocked"].includes(
    project.status,
  );
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
    if (!activeRun) return;
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(tick, 2500);
    return () => window.clearInterval(timer);
  }, [activeRun, router]);

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

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const response = await fetch(
          `/api/platform/theme-studio/projects/${project.id}/references`,
          {
            method: "POST",
            body: file,
            headers: { "Content-Type": "application/octet-stream" },
          },
        );
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          duplicate?: boolean;
        };
        if (!response.ok) {
          toast.error(`${file.name}: ${body.error ?? "upload failed"}`);
        } else if (body.duplicate) {
          toast.info(`${file.name} is already attached.`);
        }
      }
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
      router.refresh();
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
              {project.name}
            </h1>
            <StudioStatusBadge status={project.status} />
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

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-900">Brief</h2>
        {project.messages.length === 0 ? (
          <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
            {project.draftBrief}
          </p>
        ) : (
          <ol className="mt-2 space-y-3">
            {project.messages.map((m) => (
              <li key={m.id} className="rounded-lg bg-slate-50 p-3">
                <p className="text-xs text-slate-500">
                  {m.kind === "brief" ? "Submitted brief" : "Revision"} ·{" "}
                  {m.referenceCount} reference
                  {m.referenceCount === 1 ? "" : "s"} ·{" "}
                  {studioDate(m.createdAt)}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">
                  {m.body}
                </p>
              </li>
            ))}
          </ol>
        )}
        {project.status === "draft" ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <p className="text-xs text-slate-500">
              Queuing sends this brief with the {project.references.length}{" "}
              reference
              {project.references.length === 1 ? "" : "s"} below. Both are then
              kept unchanged with the run.
            </p>
            <button
              type="button"
              disabled={pending || !generationEnabled}
              onClick={() =>
                run(
                  () =>
                    queueThemeStudioGenerationAction({
                      projectId: project.id,
                      expectedRevision: project.revision,
                      idempotencyKey: queueKey.current,
                    }),
                  "Generation queued.",
                )
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Queue generation
            </button>
          </div>
        ) : null}
        {!generationEnabled && project.status === "draft" ? (
          <p className="mt-2 text-xs text-amber-700">
            Generation is switched off platform-wide.
          </p>
        ) : null}
      </section>

      {awaitingDetails && latestRun ? (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h2 className="text-sm font-semibold text-amber-900">
            The model needs more details
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
            {latestRun.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
          <textarea
            className="mt-3 block min-h-28 w-full rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm focus:border-amber-600 focus:outline-none"
            value={details}
            maxLength={12_000}
            onChange={(e) => setDetails(e.target.value)}
            placeholder="Answer the questions. Your answer is added to the brief and sent with the current references."
          />
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              disabled={pending || !generationEnabled || !details.trim()}
              onClick={() =>
                run(
                  () =>
                    submitThemeStudioDetailsAction({
                      projectId: project.id,
                      expectedRevision: project.revision,
                      body: details,
                      idempotencyKey: detailsKey.current,
                    }),
                  "Details sent. Generation queued.",
                )
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Answer and regenerate
            </button>
          </div>
        </section>
      ) : null}

      {canRevise && reviseTarget ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900">
              Revise version {reviseTarget.versionNumber}
              {reviseTarget.id !== project.currentVersionId ? (
                <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-normal text-amber-800">
                  starts a branch
                </span>
              ) : null}
            </h2>
            {packagedVersions.length > 1 ? (
              <label className="flex items-center gap-2 text-xs text-slate-600">
                Revise from
                <select
                  value={reviseTarget.id}
                  onChange={(e) => setReviseFrom(e.target.value)}
                  className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
                >
                  {packagedVersions.map((v) => (
                    <option key={v.id} value={v.id}>
                      Version {v.versionNumber}
                      {v.id === project.currentVersionId ? " (current)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <textarea
            ref={reviseBox}
            className="mt-3 block min-h-28 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-600 focus:outline-none"
            value={revision}
            maxLength={12_000}
            onChange={(e) => setRevision(e.target.value)}
            placeholder="Say what to change — for example: warmer palette, a bolder hero, move testimonials above the product grid. Everything you don't mention is kept."
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              A revision creates a new version. The one it revises stays as it
              is, and any version can be made current again.
            </p>
            <button
              type="button"
              disabled={pending || !generationEnabled || !revision.trim()}
              onClick={() =>
                run(async () => {
                  const result = await reviseThemeStudioVersionAction({
                    projectId: project.id,
                    versionId: reviseTarget.id,
                    expectedRevision: project.revision,
                    expectedPackageDigest: reviseTarget.packageDigest ?? "",
                    body: revision,
                    idempotencyKey: reviseKey.current,
                  });
                  if (result.ok) {
                    setRevision("");
                    reviseKey.current = newKey();
                  }
                  return result;
                }, "Revision queued.")
              }
              className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              Queue revision
            </button>
          </div>
        </section>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-900">
            References ({project.references.length}/{referenceLimit})
          </h2>
          {referencesEditable && project.references.length < referenceLimit ? (
            <>
              <input
                ref={fileInput}
                type="file"
                accept={REFERENCE_ACCEPT}
                multiple
                className="sr-only"
                id="studio-reference-upload"
                onChange={(e) => void upload(e.target.files)}
              />
              <label
                htmlFor="studio-reference-upload"
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50"
              >
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                Add screenshots
              </label>
            </>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-slate-500">
          JPEG, PNG, WebP or AVIF stills, up to 10 MB each. Every image is
          re-encoded before it is stored; the original file is not kept.
        </p>
        {project.references.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No references yet.</p>
        ) : (
          <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {project.references.map((ref) => (
              <li
                key={ref.id}
                className="overflow-hidden rounded-lg border border-slate-200"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- gated, no-store route; next/image would proxy and cache it */}
                <img
                  src={`/api/platform/theme-studio/references/${ref.id}`}
                  alt="Reference screenshot"
                  className="aspect-video w-full bg-slate-100 object-cover"
                  loading="lazy"
                />
                <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-slate-500">
                  <span>
                    {ref.width}×{ref.height} · {formatBytes(ref.byteSize)}
                  </span>
                  {referencesEditable && !ref.cited ? (
                    <button
                      type="button"
                      aria-label="Remove reference"
                      disabled={pending}
                      onClick={() =>
                        run(() =>
                          removeThemeStudioReferenceAction({
                            projectId: project.id,
                            assetId: ref.id,
                          }),
                        )
                      }
                      className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-red-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : ref.cited ? (
                    <span title="Sent with a generation request">Sent</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

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
                      · attempt {r.attemptCount}/{r.maxAttempts} · queued{" "}
                      {studioDate(r.createdAt)}
                      {r.finishedAt
                        ? ` · finished ${studioDate(r.finishedAt)}`
                        : ""}
                    </p>
                    {r.usage ? (
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
                        {ERROR_TEXT[r.errorCode] ?? "The run failed."}{" "}
                        <span className="font-mono">({r.errorCode})</span>
                        {r.refusalCategory
                          ? ` · category ${r.refusalCategory}`
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
                on the current version to make it a candidate for review.
              </>
            ) : (
              <>
                The current version passed its acceptance checks and is a
                candidate.{" "}
                <Link
                  href={`/dashboard/themes/studio/${project.id}/release`}
                  className="font-medium text-slate-700 underline underline-offset-2"
                >
                  Review and release
                </Link>
                .
              </>
            )}
          </p>
        ) : null}
        {project.status === "approved" || project.status === "published" ? (
          <p className="mt-1 text-xs text-slate-500">
            {project.status === "approved"
              ? "The current version is approved for publication. "
              : "This theme is published. "}
            <Link
              href={`/dashboard/themes/studio/${project.id}/release`}
              className="font-medium text-slate-700 underline underline-offset-2"
            >
              {project.status === "approved"
                ? "Publish it"
                : "Catalog and rollback"}
            </Link>
          </p>
        ) : null}
        {project.versions.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            No version yet. A successful run creates an immutable version.
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
                        {versionNumber.get(v.parentVersionId) ?? "?"}
                      </span>
                    ) : null}
                    {previewFor.get(v.id)?.status === "ready" ? (
                      <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-normal text-emerald-700">
                        preview open
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
                <p className="mt-1 text-sm text-slate-700">{v.summary}</p>
                {v.packageSummary ? (
                  <div className="mt-2 space-y-1 text-xs text-slate-600">
                    <p>
                      {v.packageSummary.pages} pages ·{" "}
                      {v.packageSummary.sections} sections ·{" "}
                      {v.packageSummary.products} sample products
                    </p>
                    {v.packageSummary.placeholders > 0 ? (
                      <p className="text-amber-700">
                        {v.packageSummary.placeholders} placeholder image
                        {v.packageSummary.placeholders === 1 ? "" : "s"}. Real
                        imagery must replace them before this theme can be
                        published.
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
