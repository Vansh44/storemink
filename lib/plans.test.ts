import { describe, it, expect } from "vitest";
import {
  aiAllowanceFor,
  NO_PLAN_ALLOWANCE_OVERRIDES,
  includedMinkCredits,
  resolvePlanAllowanceOverrides,
  PLAN_IDS,
  PLAN_META,
  PLAN_LIMITS,
  normalizePlan,
  effectivePlan,
  planAllows,
  limitsFor,
  EXPIRY_WARN_DAYS,
  expiryWarnWindow,
  compActive,
  NO_COMP,
} from "./plans";

describe("normalizePlan", () => {
  it("passes known plans through and coerces junk to free", () => {
    expect(normalizePlan("free")).toBe("free");
    expect(normalizePlan("basic")).toBe("basic");
    expect(normalizePlan("pro")).toBe("pro");
    expect(normalizePlan("growth")).toBe("free"); // retired plan id
    expect(normalizePlan(null)).toBe("free");
    expect(normalizePlan(42)).toBe("free");
  });

  it("maps the retired 'starter' id to basic (rollout alias)", () => {
    expect(normalizePlan("starter")).toBe("basic");
  });
});

describe("effectivePlan (timed plans)", () => {
  const now = new Date("2026-07-11T12:00:00.000Z");

  it("no expiry = the stored plan, indefinitely", () => {
    expect(
      effectivePlan(
        {
          plan: "pro",
          plan_expires_at: null,
          comp_plan: null,
          comp_expires_at: null,
        },
        now,
      ),
    ).toBe("pro");
    expect(
      effectivePlan(
        { plan: "basic", comp_plan: null, comp_expires_at: null },
        now,
      ),
    ).toBe("basic");
  });

  it("a future expiry keeps the plan", () => {
    expect(
      effectivePlan(
        {
          plan: "pro",
          plan_expires_at: "2026-08-01T00:00:00.000Z",
          comp_plan: null,
          comp_expires_at: null,
        },
        now,
      ),
    ).toBe("pro");
  });

  it("a past expiry lapses to free", () => {
    expect(
      effectivePlan(
        {
          plan: "pro",
          plan_expires_at: "2026-07-01T00:00:00.000Z",
          comp_plan: null,
          comp_expires_at: null,
        },
        now,
      ),
    ).toBe("free");
  });

  it("expiry exactly now counts as expired", () => {
    expect(
      effectivePlan(
        {
          plan: "basic",
          plan_expires_at: "2026-07-11T12:00:00.000Z",
          comp_plan: null,
          comp_expires_at: null,
        },
        now,
      ),
    ).toBe("free");
  });

  it("accepts Date objects", () => {
    expect(
      effectivePlan(
        {
          plan: "basic",
          plan_expires_at: new Date("2027-01-01"),
          comp_plan: null,
          comp_expires_at: null,
        },
        now,
      ),
    ).toBe("basic");
  });

  it("an unparseable expiry fails open (treated as indefinite)", () => {
    expect(
      effectivePlan(
        {
          plan: "pro",
          plan_expires_at: "not-a-date",
          comp_plan: null,
          comp_expires_at: null,
        },
        now,
      ),
    ).toBe("pro");
  });

  it("normalizes legacy plan ids before checking expiry", () => {
    expect(
      effectivePlan(
        {
          plan: "starter",
          plan_expires_at: "2027-01-01T00:00:00.000Z",
          comp_plan: null,
          comp_expires_at: null,
        },
        now,
      ),
    ).toBe("basic");
    expect(
      effectivePlan(
        {
          plan: "starter",
          plan_expires_at: "2026-01-01T00:00:00.000Z",
          comp_plan: null,
          comp_expires_at: null,
        },
        now,
      ),
    ).toBe("free");
  });
});

