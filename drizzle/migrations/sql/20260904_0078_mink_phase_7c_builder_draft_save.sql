-- Migration 0078 — Mink Phase 7C guarded Website Builder draft saves.
--
-- This widens the existing approval/audit vocabulary for one exact custom-code
-- section replacement. The application updates only store_pages.sections;
-- published_sections, status and published_at are outside this contract.

ALTER TABLE public.mink_action_tool_access
  DROP CONSTRAINT IF EXISTS mink_action_tool_access_name_check,
  ADD CONSTRAINT mink_action_tool_access_name_check CHECK (
    tool_name IN (
      'apply_product_description', 'apply_product_seo', 'create_product',
      'create_coupon', 'update_coupon', 'create_customer_group',
      'update_customer_group', 'adjust_inventory', 'bulk_adjust_inventory',
      'transition_order_status', 'publish_blog', 'send_campaign',
      'bulk_update_prices', 'create_offer', 'update_offer', 'activate_offer',
      'apply_storefront_code'
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
      'apply_storefront_code'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_approvals_resource_type_check,
  ADD CONSTRAINT mink_action_approvals_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order', 'blog', 'campaign', 'price_bulk', 'offer',
      'storefront_section'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_approvals_draft_version_check,
  ADD CONSTRAINT mink_action_approvals_draft_version_check CHECK (
    draft_version > 0
    OR (tool_name = 'apply_storefront_code' AND draft_version = 0)
  ),
  DROP CONSTRAINT IF EXISTS mink_action_approvals_storefront_code_target_check,
  ADD CONSTRAINT mink_action_approvals_storefront_code_target_check CHECK (
    tool_name <> 'apply_storefront_code'
    OR (
      resource_type = 'storefront_section'
      AND resource_id IS NOT NULL
      AND resource_version IS NOT NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND operation = 'apply'
      AND source_approval_id IS NULL
      AND draft_version = 0
      AND jsonb_typeof(before_json -> 'page_slug') = 'string'
      AND jsonb_typeof(before_json -> 'section_id') = 'string'
      AND jsonb_typeof(before_json -> 'section_digest') = 'string'
      AND jsonb_typeof(after_json -> 'section_digest') = 'string'
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
      'apply_storefront_code'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_audit_resource_type_check,
  ADD CONSTRAINT mink_action_audit_resource_type_check CHECK (
    resource_type IN (
      'product', 'coupon', 'customer_group', 'inventory', 'inventory_bulk',
      'order', 'blog', 'campaign', 'price_bulk', 'offer',
      'storefront_section'
    )
  ),
  DROP CONSTRAINT IF EXISTS mink_action_audit_storefront_code_target_check,
  ADD CONSTRAINT mink_action_audit_storefront_code_target_check CHECK (
    tool_name <> 'apply_storefront_code'
    OR (
      resource_type = 'storefront_section'
      AND resource_id IS NOT NULL
      AND resource_version_before IS NOT NULL
      AND product_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND operation = 'apply'
      AND jsonb_typeof(before_json -> 'page_slug') = 'string'
      AND jsonb_typeof(before_json -> 'section_id') = 'string'
      AND jsonb_typeof(before_json -> 'section_digest') = 'string'
      AND jsonb_typeof(after_json -> 'section_digest') = 'string'
      AND (
        (outcome = 'executed' AND result_id = resource_id AND resource_version_after IS NOT NULL)
        OR (outcome <> 'executed' AND result_id IS NULL)
      )
    )
  );

CREATE INDEX IF NOT EXISTS mink_action_approvals_storefront_code_idx
  ON public.mink_action_approvals
    (store_id, resource_id, status, created_at DESC)
  WHERE tool_name = 'apply_storefront_code';

CREATE INDEX IF NOT EXISTS mink_action_audit_storefront_code_idx
  ON public.mink_action_audit (store_id, resource_id, created_at DESC)
  WHERE tool_name = 'apply_storefront_code';

WITH phase7c AS (
  SELECT
    $old$<p><strong>Phase 7B remains preview-only.</strong> Mink can generate and store the private proposal after the request passes validation, but it cannot edit that immutable proposal, add a custom-code section, save it into the Website Builder draft, change header or footer, publish or roll back a storefront, access the StoreMink repository or shell, commit code, or deploy production. Open Website Builder separately to inspect the current page. A later guarded phase must implement any builder save or publication workflow.</p>$old$::text AS old_authority,
    $new$<p><strong>Phase 7C can save to the private Website Builder draft only.</strong> For an existing custom-code section, choose <strong>Review Builder draft save</strong>, inspect the complete current and proposed source, then choose <strong>Approve and save Builder draft</strong> within five minutes. The approval is tied to the current store, signed-in admin, immutable proposal, exact page version and exact section digest. If any of them changes, nothing is saved and you must generate a fresh proposal. StoreMink support must separately enable <strong>Website Builder draft code saves</strong> for the store.</p><p>The save replaces only the reviewed custom-code section in the draft. It does not add a section, change header or footer, publish the page, change what shoppers see, access StoreMink source code or shell, commit code, deploy production, or provide automatic rollback. Open Website Builder to inspect the saved draft. Publication remains a separate future approval.</p>$new$::text AS new_authority,
    $anchor$<p>The generated proposal is previewed only in an opaque-origin iframe with <code>sandbox="allow-scripts"</code> and a deny-by-default Content Security Policy. Popup, same-origin, form, network, worker, nested-frame and top-navigation authority are absent. The preview offers desktop and mobile widths plus escaped current/proposed source views. The stored before snapshot is never executed; only the complete validated proposed replacement is rendered. If the page or section changes later, the card is marked stale.</p>$anchor$::text AS preview_anchor,
    $approval$<p>Before a draft save, Mink validates the stored code again and creates a new five-minute approval. The operator gate, Website Builder Manage permission, custom-code entitlement, proposal version, page version, section digest and request hash are checked again inside the save transaction. Repeated requests use the same approval safely, and every execution, expiry or conflict writes an audit outcome.</p>$approval$::text AS approval_contract
)
UPDATE public.help_articles AS article
SET excerpt = 'Use Mink AI for grounded work, guarded actions, durable workflows and approved Website Builder draft saves.',
    seo_description = 'Use permission-aware Mink AI for grounded store work, secure previews and guarded Website Builder draft saves.',
    body = replace(
      replace(article.body, phase7c.old_authority, phase7c.new_authority),
      phase7c.preview_anchor,
      phase7c.preview_anchor || phase7c.approval_contract
    ),
    updated_at = now()
FROM phase7c
WHERE article.slug = 'use-mink-ai-in-your-dashboard'
  AND article.status = 'published'
  AND article.category_id IS NOT NULL
  AND article.body LIKE '%' || phase7c.old_authority || '%'
  AND article.body LIKE '%' || phase7c.preview_anchor || '%'
  AND article.body NOT LIKE '%Review Builder draft save%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%Phase 7C can save to the private Website Builder draft only%'
      AND body LIKE '%Review Builder draft save%'
      AND body LIKE '%Approve and save Builder draft%'
      AND body LIKE '%within five minutes%'
      AND body LIKE '%exact page version and exact section digest%'
      AND body LIKE '%does not add a section%'
      AND body LIKE '%Publication remains a separate future approval%'
      AND body LIKE '%every execution, expiry or conflict writes an audit outcome%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 7C Help Centre guidance was not installed';
  END IF;
END $$;
