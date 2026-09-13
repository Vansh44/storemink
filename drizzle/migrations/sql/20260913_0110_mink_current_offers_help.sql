-- Correct two existing merchant-visible explanations in place: Mink's current
-- offer answer includes the separate named item scope, and the checkout nudge
-- names the eligible product the shopper should add. This is not a release-note
-- section.

UPDATE public.help_articles
SET body = replace(
      replace(
        body,
        $old_questions$<ul><li>What plan is this store using?</li><li>How many products are published or in draft?</li><li>Find a product by its name or SKU.</li><li>What were net sales today, yesterday, over the last 7 or 30 days, month to date, or year to date?</li><li>Which tracked products or variants are low or out of stock?</li></ul>$old_questions$,
        $new_questions$<ul><li>What plan is this store using?</li><li>How many products are published or in draft?</li><li>Find a product by its name or SKU.</li><li>What were net sales today, yesterday, over the last 7 or 30 days, month to date, or year to date?</li><li>Which tracked products or variants are low or out of stock?</li><li>Which offers are running now, scheduled, disabled or unable to run?</li></ul>$new_questions$
      ),
      $old_permissions$<p>Mink AI uses the store from the current dashboard host, the location assignments and the permissions of the signed-in admin. It does not accept a store ID, location ID, role or permission from a message. <strong>Products → View</strong> is required for catalogue tools, <strong>Analytics → View</strong> for sales, and <strong>Inventory → View</strong> for low-stock lists. Asking for a hidden tool by name does not bypass those checks.</p>$old_permissions$,
      $new_permissions$<p>Mink AI uses the store from the current dashboard host, the location assignments and the permissions of the signed-in admin. It does not accept a store ID, location ID, role or permission from a message. <strong>Products → View</strong> is required for catalogue tools, <strong>Analytics → View</strong> for sales, <strong>Inventory → View</strong> for low-stock lists, and <strong>Offers → View</strong> for offer status. Offer answers distinguish an enabled offer from one that can run now by checking its dates, redemption and budget limits, delivery method, and the store-wide automatic-offer switch. For an item offer, Mink reports the named products, variants and categories under <strong>Applies to</strong> separately from the order trigger, so "on any order" does not mean "all products". A running offer may still depend on a particular shopper's basket or other saved conditions. Asking for a hidden tool by name does not bypass those checks.</p>$new_permissions$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%Which tracked products or variants are low or out of stock?%'
  AND body LIKE '%<strong>Inventory → View</strong> for low-stock lists.%';

UPDATE public.help_articles
SET body = replace(
      body,
      $old_nudge$<p><strong>In the cart, when a shopper is close.</strong> If they hold one of something on a buy-1-get-1, they are told "Add 1 more and one is free". This is switched off with <strong>Tell shoppers when they are close to an offer</strong>. It is never shown for an offer that needs a discount code or is limited to a customer group, because that would leak targeting you set deliberately. It also stops once your <strong>Max sets per order</strong> limit is reached, since a further item would earn nothing.</p>$old_nudge$,
      $new_nudge$<p><strong>In the cart, when a shopper is close.</strong> If they hold one eligible product on a buy-1-get-1, the message names what to add — for example, "Add 1 more Almond shake to get one free". This is switched off with <strong>Tell shoppers when they are close to an offer</strong>. It is never shown for an offer that needs a discount code or is limited to a customer group, because that would reveal targeting you set deliberately. It also stops once your <strong>Max sets per order</strong> limit is reached, since a further item would earn nothing.</p>$new_nudge$
    ),
    updated_at = now()
WHERE slug = 'create-and-manage-offers'
  AND status = 'published'
  AND body LIKE '%Add 1 more and one is free%';
