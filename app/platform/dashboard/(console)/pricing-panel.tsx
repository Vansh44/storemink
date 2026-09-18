"use client";

import { useState, useTransition } from "react";
import {
  saveMinkCreditPacks,
  savePlanCreditAllowances,
  savePlanPricing,
  type PlanPriceInput,
} from "@/app/actions/platform";
// The KEY comes from the pure module: lib/plans/pricing.ts is `server-only`, so
// importing a runtime value from it into this client component fails the build
// (the TYPES are fine — they are erased).
import {
  EXTRA_LOCATION_KEY,
  PLAN_IDS,
  PLAN_META,
  type IncludedMinkCredits,
  type PlanAllowanceOverrides,
} from "@/lib/plans";
import type { ExtraLocationPricing, PlanPricing } from "@/lib/plans/pricing";
import {
  CREDIT_PACK_LIMITS,
  validateCreditPacks,
  type CreditPack,
} from "@/lib/ai/credits";

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
  minkAllowances,
  minkDefaultCredits,
}: {
  pricing: PlanPricing;
  extraLocation: ExtraLocationPricing;
  minkCreditPacks: CreditPack[];
  minkAllowances: PlanAllowanceOverrides;
  /** What each plan grants with no override, so the field is never set blind. */
  minkDefaultCredits: IncludedMinkCredits;
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
      <MinkCreditAllowances
        allowances={minkAllowances}
        defaults={minkDefaultCredits}
      />
      <MinkCreditPacks packs={minkCreditPacks} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Included Mink credits per plan — the one plan LIMIT an operator can move
// without a deploy. ONE number per plan: what is typed here IS the allowance.
// ---------------------------------------------------------------------------
function MinkCreditAllowances({
  allowances,
  defaults,
}: {
  allowances: PlanAllowanceOverrides;
  /** What the plan grants with no override, so the number is never set blind. */
  defaults: IncludedMinkCredits;
}) {
  const [rows, setRows] = useState(() =>
    PLAN_IDS.map((plan) => ({
      plan,
      includedCredits: String(allowances[plan] ?? defaults[plan] ?? ""),
    })),
  );
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [pending, start] = useTransition();

  const save = () => {
    start(async () => {
      const result = await savePlanCreditAllowances(
        rows.map((row) => ({
          plan: row.plan,
          includedCredits: Number(row.includedCredits || 0),
        })),
      );
      setMsg(
        result.error
          ? { error: result.error }
          : { ok: "Included Mink credits updated." },
      );
    });
  };

  return (
    <section className="stq-card">
      <header className="mb-4">
        <h2 className="text-lg font-bold">Included Mink credits</h2>
        <p className="text-sm text-[var(--stq-muted)]">
          What each plan grants every 30 days, before any top-up pack. Applies
          to every store on that plan at its next request —{" "}
          <b>including stores already subscribed</b>, unlike a price change.
        </p>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[var(--stq-muted)]">
              <th className="py-2 pr-4 font-medium">Plan</th>
              <th className="py-2 pr-4 font-medium">Credits per 30 days</th>
              <th className="py-2 font-medium">Default</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.plan} className="border-t border-[var(--stq-line)]">
                <td className="py-3 pr-4 font-semibold">
                  {PLAN_META[row.plan].name}
                </td>
                <td className="py-3 pr-4">
                  <input
                    className="stq-input w-28"
                    inputMode="numeric"
                    value={row.includedCredits}
                    onChange={(event) => {
                      const value = event.target.value.replace(/[^\d]/g, "");
                      setRows((current) =>
                        current.map((r) =>
                          r.plan === row.plan
                            ? { ...r, includedCredits: value }
                            : r,
                        ),
                      );
                      setMsg({});
                    }}
                    aria-label={`${row.plan} included Mink credits`}
                  />
                </td>
                <td className="py-3 text-[var(--stq-muted)]">
                  {defaults[row.plan] ?? "unlimited"}
                </td>
              </tr>
            ))}
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
          {pending ? "Saving…" : "Save included credits"}
        </button>
        {msg.ok && (
          <span className="text-sm text-[var(--stq-ok)]">{msg.ok}</span>
        )}
        {msg.error && (
          <span className="text-sm text-[var(--stq-bad)]">{msg.error}</span>
        )}
      </div>
      <p className="mt-3 text-xs text-[var(--stq-muted)]">
        A balance is not topped up retroactively: raising an allowance gives
        every store on that plan the higher cap from its current 30-day window,
        and lowering one can leave a store already over the new cap until the
        window turns.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The credit-pack catalogue. Everything is the operator's: name, size, price,
// which pack is highlighted, the order, and how many packs exist.
//
// ★ ONE SAVE FOR THE WHOLE LIST. Reconciling server-side means a reorder, a
// rename, a new pack and a removal all commit together, so a merchant never
// sees a half-applied catalogue. The row order IS the display order.
// ---------------------------------------------------------------------------
type PackRow = {
  id: string;
  name: string;
  credits: string;
  priceInr: string;
  popular: boolean;
};

