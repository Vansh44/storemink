"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  setStoreStatus,
  setStorePlan,
  deleteStore,
  grantAiCredits,
  type PlatformStoreRow,
} from "@/app/actions/platform";
import {
  PLAN_IDS,
  PLAN_META,
  effectivePlan,
  limitsFor,
  normalizePlan,
  type Plan,
} from "@/lib/plans";
import {
  Search,
  AlertTriangle,
  ArrowUpCircle,
  Coins,
  History,
} from "lucide-react";

// Badge styling per plan — free is neutral, paid tiers get colour.
const PLAN_BADGE: Record<Plan, string> = {
  free: "bg-gray-50 text-gray-600 ring-gray-500/10",
  basic: "bg-sky-50 text-sky-700 ring-sky-600/20",
  pro: "bg-violet-50 text-violet-700 ring-violet-600/20",
};

// Duration choices for a timed plan grant (months presets / custom date).
const PLAN_DURATIONS = [
  { id: "indefinite", label: "Indefinite" },
  { id: "1", label: "1 month" },
  { id: "3", label: "3 months" },
  { id: "6", label: "6 months" },
  { id: "12", label: "12 months" },
  { id: "custom", label: "Custom date" },
] as const;
type PlanDuration = (typeof PLAN_DURATIONS)[number]["id"];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function storeUrl(store: PlatformStoreRow, rootDomain: string): string {
  return store.custom_domain
    ? `https://${store.custom_domain}`
    : `https://${store.slug}.${rootDomain}`;
}

