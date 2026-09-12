-- Mink can now CREATE a picture, so the two published sentences that promise it
-- never does are the most load-bearing wrong sentences in the guide: a merchant
-- who reads either of them will not ask for the thing the product can do, and a
-- merchant who tries it anyway finds the guide contradicting the screen.
--
-- ⚠ BOTH SENTENCES WERE WRITTEN BY 0105, TWO DAYS AGO, AND WERE TRUE THEN. That
-- is the cost of a guide that describes a boundary rather than a capability:
-- moving the boundary means editing the promise. Each is REPLACED where it
-- stands rather than contradicted by a new section appended below it -- the
-- appending habit 20260910_0093 had to clean up.
--
-- ⚠ THE GUIDE IS ALREADY PAST THE 25,000-CHARACTER / 14-SECTION SPLIT LINE
-- (docs/help-centre.md), and is still not split here for 0102's reason: 21 of
-- its substrings are frozen into earlier migrations' DURABLE `verify` blocks,
-- six of them <h2> headings, so moving them would make the runner refuse every
-- later migration in every environment. Nothing here adds a section or a
-- heading, and both replacements are close to the length they replace.

-- 1. The layout paragraph. It opened with "Mink never generates an image", and
--    the rule after it -- where a picture on a page may come from -- is
--    UNCHANGED and still the thing a merchant must know. So the promise is
--    replaced and the rule is kept word for word, with the one addition that
--    matters: a created picture is not usable until the merchant keeps it.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$Mink never generates an image, and it never makes up an address for one. It can place a picture you already have: a layout proposal may use only pictures from your Media library, or pictures already on the page it is changing. Ask for a hero or a gallery on a page that has no images and Mink will tell you so and ask you to add them first, rather than filling the page with pictures that will not load. Add them under <strong>Media</strong>, or straight from the plus button in the chat when you have the file to hand.$old$,
      $new$Mink never makes up an address for a picture: a layout proposal may use only pictures from your Media library, or pictures already on the page it is changing. If the page needs one you do not have, you can ask Mink to create it. Say where it goes and describe the scene, and it makes one picture and shows it to you, along with the wording screen readers will read out. It costs AI credits, so ask what you already have first. A created picture is decoration, not a photograph of your goods: Mink cannot set one as a product image, and it is not yours to use until you choose <strong>Save to Media Library</strong> on the card. Once saved it behaves like any other picture you uploaded, and putting it on a page is still a proposal you approve. Every created picture carries an invisible marker identifying it as made by AI. You can also add your own under <strong>Media</strong>, or straight from the plus button in the chat when you have the file to hand.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%Mink never generates an image, and it never makes up an address for one.%';

-- 2. The closing summary of the attachment section repeated the promise in
--    shorter form. Two paragraphs answering one question differently is the
--    defect 20260910_0093 exists to remove, so it moves with the paragraph
--    above it. The rest of that sentence -- memories, publishing, stock -- is
--    still true and is kept.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$This feature does not generate images, save memories, publish storefronts, change stock or authorize any other action.$old$,
      $new$Attaching a file does not save memories, publish storefronts, change stock or authorize any other action, and it never creates a picture: asking Mink for a new picture is a separate request you make in the chat.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%This feature does not generate images, save memories%';
