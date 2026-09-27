import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getThemeStudioActor } from "@/lib/theme-studio/access";
import { diffThemePackages, type ThemeDiff } from "@/lib/theme-studio/diff";
import {
  getThemeStudioVersionPackages,
  isUuid,
} from "@/lib/theme-studio/repository";
import { requireOperator } from "../../../../require-operator";
import { SuperadminOnly } from "../../studio-ui";

export const metadata = { title: "Compare versions — StoreMink Admin" };

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium text-slate-500">{title}</p>
      <ul className="mt-1 list-disc pl-5 text-sm text-slate-800">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function Changes({ diff }: { diff: ThemeDiff }) {
  if (diff.identical) {
    return (
      <p className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
        These two versions produce the same theme.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {diff.tokens.length > 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">
            Design tokens ({diff.tokens.length})
          </h2>
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1 pr-3 font-medium">Token</th>
                <th className="py-1 pr-3 font-medium">Before</th>
                <th className="py-1 font-medium">After</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {diff.tokens.map((t) => (
                <tr key={`${t.group}.${t.key}`}>
                  <td className="py-1.5 pr-3 font-mono text-xs text-slate-600">
                    {t.group}.{t.key}
                  </td>
                  {[t.before, t.after].map((value, i) => (
                    <td key={i} className="py-1.5 pr-3">
                      <span className="inline-flex items-center gap-2">
                        {value && /^#[0-9a-f]{3,8}$/i.test(value) ? (
                          <span
                            aria-hidden
                            className="inline-block h-3.5 w-3.5 rounded border border-slate-300"
                            style={{ background: value }}
                          />
                        ) : null}
                        <span className="break-all font-mono text-xs text-slate-800">
                          {value ?? "—"}
                        </span>
                      </span>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {diff.pages.length > 0 ? (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">
            Pages ({diff.pages.length})
          </h2>
          <ul className="mt-3 space-y-3">
            {diff.pages.map((page) => (
              <li key={page.slug} className="rounded-lg bg-slate-50 p-3">
                <p className="text-sm font-medium text-slate-900">
                  {page.title}{" "}
                  <span className="font-mono text-xs text-slate-500">
                    /{page.slug}
                  </span>{" "}
                  <span className="text-xs capitalize text-slate-500">
                    · {page.change}
                  </span>
                </p>
                <div className="mt-1 grid gap-2 text-xs text-slate-700 sm:grid-cols-2">
                  <p>Before: {page.before.join(" → ") || "—"}</p>
                  <p>After: {page.after.join(" → ") || "—"}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:grid-cols-2">
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-900">
            Sample catalogue
          </h2>
          <List title="Products added" items={diff.products.added} />
          <List title="Products removed" items={diff.products.removed} />
          <List title="Products changed" items={diff.products.changed} />
          <List title="Categories added" items={diff.categories.added} />
          <List title="Categories removed" items={diff.categories.removed} />
          <List title="Categories changed" items={diff.categories.changed} />
        </div>
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-900">
            Navigation and gaps
          </h2>
          <p className="text-sm text-slate-700">
            Navigation {diff.navigationChanged ? "changed" : "unchanged"}.
          </p>
          <List title="Capability gaps added" items={diff.gaps.added} />
          <List title="Capability gaps cleared" items={diff.gaps.removed} />
        </div>
      </section>
    </div>
  );
}

export default async function ThemeStudioComparePage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  await requireOperator();
  const actor = await getThemeStudioActor();
  const { projectId } = await params;
  const { from, to } = await searchParams;
  const base = `/dashboard/themes/studio/${projectId}`;
  const back = (
    <Link
      href={base}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-900"
    >
      <ArrowLeft className="h-4 w-4" /> Back to project
    </Link>
  );
  if (!actor) {
    return (
      <div className="w-full max-w-5xl space-y-6">
        {back}
        <SuperadminOnly />
      </div>
    );
  }
  if (!isUuid(from) || !isUuid(to) || from === to) notFound();
  const versions = await getThemeStudioVersionPackages(projectId, [from, to]);
  const before = versions.find((v) => v.id === from);
  const after = versions.find((v) => v.id === to);
  if (!before || !after) notFound();

  return (
    <div className="w-full max-w-5xl space-y-6">
      {back}
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-slate-950">
          Version {before.versionNumber} → version {after.versionNumber}
        </h1>
        <div className="mt-2 grid gap-3 text-sm text-slate-600 sm:grid-cols-2">
          {[before, after].map((v) => (
            <div
              key={v.id}
              className="rounded-lg border border-slate-200 bg-white p-3"
            >
              <p className="font-medium text-slate-900">
                Version {v.versionNumber}
              </p>
              <p className="mt-1">{v.summary}</p>
              {v.package ? (
                <Link
                  href={`${base}/versions/${v.id}`}
                  className="mt-2 inline-block text-xs font-medium text-slate-900 underline"
                >
                  Open preview
                </Link>
              ) : null}
            </div>
          ))}
        </div>
      </header>
      {before.package && after.package ? (
        <Changes diff={diffThemePackages(before.package, after.package)} />
      ) : (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          One of these versions has no theme package to compare.
        </p>
      )}
    </div>
  );
}
