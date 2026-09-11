-- Charge a Mink conversation the credits its measured size says it cost.
--
-- Read work has never been billed: `charged_credits` on the usage ledger only
-- ever carried what a Phase 3+ proposal reserved for itself, and the shadow
-- meter's number was a placeholder. This installs the mechanism; whether it
-- actually spends is a separate runtime switch (MINK_CHARGE_CREDITS, default
-- off), so applying this migration changes nothing a merchant experiences.
--
-- ★★ THE SAME POOL AS A PRODUCT DESCRIPTION. Credits come from the monthly
-- plan allowance (ai_usage) first and the purchased balance
-- (ai_credit_balances) second — the expiring resource before the permanent
-- one, exactly as lib/ai/quota.ts and consume_mink_draft_credits already do.
-- One currency, so "AI credits" and "Mink credits" cannot drift apart.

alter table public.mink_usage_ledger
  add column if not exists credit_source text,
  add column if not exists plan_credits integer not null default 0,
  add column if not exists balance_credits integer not null default 0;

alter table public.mink_usage_ledger
  drop constraint if exists mink_usage_ledger_credit_source_check;

-- `null` is the load-bearing value: it means this run has not been settled, and
-- it is what makes the charge idempotent under a retry. 'none' records a
-- settled run that owed nothing, which is NOT the same fact.
alter table public.mink_usage_ledger
  add constraint mink_usage_ledger_credit_source_check
  check (
    credit_source is null
    or credit_source in ('none', 'plan', 'credit', 'mixed', 'plan_unlimited', 'short')
  );

alter table public.mink_usage_ledger
  drop constraint if exists mink_usage_ledger_credit_split_check;

alter table public.mink_usage_ledger
  add constraint mink_usage_ledger_credit_split_check
  check (
    plan_credits >= 0
    and balance_credits >= 0
    and plan_credits + balance_credits <= charged_credits
  );

comment on column public.mink_usage_ledger.credit_source is
  'Where this run''s credits came from. NULL = not settled yet, which is what makes settlement idempotent; ''none'' = settled and owed nothing; ''short'' = the store could not cover the full amount and was charged what remained.';

/**
 * Settle one completed run, atomically, exactly once.
 *
 * ★ IT CLAMPS RATHER THAN REFUSING. The draft function returns 'insufficient'
 * and the caller deletes the proposal — correct there, because nothing has been
 * delivered yet. Here the merchant has already read the answer, so refusing
 * would mean either taking back a reply or failing a request that succeeded.
 * A store that cannot cover the full amount is charged what it has left and
 * recorded 'short'; the next run is refused up front instead.
 *
 * ★ THE CLAMP IS INSIDE THE STATEMENT THAT SPENDS. Reading headroom in the
 * application and then spending it is a check-then-act race: two runs settling
 * together would both see the same balance and overdraw it past the
 * ai_credit_balances CHECK.
 */
CREATE OR REPLACE FUNCTION public.consume_mink_run_credits(
  p_store UUID,
  p_admin TEXT,
  p_run UUID,
  p_period TEXT,
  p_plan_cap INTEGER,
  p_credits INTEGER
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  existing_source TEXT;
  used_now INTEGER;
  balance_now INTEGER;
  plan_part INTEGER;
  balance_part INTEGER;
  wanted INTEGER;
  result_source TEXT;
BEGIN
  IF p_credits < 0 OR p_credits > 20 OR (p_plan_cap IS NOT NULL AND p_plan_cap < 0) THEN
    RAISE EXCEPTION 'invalid Mink run credit request';
  END IF;

  -- Locking the ledger row makes a concurrent retry wait rather than
  -- double-charge, and the join is the tenancy boundary: a run that is not
  -- this store's and this admin's cannot be settled at all.
  SELECT ledger.credit_source INTO existing_source
  FROM public.mink_usage_ledger AS ledger
  JOIN public.mink_runs AS run
    ON run.id = ledger.run_id AND run.store_id = ledger.store_id
  WHERE ledger.run_id = p_run
    AND ledger.store_id = p_store
    AND ledger.admin_id = p_admin
    AND run.requested_by = p_admin
  FOR UPDATE OF ledger;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Mink run credit scope rejected';
  END IF;
  IF existing_source IS NOT NULL THEN
    RETURN existing_source;
  END IF;

  IF p_credits = 0 THEN
    UPDATE public.mink_usage_ledger
    SET credit_source = 'none'
    WHERE run_id = p_run;
    RETURN 'none';
  END IF;

  IF p_plan_cap IS NULL THEN
    UPDATE public.mink_usage_ledger
    SET credit_source = 'plan_unlimited'
    WHERE run_id = p_run;
    RETURN 'plan_unlimited';
  END IF;

  INSERT INTO public.ai_usage (store_id, period, used)
  VALUES (p_store, p_period, 0)
  ON CONFLICT (store_id, period) DO NOTHING;
  SELECT used INTO used_now
  FROM public.ai_usage
  WHERE store_id = p_store AND period = p_period
  FOR UPDATE;

  INSERT INTO public.ai_credit_balances (store_id, balance)
  VALUES (p_store, 0)
  ON CONFLICT (store_id) DO NOTHING;
  SELECT balance INTO balance_now
  FROM public.ai_credit_balances
  WHERE store_id = p_store
  FOR UPDATE;

  plan_part := LEAST(p_credits, GREATEST(p_plan_cap - used_now, 0));
  -- Clamp, never refuse: the answer has already been delivered.
  balance_part := LEAST(p_credits - plan_part, GREATEST(balance_now, 0));
  wanted := p_credits;

  IF plan_part > 0 THEN
    UPDATE public.ai_usage
    SET used = used + plan_part
    WHERE store_id = p_store AND period = p_period;
  END IF;
  IF balance_part > 0 THEN
    UPDATE public.ai_credit_balances
    SET balance = balance - balance_part, updated_at = now()
    WHERE store_id = p_store;
    INSERT INTO public.ai_credit_ledger (store_id, delta, kind, ref, note)
    VALUES (
      p_store,
      -balance_part,
      'spend',
      'mink-run:' || p_run::text,
      'Mink AI conversation'
    );
  END IF;

  result_source := CASE
    WHEN plan_part + balance_part < wanted THEN 'short'
    WHEN plan_part > 0 AND balance_part > 0 THEN 'mixed'
    WHEN balance_part > 0 THEN 'credit'
    WHEN plan_part > 0 THEN 'plan'
    ELSE 'short'
  END;

  UPDATE public.mink_usage_ledger
  SET charged_credits = charged_credits + plan_part + balance_part,
      plan_credits = plan_part,
      balance_credits = balance_part,
      credit_source = result_source
  WHERE run_id = p_run;
  RETURN result_source;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_mink_run_credits(
  UUID, TEXT, UUID, TEXT, INTEGER, INTEGER
) FROM PUBLIC, app_user;
GRANT EXECUTE ON FUNCTION public.consume_mink_run_credits(
  UUID, TEXT, UUID, TEXT, INTEGER, INTEGER
) TO app_service;
