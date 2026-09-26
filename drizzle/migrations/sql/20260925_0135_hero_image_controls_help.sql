-- Website Builder heroes and hero carousels gained the banner controls a paid
-- theme gives a merchant: a height preset, a focal point that every crop keeps
-- in view, a separate phone image, an overlay strength behind the copy and a
-- text position. Carousels also swipe on phones.
--
-- The section guide's list of section types is the one place a merchant reads
-- what a hero can do, so the sentence is extended in place rather than given a
-- new heading. Quoted at sentence level: nothing since the 0020 baseline has
-- edited this paragraph, and a sentence quote only expires if this sentence
-- changes.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>You can add a hero, hero carousel, featured products, shop by category, promotional banner, tile grid, media with text, gallery, testimonials, video, newsletter form, USP bar, ticker, FAQ accordion, latest blogs, rich text, or custom code.</p>$old$,
      $new$<p>You can add a hero, hero carousel, featured products, shop by category, promotional banner, tile grid, media with text, gallery, testimonials, video, newsletter form, USP bar, ticker, FAQ accordion, latest blogs, rich text, or custom code.</p>
<p>A hero or hero carousel slide can also set a height, from Small to Full screen. After you add its image, click the subject in the <strong>Focal point</strong> preview so desktop and phone crops keep it in view, and add an optional <strong>Phone image</strong> composed for tall screens; phones download only that one. When the text sits on the image, <strong>Overlay</strong> darkens or lightens it behind the words and <strong>Text position</strong> moves them to the top, middle or bottom. Each control has a default that keeps the section exactly as it was. Shoppers on phones can swipe between carousel slides, and slides do not move on their own for anyone who has turned on reduced motion.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'add-and-arrange-storefront-sections'
  AND status = 'published';
