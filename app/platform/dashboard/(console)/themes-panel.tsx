"use client";

import { useState } from "react";
import { ExternalLink, Loader2, Sprout } from "lucide-react";
import { seedDemoStore } from "@/app/actions/platform";
import type { ThemeMeta } from "@/lib/themes/meta";

// Operator panel: one live demo store per theme (the signup picker's Preview
// target). Seed creates+fills it; Reseed wipes it back to the theme's pristine
// state (applyTheme reset — only allowed on settings.demo stores).
export function ThemesPanel({
  rootDomain,
  demoSlugsLive,
  themes,
}: {
  rootDomain: string;
  /** Slugs of demo stores that already exist. */
  demoSlugsLive: string[];
  /** Server-resolved runtime catalog projection. */
  themes: ThemeMeta[];
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [live, setLive] = useState(new Set(demoSlugsLive));

  async function seed(themeId: string) {
    setPendingId(themeId);
    const res = await seedDemoStore(themeId);
    setPendingId(null);
    if (res.error) {
      alert(res.error);
      return;
    }
    if (res.warnings?.length) {
      alert(`Seeded with warnings:\n${res.warnings.join("\n")}`);
    }
    if (res.slug) setLive((s) => new Set(s).add(res.slug!));
  }

  return (
    <div className="border border-gray-200 bg-white rounded-xl shadow-sm">
      <div className="border-b border-gray-200 px-6 py-4">
        <h2 className="font-bold text-gray-900">Theme demo stores</h2>
        <p className="mt-0.5 text-sm text-gray-500">
          The live stores the signup picker&apos;s Preview button opens.
          Reseeding resets a demo to the theme&apos;s pristine state.
        </p>
      </div>
      <ul className="divide-y divide-gray-100">
        {themes.map((t) => {
          const exists = live.has(t.demo.slug);
          return (
            <li
              key={t.id}
              className="flex items-center justify-between gap-4 px-6 py-4"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 font-semibold text-gray-900">
                  {t.name}
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                    {t.catalog.industries[0]}
                  </span>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                    {t.release.status} · v{t.release.version}
                  </span>
                </div>
                <div className="mt-0.5 text-sm text-gray-500">
                  {t.demo.slug}.{rootDomain}
                  {!exists && " — not seeded yet"}
                </div>
                {t.demo.status !== "healthy" && (
                  <div className="mt-1 text-xs font-medium text-amber-700">
                    Manifest demo status: {t.demo.status}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {exists && (
                  <a
                    href={`https://${t.demo.slug}.${rootDomain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:border-gray-300"
                  >
                    Open <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                <button
                  onClick={() => seed(t.id)}
                  disabled={pendingId !== null}
                  className="inline-flex items-center gap-1.5 rounded-md bg-gray-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-700 disabled:opacity-50"
                >
                  {pendingId === t.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sprout className="h-3.5 w-3.5" />
                  )}
                  {exists ? "Reseed" : "Seed"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
