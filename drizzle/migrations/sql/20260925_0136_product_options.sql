-- Product option axes (Size, Colour …) and the positional value each variant
-- takes on them. Until now a variant was one free-text name, so a shopper
-- could not pick a size and a colour separately and a colour could not be
-- shown as a swatch.
--
-- Expand-only and invisible to existing products: every product gets an empty
-- option list and every variant an empty value list, which is exactly the
-- "no options" state the storefront already renders as a flat list of names.
-- The revision being replaced never reads either column, and a constant
-- DEFAULT makes the NOT NULL safe for its inserts.
--
-- A variant keeps its `name`; when its product has options the application
-- writes the composed "M / Black" into it, so every existing reader (cart,
-- order snapshots, invoices, POS, CSV) is untouched.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_options_shape_check;

-- A list of at most three axes. The shape of each axis is validated by the
-- application (lib/products/options.ts); the database refuses only what no
-- reader could interpret. Both functions are total on a NOT NULL jsonb, so
-- this check cannot pass by evaluating to NULL.
ALTER TABLE public.products
  ADD CONSTRAINT products_options_shape_check
  CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 3);

ALTER TABLE public.product_variants
  ADD COLUMN IF NOT EXISTS option_values text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE public.product_variants
  DROP CONSTRAINT IF EXISTS product_variants_option_values_check;

ALTER TABLE public.product_variants
  ADD CONSTRAINT product_variants_option_values_check
  CHECK (cardinality(option_values) <= 3);