export function StoresConsole({
  stores,
  canManage,
  q,
  rootDomain,
}: {
  stores: PlatformStoreRow[];
  canManage: boolean;
  email: string;
  q: string;
  rootDomain: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(q);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Permanent-delete confirmation: the operator must retype the store slug.
  const [toDelete, setToDelete] = useState<PlatformStoreRow | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // Plan dialog — any plan, any direction, optionally time-boxed.
  const [toPlanChange, setToPlanChange] = useState<PlatformStoreRow | null>(
    null,
  );
  const [targetPlan, setTargetPlan] = useState<Plan>("free");
  const [duration, setDuration] = useState<PlanDuration>("indefinite");
  const [customDate, setCustomDate] = useState("");
  const [savingPlan, setSavingPlan] = useState(false);
  const [planError, setPlanError] = useState("");

  function openPlanDialog(store: PlatformStoreRow) {
    setToPlanChange(store);
    setTargetPlan(normalizePlan(store.plan));
    setDuration("indefinite");
    setCustomDate("");
    setPlanError("");
  }

  // Human preview of the selected duration. Pure (no Date.now() during
  // render — react-hooks/purity): month presets read relatively, a custom
  // date shows the picked day. The confirm handler computes the real expiry.
  function expiryPreview(): string | null {
    if (targetPlan === "free" || duration === "indefinite") return null;
    if (duration === "custom") {
      if (!customDate) return null;
      const end = new Date(`${customDate}T23:59:59.999`);
      if (Number.isNaN(end.getTime())) return null;
      return `Plan lapses to Free on ${formatDate(end.toISOString())}.`;
    }
    return `Plan lapses to Free after ${duration} month${duration === "1" ? "" : "s"}.`;
  }

  // The expiry timestamp the current dialog selection resolves to (null =
  // indefinite / free). Custom dates are date-level: valid through the END of
  // the picked day in the operator's timezone.
  function selectedExpiry(
    now: number,
  ): { expiresAt: string | null } | { error: string } {
    if (targetPlan === "free" || duration === "indefinite") {
      return { expiresAt: null };
    }
    if (duration === "custom") {
      if (!customDate) return { error: "Pick an expiry date." };
      const end = new Date(`${customDate}T23:59:59.999`);
      if (Number.isNaN(end.getTime()) || end.getTime() <= now) {
        return { error: "The expiry date must be in the future." };
      }
      return { expiresAt: end.toISOString() };
    }
    const end = new Date(now);
    end.setMonth(end.getMonth() + Number(duration));
    return { expiresAt: end.toISOString() };
  }

  async function confirmPlanChange() {
    if (!toPlanChange) return;
    const expiry = selectedExpiry(Date.now());
    if ("error" in expiry) {
      setPlanError(expiry.error);
      return;
    }
    setSavingPlan(true);
    setPlanError("");
    const res = await setStorePlan(toPlanChange.id, targetPlan, {
      expiresAt: expiry.expiresAt,
    });
    setSavingPlan(false);
    if (res.error) {
      setPlanError(res.error);
      return;
    }
    setToPlanChange(null);
    startTransition(() => router.refresh());
  }

  // Grant-credits dialog (superadmin comp — audited in ai_credit_ledger).
  const [toGrant, setToGrant] = useState<PlatformStoreRow | null>(null);
  const [grantAmount, setGrantAmount] = useState("");
  const [grantNote, setGrantNote] = useState("");
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState("");

  function openGrant(store: PlatformStoreRow) {
    setToGrant(store);
    setGrantAmount("");
    setGrantNote("");
    setGrantError("");
  }

  async function confirmGrant() {
    if (!toGrant) return;
    const amount = Number(grantAmount);
    if (!Number.isInteger(amount) || amount < 1) {
      setGrantError("Enter a whole number of credits.");
      return;
    }
    setGranting(true);
    setGrantError("");
    const res = await grantAiCredits(toGrant.id, amount, grantNote);
    setGranting(false);
    if (res.error) {
      setGrantError(res.error);
      return;
    }
    setToGrant(null);
    startTransition(() => router.refresh());
  }

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const params = search.trim()
      ? `?q=${encodeURIComponent(search.trim())}`
      : "";
    router.push(`/dashboard/stores${params}`);
  }

  async function toggleStatus(store: PlatformStoreRow) {
    setPendingId(store.id);
    const next = store.status === "active" ? "suspended" : "active";
    const res = await setStoreStatus(store.id, next);
    setPendingId(null);
    if (res.error) {
      alert(res.error);
      return;
    }
    startTransition(() => router.refresh());
  }

  function openDelete(store: PlatformStoreRow) {
    setToDelete(store);
    setConfirmText("");
    setDeleteError("");
  }

  async function confirmDelete() {
    if (!toDelete) return;
    setDeleting(true);
    setDeleteError("");
    const res = await deleteStore(toDelete.id);
    setDeleting(false);
    if (res.error) {
      setDeleteError(res.error);
      return;
    }
    setToDelete(null);
    if (res.warning) alert(res.warning);
    startTransition(() => router.refresh());
  }

  return (
    <div className="w-full space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end gap-4">
        {/* The page owns the <h1>; this component owns the search and the
            table. It used to carry its own heading too, which read as a second
            title once it stopped being the whole of the home page. */}
        <p className="text-sm text-gray-500">
          Open a store for its full record, or act on it from here.
        </p>

        <form className="relative w-full sm:max-w-sm" onSubmit={submitSearch}>
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            className="flex h-10 w-full rounded-md border border-gray-200 bg-white px-3 py-2 pl-9 text-sm outline-none placeholder:text-gray-400 focus:border-gray-300 focus:ring-4 focus:ring-gray-100 transition-all shadow-sm"
            placeholder="Search stores by name or address…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
      </div>

      <div className="border border-gray-200 bg-white rounded-xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-6 py-3 font-medium text-gray-500">Store</th>
                <th className="px-6 py-3 font-medium text-gray-500">Owner</th>
                <th className="px-6 py-3 font-medium text-gray-500">Status</th>
                <th className="px-6 py-3 font-medium text-gray-500">Plan</th>
                <th className="px-6 py-3 font-medium text-gray-500">
                  AI · credits
                </th>
                <th className="px-6 py-3 font-medium text-gray-500">Created</th>
                <th className="px-6 py-3 font-medium text-gray-500 text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {stores.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-6 py-12 text-center text-gray-500"
                  >
                    No stores found.
                  </td>
                </tr>
              )}
              {stores.map((s) => {
                const addr = s.custom_domain ?? `${s.slug}.${rootDomain}`;
                return (
                  <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4">
                      <Link
                        href={`/dashboard/stores/${s.id}`}
                        className="font-semibold text-gray-900 hover:text-indigo-700 hover:underline"
                      >
                        {s.name}
                      </Link>
                      <div className="text-gray-500 mt-0.5">{addr}</div>
                    </td>
                    <td className="px-6 py-4 text-gray-600">
                      {s.owner_email ?? (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium ${
                          s.status === "active"
                            ? "bg-green-50 text-green-700 ring-1 ring-inset ring-green-600/20"
                            : "bg-gray-50 text-gray-600 ring-1 ring-inset ring-gray-500/10"
                        }`}
                      >
                        {s.status}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span
                        className={`inline-flex items-center px-2 py-1 rounded-md text-xs font-medium ring-1 ring-inset ${PLAN_BADGE[normalizePlan(s.plan)]}`}
                      >
                        {PLAN_META[normalizePlan(s.plan)].name}
                      </span>
                      {s.plan_expires_at &&
                        (effectivePlan(s) !== normalizePlan(s.plan) ? (
                          <div className="mt-1 text-xs font-medium text-amber-600">
                            expired {formatDate(s.plan_expires_at)}
                          </div>
                        ) : (
                          <div className="mt-1 text-xs text-gray-400">
                            till {formatDate(s.plan_expires_at)}
                          </div>
                        ))}
                    </td>
                    <td className="px-6 py-4">
                      {(() => {
                        const cap = limitsFor(
                          effectivePlan(s),
                        ).aiGenerationsPerMonth;
                        return (
                          <>
                            <div className="text-gray-700">
                              {s.ai_used}
                              <span className="text-gray-400">
                                /{cap === null ? "∞" : cap} AI
                              </span>
                            </div>
                            <div className="mt-0.5 text-xs text-gray-500">
                              {s.credit_balance} credit
                              {s.credit_balance === 1 ? "" : "s"}
                              {s.gateway !== "none" && (
                                <span
                                  className={
                                    s.gateway === "enabled"
                                      ? "ml-2 text-green-600"
                                      : "ml-2 text-amber-600"
                                  }
                                >
                                  · gateway {s.gateway}
                                </span>
                              )}
                            </div>
                          </>
                        );
                      })()}
                    </td>
                    <td className="px-6 py-4 text-gray-600">
                      {new Date(s.created_at).toLocaleDateString("en-GB", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-4">
                        <a
                          className="text-primary hover:text-primary/80 font-medium transition-colors"
                          href={`${storeUrl(s, rootDomain)}/dashboard`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open ↗
                        </a>
                        {canManage && (
                          <button
                            className="px-3 py-1.5 rounded-md text-sm font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 transition-colors inline-flex items-center gap-1"
                            onClick={() => openPlanDialog(s)}
                          >
                            <ArrowUpCircle className="h-3.5 w-3.5" />
                            Plan
                          </button>
                        )}
                        {canManage && (
                          <button
                            className="px-3 py-1.5 rounded-md text-sm font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors inline-flex items-center gap-1"
                            onClick={() => openGrant(s)}
                          >
                            <Coins className="h-3.5 w-3.5" />
                            Credits
                          </button>
                        )}
                        <Link
                          href={`/dashboard/stores/${s.id}`}
                          className="px-3 py-1.5 rounded-md text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors inline-flex items-center gap-1"
                        >
                          <History className="h-3.5 w-3.5" />
                          Details
                        </Link>
                        {canManage && (
                          <button
                            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                              s.status === "active"
                                ? "text-amber-700 bg-amber-50 hover:bg-amber-100"
                                : "text-gray-700 bg-gray-100 hover:bg-gray-200"
                            }`}
                            disabled={pendingId === s.id}
                            onClick={() => toggleStatus(s)}
                          >
                            {pendingId === s.id
                              ? "…"
                              : s.status === "active"
                                ? "Suspend"
                                : "Activate"}
                          </button>
                        )}
                        {canManage && (
                          <button
                            className="px-3 py-1.5 rounded-md text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 transition-colors"
                            onClick={() => openDelete(s)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {toPlanChange && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !savingPlan && setToPlanChange(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white shadow-xl border border-gray-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
                  <ArrowUpCircle className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">
                    Change plan for {toPlanChange.name}
                  </h2>
                  <p className="mt-1 text-sm text-gray-500">
                    Currently on{" "}
                    <span className="font-medium">
                      {PLAN_META[normalizePlan(toPlanChange.plan)].name}
                    </span>
                    {toPlanChange.plan_expires_at
                      ? ` (till ${formatDate(toPlanChange.plan_expires_at)})`
                      : ""}
                    . Changes apply immediately; downgrades never delete data.
                  </p>
                </div>
              </div>

              <div className="mt-5 space-y-2">
                {PLAN_IDS.map((p) => {
                  const meta = PLAN_META[p];
                  const active = targetPlan === p;
                  const isCurrent = normalizePlan(toPlanChange.plan) === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setTargetPlan(p)}
                      className={`w-full rounded-lg border p-3 text-left transition-colors ${
                        active
                          ? "border-indigo-500 ring-2 ring-indigo-100 bg-indigo-50/40"
                          : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-gray-900">
                          {meta.name}
                          {isCurrent && (
                            <span className="ml-2 text-xs font-medium text-gray-400">
                              current
                            </span>
                          )}
                        </span>
                        <span className="text-sm text-gray-600">
                          ₹{meta.monthlyInr.toLocaleString("en-IN")}/mo
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {meta.tagline}
                      </p>
                    </button>
                  );
                })}
              </div>

              {targetPlan !== "free" && (
                <div className="mt-5">
                  <label className="text-sm font-medium text-gray-700">
                    Duration
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {PLAN_DURATIONS.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => setDuration(d.id)}
                        className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                          duration === d.id
                            ? "bg-indigo-600 text-white"
                            : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                        }`}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                  {duration === "custom" && (
                    <input
                      type="date"
                      className="mt-3 h-10 w-full rounded-md border border-gray-300 px-3 text-sm outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-50"
                      value={customDate}
                      onChange={(e) => setCustomDate(e.target.value)}
                    />
                  )}
                  {(() => {
                    const preview = expiryPreview();
                    return preview ? (
                      <p className="mt-2 text-xs text-gray-500">{preview}</p>
                    ) : null;
                  })()}
                </div>
              )}

              {planError && (
                <p className="mt-3 text-sm text-red-600">{planError}</p>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-6 py-4">
              <button
                className="px-4 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100"
                onClick={() => setToPlanChange(null)}
                disabled={savingPlan}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 rounded-md text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={savingPlan}
                onClick={confirmPlanChange}
              >
                {savingPlan
                  ? "Saving…"
                  : `Set to ${PLAN_META[targetPlan].name}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {toDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !deleting && setToDelete(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white shadow-xl border border-gray-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">
                    Permanently delete {toDelete.name}?
                  </h2>
                  <p className="mt-1 text-sm text-gray-500">
                    This erases the store and <strong>all of its data</strong> —
                    products, categories, blogs, pages, menus, coupons and
                    uploaded media — plus every login for it (owner
                    {toDelete.owner_email ? ` ${toDelete.owner_email}` : ""},
                    staff and customers). This <strong>cannot be undone</strong>
                    .
                  </p>
                </div>
              </div>

              <div className="mt-5">
                <label className="text-sm font-medium text-gray-700">
                  Type{" "}
                  <span className="font-mono font-semibold text-gray-900">
                    {toDelete.slug}
                  </span>{" "}
                  to confirm
                </label>
                <input
                  autoFocus
                  className="mt-2 h-10 w-full rounded-md border border-gray-300 px-3 text-sm outline-none focus:border-red-400 focus:ring-4 focus:ring-red-50"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder={toDelete.slug}
                  disabled={deleting}
                />
                {deleteError && (
                  <p className="mt-2 text-sm text-red-600">{deleteError}</p>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-6 py-4">
              <button
                className="px-4 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100"
                onClick={() => setToDelete(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 rounded-md text-sm font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={deleting || confirmText.trim() !== toDelete.slug}
                onClick={confirmDelete}
              >
                {deleting ? "Deleting…" : "Delete forever"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toGrant && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !granting && setToGrant(null)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-white shadow-xl border border-gray-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600">
                  <Coins className="h-5 w-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900">
                    Grant Mink credits to {toGrant.name}
                  </h2>
                  <p className="mt-1 text-sm text-gray-500">
                    Free of cost, never expire, recorded in the credit ledger
                    with your email. Current balance:{" "}
                    <span className="font-medium">
                      {toGrant.credit_balance}
                    </span>
                    .
                  </p>
                </div>
              </div>

              <div className="mt-5 space-y-4">
                <div>
                  <label className="text-sm font-medium text-gray-700">
                    Credits
                  </label>
                  <input
                    autoFocus
                    type="number"
                    min={1}
                    step={1}
                    className="mt-2 h-10 w-full rounded-md border border-gray-300 px-3 text-sm outline-none focus:border-amber-400 focus:ring-4 focus:ring-amber-50"
                    value={grantAmount}
                    onChange={(e) => setGrantAmount(e.target.value)}
                    placeholder="e.g. 50"
                    disabled={granting}
                  />
                </div>
                <div>
                  <label className="text-sm font-medium text-gray-700">
                    Note (optional)
                  </label>
                  <input
                    className="mt-2 h-10 w-full rounded-md border border-gray-300 px-3 text-sm outline-none focus:border-amber-400 focus:ring-4 focus:ring-amber-50"
                    value={grantNote}
                    onChange={(e) => setGrantNote(e.target.value)}
                    placeholder="e.g. onboarding goodwill"
                    maxLength={200}
                    disabled={granting}
                  />
                </div>
                {grantError && (
                  <p className="text-sm text-red-600">{grantError}</p>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-6 py-4">
              <button
                className="px-4 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100"
                onClick={() => setToGrant(null)}
                disabled={granting}
              >
                Cancel
              </button>
              <button
                className="px-4 py-2 rounded-md text-sm font-semibold text-white bg-amber-600 hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
                disabled={granting || !grantAmount.trim()}
                onClick={confirmGrant}
              >
                {granting ? "Granting…" : "Grant credits"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
