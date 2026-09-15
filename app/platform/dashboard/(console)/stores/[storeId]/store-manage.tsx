"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUpCircle, Bot, Coins, Power, Trash2 } from "lucide-react";
import {
  deleteStore,
  grantAiCredits,
  setStorePlan,
  setStoreStatus,
} from "@/app/actions/platform";
import { setMinkBetaAccess } from "@/app/actions/mink-operator-actions";
import { PLAN_IDS, PLAN_META, normalizePlan, type Plan } from "@/lib/plans";

// ---------------------------------------------------------------------------
// The four things an operator can DO to a store, on the store's own page.
//
// ★ THEY LIVE HERE RATHER THAN ONLY IN THE LIST because acting on a store from
// a row of 500 means acting on whichever row you last hovered. On this page the
// name of the store you are suspending is the heading above the button.
//
// ★ EVERY ACTION RE-GATES SERVER-SIDE. `canManage` decides what to RENDER;
// `setStoreStatus` / `setStorePlan` / `grantAiCredits` / `deleteStore` each
// check `role === "superadmin"` for themselves. A hidden button is not a
// permission.
// ---------------------------------------------------------------------------

const DURATIONS = [
  { id: "indefinite", label: "Indefinite" },
  { id: "1", label: "1 month" },
  { id: "3", label: "3 months" },
  { id: "6", label: "6 months" },
  { id: "12", label: "12 months" },
  { id: "custom", label: "Custom date" },
] as const;
type Duration = (typeof DURATIONS)[number]["id"];

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}

