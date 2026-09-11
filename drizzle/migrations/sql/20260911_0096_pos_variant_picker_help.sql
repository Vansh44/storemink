-- The register catalogue shows one tile per product, then asks which variant.
--
-- WHY. The catalogue query is a LEFT JOIN over products and variants, so the
-- grid rendered every sellable SKU as its own tile: a product in five sizes
-- took five tiles, and twenty such products filled a hundred tiles with twenty
-- things a cashier was actually looking for. Variants now sit behind one tile
-- and a picker; searching and scanning still resolve an exact SKU with no
-- extra tap, because those are the two fastest paths in the shop.
--
-- The step is added to the existing walkthrough rather than appended as a new
-- section (AGENTS.md).

UPDATE public.help_articles
SET body = replace(body,
      $old$<li>Tap a product, scan its barcode, or search by name, SKU, or barcode.</li>$old$,
      $new$<li>Tap a product, scan its barcode, or search by name, SKU, or barcode.</li><li>The catalogue shows one tile per product. A product with options shows how many it has and its price range; tap it and choose the option you need, with its price, stock at this location and SKU shown for each. A product with no options goes straight into the cart.</li>$new$),
    updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published';

-- Searching and scanning deliberately skip the picker; say so, because a
-- cashier who has learnt the picker will otherwise expect it every time.
UPDATE public.help_articles
SET body = $guide$
<h2>Finding a product with options</h2>
<p>The catalogue lists <strong>one tile per product</strong>, not one per option, so a shirt in five sizes takes one tile rather than five. The tile shows how many options the product has and a price range when they differ. Tap it to choose the option, then that exact option goes into the cart.</p>
<p>Each option shows its own price, its stock at this register's location, and its SKU, so you can answer a customer without leaving the screen. An option with no stock is listed but cannot be tapped. The tile itself is only greyed out when every option has run out, because one option in stock still means you can sell the product.</p>
<p>Opening the picker adds nothing to the cart. Press <strong>Escape</strong>, or tap outside it, to go back.</p>
<p><strong>Searching and scanning skip this step.</strong> Type a name, SKU, or barcode and the results are the exact options themselves, so tapping one adds it directly. Scanning a barcode belonging to a specific option adds that option straight away, and works even while the picker is open, because the item in your hand settles the question faster than tapping does.</p>
<p>Stock on a tile is the total across the options behind it, counted at this register's location. A product with no stock tracking shows no figure rather than a zero.</p>
<p>To put a single option on the grid as its own tile, use <strong>Edit layout</strong> and place just that option. Placing two or more options of the same product groups them behind one tile instead.</p>
$guide$ || body,
    updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published'
  AND body NOT LIKE '%<h2>Finding a product with options</h2>%';
