-- Mink can now read the current blog catalogue and carry one exact owned cover
-- image through the existing private proposal and publication approval. Edit
-- the two Phase 5D paragraphs whose old wording excluded that flow; do not add
-- a release-note section to the merchant guide.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Mink can prepare a private Markdown blog proposal with a title, excerpt, body and optional SEO title and description. Save the proposal, choose <strong>Publish after approval</strong> or <strong>Schedule for later</strong>, then select <strong>Review exact change</strong>. You need <strong>Blogs Manage</strong> permission, drafting access and the separately enabled <strong>Blog publication and scheduling</strong> switch.</p>$old$,
      $new$<p>Mink can read your current blog catalogue and prepare one private Markdown blog proposal with a title, excerpt, body, optional SEO title and description, and one cover image. Ask it to use an existing store image or create a new cover; a generated cover is saved to Media and appears with the editable proposal in the same response. Save the proposal, choose <strong>Publish after approval</strong> or <strong>Schedule for later</strong>, then select <strong>Review exact change</strong>. You need <strong>Blogs Manage</strong> permission and drafting access; creating a new cover also needs <strong>Media Manage</strong> permission. If image creation is not available, ask Mink to use an existing Media or catalogue image instead.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Raw HTML is escaped and sanitized. The blog workflow supports a small Markdown subset and deliberately does not activate Markdown links, attach media, assign categories or tags, feature a post, publish a product/page/storefront version, send a campaign, contact a customer or publish every draft in bulk. Scheduled jobs have no automatic rollback; use the Blogs workspace to unpublish or edit a post after publication.</p>$old$,
      $new$<p>Raw HTML is escaped and sanitized. The blog workflow supports a small Markdown subset and one exact current-store cover image; it does not activate Markdown links, insert images inside the article body, assign categories or tags, feature a post, publish a product/page/storefront version, send a campaign, contact a customer or publish every draft in bulk. Scheduled jobs have no automatic rollback; use the Blogs workspace to unpublish or edit a post after publication.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';
