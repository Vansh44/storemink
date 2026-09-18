-- Two operator-facing simplifications, both EXPAND-ONLY.
--
-- ⚠ 0114 and 0115 are APPLIED (merged to main and dev on 2026-09-16), so
-- neither can be edited — their checksums are recorded and the runner would
-- refuse every later migration. Cloud Run also serves the old and new revision
-- against ONE database for the length of a rollout, so nothing here drops,
-- renames or tightens a column the deployed revision still reads and writes.
-- The matching CONTRACT migration (dropping mink_plan_allowances' two legacy
-- columns and the whole mink_credit_pack_prices table) is a follow-up, once no
-- revision reading them is left running. See docs/migrations.md.

-- ── 1. ONE allowance number per plan ───────────────────────────────────────
--
-- 0115 stored two (generations_per_month / credits_per_month) because
-- MINK_CHARGE_CREDITS switches between the compiled-in defaults. Operators
-- asked for one number, which is also the clearer contract: a value set here
-- IS the plan's allowance, in both modes. Plans with no row keep the code
-- ladder, so the "one switch raises the allowance and starts the charge
-- together" rule still holds everywhere an operator has not intervened.
--
-- Nullable on purpose: NOT NULL with no default is refused by the linter for
-- good reason — the DEPLOYED revision does not know this column exists and
-- would fail every insert it makes during the rollout.
ALTER TABLE public.mink_plan_allowances
  ADD COLUMN IF NOT EXISTS included_credits integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mink_plan_allowances_included_check'
      AND conrelid = 'public.mink_plan_allowances'::regclass
  ) THEN
    ALTER TABLE public.mink_plan_allowances
      ADD CONSTRAINT mink_plan_allowances_included_check
      CHECK (
        included_credits IS NULL
        OR (included_credits > 0 AND included_credits <= 100000)
      );
  END IF;
END $$;

-- Carry any allowance an operator already set. MINK_CHARGE_CREDITS is opt-IN
-- and unset in every environment, so generations_per_month is the column the
-- quota gate is really reading today — copying the other one would silently
-- change what those stores are allowed.
UPDATE public.mink_plan_allowances
SET included_credits = generations_per_month
WHERE included_credits IS NULL;

-- ── 2. A credit-pack catalogue an operator owns outright ───────────────────
--
-- 0114's mink_credit_pack_prices could only reprice three ids fixed in code.
-- Name, size, price, the highlighted pack and the order are all editable now,
-- and an operator can add or remove packs.
--
-- ★ SAFE BECAUSE A PURCHASE SNAPSHOTS WHAT IT SOLD. ai_credit_purchases stores
-- `credits` and `amount_inr` at checkout and confirmCreditPurchase grants from
-- that row, never by re-reading the pack — so editing or deleting a pack can
-- never change what a completed or in-flight purchase granted or charged.
-- `pack_id` is plain text with no foreign key, so history stays readable too.
CREATE TABLE IF NOT EXISTS public.mink_credit_packs (
  id text PRIMARY KEY,
  name text NOT NULL,
  credits integer NOT NULL,
  price_inr integer NOT NULL,
  popular boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT mink_credit_packs_name_check
    CHECK (btrim(name) <> '' AND length(name) <= 40),
  CONSTRAINT mink_credit_packs_credits_check
    CHECK (credits > 0 AND credits <= 1000000),
  CONSTRAINT mink_credit_packs_price_check
    CHECK (price_inr > 0 AND price_inr <= 500000)
);

-- At most one highlighted pack, enforced by the database rather than by the
-- save action alone: "popular" is a single slot, and two rows claiming it
-- renders two highlighted cards with no way to tell which the operator meant.
CREATE UNIQUE INDEX IF NOT EXISTS mink_credit_packs_one_popular_idx
  ON public.mink_credit_packs (popular)
  WHERE popular;

ALTER TABLE public.mink_credit_packs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mink_credit_packs FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mink_credit_packs TO app_service;

-- SEEDED, unlike the allowance table: this one OWNS the catalogue, so an empty
-- table means no top-ups at all. The seed reproduces today's three packs and
-- takes each price from mink_credit_pack_prices when an operator has already
-- changed it, so no merchant sees a price move on deploy.
INSERT INTO public.mink_credit_packs
  (id, name, credits, price_inr, popular, sort_order)
SELECT
  d.id,
  d.name,
  d.credits,
  coalesce(p.price_inr, d.price_inr),
  d.popular,
  d.sort_order
FROM (
  VALUES
    ('small', 'Small', 25, 59, false, 0),
    ('popular', 'Popular', 60, 129, true, 1),
    ('bulk', 'Bulk', 150, 299, false, 2)
) AS d (id, name, credits, price_inr, popular, sort_order)
LEFT JOIN public.mink_credit_pack_prices AS p ON p.pack_id = d.id
ON CONFLICT (id) DO NOTHING;
