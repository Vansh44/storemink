-- Mink can now USE the pictures a merchant has, and a chat attachment can be
-- kept rather than only read. Three published sentences are therefore wrong or
-- incomplete, and each is REPLACED where it stands rather than contradicted by
-- a new section appended below it -- the appending habit 20260910_0093 had to
-- clean up.
--
-- ⚠ THE GUIDE IS ALREADY PAST THE 25,000-CHARACTER / 14-SECTION SPLIT LINE
-- (docs/help-centre.md), and is still not split here for 0102's reason: 21 of
-- its substrings are frozen into earlier migrations' DURABLE `verify` blocks,
-- six of them <h2> headings, so moving them would make the runner refuse every
-- later migration in every environment. Nothing here adds a section or a
-- heading.

-- 1. "Neither proposal generates images." was true and is now the merchant's
--    likeliest wrong conclusion: it reads as "Mink cannot put a picture on my
--    page", when what it cannot do is INVENT one. The rule a merchant has to
--    know before asking for a hero is where the picture may come from.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$Neither proposal generates images.$old$,
      $new$Mink never generates an image, and it never makes up an address for one. It can place a picture you already have: a layout proposal may use only pictures from your Media library, or pictures already on the page it is changing. Ask for a hero or a gallery on a page that has no images and Mink will tell you so and ask you to add them first, rather than filling the page with pictures that will not load. Add them under <strong>Media</strong>, or straight from the plus button in the chat when you have the file to hand.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%Neither proposal generates images.%';

-- 2. The attachment paragraph promised the file is never kept anywhere. That
--    is still exactly true of processing, and is no longer true of the store's
--    Media library, because there is now a button that puts it there. Left
--    alone, a merchant would not know the button could work.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$StoreMink does not save the raw file in its database, Media library or saved memories; the provider's retention policies still apply.$old$,
      $new$Processing for review keeps no copy of the file: it does not become a media item or a saved memory, though the provider's retention policies still apply. Keeping an image is a separate, deliberate step. Choose <strong>Save to Media Library</strong> beside the attachment and the picture is stored in your own Media library exactly as if you had uploaded it there, and its address is added to your message so Mink can use it straight away. Processing and saving are independent: do either, both or neither.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%StoreMink does not save the raw file in its database%';

-- 3. The closing summary of the same section repeated the promise in shorter
--    form. Two paragraphs answering one question differently is the defect
--    20260910_0093 exists to remove, so it moves with the paragraph above it.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$This feature does not generate or place images, save memories, publish storefronts, change stock or authorize any other action.$old$,
      $new$This feature does not generate images, save memories, publish storefronts, change stock or authorize any other action. Saving an attached image to your Media library is your own upload: it changes nothing on your storefront, and putting that picture on a page is still a separate proposal you review and approve.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%does not generate or place images, save memories%';
