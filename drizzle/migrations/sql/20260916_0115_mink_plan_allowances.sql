-- Let a platform operator set the included Mink credits each plan grants.
--
-- The tier list, every other limit and the CODE DEFAULT stay in lib/plans.ts:
-- this table holds overrides only, exactly like plan_prices. Deliberately NOT
-- seeded — an empty table has to behave identically to the constants, so this
-- migration cannot change a single store's allowance, and a later change to the
-- compiled-in defaults still reaches every plan nobody has overridden.
--
-- TWO NUMBERS PER PLAN, because MINK_CHARGE_CREDITS switches between them
-- (lib/plans.ts aiAllowanceFor). generations_per_month is sized for ~Rs 0.90
-- product descriptions and is what is in force today; credits_per_month is the
-- larger allowance that must land in the SAME change as the charge, or a Free
-- store gets one question a month. Storing only the live one would make the
-- other half unreachable at the moment it starts being enforced.
CREATE TABLE IF NOT EXISTS public.mink_plan_allowances (
  plan text PRIMARY KEY,
  generations_per_month integer NOT NULL,
  credits_per_month integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT mink_plan_allowances_plan_check
    CHECK (plan IN ('free', 'basic', 'pro')),
  CONSTRAINT mink_plan_allowances_generations_check
    CHECK (generations_per_month > 0 AND generations_per_month <= 100000),
  CONSTRAINT mink_plan_allowances_credits_check
    CHECK (credits_per_month > 0 AND credits_per_month <= 100000)
);

-- Service-only, the plan_prices/store_counters posture: an allowance row is
-- platform policy, and app_user has no business reading or writing one.
ALTER TABLE public.mink_plan_allowances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mink_plan_allowances FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mink_plan_allowances TO app_service;
