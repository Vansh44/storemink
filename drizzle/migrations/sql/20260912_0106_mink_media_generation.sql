-- Phase 9E: let Mink create an image, not only place one it was given.
--
-- 9D gave the model a Media Library it can read and refuses any storefront URL
-- that is not in it. That closes the safety question and leaves the supply one:
-- a merchant with no photographs still has nothing to put in a hero, so
-- "redesign my homepage" produces a layout whose best block cannot be filled.
-- This adds one charged, immutable private proposal that IS an image.
--
-- ★★ THE GATE IS ON THE GENERATION, NOT ON A WRITE, which inverts every other
-- entry in `mink_action_tool_access`. Everywhere else the write is the
-- expensive, irreversible half, so the gate sits on the action. Here the write
-- is a private Media Library row and the PROVIDER CALL is what spends real
-- per-image money, so a gate on the save would leave the only thing worth
-- switching off ungated.
--
-- ★ AND THERE IS NO APPROVAL OR AUDIT ROW, so neither tool_check, neither
-- resource_type allowlist and neither target check moves. Saving a generated
-- image is 9D's own "Save to Media Library" button behind `media:manage`: a
-- library row changes nothing a shopper can see, and 9D's ownership guard means
-- the only route from that table onto a live page is a layout proposal the
-- merchant separately approves. A second five-minute approval here would guard
-- a boundary that is already guarded and teach merchants to click through one.
--
-- ⚠ THE VOCABULARIES BELOW WERE ENUMERATED BY QUERYING FOR AN EXISTING MEMBER,
-- never by listing the tables one expects -- 0070's lesson, repeated by 0101
-- and 0103:
--   select conrelid::regclass, conname from pg_constraint
--    where pg_get_constraintdef(oid) like '%apply_storefront_design%'
--       or pg_get_constraintdef(oid) like '%storefront_design%';
-- which returns EIGHT constraints across four tables. Six of them name tools or
-- resource types this phase never writes, so exactly two move.

-- 1. The tool vocabulary.
ALTER TABLE public.mink_action_tool_access
  DROP CONSTRAINT IF EXISTS mink_action_tool_access_name_check;
ALTER TABLE public.mink_action_tool_access
  ADD CONSTRAINT mink_action_tool_access_name_check CHECK (
    tool_name = ANY (ARRAY[
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign',
      'bulk_update_prices', 'create_offer', 'update_offer', 'activate_offer',
      'apply_storefront_code', 'publish_storefront_code',
      'apply_storefront_layout', 'apply_storefront_design',
      'generate_media_image'
    ]::text[])
  );

-- 2. The draft kind.
ALTER TABLE public.mink_drafts
  DROP CONSTRAINT IF EXISTS mink_drafts_kind_check;
ALTER TABLE public.mink_drafts
  ADD CONSTRAINT mink_drafts_kind_check CHECK (
    kind = ANY (ARRAY[
      'product_description', 'product_seo', 'blog', 'coupon_email',
      'customer_message', 'product_create', 'coupon_create', 'coupon_update',
      'customer_group_create', 'customer_group_update', 'inventory_adjustment',
      'bulk_inventory_adjustment', 'order_status_transition',
      'bulk_price_update', 'offer_create', 'offer_update', 'offer_activate',
      'storefront_custom_code', 'storefront_layout', 'storefront_design',
      'media_image'
    ]::text[])
  );

-- 3. The generated image's own shape.
--
--    ⚠⚠ EVERY jsonb_typeof IS COALESCED. A CHECK is SATISFIED when it evaluates
--    to NULL, and `content_json -> 'url'` is SQL NULL when the key is ABSENT --
--    so `jsonb_typeof(NULL) = 'string'` is NULL and the whole constraint passes
--    a row missing the very field it exists to require. Fifth recorded instance
--    (0062, 0064, 0101, 0103); the mistake is that the bare spelling reads as
--    correct.
--
--    ★ `url` AND `storage_path` ARE BOTH REQUIRED, AND THAT PAIR IS THE POINT.
--    The save writes `media_assets.url` verbatim and 9D's ownership check
--    trusts that column completely, so the application re-proves the path sits
--    under this store's prefix and that the url ends with it. The database
--    cannot check that relationship cheaply; it can at least refuse a row that
--    carries only one half of it.
ALTER TABLE public.mink_drafts
  DROP CONSTRAINT IF EXISTS mink_drafts_media_image_target_check;
ALTER TABLE public.mink_drafts
  ADD CONSTRAINT mink_drafts_media_image_target_check CHECK (
    kind <> 'media_image' OR (
      destination_type = 'media_asset'
      -- No destination_id: the Media Library row does not exist yet, and the
      -- proposal is what a merchant turns into one.
      AND destination_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND coalesce(jsonb_typeof(content_json -> 'url'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'storage_path'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'filename'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'content_type'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'size_bytes'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'purpose'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'prompt'), '') = 'string'
      -- ★ ALT TEXT IS REQUIRED BY THE DATABASE, not only by the contract.
      --   Proposal time is the only moment anything in this product asks for
      --   it, so a stored image without one can never acquire one.
      AND coalesce(jsonb_typeof(content_json -> 'alt'), '') = 'string'
    )
  );

-- 4. Backfill for stores that already have Mink on.
--
--    ★ TRUE, matching 0091's all-or-nothing operator switch and 0101/0103's
--    backfills. A tool that skipped this would be dark until somebody
--    re-toggled Mink, and `assertToolEnabled` reports that as "support has not
--    enabled this feature" -- indistinguishable from an operator decision.
--    ⚠ The spend ceiling is therefore NOT this row: it is
--    `reserveMinkImageGeneration`, which fails closed at 3 per owner per
--    minute, 10 per store per hour, 25 per store per day, 200 globally per hour
--    and 2 per run, before any provider call is made.
INSERT INTO public.mink_action_tool_access
  (store_id, tool_name, enabled, enabled_by, enabled_at, updated_at)
SELECT a.store_id, 'generate_media_image', true, a.invited_by, now(), now()
FROM public.mink_store_access a
WHERE a.enabled = true
ON CONFLICT (store_id, tool_name) DO UPDATE
SET enabled = true, updated_at = now();
