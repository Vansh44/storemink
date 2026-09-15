import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  Boxes,
  CreditCard,
  ExternalLink,
  MapPin,
  Package,
  Receipt,
  Sparkles,
  Truck,
  Users,
} from "lucide-react";
import { getStoreAudit } from "@/app/actions/platform";
import { PLAN_META } from "@/lib/plans";
import {
  loadStoreDetail,
  loadStorePeople,
  type ChannelState,
  type StoreDetail,
} from "@/lib/platform/store-detail";
import { canManage, requireOperator } from "../../require-operator";
import { StoreManageBar } from "./store-manage";
import { CompGrantCard } from "./comp-grant";

const ROOT_DOMAIN = process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "storemink.com";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const store = await loadStoreDetail(storeId);
  return { title: `${store?.name ?? "Store"} — StoreMink Admin` };
}

// ---------------------------------------------------------------------------
// One store, fully described.
//
// ★ THIS IS THE SCREEN THE CONSOLE DID NOT HAVE. Everything an operator knew
// about a store came from one table row and a history drawer — so answering
// "why is this merchant complaining?" meant opening their dashboard as them,
// or writing SQL. Plan, billing state, channels, people, usage and history
// now sit on one page, and the destructive actions sit with them rather than
// in a row of icons on a list of 500.
// ---------------------------------------------------------------------------

function money(rupees: number): string {
  return `₹${rupees.toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function date(iso: string | null): string {
  if (!iso) return "—";
  // Pinned to IST for the §24 reason: this renders on the server, where the
  // timezone is UTC on Cloud Run, so an unpinned date silently shifts.
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

const CHANNEL_LABEL: Record<ChannelState, string> = {
  enabled: "Connected",
  paused: "Paused",
  none: "Not connected",
};

const CHANNEL_TONE: Record<ChannelState, string> = {
  enabled: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  paused: "bg-amber-50 text-amber-700 ring-amber-600/20",
  none: "bg-slate-100 text-slate-500 ring-slate-400/20",
};

function Card({
  title,
  icon,
  children,
  action,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          {icon}
          {title}
        </h2>
        {action}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="divide-y divide-slate-100 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-baseline justify-between py-2">
          <dt className="text-slate-500">{label}</dt>
          <dd className="ml-4 text-right font-medium text-slate-900">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Stat({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
}) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
        {icon}
      </div>
      <div className="text-xl font-semibold tracking-tight text-slate-950">
        {value}
      </div>
      <div className="mt-0.5 text-sm font-medium text-slate-700">{label}</div>
      <div className="text-xs text-slate-400">{detail}</div>
    </article>
  );
}

function ChannelRow({ label, state }: { label: string; state: ChannelState }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <span className="text-slate-600">{label}</span>
      <span
        className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${CHANNEL_TONE[state]}`}
      >
        {CHANNEL_LABEL[state]}
      </span>
    </div>
  );
}

/** The plan line, which is two facts whenever a timed grant has lapsed. */
function PlanSummary({ store }: { store: StoreDetail }) {
  const lapsed = store.effective !== store.plan;
  return (
    <span>
      {PLAN_META[store.effective]?.name ?? store.effective}
      {lapsed ? (
        // Showing only the stored plan is how a support conversation starts
        // wrong: the gates read the EFFECTIVE plan, so a lapsed grant means
        // the merchant is on free no matter what the row says.
        <span className="ml-2 text-xs font-normal text-amber-700">
          (stored {store.plan}, expired)
        </span>
      ) : null}
    </span>
  );
}

