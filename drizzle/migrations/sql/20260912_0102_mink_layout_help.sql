-- Mink can now propose a page's whole SECTION LIST, so three published
-- sentences that told merchants it could not are wrong and are REPLACED
-- rather than contradicted by a new section appended below them. That is
-- exactly the defect 20260910_0093 cleaned up: the Mink guide had grown to
-- 36 sections ordered by engineering phase, with an early paragraph saying
-- the assistant was read-only above the sections explaining how it writes.
--
-- ⚠ THE GUIDE IS ALREADY PAST THE 25,000-CHARACTER / 14-SECTION SPLIT LINE
-- (docs/help-centre.md). It is not split here because 21 substrings of it are
-- frozen into earlier migrations' DURABLE `verify` blocks, six of them <h2>
-- headings, so moving them would make the runner refuse every later migration
-- in every environment. Splitting it needs those blocks retired first, which
-- is its own change. Nothing here adds a section or a heading.

-- 1. The intro's list of what Mink will not do named adding a section.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$publishes a product, adds a storefront section, edits your header or footer, or touches StoreMink's own code.$old$,
      $new$publishes a product, edits your header or footer, or touches StoreMink's own code.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%adds a storefront section%';

-- 2. The draft-save paragraph promised the opposite of what a layout save does.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$The draft save replaces only the reviewed custom-code section. It does not add a section or change header or footer.$old$,
      $new$A code draft save replaces only the reviewed custom-code section. A layout draft save replaces the page's whole section list, so any section you leave out of the proposal is removed — check the <strong>Removed from the page</strong> list on the card before you approve. Neither one changes your header or footer, and neither publishes anything.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%It does not add a section or change header or footer.%';

-- 3. The limitations paragraph is where a merchant looks to find out what is
--    possible, so it carries the new capability and its real boundary.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$Code proposals currently replace one existing custom-code section; they cannot create new sections or generate banner images.$old$,
      $new$Mink can propose a page's whole section list — adding, removing, reordering and reconfiguring blocks such as a hero, gallery, testimonials or featured products — for 3 AI credits, and it can separately propose replacement code for one existing custom-code section for 5. Custom code is the boundary between them: a layout proposal must carry every existing custom-code section through unchanged, and cannot add, edit or delete one. Neither proposal generates images.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%they cannot create new sections%';
