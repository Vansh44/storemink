-- Record the initial prompt a run re-sent on every later step, so the credit
-- band can remove repeated platform overhead without removing the merchant's
-- own message, memory or conversation context from the charge.
--
-- The system prompt plus the permission-filtered tool declarations run to
-- ~92,700 characters for a superadmin with drafting enabled, and every model
-- turn re-sends all of it. Measured on this table: single-step runs report
-- 16,542-17,072 input tokens, so a question answered with ONE tool call
-- accumulated ~35,000 prompt tokens even when its message and result were
-- tiny. That pushed it into the 3-credit band and left the 1-credit band
-- unreachable for any run that touched a tool.
--
-- DEFAULT 0 is the "unknown" value on purpose: every existing row keeps its
-- current band, because a reader that sees 0 charges the whole prompt exactly
-- as it did before. Nothing is repriced retroactively in either direction.

ALTER TABLE public.mink_usage_ledger
  ADD COLUMN IF NOT EXISTS base_prompt_tokens integer NOT NULL DEFAULT 0;

ALTER TABLE public.mink_usage_ledger
  DROP CONSTRAINT IF EXISTS mink_usage_ledger_base_prompt_tokens_check;

-- The same shape as the cached_tokens check beside it: a subset of the prompt
-- total, never negative. A value above input_tokens could only mean the two
-- were measured against different runs, and it would make the subtraction in
-- weightedMinkUnits meaningless rather than merely wrong.
ALTER TABLE public.mink_usage_ledger
  ADD CONSTRAINT mink_usage_ledger_base_prompt_tokens_check
  CHECK (base_prompt_tokens >= 0 AND base_prompt_tokens <= input_tokens);