function MinkCreditPacks({ packs }: { packs: CreditPack[] }) {
  const [rows, setRows] = useState<PackRow[]>(() =>
    packs.map((pack) => ({
      id: pack.id,
      name: pack.name,
      credits: String(pack.credits),
      priceInr: String(pack.priceInr),
      popular: pack.popular === true,
    })),
  );
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [pending, start] = useTransition();

  const patch = (index: number, next: Partial<PackRow>) => {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...next } : row)),
    );
    setMsg({});
  };

  const move = (index: number, delta: number) => {
    setRows((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
    setMsg({});
  };

  const addPack = () => {
    setRows((current) => [
      ...current,
      {
        // A fresh id, never a name-derived one: the id lands on
        // ai_credit_purchases.pack_id and must stay stable across renames.
        id: crypto.randomUUID(),
        name: "",
        credits: "",
        priceInr: "",
        popular: false,
      },
    ]);
    setMsg({});
  };

  const removePack = (index: number) => {
    setRows((current) => current.filter((_, i) => i !== index));
    setMsg({});
  };

  // Only one pack may be highlighted; selecting one clears the rest so the
  // form cannot submit a state the database would refuse.
  const setPopular = (index: number) => {
    setRows((current) =>
      current.map((row, i) => ({ ...row, popular: i === index })),
    );
    setMsg({});
  };

  const asPacks = (): CreditPack[] =>
    rows.map((row) => ({
      id: row.id,
      name: row.name.trim(),
      credits: Number(row.credits || 0),
      priceInr: Number(row.priceInr || 0),
      popular: row.popular,
    }));

  const problems = validateCreditPacks(asPacks());

  const save = () => {
    // The same validator the action runs, so the form can never submit
    // something the server then refuses in front of the operator.
    if (problems.length) {
      const first = problems[0];
      setMsg({
        error:
          first.index >= 0
            ? `Pack ${first.index + 1}: ${first.message}`
            : first.message,
      });
      return;
    }
    start(async () => {
      const result = await saveMinkCreditPacks(
        asPacks().map((pack) => ({ ...pack, popular: pack.popular === true })),
      );
      setMsg(
        result.error
          ? { error: result.error }
          : { ok: "Credit packs updated." },
      );
    });
  };

  return (
    <section className="stq-card">
      <header className="mb-4">
        <h2 className="text-lg font-bold">Mink credit top-ups</h2>
        <p className="text-sm text-[var(--stq-muted)]">
          The packs every store can buy once its included credits run out. Size,
          price, order and the highlighted pack are all yours; add or remove as
          many as you need.
        </p>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[var(--stq-muted)]">
              <th className="py-2 pr-4 font-medium">Order</th>
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Credits</th>
              <th className="py-2 pr-4 font-medium">Price (₹)</th>
              <th className="py-2 pr-4 font-medium">Highlighted</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id} className="border-t border-[var(--stq-line)]">
                <td className="py-3 pr-4">
                  <span className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      className="stq-btn px-2 py-1 disabled:opacity-30"
                      aria-label={`Move ${row.name || "pack"} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={index === rows.length - 1}
                      className="stq-btn px-2 py-1 disabled:opacity-30"
                      aria-label={`Move ${row.name || "pack"} down`}
                    >
                      ↓
                    </button>
                  </span>
                </td>
                <td className="py-3 pr-4">
                  <input
                    className="stq-input w-36"
                    value={row.name}
                    maxLength={CREDIT_PACK_LIMITS.nameMaxLength}
                    onChange={(event) =>
                      patch(index, { name: event.target.value })
                    }
                    aria-label={`Pack ${index + 1} name`}
                  />
                </td>
                <td className="py-3 pr-4">
                  <input
                    className="stq-input w-24"
                    inputMode="numeric"
                    value={row.credits}
                    onChange={(event) =>
                      patch(index, {
                        credits: event.target.value.replace(/[^\d]/g, ""),
                      })
                    }
                    aria-label={`Pack ${index + 1} credits`}
                  />
                </td>
                <td className="py-3 pr-4">
                  <input
                    className="stq-input w-24"
                    inputMode="numeric"
                    value={row.priceInr}
                    onChange={(event) =>
                      patch(index, {
                        priceInr: event.target.value.replace(/[^\d]/g, ""),
                      })
                    }
                    aria-label={`Pack ${index + 1} price`}
                  />
                </td>
                <td className="py-3 pr-4">
                  {/* A radio, not a checkbox: one slot, and the group makes
                      that visible rather than relying on a save-time refusal. */}
                  <input
                    type="radio"
                    name="mink-pack-popular"
                    checked={row.popular}
                    onChange={() => setPopular(index)}
                    aria-label={`Highlight pack ${index + 1}`}
                  />
                </td>
                <td className="py-3">
                  <button
                    type="button"
                    onClick={() => removePack(index)}
                    disabled={rows.length === 1}
                    title={
                      rows.length === 1
                        ? "Keep at least one pack — a store with none cannot top up."
                        : undefined
                    }
                    className="stq-btn px-2 py-1 text-[var(--stq-bad)] disabled:opacity-30"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={addPack}
          disabled={rows.length >= CREDIT_PACK_LIMITS.maxPacks}
          className="stq-btn"
        >
          Add pack
        </button>
        <button
          type="button"
          onClick={save}
          disabled={pending}
          className="stq-btn stq-btn-primary"
        >
          {pending ? "Saving…" : "Save credit packs"}
        </button>
        {msg.ok && (
          <span className="text-sm text-[var(--stq-ok)]">{msg.ok}</span>
        )}
        {msg.error && (
          <span className="text-sm text-[var(--stq-bad)]">{msg.error}</span>
        )}
      </div>
      <p className="mt-3 text-xs text-[var(--stq-muted)]">
        Removing a pack does not affect past purchases — an order records the
        credits and the amount it was sold for, so history and balances are
        untouched. A merchant mid-purchase on a removed pack is asked to pick
        again.
      </p>
    </section>
  );
}