describe("effectivePlan — the comped-plan OVERLAY", () => {
  // docs/comped-plans-spec.md. The scenario the design exists for: a store on
  // paid Basic to 10 Sept, handed one free month of Pro on 6 Sept.
  const now = new Date("2026-09-06T12:00:00.000Z");
  const paidBasic = {
    plan: "basic",
    plan_expires_at: "2026-09-10T00:00:00.000Z",
  };

  it("raises to the comped plan while the window is open", () => {
    expect(
      effectivePlan(
        {
          ...paidBasic,
          comp_plan: "pro",
          comp_expires_at: "2026-10-06T12:00:00.000Z",
        },
        now,
      ),
    ).toBe("pro");
  });

  it("★★ FALLS BACK TO THE PAID PLAN WHEN THE COMP ENDS — never to free", () => {
    // THE regression the whole overlay exists to prevent (spec §3.2). The naive
    // design wrote the comp into stores.plan/plan_expires_at, and
    // /api/cron/plan-expiry then flipped any expired non-free plan to
    // `free, null` without ever consulting billing_subscriptions — so a merchant
    // who was PAYING for Basic throughout landed on Free.
    const afterComp = new Date("2026-10-07T00:00:00.000Z");
    expect(
      effectivePlan(
        {
          plan: "basic",
          // Their subscription renewed on 10 Sept and again on 10 Oct.
          plan_expires_at: "2026-11-10T00:00:00.000Z",
          comp_plan: "pro",
          comp_expires_at: "2026-10-06T12:00:00.000Z",
        },
        afterComp,
      ),
    ).toBe("basic");
  });

  it("a comp at or below the paid rank is inert", () => {
    // A gift must never quietly demote someone. Pro subscriber, comped Basic.
    expect(
      effectivePlan(
        {
          plan: "pro",
          plan_expires_at: "2026-12-01T00:00:00.000Z",
          comp_plan: "basic",
          comp_expires_at: "2026-10-06T00:00:00.000Z",
        },
        now,
      ),
    ).toBe("pro");
  });

  it("lifts a FREE store for the window, then drops it back", () => {
    const store = {
      plan: "free",
      plan_expires_at: null,
      comp_plan: "pro",
      comp_expires_at: "2026-10-06T00:00:00.000Z",
    };
    expect(effectivePlan(store, now)).toBe("pro");
    expect(effectivePlan(store, new Date("2026-10-07T00:00:00.000Z"))).toBe(
      "free",
    );
  });

  it("★ ignores a comp with no window — fail CLOSED", () => {
    // The asymmetry is deliberate: junk must never manufacture an entitlement
    // nobody granted, where junk on the PAID side must never strip a payer.
    expect(
      effectivePlan(
        { ...paidBasic, comp_plan: "pro", comp_expires_at: null },
        now,
      ),
    ).toBe("basic");
    expect(
      effectivePlan(
        { ...paidBasic, comp_plan: "pro", comp_expires_at: "not-a-date" },
        now,
      ),
    ).toBe("basic");
  });

  it("★ an unparseable PAID expiry is still indefinite — fail OPEN", () => {
    expect(
      effectivePlan(
        {
          plan: "pro",
          plan_expires_at: "not-a-date",
          comp_plan: null,
          comp_expires_at: null,
        },
        now,
      ),
    ).toBe("pro");
  });

  it("the window is half-open: expiry instant is already over", () => {
    expect(
      effectivePlan(
        {
          plan: "free",
          plan_expires_at: null,
          comp_plan: "pro",
          comp_expires_at: now.toISOString(),
        },
        now,
      ),
    ).toBe("free");
  });

  it("★ INVARIANT 1 — a store with no comp is unchanged", () => {
    // Every existing store is this case. If it ever diverges, the overlay has
    // stopped being additive.
    expect(effectivePlan({ ...paidBasic, ...NO_COMP }, now)).toBe("basic");
    expect(
      effectivePlan(
        { ...paidBasic, ...NO_COMP },
        new Date("2026-09-11T00:00:00.000Z"),
      ),
    ).toBe("free");
  });

  it("compActive names the overlay for UI that must say so out loud", () => {
    expect(
      compActive(
        {
          ...paidBasic,
          comp_plan: "pro",
          comp_expires_at: "2026-10-06T00:00:00.000Z",
        },
        now,
      ),
    ).toBe(true);
    expect(compActive({ ...paidBasic, ...NO_COMP }, now)).toBe(false);
  });
});

