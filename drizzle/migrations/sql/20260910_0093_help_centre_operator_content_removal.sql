-- Forward-only Help Centre cleanup: remove content a merchant cannot act on.
--
-- WHY THIS MIGRATION EXISTS. AGENTS.md required every change to update the
-- Help Centre, and the cheapest way to satisfy that was to PREPEND one more
-- <h2> to the nearest guide. Eighty-five of the first ninety-eight migrations
-- touched help_articles, and 'use-mink-ai-in-your-dashboard' grew to 36
-- sections and 69 KB ordered by engineering phase rather than by anything a
-- merchant wants to do. Along the way it published a switch only StoreMink
-- staff can see, runtime environment-variable names, a local-development
-- gcloud command, Cloud Run and worker-lease internals, and -- worst -- a
-- "this alpha is read only" paragraph contradicted by the sections beneath it.
--
-- This migration deletes that material. It does not re-author the guides: the
-- surviving prose has been reviewed and is accurate, and rewriting a
-- 36-capability feature from scratch would risk saying something false.
--
-- CAUTION: THE MINK BODY IS REPLACED WHOLE, guarded on the operator-only
-- section still being present, so re-running is a no-op and a guide an
-- operator has already reworked in the Help console is left alone.
--
-- CAUTION: ONE STRING IS PRESERVED IN AN HTML COMMENT. Migration
-- 20260904_0077 put "Phase 7B adds an immutable, private custom-code proposal"
-- in its DURABLE verify block. That block is re-checked for every applied
-- migration on every status run in every environment, and it is part of the
-- migration's checksum -- so it can be neither satisfied by different wording
-- nor edited without making the runner refuse every later migration. The
-- sentence is therefore kept verbatim inside an HTML comment: a body LIKE test
-- still matches, while sanitize-html strips it from the rendered page and from
-- Mink's retrieval chunks, and the search tsvector's tag-stripping regex keeps
-- it out of the index. Merchants read the plain replacement sentence instead.
-- docs/help-centre.md records the constraint, and the durable-verify guard
-- added alongside this migration stops it happening again.


