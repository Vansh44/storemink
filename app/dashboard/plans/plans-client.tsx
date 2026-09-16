"use client";

import { useState, useTransition } from "react";
import { renewalTerm, renewalLabel } from "@/lib/plans/renewal";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  Sparkles,
  Coins,
  ShoppingCart,
  Gift,
  Zap,
  Lock,
  History,
  FileText,
  Check,
  BadgeCheck,
  RefreshCw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  confirmCreditPurchase,
  startCreditPurchase,
  type AiUsagePageData,
} from "@/app/actions/ai-credit-actions";
// ★ Everything on this page now goes through the NEW billing system (§34) —
// there is no second billing path left. See docs/billing-architecture.md.
import {
  cancelMySubscription,
  changeMyPlan,
  confirmMyPlanChange,
  confirmSubscribe,
  resumeMySubscription,
  startSubscribe,
} from "@/app/actions/subscribe-actions";
import type { SubscriptionView } from "@/lib/billing/invoice-types";
import type { CreditPack } from "@/lib/ai/credits";
import { openRazorpayModal } from "@/lib/payments/razorpay-client";
import {
  autopayRailFor,
  type MandateMethod,
} from "@/lib/billing/mandate-types";
import {
  PLAN_IDS,
  PLAN_LIMITS,
  PLAN_META,
  PLAN_RANK,
  allowanceLabel,
  normalizePlan,
  type IncludedMinkCredits,
  type Plan,
} from "@/lib/plans";
import type { PlanPricing } from "@/lib/plans/pricing";

const KIND_META: Record<
  AiUsagePageData["ledger"][number]["kind"],
  { label: string; Icon: typeof Zap; tone: string }
> = {
  spend: { label: "Generation", Icon: Zap, tone: "text-gray-500" },
  purchase: { label: "Purchase", Icon: ShoppingCart, tone: "text-green-600" },
  grant: { label: "Grant", Icon: Gift, tone: "text-indigo-600" },
};

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

// The bullets shown for each plan in "Available plans", derived from the plan
// limits so they can never drift from what's actually enforced. ★ The Mink
// allowance is the one row an operator can move without a deploy, so it comes
// in resolved rather than from PLAN_LIMITS — reading the constant here would
// advertise a number the quota gate is no longer enforcing.
function planFeatures(plan: Plan, included: IncludedMinkCredits): string[] {
  const l = PLAN_LIMITS[plan];
  return [
    `${l.maxProducts === null ? "Unlimited" : l.maxProducts} products`,
    `${l.maxStaff === null ? "Unlimited" : l.maxStaff} staff account${l.maxStaff === 1 ? "" : "s"}`,
    `${allowanceLabel(included[plan])} Mink credits / month`,
    l.customDomain ? "Custom domain" : "Subdomain only",
    l.onlinePayments ? "Online payments (own gateway)" : "Cash on Delivery",
    ...(l.customerBlogSubmissions ? ["Customer blog submissions"] : []),
    ...(l.customerGroups ? ["Customer groups"] : []),
    ...(l.shippingIntegration ? ["Shiprocket integration"] : []),
    ...(l.customCode ? ["Custom-code page sections"] : []),
    ...(l.emailCampaigns ? ["Email campaigns"] : []),
    ...(l.advancedAnalytics
      ? ["Advanced analytics — GA4, Meta Pixel and conversion insights"]
      : []),
    ...(l.removeBadge ? ['No "Powered by StoreMink" badge'] : []),
  ];
}

