-- Forward-only: consolidate existing store capabilities without changing RBAC,
-- action approvals, credits, watch opt-ins or global runtime shutdown.
-- Serialize the one-time backfill with operator enable/disable transactions.
LOCK TABLE public.mink_store_access IN SHARE ROW EXCLUSIVE MODE;
UPDATE public.mink_store_access
SET drafting_enabled = enabled, updated_at = now()
WHERE drafting_enabled IS DISTINCT FROM enabled;

INSERT INTO public.mink_action_tool_access
  (store_id, tool_name, enabled, enabled_by, enabled_at, updated_at)
SELECT a.store_id, tool_name, true, a.invited_by, now(), now()
FROM public.mink_store_access a
CROSS JOIN unnest(ARRAY[
  'apply_product_description', 'apply_product_seo', 'create_product',
  'create_coupon', 'update_coupon', 'create_customer_group', 'update_customer_group',
  'create_offer', 'update_offer', 'activate_offer',
  'adjust_inventory', 'bulk_adjust_inventory', 'transition_order_status',
  'publish_blog', 'send_campaign', 'bulk_update_prices',
  'apply_storefront_code', 'publish_storefront_code'
]::text[]) AS tools(tool_name)
WHERE a.enabled = true
ON CONFLICT (store_id, tool_name) DO UPDATE
SET enabled = true, enabled_by = EXCLUDED.enabled_by,
    enabled_at = EXCLUDED.enabled_at, updated_at = now();

UPDATE public.mink_action_tool_access t
SET enabled = false, enabled_by = NULL, enabled_at = NULL, updated_at = now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.mink_store_access a WHERE a.store_id = t.store_id AND a.enabled
);

UPDATE public.help_articles
SET body = replace(replace(replace(body,
  'Add text document', '+ (Add image or document)'),
  'Add image, PDF or voice', '+ (Add image or document)'),
  'If the control is unavailable, ask your operator to check MINK_MULTIMODAL_ENABLED, the existing Mink invitation and dashboard permissions, and whether the configured Vertex model supports the input in the configured location.',
  'If processing is unavailable, check the store Mink AI switch, dashboard permissions, global MINK_AI_ENABLED runtime switch and configured Vertex model support. The old MINK_MULTIMODAL_ENABLED flag is no longer required.'),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
  'When your operator enables multimodal input, open <strong>+ (Add image or document)</strong> beside the chat composer. Choose one file or choose <strong>Record voice</strong>. Recording needs HTTPS, microphone permission and AudioWorklet support; it stays on your device until you approve processing. Stop to listen, or discard it. Hiding the page discards an active recording. If recording is unavailable, attach a supported WAV file or type your request.',
  'Use <strong>+ (Add image or document)</strong> or drop one file onto the message box for reviewed image, PDF or WAV-file extraction. The separate microphone is now <strong>Dictate message</strong>: consent on first use, speak, then Stop to convert speech into editable message text. It is not a voice attachment. Hiding the page or discarding before Stop cancels dictation. HTTPS, microphone permission and AudioWorklet support are required; otherwise type your request.'),
  updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = $guide$
<h2>One Mink AI switch and a simpler message box</h2>
<p>Platform superadmins now use one <strong>Enable Mink AI</strong> or <strong>Disable Mink AI</strong> button on the store management page. Enabling makes all implemented Mink capabilities available together, including private drafts, approved actions, Website Builder, documents, images and voice extraction. Existing enabled stores receive the same capability settings during this upgrade; disabled stores stay disabled. Older instructions below about separate feature switches are superseded by this single control.</p>
<p>This does not approve actions or start background work. Staff permissions, plan restrictions, credits, processing limits, specific action approvals, and explicit memory/watch consent still apply. Storefront publication and stock changes still require their existing reviews. Disabling prevents new authorized work at subsequent access checks, but cannot undo work or provider requests already completed. Existing records are not deleted. The global MINK_AI_ENABLED runtime switch remains an emergency shutdown. MINK_BETA_REQUIRE_INVITE no longer bypasses store enablement; permission-checked memory inspection and deletion remain available.</p>
<p>In the message box, choose the <strong>plus (+)</strong> button to add an image or document, or drag one file onto the message box. A highlighted drop target appears. Add one file at a time: short UTF-8 .txt/.md files up to 8 KiB and 3,000 characters are read locally; supported images, PDFs and WAV audio are limited to 2 MiB and the format limits below. Unsupported formats, folders and multiple files are rejected. Selecting or dropping a file does not upload or send it.</p>
<p>Use the separate <strong>microphone button</strong> to dictate your message. On first use in this conversation/composer, choose <strong>Start dictation</strong> to consent to Vertex speech-to-text processing and grant microphone permission. Speak, then choose <strong>Stop dictation</strong>. Stop, or the 60-second limit, converts your speech and inserts plain editable text in the message box, not a voice attachment. Correct any misheard words before Send. Nothing is sent as a chat request automatically. HTTPS and browser audio support are required. Provider processing/retention and shared input limits apply; beta transcription deducts no AI credits. Discard or hide the page before stopping to cancel without transcription.</p>
<p>An attachment review panel opens only when needed. Files requiring AI extraction have a separate processing consent step, followed by editable text review. Short text documents need only local text review. Choose <strong>Add reviewed reference to message</strong>, then send your message yourself. Dictation instead inserts text directly for editing, with no audio attachment or reference wrapper. Escape, the close button, or Discard input cancels local attachment/dictation work. Cancelling cannot retract bytes already sent to Vertex. The usual 4,000-character combined message limit applies.</p>
$guide$ || body, updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
  AND body NOT LIKE '%<h2>One Mink AI switch and a simpler message box</h2>%';

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%<h2>One Mink AI switch and a simpler message box</h2>%'
      AND body LIKE '%microphone button%') THEN
    RAISE EXCEPTION 'Mink unified access and composer guidance was not installed';
  END IF;
END $verify$;
