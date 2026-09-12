-- Phase 9B: let Mink propose a page's SECTION LIST, not just its custom code.
--
-- Phase 7B/7C can only replace the HTML/CSS/JS inside one EXISTING custom-code
-- section, so on a store without one Mink can change nothing at all. Everything
-- a merchant means by "make my shop look like this" -- a hero, a gallery,
-- testimonials, reordering the page -- is a structured section and was
-- unreachable. This admits one immutable private proposal for a page's whole
-- section list, behind its own operator gate and its own human approval.
--
-- The write target is 'storefront_page', already allowed by the resource-type
-- allowlist that Phase 7D added; no new resource type is introduced.

-- 1. The tool vocabulary. ⚠ FOUND BY QUERYING pg_constraint FOR AN EXISTING
--    MEMBER, not by listing the tables one expects: migration 0070 widened the
--    three allowlists it could think of and missed mink_action_approvals'
--    own tool_check, so every offer approval was refused until 0071 repaired
--    it. `pg_get_constraintdef(oid) LIKE '%apply_storefront_code%'` returns
--    all of them.
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
      'apply_storefront_layout'
    ]::text[])
  );

ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT IF EXISTS mink_action_approvals_tool_check;
ALTER TABLE public.mink_action_approvals
  ADD CONSTRAINT mink_action_approvals_tool_check CHECK (
    tool_name = ANY (ARRAY[
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign',
      'bulk_update_prices', 'create_offer', 'update_offer', 'activate_offer',
      'apply_storefront_code', 'publish_storefront_code',
      'apply_storefront_layout'
    ]::text[])
  );

ALTER TABLE public.mink_action_audit
  DROP CONSTRAINT IF EXISTS mink_action_audit_tool_check;
ALTER TABLE public.mink_action_audit
  ADD CONSTRAINT mink_action_audit_tool_check CHECK (
    tool_name = ANY (ARRAY[
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign',
      'bulk_update_prices', 'create_offer', 'update_offer', 'activate_offer',
      'apply_storefront_code', 'publish_storefront_code',
      'apply_storefront_layout'
    ]::text[])
  );

-- 1b. ★★ THE FOURTH VOCABULARY, AND THE ONE THE HEADER ABOVE ALMOST MISSED
--     AGAIN. `draft_version_check` requires draft_version > 0 for every tool
--     EXCEPT the two storefront-code ones, because those approve an IMMUTABLE
--     proposal whose only version is 0. A layout proposal is immutable for the
--     same reason, so without this every layout preview insert is refused by
--     the database -- 0070's failure exactly, in a constraint that carries a
--     tool list without saying so in its name.
--     Found by the query the header prescribes:
--       select conrelid::regclass, conname from pg_constraint
--        where pg_get_constraintdef(oid) like '%apply_storefront_code%';
--     which returns EIGHT constraints across three tables. Enumerating the
--     tables by hand returns three.
ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT IF EXISTS mink_action_approvals_draft_version_check;
ALTER TABLE public.mink_action_approvals
  ADD CONSTRAINT mink_action_approvals_draft_version_check CHECK (
    draft_version > 0
    OR (
      tool_name = ANY (ARRAY[
        'apply_storefront_code', 'publish_storefront_code',
        'apply_storefront_layout'
      ]::text[])
      AND draft_version = 0
    )
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
      'storefront_custom_code', 'storefront_layout'
    ]::text[])
  );

-- 3. The layout proposal's own shape.
--    A stored proposal that cannot be executed is worse than one refused at
--    write time, because it has already charged the merchant credits.
--
--    ⚠⚠ EVERY jsonb_typeof IS COALESCED, AND THAT IS THE WHOLE POINT. A CHECK
--    is SATISFIED when it evaluates to NULL. `content_json -> 'sections_json'`
--    is SQL NULL when the key is ABSENT, so `jsonb_typeof(NULL) = 'string'` is
--    NULL, `true AND NULL` is NULL, and `false OR NULL` is NULL -- the
--    constraint passes a row missing the very field it exists to require.
--    Verified by inserting one: the bare form accepted it. This is the same
--    trap migration 0062 hit and CODEBASE.md records twice; the mistake is
--    that the obvious spelling reads as correct.
ALTER TABLE public.mink_drafts
  DROP CONSTRAINT IF EXISTS mink_drafts_storefront_layout_target_check;
