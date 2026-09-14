-- Mink can now propose the storefront's DESIGN — its palette, its two
-- typefaces and its corner radii — so two published paragraphs that describe
-- what Mink can propose, and what an approved save does, now understate it.
-- Both are REPLACED rather than contradicted by a new section appended below
-- them: that appending habit is exactly what 20260910_0093 had to clean up.
--
-- ⚠ THE GUIDE IS ALREADY PAST THE 25,000-CHARACTER / 14-SECTION SPLIT LINE
-- (docs/help-centre.md), and is still not split here for 0102's reason: 21 of
-- its substrings are frozen into earlier migrations' DURABLE `verify` blocks,
-- six of them <h2> headings, so moving them would make the runner refuse every
-- later migration in every environment. Nothing here adds a section or a
-- heading.

-- 1. The capability paragraph is where a merchant looks to find out what is
--    possible. It named two proposals; there are three.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$Mink can propose a page's whole section list — adding, removing, reordering and reconfiguring blocks such as a hero, gallery, testimonials or featured products — for 3 AI credits, and it can separately propose replacement code for one existing custom-code section for 5. Custom code is the boundary between them: a layout proposal must carry every existing custom-code section through unchanged, and cannot add, edit or delete one.$old$,
      $new$Mink can propose a page's whole section list — adding, removing, reordering and reconfiguring blocks such as a hero, gallery, testimonials or featured products — for 3 AI credits; it can propose your storefront's design — its colours, its two typefaces and its corner roundness — for 2; and it can separately propose replacement code for one existing custom-code section for 5. Custom code is the boundary between them: a layout proposal must carry every existing custom-code section through unchanged, and cannot add, edit or delete one. A design proposal changes no page content at all, and it is refused outright if the colours would leave your body text hard to read, so you are told which pairs failed instead of being shown an approve button over an unreadable shop.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%a layout proposal must carry every existing custom-code section through unchanged, and cannot add, edit or delete one. Neither proposal generates images.%';

-- 2. The draft-save paragraph tells a merchant what an approval is about to
--    do. A design save is the one that reaches EVERY page at once, which is
--    the fact a merchant most needs before pressing Approve.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$A code draft save replaces only the reviewed custom-code section. A layout draft save replaces the page's whole section list, so any section you leave out of the proposal is removed — check the <strong>Removed from the page</strong> list on the card before you approve. Neither one changes your header or footer, and neither publishes anything.$old$,
      $new$A code draft save replaces only the reviewed custom-code section. A layout draft save replaces the page's whole section list, so any section you leave out of the proposal is removed — check the <strong>Removed from the page</strong> list on the card before you approve. A design draft save replaces your colours, typefaces and corner roundness on every page at once; anything the proposal leaves unset goes back to inheriting your theme, and the card draws the theme's own colour so you can see what that will look like. None of the three changes your header or footer, and none of them publishes anything.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%Neither one changes your header or footer, and neither publishes anything.%';