export default async function StoreDetailPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const viewer = await requireOperator();
  const { storeId } = await params;

  const store = await loadStoreDetail(storeId);
  if (!store) notFound();

  // People and history are separate reads because they are separate questions
  // and one of them is superadmin-only — folding them into loadStoreDetail
  // would mean a member's page paying for a query whose result they cannot see.
  const [people, audit] = await Promise.all([
    loadStorePeople(store.id),
    canManage(viewer) ? getStoreAudit(store.id) : Promise.resolve(null),
  ]);

  const address = store.customDomain ?? `${store.slug}.${ROOT_DOMAIN}`;
  const origin = `https://${address}`;
  const admins = people.filter((p) => p.kind === "admin");
  const posStaff = people.filter((p) => p.kind === "pos");

  return (
    <div className="w-full max-w-7xl space-y-6">
      <Link
        href="/dashboard/stores"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" /> All stores
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
              {store.name}
            </h1>
            <span
              className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                store.status === "active"
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                  : "bg-amber-50 text-amber-700 ring-amber-600/20"
              }`}
            >
              {store.status}
            </span>
            {store.demo ? (
              <span className="inline-flex items-center rounded-md bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700 ring-1 ring-inset ring-violet-600/20">
                demo
              </span>
            ) : null}
            {!store.launched ? (
              // Not a warning — a new store is deliberately kept out of search
              // until its owner publishes something (lib/store/launch.ts).
              <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-400/20">
                not launched
              </span>
            ) : null}
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-slate-500">
            <a
              href={origin}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-slate-900"
            >
              {address} <ExternalLink className="h-3 w-3" />
            </a>
            {store.storeNo ? <span>· Store #{store.storeNo}</span> : null}
            <span>· Created {date(store.createdAt)}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`${origin}/dashboard`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Their dashboard <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <StoreManageBar
            storeId={store.id}
            slug={store.slug}
            name={store.name}
            status={store.status}
            plan={store.plan}
            canManage={canManage(viewer)}
            minkBetaEnabled={store.mink.betaEnabled}
          />
        </div>
      </header>

      <section
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
        aria-label="Store activity"
      >
        <Stat
          label="Orders"
          value={store.counts.orders.toLocaleString("en-IN")}
          detail={`${store.counts.orders30d.toLocaleString("en-IN")} in 30 days`}
          icon={<Package className="h-4 w-4" />}
        />
        <Stat
          label="Revenue"
          value={money(store.revenue.lifetime)}
          detail={`${money(store.revenue.last30d)} in 30 days`}
          icon={<Receipt className="h-4 w-4" />}
        />
        <Stat
          label="Products"
          value={store.counts.products.toLocaleString("en-IN")}
          detail={`${store.counts.blogs.toLocaleString("en-IN")} blog posts`}
          icon={<Boxes className="h-4 w-4" />}
        />
        <Stat
          label="Customers"
          value={store.counts.customers.toLocaleString("en-IN")}
          detail="shopper accounts"
          icon={<Users className="h-4 w-4" />}
        />
        <Stat
          label="Locations"
          value={store.counts.locations.toLocaleString("en-IN")}
          detail={`${store.counts.admins} admins · ${store.counts.posStaff} till staff`}
          icon={<MapPin className="h-4 w-4" />}
        />
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <Card title="Plan & billing" icon={<Receipt className="h-4 w-4" />}>
            <Facts
              rows={[
                ["Plan", <PlanSummary key="p" store={store} />],
                ["Source", store.planSource ?? "—"],
                [
                  "Expires",
                  store.planExpiresAt
                    ? date(store.planExpiresAt)
                    : "Indefinite",
                ],
                ...(store.subscription
                  ? ([
                      [
                        "Subscription",
                        `${store.subscription.state} · ${store.subscription.period}`,
                      ],
                      [
                        "Period ends",
                        date(store.subscription.currentPeriodEnd),
                      ],
                      [
                        "Billed locations",
                        String(store.subscription.billedLocations),
                      ],
                      ...(store.subscription.graceEndsAt
                        ? ([
                            [
                              "Grace ends",
                              <span key="g" className="text-amber-700">
                                {date(store.subscription.graceEndsAt)}
                              </span>,
                            ],
                          ] as [string, React.ReactNode][])
                        : []),
                      ...(store.subscription.cancelAtPeriodEnd
                        ? ([
                            [
                              "Cancelling",
                              <span key="c" className="text-amber-700">
                                at period end
                              </span>,
                            ],
                          ] as [string, React.ReactNode][])
                        : []),
                    ] as [string, React.ReactNode][])
                  : ([
                      [
                        "Subscription",
                        <span key="s" className="text-slate-400">
                          none
                        </span>,
                      ],
                    ] as [string, React.ReactNode][])),
              ]}
            />
            {/* A comp sits BELOW the billing facts, because it is not one: it
                changes nothing about what this store is charged, only what it
                can do (docs/comped-plans-spec.md). */}
            <div className="mt-4">
              <CompGrantCard
                storeId={store.id}
                comp={store.comp}
                canManage={canManage(viewer)}
              />
            </div>
          </Card>

          <Card title="Channels" icon={<CreditCard className="h-4 w-4" />}>
            {/* State only — never a credential. The gateway, carrier and SMS
                secrets are encrypted and write-only by design (§18/§35/§37),
                and an operator console is not a reason to widen that. */}
            <div className="divide-y divide-slate-100">
              <ChannelRow
                label="Payments (Razorpay)"
                state={store.channels.payments}
              />
              <ChannelRow
                label="Logistics (Shiprocket)"
                state={store.channels.logistics}
              />
              <ChannelRow label="SMS (Twilio)" state={store.channels.sms} />
            </div>
          </Card>

          <Card title="Mink usage" icon={<Sparkles className="h-4 w-4" />}>
            <Facts
              rows={[
                [
                  "This month",
                  store.ai.cap === null
                    ? `${store.ai.used} (unlimited)`
                    : `${store.ai.used} of ${store.ai.cap}`,
                ],
                ["Credit balance", String(store.ai.creditBalance)],
              ]}
            />
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Details" icon={<Truck className="h-4 w-4" />}>
            <Facts
              rows={[
                ["Owner", store.owner?.email ?? "—"],
                [
                  "Business location",
                  [store.business.city, store.business.country]
                    .filter(Boolean)
                    .join(", ") || "—",
                ],
                [
                  "Custom domain",
                  store.customDomain ? (
                    <span>
                      {store.customDomain}
                      {store.domainVerified ? (
                        <span className="ml-2 text-xs font-normal text-emerald-700">
                          live
                        </span>
                      ) : (
                        <span className="ml-2 text-xs font-normal text-amber-700">
                          pending
                        </span>
                      )}
                    </span>
                  ) : (
                    "—"
                  ),
                ],
                ["Search-indexable", store.launched ? "Yes" : "Not yet"],
                [
                  "Store ID",
                  <code key="id" className="text-xs">
                    {store.id}
                  </code>,
                ],
              ]}
            />
          </Card>

          <Card
            title="People"
            icon={<Users className="h-4 w-4" />}
            action={
              <Link
                href={`/dashboard/people?store=${store.id}`}
                className="text-xs font-semibold text-indigo-600 hover:text-indigo-800"
              >
                Open in People
              </Link>
            }
          >
            {people.length === 0 ? (
              <p className="text-sm text-slate-500">
                Nobody can sign in to this store yet.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {people.slice(0, 8).map((p) => (
                  <li
                    key={`${p.kind}-${p.id}`}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-medium text-slate-900">
                        {p.name || p.email}
                      </div>
                      <div className="truncate text-xs text-slate-500">
                        {p.email}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600">
                        {p.role}
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                          p.kind === "pos"
                            ? "bg-sky-50 text-sky-700"
                            : "bg-indigo-50 text-indigo-700"
                        }`}
                      >
                        {p.kind === "pos" ? "till" : "dashboard"}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {people.length > 8 ? (
              <p className="mt-3 text-xs text-slate-500">
                +{people.length - 8} more ({admins.length} dashboard,{" "}
                {posStaff.length} till)
              </p>
            ) : null}
          </Card>
        </div>
      </div>

      {canManage(viewer) ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card title="Plan history">
            {!audit || audit.planEvents.length === 0 ? (
              <p className="text-sm text-slate-500">
                No plan changes recorded.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {audit.planEvents.map((e) => (
                  <li key={e.id} className="py-2.5 text-sm">
                    <div className="text-slate-800">
                      {e.from_plan ? `${e.from_plan} → ` : ""}
                      <span className="font-semibold">{e.to_plan}</span>
                      {e.note ? (
                        <span className="ml-2 text-xs text-slate-500">
                          {e.note}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {date(e.created_at)} · {e.source}
                      {e.actor ? ` · ${e.actor}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Mink credit ledger">
            {!audit || audit.creditLedger.length === 0 ? (
              <p className="text-sm text-slate-500">No credit activity.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {audit.creditLedger.map((l) => (
                  <li
                    key={l.id}
                    className="flex items-center justify-between py-2.5 text-sm"
                  >
                    <div>
                      <div className="capitalize text-slate-800">
                        {l.kind}
                        {l.note ? (
                          <span className="ml-2 text-xs normal-case text-slate-500">
                            {l.note}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">
                        {date(l.created_at)}
                        {l.ref ? ` · ${l.ref}` : ""}
                      </div>
                    </div>
                    <span
                      className={`font-semibold ${
                        l.delta > 0 ? "text-emerald-600" : "text-slate-500"
                      }`}
                    >
                      {l.delta > 0 ? `+${l.delta}` : l.delta}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  );
}