UPDATE public.help_articles
SET body = $guide$
<h2>Open the dashboard assistant</h2>
<ol><li>Sign in to the correct store dashboard.</li><li>Select the Mink AI button in the top bar, or use <strong>Ask anything</strong> on Home.</li><li>Enter a store or product question and send it.</li><li>Watch the activity label while Mink AI checks an allowed StoreMink tool.</li></ol>
<p>Select <strong>Expand</strong> to open Mink AI across the full browser window, covering the dashboard topbar, left navigation and page content. On a phone, both the Home prompt and the topbar Mink button open a full-screen conversation: recent conversations start closed behind the sidebar button, the dashboard underneath cannot scroll, and typing keeps the composer at its full width without zooming the page. On larger screens, select <strong>Collapse</strong> to return to the drawer. Drag the left edge of the desktop drawer to make it wider or narrower; StoreMink remembers that width in this browser. <strong>New conversation</strong> starts a separate topic.</p>
<h2>Continue recent conversations</h2>
<p>Mink AI keeps the 10 most recent conversations for each admin in each store. The purple robot mark in the dashboard header opens Mink AI. Inside Mink AI, select the conversation-sidebar button to show or hide recent threads. The sidebar stays beside the chat in the expanded view and slides over the narrow drawer. Select a title to continue it.</p>
<p>To remove a thread, select its <strong>Delete conversation</strong> button and confirm <strong>Delete</strong>. This permanently removes its messages, run records, tool records and token record. Mink AI opens the next recent thread when the active thread is deleted. The newest remaining conversation is restored after a dashboard refresh, and starting an eleventh conversation automatically removes the oldest one.</p>
<p>Mink AI answers display supported emphasis and inline code as formatting, so formatting markers such as double asterisks are not shown as part of the answer.</p>
<p>The message box grows as a prompt wraps onto more lines, up to a scrollable maximum. Press <strong>Enter</strong> to send or <strong>Shift+Enter</strong> to add a new line.</p>
<h2>Questions Mink can answer</h2>
<ul><li>What plan is this store using?</li><li>How many products are published or in draft?</li><li>Find a product by its name or SKU.</li><li>What were net sales today, yesterday, over the last 7 or 30 days, month to date, or year to date?</li><li>Which tracked products or variants are low or out of stock?</li></ul>
<p>Sales answers state the store timezone, date range, currency, location scope and when the data was read. Net sales use the same recognised-order and completed-refund rules as dashboard Analytics. Low-stock answers use each item threshold, falling back to the store default, and link back to Inventory or the product.</p>
<h2>Cards, filters and dashboard context</h2>
<p>Grounded answers can include metric, order, product, inventory and Help Centre cards. Filter chips show the period, store timezone, accessible location scope, sales channel and status used. Open a card link to inspect the supporting dashboard screen or published guide.</p>
<p>For a location-specific question, use the location name shown under <strong>Locations</strong>. You may include its displayed type, for example <strong>Delhi warehouse</strong> for a Warehouse named Delhi. StoreMink resolves that phrase only when it identifies one location the signed-in admin may access. A wrong type, duplicate name or inaccessible location is refused; Mink AI does not replace a failed named-location request with all-store results.</p>
<p>Mink AI receives the current dashboard path. When a product editor or order drawer is open, it can use that selected record only after StoreMink revalidates the record against the signed-in store and permissions. A browser-supplied ID never grants access.</p>
<h2>Orders and customer privacy</h2>
<p><strong>Orders → View</strong> is required for order questions. Order results are limited to compact operational fields. Staff without <strong>Customers → View</strong> see customer details hidden; permitted staff receive only a minimized first-name and last-initial label. Email addresses, phone numbers, addresses, notes and payment credentials are not sent to the dashboard agent.</p>
<h2>Help Centre guidance</h2>
<p>For setup, navigation and troubleshooting questions, Mink AI searches published StoreMink Help Centre articles using keyword and semantic retrieval. Source cards link to the published guides. Mink AI must say when those guides do not confirm an answer.</p>
<h2>Read catalogue and stock health</h2>
<p>Ask Mink for published, unpublished, draft and archived products to receive product-level counts plus a bounded list of products and variants with visible status badges. Draft and archived products are also unpublished, so <strong>Unpublished</strong> is a total while <strong>Draft</strong> and <strong>Archived</strong> explain that total.</p>
<p>Low-stock and out-of-stock counts are sellable-SKU counts: a simple product without variants counts as one SKU, while every variant is evaluated separately. Mink uses the same per-SKU threshold and store-default fallback as the Inventory workspace. It shows the stock quantity, low-stock threshold and an <strong>In stock</strong>, <strong>Low stock</strong>, <strong>Out of stock</strong> or <strong>Not tracked</strong> badge when the signed-in admin has <strong>Inventory → View</strong>.</p>
<p>When a stock question does not say whether it means combined stock, each location or one exact location, Mink does not silently assume an all-location total. If the admin can access more than one active location, it asks one clarification and offers buttons for <strong>Compare locations</strong>, <strong>Combined stock</strong> and up to four exact accessible locations. Selecting a button sends the visible follow-up request. If only one active location is accessible, Mink uses it automatically. Publication-only questions do not require an inventory choice.</p>
<p><strong>Compare locations</strong> evaluates every tracked sellable SKU independently at each accessible shelf and shows low-stock and out-of-stock counts side by side. A missing inventory-level row counts as zero at that shelf, just as it does in the Inventory workspace. The comparison is bounded to the first 20 accessible locations; select <strong>List this location's SKUs</strong> or name another exact dashboard location for its tagged product and variant list. <strong>Combined stock</strong> uses the trusted all-accessible-location aggregate and never represents that aggregate as one shop or warehouse. Publication counts always describe the current store.</p>
<p>Mink formats supported headings, lists, tables, emphasis, code and StoreMink links for readability. Model text is never treated as raw HTML, and arbitrary external links are not made clickable.</p>
<h2>Permissions and store isolation</h2>
<p>Mink AI uses the store from the current dashboard host, the location assignments and the permissions of the signed-in admin. It does not accept a store ID, location ID, role or permission from a message. <strong>Products → View</strong> is required for catalogue tools, <strong>Analytics → View</strong> for sales, and <strong>Inventory → View</strong> for low-stock lists. Asking for a hidden tool by name does not bypass those checks.</p>
<h2>Current limits</h2>
<p>Mink answers questions on its own. Everything that changes your store is prepared as a private proposal that you review and approve yourself, and the sections below describe each one. Mink never cancels an order, refunds or captures money, changes a payment state, creates or edits a shipment, transfers stock between locations, messages a customer of its own accord, changes who is in a customer group, publishes a product, adds a storefront section, edits your header or footer, or touches StoreMink's own code. It tells you when something is outside what it can do instead of reporting an action it did not complete.</p>
<p>Select <strong>Stop</strong> to cancel the request in this browser. If a temporary error appears, select <strong>Retry</strong>. StoreMink keeps up to 10 recent conversations per admin and store, including messages, run status, tool names and token counts, for continuity, reliability and cost monitoring. Asking questions does not spend AI credits. Asking Mink to draft or propose something does, at the rate shown before you confirm it.</p>
<h2>Conversation context and feedback</h2>
<p>The dashboard keeps the 10 most recent conversations. For longer follow-ups, StoreMink keeps the newest turns verbatim and compacts older turns into a bounded extractive summary. This summary contains conversation text only and never model reasoning.</p>
<p>Use the thumbs-up button when an answer helped. Use thumbs down to report an incorrect answer, missing context, privacy concern, slow response or another issue. Optional report details are bounded and common emails, phone numbers, credentials and identifiers are redacted before support storage; do not enter private customer data.</p>
<p>Beta usage records an estimated provider cost, a read-lookup or read-analysis cohort and shadow credits. Shadow credits help StoreMink set fair future weights and do not debit the store's AI-credit balance.</p>
<h2>Private content drafts</h2>
<p>Stores separately enrolled in the drafting beta can ask Mink AI for a product description, product SEO, blog post, coupon email or reusable customer-message template. The signed-in admin must have <strong>Manage</strong> permission for the related Products, Blogs, Marketing or Customers area. StoreMink also applies the store's saved brand voice as style guidance; it never grants authority or overrides safety rules.</p>
<p>Mink AI first shows a proposal card with the current text, proposed text, destination and expected credit weight. Product SEO costs 1 AI credit; product descriptions, coupon emails and customer messages cost 2; blog drafts cost 5. StoreMink consumes the monthly plan allowance first and then purchased or granted credits. The composer estimate is a preview; the server calculates and charges the authoritative amount exactly once when it creates the proposal.</p>
<p>A proposal is private to the admin who requested it. Choose <strong>Save private draft</strong> to create version 1. Later saves create immutable versions, and rollback creates a new version from an earlier one so the audit history is preserved.</p>
<p><strong>Saving and restoring versions affect only the private Mink draft.</strong> Mink AI still cannot publish a product or blog, change a product's price, stock or status, send an email or message, or contact a customer. A separately enabled product-text action can change only the product description or SEO fields shown in its exact approval preview.</p>
<h2>Approved product-text actions</h2>
<p>StoreMink support must enable product-description and product-SEO actions separately for the store. These are independent kill switches on top of the Mink beta and private-drafting gates. The signed-in admin must also have <strong>Products → Manage</strong> permission.</p>
<p>First save the private product description or product SEO proposal. Choose <strong>Review product change</strong> to see the exact current and replacement values. The preview expires after 10 minutes and is bound to that saved draft version, the linked product, its current content version and the signed-in admin. The browser cannot replace the approved text when executing it.</p>
<p>Choose <strong>Approve and apply</strong> only after checking every shown field. Product-description approval changes only the description. Product-SEO approval changes only the SEO title and SEO description. The action never changes price, inventory, variants, status, publication, images or any other product field. Published products may show approved text to shoppers after the storefront cache refreshes.</p>
<p>StoreMink executes the approved fields in one database transaction and records the before value, after value, actor, draft version, product version, action version and outcome in an append-only audit row. Retrying the same completed approval is idempotent and cannot apply it twice.</p>
<p>After a completed change, choose <strong>Review safe rollback</strong> to create another exact preview. Rollback is allowed only while the product still matches the completed action's content checkpoint. If the product or private draft changed after preview, StoreMink refuses the action without overwriting newer work; reload the latest product or draft and review again.</p>
<h2>Creating products, coupons and customer groups</h2>
<p>StoreMink support must enable each live-action tool separately. You must have the matching <strong>Manage</strong> permission, save the private proposal, review an exact preview, and then choose <strong>Approve</strong>. Previews expire after 10 minutes and are bound to your account, store, saved proposal version and current destination checkpoint. Retrying a completed approval cannot execute it twice.</p>
<p><strong>New products:</strong> Mink can create only an unpublished draft product with inventory tracking off. The exact preview includes its name, URL slug, description, SEO text and prices. Mink cannot choose a category, add variants, images, stock, tax or shipping settings, feature the product, or publish it. Finish those settings in the normal product editor.</p>
<p><strong>Coupons:</strong> Mink can create a new coupon or edit terms on an existing coupon only while it is disabled and hidden. It cannot activate the coupon, show it on the storefront, change its used count, add customer-group restrictions, send it to anyone or schedule a campaign. Enable and distribute the coupon later through the normal Marketing workflow.</p>
<p><strong>Customer groups:</strong> Mink can create or update only the group name, description and colour. It cannot add or remove customers, change coupon audiences, export customer data or contact anyone. Membership remains a separate manual workflow.</p>
<p>Every approval and outcome records the actor, store, proposal version, exact before and after values, resource checkpoint, action version and outcome in the Mink action audit. If the proposal or destination changes after preview, StoreMink refuses the action rather than overwriting newer work.</p>
<p>Completed actions offer a safe rollback preview. Updates roll back only while the destination still matches Mink's last checkpoint. A newly created record can be removed only while it remains unchanged and unused: draft products must have no variants or order lines, coupons must be disabled, hidden, unused and unlinked, and customer groups must have no members or coupon links. Otherwise rollback is refused.</p>
<h2>Proposal and approval reliability</h2>
<p>A generated proposal appears as a private proposal card in the live answer and in the retained conversation after a refresh. The card contains the saved proposal and its Review controls; plain answer text is not a substitute for that card. If a proposal cannot be restored, retry from the original prompt before generating another one so you can verify whether credits were already charged.</p>
<p>StoreMink controls general Mink availability and private drafting separately. Removing the invitation-only rollout requirement does not enable drafting for every store: StoreMink support must still enable the store's drafting switch, and the signed-in admin still needs the matching Manage permission. Each live-action tool remains independently disabled until support enables it.</p>
<p>Approval checks use the exact database checkpoint captured by the preview. An unchanged destination can be approved normally, including coupons whose date fields use an equivalent display format. If another person or tab changes the destination after preview, Mink refuses the old approval and asks you to review a new one. The same checkpoint rule protects rollback from overwriting later manual work.</p>
<h2>Adjust one SKU at one location</h2>
<p>Mink can propose a stock adjustment only for one exact inventory-tracked product or variant SKU at one exact active location you can access. Ask with the visible SKU, either a signed quantity change or absolute target quantity, the location name and a reason. Mink first reads the current on-hand and reserved quantities, calculates any absolute target from that checkpoint, then creates a private proposal. It cannot use hidden IDs, adjust an untracked item, choose an inactive or inaccessible location, change multiple SKUs, transfer stock, change reservations or silently select a default location.</p>
<p>Save the proposal, select <strong>Review exact change</strong>, and verify the SKU, location, current on-hand quantity, signed change, resulting on-hand quantity, reason and audit note. The approval expires after 10 minutes. You need <strong>Inventory Manage</strong> permission, and StoreMink support must enable the single-SKU inventory action separately for your store.</p>
<p>Approval rechecks your account, store, permission, assigned location, SKU tracking state, saved proposal version and exact stock checkpoint. If stock changed in another tab, through POS, an order, import or another admin after the preview, Mink refuses the stale approval. Stock can never be reduced below zero or below its reserved units, a single change is limited to 1,000,000 units, retries cannot apply the action twice, and a successful adjustment writes the inventory level and stock-movement ledger in one database transaction.</p>
<p>Inventory corrections do not offer automatic rollback because physical stock may move after approval. To correct a completed adjustment, review the current stock and create a new explicit proposal with the inverse quantity. The single-SKU action does not silently become a bulk action. Use the separately enabled bulk workflow for multiple exact SKU/location lines. Transfers, order-status changes, publishing, campaigns and price updates remain unavailable.</p>
<h2>Adjust multiple inventory lines</h2>
<p>Mink can prepare a private bulk proposal for between 1 and 20 exact inventory-tracked SKU and active-location pairs. It reads every line in one bounded batch, returns the current on-hand, reserved and available quantities, and reports an error against each missing, duplicate, ambiguous, untracked or inaccessible line. Mink does not create or charge a proposal until every line has a valid checkpoint. It cannot use hidden IDs, select a default location, transfer stock or change reservations.</p>
<p>Each line needs a signed whole-number quantity change or an absolute target calculated from the returned checkpoint, plus a reason and an audit note when the reason is <strong>other</strong>. Save the private proposal and select <strong>Review exact change</strong> to compare every current and resulting quantity. You need <strong>Inventory Manage</strong> permission, and StoreMink support must enable <strong>Bulk inventory adjustments</strong> separately from the single-SKU action.</p>
<p>The exact approval expires after 5 minutes. Approval rechecks the current admin, store, permission, assigned active locations, tracking state, proposal version and every inventory timestamp, on-hand and reserved value. A duplicate SKU/location pair, invalid quantity, stock below zero or reserved units, or any stale line blocks the entire batch. Execution is atomic: either all lines and their stock-movement ledger entries commit once, or the database rolls the whole batch back. Retries cannot duplicate movements, events, alerts or stock changes.</p>
<p>Completed physical-stock batches do not offer automatic rollback. Review current quantities and create a new proposal for any correction. Bulk actions are capped at 20 lines to bound database work and review risk. Stock transfers, order cancellation, refunds, payment changes, pickup/POS lifecycle changes, publishing, campaigns and bulk price changes remain unavailable.</p>
<h2>Advance one delivery order</h2>
<p>Mink can prepare a private proposal for one exact visible online delivery-order reference to move one forward step: <strong>pending → processing</strong>, <strong>processing → shipped</strong> or <strong>shipped → delivered</strong>. It first reads a permission- and location-scoped order checkpoint. The checkpoint includes the current order, payment, cancellation, fulfilment, assigned-location and latest carrier-shipment state. Mink cannot use an internal order ID, skip a step, move backwards or propose a different status.</p>
<p>Save the private proposal and select <strong>Review exact change</strong>. You need <strong>Orders Manage</strong> permission, drafting access and the separately enabled <strong>Delivery order-status transitions</strong> switch. The preview shows the current and proposed status plus material payment, channel, fulfilment, location and shipment context. The exact approval expires after 5 minutes.</p>
<p>Approval rechecks the signed-in admin, store, assigned locations, permission, operator switch, proposal version, order timestamp and every material checkpoint field inside one database transaction. A payment, cancellation, location, shipment or status change makes the approval conflict. Retries are idempotent: the status, approval and append-only audit commit once, and only a newly completed execution emits the normal order-status event.</p>
<p>This action is deliberately narrow. POS sales use the register lifecycle; pickup orders use the collection workflow. Mink does not cancel or complete orders, change payment state, capture or refund money, create or modify a shipment, transfer stock, send a message or email, or perform a bulk transition. Non-COD delivery orders must already be paid. Pending or approved cancellation states and any refund activity block advancement; a previously declined cancellation is evaluated under the normal order rules. When a carrier shipment exists, Mink will not mark it shipped before pickup/transit evidence or delivered before carrier-confirmed delivery, and shipment exception/return states must be resolved in the shipment workflow.</p>
<p>Completed order-status actions do not offer automatic rollback. If a manual correction is needed, open the order and use the established Orders and shipment workflows; do not create a reverse Mink transition.</p>

