-- Website Builder sections can wear a named colour scheme (Soft, Tinted,
-- Brand, Dark) from the Style tab, which sets the section's background, text,
-- cards and buttons together. The Tinted and Contrast presets apply the Soft
-- and Dark schemes instead of a raw background colour.
--
-- The section guide's "Arrange the page" paragraph is where a merchant reads
-- how to shape a page, so the guidance follows its last sentence rather than
-- taking a new heading. Quoted at sentence level: nothing since the 0020
-- baseline has edited this paragraph.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$Undo can restore a recent change while the editing session is open.</p>$old$,
      $new$Undo can restore a recent change while the editing session is open.</p>
<p>To set a section apart, select it, open the <strong>Style</strong> tab and choose a <strong>Colour scheme</strong>: Soft, Tinted, Brand or Dark. A scheme changes the section's background, text, cards and buttons together, in your theme's colours, so the words stay readable. Each swatch shows the colours you will get, and a note appears if a scheme is hard to read with your current brand colours. Choose <strong>Page</strong> to return to your page's own colours. Carousels and promotional banners sit on their own photo and have no scheme. The <strong>Tinted</strong> and <strong>Contrast</strong> presets apply the Soft and Dark schemes.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'add-and-arrange-storefront-sections'
  AND status = 'published';
