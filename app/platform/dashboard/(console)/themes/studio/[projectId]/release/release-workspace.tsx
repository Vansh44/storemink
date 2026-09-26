"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  approveThemeStudioCandidateAction,
  changeThemeStudioCatalogAction,
  publishThemeStudioProjectAction,
  submitThemeStudioReviewAction,
} from "@/app/actions/theme-studio-actions";
import type { ThemeStudioProjectState } from "@/lib/theme-studio/contracts";
import {
  MIN_ROW_SCORE,
  REJECTION_CONDITIONS,
  REJECT_NOTE_MIN,
  REVIEWER_ROLES,
  SCORECARD_DIMENSIONS,
  scorecardAverage,
  scorecardClearsBar,
  type RejectionCondition,
  type ReviewerRole,
  type Scores,
} from "@/lib/theme-studio/scorecard";
import type { ThemeStudioReleaseState } from "@/lib/theme-studio/publication";
import { studioDate } from "../../studio-ui";

interface ReleaseProject {
  id: string;
  themeId: string;
  status: ThemeStudioProjectState;
  revision: number;
  currentVersionId: string | null;
}

const CARD = "rounded-xl border border-slate-200 bg-white p-5 shadow-sm";
const BUTTON =
  "inline-flex items-center justify-center rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY =
  "inline-flex items-center justify-center rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50";

function roleLabel(role: ReviewerRole) {
  return REVIEWER_ROLES.find((r) => r.key === role)?.label ?? role;
}

function rejectionLabel(key: string) {
  return REJECTION_CONDITIONS.find((c) => c.key === key)?.label ?? key;
}

export function ReleaseWorkspace({
  project,
  state,
  actorEmail,
  demoOrigin,
}: {
  project: ReleaseProject;
  state: ThemeStudioReleaseState;
  actorEmail: string;
  demoOrigin: string;
}) {
  const current = state.reviews.filter((r) => r.current);
  const earlier = state.reviews.filter((r) => !r.current);
  const published = state.publications.find((p) => p.status === "published");
  return (
    <div className="space-y-5">
      <EvidenceSummary project={project} state={state} />
      <section className={CARD}>
        <h2 className="text-sm font-semibold text-slate-900">Reviews</h2>
        <p className="mt-1 text-xs text-slate-500">
          Approval needs every row at {MIN_ROW_SCORE} or more and an average of
          at least 4.2 from each chair, no automatic-rejection condition, and
          one reviewer who did not author the theme. Authors on record:{" "}
          {state.authors.join(", ") || "—"}.
        </p>
        {current.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">
            No review covers the current evidence yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {current.map((review) => (
              <ReviewCard key={review.id} review={review} />
            ))}
          </ul>
        )}
        {earlier.length > 0 ? (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-slate-500">
              {earlier.length} earlier review{earlier.length === 1 ? "" : "s"}{" "}
              of previous evidence
            </summary>
            <ul className="mt-3 space-y-3">
              {earlier.map((review) => (
                <ReviewCard key={review.id} review={review} />
              ))}
            </ul>
          </details>
        ) : null}
      </section>
      {project.status === "candidate" && state.evidence.ok ? (
        <ScorecardForm
          project={project}
          state={state}
          actorEmail={actorEmail}
        />
      ) : null}
      {project.status === "candidate" ? (
        <ApprovePanel project={project} state={state} />
      ) : null}
      {project.status === "approved" ? (
        <PublishPanel project={project} state={state} />
      ) : null}
      {published ? (
        <CatalogPanel project={project} state={state} demoOrigin={demoOrigin} />
      ) : null}
      <PublicationHistory state={state} />
    </div>
  );
}

