-- Every active category now has its own storefront page at
-- /collections/<handle>, which is what menus, homepage category tiles, search
-- suggestions and product breadcrumbs link to. Old /shop?category= links still
-- arrive at the same page.
--
-- The categories guide's sentence about the handle is the only place the
-- handle's storefront role is described, so it is replaced in place. That
-- sentence has not been edited since the guide was published in 0021, and it
-- appears once in the article.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Use a stable handle because it becomes part of storefront browsing and import matching.</p>$old$,
      $new$<p>Use a stable handle: it becomes the address of the category's own page on your storefront, <code>/collections/your-handle</code>, and is used to match products in an import. Link to that address from your menus and pages. Changing the handle later breaks links people have already saved or shared.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'organize-products-with-categories-and-card-colours'
  AND status = 'published';
