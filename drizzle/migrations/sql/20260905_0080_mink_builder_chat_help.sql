-- Forward-only Help Centre update. No merchant data or action gates change.
DO $mink_builder$
DECLARE
  guidance text := $guide$<h2>Use Mink while editing your website</h2><p>Open Website Builder and click the purple Mink AI icon in the shared top header. The conversation opens over the right side of the editor, including on wide desktop screens. Resize the panel, expand it to full screen, restore it or close it without leaving Builder. Opening or closing chat does not save or publish your page.</p><p>Ask naturally, for example: &quot;What needs restocking?&quot;, &quot;What pages do I have?&quot; or &quot;Make the first custom-code section on my homepage look better on phones.&quot; You do not need to name internal tools or security rules. Mink may ask a short question when a product, location or requested change is unclear.</p><p>Builder tools read saved page data, not unsaved changes in your editor. Code proposals currently replace one existing custom-code section; they cannot create new sections or generate banner images. Draft saves and publication still need their separate permissions, enabled controls and human approvals. Opening the chat grants no additional access.</p><p>If chat does not appear, refresh after saving any pending editor work and try the top-header icon again. An access or feature-disabled message is different from a hidden panel: ask your administrator to check Mink availability and your permissions.</p>$guide$;
BEGIN
  UPDATE public.help_articles
  SET body = body || guidance, updated_at = now()
  WHERE slug = 'use-mink-ai-in-your-dashboard'
    AND status = 'published'
    AND category_id IS NOT NULL
    AND position('<h2>Use Mink while editing your website</h2>' in body) = 0;

  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND position(guidance in body) > 0
  ) THEN
    RAISE EXCEPTION 'Mink Builder chat guidance was not installed; apply preceding Mink Help migrations first';
  END IF;
END;
$mink_builder$;