function EvidenceSummary({
  project,
  state,
}: {
  project: ReleaseProject;
  state: ThemeStudioReleaseState;
}) {
  const acceptanceHref = project.currentVersionId
    ? `/dashboard/themes/studio/${project.id}/versions/${project.currentVersionId}/acceptance`
    : null;
  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold text-slate-900">
        Version {state.versionNumber ?? "—"} · evidence
      </h2>
      {state.evidence.ok ? (
        <p className="mt-1 text-sm text-slate-600">
          A passing acceptance run covers this version (evidence{" "}
          <code className="text-xs">
            {state.evidence.evidenceDigest.slice(0, 12)}
          </code>
          ). Reviews bind to this evidence; a new version or a new run needs a
          new review.
        </p>
      ) : (
        <p className="mt-1 text-sm text-amber-700">
          {state.evidence.reason}{" "}
          {acceptanceHref ? (
            <Link
              href={acceptanceHref}
              className="font-medium underline underline-offset-2"
            >
              Open acceptance
            </Link>
          ) : null}
        </p>
      )}
      {state.blockers.length > 0 && project.status !== "published" ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-700">
          {state.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ReviewCard({
  review,
}: {
  review: ThemeStudioReleaseState["reviews"][number];
}) {
  return (
    <li className="rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-slate-900">
          {roleLabel(review.role)}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            review.verdict === "approve"
              ? "bg-emerald-50 text-emerald-700"
              : "bg-red-50 text-red-700"
          }`}
        >
          {review.verdict === "approve" ? "Approved" : "Rejected"}
        </span>
        <span className="text-slate-500">
          {review.reviewerEmail}
          {review.reviewerIsAuthor ? " · author" : " · independent"}
        </span>
        <span className="text-slate-500">
          · average {review.average.toFixed(2)} · {studioDate(review.createdAt)}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600 sm:grid-cols-4">
        {SCORECARD_DIMENSIONS.map((d) => (
          <div key={d.key} className="flex justify-between gap-2">
            <dt>{d.label}</dt>
            <dd className="font-medium text-slate-900">
              {review.scores[d.key]}
            </dd>
          </div>
        ))}
      </dl>
      {review.rejections.length > 0 ? (
        <p className="mt-2 text-xs text-red-700">
          {review.rejections.map(rejectionLabel).join(" · ")}
        </p>
      ) : null}
      {review.notes ? (
        <p className="mt-2 whitespace-pre-line text-sm text-slate-700">
          {review.notes}
        </p>
      ) : null}
    </li>
  );
}

const EMPTY_SCORES = Object.fromEntries(
  SCORECARD_DIMENSIONS.map((d) => [d.key, 0]),
) as Scores;

function ScorecardForm({
  project,
  state,
  actorEmail,
}: {
  project: ReleaseProject;
  state: ThemeStudioReleaseState;
  actorEmail: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const current = state.reviews.filter((r) => r.current);
  const taken = new Set(current.map((r) => r.role));
  const alreadyReviewed = current.some(
    (r) => r.reviewerEmail.toLowerCase() === actorEmail.toLowerCase(),
  );
  const openRoles = REVIEWER_ROLES.filter((r) => !taken.has(r.key));
  const [role, setRole] = useState<ReviewerRole | null>(
    openRoles[0]?.key ?? null,
  );
  const [scores, setScores] = useState<Scores>(EMPTY_SCORES);
  const [rejections, setRejections] = useState<RejectionCondition[]>([]);
  const [notes, setNotes] = useState("");

  if (alreadyReviewed) {
    return (
      <section className={CARD}>
        <h2 className="text-sm font-semibold text-slate-900">Your review</h2>
        <p className="mt-1 text-sm text-slate-500">
          You have reviewed this evidence. The other chair needs a different
          reviewer.
        </p>
      </section>
    );
  }
  if (openRoles.length === 0) return null;

  const complete = SCORECARD_DIMENSIONS.every((d) => scores[d.key] >= 1);
  const clears = complete && scorecardClearsBar(scores, rejections);
  const canReject = complete && notes.trim().length >= REJECT_NOTE_MIN;

  const submit = (verdict: "approve" | "reject") => {
    if (!role || !state.packageDigest || !project.currentVersionId) return;
    startTransition(async () => {
      const result = await submitThemeStudioReviewAction({
        projectId: project.id,
        versionId: project.currentVersionId!,
        expectedPackageDigest: state.packageDigest!,
        scorecard: { role, scores, rejections, verdict, notes },
      });
      if (!result.ok) {
        toast.error(result.error ?? "The review couldn't be saved.");
        return;
      }
      toast.success("Review recorded.");
      router.refresh();
    });
  };

  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold text-slate-900">Add your review</h2>
      <p className="mt-1 text-xs text-slate-500">
        Review the preview at every viewport before scoring. A review is final
        once saved.
      </p>
      <fieldset className="mt-4">
        <legend className="text-xs font-medium text-slate-700">Chair</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {REVIEWER_ROLES.map((r) => (
            <label
              key={r.key}
              className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                role === r.key
                  ? "border-slate-900 bg-slate-50"
                  : "border-slate-200"
              } ${taken.has(r.key) ? "cursor-not-allowed opacity-50" : ""}`}
            >
              <input
                type="radio"
                name="role"
                value={r.key}
                disabled={taken.has(r.key)}
                checked={role === r.key}
                onChange={() => setRole(r.key)}
                className="mt-1"
              />
              <span>
                <span className="font-medium text-slate-900">{r.label}</span>
                <span className="block text-xs text-slate-500">
                  {taken.has(r.key) ? "Already reviewed" : r.prompt}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="mt-5 space-y-3">
        <legend className="text-xs font-medium text-slate-700">
          Scores (1 = poor, 5 = excellent)
        </legend>
        {SCORECARD_DIMENSIONS.map((d) => (
          <div
            key={d.key}
            className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p className="text-sm font-medium text-slate-900">{d.label}</p>
              <p className="text-xs text-slate-500">{d.question}</p>
            </div>
            <div
              role="radiogroup"
              aria-label={d.label}
              className="flex shrink-0 gap-1"
            >
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={scores[d.key] === n}
                  onClick={() => setScores((s) => ({ ...s, [d.key]: n }))}
                  className={`h-8 w-8 rounded-md border text-sm ${
                    scores[d.key] === n
                      ? n >= MIN_ROW_SCORE
                        ? "border-emerald-600 bg-emerald-600 text-white"
                        : "border-amber-600 bg-amber-600 text-white"
                      : "border-slate-300 text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        ))}
        {complete ? (
          <p className="text-xs text-slate-500">
            Average {scorecardAverage(scores).toFixed(2)} —{" "}
            {clears ? "clears the approval bar." : "below the approval bar."}
          </p>
        ) : null}
      </fieldset>
      <fieldset className="mt-5">
        <legend className="text-xs font-medium text-slate-700">
          Automatic rejection — tick any that apply
        </legend>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {REJECTION_CONDITIONS.map((c) => (
            <label
              key={c.key}
              className="flex items-start gap-2 text-sm text-slate-700"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={rejections.includes(c.key)}
                onChange={(e) =>
                  setRejections((list) =>
                    e.target.checked
                      ? [...list, c.key]
                      : list.filter((k) => k !== c.key),
                  )
                }
              />
              {c.label}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="mt-5 block">
        <span className="text-xs font-medium text-slate-700">
          Notes (required to reject)
        </span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          maxLength={2000}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || !role || !clears}
          onClick={() => submit("approve")}
          className={BUTTON}
        >
          Approve as {role ? roleLabel(role) : "…"}
        </button>
        <button
          type="button"
          disabled={pending || !role || !canReject}
          onClick={() => submit("reject")}
          className={SECONDARY}
        >
          Reject
        </button>
      </div>
    </section>
  );
}

function ApprovePanel({
  project,
  state,
}: {
  project: ReleaseProject;
  state: ThemeStudioReleaseState;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const ready =
    state.evidence.ok && state.readiness.ok && state.blockers.length === 0;
  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold text-slate-900">Approve</h2>
      {ready ? (
        <p className="mt-1 text-sm text-slate-600">
          Both reviews approve this evidence. Approving freezes the version for
          publication.
        </p>
      ) : (
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-500">
          {(state.evidence.ok ? [] : [state.evidence.reason])
            .concat(state.readiness.reasons, state.blockers)
            .map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
        </ul>
      )}
      <button
        type="button"
        disabled={!ready || pending}
        className={`${BUTTON} mt-3`}
        onClick={() =>
          startTransition(async () => {
            const result = await approveThemeStudioCandidateAction({
              projectId: project.id,
              expectedRevision: project.revision,
            });
            if (!result.ok) {
              toast.error(result.error ?? "The project couldn't be approved.");
              return;
            }
            toast.success("Approved. The version is ready to publish.");
            router.refresh();
          })
        }
      >
        Approve for publication
      </button>
    </section>
  );
}

function PublishPanel({
  project,
  state,
}: {
  project: ReleaseProject;
  state: ThemeStudioReleaseState;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const blocked = state.blockers.length > 0;
  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold text-slate-900">Publish</h2>
      <p className="mt-1 text-sm text-slate-600">
        Publishing copies the theme&apos;s images to permanent public storage,
        stores release{" "}
        {state.publishedReleases.length === 0 ? "1.0.0" : "the next version"} of{" "}
        <code className="text-xs">{project.themeId}</code>, seeds and checks the
        demo store, then adds it to the public catalog and signup. If the demo
        fails, nothing becomes public and you can retry.
      </p>
      <label className="mt-4 block max-w-sm">
        <span className="text-xs font-medium text-slate-700">
          Type <code>{project.themeId}</code> to confirm
        </span>
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
        />
      </label>
      <button
        type="button"
        disabled={pending || blocked || confirm.trim() !== project.themeId}
        className={`${BUTTON} mt-3`}
        onClick={() =>
          startTransition(async () => {
            setProblems([]);
            const result = await publishThemeStudioProjectAction({
              projectId: project.id,
              expectedRevision: project.revision,
              confirmThemeId: confirm,
            });
            if (!result.ok) {
              setProblems(result.problems ?? [result.error ?? ""]);
              toast.error(result.error ?? "The theme couldn't be published.");
              router.refresh();
              return;
            }
            toast.success(
              `Published ${project.themeId}@${result.releaseVersion}.`,
            );
            router.refresh();
          })
        }
      >
        {pending ? "Publishing…" : "Publish theme"}
      </button>
      {problems.length > 0 ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-red-700">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function CatalogPanel({
  project,
  state,
  demoOrigin,
}: {
  project: ReleaseProject;
  state: ThemeStudioReleaseState;
  demoOrigin: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [version, setVersion] = useState(state.catalog?.releaseVersion ?? "");
  const hidden = state.catalog?.visibility !== "public";

  const run = (change: Record<string, string>) =>
    startTransition(async () => {
      const result = await changeThemeStudioCatalogAction({
        projectId: project.id,
        change: { ...change, reason },
      });
      if (!result.ok) {
        toast.error(result.error ?? "The catalog couldn't be changed.");
        return;
      }
      toast.success(result.changed ? "Catalog updated." : "Nothing changed.");
      setReason("");
      router.refresh();
    });

  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold text-slate-900">Catalog</h2>
      <p className="mt-1 text-sm text-slate-600">
        <code className="text-xs">{project.themeId}</code>
        {state.catalog?.releaseVersion
          ? `@${state.catalog.releaseVersion}`
          : ""}{" "}
        is{" "}
        <strong>
          {hidden
            ? "hidden from new stores"
            : "public in the catalog and signup"}
        </strong>
        .{" "}
        <a
          href={demoOrigin}
          target="_blank"
          rel="noreferrer"
          className="font-medium underline underline-offset-2"
        >
          Open the demo store
        </a>
        . Stores that already installed it keep their exact version whatever you
        do here.
      </p>
      <label className="mt-4 block max-w-lg">
        <span className="text-xs font-medium text-slate-700">
          Reason (recorded in the audit)
        </span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {hidden ? (
          <button
            type="button"
            disabled={pending || reason.trim().length < 3}
            className={BUTTON}
            onClick={() => run({ action: "show" })}
          >
            Show in catalog again
          </button>
        ) : (
          <button
            type="button"
            disabled={pending || reason.trim().length < 3}
            className={SECONDARY}
            onClick={() => run({ action: "hide" })}
          >
            Hide from new installs
          </button>
        )}
        {state.publishedReleases.length > 1 ? (
          <>
            <select
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              aria-label="Release"
            >
              {state.publishedReleases.map((r) => (
                <option key={r.version} value={r.version}>
                  {r.version}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={
                pending ||
                reason.trim().length < 3 ||
                version === state.catalog?.releaseVersion
              }
              className={SECONDARY}
              onClick={() => run({ action: "select_release", version })}
            >
              Restore this release
            </button>
          </>
        ) : null}
      </div>
      {state.audit.length > 0 ? (
        <div className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Catalog audit
          </h3>
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {state.audit.map((row) => (
              <li key={row.id} className="py-2">
                <span className="font-medium text-slate-900">
                  {row.action.replace("_", " ")}
                </span>{" "}
                <span className="text-slate-500">
                  → {row.visibility}
                  {row.releaseVersion ? ` @${row.releaseVersion}` : ""} ·{" "}
                  {row.createdByEmail} · {studioDate(row.createdAt)}
                </span>
                {row.reason ? (
                  <p className="text-xs text-slate-500">{row.reason}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function PublicationHistory({ state }: { state: ThemeStudioReleaseState }) {
  if (state.publications.length === 0) return null;
  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold text-slate-900">
        Publication attempts
      </h2>
      <ul className="mt-2 divide-y divide-slate-100 text-sm">
        {state.publications.map((p) => (
          <li key={p.id} className="py-2">
            <span className="font-medium text-slate-900">
              {p.releaseVersion}
            </span>{" "}
            <span
              className={
                p.status === "published"
                  ? "text-emerald-700"
                  : p.status === "failed"
                    ? "text-red-700"
                    : "text-slate-500"
              }
            >
              {p.status}
            </span>{" "}
            <span className="text-slate-500">
              · {p.createdByEmail} · {studioDate(p.createdAt)}
            </span>
            {p.failure.length > 0 ? (
              <ul className="mt-1 list-disc pl-5 text-xs text-red-700">
                {p.failure.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
