import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import { getThemeStudioProject } from "@/lib/theme-studio/repository";
import { getThemeStudioReleaseState } from "@/lib/theme-studio/publication";
import { subdomainOrigin } from "@/lib/store/host";
import { requireOperator } from "../../../../require-operator";
import {
  StudioStatusBadge,
  currentQaFailed,
  SuperadminOnly,
} from "../../studio-ui";
import { ReleaseWorkspace } from "./release-workspace";

export const metadata = { title: "Theme release — StoreMink Admin" };

// Publish a theme in one step once its checks pass, then hide, show or
// restore it. Every rule shown here is re-checked by the server and, for
// publication, by the database (migration 0151).
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
            {project.name} · publish
          </h1>
          <StudioStatusBadge
            status={project.status}
            qaFailed={currentQaFailed(project)}
          />
        </div>
        <p className="max-w-3xl text-sm text-slate-500">
          When every check passes, publish the theme in one click. It goes live
          in the theme catalog and signup with a live demo store.
        </p>
      </header>
      <ReleaseWorkspace
        project={{
          id: project.id,
          name: project.name,
          themeId: project.themeId,
          status: project.status,
          revision: project.revision,
          currentVersionId: project.currentVersionId,
        }}
        state={state}
        demoOrigin={subdomainOrigin(`demo-${project.themeId}`)}
      />
    </div>
  );
}