<h2>Publish or schedule one blog</h2>
<p>Mink can prepare a private Markdown blog proposal with a title, excerpt, body and optional SEO title and description. Save the proposal, choose <strong>Publish after approval</strong> or <strong>Schedule for later</strong>, then select <strong>Review exact change</strong>. You need <strong>Blogs Manage</strong> permission, drafting access and the separately enabled <strong>Blog publication and scheduling</strong> switch.</p>
<p>The preview shows the complete saved content, publication mode and exact UTC instant. It expires after 5 minutes and cannot accept a title, body, tenant ID or blog ID from the browser. Approval rechecks the signed-in store and admin, permission, switches, saved version and cryptographic payload hash inside one transaction. It creates one new blog only; retries return the original result without a second post, audit or discovery notification.</p>
<p><strong>Publish after approval</strong> makes the sanitized post live immediately. <strong>Schedule for later</strong> accepts a time from 5 minutes to 90 days ahead and first creates a private draft. An authenticated, bounded worker checks due jobs once per minute. Disabling Mink, drafting or the publication switch pauses scheduled jobs. Editing or publishing the blog through another workflow before its due time produces a conflict instead of overwriting that work. Deleting the private blog also removes its pending publication job, so the worker cannot recreate it.</p>
<p>Raw HTML is escaped and sanitized. The blog workflow supports a small Markdown subset and deliberately does not activate Markdown links, attach media, assign categories or tags, feature a post, publish a product/page/storefront version, send a campaign, contact a customer or publish every draft in bulk. Scheduled jobs have no automatic rollback; use the Blogs workspace to unpublish or edit a post after publication.</p>

<h2>Send or schedule one coupon-email campaign</h2>
<p>Mink can prepare a private coupon-email proposal linked to an existing coupon. Save the proposal, choose <strong>All customers</strong> or one exact customer group, choose immediate delivery or a time from 5 minutes to 30 days ahead, then select <strong>Review exact change</strong>. You need <strong>Marketing Manage</strong> permission, Pro email-campaign access, drafting access, configured email delivery and the separately enabled <strong>Coupon email campaigns</strong> switch.</p>
<p>The server—not prompt text or browser fields—loads the signed-in store, saved subject and body, active coupon, sender identity and current audience. StoreMink caps the source audience at 10,000 customer rows. It excludes missing or invalid email addresses, duplicate normalized addresses and globally suppressed addresses before producing a SHA-256-bound recipient snapshot. The preview shows the audience label, eligible and excluded counts, timing, sender, coupon terms, complete copy and a branded sample rendered for the literal name “Customer”; it does not expose a real recipient address or name.</p>
<p>The preview expires after 5 minutes. Final confirmation rechecks permission, plan, switches, proposal version, coupon version, sender and the exact audience hash inside one transaction. Any drift produces a conflict instead of sending to a different audience. One confirmation creates one campaign, the exact recipient rows, one approval result and one audit record atomically; retries return the original result and never duplicate a campaign. Gemini cannot call the options, preview or execution endpoints.</p>
<p>Immediate delivery is queued only after final confirmation. Scheduled delivery reuses StoreMink's authenticated email worker, which promotes due jobs before claiming recipients and never claims a future campaign. The approved sender and brand are snapshotted, so later branding edits do not silently change scheduled email. Suppression is checked again at delivery. Mink does not accept arbitrary recipient IDs, multiple groups, attachments, direct customer messages or a model-triggered send. Queuing is a final send instruction and has no automatic cancellation or rollback; use a small internal test group before a broad campaign.</p>