describe("planAllows", () => {
  it("no minPlan = available everywhere", () => {
    expect(planAllows("free")).toBe(true);
  });
  it("compares by rank", () => {
    expect(planAllows("free", "basic")).toBe(false);
    expect(planAllows("basic", "basic")).toBe(true);
    expect(planAllows("pro", "basic")).toBe(true);
    expect(planAllows("basic", "pro")).toBe(false);
  });
});

describe("catalog consistency", () => {
  it("every plan has meta and limits", () => {
    for (const id of PLAN_IDS) {
      expect(PLAN_META[id].id).toBe(id);
      expect(PLAN_LIMITS[id]).toBeDefined();
    }
  });

  it("prices match the owner-approved catalog", () => {
    expect(PLAN_META.free.monthlyInr).toBe(0);
    expect(PLAN_META.basic.monthlyInr).toBe(1500);
    expect(PLAN_META.basic.yearlyInr).toBe(15000);
    expect(PLAN_META.pro.monthlyInr).toBe(5000);
    expect(PLAN_META.pro.yearlyInr).toBe(50000);
    expect(PLAN_LIMITS.free.advancedAnalytics).toBe(false);
    expect(PLAN_LIMITS.basic.advancedAnalytics).toBe(false);
    expect(PLAN_LIMITS.pro.advancedAnalytics).toBe(true);
  });

  it("yearly is cheaper than 12× monthly", () => {
    for (const id of ["basic", "pro"] as const) {
      expect(PLAN_META[id].yearlyInr).toBeLessThan(
        PLAN_META[id].monthlyInr * 12,
      );
    }
  });

  it("every plan meters AI (credits top up the monthly allowance)", () => {
    expect(PLAN_LIMITS.free.aiGenerationsPerMonth).toBe(3);
    expect(PLAN_LIMITS.basic.aiGenerationsPerMonth).toBe(10);
    expect(PLAN_LIMITS.pro.aiGenerationsPerMonth).toBe(50);
  });

  describe("aiAllowanceFor", () => {
    it("keeps the legacy caps while Mink conversations are free", () => {
      for (const plan of PLAN_IDS) {
        expect(aiAllowanceFor(plan, false, NO_PLAN_ALLOWANCE_OVERRIDES)).toBe(
          PLAN_LIMITS[plan].aiGenerationsPerMonth,
        );
      }
    });

    it("raises every allowance the moment Mink spends from the same pool", () => {
      // ★ ONE SWITCH FOR BOTH HALVES. Charging against caps sized for ~₹0.90
      // product descriptions would give a Free store a single Mink question a
      // month; raising them without charging is a pure cost increase. Neither
      // half can ship alone, which is what this pins.
      expect(aiAllowanceFor("free", true, NO_PLAN_ALLOWANCE_OVERRIDES)).toBe(
        20,
      );
      expect(aiAllowanceFor("basic", true, NO_PLAN_ALLOWANCE_OVERRIDES)).toBe(
        100,
      );
      expect(aiAllowanceFor("pro", true, NO_PLAN_ALLOWANCE_OVERRIDES)).toBe(
        300,
      );
    });

    it("never lowers an allowance by switching charging on", () => {
      // A merchant must not lose capacity on the day billing starts.
      for (const plan of PLAN_IDS) {
        const before = aiAllowanceFor(plan, false, NO_PLAN_ALLOWANCE_OVERRIDES);
        const after = aiAllowanceFor(plan, true, NO_PLAN_ALLOWANCE_OVERRIDES);
        if (before === null || after === null) continue;
        expect(after).toBeGreaterThanOrEqual(before);
      }
    });

    it("enforces the operator override rather than the compiled-in cap", () => {
      const overrides = resolvePlanAllowanceOverrides([
        { plan: "free", included_credits: 25, generations_per_month: 3 },
      ]);
      // ★ ONE NUMBER: the override IS the allowance, in BOTH modes. That is
      // the whole point of a single column — an operator who types 25 gets 25,
      // not 25 today and something else the day charging is switched on.
      expect(aiAllowanceFor("free", false, overrides)).toBe(25);
      expect(aiAllowanceFor("free", true, overrides)).toBe(25);
      // An untouched plan still resolves to the constant, and the compiled-in
      // ladder still rises with the charging switch there.
      expect(aiAllowanceFor("basic", false, overrides)).toBe(
        PLAN_LIMITS.basic.aiGenerationsPerMonth,
      );
      expect(aiAllowanceFor("basic", true, overrides)).toBe(
        PLAN_LIMITS.basic.aiCreditsPerMonth,
      );
    });
  });

  describe("resolvePlanAllowanceOverrides", () => {
    it("reports no override when nothing is stored", () => {
      expect(resolvePlanAllowanceOverrides([])).toEqual(
        NO_PLAN_ALLOWANCE_OVERRIDES,
      );
    });

    it("falls back to the legacy column for a row written before 0116", () => {
      // ⚠ The revision that predates migration 0116 wrote only
      // generations_per_month, and that is the value in force for such a row.
      // Ignoring it would silently restore the compiled-in cap mid-rollout.
      const resolved = resolvePlanAllowanceOverrides([
        { plan: "pro", included_credits: null, generations_per_month: 60 },
      ]);
      expect(resolved.pro).toBe(60);
    });

    it("prefers the new column when both are present", () => {
      expect(
        resolvePlanAllowanceOverrides([
          { plan: "pro", included_credits: 75, generations_per_month: 60 },
        ]).pro,
      ).toBe(75);
    });

    it("ignores a row for a plan that no longer exists", () => {
      const resolved = resolvePlanAllowanceOverrides([
        { plan: "growth", included_credits: 999, generations_per_month: 999 },
      ]);
      expect(resolved).toEqual(NO_PLAN_ALLOWANCE_OVERRIDES);
      expect(resolved).not.toHaveProperty("growth");
    });

    it("falls back to the constant rather than enforcing a cap of zero", () => {
      // ★ The database CHECKs already refuse these, so reaching one means the
      // row was written around the app. Honouring a 0 would block every AI
      // action on that tier.
      for (const bad of [0, -5, 1.5, Number.NaN]) {
        expect(
          resolvePlanAllowanceOverrides([
            { plan: "pro", included_credits: bad, generations_per_month: null },
          ]).pro,
        ).toBeNull();
      }
    });
  });

  describe("includedMinkCredits", () => {
    it("uses the override for an overridden plan and the ladder otherwise", () => {
      const overrides = resolvePlanAllowanceOverrides([
        { plan: "free", included_credits: 4, generations_per_month: null },
      ]);
      expect(includedMinkCredits(overrides, false).free).toBe(4);
      expect(includedMinkCredits(overrides, true).free).toBe(4);
      expect(includedMinkCredits(overrides, false).basic).toBe(
        PLAN_LIMITS.basic.aiGenerationsPerMonth,
      );
      expect(includedMinkCredits(overrides, true).basic).toBe(
        PLAN_LIMITS.basic.aiCreditsPerMonth,
      );
    });

    it("quotes exactly what aiAllowanceFor enforces", () => {
      // The whole point of the pre-switched map: a display surface and the
      // quota gate must never be able to disagree.
      const overrides = resolvePlanAllowanceOverrides([
        { plan: "basic", included_credits: 12, generations_per_month: null },
      ]);
      for (const charging of [false, true]) {
        const included = includedMinkCredits(overrides, charging);
        for (const plan of PLAN_IDS) {
          expect(included[plan]).toBe(
            aiAllowanceFor(plan, charging, overrides),
          );
        }
      }
    });
  });

  it("online payments are a paid-plan feature (basic+)", () => {
    expect(PLAN_LIMITS.free.onlinePayments).toBe(false);
    expect(PLAN_LIMITS.basic.onlinePayments).toBe(true);
    expect(PLAN_LIMITS.pro.onlinePayments).toBe(true);
  });

  it("matches the published product and feature tiers", () => {
    expect(PLAN_LIMITS.free.maxProducts).toBe(5);
    expect(PLAN_LIMITS.basic.maxProducts).toBe(50);
    expect(PLAN_LIMITS.pro.maxProducts).toBeNull();

    expect(PLAN_LIMITS.free.customDomain).toBe(false);
    expect(PLAN_LIMITS.basic.customDomain).toBe(false);
    expect(PLAN_LIMITS.pro.customDomain).toBe(true);

    expect(PLAN_LIMITS.free.customerBlogSubmissions).toBe(false);
    expect(PLAN_LIMITS.basic.customerBlogSubmissions).toBe(true);
    expect(PLAN_LIMITS.pro.customerBlogSubmissions).toBe(true);

    expect(PLAN_LIMITS.free.aiCreditTopUps).toBe(true);
    expect(PLAN_LIMITS.basic.aiCreditTopUps).toBe(true);
    expect(PLAN_LIMITS.pro.aiCreditTopUps).toBe(true);
  });

  it("limits never shrink as plans go up", () => {
    const cap = (n: number | null) => n ?? Infinity;
    expect(cap(PLAN_LIMITS.basic.maxProducts)).toBeGreaterThan(
      cap(PLAN_LIMITS.free.maxProducts),
    );
    expect(cap(PLAN_LIMITS.pro.maxProducts)).toBeGreaterThanOrEqual(
      cap(PLAN_LIMITS.basic.maxProducts),
    );
    expect(cap(PLAN_LIMITS.pro.aiGenerationsPerMonth)).toBeGreaterThanOrEqual(
      cap(PLAN_LIMITS.basic.aiGenerationsPerMonth),
    );
  });

  it("limitsFor tolerates junk plans", () => {
    expect(limitsFor("bogus")).toEqual(PLAN_LIMITS.free);
    expect(limitsFor("pro").maxProducts).toBeNull();
  });
});

