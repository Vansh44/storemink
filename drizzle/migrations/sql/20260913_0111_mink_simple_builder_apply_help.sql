-- Keep the existing Mink picture workflow accurate without adding another
-- release-note section. A supplied product image can be handed over in a
-- follow-up, and safe Website Builder draft changes now apply with one click.

UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        $old_image$If your message clearly asks to use an attached image in a named storefront destination — for example a homepage carousel, hero, banner or gallery — Send saves your image under <strong>Media</strong> and Mink prepares the private page change in the same response.$old_image$,
        $new_image$If your message clearly asks to use an attached image in a named storefront destination — for example a homepage carousel, hero, banner or gallery — or you hand over the product image for the storefront task already being discussed, Send saves your image under <strong>Media</strong> and Mink prepares the private page change in the same response. The attached file is used directly, so you do not need to upload or describe it again.$new_image$
      ),
      $old_apply$You still review and approve the layout before it reaches your Website Builder draft, and publishing remains a separate step in Website Builder.$old_apply$,
      $new_apply$The result shows one <strong>Apply to Website Builder draft</strong> button in chat. It performs the safety check and saves the private draft in one click; publishing remains a separate step in Website Builder.$new_apply$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%If your message clearly asks to use an attached image in a named storefront destination%'
  AND body LIKE '%You still review and approve the layout before it reaches your Website Builder draft%';
