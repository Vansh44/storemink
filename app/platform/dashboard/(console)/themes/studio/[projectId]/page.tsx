import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import { getThemeStudioConfig } from "@/lib/theme-studio/config";
import { THEME_STUDIO_LIMITS } from "@/lib/theme-studio/contracts";
import { THEME_STUDIO_MODELS } from "@/lib/theme-studio/models";
import { getThemeStudioProject } from "@/lib/theme-studio/repository";
import { listThemeStudioAcceptanceRuns } from "@/lib/theme-studio/acceptance";
import { requireOperator } from "../../../require-operator";
import { SuperadminOnly } from "../studio-ui";
import { ProjectWorkspace, type VersionAcceptance } from "./workspace";

export const metadata = { title: "Studio project — StoreMink Admin" };

export default async function ThemeStudioProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  await requireOperator();
  const actor = await getThemeStudioActor();
  const back = (
    <Link
      href="/dashboard/themes/studio"
      className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-900"
    >
      <ArrowLeft className="h-4 w-4" /> AI Theme Studio
    </Link>
  );
  if (!actor) {
    return (
      <div className="w-full max-w-6xl space-y-6">
        {back}
        <SuperadminOnly />
      </div>
    );
  }
  const { projectId } = await params;
  const project = await getThemeStudioProject(projectId);
  if (!project) notFound();
  // The latest verdict per version (runs arrive newest first).
  const acceptance: Record<string, VersionAcceptance> = {};
  for (const run of await listThemeStudioAcceptanceRuns(project.id)) {
    acceptance[run.versionId] ??= {
      status: run.status,
      currentBuild: run.currentBuild,
    };
  }
  const config = getThemeStudioConfig();
  const modelLabel =
    THEME_STUDIO_MODELS.find((m) => m.key === project.modelKey)?.label ??
    project.modelKey;

  return (
    <div className="w-full max-w-6xl space-y-6">
      {back}
      <ProjectWorkspace
        project={project}
        modelLabel={modelLabel}
        generationEnabled={config.generationEnabled}
        testProvider={config.provider === "fake"}
        referenceLimit={THEME_STUDIO_LIMITS.referenceImages}
        acceptance={acceptance}
      />
    </div>
  );
}