ALTER TABLE public.mink_drafts
  ADD CONSTRAINT mink_drafts_storefront_layout_target_check CHECK (
    kind <> 'storefront_layout' OR (
      destination_type = 'storefront_page'
      AND location_id IS NULL
      AND variant_id IS NULL
      AND coalesce(jsonb_typeof(content_json -> 'page_slug'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'expected_page_version'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'expected_sections_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'patch_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'sections_json'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'explanation'), '') = 'string'
    )
  );

ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT IF EXISTS mink_action_approvals_storefront_layout_target_check;
ALTER TABLE public.mink_action_approvals
  ADD CONSTRAINT mink_action_approvals_storefront_layout_target_check CHECK (
    tool_name <> 'apply_storefront_layout' OR (
      resource_type = 'storefront_page'
      AND resource_id IS NOT NULL
      AND resource_version IS NOT NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND operation = 'apply'
      AND source_approval_id IS NULL
      AND coalesce(jsonb_typeof(before_json -> 'page_slug'), '') = 'string'
      AND coalesce(jsonb_typeof(before_json -> 'sections_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(after_json -> 'sections_digest'), '') = 'string'
      AND (
        (status = 'executed' AND result_id = resource_id AND result_version IS NOT NULL)
        OR (status <> 'executed' AND result_id IS NULL AND result_version IS NULL)
      )
    )
  );

ALTER TABLE public.mink_action_audit
  DROP CONSTRAINT IF EXISTS mink_action_audit_storefront_layout_target_check;
ALTER TABLE public.mink_action_audit
  ADD CONSTRAINT mink_action_audit_storefront_layout_target_check CHECK (
    tool_name <> 'apply_storefront_layout' OR (
      resource_type = 'storefront_page'
      AND resource_id IS NOT NULL
      AND resource_version_before IS NOT NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND operation = 'apply'
      AND coalesce(jsonb_typeof(before_json -> 'page_slug'), '') = 'string'
      AND coalesce(jsonb_typeof(before_json -> 'sections_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(after_json -> 'sections_digest'), '') = 'string'
      AND (
        (outcome = 'executed' AND result_id = resource_id AND resource_version_after IS NOT NULL)
        OR (outcome <> 'executed' AND result_id IS NULL)
      )
    )
  );

-- 4. Enrol the tool for stores that already have Mink on, matching the single
--    operator switch installed by 0091. ⚠ THAT SWITCH IS ALL-OR-NOTHING BY
--    DESIGN (granular per-action controls were deliberately removed), so a new
--    tool that skipped this backfill would be dark on every existing store
--    until somebody re-toggled Mink -- exactly the release step that gets
--    forgotten. Stores with Mink disabled get nothing.
INSERT INTO public.mink_action_tool_access
  (store_id, tool_name, enabled, enabled_by, enabled_at, updated_at)
SELECT a.store_id, 'apply_storefront_layout', true, a.invited_by, now(), now()
FROM public.mink_store_access a
WHERE a.enabled = true
ON CONFLICT (store_id, tool_name) DO UPDATE
SET enabled = true, updated_at = now();

-- 5. Repair the SAME hole in the Phase 7B/7C target checks, found while
--    probing the new ones. `mink_drafts_storefront_code_target_check` and its
--    approvals counterpart use the bare `jsonb_typeof(...) = 'string'` form,
--    so a storefront_code proposal missing `html` entirely -- or an approval
--    missing its section digest -- is accepted today. Both tables hold zero
--    rows that would fail the tightened form, so this validates instantly.
ALTER TABLE public.mink_drafts
  DROP CONSTRAINT IF EXISTS mink_drafts_storefront_code_target_check;
ALTER TABLE public.mink_drafts
  ADD CONSTRAINT mink_drafts_storefront_code_target_check CHECK (
    kind <> 'storefront_custom_code' OR (
      destination_type = 'storefront_section'
      AND destination_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND coalesce(jsonb_typeof(content_json -> 'page_slug'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'section_id'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'expected_page_version'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'expected_section_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'patch_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'html'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'css'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'js'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'height_mode'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'fixed_height'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'explanation'), '') = 'string'
    )
  );
