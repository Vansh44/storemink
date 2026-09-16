import { listAllStores } from "@/app/actions/platform";
import { StoresConsole } from "../stores-console";
import { canManage, requireOperator } from "../require-operator";
import { getPlanAllowances } from "@/lib/plans/allowances";
import { getMinkConfig } from "@/lib/mink/config";
import { includedMinkCredits } from "@/lib/plans";

export const metadata = { title: "Stores — StoreMink Admin" };

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "storemink.com";

// The merchant estate.
//
// ★ THIS USED TO BE THE HOME PAGE, stacked under the metric row and above the
// pricing editor and the theme seeder. Giving it its own route is most of what
// "everything is on one page" was asking for: the list can now own the full
// width, deep-link its search (`?q=`), and grow filters without pushing three
// unrelated panels further down the scroll.
export default async function StoresPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const viewer = await requireOperator();
  const { q } = await searchParams;
  const [stores, allowances] = await Promise.all([
    listAllStores(q),
    getPlanAllowances(),
  ]);
  const includedCredits = includedMinkCredits(
    allowances,
    getMinkConfig().chargeCredits,
  );

  return (
    <div className="w-full max-w-7xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
            Stores
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {stores.length === 500
              ? "Showing the 500 most recent stores — search to narrow it down."
              : `${stores.length.toLocaleString("en-IN")} ${
                  stores.length === 1 ? "store" : "stores"
                } on the platform.`}
          </p>
        </div>
      </header>

      <StoresConsole
        stores={stores}
        canManage={canManage(viewer)}
        email={viewer.email}
        q={q ?? ""}
        rootDomain={ROOT_DOMAIN}
        includedCredits={includedCredits}
      />
    </div>
  );
}
