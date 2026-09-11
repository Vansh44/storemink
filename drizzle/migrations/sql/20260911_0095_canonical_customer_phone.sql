-- One stored shape for a customer's number: E.164, always with a country code.
--
-- WHY. `users.phone` was written two ways by the two things that create a
-- customer -- website signup stored Identity Platform's "+919877542162" while
-- the register stored "9877542162" -- and (store_id, phone) is UNIQUE on the
-- STRING, so the same person could hold two rows and neither side could see
-- the other's. The application now writes E.164 on both paths; this brings the
-- rows written before that into the same shape, so a merchant's customer list
-- stops showing two different formats for the same kind of number.
--
-- CAUTION: A ROW WITH A TWIN IS LEFT ALONE, DELIBERATELY. Where a store
-- already holds BOTH "9877542162" and "+919877542162" they are the same
-- person, and rewriting one onto the other would violate the unique key --
-- or, worse, silently merge two customers' history if it did not. Those pairs
-- need a considered merge (their orders, credit and reviews all point at a
-- customer id), which is not something a migration should do unasked. The
-- application matches both shapes, so the till attaches to the right row
-- either way; the report at the end of this file counts what is left.
--
-- Placeholder numbers such as 8888888888 are migrated like any other. The
-- rejection of those belongs to the courier boundary (Shiprocket cannot book
-- one), not to customer identity.

-- Bare national numbers -> +91.
UPDATE public.users u
SET phone = '+91' || u.phone
WHERE u.phone ~ '^[6-9][0-9]{9}$'
  AND NOT EXISTS (
    SELECT 1
      FROM public.users twin
     WHERE twin.store_id = u.store_id
       AND twin.phone = '+91' || u.phone
  );

-- "919877542162", written by nothing current but cheap to fold in.
UPDATE public.users u
SET phone = '+' || u.phone
WHERE u.phone ~ '^91[6-9][0-9]{9}$'
  AND NOT EXISTS (
    SELECT 1
      FROM public.users twin
     WHERE twin.store_id = u.store_id
       AND twin.phone = '+' || u.phone
  );

-- "09877542162".
UPDATE public.users u
SET phone = '+91' || substring(u.phone from 2)
WHERE u.phone ~ '^0[6-9][0-9]{9}$'
  AND NOT EXISTS (
    SELECT 1
      FROM public.users twin
     WHERE twin.store_id = u.store_id
       AND twin.phone = '+91' || substring(u.phone from 2)
  );

-- Report, not a failure: a store with duplicate pairs is in a state a merge
-- has to resolve, and stopping the migration would not help it.
DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT count(*) INTO remaining
    FROM public.users
   WHERE phone !~ '^\+';
  IF remaining > 0 THEN
    RAISE NOTICE
      'canonical phone: % row(s) still hold a legacy shape because the same store already has the E.164 twin; these are duplicate customers needing a merge.',
      remaining;
  END IF;
END $$;

-- The guide told cashiers to type a ten-digit number, which is now only the
-- default. Replaced in place rather than appended to (AGENTS.md).
UPDATE public.help_articles
SET body = replace(body,
      $old$<li>Enter the customer's 10-digit mobile number. The box accepts digits only.</li>$old$,
      $new$<li>Enter the customer's mobile number. The box accepts digits only. It is set to <strong>+91</strong> for India; change the country code beside it first if the number is from somewhere else, and the expected length follows that choice.</li>$new$),
    updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published';

UPDATE public.help_articles
SET body = replace(body,
      $old$<li>Select <strong>Charge</strong>, enter the customer's 10-digit mobile, and select <strong>OK</strong>.</li>$old$,
      $new$<li>Select <strong>Charge</strong>, check the country code, enter the customer's mobile, and select <strong>OK</strong>.</li>$new$),
    updated_at = now()
WHERE slug = 'process-an-in-store-sale' AND status = 'published';
