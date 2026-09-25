import Link from "next/link";
import { redirect } from "next/navigation";
import { Sparkles } from "lucide-react";
import { listAllStores } from "@/app/actions/platform";
import { getThemeCatalog } from "@/lib/themes/runtime-registry";
import { ThemesPanel } from "../themes-panel";
import { canManage, requireOperator } from "../require-operator";

export const metadata = { title: "Themes — StoreMink Admin" };

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "storemink.com";

// Theme demo stores.
//
// Seeding a demo store writes real rows, so this stays superadmin-only — a
// member is redirected rather than shown a panel whose every button fails.
// (The read-only-view rule in require-operator.ts applies where there IS a
// useful read-only view; a seeder has none.)
export default async function ThemesPage() {
  const viewer = await requireOperator();
  if (!canManage(viewer)) redirect("/dashboard");

  // Which theme demos actually exist right now. `listAllStores` is the one
  // read that already knows, so the panel can show "seed" vs "reseed" honestly
  // rather than offering a Preview link to a 404.
  const [stores, themes] = await Promise.all([
    listAllStores(),
    getThemeCatalog(),
  ]);
  const demoSlugs = new Set(themes.map((t) => t.demo.slug));
  const demoSlugsLive = stores
    .filter((s) => demoSlugs.has(s.slug))
    .map((s) => s.slug);

  return (
    <div className="w-full max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
            Themes
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            The catalog merchants pick from at signup, and the demo store behind
            each one.
          </p>
        </div>
        <Link
          href="/dashboard/themes/studio"
          className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          <Sparkles className="h-4 w-4" /> AI Theme Studio
        </Link>
      </header>

      <ThemesPanel
        rootDomain={ROOT_DOMAIN}
        demoSlugsLive={demoSlugsLive}
        themes={themes}
      />
    </div>
  );
}
