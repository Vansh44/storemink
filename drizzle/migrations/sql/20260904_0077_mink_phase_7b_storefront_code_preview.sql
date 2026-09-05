-- Migration 0077 — Mink Phase 7B private storefront-code proposals.
--
-- The only new persisted object is an owner-private Mink proposal. This phase
-- deliberately grants no store_pages UPDATE, Website Builder save, publish,
-- repository, shell or deployment authority.

ALTER TABLE public.mink_drafts
  DROP CONSTRAINT IF EXISTS mink_drafts_kind_check,
  ADD CONSTRAINT mink_drafts_kind_check CHECK (
    kind = ANY (ARRAY[
      'product_description', 'product_seo', 'blog', 'coupon_email',
      'customer_message', 'product_create', 'coupon_create', 'coupon_update',
      'customer_group_create', 'customer_group_update',
      'inventory_adjustment', 'bulk_inventory_adjustment',
      'order_status_transition', 'bulk_price_update',
      'offer_create', 'offer_update', 'offer_activate',
      'storefront_custom_code'
    ]::text[])
  ),
  DROP CONSTRAINT IF EXISTS mink_drafts_storefront_code_target_check,
  ADD CONSTRAINT mink_drafts_storefront_code_target_check CHECK (
    kind <> 'storefront_custom_code'
    OR (
      destination_type = 'storefront_section'
      AND destination_id IS NULL
      AND location_id IS NULL
      AND variant_id IS NULL
      AND jsonb_typeof(content_json -> 'page_slug') = 'string'
      AND jsonb_typeof(content_json -> 'section_id') = 'string'
      AND jsonb_typeof(content_json -> 'expected_page_version') = 'string'
      AND jsonb_typeof(content_json -> 'expected_section_digest') = 'string'
      AND jsonb_typeof(content_json -> 'patch_digest') = 'string'
      AND jsonb_typeof(content_json -> 'html') = 'string'
      AND jsonb_typeof(content_json -> 'css') = 'string'
      AND jsonb_typeof(content_json -> 'js') = 'string'
      AND jsonb_typeof(content_json -> 'height_mode') = 'string'
      AND jsonb_typeof(content_json -> 'fixed_height') = 'string'
      AND jsonb_typeof(content_json -> 'explanation') = 'string'
    )
  );

WITH phase7b AS (
  SELECT
    '<p>Phase 7A also defines a validation-only contract for a future custom-code proposal. A patch must target one exact page version and section digest, stay within 64 KiB per code field and 96 KiB combined, and reject unsafe network, cookie or storage, parent-window, dynamic-evaluation, worker, embed and CSS capabilities. The existing preview boundary is an opaque-origin iframe with <code>sandbox="allow-scripts allow-popups"</code>; same-origin and top navigation are not allowed.</p>'::text AS old_contract,
    '<p>Phase 7B adds an immutable, private custom-code proposal for one <strong>existing custom-code section</strong>. It requires <strong>Website Builder Manage</strong> plus Mink drafting, costs 5 AI credits, and rechecks the exact current page version and section digest before charging. Generated HTML, CSS and JavaScript must stay within 64 KiB per field and 96 KiB combined. Deterministic validation rejects network access, cookies or storage, parent-window access, cross-context messaging, navigation, dynamic evaluation, workers, forms, embeds, external resources and unsafe CSS.</p><p>The generated proposal is previewed only in an opaque-origin iframe with <code>sandbox="allow-scripts"</code> and a deny-by-default Content Security Policy. Popup, same-origin, form, network, worker, nested-frame and top-navigation authority are absent. The preview offers desktop and mobile widths plus escaped current/proposed source views. The stored before snapshot is never executed; only the complete validated proposed replacement is rendered. If the page or section changes later, the card is marked stale.</p>'::text AS new_contract,
    '<p><strong>Phase 7A is read-only.</strong> Mink can explain current design facts and suggest a plan, but it cannot yet create a code proposal, execute or preview generated code, save a page or header/footer draft, publish or roll back a storefront, access the StoreMink repository or shell, commit code, or deploy production. If Mink says it completed one of those actions, no matching capability exists in this phase and the claim is incorrect.</p>'::text AS old_authority,
    '<p><strong>Phase 7B remains preview-only.</strong> Mink can generate and store the private proposal after the request passes validation, but it cannot edit that immutable proposal, add a custom-code section, save it into the Website Builder draft, change header or footer, publish or roll back a storefront, access the StoreMink repository or shell, commit code, or deploy production. Open Website Builder separately to inspect the current page. A later guarded phase must implement any builder save or publication workflow.</p>'::text AS new_authority
)
UPDATE public.help_articles AS article
SET excerpt = 'Use Mink AI for grounded business work, guarded actions, durable workflows and private storefront code previews.',
    seo_description = 'Use permission-aware Mink AI for grounded store work, guarded actions, durable workflows and secure private storefront code previews.',
    body = replace(
      replace(article.body, phase7b.old_contract, phase7b.new_contract),
      phase7b.old_authority,
      phase7b.new_authority
    ),
    updated_at = now()
FROM phase7b
WHERE article.slug = 'use-mink-ai-in-your-dashboard'
  AND article.status = 'published'
  AND article.category_id IS NOT NULL
  AND article.body LIKE '%' || phase7b.old_contract || '%'
  AND article.body LIKE '%' || phase7b.old_authority || '%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%Phase 7B adds an immutable, private custom-code proposal%'
      AND body LIKE '%Website Builder Manage%'
      AND body LIKE '%costs 5 AI credits%'
      AND body LIKE '%sandbox="allow-scripts"%'
      AND body LIKE '%deny-by-default Content Security Policy%'
      AND body LIKE '%The stored before snapshot is never executed%'
      AND body LIKE '%Phase 7B remains preview-only%'
      AND body LIKE '%cannot edit that immutable proposal%'
      AND body LIKE '%access the StoreMink repository or shell%'
      AND body NOT LIKE '%cannot yet create a code proposal%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 7B Help Centre guidance was not installed';
  END IF;
END $$;
