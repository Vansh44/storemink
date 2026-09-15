"use client";

import { useState, useTransition } from "react";
import {
  saveMinkCreditPackPricing,
  savePlanPricing,
  type PlanPriceInput,
} from "@/app/actions/platform";
// The KEY comes from the pure module: lib/plans/pricing.ts is `server-only`, so
// importing a runtime value from it into this client component fails the build
// (the TYPES are fine — they are erased).
import { EXTRA_LOCATION_KEY } from "@/lib/plans";
import type { ExtraLocationPricing, PlanPricing } from "@/lib/plans/pricing";
import type { CreditPack } from "@/lib/ai/credits";

// ---------------------------------------------------------------------------
// Plan pricing, editable by a platform superadmin.
//
// Two prices per plan. `Charged` is what a merchant actually pays and what
// Razorpay bills. `Was` is the struck-through list price on the pricing page —
// display only, never charged, blank when no offer is running.
//
// The save action re-validates everything server-side; the checks here exist
// to give an answer before a round trip, not instead of one.
// ---------------------------------------------------------------------------

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

type Row = {
  plan: string;
  monthlyInr: string;
  yearlyInr: string;
  baseMonthlyInr: string;
  baseYearlyInr: string;
};

/** Rows the merchant can subscribe to, then the metered add-on. The add-on is
 *  kept LAST and labelled, because it is priced here but is not a tier — it has
 *  no pricing card and therefore no struck-through "Was" price. */
function toRows(
  pricing: PlanPricing,
  extraLocation: ExtraLocationPricing,
): Row[] {
  const tiers = Object.entries(pricing).map(([plan, p]) => ({
    plan,
    monthlyInr: String(p.monthlyInr),
    yearlyInr: String(p.yearlyInr),
    baseMonthlyInr: p.baseMonthlyInr === null ? "" : String(p.baseMonthlyInr),
    baseYearlyInr: p.baseYearlyInr === null ? "" : String(p.baseYearlyInr),
  }));
  return [
    ...tiers,
    {
      plan: EXTRA_LOCATION_KEY,
      monthlyInr: String(extraLocation.monthlyInr),
      yearlyInr: String(extraLocation.yearlyInr),
      baseMonthlyInr: "",
      baseYearlyInr: "",
    },
  ];
}

const ROW_LABEL: Record<string, string> = {
  [EXTRA_LOCATION_KEY]: "Extra POS location",
};