export function PlansBillingClient({
  initialData,
  subscription,
  packs,
  canManage,
  pricing,
  includedCredits,
}: {
  initialData: AiUsagePageData;
  subscription: SubscriptionView;
  packs: CreditPack[];
  canManage: boolean;
  /** Resolved server-side, with the MINK_CHARGE_CREDITS switch already applied
   *  — the flag is server-only, so a client that guessed at it would advertise
   *  the half that is not being enforced. */
  includedCredits: IncludedMinkCredits;
  /** Resolved server-side (code defaults + operator overrides). Never read
   *  PLAN_META prices here — they ignore what an operator has set, so the card
   *  and the charge would disagree. */
  pricing: PlanPricing;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const data = initialData;
  const [buyingPack, setBuyingPack] = useState<string | null>(null);
  // Yearly by default, matching the public pricing page. It is the cheaper
  // per-month figure and the one we want anchored before a comparison.
  const [period, setPeriod] = useState<"monthly" | "yearly">("yearly");
  const [upgradeTo, setUpgradeTo] = useState<Plan | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const refresh = () => startRefresh(() => router.refresh());

  async function handleCancel() {
    // The promise has to match what the server will actually do. Access runs to
    // the end of a cycle only if a cycle is running — between authorising the
    // mandate and the first charge there isn't one, and telling someone they
    // keep a plan they were never charged for sets up the wrong expectation.
    const keepsCycle =
      subscription.status === "active" && !!subscription.currentEnd;
    if (
      !window.confirm(
        keepsCycle
          ? "Cancel your subscription? You keep your plan until the current cycle ends, then you'll move to Free. No further payments will be taken."
          : "Cancel your subscription? No payments will be taken.",
      )
    ) {
      return;
    }
    setCancelling(true);
    const res = await cancelMySubscription();
    setCancelling(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(res.message);
    refresh();
  }

  // ★ NEW: changing your mind before the cycle ends. The old path could not offer
  // this — it cancelled the subscription at the gateway, so coming back meant
  // re-authorising. Here it is clearing a flag.
  async function handleResume() {
    setCancelling(true);
    const res = await resumeMySubscription();
    setCancelling(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success(res.message);
    refresh();
  }

  const { used, cap, creditBalance, resetsAt } = data.usage;
  const remaining = cap === null ? null : Math.max(0, cap - used);
  const plan = normalizePlan(data.plan);
  const planMeta = PLAN_META[plan];
  const pct =
    cap === null
      ? 0
      : Math.min(100, Math.round((used / Math.max(cap, 1)) * 100));

  // Plan status, derived from the effective plan + expiry. `now` is captured
  // once (render must stay pure — no Date.now() inline).
  const [now] = useState(() => Date.now());

  // The allowance follows the store's plan-start anniversary, not the calendar
  // month. The server owns that calculation; the client only phrases it.
  const resetCountdown = (() => {
    const nextReset = new Date(resetsAt).getTime();
    const days = Math.ceil((nextReset - now) / 86_400_000);
    if (days <= 0) return "today";
    if (days === 1) return "tomorrow";
    return `in ${days} days`;
  })();
  const expiresAt = data.planExpiresAt;
  const expired =
    plan === "free" && !!expiresAt && new Date(expiresAt).getTime() < now;
  // Whether that date is the next charge or the last day of service.
  const term = renewalTerm({
    expiresAt,
    expired,
    // A paid cycle and an authorised mandate are different facts. An active
    // manual-renewal subscription must say "ends", not promise a renewal.
    hasMandate: subscription.autopay,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    status: subscription.status,
  });
  const status = expired
    ? { label: "Expired", tone: "amber" as const }
    : plan === "free"
      ? { label: "Free", tone: "gray" as const }
      : { label: "Active", tone: "green" as const };

  async function handleBuy(pack: CreditPack) {
    setBuyingPack(pack.id);
    const start = await startCreditPurchase(pack.id);
    if ("error" in start) {
      toast.error(start.error);
      setBuyingPack(null);
      return;
    }
    const opened = await openRazorpayModal({
      keyId: start.keyId,
      rzpOrderId: start.rzpOrderId,
      amountPaise: start.amountPaise,
      name: "StoreMink",
      description: `${pack.credits} Mink credits — ${start.packName} pack`,
      onSuccess: async (res) => {
        const confirm = await confirmCreditPurchase(
          start.purchaseId,
          res.razorpay_payment_id,
          res.razorpay_signature,
        );
        setBuyingPack(null);
        if (confirm.error) {
          toast.info(
            "Payment received — your credits will appear here in a few minutes.",
          );
        } else {
          toast.success(`${confirm.creditsAdded} Mink credits added!`);
        }
        startRefresh(() => router.refresh());
      },
      onDismiss: () => {
        setBuyingPack(null);
        toast.error("Payment not completed.");
      },
    });
    if (!opened) {
      setBuyingPack(null);
      toast.error("Couldn't load the payment window. Please try again.");
    }
  }

  return (
    <div className="dash-page-enter mx-auto w-full max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[#111827]">
          Plans &amp; Billing
        </h1>
        <p className="mt-1 text-sm text-[#5b6472]">
          Your subscription, Mink credits, and the plans you can move to.
        </p>
      </div>

      {/* ★ In the HEADER, not buried at the bottom. Finding a past invoice is
          something a merchant comes to this page specifically to do — usually
          at the request of an accountant — and it is not a thing they scroll
          for. */}
      <Link
        href="/dashboard/plans/invoices"
        className="-mt-3 inline-flex items-center gap-1.5 self-start text-sm font-medium text-[#111827] hover:underline"
      >
        <FileText className="h-4 w-4" strokeWidth={2} />
        View invoices
      </Link>

      {/* ─────────────── 1. Plan details ─────────────── */}
      <section className="rounded-xl border border-[rgba(17,24,39,0.08)] bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-indigo-50">
              <BadgeCheck className="h-6 w-6 text-indigo-600" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-[#111827]">
                  {planMeta.name} plan
                </h2>
                <StatusPill status={status} />
              </div>
              <p className="mt-0.5 text-sm text-[#5b6472]">
                {planMeta.tagline}
              </p>
            </div>
          </div>
          {plan !== "pro" && (
            <button
              type="button"
              className="dash-btn dash-btn-primary"
              onClick={() =>
                document
                  .getElementById("available-plans")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              {plan === "free" ? "Upgrade plan" : "See upgrade options"}
            </button>
          )}
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Detail label="Price">
            {/* Resolved pricing, not PLAN_META — after an operator reprice the
                constant is no longer what this store is on. */}
            {pricing[plan].monthlyInr === 0
              ? "Free"
              : `₹${pricing[plan].monthlyInr.toLocaleString("en-IN")}/mo`}
          </Detail>
          <Detail label="Status">{status.label}</Detail>
          <Detail label={renewalLabel(term)}>
            {expiresAt ? formatDate(expiresAt) : "No expiry"}
          </Detail>
          <Detail label="Billing">
            {data.planSource === "paid"
              ? "Paid subscription"
              : data.planSource === "trial"
                ? "Trial"
                : data.planSource === "comp"
                  ? "Complimentary"
                  : "—"}
          </Detail>
        </dl>

        {/* Autopay controls / notices */}
        {(subscription.active ||
          subscription.cancelAtPeriodEnd ||
          subscription.scheduledPlan) && (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[rgba(17,24,39,0.08)] pt-4">
            <p className="text-sm text-[#5b6472]">
              {subscription.cancelAtPeriodEnd ? (
                <>
                  Cancelled — you keep {planMeta.name}
                  {subscription.currentEnd
                    ? ` until ${formatDate(subscription.currentEnd)}`
                    : " until the cycle ends"}
                  , then move to Free.
                </>
              ) : subscription.scheduledPlan || subscription.scheduledPeriod ? (
                <>
                  {
                    PLAN_META[normalizePlan(subscription.scheduledPlan ?? plan)]
                      .name
                  }
                  {/* The PERIOD is named too: the old shape could not express a
                      same-tier period switch, so it silently showed nothing. */}
                  {subscription.scheduledPeriod
                    ? `, billed ${subscription.scheduledPeriod},`
                    : ""}{" "}
                  starts at your next renewal
                  {subscription.currentEnd
                    ? ` (${formatDate(subscription.currentEnd)})`
                    : ""}
                  .
                </>
              ) : subscription.autopay ? (
                <>
                  Autopay renews your {planMeta.name} plan
                  {subscription.currentEnd
                    ? ` on ${formatDate(subscription.currentEnd)}`
                    : " automatically"}
                  .
                </>
              ) : (
                <>
                  {/* ★ Autopay is OFF, which is the ordinary state while the
                      recurring charge is unverified — so say what the merchant
                      must DO rather than implying it renews itself. */}
                  Your {planMeta.name} plan runs
                  {subscription.currentEnd
                    ? ` to ${formatDate(subscription.currentEnd)}`
                    : " to the end of this cycle"}
                  . We&apos;ll send an invoice to pay before then.
                </>
              )}
            </p>
            {canManage &&
              subscription.active &&
              (subscription.cancelAtPeriodEnd ? (
                <button
                  type="button"
                  onClick={handleResume}
                  disabled={cancelling}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-[#111827] hover:bg-[#111827]/[0.04] disabled:opacity-60"
                >
                  {cancelling ? "Resuming…" : "Keep my plan"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-60"
                >
                  {cancelling ? "Cancelling…" : "Cancel subscription"}
                </button>
              ))}
          </div>
        )}
      </section>

      {/* ─────────────── 2. Mink credits & usage ─────────────── */}
      <section className="rounded-xl border border-[rgba(17,24,39,0.08)] bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-[#111827]">
          Mink credits &amp; usage
        </h2>
        <p className="mt-1 text-sm text-[#5b6472]">
          Mink conversations and supported AI tasks use your plan&apos;s
          included credits first, then your top-up credits. Top-up credits never
          expire.
        </p>

        <div className="mt-5 grid gap-6 sm:grid-cols-2">
          {/* Monthly allowance */}
          <div className="rounded-lg border border-[rgba(17,24,39,0.08)] p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-50">
                <Sparkles className="h-5 w-5 text-indigo-600" />
              </div>
              <div className="flex-1">
                <h3 className="text-base font-semibold text-[#111827]">
                  Included credits
                </h3>
                <p className="text-sm text-[#5b6472]">
                  {planMeta.name} plan allowance
                </p>
              </div>
              <button
                type="button"
                onClick={() => startRefresh(() => router.refresh())}
                disabled={refreshing}
                aria-label="Refresh usage"
                title="Refresh usage"
                className="flex h-8 w-8 items-center justify-center rounded-md text-[#6b7280] transition-colors hover:bg-[#f3f4f6] disabled:opacity-60"
              >
                <RefreshCw
                  className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
                />
              </button>
            </div>
            <div className="mt-4">
              <div className="flex items-baseline justify-between">
                <span className="text-3xl font-bold text-[#111827]">
                  {cap === null ? used : remaining}
                </span>
                <span className="text-sm text-[#5b6472]">
                  {cap === null ? "credits used" : `of ${cap} credits left`}
                </span>
              </div>
              {cap !== null && (
                <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-100">
                  <div
                    className={`h-full rounded-full ${pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-indigo-500"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
              <p className="mt-2 text-xs text-[#5b6472]">
                Resets {resetCountdown} ({formatDate(resetsAt)}).
              </p>
            </div>
          </div>

          {/* Credit balance */}
          <div className="rounded-lg border border-[rgba(17,24,39,0.08)] p-5">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-50">
                <Coins className="h-5 w-5 text-amber-600" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-[#111827]">
                  Top-up Mink credits
                </h3>
                <p className="text-sm text-[#5b6472]">Never expire</p>
              </div>
            </div>
            <div className="mt-4">
              <span className="text-3xl font-bold text-[#111827]">
                {creditBalance}
              </span>
              <span className="ml-2 text-sm text-[#5b6472]">
                credit{creditBalance === 1 ? "" : "s"} remaining
              </span>
              <p className="mt-2 text-xs text-[#5b6472]">
                Used automatically once the monthly allowance runs out.
              </p>
            </div>
          </div>
        </div>

        {/* Buy credits */}
        <div className="mt-6">
          <h3 className="text-base font-semibold text-[#111827]">
            Top up Mink credits
          </h3>
          <p className="mt-1 text-sm text-[#5b6472]">
            Add non-expiring credits for a one-off burst of Mink work.
          </p>
          <div className="mt-4">
            {!data.canBuyCredits ? (
              <div className="flex items-start gap-3 rounded-md bg-amber-50 p-4">
                <Lock className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" />
                <div className="text-sm text-amber-800">
                  <p className="font-medium">Credit top-ups are unavailable.</p>
                  <p className="mt-1">
                    Please try again later or contact StoreMink support.
                  </p>
                </div>
              </div>
            ) : !data.purchasesAvailable ? (
              <p className="text-sm text-[#5b6472]">
                Credit purchases aren&apos;t available right now. Please check
                back soon.
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-3">
                {packs.map((pack) => (
                  <div
                    key={pack.id}
                    className={`relative rounded-lg border p-5 ${
                      pack.popular
                        ? "border-indigo-300 ring-1 ring-indigo-200"
                        : "border-[rgba(17,24,39,0.08)]"
                    }`}
                  >
                    {pack.popular && (
                      <span className="absolute -top-2.5 left-4 rounded-full bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white">
                        Most popular
                      </span>
                    )}
                    <div className="text-sm font-medium text-[#5b6472]">
                      {pack.name}
                    </div>
                    <div className="mt-1 text-2xl font-bold text-[#111827]">
                      {pack.credits}{" "}
                      <span className="text-sm font-medium text-[#5b6472]">
                        credits
                      </span>
                    </div>
                    <div className="mt-1 text-sm text-[#5b6472]">
                      ₹{pack.priceInr.toLocaleString("en-IN")} · ₹
                      {(pack.priceInr / pack.credits).toFixed(2)}/credit
                    </div>
                    <button
                      type="button"
                      className="dash-btn dash-btn-primary mt-4 w-full justify-center"
                      onClick={() => handleBuy(pack)}
                      disabled={!canManage || buyingPack !== null}
                    >
                      {buyingPack === pack.id ? "Opening…" : "Buy now"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recent activity */}
        <div className="mt-6 border-t border-[rgba(17,24,39,0.08)] pt-5">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-[#5b6472]" />
            <h3 className="text-base font-semibold text-[#111827]">
              Recent Mink credit activity
            </h3>
          </div>
          {data.ledger.length === 0 ? (
            <p className="mt-3 text-sm text-[#5b6472]">
              No Mink credit activity yet — purchases, grants and spends show up
              here.
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-[rgba(17,24,39,0.06)]">
              {data.ledger.map((entry) => {
                const meta = KIND_META[entry.kind];
                return (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between py-3"
                  >
                    <div className="flex items-center gap-3">
                      <meta.Icon className={`h-4 w-4 ${meta.tone}`} />
                      <div>
                        <div className="text-sm font-medium text-[#344054]">
                          {meta.label}
                          {entry.note ? (
                            <span className="ml-2 text-xs font-normal text-[#5b6472]">
                              {entry.note}
                            </span>
                          ) : null}
                        </div>
                        <div className="text-xs text-[#5b6472]">
                          {formatDateTime(entry.created_at)}
                        </div>
                      </div>
                    </div>
                    <span
                      className={`text-sm font-semibold ${
                        entry.delta > 0 ? "text-green-600" : "text-[#5b6472]"
                      }`}
                    >
                      {entry.delta > 0 ? `+${entry.delta}` : entry.delta}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* ─────────────── 3. Available plans ─────────────── */}
      <section
        id="available-plans"
        className="rounded-xl border border-[rgba(17,24,39,0.08)] bg-white p-6 shadow-sm"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-[#111827]">
              Available plans
            </h2>
            <p className="mt-1 text-sm text-[#5b6472]">
              Pick the plan that fits your business. Yearly billing saves ~2
              months.
            </p>
          </div>
          <div className="inline-flex items-center rounded-full bg-[#f1f3f5] p-1 text-sm font-medium">
            {(["monthly", "yearly"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className={`rounded-full px-4 py-1.5 capitalize transition-colors ${
                  period === p
                    ? "bg-indigo-600 text-white shadow-sm"
                    : "text-[#5b6472]"
                }`}
              >
                {p}
                {p === "yearly" && (
                  <span className="ml-1.5 text-[11px] font-semibold text-amber-600">
                    SAVE
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {PLAN_IDS.map((p) => {
            const meta = PLAN_META[p];
            // Same tier on the other billing cycle is a real plan change. The
            // old card disabled it, even though the server supports it.
            const isCurrent =
              p === plan &&
              (p === "free" || period === (subscription.period ?? "monthly"));
            const isUpgrade = PLAN_RANK[p] > PLAN_RANK[plan];
            const p_ = pricing[p];
            // The headline is ALWAYS per month so the two tabs compare like
            // for like; the annual total is spelled out below rather than
            // hidden until checkout.
            const perMonth =
              period === "yearly"
                ? Math.round(p_.yearlyInr / 12)
                : p_.monthlyInr;
            const billed = period === "yearly" ? p_.yearlyInr : p_.monthlyInr;
            return (
              <div
                key={p}
                className={`relative flex flex-col rounded-xl border p-5 ${
                  isCurrent
                    ? "border-green-300 bg-green-50/40 ring-1 ring-green-200"
                    : "border-[rgba(17,24,39,0.1)]"
                }`}
              >
                {isCurrent && (
                  <span className="absolute right-4 top-4 rounded-full bg-green-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                    Current
                  </span>
                )}
                <div className="text-base font-bold text-[#111827]">
                  {meta.name}
                </div>
                <div className="mt-1 text-2xl font-bold text-[#111827]">
                  {perMonth === 0 ? (
                    "₹0"
                  ) : (
                    <>
                      ₹{perMonth.toLocaleString("en-IN")}
                      <span className="text-sm font-medium text-[#5b6472]">
                        /month
                      </span>
                    </>
                  )}
                </div>
                {billed === 0 && (
                  <p className="mt-0.5 text-xs text-[#5b6472]">Free forever</p>
                )}
                <p className="mt-1 text-xs text-[#5b6472]">{meta.tagline}</p>

                <ul className="mt-4 flex-1 space-y-2">
                  {planFeatures(p, includedCredits).map((f) => (
                    <li
                      key={f}
                      className="flex items-start gap-2 text-sm text-[#344054]"
                    >
                      <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600" />
                      {f}
                    </li>
                  ))}
                </ul>

                <div className="mt-5">
                  {isCurrent ? (
                    <button
                      type="button"
                      disabled
                      className="dash-btn w-full justify-center opacity-60"
                    >
                      Current plan
                    </button>
                  ) : isUpgrade ? (
                    <button
                      type="button"
                      className="dash-btn dash-btn-primary w-full justify-center"
                      onClick={() => setUpgradeTo(p)}
                    >
                      Upgrade to {meta.name}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="dash-btn w-full justify-center"
                      onClick={() => setUpgradeTo(p)}
                    >
                      Switch to {meta.name}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {upgradeTo && (
        <UpgradeModal
          plan={upgradeTo}
          period={period}
          purchasesAvailable={data.purchasesAvailable}
          hasActiveSubscription={subscription.active}
          onClose={() => setUpgradeTo(null)}
          onActivated={() => {
            setUpgradeTo(null);
            refresh();
          }}
          pricing={pricing}
          packs={packs}
          currentPlan={plan}
          currentPeriod={subscription.period ?? "monthly"}
          hasAutopay={subscription.autopay}
        />
      )}
    </div>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-[#9ca3af]">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-semibold text-[#111827]">{children}</dd>
    </div>
  );
}

function StatusPill({
  status,
}: {
  status: { label: string; tone: "green" | "amber" | "gray" };
}) {
  const tone =
    status.tone === "green"
      ? "bg-green-50 text-green-700"
      : status.tone === "amber"
        ? "bg-amber-50 text-amber-700"
        : "bg-gray-100 text-gray-600";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}
    >
      {status.label}
    </span>
  );
}

// Upgrade flow, three branches:
//   • free → paid (no subscription): authorise a fresh autopay mandate.
//   • paid → higher paid (active subscription): change the plan on the same
//     mandate, either NOW (prorated) or at the next renewal.
//   • no self-serve path available: fall back to contacting support.
function UpgradeModal({
  plan,
  period,
  purchasesAvailable,
  hasActiveSubscription,
  onClose,
  onActivated,
  pricing,
  packs,
  currentPlan,
  currentPeriod,
  hasAutopay,
}: {
  plan: Plan;
  period: "monthly" | "yearly";
  purchasesAvailable: boolean;
  hasActiveSubscription: boolean;
  onClose: () => void;
  onActivated: () => void;
  pricing: PlanPricing;
  packs: CreditPack[];
  currentPlan: Plan;
  currentPeriod: "monthly" | "yearly";
  hasAutopay: boolean;
}) {
  const [stage, setStage] = useState<1 | 2 | 3>(1);
  const [selectedPlan, setSelectedPlan] = useState<Plan>(plan);
  const [selectedPeriod, setSelectedPeriod] = useState<"monthly" | "yearly">(
    period,
  );
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // ★ Only ever a REQUEST, and only ever the sideways move to card. The server
  // derives the rail from the charge; "upi" here means "no override".
  const [mandateMethod, setMandateMethod] = useState<MandateMethod>("upi");
  const meta = PLAN_META[selectedPlan];
  const selectedPack = packs.find((pack) => pack.id === selectedPackId) ?? null;
  const price =
    selectedPeriod === "yearly"
      ? pricing[selectedPlan].yearlyInr
      : pricing[selectedPlan].monthlyInr;
  // ⚠ An ESTIMATE: it cannot see tax, so with GST on it can read a shade low
  // near the limit. The server decides authoritatively and reports `autopay`
  // back, which is what the toast below corrects from — this only chooses which
  // explanation to show before the call.
  const autopayPossible = autopayRailFor(price * 100) !== null;

  // No live mandate yet (free, or an operator-granted paid plan) → start a
  // fresh subscription for the target plan. An existing active subscription →
  // change the plan on that same mandate (now / at renewal).
  // Predicts what the server will decide, so the button can say which one it
  // is. The SERVER is authoritative (lib/payments/plan-change.ts) and compares
  // against what the merchant actually pays, which for a grandfathered
  // subscriber can differ from the catalog price used here — in which case
  // they simply get the gentler outcome than the button promised.
  const currentAmount =
    currentPeriod === "yearly"
      ? pricing[currentPlan].yearlyInr
      : pricing[currentPlan].monthlyInr;
  const targetAmount =
    selectedPeriod === "yearly"
      ? pricing[selectedPlan].yearlyInr
      : pricing[selectedPlan].monthlyInr;
  const dearer = targetAmount > currentAmount;

  const isPlanChange = hasActiveSubscription && purchasesAvailable;
  const isNewSubscription =
    selectedPlan !== "free" && !hasActiveSubscription && purchasesAvailable;

  // ★ THE NEW BILLING SYSTEM (§34). The first cycle is a one-time ORDER paid on
  // session, not a Razorpay Subscription — StoreMink computes the amount and the
  // gateway only collects it, so a later price change needs nothing updated at
  // the provider. See docs/billing-architecture.md §2.
  async function buySelectedCredits() {
    if (!selectedPack) {
      setWorking(false);
      onActivated();
      return;
    }

    setWorking(true);

    const start = await startCreditPurchase(selectedPack.id);
    if ("error" in start) {
      setWorking(false);
      toast.info(
        `Your plan change is complete, but the credit top-up could not start: ${start.error}`,
      );
      onActivated();
      return;
    }
    const opened = await openRazorpayModal({
      keyId: start.keyId,
      rzpOrderId: start.rzpOrderId,
      amountPaise: start.amountPaise,
      name: "StoreMink",
      description: `${selectedPack.credits} Mink credits — one-time purchase`,
      onSuccess: async (res) => {
        const confirmed = await confirmCreditPurchase(
          start.purchaseId,
          res.razorpay_payment_id,
          res.razorpay_signature,
        );
        setWorking(false);
        if (confirmed.error) {
          toast.info(
            "The credit payment was received and is being reconciled. Don't pay again.",
          );
        } else {
          toast.success(`${confirmed.creditsAdded} Mink credits added.`);
        }
        onActivated();
      },
      onDismiss: () => {
        setWorking(false);
        toast.info(
          "Your plan change is complete. The optional AI-credit purchase was cancelled.",
        );
        onActivated();
      },
    });
    if (!opened) {
      setWorking(false);
      toast.info(
        "Your plan change is complete, but the AI-credit payment window could not open.",
      );
      onActivated();
    }
  }

  async function subscribe() {
    setWorking(true);
    const start = await startSubscribe(
      selectedPlan,
      selectedPeriod,
      mandateMethod,
    );
    if (!start.ok) {
      toast.error(start.error);
      setWorking(false);
      return;
    }
    if (!start.autopay && autopayPossible) {
      // ★ The client's estimate cannot see tax, so it can read a shade low near
      // the ₹15,000 limit. The SERVER is authoritative; correct the screen
      // rather than opening a Checkout the merchant misreads as autopay.
      toast.info(
        "This plan is above the automatic-debit limit, so renewals will be invoiced.",
      );
    } else if (start.autopay && start.mandateMethod !== mandateMethod) {
      // ★ A payment window left open earlier is resumed rather than replaced
      // (that is what stops a duplicate charge), and its rail was fixed when
      // that order was created. Say so instead of opening a Checkout that
      // quietly contradicts the choice just made.
      toast.info(
        start.mandateMethod === "upi"
          ? "Resuming your earlier UPI Autopay authorisation."
          : "Resuming your earlier card authorisation.",
      );
    }
    const opened = await openRazorpayModal({
      keyId: start.keyId,
      rzpOrderId: start.providerOrderId,
      amountPaise: start.amountPaise,
      // ★★ OMITTED WHEN THERE IS NO MANDATE. `openRazorpayModal` sends
      // `recurring: true` alongside a customer id, and asking Checkout to treat
      // a plain one-time order as recurring is exactly the mismatch that showed
      // a Cards-only screen. No mandate, no recurring binding.
      customerId: start.autopay ? start.providerCustomerId : undefined,
      name: "StoreMink",
      description: `${meta.name} plan — first ${selectedPeriod === "yearly" ? "year" : "month"}`,
      onSuccess: async (res) => {
        const confirmed = await confirmSubscribe(
          start.invoiceId,
          res.razorpay_payment_id,
          res.razorpay_signature,
        );
        setWorking(false);
        if (!confirmed.ok) {
          // ★ Deliberately NOT an error toast. confirmSubscribe already
          // distinguishes "money in but plan not moved" from a decline, and its
          // message says not to pay again — surfacing it verbatim is the point.
          toast.info(confirmed.error);
        } else if (confirmed.autopay) {
          toast.success(`You're on the ${meta.name} plan!`);
        } else {
          // ⚠ Say so plainly. Without a mandate the next cycle needs paying by
          // hand, and a merchant who assumes autopay will simply be downgraded.
          toast.success(
            `You're on the ${meta.name} plan. Autopay isn't set up yet, so we'll ask you to pay each renewal.`,
          );
        }
        if (!confirmed.ok) {
          onActivated();
        } else {
          await buySelectedCredits();
        }
      },
      onDismiss: () => {
        setWorking(false);
        toast.error("Payment wasn't completed.");
      },
    });
    if (!opened) {
      setWorking(false);
      toast.error("Couldn't open the payment window. Please try again.");
    }
  }

  async function doChange() {
    setWorking(true);
    // No `when` — the server derives it from the direction of the change.
    // Offering "switch now" on a downgrade looks helpful and is the option
    // that triggers a refund of money already paid.
    const res = await changeMyPlan(selectedPlan, selectedPeriod);
    if (!res.ok) {
      setWorking(false);
      toast.error(res.error);
      return;
    }

    // Cheaper or equal: booked for the cycle end, nothing to pay.
    if (!res.payment) {
      setWorking(false);
      toast.success(res.message);
      await buySelectedCredits();
      return;
    }

    // ★ Dearer: the part period is charged NOW, on the same one-off checkout as
    // enrolment and location purchases.
    const opened = await openRazorpayModal({
      keyId: res.payment.keyId,
      rzpOrderId: res.payment.providerOrderId,
      amountPaise: res.payment.amountPaise,
      name: "StoreMink",
      description: `${meta.name} plan — part period`,
      onSuccess: async (r) => {
        const done = await confirmMyPlanChange(
          res.payment!.invoiceId,
          selectedPlan,
          selectedPeriod,
          r.razorpay_payment_id,
          r.razorpay_signature,
        );
        setWorking(false);
        if (!done.ok) {
          // Money may have moved — never "failed" (§26's rule).
          toast.info(done.error);
        } else {
          toast.success(`You're on ${meta.name}.`);
        }
        if (!done.ok) {
          onActivated();
        } else {
          await buySelectedCredits();
        }
      },
      onDismiss: () => {
        setWorking(false);
        toast.error("Payment wasn't completed.");
      },
    });
    if (!opened) {
      setWorking(false);
      toast.error("Couldn't open the payment window. Please try again.");
    }
  }

  const steps = ["Choose plan", "Mink credits", "Review & pay"];
  const recurringLabel = selectedPeriod === "yearly" ? "year" : "month";

  return (
    <Dialog open onOpenChange={(open) => !open && !working && onClose()}>
      <DialogContent
        showCloseButton={!working}
        className="max-h-[calc(100dvh-1rem)] gap-0 overflow-hidden p-0 sm:max-w-5xl"
      >
        <div className="border-b border-[#e5e7eb] bg-[#111827] px-6 py-5 text-white">
          <DialogTitle className="text-xl font-semibold text-white">
            Purchase subscription
          </DialogTitle>
          <DialogDescription className="mt-1 text-sm text-white/70">
            Review every recurring and one-time charge before opening Razorpay.
          </DialogDescription>
        </div>

        <ol className="grid grid-cols-3 border-b border-[#e5e7eb] bg-white px-4 py-4 sm:px-7">
          {steps.map((label, index) => {
            const number = (index + 1) as 1 | 2 | 3;
            const complete = stage > number;
            const current = stage === number;
            return (
              <li
                key={label}
                aria-current={current ? "step" : undefined}
                className={`flex min-w-0 items-center gap-2 text-xs font-semibold sm:text-sm ${
                  complete
                    ? "text-green-600"
                    : current
                      ? "text-indigo-700"
                      : "text-[#9ca3af]"
                }`}
              >
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                    complete
                      ? "bg-green-600 text-white"
                      : current
                        ? "bg-indigo-700 text-white"
                        : "bg-[#f3f4f6]"
                  }`}
                >
                  {complete ? <Check className="h-4 w-4" /> : number}
                </span>
                <span className="truncate">{label}</span>
              </li>
            );
          })}
        </ol>

        <div className="grid min-h-0 overflow-y-auto bg-[#f8fafc] md:grid-cols-[minmax(0,1fr)_320px]">
          <div className="p-5 sm:p-7">
            {stage === 1 && (
              <div>
                <h3 className="text-lg font-semibold text-[#111827]">
                  Choose a plan and billing cycle
                </h3>
                <div className="mt-4 inline-flex rounded-lg border border-[#d1d5db] bg-white p-1">
                  {(["yearly", "monthly"] as const).map((candidate) => (
                    <button
                      key={candidate}
                      type="button"
                      onClick={() => setSelectedPeriod(candidate)}
                      className={`rounded-md px-4 py-2 text-sm font-semibold capitalize ${
                        selectedPeriod === candidate
                          ? "bg-indigo-700 text-white"
                          : "text-[#5b6472]"
                      }`}
                    >
                      {candidate}
                    </button>
                  ))}
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-3">
                  {PLAN_IDS.map((candidate) => {
                    const amount =
                      selectedPeriod === "yearly"
                        ? pricing[candidate].yearlyInr
                        : pricing[candidate].monthlyInr;
                    const selected = candidate === selectedPlan;
                    const current =
                      candidate === currentPlan &&
                      (candidate === "free" ||
                        selectedPeriod === currentPeriod);
                    return (
                      <button
                        key={candidate}
                        type="button"
                        onClick={() => {
                          if (!current) {
                            setSelectedPlan(candidate);
                            if (candidate === "free") setSelectedPackId(null);
                          }
                        }}
                        disabled={current}
                        className={`rounded-xl border bg-white p-4 text-left transition ${
                          selected
                            ? "border-indigo-700 ring-2 ring-indigo-100"
                            : "border-[#e5e7eb] hover:border-indigo-300"
                        } disabled:cursor-not-allowed disabled:bg-green-50/60`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-[#111827]">
                            {PLAN_META[candidate].name}
                          </span>
                          {current && (
                            <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                              Current
                            </span>
                          )}
                        </div>
                        <div className="mt-2 text-xl font-bold text-[#111827]">
                          {amount === 0
                            ? "Free"
                            : `₹${amount.toLocaleString("en-IN")}`}
                        </div>
                        <div className="mt-1 text-xs text-[#5b6472]">
                          {amount === 0
                            ? "No recurring charge"
                            : `Billed every ${recurringLabel}`}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {stage === 2 && (
              <div>
                <h3 className="text-lg font-semibold text-[#111827]">
                  Optional Mink credits
                </h3>
                <p className="mt-1 text-sm text-[#5b6472]">
                  Mink credits are a one-time purchase, never renew, and never
                  expire. They use a separate payment and invoice from your
                  plan.
                </p>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setSelectedPackId(null)}
                    className={`rounded-xl border bg-white p-4 text-left ${
                      selectedPackId === null
                        ? "border-indigo-700 ring-2 ring-indigo-100"
                        : "border-[#e5e7eb]"
                    }`}
                  >
                    <span className="font-semibold text-[#111827]">
                      No top-up
                    </span>
                    <p className="mt-1 text-xs text-[#5b6472]">
                      Continue with the plan allowance.
                    </p>
                  </button>
                  {packs.map((pack) => (
                    <button
                      key={pack.id}
                      type="button"
                      onClick={() => setSelectedPackId(pack.id)}
                      className={`relative rounded-xl border bg-white p-4 text-left ${
                        selectedPackId === pack.id
                          ? "border-indigo-700 ring-2 ring-indigo-100"
                          : "border-[#e5e7eb]"
                      }`}
                    >
                      {pack.popular && (
                        <span className="absolute right-3 top-3 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">
                          Popular
                        </span>
                      )}
                      <span className="font-semibold text-[#111827]">
                        {pack.credits} credits
                      </span>
                      <p className="mt-1 text-sm font-semibold text-[#111827]">
                        ₹{pack.priceInr.toLocaleString("en-IN")} once
                      </p>
                      <p className="mt-1 text-xs text-[#5b6472]">
                        {pack.name} pack · never expires
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {stage === 3 && (
              <div>
                <h3 className="text-lg font-semibold text-[#111827]">
                  Review before payment
                </h3>
                <div className="mt-5 divide-y divide-[#e5e7eb] rounded-xl border border-[#e5e7eb] bg-white px-5">
                  <div className="flex justify-between gap-4 py-4 text-sm">
                    <span className="text-[#5b6472]">Current plan</span>
                    <span className="font-semibold text-[#111827]">
                      {PLAN_META[currentPlan].name}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4 py-4 text-sm">
                    <span className="text-[#5b6472]">New plan</span>
                    <span className="font-semibold text-[#111827]">
                      {meta.name} · {selectedPeriod}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4 py-4 text-sm">
                    <span className="text-[#5b6472]">AI-credit add-on</span>
                    <span className="text-right font-semibold text-[#111827]">
                      {selectedPack
                        ? `${selectedPack.credits} credits · ₹${selectedPack.priceInr.toLocaleString("en-IN")} once`
                        : "None"}
                    </span>
                  </div>
                </div>
                {/* ★★ THE AMOUNT PICKS THE RAIL, NOT THE MERCHANT. Razorpay
                    fixes the rail on the ORDER and it cannot be edited after,
                    so a merchant who picked one their renewal cannot carry had
                    authorised a mandate that would never fire — with nothing
                    telling them. RBI's AFA-exempt limit is ₹15,000 on cards AND
                    UPI alike, so above it no supported rail can auto-debit at
                    all and we ask for no mandate rather than a ceiling we could
                    never exercise. */}
                {autopayPossible ? (
                  <div className="mt-5 rounded-xl border border-[#e5e7eb] bg-white p-4">
                    <p className="text-sm font-semibold text-[#111827]">
                      Renewals are charged by UPI Autopay
                    </p>
                    <p className="mt-1 text-xs leading-5 text-[#5b6472]">
                      You approve a mandate once in your UPI app; no card
                      details are stored. The first payment is taken now.
                    </p>
                    {/* ★ The escape hatch. Checkout shows only the rail on the
                        order, so a merchant with no UPI app would otherwise be
                        unable to subscribe at all. */}
                    <button
                      type="button"
                      onClick={() =>
                        setMandateMethod(
                          mandateMethod === "card" ? "upi" : "card",
                        )
                      }
                      className="mt-2 text-xs font-semibold text-[#4f39f6] underline underline-offset-2"
                    >
                      {mandateMethod === "card"
                        ? "Use UPI Autopay instead"
                        : "Pay by card instead"}
                    </button>
                    {mandateMethod === "card" && (
                      <p className="mt-2 text-xs leading-5 text-[#5b6472]">
                        Your card will be saved under RBI e-mandate rules.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
                    <p className="text-sm font-semibold text-amber-900">
                      Renewals for this plan are invoiced
                    </p>
                    <p className="mt-1 text-xs leading-5 text-amber-900">
                      Indian rules cap automatic debits at ₹15,000 per charge on
                      both cards and UPI, and this plan is above that. You pay
                      today&rsquo;s amount now; before each renewal we email you
                      an invoice with a payment link. Nothing is auto-debited,
                      so nothing lapses without you deciding.
                    </p>
                  </div>
                )}
                {selectedPack && (
                  <div className="mt-4 rounded-lg border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-900">
                    Two secure payment windows will open: the subscription
                    first, then the optional one-time credit top-up. Cancelling
                    the second does not undo the plan purchase.
                  </div>
                )}
              </div>
            )}
          </div>

          <aside className="border-t border-[#e5e7eb] bg-white p-5 md:border-l md:border-t-0 sm:p-6">
            <h3 className="font-semibold text-[#111827]">Summary</h3>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-[#5b6472]">Plan</dt>
                <dd className="font-semibold text-[#111827]">{meta.name}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-[#5b6472]">Billing</dt>
                <dd className="font-semibold capitalize text-[#111827]">
                  {selectedPeriod}
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-t border-[#e5e7eb] pt-3">
                <dt className="font-semibold text-[#111827]">
                  Advertised plan price
                </dt>
                <dd className="text-lg font-bold text-[#111827]">
                  {price === 0 ? "Free" : `₹${price.toLocaleString("en-IN")}`}
                </dd>
              </div>
            </dl>
            <p className="mt-3 text-xs leading-5 text-[#5b6472]">
              StoreMink calculates the exact prorated amount, account credit and
              configured tax on the server. Razorpay shows that final amount
              before you authorise payment.
            </p>
            <div className="mt-4 rounded-lg bg-green-50 p-3 text-xs leading-5 text-green-800">
              <Lock className="mr-1 inline h-3.5 w-3.5" />
              {isNewSubscription
                ? "Autopay is offered when the mandate and billing contact are eligible; otherwise renewal stays manual."
                : hasAutopay
                  ? "Your authorised mandate remains attached. Charges outside its limits require manual approval."
                  : "This subscription currently renews manually. This change does not pretend autopay is active."}
            </div>

            <div className="mt-6 space-y-2">
              {stage < 3 ? (
                <button
                  type="button"
                  onClick={() => setStage((stage + 1) as 2 | 3)}
                  disabled={stage === 1 && selectedPlan === currentPlan}
                  className="dash-btn dash-btn-primary w-full justify-center"
                >
                  {stage === 1 ? "Continue to Mink credits" : "Review purchase"}
                </button>
              ) : isNewSubscription ? (
                <button
                  type="button"
                  onClick={subscribe}
                  disabled={working}
                  className="dash-btn dash-btn-primary w-full justify-center"
                >
                  {working ? "Opening secure payment…" : "Continue to payment"}
                </button>
              ) : isPlanChange ? (
                <button
                  type="button"
                  onClick={doChange}
                  disabled={working}
                  className="dash-btn dash-btn-primary w-full justify-center"
                >
                  {working
                    ? "Preparing…"
                    : dearer
                      ? "Pay prorated change"
                      : "Schedule at renewal"}
                </button>
              ) : (
                <a
                  href="mailto:support@storemink.com?subject=Change%20my%20plan"
                  className="dash-btn dash-btn-primary w-full justify-center"
                >
                  Contact support
                </a>
              )}
              {stage > 1 && !working && (
                <button
                  type="button"
                  onClick={() => setStage((stage - 1) as 1 | 2)}
                  className="dash-btn w-full justify-center"
                >
                  Back
                </button>
              )}
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  );
}
