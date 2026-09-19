-- Mink draft credits: accept the 30-day cycle period key.
--
-- ★★ 0114 MOVED THE ALLOWANCE KEY AND LEFT THIS CHECK BEHIND, WHICH TOOK EVERY
-- PROPOSAL OFFLINE ON A PAYING STORE. `lib/ai/quota.ts` used to meter against a
-- UTC calendar month ('2026-09') and now anchors paid stores to consecutive
-- 30-day windows ('cycle:2026-09-11T11:37:15.000Z'). 0114 backfilled `ai_usage`
-- — which carries no format check — so conversational metering and run
-- settlement moved over cleanly. `mink_draft_credit_usage` still asserted
-- '^[0-9]{4}-[0-9]{2}$', and `consume_mink_draft_credits` writes the same key
-- into both tables. So the very first proposal a subscribed store attempted
-- after 0114 hit:
--
--   new row for relation "mink_draft_credit_usage" violates check constraint
--   "mink_draft_credit_usage_period_check"
--
-- and the merchant was told only "Mink AI couldn't complete that request."
-- Every Phase 3+ capability charges through this one function, so it was not a
-- degraded corner: storefront layout, storefront design, generated images,
-- blogs, product copy, SEO, coupon emails and customer messages were all dead
-- for exactly the stores that pay for them. A free store, which has no billing
-- cycle to anchor to, kept the calendar key and kept working — which is why it
-- reads as intermittent rather than total.
--
-- ⚠ THE CHARGE IS TRANSACTIONAL, so nothing was left half-written: the draft
-- insert and this charge share one transaction and rolled back together. No
-- credit was spent, and there is no orphaned draft to repair — which is also
-- why this migration has nothing to backfill. The rejected rows never existed.
--
-- ★ WIDENED, NOT DROPPED. The key is produced by one pure function and is never
-- user input, so the check has little left to catch — but it is what documents
-- the two vocabularies in force, and naming both is cheaper than discovering a
-- third one in production. The guard against outgrowing it again is in the
-- application, not here: `lib/ai/quota.test.ts` asserts that every key
-- `minkCreditCycleAt` can emit satisfies this exact expression, so the next
-- format change fails in CI instead of on a merchant's screen.
--
-- Backward compatible: the revision being replaced only ever writes the
-- calendar key, which still passes.

ALTER TABLE public.mink_draft_credit_usage
  DROP CONSTRAINT IF EXISTS mink_draft_credit_usage_period_check;

ALTER TABLE public.mink_draft_credit_usage
  ADD CONSTRAINT mink_draft_credit_usage_period_check CHECK (
    period ~ '^[0-9]{4}-[0-9]{2}$'
    OR period ~ '^cycle:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
  );
