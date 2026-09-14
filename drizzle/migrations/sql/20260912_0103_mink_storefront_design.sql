-- Phase 9C: let Mink propose the storefront's DESIGN -- palette, typefaces and
-- corner radii.
--
-- 7B replaces the code inside one custom-code section and 9B replaces one
-- page's section list. Neither can change what the whole shop LOOKS like, and
-- "I like this website, make mine like it" is a statement about colour and type
-- before it is a statement about blocks. Phase 9A gave that a home
-- (`store_chrome.draft.design`, eight curated palette tokens, an allowlisted
-- typeface pair, four radii); this admits one immutable private proposal for
-- it, behind its own operator gate and its own human approval.
--
-- ⚠ THE WRITE TARGET IS A NEW RESOURCE TYPE, `storefront_chrome`. Every earlier
-- storefront action wrote `store_pages`; this writes the chrome row, whose
-- primary key IS the store id.

-- 1. The tool vocabulary. ⚠ ENUMERATED BY QUERYING FOR AN EXISTING MEMBER, not
--    by listing the tables one expects -- 0070 widened three allowlists it
--    could think of and missed a fourth, and 0101 nearly repeated it:
--      select conrelid::regclass, conname from pg_constraint
--       where pg_get_constraintdef(oid) like '%apply_storefront_layout%';
--    which returns SIX constraints across three tables (three tool lists, the
--    draft-version list, and two target checks).
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
      'apply_storefront_layout', 'apply_storefront_design'
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
      'apply_storefront_layout', 'apply_storefront_design'
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
      'apply_storefront_layout', 'apply_storefront_design'
    ]::text[])
  );

-- 1b. The fourth vocabulary, whose NAME says nothing about tools.
--     `draft_version > 0` is required for every tool EXCEPT the storefront
--     ones, whose proposals are IMMUTABLE and therefore always version 0. Without
--     widening it, every design preview insert is refused by the database.
ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT IF EXISTS mink_action_approvals_draft_version_check;
ALTER TABLE public.mink_action_approvals
  ADD CONSTRAINT mink_action_approvals_draft_version_check CHECK (
    draft_version > 0
    OR (
      tool_name = ANY (ARRAY[
        'apply_storefront_code', 'publish_storefront_code',
        'apply_storefront_layout', 'apply_storefront_design'
      ]::text[])
      AND draft_version = 0
    )
  );

-- 2. The resource type. Both allowlists, or the audit insert rolls back the
--    execution it was recording -- 0071's lesson on the sibling table.
ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT IF EXISTS mink_action_approvals_resource_type_check;
ALTER TABLE public.mink_action_approvals
  ADD CONSTRAINT mink_action_approvals_resource_type_check CHECK (
    resource_type = ANY (ARRAY[
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order', 'blog', 'campaign', 'price_bulk', 'offer',
      'storefront_section', 'storefront_page', 'storefront_chrome'
    ]::text[])
  );

ALTER TABLE public.mink_action_audit
  DROP CONSTRAINT IF EXISTS mink_action_audit_resource_type_check;
ALTER TABLE public.mink_action_audit
  ADD CONSTRAINT mink_action_audit_resource_type_check CHECK (
    resource_type = ANY (ARRAY[
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order', 'blog', 'campaign', 'price_bulk', 'offer',
      'storefront_section', 'storefront_page', 'storefront_chrome'
    ]::text[])
  );

-- 3. The draft kind.
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
      'storefront_custom_code', 'storefront_layout', 'storefront_design'
    ]::text[])
  );

-- 4. The design proposal's own shape.
--
--    ⚠⚠ EVERY jsonb_typeof IS COALESCED. A CHECK is SATISFIED when it evaluates
--    to NULL, and `content_json -> 'design_json'` is SQL NULL when the key is
--    ABSENT -- so `jsonb_typeof(NULL) = 'string'` is NULL and the whole
--    constraint passes a row missing the very field it exists to require. This
--    is the fourth time that trap is recorded here (0062, 0064, 0101); the
--    mistake is that the bare spelling reads as correct.
ALTER TABLE public.mink_drafts
  DROP CONSTRAINT IF EXISTS mink_drafts_storefront_design_target_check;
ALTER TABLE public.mink_drafts
  ADD CONSTRAINT mink_drafts_storefront_design_target_check CHECK (
    kind <> 'storefront_design' OR (
      destination_type = 'storefront_chrome'
      AND destination_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND coalesce(jsonb_typeof(content_json -> 'expected_design_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'patch_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'design_json'), '') = 'string'
      AND coalesce(jsonb_typeof(content_json -> 'explanation'), '') = 'string'
    )
  );

