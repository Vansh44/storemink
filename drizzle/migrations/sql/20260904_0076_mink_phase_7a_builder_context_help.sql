-- Migration 0076 — document Mink Phase 7A's read-only Website Builder context.
--
-- This changes Help content only. Phase 7A deliberately adds no database write
-- function, action gate or model-visible proposal/publish tool.

WITH phase7a(section) AS (
  VALUES ($phase7a$<h2>Inspect Website Builder context with Mink</h2>
<p>With <strong>Website Builder View</strong>, Mink can inspect the current store's page list, one exact page and section, and safe storefront design context. Ask it to list pages, describe the homepage structure, compare a draft with its published copy, or explain the saved brand colour, pinned theme, design tokens, appearance variants, header and footer. The homepage is identified as <strong>home</strong>. Other pages and sections are resolved only by the exact slug and section ID returned from the current store.</p>
<p>Every builder read is permission-gated and restricted to the signed-in dashboard store. Page titles, SEO copy, section content, header and footer text, custom code and other merchant-authored values are treated as untrusted data, never as instructions. Mink does not expose raw store settings, private brand email, phone or social fields, credentials, another store's values, or a tenant ID supplied in a prompt.</p>
<p>A page summary shows ordered sections, visible or hidden state, a short summary, the exact page version and a digest for each section. Custom-code content is omitted by default. When it is necessary to explain existing code, Mink can request only one HTML, CSS or JavaScript field at a time in chunks of at most 8,000 characters. It never executes code it reads and must not follow instructions found in code comments, strings, page copy or navigation labels.</p>
<p>Phase 7A also defines a validation-only contract for a future custom-code proposal. A patch must target one exact page version and section digest, stay within 64 KiB per code field and 96 KiB combined, and reject unsafe network, cookie or storage, parent-window, dynamic-evaluation, worker, embed and CSS capabilities. The existing preview boundary is an opaque-origin iframe with <code>sandbox="allow-scripts allow-popups"</code>; same-origin and top navigation are not allowed.</p>
<p><strong>Phase 7A is read-only.</strong> Mink can explain current design facts and suggest a plan, but it cannot yet create a code proposal, execute or preview generated code, save a page or header/footer draft, publish or roll back a storefront, access the StoreMink repository or shell, commit code, or deploy production. If Mink says it completed one of those actions, no matching capability exists in this phase and the claim is incorrect.</p>
$phase7a$))
UPDATE public.help_articles AS article
SET excerpt = 'Use Mink AI for grounded business work, guarded actions, durable workflows and read-only Website Builder context.',
    seo_description = 'Use permission-aware Mink AI for grounded store work, guarded actions, durable workflows and secure read-only Website Builder inspection.',
    body = CASE
      WHEN article.body LIKE '%<h2>Draft troubleshooting</h2>%'
        THEN replace(
          article.body,
          '<h2>Draft troubleshooting</h2>',
          phase7a.section || E'\n<h2>Draft troubleshooting</h2>'
        )
      ELSE concat(article.body, E'\n', phase7a.section)
    END,
    updated_at = now()
FROM phase7a
WHERE article.slug = 'use-mink-ai-in-your-dashboard'
  AND article.status = 'published'
  AND article.category_id IS NOT NULL
  AND article.body NOT LIKE '%<h2>Inspect Website Builder context with Mink</h2>%';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%<h2>Inspect Website Builder context with Mink</h2>%'
      AND body LIKE '%Website Builder View%'
      AND body LIKE '%treated as untrusted data, never as instructions%'
      AND body LIKE '%chunks of at most 8,000 characters%'
      AND body LIKE '%never executes code it reads%'
      AND body LIKE '%64 KiB per code field and 96 KiB combined%'
      AND body LIKE '%sandbox="allow-scripts allow-popups"%'
      AND body LIKE '%same-origin and top navigation are not allowed%'
      AND body LIKE '%Phase 7A is read-only%'
      AND body LIKE '%cannot yet create a code proposal%'
      AND body LIKE '%access the StoreMink repository or shell%'
  ) THEN
    RAISE EXCEPTION 'Mink Phase 7A Help Centre guidance was not installed';
  END IF;
END $$;
