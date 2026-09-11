-- The till now recognises a shopper who already has an account, and offers
-- name and email fields for a number it has not met.
--
-- WHY THE GUIDE WAS WRONG. users.phone was written in two different shapes by
-- the two things that create a customer: website signup stored Identity
-- Platform's E.164 ("+919877542162") while the register stored the national
-- form ("9877542162"), and (store_id, phone) is UNIQUE on the STRING. So the
-- till could not see an account that already existed and recorded a second,
-- nameless "Customer" row for the same person. The guide described that as
-- intended behaviour ("StoreMink creates and attaches a phone-only customer
-- automatically"), so a merchant reading it had no reason to report the
-- duplicates as a fault.
--
-- Per AGENTS.md, the paragraphs that are now inaccurate are REPLACED rather
-- than a new section being appended beside them.

UPDATE public.help_articles
SET body = replace(body,
      $old$<p>StoreMink does not search while you type. Selecting OK performs one exact lookup. If the mobile already belongs to a customer, their saved name, email and available store credit appear on the Payment screen. If it is new, StoreMink creates and attaches a phone-only customer automatically. Both routes go straight to Payment without another Continue step.</p>$old$,
      $new$<p>StoreMink does not search while you type. Selecting OK performs one exact lookup. If the mobile already belongs to a customer, their saved name, email and available store credit appear on the Payment screen, whether that customer was recorded at the till or created their own account online. If the number is new, StoreMink asks for their first name before you can continue, with an optional last name and email, so they are recognised next time. A name is required: the register no longer records a number on its own.</p>$new$),
    updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
      $old$<p>Check the displayed customer before taking money. Select <strong>Change</strong> to submit a different mobile before the first payment is added. A customer created at the till can connect their in-store history and store credit when they later sign up online with the same verified mobile.</p>$old$,
      $new$<p>Check the displayed customer before taking money. Select <strong>Change number</strong> to submit a different mobile before the first payment is added. A customer recorded at the till keeps their in-store history and store credit when they later create an account online with the same mobile: that account joins the existing record instead of starting a new one, so nobody ends up on your customer list twice.</p>$new$),
    updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published';

-- The Charge walkthrough gains the step, in place.
UPDATE public.help_articles
SET body = replace(body,
      $old$<li>Check the resolved customer on the Payment screen.</li>$old$,
      $new$<li>For a number StoreMink has not seen, enter their first name, and optionally a last name and email, then select <strong>Save and continue</strong>.</li><li>Check the resolved customer on the Payment screen.</li>$new$),
    updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published';