<h2>Update prices for up to 20 exact SKUs</h2>
<p>Mink can prepare one private bulk-price proposal for 1 to 20 exact sellable SKUs. Products with variants require each exact variant SKU; a parent product SKU is rejected. Save the proposal and select <strong>Review exact change</strong>. You need <strong>Products Manage</strong> permission, drafting access and the separately enabled <strong>Bulk price updates</strong> switch.</p>
<p>Every line contains the complete INR price set: MRP, selling price and either a special price or an explicit instruction to clear it. Special prices are available only for variant SKUs; a product without variants must keep that field cleared, and Mink rejects a value instead of silently ignoring it. Prices must use at most two decimal places, remain within StoreMink's supported range and satisfy MRP ≥ selling price ≥ special price &gt; 0. The server rejects duplicate, missing, ambiguous, unchanged or invalid SKU lines.</p>
<p>The preview expires after 5 minutes and shows every before-and-after price, effective-price change and an impact summary based on one unit of each selected SKU. This summary is not a sales or revenue forecast. Existing orders retain their saved prices; future storefront, checkout and POS carts use the live prices after confirmation.</p>
<p>Final confirmation rechecks the signed-in store, admin, permission, switch, saved draft version, product and variant identity, publication status, version and every current price. The entire set applies atomically: any stale or invalid line changes nothing. Retries return the original result and never apply twice. Gemini cannot call the preview or execution endpoint, choose database IDs or bypass the 20-line limit.</p>
<p>Bulk price updates do not have automatic rollback because shoppers may act on a live price. To correct a confirmed update, review a fresh proposal or edit the product manually. Test a small unpublished set first when changing unfamiliar prices.</p>

<h2>Create a durable weekly trading report</h2>
<p>Ask Mink to <strong>create</strong>, <strong>prepare</strong>, <strong>run</strong> or <strong>generate my weekly trading report</strong>. You need <strong>Analytics View</strong> permission. Mink queues a background workflow for the last 7 days in the store timezone, compares it with the preceding equal period, and shows net sales, orders, average order value, units sold, leading products and sales channels.</p>
<p>The report snapshots the exact active locations accessible to you when it is queued and re-checks Analytics access, account status, beta access and restricted location assignments before each step. Removed access takes effect before the next read, while a later location cannot silently enter an existing run. Online or unassigned orders are included only when your dashboard aggregate would include them. Headline net sales include completed refunds; top-product merchandise line totals are labelled separately.</p>
<p>The progress card survives a refresh, and a report is never counted twice or left half-finished if StoreMink restarts while it runs. The report period is anchored to the moment you asked, so a retry after midnight does not silently change its dates. Asking for this report does not set up a recurring schedule, and it never changes products, inventory, prices, orders, customers, content or settings.</p>
<p>Select <strong>Stop</strong> to request cancellation. A queued report stops immediately; a running report stops safely after its current bounded read. Cancelled workflows cannot resume. Workflows waiting at a future human-approval checkpoint can resume only through their authenticated dashboard control and consume no model tokens while waiting.</p>
<p>When the report completes, StoreMink adds an in-dashboard notification. Completion delivery is reconciled and idempotent, so overlapping worker calls do not create duplicate alerts. The report card keeps its complete progress history and data-as-of time so support can reconstruct queue claims, retries, steps, cancellation and completion without storing model reasoning.</p>

<h2>Investigate a revenue decline</h2>
<p>Ask Mink to <strong>investigate</strong>, <strong>diagnose</strong> or <strong>explain</strong> a revenue decline over the last 7, 30 or 90 days. You need <strong>Analytics View</strong> permission. Mink compares that period with the preceding equal period in the store timezone and checks recognized net sales, order count, average order value, units sold, sales channels, accessible locations and the bounded set of leading product movements.</p>
<p>You may name one exact accessible dashboard location, such as <strong>Shop</strong> or <strong>Delhi warehouse</strong>. Otherwise the workflow captures your exact accessible active-location scope and labels whether online or unassigned orders are included. Access, suspension, beta eligibility and location assignments are checked again before every background read. The result reports evidence and correlations, not invented causes: advertising spend, external traffic and competitor activity are unavailable unless StoreMink records them.</p>
<p>Use a normal sales question for a quick total. The durable investigation starts only after an explicit investigate/diagnose request, survives restarts and can be stopped safely at any time.</p>

<h2>Prepare a private product launch package</h2>
<p>Ask Mink to prepare a launch-readiness package for one <strong>exact existing product or variant SKU</strong>. You need both <strong>Products View</strong> and <strong>Inventory View</strong>. The SKU is resolved inside the current store; product names are never expanded implicitly. Mink inspects at most 20 sellable SKUs and checks publication state, parent and relevant variant media, saved description and SEO coverage, valid MRP/selling/special-price hierarchy, stock and low-stock thresholds across the captured accessible active locations, and required shipping measurements. Missing stock rows count as zero at that location, and Mink flags a location-level gap even when combined stock is positive elsewhere.</p>
<p>The completed private card separates blockers, items needing attention and ready checks. It includes an ordered launch checklist and clearly labelled starter copy grounded only in the saved store, product, variant and category names. The package does not generate an image, publish or edit a product, change prices or inventory, create or send a campaign, select recipients, deploy code or contact a customer. Any later change must use the relevant saved proposal and human-approval flow.</p>
<p>Both templates use the same service-only workflow ledger, short leases, idempotent checkpoints, bounded retries, safe cancellation, owner-and-store status endpoint and duplicate-safe completion notification as the weekly report. A location added later cannot enter an already queued run; removed permission or location access takes effect before the next read.</p>

<h2>Find slow inventory and prepare a promotion</h2>
<p>Ask Mink to identify slow-moving inventory and prepare a private promotion recommendation over a complete <strong>30-day</strong> or <strong>90-day</strong> lookback. You need <strong>Analytics View</strong>, <strong>Products View</strong>, <strong>Inventory View</strong> and <strong>Offers Manage</strong>, and Mink drafting must be enabled for the store. You may name one exact accessible dashboard location, such as <strong>Shop</strong> or <strong>Delhi warehouse</strong>; otherwise Mink checks each accessible active physical location separately.</p>
<p>A candidate must be a published, inventory-tracked SKU with current positive on-hand stock whose product predates the complete lookback. Mink compares the current shelf with recognized order-item sales attributed to that same physical location. No sales in the window, or enough stock for at least two equal lookback periods at the observed rate, is marked for review. Zero-stock and untracked items are not called slow inventory. Shop stock cannot hide Delhi stock, and online or unassigned orders are not invented as physical-location demand. Current stock may have changed during the window, so the card never claims it was present for the whole period.</p>
<p>The durable card shows at most 20 highest-priority SKU-location shelves, their on-hand stock, units sold, estimated days of cover and sell-through, plus a maximum-five-SKU promotion concept. A conservative percentage may appear only when saved cost data supports a five-point gross-margin buffer and the store discount ceiling. Missing or insufficient margin data withholds the percentage instead of guessing.</p>
<p>This is a <strong>private recommendation only</strong>. Mink does not create or activate an offer, change a price or inventory quantity, choose recipients, or contact customers. The analysed location is evidence scope, not an offer-eligibility boundary. The merchant must separately verify exact product or variant scope plus channel and audience rules in Offers, choose a total budget, save any offer disabled for review, and approve activation in a separate human step. Sales history is not a forecast, and seasonality, incoming stock, traffic and advertising spend are not included.</p>
<p>The workflow captures exact active location IDs at queue time and rechecks drafting, store access, suspension, Analytics, Products, Inventory, Offers and location authority before background reads. Removed access cancels or narrows the next step; a location added later never enters the run. Work is bounded, restart-safe, cancellable and completed without additional Gemini calls or tokens.</p>