-- ★★ `resource_version` IS DELIBERATELY NOT REQUIRED HERE, and that is the one
--    way this target check differs from 9B's. That column is
--    `timestamp with time zone`, so it cannot hold the design digest -- it
--    carries the chrome row's `updated_at`, which is NULL for a store that has
--    never opened the Brand panel and therefore has no chrome row at all. The
--    value the write is actually gated on is `before_json.design_digest`,
--    required below, bound into the approval's canonical request hash, and
--    re-compared against the live design inside the executing transaction.
ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT IF EXISTS mink_action_approvals_storefront_design_target_check;
ALTER TABLE public.mink_action_approvals
  ADD CONSTRAINT mink_action_approvals_storefront_design_target_check CHECK (
    tool_name <> 'apply_storefront_design' OR (
      resource_type = 'storefront_chrome'
      -- The chrome row's primary key IS the store id, so an approval naming
      -- any other resource is a tenancy error rather than a stale pointer.
      AND resource_id = store_id
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND operation = 'apply'
      AND source_approval_id IS NULL
      AND coalesce(jsonb_typeof(before_json -> 'design_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(after_json -> 'design_digest'), '') = 'string'
      AND (
        (status = 'executed' AND result_id IS NOT NULL AND result_id = resource_id)
        OR (status <> 'executed' AND result_id IS NULL AND result_version IS NULL)
      )
    )
  );

ALTER TABLE public.mink_action_audit
  DROP CONSTRAINT IF EXISTS mink_action_audit_storefront_design_target_check;
ALTER TABLE public.mink_action_audit
  ADD CONSTRAINT mink_action_audit_storefront_design_target_check CHECK (
    tool_name <> 'apply_storefront_design' OR (
      resource_type = 'storefront_chrome'
      AND resource_id = store_id
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND operation = 'apply'
      AND coalesce(jsonb_typeof(before_json -> 'design_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(after_json -> 'design_digest'), '') = 'string'
      AND (
        (outcome = 'executed' AND result_id IS NOT NULL AND result_id = resource_id)
        OR (outcome <> 'executed' AND result_id IS NULL)
      )
    )
  );

-- 6. ★★ REPAIR THE SAME NULL TRAP IN EVERY APPLIED STOREFRONT TARGET CHECK,
--    FOUND BY PROBING THE NEW ONES.
--
--    `(outcome = 'executed' AND result_id = resource_id) OR (outcome <>
--    'executed' AND result_id IS NULL)` reads as exhaustive and is not: with
--    `result_id` NULL the first arm is `true AND NULL` = NULL, the second is
--    `false`, and `NULL OR false` is NULL -- which SATISFIES a CHECK. So an
--    executed row recording no result at all was accepted. Verified by INSERT
--    against a real database: an `apply_storefront_layout` audit row with
--    `outcome = 'executed'`, `resource_version_after` set and `result_id` NULL
--    went in, while the same row naming the WRONG result was correctly refused.
--
--    ⚠ THIS IS THE THIRD SHAPE OF THE SAME TRAP. 0062 hit it with
--    `jsonb_typeof` on an absent key, 0101 with the same, and it is repaired
--    here in a bare COMPARISON — so coalescing every `jsonb_typeof` is not the
--    rule. The rule is that ANY sub-expression which can be NULL makes its
--    whole CHECK pass, and a two-armed `OR` over a nullable column has one such
--    expression per arm.
--
--    ⚠ Some of these were saved only by a NEIGHBOURING conjunct: on the
--    approvals side `result_version IS NULL` in the second arm is a real
--    `false` that collapses the AND, so the hole opens only when
--    `result_version` is set and `result_id` is not. A guard that depends on
--    the field beside it is one an unrelated edit removes, so all eight are
--    fixed the same way rather than only the reachable ones.
--
--    All eight tables hold rows that satisfy the tightened form (the
--    application has always written `result_id`), so these validate instantly.

ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT IF EXISTS mink_action_approvals_storefront_code_target_check;
ALTER TABLE public.mink_action_approvals
  ADD CONSTRAINT mink_action_approvals_storefront_code_target_check CHECK (
    tool_name <> 'apply_storefront_code' OR (
      resource_type = 'storefront_section'
      AND resource_id IS NOT NULL
      AND resource_version IS NOT NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND operation = 'apply'
      AND source_approval_id IS NULL
      AND draft_version = 0
      AND coalesce(jsonb_typeof(before_json -> 'page_slug'), '') = 'string'
      AND coalesce(jsonb_typeof(before_json -> 'section_id'), '') = 'string'
      AND coalesce(jsonb_typeof(before_json -> 'section_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(after_json -> 'section_digest'), '') = 'string'
      AND (
        (status = 'executed' AND result_id IS NOT NULL AND result_id = resource_id
          AND result_version IS NOT NULL)
        OR (status <> 'executed' AND result_id IS NULL AND result_version IS NULL)
      )
    )
  );

ALTER TABLE public.mink_action_audit
  DROP CONSTRAINT IF EXISTS mink_action_audit_storefront_code_target_check;
ALTER TABLE public.mink_action_audit
  ADD CONSTRAINT mink_action_audit_storefront_code_target_check CHECK (
    tool_name <> 'apply_storefront_code' OR (
      resource_type = 'storefront_section'
      AND resource_id IS NOT NULL
      AND resource_version_before IS NOT NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND operation = 'apply'
      AND coalesce(jsonb_typeof(before_json -> 'page_slug'), '') = 'string'
      AND coalesce(jsonb_typeof(before_json -> 'section_id'), '') = 'string'
      AND coalesce(jsonb_typeof(before_json -> 'section_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(after_json -> 'section_digest'), '') = 'string'
      AND (
        (outcome = 'executed' AND result_id IS NOT NULL AND result_id = resource_id
          AND resource_version_after IS NOT NULL)
        OR (outcome <> 'executed' AND result_id IS NULL)
      )
    )
  );

ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT IF EXISTS mink_action_approvals_storefront_publish_target_check;
ALTER TABLE public.mink_action_approvals
  ADD CONSTRAINT mink_action_approvals_storefront_publish_target_check CHECK (
    tool_name <> 'publish_storefront_code' OR (
      resource_type = 'storefront_page'
      AND resource_id IS NOT NULL
      AND resource_version IS NOT NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND source_approval_id IS NOT NULL
      AND draft_version = 0
      AND coalesce(jsonb_typeof(before_json -> 'sections'), '') = 'array'
      AND coalesce(jsonb_typeof(after_json -> 'sections'), '') = 'array'
      AND coalesce(jsonb_typeof(before_json -> 'sections_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(after_json -> 'sections_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(before_json -> 'target_section_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(after_json -> 'target_section_digest'), '') = 'string'
      AND (
        operation = 'rollback'
        OR coalesce(jsonb_typeof(after_json -> 'browser_validation'), '') = 'object'
      )
      AND (
        (status = 'executed' AND result_id IS NOT NULL AND result_id = resource_id
          AND result_version IS NOT NULL)
        OR (status <> 'executed' AND result_id IS NULL AND result_version IS NULL)
      )
    )
  );

ALTER TABLE public.mink_action_audit
  DROP CONSTRAINT IF EXISTS mink_action_audit_storefront_publish_target_check;
ALTER TABLE public.mink_action_audit
  ADD CONSTRAINT mink_action_audit_storefront_publish_target_check CHECK (
    tool_name <> 'publish_storefront_code' OR (
      resource_type = 'storefront_page'
      AND resource_id IS NOT NULL
      AND resource_version_before IS NOT NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND coalesce(jsonb_typeof(before_json -> 'sections'), '') = 'array'
      AND coalesce(jsonb_typeof(after_json -> 'sections'), '') = 'array'
      AND coalesce(jsonb_typeof(before_json -> 'sections_digest'), '') = 'string'
      AND coalesce(jsonb_typeof(after_json -> 'sections_digest'), '') = 'string'
      AND (
        (outcome = 'executed' AND result_id IS NOT NULL AND result_id = resource_id
          AND resource_version_after IS NOT NULL)
        OR (outcome <> 'executed' AND result_id IS NULL)
      )
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
        (status = 'executed' AND result_id IS NOT NULL AND result_id = resource_id
          AND result_version IS NOT NULL)
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
        (outcome = 'executed' AND result_id IS NOT NULL AND result_id = resource_id
          AND resource_version_after IS NOT NULL)
        OR (outcome <> 'executed' AND result_id IS NULL)
      )
    )
  );

-- 5. Enrol the tool for stores that already have Mink on, matching the single
--    operator switch installed by 0091. ⚠ THAT SWITCH IS ALL-OR-NOTHING BY
--    DESIGN, so a new tool that skipped this backfill would be dark on every
--    existing store until somebody re-toggled Mink -- exactly the release step
--    that gets forgotten. Stores with Mink disabled get nothing.
INSERT INTO public.mink_action_tool_access
  (store_id, tool_name, enabled, enabled_by, enabled_at, updated_at)
SELECT a.store_id, 'apply_storefront_design', true, a.invited_by, now(), now()
FROM public.mink_store_access a
WHERE a.enabled = true
ON CONFLICT (store_id, tool_name) DO UPDATE
SET enabled = true, updated_at = now();
