import type { ThemeStudioProjectState } from "@/lib/theme-studio/contracts";

// Small presentational pieces shared by the Studio pages. Server-safe: no
// hooks, no client-only imports.

const STATUS_TONE: Record<ThemeStudioProjectState, string> = {
  draft: "bg-slate-100 text-slate-600",
  generating: "bg-sky-50 text-sky-700",
  ready: "bg-amber-50 text-amber-700",
  candidate: "bg-indigo-50 text-indigo-700",
  approved: "bg-violet-50 text-violet-700",
  published: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-50 text-red-700",
  blocked: "bg-amber-50 text-amber-700",
  archived: "bg-slate-100 text-slate-400",
};

/**
 * One label rule for every Studio surface. `ready` is the unverified state, so
 * it reads "Needs checks" — unless automatic QA has already judged the current
 * version and failed it, which is "Needs attention", not "not checked yet".
 */
export function StudioStatusBadge({
  status,
  qaFailed = false,
}: {
  status: ThemeStudioProjectState;
  qaFailed?: boolean;
}) {
  // `candidate` and `approved` are internal names: to an operator they mean
  // "checks passed, publish it" and "publishing didn't finish, retry it".
  const label =
    status === "ready"
      ? qaFailed
        ? "Needs attention"
        : "Needs checks"
      : status === "candidate"
        ? "Ready to publish"
        : status === "approved"
          ? "Publishing"
          : status;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${STATUS_TONE[status]}`}
    >
      {label}
    </span>
  );
}

/** Whether automatic QA failed the project's current version. */
export function currentQaFailed(project: {
  currentVersionId: string | null;
  versions: readonly { id: string; qaStatus: string }[];
}): boolean {
  return (
    project.versions.find((v) => v.id === project.currentVersionId)
      ?.qaStatus === "failed"
  );
}

export function studioDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

export function SuperadminOnly() {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-6 py-10 text-center">
      <h2 className="text-sm font-semibold text-slate-900">
        Theme Studio is limited to superadmins
      </h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
        Studio prompts, reference images and generated drafts are superadmin
        data. Ask a superadmin if you need a project opened.
      </p>
    </div>
  );
}