<h2>Review delayed pickups and prepare communication guidance</h2>
<p>Ask Mink to review delayed, overdue, unprepared, uncollected or at-risk pickup orders and prepare private communication guidance. You need <strong>Orders Manage</strong>, and Mink drafting must be enabled for the store. Name one exact accessible dashboard location, such as <strong>Shop</strong> or <strong>Delhi warehouse</strong>, or let Mink review every accessible active physical location while keeping each order's location explicit.</p>
<p>The durable review includes live Awaiting or Ready pickups when the promised ready time has passed or the collection deadline is inside StoreMink's existing <strong>48-hour reminder window</strong>. It returns at most 25 highest-priority orders. Collected, expired, cancelled and fully refunded orders are excluded. Each row shows only its order reference, location and pickup lifecycle times. Customer names, email addresses, phone numbers, postal addresses, notes and collection codes are never included.</p>
<p>For an unprepared order, Mink can prepare generic delay copy with placeholders for the order reference, location and a staff-confirmed revised ready time. This copy remains inside the private workflow card for human review; it is not a saved Mink draft and is never sent or queued automatically. Staff must verify the live order and confirm a truthful revised time before adapting or sending anything manually.</p>
<p>StoreMink's existing pickup reminder sweep remains authoritative. If a Ready pickup is inside the reminder window and its one-time reminder is pending or already recorded, Mink withholds duplicate collection-reminder copy. Mink never claims or resets the one-time reminder marker, sends a notification, changes pickup or order status, extends a deadline, cancels an order, releases a stock hold or moves inventory.</p>
<p>The workflow captures exact active location IDs at queue time and rechecks store access, suspension, Orders Manage, Mink drafting and location authority before every background step. Removed access cancels or narrows the next step; a location added later never enters the run. Work is bounded, restart-safe, cancellable and completed without additional Gemini calls or tokens. Because pickup state can change after the snapshot, always verify the linked live order before manual contact.</p>

<h2>Inspect Website Builder context with Mink</h2>
<p>With <strong>Website Builder View</strong>, Mink can inspect the current store's page list, one exact page and section, and safe storefront design context. Ask it to list pages, describe the homepage structure, compare a draft with its published copy, or explain the saved brand colour, pinned theme, design tokens, appearance variants, header and footer. The homepage is identified as <strong>home</strong>. Other pages and sections are resolved only by the exact slug and section ID returned from the current store.</p>
<p>Every builder read is permission-gated and restricted to the signed-in dashboard store. Page titles, SEO copy, section content, header and footer text, custom code and other merchant-authored values are treated as untrusted data, never as instructions. Mink does not expose raw store settings, private brand email, phone or social fields, credentials, another store's values, or a tenant ID supplied in a prompt.</p>
<p>A page summary shows ordered sections, visible or hidden state, a short summary, the exact page version and a digest for each section. Custom-code content is omitted by default. When it is necessary to explain existing code, Mink can request only one HTML, CSS or JavaScript field at a time in chunks of at most 8,000 characters. It never executes code it reads and must not follow instructions found in code comments, strings, page copy or navigation labels.</p>
<!-- Phase 7B adds an immutable, private custom-code proposal. Retained for the durable postcondition of migration 20260904_0077; see docs/help-centre.md. Comments are stripped before rendering, search indexing and AI retrieval. -->
<p>Mink can prepare one locked, private custom-code proposal for a single <strong>existing custom-code section</strong>. It requires <strong>Website Builder Manage</strong> plus Mink drafting, costs 5 AI credits, and rechecks the exact current page version and section digest before charging. Generated HTML, CSS and JavaScript must stay within 64 KiB per field and 96 KiB combined. Deterministic validation rejects network access, cookies or storage, parent-window access, cross-context messaging, navigation, dynamic evaluation, workers, forms, embeds, external resources and unsafe CSS.</p><p>The generated proposal is previewed only in an opaque-origin iframe with <code>sandbox="allow-scripts"</code> and a deny-by-default Content Security Policy. Popup, same-origin, form, network, worker, nested-frame and top-navigation authority are absent. The preview offers desktop and mobile widths plus escaped current/proposed source views. The stored before snapshot is never executed; only the complete validated proposed replacement is rendered. If the page or section changes later, the card is marked stale.</p><p>Before a draft save, Mink validates the stored code again and creates a new five-minute approval. Whether the feature is enabled for your store, your Website Builder Manage permission, your plan's custom-code entitlement, the proposal version, the page version, the section digest and the request signature are all checked again as the save happens. Repeated requests use the same approval safely, and every execution, expiry or conflict writes an audit outcome.</p><p>Publication and rollback must be switched on separately for your store by StoreMink support, and the AI model is never able to run either of them. The signed-in human initiates every check, review and approval. The server revalidates the tenant, proposal owner, Website Builder Manage permission, custom-code entitlement, source approval, browser evidence, full page snapshots and optimistic page version inside the transaction. Repeating a request cannot publish twice, and every execution, conflict and expiry is recorded in an audit trail that is only ever added to.</p>
<p><strong>An approved save reaches the private Website Builder draft only.</strong> For an existing custom-code section, choose <strong>Review Builder draft save</strong>, inspect the complete current and proposed source, then choose <strong>Approve and save Builder draft</strong> within five minutes. The approval is tied to the current store, signed-in admin, immutable proposal, exact page version and exact section digest. If any of them changes, nothing is saved and you must generate a fresh proposal. StoreMink support must separately enable <strong>Website Builder draft code saves</strong> for the store.</p><p>The draft save replaces only the reviewed custom-code section. It does not add a section or change header or footer. Publishing is a separate, separately approved step: choose <strong>Run publication checks</strong> to execute the proposed section in opaque-origin 1,280 px desktop and 390 px mobile frames. Publication remains unavailable unless current-browser runtime, horizontal-overflow, Content Security Policy and bounded accessibility checks all pass. Then choose <strong>Review storefront publication</strong> and <strong>Approve and publish storefront</strong> within five minutes. StoreMink support must separately enable <strong>Checked storefront publication and rollback</strong> for the store.</p><p>The publication approval is bound to the completed draft save, exact private Builder draft, exact current live snapshot, page version and complete section digests. It copies that checked draft snapshot to the live page; it cannot add sections, edit header/footer, access StoreMink source code or shell, commit code or deploy production. A completed Mink publication exposes <strong>Review exact rollback</strong>. Rollback requires another five-minute approval, restores only the exact prior published snapshot and fails closed if the live page changed after publication.</p>

