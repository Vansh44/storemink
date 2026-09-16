import { redirect } from "next/navigation";
import {
  getExtraLocationPricingLive,
  getPlanPricingLive,
} from "@/lib/plans/pricing";
import { PricingPanel } from "../pricing-panel";
import { getMinkCreditPacksLive } from "@/lib/ai/credit-pricing";
import { getPlanAllowancesLive } from "@/lib/plans/allowances";
import { getMinkConfig } from "@/lib/mink/config";
import { canManage, requireOperator } from "../require-operator";

export const metadata = { title: "Pricing — StoreMink Admin" };

// What StoreMink charges.
//
// Superadmin-only and its own route: this used to sit below the store table on
// the home page, which put "reprice the Pro plan for every merchant" one
// mis-click away from "look at a store". Repricing is rare, deliberate, and
// affects every future subscription — it belongs somewhere you have to go.
export default async function PricingPage() {
  const viewer = await requireOperator();
  if (!canManage(viewer)) redirect("/dashboard");

  const [pricing, extraLocation, minkCreditPacks, minkAllowances] =
    await Promise.all([
      getPlanPricingLive(),
      getExtraLocationPricingLive(),
      getMinkCreditPacksLive(),
      // Live, like the prices beside it: the panel is about to write these
      // back, so showing a cached value would let an operator overwrite a
      // change somebody else made inside the revalidation window.
      getPlanAllowancesLive(),
    ]);

  return (
    <div className="w-full max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
          Pricing
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Plan prices, the extra-location add-on, included Mink credits and
          top-up packs. Existing subscribers keep the plan price they
          authorised; an allowance change reaches every store on that plan.
        </p>
      </header>

      <PricingPanel
        pricing={pricing}
        extraLocation={extraLocation}
        minkCreditPacks={minkCreditPacks}
        minkAllowances={minkAllowances}
        minkChargesCredits={getMinkConfig().chargeCredits}
      />
    </div>
  );
}
