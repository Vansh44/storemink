-- A created picture is now kept automatically, and a request that names a page
-- destination continues through the layout proposal in the same conversation
-- turn. Edit the paragraph that still asks the merchant to press Save; do not
-- append a release-note section or disturb the separate attachment guidance.
--
-- The guide is already over the ordinary split threshold, but its headings and
-- several passages are frozen by old durable verifications. This replacement
-- adds no heading and removes the obsolete manual hand-off in place.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$Mink never makes up an address for a picture: a layout proposal may use only pictures from your Media library, or pictures already on the page it is changing. If the page needs one you do not have, you can ask Mink to create it. Say where it goes and describe the scene, and it makes one picture and shows it to you, along with the wording screen readers will read out. It costs AI credits, so ask what you already have first. A created picture is decoration, not a photograph of your goods: Mink cannot set one as a product image, and it is not yours to use until you choose <strong>Save to Media Library</strong> on the card. Once saved it behaves like any other picture you uploaded, and putting it on a page is still a proposal you approve. Every created picture carries an invisible marker identifying it as made by AI. You can also add your own under <strong>Media</strong>, or straight from the plus button in the chat when you have the file to hand.$old$,
      $new$Mink never makes up an address for a picture: a layout proposal may use only pictures from your Media library, pictures already on the page it is changing, or a new picture Mink has just created for you. If you explicitly ask Mink to create a picture, say what it is for and describe the scene. Mink uses the intended placement to choose a suitable shape, makes one picture, saves it under <strong>Media</strong> and shows it to you with the wording screen readers will read out. If that same request names a page destination, such as a homepage hero or promotional banner, Mink also prepares the page change in the same response. You still review and approve that layout before it reaches your Website Builder draft, and publishing remains a separate step in Website Builder. Image generation costs AI credits; for a page redesign that does not require a new picture, Mink checks the images you already own first. A created picture is decoration, not a photograph of your goods, and Mink cannot set one as a product image. Every created picture carries an invisible marker identifying it as made by AI. You can also add your own under <strong>Media</strong>, or straight from the plus button in the chat when you have the file to hand.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%it is not yours to use until you choose <strong>Save to Media Library</strong>%';
