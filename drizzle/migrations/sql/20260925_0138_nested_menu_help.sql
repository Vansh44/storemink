-- Header menus can nest: a header link gains sub-links, those can have their
-- own, and a top-level link with sub-links can carry an image. On a computer
-- the link opens a menu (a short list, or a wide panel with columns and the
-- image); on a phone the drawer drills down one level at a time.
--
-- The header/footer guide's step "Edit the menu links, labels, …" is the only
-- place that describes editing the menu, so it is replaced in place with the
-- same step plus how to build a menu. That step has not been edited since the
-- guide was published in 0020, and it appears once in the article.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<li>Edit the menu links, labels, logo treatment, layout, and available contact or social details.</li>$old$,
      $new$<li>Edit the menu links, labels, logo treatment, layout, and available contact or social details.</li><li>To open a menu from a header link, select <strong>Add sub-link</strong> under it. Add sub-links under those to lay a larger menu out in columns, and add an optional menu image beside them. A link that only opens a menu can leave its address empty. On a computer the menu opens when a shopper points at or selects the link; on a phone it opens one level at a time with a Back button.</li>$new$
    ),
    updated_at = now()
WHERE slug = 'edit-your-header-footer-and-navigation'
  AND status = 'published';