// The value of a "your plan expires soon" warning is that it arrives once per
// horizon. "≤ 7 days away" would re-send it every day for a week; the daily
// cron plus a 24-hour band gives once-only with no state to keep.
describe("expiryWarnWindow", () => {
  const now = new Date("2026-07-27T00:00:00.000Z");
  const at = (iso: string) => {
    // Which horizons would match a plan expiring at `iso`, on a run at `now`.
    return EXPIRY_WARN_DAYS.filter((days) => {
      const { from, to } = expiryWarnWindow(now, days);
      return iso > from && iso <= to;
    });
  };

  it("covers exactly 24 hours per horizon", () => {
    const w = expiryWarnWindow(now, 7);
    expect(w.from).toBe("2026-08-02T00:00:00.000Z"); // now + 6d
    expect(w.to).toBe("2026-08-03T00:00:00.000Z"); // now + 7d
  });

  it("matches a store on exactly one horizon at a time", () => {
    expect(at("2026-08-03T00:00:00.000Z")).toEqual([7]); // 7 days out
    expect(at("2026-07-28T00:00:00.000Z")).toEqual([1]); // 1 day out
  });

  it("does not warn on the days between the horizons", () => {
    expect(at("2026-07-31T12:00:00.000Z")).toEqual([]); // ~4.5 days out
    expect(at("2026-07-29T12:00:00.000Z")).toEqual([]); // ~2.5 days out
  });

  it("does not warn about a plan expiring beyond the furthest horizon", () => {
    expect(at("2026-09-01T00:00:00.000Z")).toEqual([]);
  });

  it("leaves already-expired plans to the downgrade pass", () => {
    // The window is half-open and starts in the FUTURE for the 1-day horizon,
    // so a plan that already lapsed is never picked up as a "warning".
    expect(at("2026-07-26T00:00:00.000Z")).toEqual([]);
    expect(at("2026-07-27T00:00:00.000Z")).toEqual([]); // exactly now
  });

  it("re-warns the same store as it passes each horizon in turn", () => {
    const expiry = "2026-08-03T00:00:00.000Z";
    expect(at(expiry)).toEqual([7]);
    // Six days later the same store is now one day out.
    const later = new Date("2026-08-02T00:00:00.000Z");
    const { from, to } = expiryWarnWindow(later, 1);
    expect(expiry > from && expiry <= to).toBe(true);
  });
});