export function PricingPanel({
  pricing,
  extraLocation,
  minkCreditPacks,
}: {
  pricing: PlanPricing;
  extraLocation: ExtraLocationPricing;
  minkCreditPacks: CreditPack[];
}) {
  const [rows, setRows] = useState<Row[]>(() => toRows(pricing, extraLocation));
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [pending, start] = useTransition();

  const set = (plan: string, key: keyof Row, value: string) => {
    // Digits only — a stray "₹" or a comma would fail server validation with a
    // less useful message than simply not accepting the character.
    const clean = value.replace(/[^\d]/g, "");
    setRows((r) =>
      r.map((x) => (x.plan === plan ? { ...x, [key]: clean } : x)),
    );
    setMsg({});
  };

  const save = () => {
    const payload: PlanPriceInput[] = rows.map((r) => ({
      plan: r.plan,
      monthlyInr: Number(r.monthlyInr || 0),
      yearlyInr: Number(r.yearlyInr || 0),
      baseMonthlyInr: r.baseMonthlyInr === "" ? null : Number(r.baseMonthlyInr),
      baseYearlyInr: r.baseYearlyInr === "" ? null : Number(r.baseYearlyInr),
    }));
    start(async () => {
      const res = await savePlanPricing(payload);
      setMsg(res.error ? { error: res.error } : { ok: "Pricing updated." });
    });
  };

  return (
    <div className="space-y-6">
      <section className="stq-card">
        <header className="mb-4">
          <h2 className="text-lg font-bold">Plan pricing</h2>
          <p className="text-sm text-[var(--stq-muted)]">
            Changes show on the pricing page immediately.{" "}
            <b>Anyone already subscribed keeps the price they signed up at</b> —
            a new price creates a new Razorpay plan and never reprices a live
            mandate.
          </p>
        </header>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--stq-muted)]">
                <th className="py-2 pr-4 font-medium">Plan</th>
                <th className="py-2 pr-4 font-medium">Charged / month</th>
                <th className="py-2 pr-4 font-medium">Charged / year</th>
                <th className="py-2 pr-4 font-medium">Was / month</th>
                <th className="py-2 pr-4 font-medium">Was / year</th>
                <th className="py-2 font-medium">On the page</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const monthly = Number(r.monthlyInr || 0);
                const yearly = Number(r.yearlyInr || 0);
                const perMonth = yearly > 0 ? Math.round(yearly / 12) : 0;
                const isAddon = r.plan === EXTRA_LOCATION_KEY;
                return (
                  <tr
                    key={r.plan}
                    className="border-t border-[var(--stq-line)]"
                  >
                    <td className="py-3 pr-4 font-semibold capitalize">
                      {ROW_LABEL[r.plan] ?? r.plan}
                    </td>
                    {(
                      [
                        "monthlyInr",
                        "yearlyInr",
                        "baseMonthlyInr",
                        "baseYearlyInr",
                      ] as const
                    ).map((key) => (
                      <td className="py-3 pr-4" key={key}>
                        {/* The add-on has no pricing card, so a struck-through
                          price has nowhere to render — offering the field would
                          store a number nobody ever sees. */}
                        {isAddon && key.startsWith("base") ? (
                          <span className="text-[var(--stq-muted)]">—</span>
                        ) : (
                          <input
                            className="stq-input w-28"
                            inputMode="numeric"
                            value={r[key]}
                            placeholder={key.startsWith("base") ? "none" : "0"}
                            onChange={(e) => set(r.plan, key, e.target.value)}
                            aria-label={`${r.plan} ${key}`}
                          />
                        )}
                      </td>
                    ))}
                    <td className="py-3 text-[var(--stq-muted)]">
                      {isAddon ? (
                        <>
                          per location, on top of Pro ·{" "}
                          <b className="text-[var(--stq-ink)]">
                            {inr(monthly)}
                          </b>
                          /mo
                        </>
                      ) : monthly === 0 && yearly === 0 ? (
                        "Free"
                      ) : (
                        <>
                          <b className="text-[var(--stq-ink)]">
                            {inr(perMonth)}
                          </b>
                          /mo on yearly · {inr(monthly)}/mo monthly
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={pending}
            className="stq-btn stq-btn-primary"
          >
            {pending ? "Saving…" : "Save pricing"}
          </button>
          {msg.ok && (
            <span className="text-sm text-[var(--stq-ok)]">{msg.ok}</span>
          )}
          {msg.error && (
            <span className="text-sm text-[var(--stq-bad)]">{msg.error}</span>
          )}
        </div>

        <p className="mt-3 text-xs text-[var(--stq-muted)]">
          Leave a “Was” field blank when no offer is running — the page then
          shows one price with no strike-through. A “Was” price must be at least
          the price you charge.
        </p>
      </section>
      <MinkCreditPricing packs={minkCreditPacks} />
    </div>
  );
}

function MinkCreditPricing({ packs }: { packs: CreditPack[] }) {
  const [prices, setPrices] = useState(() =>
    Object.fromEntries(packs.map((pack) => [pack.id, String(pack.priceInr)])),
  );
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [pending, start] = useTransition();

  const save = () => {
    start(async () => {
      const result = await saveMinkCreditPackPricing(
        packs.map((pack) => ({
          packId: pack.id,
          priceInr: Number(prices[pack.id] || 0),
        })),
      );
      setMsg(
        result.error
          ? { error: result.error }
          : { ok: "Mink credit prices updated." },
      );
    });
  };

  return (
    <section className="stq-card">
      <header className="mb-4">
        <h2 className="text-lg font-bold">Mink credit top-ups</h2>
        <p className="text-sm text-[var(--stq-muted)]">
          These prices apply globally to every store. Pack sizes stay fixed.
        </p>
      </header>
      <div className="grid gap-4 sm:grid-cols-3">
        {packs.map((pack) => (
          <label key={pack.id} className="space-y-2">
            <span className="block text-sm font-semibold">
              {pack.name} · {pack.credits} credits
            </span>
            <span className="flex items-center gap-2">
              <span className="text-sm text-[var(--stq-muted)]">₹</span>
              <input
                className="stq-input w-full"
                inputMode="numeric"
                value={prices[pack.id] ?? ""}
                onChange={(event) => {
                  const value = event.target.value.replace(/[^\d]/g, "");
                  setPrices((current) => ({
                    ...current,
                    [pack.id]: value,
                  }));
                  setMsg({});
                }}
                aria-label={`${pack.name} Mink credit pack price`}
              />
            </span>
          </label>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="stq-btn stq-btn-primary"
        >
          {pending ? "Saving…" : "Save Mink credit prices"}
        </button>
        {msg.ok && (
          <span className="text-sm text-[var(--stq-ok)]">{msg.ok}</span>
        )}
        {msg.error && (
          <span className="text-sm text-[var(--stq-bad)]">{msg.error}</span>
        )}
      </div>
    </section>
  );
}
