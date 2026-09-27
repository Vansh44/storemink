import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import { THEME_STUDIO_VIEWPORTS } from "@/lib/theme-studio/contracts";
import { getThemeStudioProject } from "@/lib/theme-studio/repository";
import { requireOperator } from "../../../../../require-operator";
import { StudioStatusBadge, SuperadminOnly } from "../../../studio-ui";
import { PreviewFrame } from "./preview-frame";

export const metadata = { title: "Theme preview — StoreMink Admin" };

// One version's private preview. The frame asks the server for an entry token
// only after the page loads, so no token is ever rendered into this HTML.
export default async function ThemeStudioVersionPreviewPage({
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

  return (
    <div className="w-full space-y-4">
      {back}
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight text-slate-950">
          {project.name} · version {version.versionNumber}
        </h1>
        <StudioStatusBadge status={project.status} />
        {version.id === project.currentVersionId ? (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
            current
          </span>
        ) : null}
      </header>
      <p className="text-sm text-slate-500">
        A private store built from this version and rendered by the live
        storefront. It takes no orders, is hidden from search and is removed a
        day after it was last opened.
      </p>
      <PreviewFrame
        projectId={project.id}
        versionId={version.id}
        viewports={THEME_STUDIO_VIEWPORTS}
      />
    </div>
  );
}
