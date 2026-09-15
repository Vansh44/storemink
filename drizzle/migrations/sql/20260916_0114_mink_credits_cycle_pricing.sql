-- Name the shared AI pool for the assistant merchants actually use, align its
-- monthly window to the plan-start anniversary, and let a platform operator
-- control the prices of the three existing top-up packs.

CREATE TABLE IF NOT EXISTS public.mink_credit_pack_prices (
  pack_id text PRIMARY KEY,
  price_inr integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  CONSTRAINT mink_credit_pack_prices_pack_id_check
    CHECK (pack_id IN ('small', 'popular', 'bulk')),
  CONSTRAINT mink_credit_pack_prices_price_check
    CHECK (price_inr > 0 AND price_inr <= 500000)
);

ALTER TABLE public.mink_credit_pack_prices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mink_credit_pack_prices FROM PUBLIC, app_user;
GRANT SELECT, INSERT, UPDATE ON TABLE public.mink_credit_pack_prices TO app_service;

INSERT INTO public.mink_credit_pack_prices (pack_id, price_inr)
VALUES ('small', 59), ('popular', 129), ('bulk', 299)
ON CONFLICT (pack_id) DO NOTHING;

-- Preserve this month's already-used allowance when a paid store moves from a
-- calendar key to its plan-anchored key. GREATEST avoids double-counting if a
-- deployment is retried after the new application has already written there.
INSERT INTO public.ai_usage (store_id, period, used)
SELECT
  usage.store_id,
  'cycle:' || to_char(
    boundary.starts_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ),
  usage.used
FROM public.ai_usage AS usage
JOIN public.billing_subscriptions AS subscription
  ON subscription.store_id = usage.store_id
CROSS JOIN LATERAL (
  SELECT max(
    subscription.current_period_start + (series.offset * interval '30 days')
  ) AS starts_at
  FROM generate_series(0, 240) AS series(offset)
  WHERE subscription.current_period_start IS NOT NULL
    AND subscription.current_period_start + (series.offset * interval '30 days') <= now()
) AS boundary
WHERE usage.period = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
  AND boundary.starts_at IS NOT NULL
ON CONFLICT (store_id, period) DO UPDATE
SET used = greatest(public.ai_usage.used, EXCLUDED.used);

UPDATE public.help_articles
SET title = 'Understand Mink credits and usage',
    excerpt = 'Track included Mink credits, buy non-expiring top-ups, read credit activity, and resolve delayed or blocked usage.',
    body = replace(
      body,
      $old$<p>StoreMink AI can help with product copy, SEO, brand voice, coupon emails, and other supported writing jobs. Every generation uses the store's monthly plan allowance first, then its purchased credit balance.</p>$old$,
      $new$<p>Mink AI and supported StoreMink writing tools use one shared balance called <strong>Mink credits</strong>. Each task uses the store's included plan credits first, then its non-expiring top-up balance.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'understand-ai-usage-and-credits'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      replace(
        replace(
          body,
          'StoreMink keeps subscription and AI-credit documents',
          'StoreMink keeps subscription and Mink-credit documents'
        ),
        'An AI-credit invoice is a paid receipt',
        'A Mink-credit invoice is a paid receipt'
      ),
      'Find StoreMink subscription and AI-credit invoices',
      'Find StoreMink subscription and Mink-credit invoices'
    ),
    excerpt = replace(excerpt, 'AI-credit invoices', 'Mink-credit invoices'),
    seo_description = replace(seo_description, 'AI-credit invoices', 'Mink-credit invoices'),
    updated_at = now()
WHERE slug = 'view-and-pay-storemink-invoices'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<h2>Check monthly usage</h2>
<ol><li>Open <strong>Plan &amp; billing</strong>.</li><li>Find <strong>AI usage this month</strong>.</li><li>Review the number used, the plan allowance, and the remaining amount.</li><li>Check the reset countdown. The monthly allowance resets at the start of the next UTC calendar month.</li></ol>
<p>The allowance depends on the effective plan and is enforced for the whole store, not separately for each staff member.</p>$old$,
      $new$<h2>Check included usage</h2>
<ol><li>Open <strong>Plan &amp; billing</strong>.</li><li>Find <strong>Mink credits &amp; usage</strong>.</li><li>Review the included credits left and the separate top-up balance.</li><li>Check the reset date. Included credits refresh every 30 days, counted from the paid plan cycle start.</li></ol>
<p>The allowance depends on the effective plan and is shared by the whole store, not issued separately to each staff member.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'understand-ai-usage-and-credits'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<h2>How purchased credits work</h2>
<ul><li>Credits are used only after the monthly allowance runs out.</li><li>Purchased and granted credits do not expire.</li><li>Top-ups are available on Free, Basic, and Pro.</li><li>A credit top-up is a separate one-time Razorpay payment and receives its own paid invoice.</li><li>Credits belong to the store and are visible to staff with the required billing or AI access.</li></ul>
<h2>Buy credits</h2>
<ol><li>Under <strong>Top up credits</strong>, compare the current packs.</li><li>Select <strong>Buy now</strong> for the required pack.</li><li>Confirm the pack and amount in the secure payment window.</li><li>Wait for the page to refresh and show the new balance.</li></ol>$old$,
      $new$<h2>How top-up Mink credits work</h2>
<ul><li>Top-up credits are used only after the included allowance runs out.</li><li>Purchased and granted credits do not expire.</li><li>Top-ups are available on every plan.</li><li>A top-up is a separate one-time Razorpay payment and receives its own paid invoice.</li><li>Mink credits belong to the store and are visible to staff with the required access.</li></ul>
<h2>Buy Mink credits</h2>
<ol><li>Under <strong>Top up Mink credits</strong>, compare the current packs and prices.</li><li>Select <strong>Buy now</strong> for the required pack.</li><li>Confirm the pack and amount in the secure payment window.</li><li>Wait for the page to refresh and show the new balance.</li></ol>$new$
    ),
    updated_at = now()
WHERE slug = 'understand-ai-usage-and-credits'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      'Credit packs can be bought on Free, Basic, or Pro when StoreMink credit payments are available.',
      'Mink credit packs can be bought on Free, Basic, or Pro when StoreMink credit payments are available.'
    ),
    updated_at = now()
WHERE slug = 'understand-ai-usage-and-credits'
  AND status = 'published';

UPDATE public.help_articles
SET body = replace(
      body,
      $old$<h2>Read the activity</h2>
<p><strong>Recent credit activity</strong> shows purchases, operator grants, and generations that spent a credit. The current balance never goes below zero, and a payment reference cannot grant the same pack twice.</p>$old$,
      $new$<h2>Read the activity</h2>
<p><strong>Recent Mink credit activity</strong> shows purchases, operator grants, and tasks that spent credits. The current balance never goes below zero, and a payment reference cannot grant the same pack twice.</p>$new$
    ),
    updated_at = now()
WHERE slug = 'understand-ai-usage-and-credits'
  AND status = 'published';
