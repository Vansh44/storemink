import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import {
  THEME_STUDIO_CATALOG_SIZES,
  THEME_STUDIO_FEATURES,
  THEME_STUDIO_INDUSTRIES,
  THEME_STUDIO_LIMITS,
} from "@/lib/theme-studio/contracts";
import { themeStudioModelOptions } from "@/lib/theme-studio/models";
import { getThemeCatalog } from "@/lib/themes/runtime-registry";
import { requireOperator } from "../../../require-operator";
import { SuperadminOnly } from "../studio-ui";
import { NewProjectForm } from "./new-project-form";

export const metadata = { title: "New Studio project — StoreMink Admin" };

export default async function NewThemeStudioProjectPage() {
  await requireOperator();
  const actor = await getThemeStudioActor();
  // Base themes are the bundled/runtime catalogue, as metadata only.
  const baseThemes = actor
    ? (await getThemeCatalog()).map((t) => ({ id: t.id, name: t.name }))
    : [];

  return (
    <div className="w-full max-w-4xl space-y-6">
      <Link
        href="/dashboard/themes/studio"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" /> AI Theme Studio
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
        New Studio project
      </h1>
      {!actor ? (
        <SuperadminOnly />
      ) : (
        // The browser gets model KEYS and labels, never provider ids.
        // Vocabularies come from the contract on the server, so the form can
        // only offer what validateProjectInput will accept.
        <NewProjectForm
          models={[...themeStudioModelOptions()]}
          baseThemes={baseThemes}
          industries={[...THEME_STUDIO_INDUSTRIES]}
          catalogSizes={[...THEME_STUDIO_CATALOG_SIZES]}
          features={[...THEME_STUDIO_FEATURES]}
          briefMax={THEME_STUDIO_LIMITS.promptChars}
        />
      )}
    </div>
  );
}
