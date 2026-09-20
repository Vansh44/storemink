-- Image creation can now use the store's own product, category and Media
-- pictures as visual references. Migration 0113 already revised a different
-- sentence inside the paragraph created by 0109, so replace only the two
-- inaccurate sentences. Matching the whole 0109 paragraph would be a no-op.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$If you explicitly ask Mink to create a new decorative picture, say what it is for and describe the scene.$old$,
      $new$If you explicitly ask Mink to create a new picture, say what it is for, describe the scene and name any product, category or saved Media image it should follow. Mink first checks the relevant pictures you can access. It uses an exact matching product, category or Media image as visual reference when one is available, so the new artwork follows the subject you named rather than substituting an unrelated one. Product and offer wording stays editable on the page instead of being added to the picture.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%If you explicitly ask Mink to create a new decorative picture, say what it is for and describe the scene.%';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$A created picture is decoration, not a photograph of your goods, and Mink cannot set one as a product image.$old$,
      $new$The result is AI-generated storefront artwork, not the original catalogue photograph, and Mink cannot replace a product's saved images with it.$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%A created picture is decoration, not a photograph of your goods, and Mink cannot set one as a product image.%';