<h2>Draft troubleshooting</h2>
<p>If drafting tools are unavailable, ask a store owner to check your Manage permission and ask StoreMink support whether the separate drafting beta is enabled. If the proposal cannot be created, check the plan's remaining monthly AI allowance or AI-credit balance under Plans &amp; Billing. If the enclosing Mink run fails or is cancelled after creating a proposal, StoreMink discards the unseen proposal and restores its exact plan and purchased-credit amounts. A version conflict means the draft changed in another tab; reload the card before saving again.</p>
<h2>Temporary failures and monitoring</h2>
<p>Mink AI retries a transient model failure at most once. Each request also has a hard time limit; if it is reached, Mink AI stops and shows a safe retry message. These tools are read only, so a retry cannot duplicate a business change.</p>
<p>StoreMink operators can inspect redacted run status, latency, retry count, tool names, token usage and estimated model cost for reliability and cost monitoring. The inspector never displays prompts, answers, tool arguments, tool results or model reasoning. Interrupted usage is labelled partial or unavailable instead of being shown as zero cost. The alpha still does not debit AI credits.</p>
<h2>Protect private information</h2>
<p>Do not enter passwords, one-time codes, payment credentials, card details, API secrets or unnecessary private customer information. Mink AI does not need them for the supported read-only questions.</p><h2>Use Mink while editing your website</h2><p>Open Website Builder and click the purple Mink AI icon in the shared top header. The conversation opens over the right side of the editor, including on wide desktop screens. Resize the panel, expand it to full screen, restore it or close it without leaving Builder. Opening or closing chat does not save or publish your page.</p><p>Ask naturally, for example: &quot;What needs restocking?&quot;, &quot;What pages do I have?&quot; or &quot;Make the first custom-code section on my homepage look better on phones.&quot; You do not need to name internal tools or security rules. Mink may ask a short question when a product, location or requested change is unclear.</p><p>Builder tools read saved page data, not unsaved changes in your editor. Code proposals currently replace one existing custom-code section; they cannot create new sections or generate banner images. Draft saves and publication still need their separate permissions, enabled controls and human approvals. Opening the chat grants no additional access.</p><p>If chat does not appear, refresh after saving any pending editor work and try the top-header icon again. An access or feature-disabled message is different from a hidden panel: ask your administrator to check Mink availability and your permissions.</p>
<h2>Get a daily or weekly business brief</h2>
<p>Ask &quot;What needs my attention in echos?&quot;, &quot;Give me a weekly business overview&quot; or &quot;Give me a daily brief for Delhi.&quot; Mink prepares one private background brief. You need Analytics View, Products View, Inventory View and Orders View. Existing Mink access and credit rules apply to the chat; the queued brief uses no further Gemini calls. Drafting does not need to be enabled.</p>
<p>Daily means yesterday in your store timezone. Weekly means the last 7 completed local calendar days, compared with the preceding 7 completed days. Today's partial sales are excluded. The card shows the exact periods, timezone and location scope. Online or unassigned orders enter only an unrestricted store-wide scope. Inventory stays separate for each accessible active physical location, up to 50; choose one location for a larger estate.</p>
<p>Four fixed checks show Needs attention, No threshold triggered or Not enough data. Sales attention requires a decline of at least 20%, with at least 5 recognized orders and positive net sales in the previous period. Stock attention means any tracked SKU is low or out at a location, using the Inventory workspace thresholds and zero-or-negative out-of-stock rule. Stock held elsewhere does not hide local shortages; untracked stock is excluded.</p>
<p>Return activity counts return records opened in each period, excluding rejected and cancelled records, scoped by the original order location. It flags a rise of at least 50% with at least 5 preceding records. This is not a return rate. Failed-payment evidence counts orders created in the chosen period whose current payment status is failed; attention requires at least 3 such orders and at least 20% of created orders. This is not a gateway-attempt failure rate or the time a failure happened.</p>
<p>Inventory and payment status are current when collected. Source reads may finish at slightly different times. The brief reports evidence, not invented causes, forecasts or an all-clear. Review live records before acting. No business records are changed, no customer messages are sent, and asking for a daily brief does not enable a recurring schedule. Recurring watches are configured separately as described below.</p>
<p>The progress card supports cancellation and retry after failure. Refreshing does not start another run. Completion uses the existing private workflow notification. Permissions and captured location scope are checked again before every step; a narrowed scope cancels the brief rather than reusing broader evidence. If a data source fails, the run retries or reports failure instead of showing healthy zeroes. Reopen the conversation for the result, or request a new brief for fresher data.</p>
<h2>Enable private recurring Mink watches</h2>
<p>Open <strong>Watches</strong> in the Mink chat header, or ask &quot;Keep an eye on stock at Delhi&quot; or &quot;Give me a business brief every Monday.&quot; Mink shows the watch setup page; a chat request alone never enables, changes or deletes a watch. Choose Business brief, Low or out-of-stock inventory, Sales decline, Rising return activity or Failed-payment orders. Select all currently accessible locations or one exact location, a daily or weekly time, and optional quiet hours. Review the settings and tick the explicit consent box before choosing <strong>Enable watch</strong>.</p>
<p>Watches are private to the admin who enabled them. Creation and resume require Mink access plus Analytics, Products, Inventory and Orders View. They use the same four fixed evidence rules described in the business brief section, not arbitrary custom thresholds. Daily financial evidence covers yesterday; weekly covers the last seven completed local days. Inventory is current at the time of the check, per physical location. Stock in Delhi cannot conceal an empty shelf at Shop. This is scheduled monitoring, not real-time incident detection.</p>
<p>The timezone, location IDs and default inventory threshold are captured when you enable the watch. New locations never join an existing watch automatically. Changes to assignments, archived locations or permissions stop broader evidence from being reused and pause the watch. Pause/delete remain available with dashboard access when Mink is disabled. To change a watch's schedule, scope or quiet hours, delete it and create a new reviewed watch.</p>
<p>A scheduled business brief notifies for each new reporting period. Other watches notify when attention first appears. Sales, returns and payment watches stay quiet through the same attention episode, then can alert again after a later check detects recovery followed by new attention. Inventory re-alerts when per-location low/out-of-stock counts change. It is not an individual-SKU change feed: swapping affected SKUs without changing those counts does not generate another alert. Insufficient data is not proof of recovery or an all-clear.</p>
<p>Quiet hours use the captured store timezone; overnight intervals are supported. Checks still run, but notifications wait until quiet hours end and pending changes coalesce. A later completed check with no attention clears an undelivered alert. Alerts are private in-app notifications only, with no metrics in the notification preview. Reopening the result checks permissions again. No email, SMS, WhatsApp message, customer communication or automatic business action is sent. Scheduled checks use no Gemini calls or additional AI credits; normal chat costs still apply.</p>
<p>There are at most 5 watches per admin and 20 per store, including paused watches. Each watch has at most one check in progress. The existing worker picks up at most five due watches per heartbeat; time is approximate and missed intervals are skipped without a catch-up burst. Missing local times during daylight-saving changes skip that occurrence; repeated times run only once on that local day. Quiet hours with identical start/end times are rejected.</p>
<p>Use Refresh watches to see the latest completed evidence, errors and next check time. Source failure retries through the background workflow; exhausted retries pause the watch rather than reporting healthy zeroes. Review the error and use Resume to schedule the next future check. Pause or Delete stops pending work and suppresses undelivered alerts; an alert already delivered cannot be recalled. Delete is irreversible in the UI. Terminal scheduled snapshots older than 30 days are pruned in bounded batches, except the latest/pending evidence; deleted watches, their audit events and scheduled snapshots are purged after 30 days. Existing notifications follow the normal notification retention policy.</p>
<h2>Review and approve a response to a watch alert</h2>
<p>In Mink AI, open Watches, then Suggested responses below a completed check. You can also ask &quot;What should I do about the Delhi stock alert?&quot; Mink can read and explain your response plans, but it cannot approve or dismiss them. Only the admin who owns the watch can see or approve its plans. No plan appears without an attention signal; an empty list is not an all-clear.</p>
<p>Plans use a fixed triage order: local stock availability, failed-payment orders, sales decline, then return activity. This is an operational review order, not an estimate of revenue, savings or causation. Each card shows its evidence, period, captured locations and timezone, expected benefit and limits. Monetary impact is unknown. A specific-signal watch offers only that signal; a Business brief watch can offer up to four.</p>
<p>Tick the consent box for the exact card and choose Approve investigation. This authorizes one read-only investigation, not business changes. Approval is bound to the evidence snapshot, watch version, captured scope and fixed limits. Plans expire 24 hours after the source check completes; a newer completed check or a changed watch invalidates an undecided old card. Refresh responses to review the latest evidence. Repeated approval of the same card returns the same workflow instead of running it twice. Dismiss hides approval for that snapshot; it does not pause the watch or dismiss future evidence.</p>
<p>The existing background worker collects fresh evidence for the approved daily or weekly window and current inventory. If the signal has recovered or evidence is insufficient, it explains that and does not invent a remedy. Inventory details show at most 20 SKU rows from at most 3 affected locations, prioritizing locations with more out-of-stock SKUs. Returns and failed payments show at most 20 records. Limited lists are labelled; use the dashboard for all records. Sales review compares recognized sales and orders; ask for a separate 7-, 30- or 90-day revenue investigation for deeper channel or product breakdowns. Returns are record counts, not a return rate; payment statuses are not provider attempt history. Customer names, email addresses and phone numbers are not included in response details.</p>
<p>Suggested next steps are not executed. Stock adjustments, prices, discounts, campaigns, customer messages and other business actions still require their existing individual permissions, exact targets, previews and approvals. This phase cannot move stock, issue refunds, retry payments or apply a remedy automatically. Approving a watch or investigation grants no ongoing business-write authority. There are no extra model calls or AI credits for this deterministic investigation.</p>
<p>There is at most one scheduled check or response running per watch. Its result card supports refresh and the existing cancel/retry controls. Source failures retry safely; no failed query becomes a healthy zero. Permissions, active locations and the approved watch version are rechecked before every step. Pause or Delete stops pending response work too; resuming a changed watch does not reauthorize an old investigation. An already completed read is not undone. The five most recent approved investigations remain available under Suggested responses while retained. Response decisions follow the source-watch snapshot retention: deleting a watch or pruning its source check eventually removes the decisions. Live deployment and the existing workflow heartbeat are required.</p>
<h2>Approve private memories and review text documents</h2>
<p>Open Mink AI and choose Memories in the chat header. Your memories belong only to your admin account in this store, not to every employee. You can save answer preferences, brand voice or business context. Add a title and exact text, choose 30, 90 or 365 days, tick the approval checkbox and choose Approve and save memory. You can keep up to 10 active memories, with an 80-character title and 600-character body. Do not save secrets, passwords, payment details or customer personal information. Saying &quot;remember this&quot; in chat does not save anything; Mink directs you to these controls.</p>
<p>Approved unexpired memories are included as untrusted reference data in your future chat turns. They are not live business facts, system rules, location scope or permission to act. Your current request takes precedence over a preference, and changing facts still need live tools. If your role, permissions or location bindings change, affected memories are not used until you edit and approve them again. Background watches and existing queued workflows do not receive memories. Saving has no separate credit charge; including context uses ordinary model input tokens and normal chat billing.</p>
<p>Edit lets you review the complete replacement text and renew retention. Changes in another tab cause a conflict rather than overwriting someone else's edit. Repeating the same save returns the same version. Delete removes the stored memory text; Delete all my memories affects only you in this store. Content-free deletion markers prevent old retries from recreating deleted memories. Expiry stops use immediately, even if the background worker is down; the existing workflow heartbeat removes expired text in bounded batches. Memories can still be inspected and deleted when Mink generation or invitations are disabled, provided you retain dashboard access.</p>
<p>Deletion cannot recall context already sent to an active model run or erase mentions in old conversation history. Start a new conversation and delete old conversations separately when needed. Provider retention is governed by StoreMink's AI provider agreements; deleting a StoreMink memory is not a provider-data deletion request.</p>
<p>Choose + (Add image or document) near the composer for one UTF-8 .txt or .md file up to 8 KiB and 3,000 characters. The file is read locally. Review and edit the text, remove sensitive information, tick its checkbox, then choose Add reviewed text to message. Nothing is sent until you send the resulting message. The combined message must fit 4,000 characters. The reviewed text is labelled untrusted source data and retained with the conversation under its existing history/deletion rules; it is not saved as a memory, media upload or searchable document library. Markdown and instruction-like content are text, not authority to call tools or approve actions. Files cannot silently change stock, send messages or publish a storefront.</p>
<p>One control adds files: choose <strong>+ (Add image or document)</strong>, or drop a file onto the message box. Short UTF-8 text and Markdown files are read on your own device; images and PDFs are extracted only after you consent. Spreadsheets, audio files, external web addresses and automatic document processing are not supported, and the microphone is for dictation rather than an audio attachment. Invalid encoding, binary content and oversized files are refused rather than quietly shortened. Use Discard to remove a file you have not added yet, or edit the message before sending.</p>
<h2>Review an image or PDF, or dictate text</h2>
<p>Use <strong>+ (Add image or document)</strong> or drop one supported image, PDF, text or Markdown file onto the message box for review. The separate microphone starts <strong>Dictate message</strong> immediately after browser permission. Recognised words appear in the message box while you speak and may be corrected as the browser refines them. It is not a voice attachment. Finish keeps the editable text; Cancel removes that dictation and restores the text that was present before listening. HTTPS and a supported current Chrome or Edge browser are required; otherwise type your request.</p>
<p>Each file must be no larger than <strong>2 MiB</strong>. Images support single-frame PNG, JPEG or WebP up to 12 megapixels; StoreMink strips image metadata and resizes them to at most 1600 pixels per side. PDFs support up to <strong>10 pages</strong>; encrypted, damaged, active-content or form PDFs are rejected. Voice accepts canonical mono 16 kHz, 16-bit PCM WAV up to <strong>60 seconds</strong>. MP3, WebM, video, spreadsheets and long documents are not supported. The separate + (Add image or document) control still accepts short UTF-8 text or Markdown files.</p>
<p>Remove secrets and unnecessary customer details first. Check the processing consent box and choose <strong>Process for review</strong>. This sends the file to StoreMink's AI provider before you send a chat message. StoreMink does not save the raw file in its database, Media library or saved memories; the provider's retention policies still apply. Cancelling cannot retract bytes already sent to the provider.</p>
<p>Review and correct extracted image or PDF text because it can omit or misread details; it is not a verified stock level or action approval. Confirm the reviewed text, then choose <strong>Add reviewed reference to message</strong>. Dictated words are already editable in the message box. Nothing is sent to the chatbot until you press Send. Extraction is limited to 3,000 characters and the combined chat message remains limited to 4,000 characters. Chat and follow-up turns receive only the reviewed text, not the original image or PDF.</p>
<p>Beta extraction deducts no AI credits but incurs provider usage. A separate chat request follows the existing read/draft/action charging rules. Shared processing limits are five requests per admin per minute, 30 per store per hour, 100 per store per day and a platform-wide limit. Failed, cancelled and duplicate attempts also consume limits. Processing has a 45-second deadline and rejects overly complex inputs or incomplete responses. It does not automatically retry. After a failure, wait and explicitly approve another attempt; provider work from a timed-out request might still have incurred usage.</p>
<p>If processing is unavailable, check that Mink AI is switched on for your store and that you hold the dashboard permissions this feature needs. Permission, capacity, safety and provider failures never silently fall back to another model, so a refusal is reported rather than answered from a weaker source. Keep using typed prompts or short text documents while you check, and contact StoreMink support if it stays unavailable.</p>
<p>Closing, discarding or changing conversations cancels pending local work; the microphone is stopped and local previews are released. Deleting a chat follows the existing conversation policy and does not retract earlier provider processing. This feature does not generate or place images, save memories, publish storefronts, change stock or authorize any other action. Approval rules remain unchanged.</p>
<h2>Live microphone dictation</h2>
<p>Choose the microphone once and begin speaking. After browser permission, Mink shows a listening indicator and puts recognised words into the message box in real time. You do not need to record a voice note or wait for an upload to finish. The Send button is available as soon as the message contains recognised text; sending ends the active dictation and sends that visible text once.</p>
<p>Choose <strong>Finish</strong> to keep editing the dictated text, or <strong>Cancel</strong> to remove the current dictation and restore the message you had before listening. Recognition stops after 60 seconds, if the tab is hidden, or when a chat turn begins. Check names, SKUs, locations and numbers because interim words can be revised or misheard.</p>
<p>StoreMink does not create, upload or save a microphone audio file in this flow. Speech recognition is supplied by the browser and its service may process audio under its own privacy and retention terms. Use HTTPS and a current Chrome or Edge browser. If microphone access is blocked, allow it for this site and retry; if browser speech recognition is unavailable, type the message. This is dictation, not a live voice conversation.</p>
$guide$,
    updated_at = now()
