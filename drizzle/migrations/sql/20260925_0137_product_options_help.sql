-- Products gained option axes: a merchant names up to three options (Size,
-- Colour), types their values, and the editor creates one variant per
-- combination. Colour options can show swatches. Shoppers pick each option on
-- the product page, and a quick-add card opens the same choices.
--
-- The product guide's "Add variants" steps described typing one free-text
-- name per variant and said the top variant is selected first, which is no
-- longer how the page opens (it opens on the first variant in stock). So the
-- steps list is replaced in place. It is quoted whole because every step
-- changes; the list has not been edited since 0060, which touched only the
-- step naming the sale price.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<ol><li>Select the <strong>Variants</strong> tab.</li><li>Select <strong>Add variant</strong>.</li><li>Enter a clear option name, such as a size or colour.</li><li>Enter its base and selling prices, optional sale price, opening stock, supplier barcode, and images. Cost appears only when gross margin is available for the store.</li><li>Repeat for the remaining options. Use the arrows to reorder variant rows; the top variant is selected first on the product page.</li><li>Save the product.</li></ol>$old$,
      $new$<p>Give a product options when it comes in more than one size, colour or style.</p>
<ol><li>Select the <strong>Variants</strong> tab.</li><li>Under <strong>Options</strong>, select <strong>Add options like size or colour</strong>. Name the option, for example Size, and type each value, pressing Enter after each one. A product can have up to three options, such as Size and Colour.</li><li>For a colour option, tick <strong>Show as colour swatches on the storefront</strong> and pick the colour for each value.</li><li>StoreMink creates one variant for every combination, such as M / Black. Enter each variant's base and selling prices, optional sale price, opening stock, supplier barcode, and images. Cost appears only when gross margin is available for the store.</li><li>Save the product.</li></ol>
<p>Shoppers choose each option separately on the product page. A combination you do not sell, or one that is sold out, is shown crossed out, and the page opens on the first variant in your list that is in stock. On themes with quick add, <strong>+ Add</strong> on a product card opens the same choices without leaving the page. Removing a value removes the variants that use it, so the rules under Removing a variant below apply.</p>
<p>A product with a single kind of choice, such as 500 ml and 1 L, can skip options: select <strong>Add variant</strong> and give each variant a name. If you later add options to it, the existing variant names become the first option's values, so their prices, stock and history are kept.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'add-product-images-and-variants'
  AND status = 'published';
