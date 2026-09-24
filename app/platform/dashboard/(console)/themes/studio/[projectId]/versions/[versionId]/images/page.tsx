import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import { getThemeStudioProject } from "@/lib/theme-studio/repository";
import { listThemeStudioSlots } from "@/lib/theme-studio/slot-images";
import { requireOperator } from "../../../../../../require-operator";
import { StudioStatusBadge, SuperadminOnly } from "../../../../studio-ui";
import { SlotImagesEditor } from "./slot-images-editor";

export const metadata = { title: "Theme images — StoreMink Admin" };

// Every image slot of one version, and the operator's replacements for them.
// Saving creates ONE new version; this version is never changed.
export default async function ThemeStudioSlotImagesPage({
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
  const [project, listing] = await Promise.all([
    getThemeStudioProject(projectId),
    listThemeStudioSlots(projectId, versionId),
  ]);
  if (!project || !listing) notFound();
  const isCurrent = project.currentVersionId === versionId;
  const canEdit = project.status === "ready" || project.status === "candidate";
  const placeholders = listing.slots.filter((slot) => slot.placeholder).length;

  return (
    <div className="w-full space-y-5">
      {back}
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-slate-950">
            {project.name} · version {listing.versionNumber} images
          </h1>
          <StudioStatusBadge status={project.status} />
          {isCurrent ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              current
            </span>
          ) : null}
        </div>
        <p className="max-w-3xl text-sm text-slate-500">
          Every picture this theme shows is a slot. Upload an image for each
          slot that still has a placeholder: it is cropped to the slot&apos;s
          shape and compressed to the storefront&apos;s limits. Say where each
          image came from — acceptance and publication rely on it. Saving
          creates a new version; version {listing.versionNumber} stays as it is.
          {placeholders > 0
            ? ` ${placeholders} of ${listing.slots.length} slots still have a placeholder.`
            : " No placeholders remain."}
        </p>
      </header>
      <SlotImagesEditor
        projectId={project.id}
        versionId={versionId}
        versionNumber={listing.versionNumber}
        nextVersionNumber={
          Math.max(...project.versions.map((v) => v.versionNumber)) + 1
        }
        packageDigest={listing.packageDigest}
        revision={project.revision}
        canEdit={canEdit}
        blockedReason={
          canEdit
            ? null
            : project.status === "generating"
              ? "Wait for the active run to finish before changing images."
              : "Images can be changed only while the project is ready or a candidate."
        }
        slots={listing.slots}
      />
    </div>
  );
}