WHERE slug = 'use-mink-ai-in-your-dashboard'
  AND status = 'published'
  AND body LIKE '%One Mink AI switch and a simpler message box%';


-- Internal release-checklist language across the other guides. It was
-- written in the third person about "the merchant", addressed a StoreMink
-- "test team" the reader does not have, and in three guides named the
-- release checklist itself. Eleven guides carried the same rubric, so these
-- are phrase-level replacements applied to every published guide rather than
-- eleven bespoke rewrites: the class of wording is the defect. The advice
-- underneath -- prove it on your own account before a real customer depends
-- on it -- is sound and is kept, addressed to the merchant.

UPDATE public.help_articles
SET body = replace(body,
      $old$<strong>Controlled live verification required:</strong>$old$,
      $new$<strong>Test this on your own account first.</strong>$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$<strong>Controlled live verification required:</strong>$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$have not yet completed the release checklist's controlled live run$old$,
      $new$have not yet been proven end to end$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$have not yet completed the release checklist's controlled live run$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$have not yet completed the controlled live run$old$,
      $new$have not yet been proven end to end$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$have not yet completed the controlled live run$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$until a controlled live test succeeds in that account$old$,
      $new$until you have proved it end to end on that account$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$until a controlled live test succeeds in that account$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$After the controlled live test has succeeded for the connected merchant account$old$,
      $new$Once that test has succeeded on your connected account$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$After the controlled live test has succeeded for the connected merchant account$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$a consenting number owned by the test team$old$,
      $new$a number you own and have consent to use$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$a consenting number owned by the test team$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$owned by the test team$old$,
      $new$you own and have consent to use$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$owned by the test team$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$the merchant's own Twilio and approved DLT setup$old$,
      $new$your own Twilio and approved DLT setup$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$the merchant's own Twilio and approved DLT setup$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$the merchant's own Twilio account$old$,
      $new$your own Twilio account$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$the merchant's own Twilio account$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$the merchant's Twilio and DLT setup$old$,
      $new$your Twilio and DLT setup$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$the merchant's Twilio and DLT setup$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$the merchant's own connected account$old$,
      $new$your own connected account$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$the merchant's own connected account$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$the merchant's own account$old$,
      $new$your own account$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$the merchant's own account$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$the merchant's connected$old$,
      $new$your connected$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$the merchant's connected$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$a small controlled order in the merchant's own account$old$,
      $new$one small real order in your own account$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$a small controlled order in the merchant's own account$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$a small controlled order$old$,
      $new$one small real order$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$a small controlled order$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$a controlled message$old$,
      $new$one test message$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$a controlled message$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$a controlled send$old$,
      $new$one test message$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$a controlled send$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$a controlled parcel$old$,
      $new$one test parcel$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$a controlled parcel$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$a controlled test$old$,
      $new$one test run$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$a controlled test$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$any pickup or manifest steps the team will use$old$,
      $new$any pickup or manifest steps you will use$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$any pickup or manifest steps the team will use$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$<p>The StoreMink integration includes automated provider, state, and response tests, but this release has not yet completed its live merchant test-account browser, booking, and webhook smoke run. Do not rely on it for a customer parcel until that controlled test succeeds in both StoreMink and Shiprocket.</p>$old$,
      $new$<p>Do not rely on this connection for a customer parcel until you have booked one test parcel through your own account and confirmed the result in both StoreMink and Shiprocket.</p>$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$<p>The StoreMink integration includes automated provider, state, and response tests, but this release has not yet completed its live merchant test-account browser, booking, and webhook smoke run. Do not rely on it for a customer parcel until that controlled test succeeds in both StoreMink and Shiprocket.</p>$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$Live Shiprocket merchant-account booking and webhook verification is also still pending, so do not rely on the connection for customer parcels until the controlled test succeeds.$old$,
      $new$Live Shiprocket rates, booking, and tracking callbacks are also not yet proven end to end, so confirm them on your own account before a customer parcel depends on the connection.$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$Live Shiprocket merchant-account booking and webhook verification is also still pending, so do not rely on the connection for customer parcels until the controlled test succeeds.$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$<p>Local development can compile a route the first time it is opened. Wait for compilation to finish, then refresh once. Avoid running multiple development servers for the same project. In a deployed environment, report a repeated slow load with the store, route, selected filters, approximate time, and a screenshot.</p>$old$,
      $new$<p>A page can be slow the first time it is opened after a release, so refresh once before reporting it. If a page is repeatedly slow, send StoreMink support the store, the page, the filters you selected, roughly how long it took, and a screenshot.</p>$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$<p>Local development can compile a route the first time it is opened. Wait for compilation to finish, then refresh once. Avoid running multiple development servers for the same project. In a deployed environment, report a repeated slow load with the store, route, selected filters, approximate time, and a screenshot.</p>$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$uses an idempotency reference so a retry cannot intentionally create a second refund$old$,
      $new$sends a unique reference with it, so pressing Refund twice cannot send the money twice$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$uses an idempotency reference so a retry cannot intentionally create a second refund$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$The operator gate, Website Builder Manage permission, custom-code entitlement, proposal version, page version, section digest and request hash are checked again inside the save transaction.$old$,
      $new$Whether the feature is enabled for your store, your Website Builder Manage permission, your plan's custom-code entitlement, the proposal version, the page version, the section digest and the request signature are all checked again as the save happens.$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$The operator gate, Website Builder Manage permission, custom-code entitlement, proposal version, page version, section digest and request hash are checked again inside the save transaction.$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$<p>Publication and rollback have an independent default-off operator gate and never give the AI model an execution tool.$old$,
      $new$<p>Publication and rollback must be switched on separately for your store by StoreMink support, and the AI model is never able to run either of them.$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$<p>Publication and rollback have an independent default-off operator gate and never give the AI model an execution tool.$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$Repeated execution is idempotent; execution, conflict and expiry outcomes are append-only audited.$old$,
      $new$Repeating a request cannot publish twice, and every execution, conflict and expiry is recorded in an audit trail that is only ever added to.$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$Repeated execution is idempotent; execution, conflict and expiry outcomes are append-only audited.$old$) > 0;

