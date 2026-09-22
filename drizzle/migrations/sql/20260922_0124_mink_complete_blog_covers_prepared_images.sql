-- Finish the two merchant-visible image hand-offs: a new Mink blog always
-- carries its cover into the proposal, and an attached authentic photo is
-- fitted to its destination without asking the merchant to resize or reupload.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Mink can read your current blog catalogue and prepare one private Markdown blog proposal with a title, excerpt, body, optional SEO title and description, and one cover image. Ask it to use an existing store image or create a new cover; a generated cover is saved to Media and appears with the editable proposal in the same response. Save the proposal, choose <strong>Publish after approval</strong> or <strong>Schedule for later</strong>, then select <strong>Review exact change</strong>. You need <strong>Blogs Manage</strong> permission and drafting access; creating a new cover also needs <strong>Media Manage</strong> permission. If image creation is not available, ask Mink to use an existing Media or catalogue image instead.</p>$old$,
      $new$<p>Mink can read your current blog catalogue and prepare one private Markdown blog proposal with a title, excerpt, body, optional SEO title and description, and one cover image. Every new Mink blog includes a cover by default: unless you supply or choose an existing store image, Mink creates a 16:9 editorial cover, saves it to Media and attaches that exact image to the editable blog proposal in the same response. You do not need to copy its URL or open the blog editor to finish the hand-off. If an existing image has a different shape, StoreMink preserves the original and prepares a correctly shaped Media copy without cutting through the subject. In the normal blog editor you can also upload a cover or paste an existing Media Library URL. Save the proposal, choose <strong>Publish after approval</strong> or <strong>Schedule for later</strong>, then select <strong>Review exact change</strong>. You need <strong>Blogs Manage</strong> permission and drafting access; creating a cover, or saving a reshaped copy of one, also needs <strong>Media Manage</strong> permission. Without it Mink uses the image you chose exactly as it is.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

-- ★★ SENTENCE-LEVEL, NOT PARAGRAPH-LEVEL, AND THAT IS WHY THIS MIGRATION
-- FAILED ITS OWN POSTCONDITION ON THE FIRST ATTEMPT. It quoted this whole
-- paragraph as 20260920_0120 published it -- but 20260921_0121 had already
-- rewritten the paragraph's closing sentence in place, so `replace()` matched
-- nothing, the edit silently did not happen, and applyVerify refused the
-- deploy. A paragraph quote expires the moment ANY sibling migration edits ANY
-- part of it. Quote only the sentences being changed.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$When you ask to create a product from an attached product photo, Mink carries that exact saved image into the private product proposal.$old$,
      $new$When you ask to create a product from an attached product photo, Mink keeps the authentic photograph complete and automatically prepares a square Media copy when its shape does not suit a product card, then carries that exact prepared image into the private product proposal. A blog cover is prepared at 16:9 in the same way. The original upload is never cropped or overwritten.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$You still review and approve any product or storefront change separately.$old$,
      $new$You still review and approve any product, blog or storefront change separately.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';
