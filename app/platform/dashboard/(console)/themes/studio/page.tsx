import Link from "next/link";
import { ArrowLeft, Plus, Sparkles } from "lucide-react";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import { getThemeStudioConfig } from "@/lib/theme-studio/config";
import { listThemeStudioProjects } from "@/lib/theme-studio/repository";
import { THEME_STUDIO_MODELS } from "@/lib/theme-studio/models";
import { requireOperator } from "../../require-operator";
import { StudioStatusBadge, SuperadminOnly, studioDate } from "./studio-ui";

export const metadata = { title: "AI Theme Studio — StoreMink Admin" };

// ★ Every Studio page gates itself (require-operator.ts explains why the
// layout's redirect is not enough), and then gates AGAIN on superadmin: a
// platform member is an operator but must not see Studio prompts, references
// or drafts. Reads below run under service scope, so this is the boundary.

const MODEL_LABEL = new Map(THEME_STUDIO_MODELS.map((m) => [m.key, m.label]));

export default async function ThemeStudioPage() {
  await requireOperator();
  const actor = await getThemeStudioActor();

  return (
    <div className="w-full max-w-6xl space-y-6">
      <Link
        href="/dashboard/themes"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" /> Themes
      </Link>
      {!actor ? <SuperadminOnly /> : <ProjectList />}
    </div>
  );
}

async function ProjectList() {
  const projects = await listThemeStudioProjects();
  const config = getThemeStudioConfig();
  return (
    <>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
            AI Theme Studio
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Draft a storefront theme from a brief and reference screenshots.
            Every generation is an immutable version; nothing reaches the
            catalogue without a separate review and publish step.
          </p>
        </div>
        <Link
          href="/dashboard/themes/studio/new"
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          <Plus className="h-4 w-4" /> New project
        </Link>
      </header>

      {!config.generationEnabled ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Generation is switched off platform-wide. You can still create
          projects and add references; queuing is refused until it is switched
          back on.
        </p>
      ) : config.provider === "fake" ? (
        <p className="rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-800">
          This environment uses the offline test provider. Runs make no model
          call and produce a placeholder design intent, so you can check the
          workflow before real generation is enabled.
        </p>
      ) : null}

      {projects.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
          <Sparkles className="mx-auto h-8 w-8 text-slate-300" />
          <h2 className="mt-3 text-sm font-semibold text-slate-900">
            No Studio projects yet
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            Start one with a name, a brief and the model to use. Add reference
            screenshots on the project page before you queue generation.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <ul className="divide-y divide-slate-100">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/dashboard/themes/studio/${p.id}`}
                  className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 transition hover:bg-slate-50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">
                        {p.name}
                      </span>
                      <StudioStatusBadge status={p.status} />
                      {p.activeRunStatus ? (
                        <span className="text-xs text-sky-700">
                          Run {p.activeRunStatus}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-slate-500">
                      {p.themeId}
                    </p>
                  </div>
                  <div className="text-right text-xs text-slate-500">
                    <div>{MODEL_LABEL.get(p.modelKey) ?? p.modelKey}</div>
                    <div>
                      {p.versionCount} version{p.versionCount === 1 ? "" : "s"}{" "}
                      · {studioDate(p.updatedAt)}
                    </div>
                    <div>{p.createdByEmail}</div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
