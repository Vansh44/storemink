"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  changeThemeStudioCatalogAction,
  publishThemeStudioProjectAction,
} from "@/app/actions/theme-studio-actions";
import type { ThemeStudioProjectState } from "@/lib/theme-studio/contracts";
import type { ThemeStudioReleaseState } from "@/lib/theme-studio/publication";
import { studioDate } from "../../studio-ui";

interface ReleaseProject {
  id: string;
  name: string;
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

// One step: a candidate has passed every automated check and the visual QA
// scorecard, so publishing it is a single button. Hide, show and restore are
// single buttons too. Every rule is re-checked by the server and, for
// publication, by the database (migration 0151).
export function ReleaseWorkspace({
  project,
  state,
  demoOrigin,
}: {
  project: ReleaseProject;
  state: ThemeStudioReleaseState;
  demoOrigin: string;
}) {
  const published = state.publications.find((p) => p.status === "published");
  return (
    <div className="space-y-5">
      {project.status === "published" && published ? (
        <LivePanel project={project} state={state} demoOrigin={demoOrigin} />
      ) : (
        <PublishPanel project={project} state={state} />
      )}
      <History state={state} />
    </div>
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
  const [problems, setProblems] = useState<string[]>([]);
  const publishable =
    project.status === "candidate" || project.status === "approved";
  const retry = project.status === "approved";
  const ready = publishable && state.evidence.ok && state.blockers.length === 0;
  const checksHref = project.currentVersionId
    ? `/dashboard/themes/studio/${project.id}/versions/${project.currentVersionId}/acceptance`
    : `/dashboard/themes/studio/${project.id}`;

  const publish = () => {
    if (
      !window.confirm(
        `Publish ${project.name}? It goes live in the theme catalog and signup, with a live demo store.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      setProblems([]);
      const result = await publishThemeStudioProjectAction({
        projectId: project.id,
        expectedRevision: project.revision,
      });
      if (!result.ok) {
        setProblems(result.problems ?? [result.error ?? ""]);
        toast.error(result.error ?? "The theme couldn't be published.");
        router.refresh();
        return;
      }
      toast.success(`${project.name} is live.`);
      router.refresh();
    });
  };

  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold text-slate-900">Publish</h2>
      {!publishable ? (
        <p className="mt-1 text-sm text-slate-600">
          Publishing opens once version {state.versionNumber ?? "—"} passes its
          checks.{" "}
          <Link
            href={checksHref}
            className="font-medium underline underline-offset-2"
          >
            Open checks
          </Link>
        </p>
      ) : state.evidence.ok ? (
        <p className="mt-1 text-sm text-slate-600">
          Version {state.versionNumber ?? "—"} passed every check. Publishing
          adds it to themes.storemink.com and signup, with a live demo store.
          Stores that later install it keep that exact version.
        </p>
      ) : (
        <p className="mt-1 text-sm text-amber-700">
          {state.evidence.reason}{" "}
          <Link
            href={checksHref}
            className="font-medium underline underline-offset-2"
          >
            Run the checks again
          </Link>
        </p>
      )}
      {state.blockers.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-700">
          {state.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      ) : null}
      {publishable ? (
        <button
          type="button"
          disabled={pending || !ready}
          className={`${BUTTON} mt-4`}
          onClick={publish}
        >
          {pending
            ? "Publishing…"
            : retry
              ? "Retry publishing"
              : "Publish theme"}
        </button>
      ) : null}
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

function LivePanel({
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
  const [version, setVersion] = useState(state.catalog?.releaseVersion ?? "");
  const hidden = state.catalog?.visibility !== "public";

  const run = (change: Record<string, string>, done: string) =>
    startTransition(async () => {
      const result = await changeThemeStudioCatalogAction({
        projectId: project.id,
        change,
      });
      if (!result.ok) {
        toast.error(result.error ?? "The catalog couldn't be changed.");
        return;
      }
      toast.success(result.changed ? done : "Nothing changed.");
      router.refresh();
    });

  return (
    <section className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-900">
          {hidden ? "Hidden" : "Live"}
        </h2>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            hidden
              ? "bg-slate-100 text-slate-600"
              : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {state.catalog?.releaseVersion
            ? `v${state.catalog.releaseVersion}`
            : project.themeId}
        </span>
      </div>
      <p className="mt-1 text-sm text-slate-600">
        {hidden
          ? "New stores can't pick this theme. Stores already using it are unaffected."
          : "In the theme catalog and signup. Stores already using it keep their exact version."}{" "}
        <a
          href={demoOrigin}
          target="_blank"
          rel="noreferrer"
          className="font-medium underline underline-offset-2"
        >
          Open live demo
        </a>
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {hidden ? (
          <button
            type="button"
            disabled={pending}
            className={BUTTON}
            onClick={() => run({ action: "show" }, "Back in the catalog.")}
          >
            Show in catalog
          </button>
        ) : (
          <button
            type="button"
            disabled={pending}
            className={SECONDARY}
            onClick={() => run({ action: "hide" }, "Hidden from new stores.")}
          >
            Hide from new stores
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
                  v{r.version}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={pending || version === state.catalog?.releaseVersion}
              className={SECONDARY}
              onClick={() =>
                run(
                  { action: "select_release", version },
                  `Restored v${version}.`,
                )
              }
            >
              Restore this version
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}

function History({ state }: { state: ThemeStudioReleaseState }) {
  if (state.publications.length === 0 && state.audit.length === 0) return null;
  return (
    <details className={CARD}>
      <summary className="cursor-pointer text-sm font-semibold text-slate-900">
        History
      </summary>
      <ul className="mt-3 divide-y divide-slate-100 text-sm">
        {state.publications.map((p) => (
          <li key={p.id} className="py-2">
            <span className="font-medium text-slate-900">
              Publish v{p.releaseVersion}
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
        {state.audit.map((row) => (
          <li key={row.id} className="py-2">
            <span className="font-medium text-slate-900">
              {row.action.replace("_", " ")}
            </span>{" "}
            <span className="text-slate-500">
              → {row.visibility}
              {row.releaseVersion ? ` v${row.releaseVersion}` : ""} ·{" "}
              {row.createdByEmail} · {studioDate(row.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