export function StoreManageBar({
  storeId,
  slug,
  name,
  status,
  plan,
  canManage,
  minkBetaEnabled,
}: {
  storeId: string;
  slug: string;
  name: string;
  status: string;
  plan: Plan;
  canManage: boolean;
  minkBetaEnabled: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  const [planOpen, setPlanOpen] = useState(false);
  const [targetPlan, setTargetPlan] = useState<Plan>(normalizePlan(plan));
  const [duration, setDuration] = useState<Duration>("indefinite");
  const [customDate, setCustomDate] = useState("");

  const [creditsOpen, setCreditsOpen] = useState(false);
  const [creditAmount, setCreditAmount] = useState("25");
  const [creditNote, setCreditNote] = useState("");

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  if (!canManage) return null;

  function done(message: string) {
    toast.success(message);
    startTransition(() => router.refresh());
  }

  async function toggleStatus() {
    const next = status === "active" ? "suspended" : "active";
    setBusy(true);
    const res = await setStoreStatus(storeId, next);
    setBusy(false);
    if (res.error) return void toast.error(res.error);
    done(next === "suspended" ? "Store suspended." : "Store reactivated.");
  }

  async function toggleMinkBeta() {
    setBusy(true);
    const res = await setMinkBetaAccess(storeId, !minkBetaEnabled);
    setBusy(false);
    if (res.error) return void toast.error(res.error);
    done(
      minkBetaEnabled
        ? `Disabled Mink AI for ${name}.`
        : `Enabled Mink AI and all its features for ${name}.`,
    );
  }

  /** The expiry the current selection resolves to, or an error to show. */
  function selectedExpiry(): { expiresAt: string | null } | { error: string } {
    if (targetPlan === "free" || duration === "indefinite") {
      return { expiresAt: null };
    }
    if (duration === "custom") {
      if (!customDate) return { error: "Pick an expiry date." };
      const end = new Date(`${customDate}T23:59:59.999`);
      if (Number.isNaN(end.getTime()) || end.getTime() <= Date.now()) {
        return { error: "The expiry date must be in the future." };
      }
      return { expiresAt: end.toISOString() };
    }
    const end = new Date();
    end.setMonth(end.getMonth() + Number(duration));
    return { expiresAt: end.toISOString() };
  }

  async function savePlan() {
    const resolved = selectedExpiry();
    if ("error" in resolved) return void toast.error(resolved.error);

    setBusy(true);
    const res = await setStorePlan(storeId, targetPlan, {
      expiresAt: resolved.expiresAt,
    });
    setBusy(false);
    if (res.error) return void toast.error(res.error);
    setPlanOpen(false);
    done(`${name} is now on ${PLAN_META[targetPlan]?.name ?? targetPlan}.`);
  }

  async function saveCredits() {
    const amount = Number(creditAmount);
    if (!Number.isInteger(amount) || amount < 1) {
      return void toast.error("Enter a whole number of credits.");
    }
    setBusy(true);
    const res = await grantAiCredits(storeId, amount, creditNote || undefined);
    setBusy(false);
    if (res.error) return void toast.error(res.error);
    setCreditsOpen(false);
    setCreditNote("");
    done(`Granted ${amount} credits.`);
  }

  async function confirmDelete() {
    setBusy(true);
    const res = await deleteStore(storeId);
    setBusy(false);
    if (res.error) return void toast.error(res.error);
    if (res.warning) toast.warning(res.warning);
    else toast.success(`${name} deleted.`);
    // Back to the list — the page we are on no longer describes anything.
    router.push("/dashboard/stores");
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setPlanOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-50 px-3.5 py-2 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-100"
        >
          <ArrowUpCircle className="h-4 w-4" /> Plan
        </button>
        <button
          onClick={() => setCreditsOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-amber-50 px-3.5 py-2 text-sm font-semibold text-amber-700 transition hover:bg-amber-100"
        >
          <Coins className="h-4 w-4" /> Credits
        </button>
        <button
          onClick={toggleMinkBeta}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg bg-violet-50 px-3.5 py-2 text-sm font-semibold text-violet-700 transition hover:bg-violet-100 disabled:opacity-50"
        >
          <Bot className="h-4 w-4" />
          {minkBetaEnabled ? "Disable Mink AI" : "Enable Mink AI"}
        </button>
        <button
          onClick={toggleStatus}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
        >
          <Power className="h-4 w-4" />
          {status === "active" ? "Suspend" : "Activate"}
        </button>
        <button
          onClick={() => {
            setConfirmText("");
            setDeleteOpen(true);
          }}
          className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-red-600 transition hover:bg-red-50"
        >
          <Trash2 className="h-4 w-4" /> Delete
        </button>
      </div>

      {planOpen && (
        <Modal
          title={`Change plan — ${name}`}
          onClose={() => setPlanOpen(false)}
        >
          <label className="block text-sm font-medium text-slate-700">
            Plan
          </label>
          <select
            className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={targetPlan}
            onChange={(e) => setTargetPlan(e.target.value as Plan)}
          >
            {PLAN_IDS.map((id) => (
              <option key={id} value={id}>
                {PLAN_META[id]?.name ?? id}
              </option>
            ))}
          </select>

          {targetPlan !== "free" && (
            <>
              <label className="mt-4 block text-sm font-medium text-slate-700">
                Duration
              </label>
              <select
                className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
                value={duration}
                onChange={(e) => setDuration(e.target.value as Duration)}
              >
                {DURATIONS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
              {duration === "custom" && (
                <input
                  type="date"
                  className="mt-2 w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
                  value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                />
              )}
              <p className="mt-2 text-xs text-slate-500">
                A timed grant lapses to Free automatically. An operator grant is
                a floor: paid billing may raise it, never lower it.
              </p>
            </>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <button
              className="rounded-md px-3.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
              onClick={() => setPlanOpen(false)}
            >
              Cancel
            </button>
            <button
              className="rounded-md bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              disabled={busy}
              onClick={savePlan}
            >
              {busy ? "Saving…" : "Save plan"}
            </button>
          </div>
        </Modal>
      )}

      {creditsOpen && (
        <Modal
          title={`Grant Mink credits — ${name}`}
          onClose={() => setCreditsOpen(false)}
        >
          <label className="block text-sm font-medium text-slate-700">
            Credits
          </label>
          <input
            type="number"
            min={1}
            className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={creditAmount}
            onChange={(e) => setCreditAmount(e.target.value)}
          />
          <label className="mt-4 block text-sm font-medium text-slate-700">
            Note <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <input
            className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            placeholder="Why this grant was made"
            value={creditNote}
            onChange={(e) => setCreditNote(e.target.value)}
          />
          <p className="mt-2 text-xs text-slate-500">
            Recorded in the credit ledger against your email. Credits never
            expire and are spent only after the monthly allowance.
          </p>
          <div className="mt-6 flex justify-end gap-2">
            <button
              className="rounded-md px-3.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
              onClick={() => setCreditsOpen(false)}
            >
              Cancel
            </button>
            <button
              className="rounded-md bg-slate-900 px-3.5 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
              disabled={busy}
              onClick={saveCredits}
            >
              {busy ? "Granting…" : "Grant"}
            </button>
          </div>
        </Modal>
      )}

      {deleteOpen && (
        <Modal title={`Delete ${name}?`} onClose={() => setDeleteOpen(false)}>
          <p className="text-sm text-slate-600">
            This permanently removes the store, its orders, products, customers,
            uploaded media and every login attached to it. It cannot be undone.
          </p>
          <label className="mt-4 block text-sm font-medium text-slate-700">
            Type <code className="rounded bg-slate-100 px-1">{slug}</code> to
            confirm
          </label>
          <input
            className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoComplete="off"
          />
          <div className="mt-6 flex justify-end gap-2">
            <button
              className="rounded-md px-3.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100"
              onClick={() => setDeleteOpen(false)}
            >
              Cancel
            </button>
            <button
              className="rounded-md bg-red-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
              disabled={busy || confirmText !== slug}
              onClick={confirmDelete}
            >
              {busy ? "Deleting…" : "Delete permanently"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
