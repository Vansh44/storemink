import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import { getThemeStudioProject } from "@/lib/theme-studio/repository";
import { getThemeStudioReleaseState } from "@/lib/theme-studio/publication";
import { subdomainOrigin } from "@/lib/store/host";
import { requireOperator } from "../../../../require-operator";
import { StudioStatusBadge, SuperadminOnly } from "../../studio-ui";
import { ReleaseWorkspace } from "./release-workspace";

export const metadata = { title: "Theme release — StoreMink Admin" };

// Phase 6: the human review, approval, publication and catalog controls for
// one project. Every rule shown here is re-checked by the server and, for
// approval and publication, by the database (migration 0134).
export default async function ThemeStudioReleasePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  await requireOperator();
  const actor = await getThemeStudioActor();
  const { projectId } = await params;
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
  const [project, state] = await Promise.all([
    getThemeStudioProject(projectId),
    getThemeStudioReleaseState(projectId),
  ]);
  if (!project || !state) notFound();

  return (
    <div className="w-full space-y-5">
      {back}
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-slate-950">
            {project.name} · review and release
          </h1>
          <StudioStatusBadge status={project.status} />
        </div>
        <p className="max-w-3xl text-sm text-slate-500">
          Two people review the candidate against the release scorecard — one
          for design, one for commerce — and at least one of them must not have
          worked on this theme. Once approved, publishing stores an immutable
          release, seeds and checks its demo store, and only then adds it to the
          public catalog and signup. Hiding or restoring later changes what new
          stores can pick; stores that already use it keep their exact version.
        </p>
      </header>
      <ReleaseWorkspace
        project={{
          id: project.id,
          themeId: project.themeId,
          status: project.status,
          revision: project.revision,
          currentVersionId: project.currentVersionId,
        }}
        state={state}
        actorEmail={actor.email}
        demoOrigin={subdomainOrigin(`demo-${project.themeId}`)}
      />
    </div>
  );
}
