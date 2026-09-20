-- Mink conversations now spend credits, so three published statements that
-- promised otherwise are corrected in place (AGENTS.md: edit the section that
-- is wrong, never append a section the paragraph above contradicts).
--
-- WHY. Charging shipped switched off and stayed off: the flag was opt-in and
-- was set in no environment, so only proposals were ever billed. Turning it on
-- also raises every plan's included amount in the same move, which is why the
-- plan matrix moves here too -- publishing the new price without the new
-- allowance would read as a straight increase.

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<p>Beta usage records an estimated provider cost, a read-lookup or read-analysis cohort and shadow credits. Shadow credits help StoreMink set fair future weights and do not debit the store's AI-credit balance.</p>$old$,
      $new$<p>Every request you send to Mink uses credits from your store's balance, and the amount depends on how much work the request takes: a short question or a straightforward lookup uses 1 credit, a longer piece of work uses 3, and a large one uses 8. The balance beneath the message box shows what is left, and you can open it to see your plan's monthly amount and any credits you have bought separately.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$Interrupted usage is labelled partial or unavailable instead of being shown as zero cost. The alpha still does not debit AI credits.</p>$old$,
      $new$Interrupted usage is labelled partial or unavailable instead of being shown as zero cost. A request that does not finish costs you nothing: only a completed answer uses credits.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

-- Preparing something to approve keeps its own published price. Say plainly
-- that the two do not add up, or a merchant reading both paragraphs will
-- expect to pay twice for one request.
UPDATE public.help_articles
SET body = replace(
      body,
      $old$The composer estimate is a preview; the server calculates and charges the authoritative amount exactly once when it creates the proposal.</p>$old$,
      $new$The composer estimate is a preview; the server calculates and charges the authoritative amount exactly once when it creates the proposal. When one request both answers you and prepares a proposal, you are charged once, at whichever of the two amounts is higher, never both added together.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard' AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<tr><td>Included AI generations each month</td><td>3</td><td>10</td><td>50</td></tr>$old$,
      $new$<tr><td>Included Mink credits each month</td><td>20</td><td>100</td><td>300</td></tr>$new$
    ),
    updated_at = now()
WHERE status = 'published'
  AND body LIKE '%<tr><td>Included AI generations each month</td>%';

DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM public.help_articles
    WHERE status = 'published'
      AND body LIKE '%do not debit the store%AI-credit balance%') THEN
    RAISE EXCEPTION 'A published guide still promises that Mink requests do not spend credits';
  END IF;
  IF EXISTS (SELECT 1 FROM public.help_articles
    WHERE status = 'published' AND body LIKE '%still does not debit AI credits%') THEN
    RAISE EXCEPTION 'A published guide still describes Mink as not debiting credits';
  END IF;
  IF EXISTS (SELECT 1 FROM public.help_articles
    WHERE status = 'published'
      AND body LIKE '%Included AI generations each month%') THEN
    RAISE EXCEPTION 'The plan matrix still publishes the pre-charging monthly allowance';
  END IF;
END $verify$;
