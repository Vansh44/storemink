-- Migration 0079 — Mink Phase 7D checked storefront publication and rollback.
--
-- Publication is a separate, default-off action. A publish approval must point
-- to the completed Phase 7C draft save; rollback must point to the completed
-- publication. Both bind complete page snapshots and exact page versions.

ALTER TABLE public.mink_action_tool_access
  DROP CONSTRAINT IF EXISTS mink_action_tool_access_name_check,
  ADD CONSTRAINT mink_action_tool_access_name_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign',
      'bulk_update_prices', 'create_offer', 'update_offer', 'activate_offer',
      'apply_storefront_code', 'publish_storefront_code'
    )
  );

ALTER TABLE public.mink_action_approvals
  DROP CONSTRAINT IF EXISTS mink_action_approvals_tool_check,
  ADD CONSTRAINT mink_action_approvals_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign',
      'bulk_update_prices', 'create_offer', 'update_offer', 'activate_offer',
      'apply_storefront_code', 'publish_storefront_code'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_approvals_resource_type_check,
  ADD CONSTRAINT mink_action_approvals_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order', 'blog', 'campaign', 'price_bulk', 'offer',
      'storefront_section', 'storefront_page'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_approvals_draft_version_check,
  ADD CONSTRAINT mink_action_approvals_draft_version_check CHECK (
    draft_version > 0
    OR (
      tool_name IN ('apply_storefront_code', 'publish_storefront_code')
      AND draft_version = 0
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_approvals_storefront_publish_target_check,
  ADD CONSTRAINT mink_action_approvals_storefront_publish_target_check CHECK (
    tool_name <> 'publish_storefront_code'
    OR (
      resource_type = 'storefront_page'
      AND resource_id IS NOT NULL
      AND resource_version IS NOT NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND source_approval_id IS NOT NULL
      AND draft_version = 0
      AND jsonb_typeof(before_json -> 'sections') = 'array'
      AND jsonb_typeof(after_json -> 'sections') = 'array'
      AND jsonb_typeof(before_json -> 'sections_digest') = 'string'
      AND jsonb_typeof(after_json -> 'sections_digest') = 'string'
      AND jsonb_typeof(before_json -> 'target_section_digest') = 'string'
      AND jsonb_typeof(after_json -> 'target_section_digest') = 'string'
      AND (
        operation = 'rollback'
        OR jsonb_typeof(after_json -> 'browser_validation') = 'object'
      )
      AND (
        (status = 'executed' AND result_id = resource_id AND result_version IS NOT NULL)
        OR (status <> 'executed' AND result_id IS NULL AND result_version IS NULL)
      )
    )
  );

ALTER TABLE public.mink_action_audit
  DROP CONSTRAINT IF EXISTS mink_action_audit_tool_check,
  ADD CONSTRAINT mink_action_audit_tool_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign',
      'bulk_update_prices', 'create_offer', 'update_offer', 'activate_offer',
      'apply_storefront_code', 'publish_storefront_code'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_audit_resource_type_check,
  ADD CONSTRAINT mink_action_audit_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order', 'blog', 'campaign', 'price_bulk', 'offer',
      'storefront_section', 'storefront_page'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_audit_storefront_publish_target_check,
  ADD CONSTRAINT mink_action_audit_storefront_publish_target_check CHECK (
    tool_name <> 'publish_storefront_code'
    OR (
      resource_type = 'storefront_page'
      AND resource_id IS NOT NULL
      AND resource_version_before IS NOT NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND jsonb_typeof(before_json -> 'sections') = 'array'
      AND jsonb_typeof(after_json -> 'sections') = 'array'
      AND jsonb_typeof(before_json -> 'sections_digest') = 'string'
      AND jsonb_typeof(after_json -> 'sections_digest') = 'string'
      AND (
        (outcome = 'executed' AND result_id = resource_id AND resource_version_after IS NOT NULL)
        OR (outcome <> 'executed' AND result_id IS NULL)
      )
    )
  );

CREATE INDEX IF NOT EXISTS mink_action_approvals_storefront_publish_idx
  ON public.mink_action_approvals
    (store_id, resource_id, status, created_at DESC)
  WHERE tool_name = 'publish_storefront_code';

CREATE INDEX IF NOT EXISTS mink_action_audit_storefront_publish_idx
  ON public.mink_action_audit (store_id, resource_id, created_at DESC)
  WHERE tool_name = 'publish_storefront_code';

WITH phase7d AS (
  SELECT
    $old$<p>The save replaces only the reviewed custom-code section in the draft. It does not add a section, change header or footer, publish the page, change what shoppers see, access StoreMink source code or shell, commit code, deploy production, or provide automatic rollback. Open Website Builder to inspect the saved draft. Publication remains a separate future approval.</p>$old$::text AS old_authority,
    $new$<p>The draft save replaces only the reviewed custom-code section. It does not add a section or change header or footer. Phase 7D adds a separate publication boundary: choose <strong>Run publication checks</strong> to execute the proposed section in opaque-origin 1,280 px desktop and 390 px mobile frames. Publication remains unavailable unless current-browser runtime, horizontal-overflow, Content Security Policy and bounded accessibility checks all pass. Then choose <strong>Review storefront publication</strong> and <strong>Approve and publish storefront</strong> within five minutes. StoreMink support must separately enable <strong>Checked storefront publication and rollback</strong> for the store.</p><p>The publication approval is bound to the completed Phase 7C save, exact private Builder draft, exact current live snapshot, page version and complete section digests. It copies that checked draft snapshot to the live page; it cannot add sections, edit header/footer, access StoreMink source code or shell, commit code or deploy production. A completed Mink publication exposes <strong>Review exact rollback</strong>. Rollback requires another five-minute approval, restores only the exact prior published snapshot and fails closed if the live page changed after publication.</p>$new$::text AS new_authority,
    $approval$<p>Before a draft save, Mink validates the stored code again and creates a new five-minute approval. The operator gate, Website Builder Manage permission, custom-code entitlement, proposal version, page version, section digest and request hash are checked again inside the save transaction. Repeated requests use the same approval safely, and every execution, expiry or conflict writes an audit outcome.</p>$approval$::text AS approval_anchor,
    $publication$<p>Publication and rollback have an independent default-off operator gate and never grant Gemini an execution tool. The signed-in human initiates every check, review and approval. The server revalidates the tenant, proposal owner, Website Builder Manage permission, custom-code entitlement, source approval, browser evidence, full page snapshots and optimistic page version inside the transaction. Repeated execution is idempotent; execution, conflict and expiry outcomes are append-only audited.</p>$publication$::text AS publication_contract
)
UPDATE public.help_articles AS article
SET excerpt = 'Use Mink AI for grounded work, guarded actions, checked storefront publication and exact rollback.',
    seo_description = 'Use permission-aware Mink AI for secure Website Builder previews, approved draft saves, checked publication and exact rollback.',
    body = replace(
      replace(article.body, phase7d.old_authority, phase7d.new_authority),
      phase7d.approval_anchor,
      phase7d.approval_anchor || phase7d.publication_contract
    ),
    updated_at = now()
FROM phase7d
WHERE article.slug = 'use-mink-ai-in-your-dashboard'
  AND article.status = 'published'
  AND article.category_id IS NOT NULL
  AND article.body LIKE '%' || phase7d.old_authority || '%'
  AND article.body LIKE '%' || phase7d.approval_anchor || '%'
  AND article.body NOT LIKE '%Run publication checks%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%Run publication checks%'
      AND body LIKE '%1,280 px desktop and 390 px mobile%'
      AND body LIKE '%Approve and publish storefront%'
      AND body LIKE '%Checked storefront publication and rollback%'
      AND body LIKE '%Review exact rollback%'
      AND body LIKE '%fails closed if the live page changed after publication%'
      AND body LIKE '%never grant Gemini an execution tool%'
      AND body LIKE '%execution, conflict and expiry outcomes are append-only audited%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 7D Help Centre guidance was not installed';
  END IF;
END $$;
