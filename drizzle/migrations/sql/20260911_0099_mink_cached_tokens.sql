-- Record how many prompt tokens the provider served from a context cache.
--
-- The Mink system prompt plus its tool declarations are a deterministic prefix
-- re-sent on every step of every run, and it is the largest single cost line:
-- measured across the ledger it grew from 7,089 to 11,154 tokens per step as
-- tool registry versions v9 → v16 shipped, because a declaration is charged on
-- every turn whether or not the model calls it.
--
-- Whether a cache is actually serving that prefix is invisible today, so the
-- shadow cost has been billing every prompt token at the full input rate. This
-- stores the provider's own count as a RAW FACT next to the derived cost:
-- estimated_cost_microusd can then be recomputed for any historical row if the
-- assumed cached-rate multiplier (lib/mink/cost.ts) turns out to be wrong.
--
-- Additive and defaulted, so the revision being replaced keeps inserting rows
-- without it and reads 0 — which is exactly what it was implicitly assuming.

alter table public.mink_usage_ledger
  add column if not exists cached_tokens integer not null default 0;

alter table public.mink_usage_ledger
  drop constraint if exists mink_usage_ledger_cached_tokens_check;

-- Cached tokens are a SUBSET of input_tokens, never an addition: the provider
-- documents promptTokenCount as already including cached content. A row where
-- the two disagree is a mis-read, and it would understate cost rather than
-- overstate it, so the database refuses it instead of storing it.
alter table public.mink_usage_ledger
  add constraint mink_usage_ledger_cached_tokens_check
  check (cached_tokens >= 0 and cached_tokens <= input_tokens);

comment on column public.mink_usage_ledger.cached_tokens is
  'Prompt tokens served from a provider context cache. A SUBSET of input_tokens, not an addition. Stored raw so any row can be repriced when the cached-rate assumption in lib/mink/cost.ts changes.';
