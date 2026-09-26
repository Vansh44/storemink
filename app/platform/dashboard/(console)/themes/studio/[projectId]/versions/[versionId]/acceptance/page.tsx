import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import {
  listThemeStudioAcceptanceRuns,
  verifyThemeStudioCandidateEvidence,
} from "@/lib/theme-studio/acceptance";
import { getThemeStudioProject } from "@/lib/theme-studio/repository";
import { requireOperator } from "../../../../../../require-operator";
import {
  StudioStatusBadge,
  SuperadminOnly,
  studioDate,
} from "../../../../studio-ui";
import { AcceptanceEvidence, AcceptanceRunBadge } from "./acceptance-evidence";
import { AcceptanceRunner } from "./acceptance-runner";

export const metadata = { title: "Theme acceptance — StoreMink Admin" };

// Automated acceptance for one version: run the gates, read the evidence.
// Evidence is bound to the version's package digest, its asset bytes and the
// build that rendered it (lib/theme-studio/acceptance.ts).
export default async function ThemeStudioAcceptancePage({
  params,
}: {
  params: Promise<{ projectId: string; versionId: string }>;
}) {
  await requireOperator();
  const actor = await getThemeStudioActor();
  const { projectId, versionId } = await params;
  const back = (
    <Link
      href={`/dashboard/themes/studio/${projectId}`}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-900"
    >
      <ArrowLeft className="h-4 w-4" /> Back to project
    </Link>
  );
  if (!actor) {
    return (
      <div className="w-full space-y-6">
        {back}
        <SuperadminOnly />
      </div>
    );
  }
  const project = await getThemeStudioProject(projectId);
  const version = project?.versions.find((v) => v.id === versionId);
  if (!project || !version || !version.hasPackage) notFound();

  const runs = (await listThemeStudioAcceptanceRuns(project.id)).filter(
    (run) => run.versionId === version.id,
  );
  const latest = runs[0] ?? null;
  const isCurrent = version.id === project.currentVersionId;
  const evidence =
    isCurrent && project.status === "candidate"
      ? await verifyThemeStudioCandidateEvidence(project.id)
      : null;

  const blockedReason = !isCurrent
    ? "Only the current version can be checked. Make this version current first."
    : project.status === "generating"
      ? "Wait for the active run to finish."
      : project.status === "blocked"
        ? "This project is blocked. Revise it, or make a version current again, first."
        : project.status !== "ready" && project.status !== "candidate"
          ? "This project can't be checked in its current state."
          : null;

  return (
    <div className="w-full space-y-5">
      {back}
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-slate-950">
            {project.name} · version {version.versionNumber} acceptance
          </h1>
          <StudioStatusBadge status={project.status} />
          {isCurrent ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              current
            </span>
          ) : null}
        </div>
        <p className="max-w-3xl text-sm text-slate-500">
          Automated gates a version must pass before it can be reviewed: the
          package contract, content floors, design and contrast, a security
          scan, asset integrity and provenance, the preview store&apos;s
          rendered pages and links, and — measured in this browser at laptop,
          iPad and mobile sizes — layout overflow, accessibility (axe) and
          media. Performance is recorded but not required, because it is
          measured on this machine rather than a production build.{" "}
          <Link
            href={`/dashboard/themes/studio/${project.id}/versions/${version.id}`}
            className="font-medium text-slate-700 underline underline-offset-2"
          >
            Open the preview
          </Link>
        </p>
      </header>

      {evidence && !evidence.ok ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          This project is a candidate, but its evidence is no longer current:{" "}
          {evidence.reason}
        </p>
      ) : null}
      {evidence?.ok ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          Candidate evidence is current for this version and build.
        </p>
      ) : null}

      <AcceptanceRunner
        projectId={project.id}
        versionId={version.id}
        canRun={blockedReason === null}
        blockedReason={blockedReason}
      />

      {latest ? (
        <AcceptanceEvidence run={latest} />
      ) : (
        <p className="rounded-xl border border-dashed border-slate-300 px-6 py-8 text-center text-sm text-slate-500">
          This version has not been checked yet.
        </p>
      )}

      {runs.length > 1 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-900">
            Earlier runs of this version
          </h2>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
            {runs.slice(1).map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm"
              >
                <span className="flex items-center gap-2">
                  <AcceptanceRunBadge status={run.status} />
                  <span className="text-slate-600">
                    {
                      run.gates.filter((g) => g.required && g.status !== "pass")
                        .length
                    }{" "}
                    required gate(s) not passed
                  </span>
                </span>
                <span className="text-xs text-slate-500">
                  {run.createdByEmail} · {studioDate(run.createdAt)} · build{" "}
                  <span className="font-mono">{run.buildId}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
