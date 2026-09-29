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
import { acceptanceRepairDraft } from "@/lib/theme-studio/acceptance-repair";

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
        <>
          {latest.status !== "passed" ? (
            <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950">
              <h2 className="font-semibold">Resolve acceptance issues</h2>
              <p>
                {!latest.currentBuild
                  ? "These results are from an earlier build. Run acceptance checks again before revising the theme."
                  : latest.status === "awaiting_browser"
                    ? "Browser checks did not finish. Run acceptance checks again and keep this tab visible until they complete."
                    : "Fix the reported issues, then run acceptance checks again. A revision creates a new version and keeps this version available."}
              </p>
              {latest.gates.some(
                (g) =>
                  g.id === "routes.render" &&
                  g.findings.some((f) => f.code === "indexable"),
              ) ? (
                <p>
                  Missing preview noindex is a storefront code issue. Theme
                  revisions cannot repair preview metadata; rerun after the code
                  fix is deployed.
                </p>
              ) : null}
              {latest.gates.some(
                (g) => g.id.startsWith("assets.") && g.status === "fail",
              ) ? (
                <p>
                  Open Images to resolve asset failures. Preview, desktop
                  screenshot and mobile screenshot slots need browser capture.
                  Other missing artwork can be generated or replaced there.
                </p>
              ) : null}
              <div className="flex flex-wrap gap-4 font-medium underline underline-offset-2">
                <Link
                  href={`/dashboard/themes/studio/${project.id}/versions/${version.id}/images`}
                >
                  Open Images and capture
                </Link>
                {acceptanceRepairDraft(latest, version) ? (
                  <Link
                    href={`/dashboard/themes/studio/${project.id}?repairAcceptance=${latest.id}`}
                  >
                    Fix theme issues in chat
                  </Link>
                ) : null}
              </div>
              {acceptanceRepairDraft(latest, version) ? (
                <p>
                  The chat opens with the failed checks filled in. Add
                  instructions or screenshots, review the message and send it.
                </p>
              ) : null}
            </section>
          ) : null}
          <AcceptanceEvidence run={latest} />
        </>
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
