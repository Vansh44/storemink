-- Forward-only Phase 8A. Reuses the private workflow queue; no recurring jobs.
-- The existing open-return index excludes completed records. Briefs compare
-- all non-rejected/non-cancelled records in two bounded historical windows.
CREATE INDEX IF NOT EXISTS mink_brief_returns_store_created_idx
  ON public.order_returns (store_id, created_at);

ALTER TABLE public.mink_workflow_runs
  DROP CONSTRAINT mink_workflow_runs_template_check;
ALTER TABLE public.mink_workflow_runs
  ADD CONSTRAINT mink_workflow_runs_template_check CHECK (
    template IN ('weekly_trading_report', 'revenue_decline_investigation',
      'product_launch_preparation', 'slow_inventory_promotion',
      'delayed_pickup_review', 'business_brief')
  );

DO $mink_brief$
DECLARE
  guidance text := $guide$<h2>Get a daily or weekly business brief</h2>
<p>Ask &quot;What needs my attention in echos?&quot;, &quot;Give me a weekly business overview&quot; or &quot;Give me a daily brief for Delhi.&quot; Mink prepares one private background brief. You need Analytics View, Products View, Inventory View and Orders View. Existing Mink access and credit rules apply to the chat; the queued brief uses no further Gemini calls. Drafting does not need to be enabled.</p>
<p>Daily means yesterday in your store timezone. Weekly means the last 7 completed local calendar days, compared with the preceding 7 completed days. Today's partial sales are excluded. The card shows the exact periods, timezone and location scope. Online or unassigned orders enter only an unrestricted store-wide scope. Inventory stays separate for each accessible active physical location, up to 50; choose one location for a larger estate.</p>
<p>Four fixed checks show Needs attention, No threshold triggered or Not enough data. Sales attention requires a decline of at least 20%, with at least 5 recognized orders and positive net sales in the previous period. Stock attention means any tracked SKU is low or out at a location, using the Inventory workspace thresholds and zero-or-negative out-of-stock rule. Stock held elsewhere does not hide local shortages; untracked stock is excluded.</p>
<p>Return activity counts return records opened in each period, excluding rejected and cancelled records, scoped by the original order location. It flags a rise of at least 50% with at least 5 preceding records. This is not a return rate. Failed-payment evidence counts orders created in the chosen period whose current payment status is failed; attention requires at least 3 such orders and at least 20% of created orders. This is not a gateway-attempt failure rate or the time a failure happened.</p>
<p>Inventory and payment status are current when collected. Source reads may finish at slightly different times. The brief reports evidence, not invented causes, forecasts or an all-clear. Review live records before acting. No business records are changed, no customer messages are sent, and asking for a daily brief does not enable a recurring schedule. Recurring watches are a later phase.</p>
<p>The progress card supports cancellation and retry after failure. Refreshing does not start another run. Completion uses the existing private workflow notification. Permissions and captured location scope are checked again before every step; a narrowed scope cancels the brief rather than reusing broader evidence. If a data source fails, the run retries or reports failure instead of showing healthy zeroes. Reopen the conversation for the result, or request a new brief for fresher data.</p>$guide$;
BEGIN
  UPDATE public.help_articles
  SET body = body || E'\n' || guidance, updated_at = now()
  WHERE slug = 'use-mink-ai-in-your-dashboard'
    AND status = 'published' AND category_id IS NOT NULL
    AND position('<h2>Get a daily or weekly business brief</h2>' in body) = 0;
  IF NOT EXISTS (
    SELECT 1 FROM public.help_articles
    WHERE slug = 'use-mink-ai-in-your-dashboard'
      AND status = 'published' AND category_id IS NOT NULL
      AND position(guidance in body) > 0
  ) THEN
    RAISE EXCEPTION 'Mink Phase 8A business brief guidance was not installed; apply preceding Help migrations first';
  END IF;
END;
$mink_brief$;
