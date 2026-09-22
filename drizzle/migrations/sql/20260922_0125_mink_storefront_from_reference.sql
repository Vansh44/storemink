-- A screenshot of a site a merchant likes now answers both halves of "make my
-- shop look like this": the exact design tokens it already read, and the
-- reference page's block order. The guide's screenshot sentence described only
-- the first, and only for a merchant's own storefront.
--
-- The reference's own wording, photography and logos are deliberately never
-- carried across, so the guide says so where a merchant would otherwise assume
-- the opposite.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$When you attach a screenshot of your own storefront and ask for a change, Mink combines the visual reading with the current Website Builder state before preparing the normal private proposal.$old$,
      $new$When you attach a screenshot of a shop you like and ask for your store to look similar, Mink reads its exact colours, typefaces, corner roundness and the order of the blocks down the page, checks your current Website Builder state, and prepares a private design proposal and a private page-layout proposal for you to review. Wording is written for your own brand and pictures come from your catalogue and Media Library; text, photographs and logos belonging to the shop in the screenshot are never copied. A screenshot of your own storefront works the same way.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published';
