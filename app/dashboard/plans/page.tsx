import { requireSectionAccess } from "../lib/access";
import { getAiUsagePageData } from "@/app/actions/ai-credit-actions";
import {
  getMySubscription,
  getPayableInvoices,
} from "@/app/actions/subscribe-actions";
import { getMinkCreditPacksLive } from "@/lib/ai/credit-pricing";
import { getPlanPricingLive } from "@/lib/plans/pricing";
import { getPlanAllowancesLive } from "@/lib/plans/allowances";
import { getMinkConfig } from "@/lib/mink/config";
import { PLAN_META, includedMinkCredits, normalizePlan } from "@/lib/plans";
import { PlansBillingClient } from "./plans-client";
import { OpenInvoices } from "./open-invoices";
import { CompActiveNotice, CompOfferCard } from "./comp-offer";

export const metadata = { title: "Plans & Billing" };

// Permission section is still "ai" (the credit/AI actions gate on it) — only the
// nav label + route changed to "Plans & Billing".
export default async function PlansBillingPage() {
  const access = await requireSectionAccess("ai", "view");
  // LIVE, not the cached read: this page quotes a price and then charges it.
  // Reading through a cache a reprice had not yet reached would show one number
  // in the upgrade dialog and take a different one from the card.
  const [data, subscription, pricing, invoices, packs, allowances] =
    await Promise.all([
      getAiUsagePageData(),
      getMySubscription(),
      getPlanPricingLive(),
      // ★ What they OWE, above everything else on the page. Manual collection is
      // still required for amounts above the AFA limit, revoked mandates and
      // provider incidents, so burying it would downgrade merchants who never
      // knew there was a bill.
      getPayableInvoices(),
      getMinkCreditPacksLive(),
      getPlanAllowancesLive(),
    ]);
  const includedCredits = includedMinkCredits(
    allowances,
    getMinkConfig().chargeCredits,
  );
  const canManage = access.can("ai", "manage");
  const paidPlanName = PLAN_META[normalizePlan(data.paidPlan)].name;
  return (
    <div className="space-y-6">
      <OpenInvoices invoices={invoices} canManage={canManage} />
      {/* A comped plan is a gift, not a bill — it sits below what they OWE and
          above the rest of the page. Offer and active state are mutually
          exclusive (docs/comped-plans-spec.md). */}
      {data.compActive ? (
        <CompActiveNotice comp={data.compActive} paidPlanName={paidPlanName} />
      ) : data.compOffer ? (
        <CompOfferCard
          offer={data.compOffer}
          currentPlanName={paidPlanName}
          canManage={canManage}
        />
      ) : null}
      <PlansBillingClient
        initialData={data}
        subscription={subscription}
        packs={packs}
        canManage={canManage}
        pricing={pricing}
        includedCredits={includedCredits}
      />
    </div>
  );
}
