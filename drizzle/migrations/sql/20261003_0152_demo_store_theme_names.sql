-- Theme demo stores carry the theme's own name (2026-10-03).
--
-- Every demo store was created as "<Theme> Demo", and the storefront header
-- shows the brand name, so themes.storemink.com's live preview read
-- "Luxe Demo" on a page whose job is to show the theme as a finished shop.
-- New seeds already use the plain name (lib/themes/demo-store.ts); this
-- renames the demo stores that already exist.
--
-- Scoped to platform-owned demos only: `settings.demo = true`, a `demo-` slug,
-- not a Theme Studio preview (those already show the theme name). Only a
-- trailing " Demo" is removed, so a name somebody has since changed by hand
-- is left alone. Idempotent: a second run matches nothing.
UPDATE public.stores
SET name = left(name, length(name) - length(' Demo')),
    settings = coalesce(settings, '{}'::jsonb)
      || jsonb_build_object(
           'brand',
           coalesce(settings -> 'brand', '{}'::jsonb)
             || jsonb_build_object('name', left(name, length(name) - length(' Demo')))
         )
WHERE (settings -> 'demo') = 'true'::jsonb
  AND NOT (settings ? 'studioPreview')
  AND slug LIKE 'demo-%'
  AND name LIKE '% Demo'
  AND length(name) > length(' Demo');
