-- Correcting a mistyped mobile at the till.
--
-- WHY THE GUIDE NEEDED IT. 0094 published "If the number is new, StoreMink asks
-- for their first name before you can continue... A name is required: the
-- register no longer records a number on its own." True, and it left a cashier
-- who had mistyped one digit with nothing to do: the details step had no way
-- back, so the only exits were saving a record under the wrong number or
-- cancelling the whole checkout. The register now offers Change number on that
-- step and hands the digits back for correction, which is a change in what
-- staff DO and so belongs in the guide.
--
-- Per AGENTS.md the inaccurate paragraph is REPLACED in place rather than a new
-- section being appended beside it.

UPDATE public.help_articles
SET body = replace(body,
      $old$If the number is new, StoreMink asks for their first name before you can continue, with an optional last name and email, so they are recognised next time. A name is required: the register no longer records a number on its own.</p>$old$,
      $new$If the number is new, StoreMink asks for their first name before you can continue, with an optional last name and email, so they are recognised next time. A name is required: the register no longer records a number on its own. Mistyped it? Select <strong>Change number</strong> above the fields. The digits come back for you to correct, and anything you had typed for the wrong number is cleared.</p>$new$),
    updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published';

-- The Charge walkthrough gains the same escape, in place.
UPDATE public.help_articles
SET body = replace(body,
      $old$<li>For a number StoreMink has not seen, enter their first name, and optionally a last name and email, then select <strong>Save and continue</strong>.</li>$old$,
      $new$<li>For a number StoreMink has not seen, enter their first name, and optionally a last name and email, then select <strong>Save and continue</strong>. Select <strong>Change number</strong> first if the mobile itself is wrong.</li>$new$),
    updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published';

DO $verify$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.help_articles
    WHERE slug = 'process-an-in-store-sale' AND status = 'published'
      AND category_id IS NOT NULL
      AND body LIKE '%The digits come back for you to correct%'
      AND body LIKE '%if the mobile itself is wrong%') THEN
    RAISE EXCEPTION 'In-store sale guide was not updated for correcting a mistyped mobile';
  END IF;
END $verify$;