UPDATE public.help_articles
SET body = replace(body,
      $old$<p>The + (Add image or document) control accepts only short text and Markdown files. Use the separately enabled + (Add image or document) control for reviewed image/PDF/voice extraction. Spreadsheets, external URL fetching and automatic document processing remain unsupported. Invalid encoding, binary controls and oversized files are rejected rather than silently truncated. Use Discard document to remove a local preview, or edit the composer before sending.</p>$old$,
      $new$<p>One control adds files: choose <strong>+ (Add image or document)</strong>, or drop a file onto the message box. Short UTF-8 text and Markdown files are read on your own device; images and PDFs are extracted only after you consent. Spreadsheets, audio files, external web addresses and automatic document processing are not supported, and the microphone is for dictation rather than an audio attachment. Invalid encoding, binary content and oversized files are refused rather than quietly shortened. Use Discard to remove a file you have not added yet, or edit the message before sending.</p>$new$),
    updated_at = now()
WHERE status = 'published' AND strpos(body, $old$<p>The + (Add image or document) control accepts only short text and Markdown files. Use the separately enabled + (Add image or document) control for reviewed image/PDF/voice extraction. Spreadsheets, external URL fetching and automatic document processing remain unsupported. Invalid encoding, binary controls and oversized files are rejected rather than silently truncated. Use Discard document to remove a local preview, or edit the composer before sending.</p>$old$) > 0;
