# POS & Locations — acceptance tests

Everything built across POS Phases 0–4 and Locations Phases A–F, as stories
you can run against staging. **Keep this current: a phase isn't done until its
stories are here.**

- **Design detail:** `docs/pos-plan.md`, `docs/locations-ia.md`
- **What's next:** `docs/roadmap.md`
- **★ marks a story testing a non-obvious invariant** — something that looks
  right by accident and breaks silently. Those are the ones worth re-running
  after any refactor near them.

---

## 0.1 Public POS product site

**PS-0.0 — A lower-plan merchant can understand POS before upgrading**
Open `/dashboard/pos` for a Free or Basic store at desktop and mobile widths.
**Expect:** a responsive feature banner shows the real StoreMink register UI
across desktop, tablet and phone hardware, and leads with complete retail
journeys: fast in-store checkout, multi-location inventory, GST receipts and
cash-up, plus pickup, returns and store credit. It does not spend the limited
feature space on baseline payment methods or staff roles. The primary action
opens Plans & Billing, while **Explore all POS features** opens
`https://pos.storemink.com` in a new tab so the merchant's dashboard session
remains in place. The current plan and the two locations included with Pro
remain explicit.

**PS-0.1 — The POS product site is not a merchant storefront**
Open `pos.storemink.com` (or `pos.localhost:3000` in local development).
**Expect:** the public Point of Sale product page renders. It canonicalises to
`https://pos.storemink.com`, advertises that host's own robots and one-page
sitemap, and never attempts store resolution or POS operator authentication.
The page leads with the real StoreMink register running across desktop, tablet
and phone, then explains complete retail workflows in this order: in-store
checkout, shared multi-location inventory, pickup/returns/store credit, and
daily operations. The early feature space is reserved for these outcomes;
baseline tender types and staff/device controls appear only in the deeper
operational detail. Pro pricing, two included locations, authorised till limits
and the requirement for a connection to complete a sale remain explicit.
An unknown path such as `/not-a-page` stays inside the product route tree and
404s; it must not expose an unrelated platform page.

**PS-0.2 ★ — Marketing and register addresses stay distinct**
Open `{slug}.storemink.com/pos` for a real merchant.
**Expect:** the merchant's operational register and credential gate behave as
before. Creating a store with the slug `pos` is refused as reserved. On the
public product page, checkout, inventory, pickup/returns, operations, pricing
and FAQ anchors remain same-document native fragments on `pos.storemink.com`
(and therefore preserve `http://` on `pos.localhost`), while StoreMink home,
platform pricing, login, and signup deliberately navigate to `storemink.com`.

**PS-0.3 — The Help Centre covers the full shipped POS journey**
Open `help.storemink.com` after migrations
`20260825_0015_pos_help_documents` and
`20260902_0055_pos_https_entry_help` are applied.
**Expect:** a dedicated **Point of Sale** card appears fourth in the category
grid with its own scan icon and 17 published articles. The guides use easy
language and cover requirements, locations, staff/PINs, authorised devices,
settings, layout/scanning, checkout, tenders, discounts, receipts, stock,
shifts, pickup, returns, refunds/store credit/exchanges/credit notes, reporting,
and troubleshooting. Every article appears in the Topics tree and Help search,
has a canonical `/help/point-of-sale/<slug>` URL, and is included in the Help
sitemap. Claims describe shipped behaviour only, including the requirement for
an internet connection to complete a sale. The overview and troubleshooting
guides also explain that users may enter a StoreMink address without typing the
scheme and that plain HTTP is permanently upgraded to HTTPS; the articles
remain editable from the operator Help console.

**PS-0.4 ★ — Bare StoreMink addresses upgrade to HTTPS**
Open `http://pos.storemink.com`, then repeat with an arbitrary path and query.
Also open `http://{slug}.storemink.com/pos` for a real merchant.
**Expect:** the load balancer returns a permanent 308 to the identical host,
path, and query on `https://`. The product host finishes on the public POS page;
the merchant host finishes at that store's operational register. No plain-HTTP
request reaches the Next.js application.

---

## 0. Before you can test anything

| Prerequisite                                                                                                                                                                                        | Why                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Migrations `pos_00`–`pos_11`, `locations_01`–`locations_06`, `locations_08`–`locations_10`, `20260816_0003_pos_pickup_prepared_at`, and `20260816_0004_ai_credit_invoice_paid_repair` as `postgres` | Column/function/data drift otherwise                                                              |
| Store on the **Pro** plan                                                                                                                                                                           | POS and Locations are Pro-gated                                                                   |
| `POS_SESSION_SECRET` set                                                                                                                                                                            | Without it device authorization and PIN login refuse with a clear error rather than 500ing        |
| `RESEND_*` configured                                                                                                                                                                               | Staff invitations and pickup emails go nowhere otherwise                                          |
| `logistics_01_shiprocket.sql` applied + `PAYMENT_CRED_KEY` set                                                                                                                                      | Schema is ledger-verified on staging + prod (2026-08-14); the key is still needed for credentials |
| `billing_09_attempt_mandate_ceiling.sql` applied before the autopay build                                                                                                                           | Confirmation otherwise cannot retain the exact ceiling the merchant authorised                    |

**Status on local staging:** `pos_00`–`pos_11` and `locations_01`–`locations_09`
are applied. `locations_10`, `20260816_0003_pos_pickup_prepared_at`, and
`20260816_0004_ai_credit_invoice_paid_repair` are pending a `postgres` migration run; the three local theme-demo rows were
repaired explicitly for smoke testing only.
(`locations_07` added merchant postcode rules and `locations_08` removed them
again; both ran.)

---

## 0.2 Signup origin, address and pricing

**PS-0.3 — An expired signup session has an exit**
Reach the email-code step, delete or invalidate the Identity Platform user, and
submit the code.
**Expect:** the error offers both **Start signup again** and **Go to login**.
Start again clears the Firebase identity and the server cookie and returns to a
clean account step. Every later signup screen also has **Start over** in the
header. There is no dead-end instruction with no matching control.

**PS-0.4 ★ — A new store has one complete business address**
At **Where do you sell from?**, leave each of street/building, city,
state/province, postal/PIN code and country empty in turn.
**Expect:** Continue refuses each missing core field. Address line 2 remains
optional because many valid addresses do not have a suite, floor or landmark.
Complete signup, then inspect `stores.settings.business` and
`store_billing_settings`: the former has the structured address and the latter
has the same formatted invoice address, business name and verified contacts.
The first invoice must print it without requiring a second settings visit.

**PS-0.5 — Location autofill assists; it never owns the answer**
Deny browser location, block the Maps script, and complete the plain form.
Repeat with browser location allowed and then correct a geocoded field.
**Expect:** both paths finish. Autofill may populate street, city, state, postal
code and country when its provider resolves them, but every field remains
editable and coordinates remain optional.

**PS-0.6 ★★ — Signup is Free-first; dashboard upgrade uses operator pricing**
In the platform Pricing console set Basic to ₹1,500/month and ₹15,000/year with
₹2,000/₹20,000 "Was" prices; set Pro to ₹2,400/month and ₹24,000/year with
₹5,000/₹50,000 "Was" prices. Complete a fresh signup, then open Plans & Billing
from the new store dashboard.
**Expect:** signup has six stages, no plan/payment screen and creates an active
Free store immediately after Theme. The dashboard upgrade window shows Basic at
₹1,500 monthly or ₹1,250/month billed ₹15,000 yearly and Pro at ₹2,400 monthly
or ₹2,000/month billed ₹24,000 yearly, with matching "Was" figures struck
through. If the live pricing read fails, no paid checkout starts and the Free
store remains usable.

---

## 1. Plan gating & enabling POS

**PS-1.1 — A free store is told, not blocked from seeing it**
Sidebar on a free/basic store → Point of Sale.
**Expect:** an "Included in Pro" badge linking to `/dashboard/plans`. No POS
pages reachable.

**PS-1.2 — Pro store enables POS**
Pro store → sidebar → Point of Sale → "Enable POS".
**Expect:** the section expands to Overview + Settings + Staff + Devices.
`pos.enabled` flips on.

**PS-1.3 ★ — The plan gate is server-side**
With POS enabled, downgrade the store to Basic from the platform console.
**Expect:** POS pages stop working immediately. **Nothing is deleted** —
locations, staff and stock are all intact when you restore Pro. Soft-on-
downgrade: caps block NEW rows, never destroy existing ones.

**PS-1.3a ★★ — Every plan downgrade is reversible without data loss**
Start on Pro with more than 50 products, more than three staff, active coupons,
customer groups and members, customer blog drafts/submissions, saved custom
code, a custom domain, a Shiprocket connection and warehouse mappings, a saved
Analytics layout, campaign history, locations, inventory, orders and POS
history. Simulate a declined renewal that moves the store to Free.
**Expect:** no row, file reference, join, credential, setting, layout or history
is deleted, reset, unpublished or reassigned. Every existing product remains
visible and editable, but a new product and staff invite are refused at the
Free caps; gated runtime features pause. Existing groups and memberships remain
editable, unused custom roles can be deleted, and a retained custom-code section
can stay or be removed while other page edits still save. Shiprocket checkout
uses the retained manual/free option instead of exposing merchant plan copy to
shoppers. Move to Basic: the original blog submissions, custom code, Shiprocket
state and detailed Analytics return, with creation allowed up to 50 products
and three total staff. Move to Pro: the same custom domain, campaigns, advanced
Analytics, POS and unlimited catalogue access return. No restore job or manual
data repair is needed.

**PS-1.4 — A single-location store never sees Locations**
Fresh Pro store with one location and POS off.
**Expect:** no Locations entry in the sidebar. It appears once the store has 2+
locations or POS is on.

### Metered extra locations (roadmap Step 5)

⚠ These move real money on the platform's Razorpay account. Run them against a
**test-mode** account first; PS-1.9 in particular cannot be undone by clicking.

**PS-1.5 — At the included cap, the merchant is offered a location, not a wall**
Pro store with 2 locations, autopay active. Open `/dashboard/locations`.
**Expect:** "2 of 2 locations used", and an **Add a location · ₹1,000/month**
button. **Was:** "additional locations are ₹1,000/mo (coming soon)" and a
disabled button — the only item on the roadmap actively refusing money.

**PS-1.6 ★ — Buying charges now and lifts the cap in the same breath**
Press it and confirm.
**Expect:** the toast says you'll be charged the difference for the rest of the
cycle; the card reads "2 of 3"; **Add location** is enabled; and the next
StoreMink renewal invoice includes ₹5,000 + ₹1,000 (plus any applicable tax).
Create the third location — it saves. A merchant charged for a location the cap
still refuses is the failure this whole step exists to avoid.

**PS-1.7 ★ — Releasing waits for the cycle end**
With 3 locations paid for and only 2 in use, press **Release 1 unused**.
**Expect:** "You keep them until the end of this billing cycle. Nothing is
charged today." No refund is issued — that is deliberate (Step 2's rule: nobody
loses money, they keep what they bought until it runs out).

**PS-1.8 ★ — You cannot stop paying for a shop you are using**
With 3 locations, all 3 in use, try to release one.
**Expect:** refused — "You're using 1 extra location. Delete or deactivate it
before you stop paying for it." Refused, not silently clamped: a clamp leaves
them paying for a release they believed went through, and they find out on their
card.

**PS-1.9 ★★ — A plan change keeps billing for the shops they keep**
On a store paying for 1 extra location, switch monthly → yearly.
**Expect:** the next yearly invoice is ₹50,000 + ₹10,000, not ₹50,000. The
location is priced at the YEARLY rate. **Watch for:** dropping to the bare plan
price while the merchant keeps every shop — a revenue leak invisible from both
sides, and the reason `changePlan` threads the count through.

**PS-1.10 — A comped Pro store is told why, not shown a broken button**
Operator-comp a store to Pro (no Razorpay mandate). Open Locations.
**Expect:** "Extra locations are billed through your subscription. Set up
autopay to add more shops." No buy button.

**PS-1.11 ★ — The cap is server-side**
Call `createLocation` directly while at the allowance.
**Expect:** refused. A count the client could name would be a free location
(invariant 5 — a disabled control is not a permission).

**PS-1.16 ★★ — A location must fit the full next autopay invoice**
Use a Pro monthly store whose active mandate ceiling is above the location
add-ons alone but below **base plan + all extra locations + GST**. Try to buy the
location.
**Expect:** refused before Razorpay checkout with the autopay-limit message. Now
remove `max_amount_paise` from that active mandate and retry: also refused. A
missing ceiling cannot fail open because the part-period payment could succeed
today while the next automatic renewal is impossible.

**PS-1.17 ★★ — Autopay needs a chargeable billing contact**
Subscribe once with an owner email but no owner phone, then again after adding a
phone.
**Expect:** the first checkout is an ordinary one-time payment and activation
plainly says autopay was not set up. The second offers the mandate and records
its exact authorised ceiling. A phone-less mandate would enrol successfully but
fail every subsequent debit before reaching Razorpay.

**PS-1.18 ★★ — AI credits are a paid receipt, never subscription debt**
Buy the ₹59 AI-credit pack, then open `/dashboard/plans` and invoice history.
**Expect:** the credits arrive once; the invoice is issued with status `paid`;
the amber “invoice to pay” banner does not list it and the store's plan is not
at risk. Calling `startPayInvoice` with that invoice id is refused before a
Razorpay order or billing attempt is created. For a pre-fix paid purchase whose
linked invoice is `open`, apply migration `20260816_0004`: it becomes `paid`
without changing its amount or original document number.

**PS-1.13 ★ — The price comes from the operator console, not the code**
As a platform superadmin, open `storemink.com/dashboard` → Plan pricing. There
is an **Extra POS location** row with Charged/month and Charged/year (the "Was"
columns show `—`: the add-on has no pricing card, so a strike-through has
nowhere to render). Set it to ₹1,500/month and save.
**Expect:** `/dashboard/locations` on a Pro store immediately offers "Add a
location · ₹1,500/month", and buying one charges ₹1,500. Nothing needs a deploy.

**PS-1.14 ★★ — Repricing never touches a live subscription**
With a merchant already paying for one extra location at ₹1,000, change the
console price to ₹1,500.
**Expect:** the current paid cycle and any already-finalized invoice stay
unchanged; the next invoice built after the change uses ₹1,500. StoreMink owns
the renewal amount now—there is no Razorpay plan mutation—and finalized GST
documents remain immutable.

**PS-1.15 ★ — The add-on never becomes a pricing card**
After setting a price, open the public pricing page.
**Expect:** three plan cards, exactly as before. `resolvePricing` keys off
`PLAN_IDS` and ignores this row — widening it to accept arbitrary keys is the
change that would put "Extra location" on the page as a plan someone could try
to sign up to.

**PS-1.12 — Downgrading never deletes a shop**
Store with 4 locations (2 paid) → downgrade to Basic.
**Expect:** all 4 locations still exist and POS stops working. No new ones can
be created. Soft-on-downgrade, invariant 1.

---

## 2. Locations & capabilities

**PS-2.1 — Create a second location**
`/dashboard/locations` → add "Mumbai Shop", type Shop.
**Expect:** it appears in the list; a default-capability set is applied from its
type; the sidebar Locations entry is now visible.

**PS-2.2 — Capabilities are per location**
Open Mumbai → tick **Customer pickup**.
**Expect:** refused with _"Turn on Sell here first"_ until **Sell here** is
ticked. Someone has to physically hand the goods over.

**PS-2.3 ★ — A disabled checkbox is not a permission**
Turn off **Sell here** on a location that has **Customer pickup** on, and save.
**Expect:** pickup is stored OFF too — the cascade is applied server-side, so
stored state can never disagree with what `locationCan` reports.

**PS-2.4 ★ — The last fulfilling location can't be switched off**
Ensure exactly one location has **Fulfil online orders**, then try to untick it.
**Expect:** refused with _"This is the only location that fulfils online
orders."_ Otherwise the store advertises products it has no way to ship and
every checkout fails with no visible cause.

**PS-2.5 ★ — The backfill preserved behaviour**
On a store that existed before `locations_01`: check the default location.
**Expect:** **Fulfil online orders ON** (it describes what was already
happening), **Customer pickup and Accept returns OFF** (they introduce new
behaviour). A migration may not change what a live store does.

**PS-2.9 ★ — A newly created store can sell its seeded stock online**
Create a store after `locations_10`, then inspect its auto-created Main location
and one stocked product on the storefront.
**Expect:** Main stores `online_fulfil: true`; inventory seeded at Main
contributes to both aggregate and online stock; the PDP is not falsely sold out.

**PS-2.7 — Rename a location**
Open a location → Details → change the name → Save details.
**Expect:** saved, and the heading and list both update. Type, address, GSTIN,
GST state code and receipt prefix are all editable on the same card and save
together — the location editor is the full page, matching the products
convention (edit is a page, only "New" is a dialog).

**PS-2.10 — A location leads directly to its stock**
Open `/dashboard/locations` and select **View inventory** on Mumbai. Repeat from
Mumbai's location editor.
**Expect:** both open `/dashboard/inventory?location=<mumbai-id>` and the stock
location panel says Mumbai. The merchant does not have to rediscover the same
location in another selector.

**PS-2.8 ★ — Saving details doesn't blank the rest**
Change only the name and save.
**Expect:** type, address and tax fields are unchanged. `updateLocation`
replaces the whole row, so a partial send would wipe them — and a missing type
would silently turn a warehouse into a shop.

**PS-2.6 — Pickup and returns are Pro-only**
On a Basic store (if you can reach the page).
**Expect:** a padlock on Customer pickup and Accept returns.

**PS-2.11 — Fulfilment stays inside the Locations navigation**
Open `/dashboard/locations`, then use the left Locations panel to select
**Online fulfilment & pickup**. Deep-link directly to
`/dashboard/locations/fulfilment` and reload once.
**Expect:** the left panel contains **All locations** and **Online fulfilment &
pickup** in both cases, the current child is highlighted, and the page does not
fall back to the main dashboard rail. The locations list does not repeat a
second fulfilment button above its cards.

**PS-2.12 — Routing and pickup settings form one aligned workspace**
Open **Locations → Online fulfilment & pickup** at desktop, tablet, and phone
widths.
**Expect:** Website order routing and Checkout share the same left edge and
maximum width. Routing method and Location priority sit side by side when
space permits and stack cleanly on a narrow screen. Eligible locations have
aligned priority controls; ineligible locations remain visible with an
**Enable in location** link. **Skip deactivated locations** and **Save routing**
share the routing footer instead of floating in separate whitespace.

**PS-2.13 — A narrow Locations panel still names every destination**
Resize the desktop sidebar to its minimum width, then open the mobile drawer.
**Expect:** **Online fulfilment & pickup** wraps onto a second line when needed;
no part of the label is replaced by an ellipsis. The icon remains aligned with
the first line, the active background contains both lines, and short labels
such as **All locations** remain compact.

---

## 3. Location scope — staff see only their location

**PS-3.1 — An unbound admin sees everything**
`/dashboard/locations` → Admin access → leave an admin with no locations ticked.
**Expect:** they see every location's orders and inventory. **Absence is not
restriction.**

**PS-3.2 ★ — A bound admin sees only their shop**
Bind an admin to Mumbai only. Sign in as them.
**Expect:** `/dashboard/orders` shows only orders routed to Mumbai;
`/dashboard/inventory` opens on Mumbai, names it in the stock-location panel,
and does not offer a store-wide aggregate.

**PS-3.3 ★ — Naming another location in the URL is refused**
As that Mumbai-bound admin, hit `/dashboard/inventory?location=<pune-id>`.
**Expect:** refused server-side, not just hidden in the UI.

**PS-3.4 ★★ — Mink AI reads the same shelves the admin may see**
As the Mumbai-bound admin, ask Mink AI which items are low in stock, then ask
for Pune by its exact name.
**Expect:** the aggregate list is calculated only from the admin's trusted
Mumbai assignment. The Pune request returns a safe inaccessible-location error;
the prompt cannot supply a location ID or widen the assignment.

**PS-3.5 — Inventory permission removes the Mink stock tool**
Use an admin with Dashboard → View but without Inventory → View and ask for the
low-stock list.
**Expect:** `list_low_stock` is absent from the model's tool manifest and a
direct function-call attempt is rejected again at execution. No inventory row
is read and Mink explains that the current read-only assistant cannot access it.

**PS-3.6 ★★ — Mink order cards preserve location and channel scope**
As a Mumbai-bound admin with Orders → View, ask for today's Website orders,
then today's POS orders, and then Pune orders.
**Expect:** the first two answers render order cards and visibly repeat Today,
the trusted Mumbai assignment and the selected Online/POS channel. The Pune
request is refused; neither prompt text nor a supplied record identifier can
widen the trusted assignment. Unassigned legacy/online orders follow the same
aggregate scope contract as the dashboard order book.

**PS-3.7 ★★ — Selected orders are tenant-revalidated and PII-minimized**
Open an order drawer and ask Mink about “this order”; repeat as an admin without
Customers → View, then attempt to place another store's order ID in the page
markup or request body.
**Expect:** `get_current_order` is offered only after the server confirms that
the selected order belongs to the current store. Customer output is at most a
first name plus surname initial when Customers → View is allowed, otherwise it
says details are hidden; email, phone and address never appear. A foreign or
invalid selection is discarded and cannot cause an order read.

**PS-3.8 — Missing order permission removes both Mink order tools**
Use an admin without Orders → View and ask for recent orders while an order
drawer is open.
**Expect:** both `list_orders` and `get_current_order` are absent from the model
manifest, a direct call is rejected at execution, and no order/customer row is
read.

**PS-3.9 — Invited beta access fails closed per store**
With `MINK_AI_ENABLED=true` and `MINK_BETA_REQUIRE_INVITE=true`, remove the
store's invitation from its operator detail page, then add it again.
**Expect:** the uninvited store receives the canned assistant and cannot call
stream/history/feedback endpoints. The invited store receives the read-only
agent; another store remains unchanged. The global flag can still stop all
stores independently.

**PS-3.10 ★★ — A displayed location type is a safe alias, not a wider scope**
Keep **Delhi** as a Warehouse and ask Mink for “today's sales for Delhi
warehouse”. Repeat with “warehouse Delhi”, then ask for “Delhi shop”; run the
same prompts as an admin assigned only to Mumbai.
**Expect:** the first two owner requests resolve to the canonical **Delhi** row
and the answer card names Delhi rather than all locations. “Delhi shop” is
refused because the type is wrong. The Mumbai-bound admin cannot resolve any
Delhi alias. A missing, ambiguous or inaccessible named location is never
silently retried as an all-location sales, inventory or order request.

**PS-3.11 ★★ — Mink catalogue health matches the Inventory SKU model**
Create a published variant product with one variant at 4 units and an effective
threshold of 5, plus another variant with 0 at Shop but stock at another
location. Ask “How many products are published, unpublished, draft, archived,
low in stock and out of stock?”, then choose **Compare locations**. Repeat with
**Combined stock** and with “at Shop”.
**Expect:** publication totals count products; Draft and Archived are subsets of
Unpublished. Stock totals count sellable SKUs (simple products without variants
plus each variant), use per-SKU threshold with the store default fallback, and
match Inventory. With multiple accessible locations, the vague question first
offers permission-safe Compare, Combined and exact-location choices instead of
returning counts. Compare shows Shop and the other accessible shelves
independently; a missing tracked shelf row counts as zero/out of stock. Combined
reports only the aggregate, and Shop reports only that shelf; none is presented
as another. The bounded exact/combined card lists products/variants with
publication and stock badges, quantities, thresholds and trusted dashboard
links. The comparison is bounded to 20 locations and each row can request its
exact SKU list. With one accessible location, Mink uses it automatically.
Without Inventory → View, publication data remains available but stock
counts/fields stay hidden and no shelf data is read.

**PS-3.12 — Mink answers remain readable and inert**
Return an answer containing headings, paragraphs, ordered and nested lists, a
table, bold text, inline/fenced code, a returned dashboard path, raw HTML and an
arbitrary external URL.
**Expect:** supported Markdown renders with compact ChatGPT-style typography and
the dashboard path is clickable. Raw HTML remains visible text, not a DOM node;
the arbitrary URL is not clickable. Restored conversation history renders the
same structured catalogue artifact. The answer has copy/helpful/report controls
and no grey assistant speech bubble.

**PS-3.13 ★★ — Mink reviews delayed pickups without becoming a second reminder job**
As an Echos admin with Mink drafting and Orders Manage, create controlled
Awaiting/Ready pickup fixtures at Shop and Delhi, including an Awaiting order
past its promised-ready time, a Ready order inside 48 hours with no reminder
marker, and one whose marker is already recorded. Ask the exact Phase 6E
prompts from `docs/mink-ai-test-prompts.md` for both locations and separately
for Shop and Delhi warehouse.
**Expect:** exact location aliases never widen; only live Awaiting/Ready,
non-cancelled, non-refunded and not-yet-expired pickups appear. The card is
bounded to 25 rows, keeps each location explicit, links by visible order
reference, and exposes no customer name, email, phone, address, note or
collection code. Awaiting delay copy keeps the revised ready time as a
staff-confirmed placeholder. A pending or recorded automatic reminder
withholds duplicate collection copy. The workflow does not send/queue/save a
message, change the reminder marker, status or deadline, release a hold, or
move stock. Removing Orders Manage, drafting or location authority cancels or
narrows the next step; a restart/retry still produces one run and one
completion notification. The existing pickup expiry and one-time reminder
sweeps behave exactly as before.

---

## 4. Inventory — the dashboard

**PS-4.0 — Multi-location inventory opens on a real shelf**
Open `/dashboard/inventory` with two or more accessible locations and no
`location` query parameter.
**Expect:** the default/first accessible location is selected, its name is
prominent, and the page says every change affects only that location. A bound
admin lands on their first accessible location, never another store shelf.

**PS-4.1 — A single-location store sees no selector**
**Expect:** `/dashboard/inventory` looks exactly as it did before multi-location.

**PS-4.2 — "All locations" is read-only**
Multi-location store → select **All locations**.
**Expect:** totals shown under an explicit **All locations (view only)** state.
Editing and bulk selection are disabled, and clicking a row does not open the
stock drawer. You cannot adjust a sum.

**PS-4.3 ★ — A correction is computed against THAT shelf**
Product with 10 in Mumbai and 5 in Pune (total 15). Select Mumbai, set stock to 8.
**Expect:** Mumbai becomes 8, Pune stays 5, total 13. **Not** a delta computed
against 15 — that would write a wildly wrong correction.

**PS-4.4 ★ — A shop that never carried a SKU counts as zero**
Bulk-adjust a SKU at a shop that has never stocked it.
**Expect:** it's stocked from zero, not skipped. That's the normal case when
opening a new shop.

**PS-4.5 — Ledger**
Any adjustment → open the history drawer.
**Expect:** the read is server-authorized and filtered to the selected location;
the drawer and each current entry name that location. The append-only row stores
quantity, reason, actor and location. The current drawer does not display the
operator identifier.

**PS-4.6 — Product editing hands stock off without a fake input**
Open an existing simple product and then a product with existing variants.
**Expect:** both expose a dedicated **Inventory** tab with the store-wide total
and **Manage stock by location**. Existing variant quantities are read-only in
the product form and link to Inventory; a new variant alone accepts opening
stock for the main location. Saving an existing variant never appears to accept
an inventory edit that the server ignores.

---

## 5. Inventory — from the shop floor (`/pos/inventory`)

**PS-5.1 — A cashier can't**
Sign in as a cashier → `/pos/inventory`.
**Expect:** refused. A cashier sells stock; they don't declare how much exists.

**PS-5.2 — Receive / correct**
As a manager: search or scan a product → receive +10.
**Expect:** on-hand at the operator's own location rises by 10; a ledger row is
written.

**PS-5.3 ★ — A count is stored as a DELTA**
Count a product to an absolute figure while a sale for it is rung on another
till.
**Expect:** the sale is not erased — the count goes through the same atomic
adjustment and leaves a normal ledger row. A count that matches writes nothing.

**PS-5.4 ★ — A transfer is atomic**
Send 5 units from Mumbai to Pune.
**Expect:** Mumbai −5 and Pune +5, with paired `transfer_out` / `transfer_in`
ledger rows. Both legs commit or neither does — one plpgsql transaction, so
units can never cease to exist on the store's books.

**PS-5.5 ★ — Two managers can't both move the last units**
Two managers transfer the last 5 units simultaneously.
**Expect:** one succeeds, one is refused. The source decrement is conditional on
having the stock.

**PS-5.6 — A correction to zero still alerts**
Manually correct a tracked SKU to 0.
**Expect:** the out-of-stock notification fires, exactly as if a sale had
emptied it.

---

## 6. Staff, devices & the register shell

**PS-6.1 — Invite a cashier**
`/dashboard/pos/staff` → invite by name, email, role, locations.
**Expect:** an email arrives with a `/pos/register?token=…` link. **The admin
never sets or sees a PIN.**

**PS-6.2 — Self-registration**
Open the link → password twice → phone OTP → 8-digit PIN twice.
**Expect:** account created, status invited → active, token consumed. Re-opening
the link now fails.

**PS-6.3 ★ — Staff are bounced out of the dashboard**
As that cashier, visit `/dashboard`.
**Expect:** redirected to `/pos`. The role claim in the session cookie is what
does this — no DB query in the proxy.

**PS-6.4 — Login, both modes**
`/pos` → email + PIN, and email + password.
**Expect:** both work. PIN mints the `pos_operator` cookie; password uses the
standard session.

**PS-6.5 ★ — A cashier cannot sell from an unauthorized browser**
Sign in as a cashier in a fresh private window.
**Expect:** refused with a pairing prompt, not a sale screen. Owners are not
device-restricted.

**PS-6.6 — Authorize a device**
As owner on the till: "Authorize this device". Or dashboard → Devices →
generate a code → enter it at `/pos`.
**Expect:** authorized; the code is single-use and expires in 10 minutes.

**PS-6.6a ★★ — Only the owner may GRANT device trust**
Sign in as a delegated dashboard admin (a non-superadmin role with the POS
section) and try "Authorize this device", then try generating a pairing code.
**Expect:** both refused — _"Only the store owner can authorize a device."_ No
`pos_devices` row is written and no cookie is set. A device grant hands a
browser the lasting ability to take money, so it is not delegable. Redeeming a
code (`pairDevice`) is unchanged: the code itself is the authorization.

**PS-6.6b ★★ — But that same admin CAN revoke**
As the delegated admin, revoke a device from dashboard → POS → Devices.
**Expect:** it works. Revocation only ever takes trust away, and making the
owner the only person who can kill a stolen or cloned till would leave it live
for hours. The asymmetry is intentional and test-pinned.

**PS-6.7 ★ — A copied cookie is detected**
Copy the `pos_device` cookie to another browser and use it after the original
signs in again.
**Expect:** the device is revoked and `device_clone_detected` appears in
`/dashboard/pos/devices`. A valid signature can't catch a clone — the rotating
nonce can.

**PS-6.8 ★ — Revoking ends the session at once**
Revoke a device while its operator is mid-session.
**Expect:** their next request fails. The cookie is never trusted for
authorization — `pos_staff` is re-read on every resolve.

**PS-6.9 — Deactivating a staff member ends their session**
Same, via Staff → deactivate.
**Expect:** signed out on the next request, not when the token lapses.

**PS-6.10 — Forgot PIN or password**
`/pos` → "Forgot PIN or password?" with a real address, then a bogus one.
**Expect:** identical success message both times (enumeration-safe); only the
inbox differs. The link is single-use, 1 hour.

**PS-6.10a ★★ — Permanent store deletion removes registered POS identities**
Register a cashier or manager, permanently delete the store from the operator
console, recreate the store, and invite the same email again.
**Expect:** registration can create a fresh account with a fresh password. The
delete path must collect `pos_staff.user_id` before the database cascade; the
cascade removes the staff row but cannot remove its Identity Platform login.

**PS-6.10b ★★ — Store deletion is complete without breaking shared people**
Give one Firebase identity a role in the store being deleted and a second
StoreMink role (another store or the platform console). Add unused Media Library
files, an uploaded-but-unsaved image/video, a custom domain, a store-policy
acceptance, a reconciliation item and a platform-announcement recipient; then
permanently delete the store.
**Expect:** every store-owned SQL row is cascade-deleted; referenced and
abandoned objects below `stores/{storeId}/` are gone; custom-domain certificate,
authorized-domain, Search Console, Site Verification and any legacy Resend
domain resources are removed.
The shared identity still signs in to its remaining role. A failed external
cleanup is shown to the operator as a warning instead of being reported as a
complete purge.

**PS-6.11 — Idle auto-lock**
Sign in with a PIN, leave the till for `pos.idleLockMinutes` (default 10).
**Expect:** a **5-minute** countdown ("Locking in 1:58"), then locked. Touching
the screen or "Stay" dismisses it. **Only the superadmin is exempt** — a
delegated dashboard admin locks like any operator.

**PS-6.11a ★★ — The lock actually locks a session-cookie actor**
Sign in with email + PASSWORD (staff), or as a delegated admin, and let the
timer run out.
**Expect:** you land on `/pos/login` and **STAY** there. Clearing the
`pos_operator` cookie alone would not do it — `resolvePosOperator` re-resolves a
session cookie and `/pos/login` sends a resolvable operator straight back to
`/pos`, so the lock would be a flash for exactly these people. `posLock` clears
`sm_session` too, which means **it also signs them out of `/dashboard`** — that
is the intended trade (the walked-away session is the risk) and the reason the
superadmin is exempt.

**PS-6.12 ★ — The warning never outruns the idle window**
Set `pos.idleLockMinutes` to 1 (its minimum) and leave the till.
**Expect:** the banner appears with 30s left, not immediately — the warning is
capped at half the window, so a short setting doesn't put it on screen
permanently.

**PS-6.13 ★★ — EVERY screen locks, not just the two that asked**
Set `pos.idleLockMinutes` to 1. As a cashier, go to each of `/pos`,
`/pos/sell`, `/pos/inventory`, `/pos/shift`, `/pos/pickups` and `/pos/sales`
in turn and leave the till alone on each.
**Expect:** all seven warn and then lock to `/pos/login`.
**Was:** only `/pos` and `/pos/sell` locked. The other five never did — so the
till sat unlocked indefinitely on the screens that issue refunds, adjust stock
and move cash, which are the ones where walking away costs most.

**PS-6.14 — One timer, not two**
On `/pos` and `/pos/sell` (the two that used to mount their own), let the
warning appear.
**Expect:** exactly ONE amber banner, and one lock. Two mounts would run two
countdowns and fire two `posLock()` calls.

**PS-6.15 — The login screen doesn't lock itself**
Sit on `/pos/login`, `/pos/register` and `/pos/reset` past the idle window.
**Expect:** nothing happens. No operator means nothing to lock, and a timer
redirecting to the login page FROM the login page is a loop.

---

## 7. The register (`/pos/sell`)

**PS-7.1 — Scan and sell**
Scan a barcode (hardware scanner, or camera on mobile).
**Expect:** the line is added in well under a second. Unknown code → a clear
miss, and the server is asked before giving up (a product created since the last
sync must stay sellable).

**PS-7.2 ★ — The quoted total is the charged total**
Add items on a taxed product, and note the total on screen. Complete the sale.
**Expect:** identical. Tendering exactly the quoted amount is accepted, and
change is calculated from that same figure. Both sides call `posTotals`.

**PS-7.3 ★ — Money compares in paise**
Tender the exact total on a cart whose total has a fractional component.
**Expect:** accepted as paid in full. A rupee-float compare would refuse an
exactly-covering payment.

**PS-7.4 — Line discount**
As the owner, mark one line down (a damaged tin).
**Expect:** the receipt prints `2 × ₹100 … ₹200 / Less −₹30 = ₹170`, and the
line total is net of it.

**PS-7.4a ★ — Only the owner can discount (default)**
Sign in as a **cashier**, then as a **manager**. Look at the cart.
**Expect:** no "Discount ₹" field and no per-line "Less ₹" field for either.
Sign in as the owner (the store's superadmin): both are there.

**PS-7.4b ★ — And the server says no, not just the screen**
As a cashier or manager, call `placePosSale` directly with `orderDiscount: 50`
(or a `lineDiscount`).
**Expect:** refused — _"Only the owner can apply a discount."_ Both kinds are
blocked: "Less ₹50" per line is the same act as "Discount ₹50" on the sale.

**PS-7.4c ★★ — A manager's PIN cannot unlock it**
Repeat PS-7.4b with a genuine `approvalToken` (mint one by entering a real
manager PIN on the same cart).
**Expect:** STILL refused, and NO PIN prompt appears on screen
(`needsApproval` is never returned). The manager is one of the people being
kept out, so their own PIN must not be the key.

**PS-7.4f ★★ — Approval is a signed grant, not a claim**
Turn `pos.ownerOnlyDiscounts` OFF (so the cap machinery is live) and, as a
cashier, call `placePosSale` with `orderDiscount` over `pos.maxDiscountPercent`
and: (a) no `approvalToken`; (b) `approvalToken: "true"`; (c) a token minted for
a SMALLER discount; (d) a token minted for a different cart; (e) a token minted
at another location.
**Expect:** all five come back `needsApproval` and write nothing. Only a token
minted by `verifyManagerPin` for THIS cart, till and operator, inside 3 minutes,
completes the sale. Before this, `managerApproved: true` from the browser was
enough — the PIN pad was a UI step, not a gate.

**PS-7.4d ★★ — A price override is a discount, and is blocked too**
As a manager, call `placePosSale` with a line `priceOverride` well under the
listed price.
**Expect:** refused — _"Only the owner can change a price on a sale."_ Marking a
₹200 tin down to ₹1 is discounting it by ₹199; leaving this open would make
PS-7.4b decorative. `pos.allowPriceOverride` is a different question (may the
till reprice AT ALL — it stops the owner too); this is who.

**PS-7.4e ★★ — POS access is delegable; discounting is not**
Give a second dashboard admin a non-superadmin role that grants the POS section.
Sign in as them at `/pos` and try to discount or reprice.
**Expect:** refused. They resolve as `owner` (not `superadmin`) and run the till
normally otherwise — they can still sell, adjust stock, and authorize this
device. Without this split, "owner only" means "anyone ever given a dashboard
login with POS on".

**PS-7.5 ★ — Splitting a giveaway doesn't dodge the cap**
Turn `pos.ownerOnlyDiscounts` OFF (this is what re-arms the cap at all), set
`pos.maxDiscountPercent`, then split the same total discount across several line
discounts instead of one order discount.
**Expect:** still counted together, still needs a manager PIN above the cap.

**PS-7.6 — Manager override**
With `pos.ownerOnlyDiscounts` off, exceed the cap as a cashier (and separately,
send a `priceOverride`).
**Expect:** a manager PIN is required and recorded for both. A manager is exempt
from the cap (`discount_over_cap`).

**PS-7.6a — Repricing can be switched off outright**
Turn `pos.allowPriceOverride` off and send a `priceOverride` **as the owner**.
**Expect:** refused — _"Price overrides are turned off."_ It is a store policy,
not a permission, so it stops the owner too.

**PS-7.7 ★ — Prices are re-read server-side**
Tamper with a price in the client before completing.
**Expect:** the server's price wins. The catalog cache is never authoritative.

**PS-7.8 — Sold-out sinks**
Take a product to zero.
**Expect:** it moves to the end of the grid and is disabled — the ordering and
the disabled state agree because they share one definition.

**PS-7.9 — Register layout**
As manager: "Edit layout" → drag products from the left panel into the grid.
**Expect:** an in-place slide-over (not a new page), finger-draggable, showing
"12 of 20 products". Cashiers don't see the button.

**PS-7.10 ★ — Layout never makes a product unsellable**
Leave products out of the layout, then search for one.
**Expect:** found and sellable. The layout decides the IDLE grid only.

**PS-7.11 ★ — Restocking restores the manager's position**
Restock a sold-out product that had sunk to the end.
**Expect:** back in its configured slot with no edit. The shift is computed at
render, never written back.

**PS-7.12 ★ — No layout row = the whole catalogue**
A location that has never configured a layout.
**Expect:** every product shows. The feature cannot blank a till that predates
it, and a failed read degrades to everything rather than an empty screen.

**PS-7.13 ★ — A register sale emits like a sale**
Complete a sale that empties a SKU.
**Expect:** an entry in `/dashboard/logs`, the team notification fires, and
the low/out-of-stock alert fires. An in-store sale is a sale.

**PS-7.14 ★ — Cancelling a POS sale restocks at ITS OWN shop**
Sell from Mumbai, then cancel that order from the dashboard.
**Expect:** Mumbai regains the units. **Not** the default location — that would
silently compound an error on every cancellation.

**PS-7.15 — Attach a customer**
Search by phone/name/email.
**Expect:** only existing customers of this store. The till cannot create one.

**PS-7.16 ★ — A foreign customer is refused**
Attempt a sale against another store's customer id.
**Expect:** refused server-side. They hold RLS SELECT on their own orders and
would otherwise see a foreign order in their history.

**PS-7.17 — GSTIN on the bill**
Enter a business buyer's GSTIN.
**Expect:** format-validated, uppercased, printed. It works with no customer
attached.

### Customer Online / In-store history

**PS-7.17a — Delivery-only stores stay simple**
On a store with pickup off and no active shop that can use StoreMink POS, sign
in as a shopper and open `/orders`.
**Expect:** no Online/In store tabs. The ordinary combined order list/empty
state remains. An external till does not count because StoreMink cannot attach
or read its receipts.

**PS-7.17b — A working physical journey reveals the split**
Enable StoreMink POS at an active `pos`-capable shop, or enable checkout pickup
with an active `pickup`-capable shop, then open `/orders`.
**Expect:** equal-width **Online** and **In store** tabs. Home-delivery website
orders are Online; StoreMink till sales and pickup orders are In store.

**PS-7.17c ★ — A setting cannot advertise a journey by itself**
Leave POS/pickup settings on but deactivate the only eligible shop, remove its
capability, use only a warehouse, or let the Pro plan expire.
**Expect:** the In store tab is not offered to a customer with no physical-store
history. Settings, location capability, active state and effective plan must all
agree.

**PS-7.17d ★ — Disabling a feature never hides a receipt**
Attach a customer to a POS sale and place a pickup order, then disable POS and
pickup (or deactivate the location). Sign in as that customer.
**Expect:** In store remains visible and both historical orders remain there.
Feature gates stop future journeys; they never erase or conceal customer-owned
history.

**PS-7.17e — Each tab has useful empty guidance**
Open a tab with no matching orders.
**Expect:** a centred channel-specific icon, title and explanation. Online links
to Shop; pickup-capable In store links to Shop for pickup; POS-only In store
explains that the cashier must attach the customer's account.

**PS-7.17f ★ — A POS receipt is not presented as delivery**
Open a customer-linked POS order from In store.
**Expect:** an **In store** badge, “Purchased in store”, the sale location,
items, totals and invoice. No shipment timeline and no empty delivery-address
card. An anonymous walk-in remains invisible until roadmap Step 4 adds safe
claim/merge identity.

**PS-7.18 — Offline-ish speed**
Throttle the network to slow-3G and search the catalogue.
**Expect:** search still instant — it's served from the local IndexedDB cache.
Completing a sale still needs the server.

**PS-7.19 ★ — Tapping a product must not open the keyboard (iPad)**
On a tablet, tap several products into the cart.
**Expect:** the software keyboard NEVER appears — not on load, not on any tap.
Sticky focus on the search box is switched off wherever `hover: none` and
`pointer: coarse`, because iPadOS answers a programmatic focus by opening the
keyboard over half the till. A laptop with a touchscreen keeps sticky focus.

**PS-7.19a ★★ — Hydration cannot summon the phone keyboard**
Cold-load `/pos/sell` on an iPhone or touch-primary tablet and do not touch the
search field. Tap a product as soon as the grid appears, then repeat after a
normal reload.
**Expect:** the keyboard never opens. The focus decision rechecks the live media
query instead of trusting the initial server snapshot, which reports non-touch
during hydration. On a keyboard-first till the search still receives sticky
focus without scrolling the register.

**PS-7.19b ★★ — POS typing does not zoom or create a second page scroll**
On iPhone Chrome/Safari, focus catalogue search, a line/order discount, customer
mobile, and any tender field; type and dismiss the keyboard. Scroll Products to
its end, switch to Cart, and repeat.
**Expect:** the visual scale and full-width alignment never change, the camera
control cannot push search outside the viewport, and only the active Products
or Cart area scrolls. A boundary swipe never moves the POS shell or reveals a
horizontal page strip. All editable POS controls render at least 16 px on
touch-primary hardware.

**PS-7.20 ★ — A tablet still scans, with nothing focused**
On that same tablet, with a paired hardware scanner and no field focused
(e.g. straight after tapping a product tile), scan a barcode.
**Expect:** the line is added. Turning sticky focus off must not cost a tablet
its scanner — a document-level wedge reads the burst instead.

**PS-7.21 ★ — A scan does not re-ring the tapped product**
Tap a product tile (it now holds focus), then scan a DIFFERENT product.
**Expect:** the scanned product is added, once. The wedge swallows the burst —
Space and Enter both activate a focused button, so an unhandled scan would add
the tapped item again.

**PS-7.22 — Typing a search is never intercepted**
Tap the search box and type a product name.
**Expect:** the characters go to the box and the grid filters. The wedge stays
out of the way whenever an editable element has focus.

**PS-7.23 — Overlays keep their own focus**
Select **Charge**, focus the mobile-number field (or expand the optional receipt
details on Payment) and type.
**Expect:** the field keeps focus. The register never pulls focus back to the
scan box while an overlay owns the screen.

**PS-7.24 ★★ — A 0% discount cap means ZERO, not the default**
Turn OFF `pos.ownerOnlyDiscounts`, turn ON
`pos.requireManagerForDiscount`, and set `pos.maxDiscountPercent` to **0** (the
registry allows it: `min: 0`). As a cashier, ring a ₹100 sale and apply a ₹5
discount.
**Expect:** "A manager's PIN is needed to approve this (over 0%)." A cap of 0
is the merchant saying a cashier may discount NOTHING unaided.
**Was:** allowed. The cap was read as `Number(…) || 10`, so a deliberate 0
became the 10% default and handed cashiers exactly the authority the merchant
had withheld — the strictest setting behaving as the most permissive.

Then ring the same ₹100 sale with **no** discount.
**Expect:** it goes through. A 0 cap must not become "refuse everything".

**PS-7.25 ★★ — The phone register is not a squeezed desktop till**
Open `/pos/sell` at 459px wide (the reported failure), then at a portrait-tablet
width below 1024px. Add several products.
**Expect:** Products uses the full working width with two or more readable
product columns; the fixed 360px cart is not sitting beside it. Adding an item
keeps Products open and updates both the cart badge and the persistent **View
cart · N** action with the live total. Select View cart: Cart now uses the full
width and exposes the complete line, quantity, discount, totals, Charge, Hold
sale and Held controls. Select Products to add another item without losing the
cart. As a manager, the compact grid icon opens layout editing on Products and
Cart stays disabled until editing closes. At 1024px and wider, the product grid
and 360px cart return side by side. Hold or complete a sale on mobile and start
the next one: Products is selected again.

---

## 7b. Checkout payment defaults & collection payment policy

Roadmap Step 1. ⚠ PS-C.3 and PS-C.4 change what shoppers are charged — run them
against a store whose Razorpay is in **test mode**.

**PS-C.1 ★★ — A gateway-connected store defaults to ONLINE**
Connect Razorpay in Channels, then open `/checkout` with items in the cart.
**Expect:** "Pay online" is the first payment method and is pre-selected.
Disconnect Razorpay and reload checkout: the online option is absent entirely,
and the appropriate offline method is selected instead.
**Was:** Cash on Delivery, always — `useState("cod")` was hardcoded and nothing
reconciled it with the gateway config. Every merchant who connected a gateway
watched shoppers land on the option that costs them a courier round trip.

**PS-C.2 ★ — It never overrides a choice the shopper made**
Open `/checkout` and tap **Cash on Delivery** immediately, before the page
settles.
**Expect:** it stays on COD. The config and pickup policy both arrive after
first paint, and a default re-applied on their arrival would yank the selection
out from under someone mid-tap.

**PS-C.3 — Prepaid collections**
Locations → Online fulfilment → set **Payment for collection orders** to "Pay
online only". At checkout, switch to Pickup.
**Expect:** only "Pay online" is offered, with a line saying this store takes
payment for collection orders when they are placed. COD/pay-at-store is gone.

**PS-C.4 — Pay at the counter only**
Set it to "Pay at the counter only" and switch to Pickup.
**Expect:** only the counter option is offered, even though Razorpay is
connected.

**PS-C.5 ★ — Delivery is untouched by the collection policy**
With either policy set, switch back to Delivery.
**Expect:** both options are offered again. A policy about collections says
nothing about courier orders, and silently switching COD off for them would be a
policy the merchant never set.

**PS-C.6 ★★ — The policy is enforced server-side**
With the store on "Pay online only", call `placeOrder` directly with
`paymentMethod: "pay_at_store"` and a pickup location.
**Expect:** refused — "That payment method isn't available for collection orders
at this store." A control the UI hides is not a permission (invariant 5);
without this the goods are held and nobody ever owes anything.

**PS-C.7 ★ — "Pay online only" needs a gateway**
On a store with no Razorpay connected, try to set the policy to "Pay online
only".
**Expect:** refused at save — "Connect a payment gateway in Channels before
requiring collection orders to be paid online." Otherwise pickup becomes
unorderable and it is a shopper who discovers it.

**PS-C.8 — A retired policy value falls back**
Hand-edit `stores.settings.features["fulfilment.pickupPayment"]` to `"nonsense"`.
**Expect:** checkout behaves as "Let the customer choose". A stricter policy
nobody chose must never be imposed by a typo (invariant 6).

---

## 7c. Cancellation & refund flow (roadmap Step 2)

⚠ Needs `supabase/orders_01_cancellation.sql` applied. PS-D.6–D.9 move real
money — use a **test-mode** gateway.

**PS-D.1 — The merchant sets the rules**
Orders → Settings. Turn **Let customers cancel their own orders** on.
**Expect:** a **Cancellation window** select (No cancellations / Until fulfilled
/ 1 hour / 24 hours / Custom hours) and a **Cancellation approval** select,
defaulting to **Require my approval**.

**PS-D.2 — Asking is not cancelling**
As a customer, open a pending order → **Cancel order** → confirm.
**Expect:** the panel says it cancels **the entire order** and that the store
reviews it. After submitting: "Cancellation request submitted." **The order is
still active** — status unchanged, stock not returned, no money moved.
**Was:** it cancelled outright the moment the button was pressed.

**PS-D.3 ★ — One request, and a decline sticks**
Submit a second request on the same order.
**Expect:** refused ("already asked"). Have the merchant decline it, then try
again: refused, quoting the decline. A decline that can be reopened by asking
again means nothing.

**PS-D.4 ★ — The window is enforced server-side**
Set the window to 1 hour. On an order placed two hours ago, call `cancelMyOrder`
directly.
**Expect:** refused — "within 1 hour". A window enforced only in the browser is
not enforced (invariant 5).

**PS-D.5 ★ — "Until fulfilled" is not a duration**
Set the window to **Until fulfilled**. Request cancellation on an order placed
three months ago that nobody has fulfilled.
**Expect:** accepted. Then mark an order shipped and try: refused, and pointed
at returns.

**PS-D.6 — Approving cancels the whole order**
Orders → Cancellations → **Approve & cancel**. Choose a refund destination, a
reason, leave Restock and Notify ON, add a staff note.
**Expect:** order cancelled, stock returned, customer notified. The staff note
appears **nowhere** the customer can see.

**PS-D.7 — Refund to store credit uses the existing balance**
Approve with **Store credit** on a ₹2,000 paid order.
**Expect:** ₹2,000 on the customer's balance, AND an `order_refunds` row — the
refund goes through `issueRefund`, not a separate credit path, so the order's
refund cap and payment status stay correct.

**PS-D.8 ★★ — A failed refund is never reported as success**
Break the gateway (wrong key) and approve with **Original payment method**.
**Expect:** "Order cancelled, but the refund failed: …". The order IS cancelled
— that claim already committed — but nobody is told they were refunded when
they were not.

**PS-D.9 ★★ — An unknown gateway answer is not a failure**
Force a timeout on the refund call.
**Expect:** "the refund is in flight — don't send it again." NOT an error.
Reporting this as failed is how a customer gets paid twice (CODEBASE §26).

**PS-D.10 — Declining requires a reason, and the customer reads it**
Decline a request with the reason box empty.
**Expect:** refused. With a reason: the order stays **active** and the customer
is notified with those exact words.

**PS-D.11 — Automatic approval, off by default**
Confirm a request waits by default. Switch approval to **Approve
automatically**, then request again.
**Expect:** the order cancels immediately. **Watch for:** it must still restock
and notify.

**PS-D.12 ★ — Only honourable refund destinations are offered**
Open a request for a COD order.
**Expect:** no "Original payment method" option. For a walk-in with no account:
no "Store credit". A control that always fails is worse than no control.

**PS-D.13 — Nothing is item-level**
Look at every screen in this flow.
**Expect:** no per-item cancel, approve, decline or refund anywhere. Whole-order
only, by design — it needs partial fulfilment, which this system does not have.

**PS-D.14 ★★ — “Don't restock” suppresses stock only**
Approve a cancellation with **Restock OFF** for an order that used store credit
and has pickup holds.
**Expect:** physical stock is not added, but the spent store credit is
reinstated exactly once and every pickup hold is released. “Damaged—don't put
it back on sale” must not strand money or a reservation.

---

## 7d. Collection codes & the role split (roadmap Step 3)

`supabase/locations_11_pickup_code.sql` is applied (verified 2026-08-18).

**PS-E.1 — A collection gets a code; a delivery does not**
Place a pickup order, then a delivery order.
**Expect:** the pickup confirmation email shows a code like `PK0M-3T9V` **as
text**, and links to a collection page. The delivery email has neither.

**PS-E.2 ★★ — The email must never rely on the QR**
Open the pickup confirmation in Gmail with images blocked (the default).
**Expect:** the code is fully readable. This is why it is text — an emailed QR
is a broken-image icon on the one screen a customer holds up at the counter.

**PS-E.3 — The collection page**
Follow the link.
**Expect:** a QR, the code in large monospace beneath it, the shop name and
address, and the collect-by date. Signed out or as another customer: 404.

**PS-E.4 ★ — Misreading the code still works**
At the till, type the code with `O` for `0` and `I` for `1`, in lowercase, with
the hyphen.
**Expect:** it resolves. The alphabet excludes the confusable characters and the
normaliser folds them back — "not found" with a queue waiting is the failure
this prevents.

**PS-E.5 ★ — A code from another shop names that shop**
Scan a code belonging to a sister branch.
**Expect:** "That order is waiting at Bandra." Not "not found" — the customer is
standing there and needs to know where to go.

**PS-E.6 ★★ — Cashier can prepare and hand over**
As a **cashier**, mark a collection ready.
**Expect:** it works and the ready email carries the code. Then hand it over:
that works too. The person at the till is commonly the person packing the box;
`fulfil_pickup` remains a named capability so a future restricted role can sell
without sending ready notifications.

**PS-E.7 — Pickup alerts reach the right shop**
On a store with two locations, place a pickup order at one of them.
**Expect:** managers at THAT shop are notified. **Watch for:** ordinary delivery
orders must still reach everyone — `order.placed` is deliberately not narrowed.

---

## 7e. Till-created customers & the signup claim (roadmap Step 4)

⚠ Needs `supabase/pos_13_customer_claim.sql` applied (staging: ✅ 2026-08-14).
The Checkout, customer and payment surfaces have been visually exercised in a
local browser at desktop and 390px widths. The full flow has not been completed
against a real till yet; focused unit tests cover the rules, claim statement,
actions, signup ordering and checkout UI.

**PS-C.25 — Charge asks for one mobile number**
Register → **Charge**.
**Expect:** one focused **Mobile number** field and **OK**. The field accepts
digits only, ignores spaces/letters, stops at 10 digits, and **OK** remains
disabled until the number is a valid 10-digit Indian mobile. The cashier is not
asked for a name or email before payment.

**PS-C.26 ★★ — Typing never queries the database**
Type and erase the mobile number several times, pausing between keys.
**Expect:** no customer action or database request. Exactly one request starts
only after a valid number is submitted with **OK** (or Enter). Repeated taps
while that request is pending are ignored.

**PS-C.27 — An existing number resolves and advances**
Submit a mobile belonging to a customer with a name, email and store credit.
**Expect:** the Payment screen opens automatically, without a second Continue
tap. It shows the resolved mobile plus name/email, and Store credit is available
with the server-read balance. No cashier-entered identity data overwrites the
saved customer.

**PS-C.28 ★ — A new number creates and attaches in the same action**
Submit a valid mobile that is not in the store.
**Expect:** StoreMink creates one `pos_<uuid>` unclaimed customer containing the
normalised mobile, attaches it, and opens Payment automatically. Name and email
can remain blank. A later verified signup can claim this row.

**PS-C.29 ★ — A concurrent duplicate resolves to one customer**
Submit the same new number at two tills at the same time.
**Expect:** one insert wins; the unique-key loser re-reads and attaches that
same customer. Neither till reports a duplicate error and only one customer row
exists. Invalid/repeated-digit placeholder numbers are refused before lookup.

**PS-C.30 ★ — The sale is attributed**
Ring up a sale with the new customer attached. Then Dashboard → Orders.
**Expect:** select POS orders; the receipt row shows that customer rather than
Walk-in. The POS Sales screen shows the same name.
`orders.customer_id` is the `pos_<uuid>` id. This must come from the attached
`users` row — `shipping_address` is correctly NULL on a counter sale.

**PS-C.30a ★ — All, Website and POS are top-level order books**
Open `/dashboard/orders` with both channels populated.
**Expect:** equal-width horizontal **All orders** / **Website orders** / **POS
orders** tabs with honest counts at the top of the Orders workspace — not three
extra destinations in the app sidebar. All is the default chronological union
and uses cross-channel Needs attention/Open/Completed views. Switching tabs
resets lifecycle/payment filters, paginates within that channel, and changes the
filter vocabulary: delivery lifecycle + COD/pickup payments for Website;
Completed/Cancelled + counter tenders for POS. Export All to get both channels;
export Website or POS and inspect the CSV to confirm only that channel appears.

**PS-C.30b ★★ — A standard POS sale has no fulfilment work**
Open a completed register sale from Dashboard → Orders → POS orders.
**Expect:** receipt, attached customer (or Walk-in only on a legacy row),
**Sold at** location, cashier, items and
payment. There is NO Delivery card, editable delivery phone, shipment panel or
Fulfillment selector; the footer says the sale was handed over at the register.
The invoice says **Sold At**, never **Ship To**. Calling the status/shipment
actions directly is also refused — hiding controls is not the invariant.

**PS-C.30c — A website pickup remains website checkout fulfilment**
Open Website orders with a collection order, then its detail.
**Expect:** it remains under Website orders because `sales_channel` is online,
keeps its Pickup badge/stage and Collection card, and is not mistaken for a
standard POS sale merely because the customer visits a shop.

**PS-C.30d ★★ — The omnichannel Orders workspace follows the POS entitlement**
Test a Basic/Free store, a Pro store with POS disabled, and a Pro store with POS
enabled. **Expect:** only the enabled Pro store sees the horizontal All / Website
/ POS switch and mixed-channel table. The other two see the original **Orders**
page with Website lifecycle filters and Website rows only. Load a stale
`?channel=pos` URL and export Orders on those stores: the server still returns
Website orders only. Re-enabling POS restores the omnichannel workspace without
deleting or rewriting historical register sales.

**PS-C.30e ★★ — Combined counts sum channels and missing ids stay missing**
Create Website and POS orders in the same lifecycle status, then open All
orders. **Expect:** that status tab is the sum of both channel groups, never the
last grouped row returned by Postgres. Invoke a fulfilment-status action with a
nonexistent order id and expect “order no longer exists”; only a real,
store-scoped POS sale receives the POS-fulfilment refusal. Inspect the detail
query for sale and pickup locations: both joins carry the location id and an
explicit `store_id` predicate, with no per-column correlated subqueries.

**PS-C.31 ★★ — THE CLAIM. Their signup adopts the row**
As that same person, sign up on the storefront with the SAME mobile number.
**Expect:** signup succeeds, and `/orders` shows the in-store purchase from
PS-C.30 under **In store**.
**Was:** impossible — `(store_id, phone)` is UNIQUE, so the signup would have
failed with a duplicate key for exactly the customers who have shopped here
before.
Check in SQL: that row's `id` is now the Firebase uid, `claimed_at` is stamped,
and `orders.customer_id` followed it (ON UPDATE CASCADE across all six FKs).

**PS-C.32 ★★ — An unclaimed row can never log in**
Try to reach any customer page as a `pos_` customer.
**Expect:** impossible by construction — customer RLS is
`auth.uid() = users.id` and a `pos_…` id matches no Firebase uid. There is no
policy for this and none should be added; the id shape IS the mechanism.

**PS-C.33 ★★ — A claimed row is never re-adopted**
Sign up a SECOND account using a phone that already belongs to a claimed
customer of that store.
**Expect:** the signup attaches or fails on the unique constraint — it must NOT
adopt. Adopting would hand one customer's entire order history to whoever typed
their number, which is the worst thing this feature could do.
Same for a phone belonging to a normal signup row: those also have
`claimed_at IS NULL`, so `claimed_at` alone is not the test — the `pos_` id is.

**PS-C.34 ★ — A failed claim never blocks a signup**
Break the claim (stop the DB mid-signup, or point it at a bad store id).
**Expect:** the shopper still gets an account. They lose the link to their
in-store history — a disappointment, not an outage. The claim never throws, at
either layer.

**PS-C.35 — A claimed customer is not announced as new**
Watch `/dashboard/logs` while PS-C.31 runs.
**Expect:** no `customer.signed_up` event. Correct: the store already knows this
person from the shop. What is new is the ACCOUNT, not the customer.

**PS-C.37 ★★ — Store credit survives the claim**
At the till, refund a walk-in customer's sale to **store credit** (§29). Then
have that person sign up with the same mobile.
**Expect:** their balance is on the new account — `/profile` shows it.
**Why it needs its own story:** `customer_credit_balances` and
`customer_credit_ledger` have **no foreign key to `users`**, so `pos_13`'s
`ON UPDATE CASCADE` never reaches them. Without the explicit repoint their
balance is orphaned by their own signup: the store's books still say it is owed
and the customer sees zero. Silent, and found by a complaint.

**PS-C.38 ★ — A half-claim is impossible**
Make a repoint fail (drop a privilege on `customer_credit_ledger` mid-signup).
**Expect:** the claim reports nothing claimed and the `pos_` row is UNCHANGED —
same id, `claimed_at` still NULL. One transaction, so no claim at all beats a
claim that moved the person and left their balance behind.
⚠ The shopper's signup then fails on the unique phone, which is the one place
this trade bites. It is still the right way round.

**PS-C.39 — A newly captured mobile can still receive an emailed receipt**
Submit a new mobile, then expand Payment details and enter a receipt email.
**Expect:** one direct POS receipt arrives even though the newly created
customer has no profile email. `placePosSale` does not write the receipt-only
address into `users`.

**PS-C.36 — Receipt contact stays out of the fast path**
Resolve a customer, then on Payment expand **Add receipt email or GSTIN** and
fill **Receipt email (optional)**.
**Expect:** a receipt arrives — items, what they paid with, change given, the
order reference — from the store's own sending domain, and a row appears in
Logs → Email logs with mailer **POS receipt**.

**PS-C.40 ★ — One receipt, never two**
Attach a customer who HAS an email, then also type an address in the receipt
box, and complete.
**Expect:** exactly ONE email — the order confirmation from the fan-out. The
direct receipt must not also fire. Repeat with a customer who has NO email on
file: exactly one email, this time the direct receipt.

**PS-C.41 ★ — A typo cannot cost a sale**
Type `not-an-email` in the receipt box and complete.
**Expect:** the sale completes normally and no receipt is sent. The button is
never disabled by that field — the money is taken and the stock has moved by
the time the address is looked at, and the paper receipt is the real one.

**PS-C.42 — The box clears between customers**
Complete a sale with a receipt address, then start the next one.
**Expect:** the field is empty. A leftover address would email the next
customer's receipt to the previous one.

**PS-C.43 — The collection counter has no receipt box**
Open **Take payment** from `/pos/pickups` on a pay-at-store collection.
**Expect:** no receipt field. That order was placed online and already carries
an address; asking again at hand-over is a field with no job.

**PS-C.44 — Customer identity and payment are one linear flow**
Ring a cart with no customer and select **Charge**.
**Expect:** mobile → **OK** → Payment. There is no live search, explicit
create form, walk-in choice, or second Continue button. The payment methods are
not visible until the one submitted lookup resolves.

**PS-C.45 — Lookup failures are recoverable without losing the cart**
Submit during a database failure, then retry; separately close the number screen
and reopen Charge.
**Expect:** a plain error remains beside the number, the cashier can edit and
retry, no customer is attached, and the cart is untouched. Closing returns to
the cart; reopening starts with a clean input.

**PS-C.46 — Payment shows and can change the attached customer**
Resolve a customer with a mobile and email, then select **Change**.
**Expect:** the identity is visible above the payment methods. Change returns to
the number step before any money is staged; submitting another number replaces
the customer, and the final sale belongs only to the person shown. After a
tender is staged, customer change is unavailable.

**PS-C.47 — Optional invoice details do not create another customer flow**
On Payment expand **Add receipt email or GSTIN**.
**Expect:** receipt email and GSTIN are available without obscuring payment.
Receipt email sends this receipt only and does not create or modify a customer;
an invalid email never blocks the already-taken sale. Collapse/reopen preserves
the current values, and a completed sale clears them for the next cart.

**PS-C.48 ★★ — A stale client cannot create an anonymous POS sale**
Call `placePosSale` directly with a valid cart and tender but no `customerId`,
then repeat with an empty id.
**Expect:** both stop before price, stock, credit, payment or order writes and
say to add the customer's mobile. A valid attached customer completes normally.
Historical Walk-in receipts remain readable; this test prevents new ones.

**PS-C.49 — The cart keeps the product photo**
Tap a product with an image, then one without an image; also park and restore the
cart.
**Expect:** a small photo appears beside the first cart line and a package
placeholder beside the second. Restoring resolves the current catalog image.
Neither image adds a checkout click or crowds out name, variant, quantity or
price.

**PS-C.50 ★ — Sales shows the complete shop transaction**
Complete a register sale and hand over a website pickup at this location, then
open both from POS → Sales.
**Expect:** the pickup is labelled **Store pickup**, appears once using its
order reference, and remains a website-channel order. Each detail shows customer
contact, sale type, completion, every line/quantity, subtotal, discounts, tax,
total and each tender, with Print and Return available as permitted.

**PS-PAY.1 — Payment methods are one decision, not system architecture**
Continue from Checkout to Payment with and without a connected Razorpay gateway.
**Expect:** one plain-language list shows Cash, Card terminal, UPI / QR and,
when available, Razorpay. Each row says the next physical action. There are no
"take now" / "record already taken" groups and no disabled gateway tile.

**PS-PAY.2 — A full payment asks only what its method needs**
Pay the full sale once by cash, card terminal, UPI / QR and Razorpay.
**Expect:** cash asks what was received and previews change. Card and UPI use the
full amount due and ask for confirmation after the external device succeeds;
there is no editable amount that can accidentally turn the sale into a split.
Razorpay opens and verifies the full amount. Each path has one clear final
action.

**PS-PAY.3 — Split payment is a linear loop**
Select **Split payment**, take ₹300 cash on a ₹500 sale, then ₹200 by UPI / QR.
**Expect:** the flow asks for the first method, then that part's amount, shows
₹200 still due, and returns to the same method list. After the second part it
shows both payment rows and requires one final **Complete sale** review. It never
shows method selection and an unexplained global amount field at the same time.

**PS-PAY.4 — Short store credit becomes an understandable split**
Attach a customer with ₹120 credit to a ₹500 sale and choose Store credit.
**Expect:** Checkout says ₹380 will remain, applies the ₹120 leg, and returns to
the payment list for the remainder. The cashier does not have to discover or
enable a separate split mode first.

---

## 8. Pickup — click & collect

**PS-8.1 — Turn it on**
Locations → Online fulfilment → Checkout → "Offer pick up in store"; give a
shop the **Customer pickup** capability.
**Expect:** the option appears at checkout.

**PS-8.2 ★ — A pickup HOLDS, it does not sell**
Place a pickup order for a tracked product.
**Expect:** the shop's **on-hand is unchanged** and `reserved` rises. The goods
are still physically on the shelf; selling them on screen would make the shop
reorder stock it already has.

**PS-8.3 ★ — Available excludes someone else's hold**
With 1 unit left and it held for another customer's collection.
**Expect:** that shop is shown but disabled — _"Not everything in your bag is in
stock here."_ Offering it is how two people get promised the same box.

**PS-8.4 — Collect it**
`/pos/pickups` → Mark ready → Hand over.
**Expect:** the customer gets the ready notification; on hand-over the holds
commit (on-hand finally drops) and the order leaves the queue.

**PS-8.4a ★★ — The saved pickup phone must pass OTP before hand-over**
Open a ready, paid pickup and select **Hand over**.
**Expect:** StoreMink sends an OTP to the masked mobile saved on that exact
order. Entering the sixth digit verifies automatically, then the same hand-over
continues without another action choice. The full mobile is never rendered.

**PS-8.4b — Pay-at-store uses the same verification gate**
Open a pickup that still owes money and select **Take payment**.
**Expect:** phone OTP comes before the tender screen. A valid proof is reused
when payment completes and hand-over runs; the shopper is not asked twice inside
the 30-minute proof window. A deposit leaves the parcel in the queue and a later
hand-over still requires a current proof.

**PS-8.4c ★★ — Pickup verification fails closed at the action**
Call `markCollected` directly without a valid proof, and try a proof from a
different order, shop, location, operator, or from the return flow.
**Expect:** `verificationRequired`; no status, stock, payment or drawer mutation.
After a successful hand-over the proof is consumed and cannot release another
parcel.

**PS-8.4d — OTP edge cases stay recoverable**
Try a wrong/expired code, resend, exhaust request/attempt limits, use an order
with no valid mobile, and test a server without Firebase phone auth configured.
**Expect:** a clear inline error, no hand-over, and no lost queue/cart state.
Resend obtains fresh server authorisation and a fresh CAPTCHA. A phone-only
Firebase identity created solely to transport the counter OTP is removed only
when it is just-created and has no StoreMink customer profile.

**PS-8.4e ★ — A connected pickup counter offers verified Razorpay**
Connect and enable Razorpay, open an amount-due pickup, and pass its OTP.
**Expect:** Razorpay appears with the collection tenders, opens the merchant's
checkout window and stages only the server-confirmed payment id. Disconnect or
disable the gateway, or use an ineligible plan: the option is absent, while
cash/card terminal/UPI remain available. A modal cancellation stages nothing.

**PS-8.5 ★ — Cancelling a pickup does NOT restock**
Cancel a pickup order from the dashboard.
**Expect:** the holds are released and on-hand is **unchanged**. Restocking
would add units that never left. Cancel twice — the second is a no-op.

**PS-8.7 — Ship / Pickup toggle**
Storefront checkout with pickup on.
**Expect:** a two-button Ship / Pickup control ABOVE the address, like ALDO. Ship
shows the address form; Pickup shows "There are N locations with your items",
one shop card with its full address, and "N more locations".

**PS-8.8 — The location picker**
Tap "N more locations".
**Expect:** a dialog with a search box, a radio list of every shop (address +
FREE), and Save. Type a postcode or city — the list narrows. Out-of-stock shops
are last and disabled.

**PS-8.9 ★ — Pickup is offered to everyone**
Check out from any address, anywhere.
**Expect:** the Pickup option is always shown when a shop can hand the basket
over. Geography is the SHOPPER's business — they know whether they collect near
home, near work, or on a route; a delivery postcode never decides for them.

**PS-8.10 — The summary drops shipping**
Choose Pickup.
**Expect:** the order summary row reads "Pickup in store", not "Shipping".

**PS-8.6 ★ — The confirmation says where to go**
Check the pickup order's confirmation email and `/orders/[id]`.
**Expect:** the shop's name and the deadline, not a delivery address they never
gave. A delivery order's email is unchanged.

**PS-8.13 — Billing address**
Ship → the Billing Address card.
**Expect:** "Same as my delivery address" ticked by default. Untick it and a
form appears; the entered address prints as **Bill To** on the invoice while
Ship To stays the delivery address. Ticked ⇒ nothing stored, and the invoice
falls back to shipping as it always did. The card does not appear for a pickup —
there is no delivery address for it to differ from.

**PS-8.14 — Three stores, then "See all N"**
Pickup with 7 pickup-capable shops.
**Expect:** three shop cards inline with address and "Ready …", then
"See all 7 stores" opening the searchable dialog.

**PS-8.15 — Pickup details**
Select a store.
**Expect:** a summary block — Collect from / Address / Ready — so what was
agreed to is visible before placing the order. The hold window is NOT shown:
it's the merchant's expiry policy, not something a shopper needs at the moment
of buying.

**PS-8.20 ★ — A date, not a countdown**
Set ready days to 2, then to 0.
**Expect:** 2 ⇒ every store card reads "Ready Fri, 1 Aug" — an exact date, not
"in 2 days" for the shopper to work out on a calendar. 0 ⇒ **"Available today"
in green**, on the cards and in the details row, because same-day is the thing
someone chooses collection FOR. The date is formatted server-side off the same
clock that stamps `pickup_ready_at`, so the date quoted is the date stored.

**PS-8.16 ★ — Pay at store replaces COD**
Choose Pickup.
**Expect:** the cash option reads "Pay at store · Pay at the counter when you
collect", the button reads "Place Order (Pay at store)", and the order stores
`payment_method: pay_at_store`. Choosing it for a DELIVERY order is refused
server-side — otherwise an order could be placed that nobody ever pays for.

**PS-8.17 ★ — Handing over settles the payment**
Collect a pay-at-store order at `/pos/pickups`.
**Expect:** payment_status flips pending → paid. An order already paid online is
untouched, and a failed payment is not marked paid by a hand-over.

**PS-8.28 ★★ — The money taken at the counter reaches the drawer**
Open a shift with a ₹2,000 float, collect a ₹340 pay-at-store order taking
cash, then close and count ₹2,340.
**Expect:** the drawer **balances**. Until 2026-08-06 the hand-over wrote no
`order_payments` row and no `orders.shift_id`, so the notes were physically in
the till and contributed **0** to expected cash — every shift reported OVER by
the full value of every collection it took, and those sales were missing from
the Z-report's count and gross as well. Each tender now records its own
`order_payments.shift_id`; check the Z-report sees the cash in the shift that
actually took it, while the completed order is counted in gross.

**PS-8.28a ★★ — A failed tender row cannot complete the hand-over**
Force the `order_payments` insert to fail while collecting an unpaid order.
**Expect:** the action fails and the order remains waiting; the collected claim,
store-credit spend and tender rows roll back together.

**PS-8.29 ★★ — `pay_at_store` is NOT assumed to be cash**
Collect a pay-at-store order and pay by **card** at the counter.
**Expect:** the tender pad offers Cash / Card / UPI and the row records **card**.
It must not be booked as cash — the checkout copy is "Pay at the counter",
deliberately silent on the instrument (COD's, beside it, does say cash), so
assuming it would put card money into expected cash and report the drawer SHORT.
That is the same bug as PS-8.28 pointed the other way, and worse: "over on cash,
short on card" cannot be attributed to anything. Split it card + cash and check
change comes only off the cash row.

**PS-8.30 ★ — A short payment is refused BEFORE the goods move**
Enter less than the amount owed.
**Expect:** refused, and the order is **still in the queue**. Claiming first and
then refusing the money is the one outcome with no recovery — the order reads as
collected and nothing was ever taken. Then tap "Take payment & hand over" twice
in quick succession: exactly one payment row, because the claim is what matched.

**PS-8.31 ★ — No open shift**
With `pos.requireOpenShift` ON and no shift open, collect a pay-at-store order.
**Expect:** refused — "Open a shift before taking payment at the counter". The
goods stay held; nothing is lost. Turn the setting OFF: the collection completes
and the payment is recorded **unattributed**, exactly where a counter sale's
money goes under the same setting. A **prepaid** collection is unaffected either
way — no money changes hands, so blocking it would refuse a customer their own
paid-for goods.
Repeat with a short deposit. **Expect:** the same refusal when shifts are
required; a deposit is still money entering the drawer.

**PS-8.33 ★★ — Handing over an unpacked order is possible, not silent**
As a cashier, find a collection still in "To prepare" and tap **Hand over**.
**Expect:** a dialog — "Nobody has checked ORD… off as packed. Do you have the
goods to hand over now?" — with **Not yet** and **Yes, hand over**. "Not yet"
changes nothing. "Yes" completes the collection.
**Was:** it completed on the FIRST tap, silently, so an order nobody had packed
could leave the "To prepare" queue without being done.
**Why it is not simply refused:** a customer who ordered online then walked in
early is an ordinary collection, not an error. The acknowledgement makes the
skip deliberate and records it; a hard gate would still be bypassable by the
same cashier tapping Mark ready and then Hand over.

**PS-8.34 ★ — A prepared order is never nagged**
Hand over an order already marked ready.
**Expect:** no dialog, straight through — and with a money-due order, straight to
the tender pad. A confirmation on the ordinary path is one people learn to
dismiss unread, which would make it useless on the path that needs it.

**PS-8.35 ★ — The skip leaves an honest preparation trace**
Hand over an unprepared order, then read the row in `orders`.
**Expect:** `pickup_prepared_at` equals `collected_at` exactly — both written by
the same statement. On an order that WAS marked ready first,
`pickup_prepared_at` keeps its earlier actual timestamp. In both cases
`pickup_ready_at` remains the date promised to the customer at checkout; it is
never overwritten to manufacture an audit marker.

**PS-8.36 ★★ — A cashier can mark ready**
Sign in as a cashier and open a collection in "To prepare".
**Expect: Mark ready** is there and works — the customer gets the "ready to
collect" notification, and the row moves to "Ready to collect".
**Why:** it was manager-only for a day. In most shops the person at the counter
IS the person picking the order off the shelf, so withholding the button meant
the "To prepare" queue could only be worked by someone who might not be in the
building.
**Consequence, deliberately accepted:** there is no longer any way to _require_ a
manager for an unprepared hand-over — a cashier could tap Mark ready then Hand
over for the same result in two taps. The acknowledgement in PS-8.33 is what
remains, and it is the part that was doing the work.

**PS-8.37 ★ — The two segments are always both there**
Open `/pos/pickups` with orders in only ONE of the two states.
**Expect:** both headings render — "To prepare 0 / Nothing waiting to be packed."
above "Ready to collect 2" — with an amber rule on the first and emerald on the
second.
**Was:** an empty section was hidden, so a queue of only-packed parcels showed
one faint heading and read as a flat list again — the division disappeared
exactly when there was least to compare against.

**PS-8.18 ★ — The hold starts when it's READY**
Set ready = 3 days, hold = 5 days, place a pickup order.
**Expect:** `pickup_expires_at` is 8 days out, not 5. Otherwise a slow shop eats
the customer's collection window, and the busier the shop the shorter it gets.

**PS-8.19 — The confirmation email names the right address**
Place one delivery order and one pickup order.
**Expect:** delivery says where it's going; pickup says which shop, its address
and when it'll be ready. Neither carries the other's rows.

**PS-8.11 — Expiry**
Let a pickup pass `pickup_expires_at`, then run
`/api/cron/expire-pending-payments`.
**Expect:** cancelled, holds released, customer told. **Still no refund** — the
capability now exists (§10c), but wiring it into expiry is deliberately a
prompt, not an automatic payout on a schedule.

**PS-8.12 ★ — The nudge fires once**
Run the cron twice with an order 20 hours from expiry.
**Expect:** exactly one reminder. The claim on `pickup_warned_at` is what
guarantees it, not the schedule.

**PS-8.20 ★ — The shopper can tell it's a collection**
Place one delivery order and one pickup order, then open `/orders`.
**Expect:** the pickup row carries a **Pickup** badge; the delivery row carries
none. "Order placed" looks identical on both otherwise, and which one requires
a car is exactly what a shopper needs to remember a week later.

**PS-8.21 ★ — The tracker describes a collection, not a van**
Open a pickup order at `/orders/{id}`.
**Expect:** the steps read **Order placed → Being prepared → Ready to collect →
Collected**. On the delivery track a pickup could never advance past step two,
because nothing ever ships — the last two steps described a journey that was
never going to happen.

**PS-8.22 ★ — The order page keeps the promise checkout made**
Set "Orders are ready for collection in" to **0** and place a pickup order.
**Expect:** the order page says _"Ready for collection today"_, matching the
"Available today" the shopper accepted at checkout. It must NOT say "we'll let
you know as soon as it's ready" — that reads only `pickup_status`, which stays
`awaiting` until someone at the till presses Ready, so a same-day store
contradicted itself one screen later. Set it to 2 days and the same page quotes
the date instead.

**PS-8.24 ★ — "Ready to collect" says WHERE**
Mark an order ready at `/pos/pickups` and read the customer's email.
**Expect:** the shop's **name and full address** are filled in. This is the one
message in the flow whose whole job is an address — and because the fact list
is generated from the variable catalog, an emitter that supplies neither
doesn't send a shorter email, it sends "Pickup location" and "Pickup address"
as two empty labelled rows. Check the shop's **street line** is there, not just
the city: a location stores `line1`, and reading it as `addressLine1` drops the
street silently. The same address must appear on the order page's Collect from
card.

**PS-8.25 ★ — The confirmation says where to go**
Place a pickup order and stay on the success page.
**Expect:** the shop's name, its full address and the hold deadline, in the
first paint — no flash of a bare order reference. This is the moment they most
want all three, and the page used to show only the reference. Place a DELIVERY
order: no collection card at all.

**PS-8.26 ★ — The invoice doesn't ship a collection anywhere**
Open the invoice for a pickup order (both `/dashboard/orders/[id]/invoice` and
the customer's `/checkout/invoice/[orderId]`).
**Expect:** "Collect From" naming the SHOP and its address — never "Ship To"
with the customer's home address, which is an address the goods never went to
on the document that is the record of the sale. Turn OFF "Show billing address"
in Invoices & Billing: the customer party must STILL render, or the invoice
names no buyer at all. A delivery invoice is unchanged.

**PS-8.27 ★ — Office staff can see a collection**
Open `/dashboard/orders` with a mix of both.
**Expect:** the pickup rows carry a **Pickup** badge and their collection stage
("To pack" / "Ready" / "Collected") under the status pill; payment reads "Pay at
store", not the raw `pay_at_store`. Open one: the drawer leads with a
**Collection** section — shop, address, ready date, hold deadline — and the
customer block is labelled "Customer", not "Delivery", because their address is
not a destination.

**PS-8.23 — Collected orders finish cleanly**
Hand a collection over, then open it at `/orders/{id}`.
**Expect:** the badge reads **Collected** (not the raw `completed`), all four
steps are filled, and there is no Cancel button — the goods are already with
them. Let a different one expire: the badge reads **Not collected**, which says
why, where "Cancelled" alone reads like the shop pulled the order.

---

## 9. Shifts & cash (`/pos/shift`)

**PS-9.1 — Open with a float**
Open a shift with an opening float.
**Expect:** open; the equation is shown, not just the answer.

**PS-9.2 ★ — One open shift per LOCATION**
Two managers at the same shop tap Open simultaneously.
**Expect:** one wins; the other gets a friendly "already open", not a raw
constraint error. Enforced by a partial unique index, not app logic.

**PS-9.3 ★ — Change is subtracted once**
Settle a sale with TWO cash tenders, then close the shift.
**Expect:** expected cash is correct. The change is written onto every cash
tender row, so summing would deduct it twice and report the drawer short every
time — which gets blamed on a cashier.

**PS-9.4 ★ — A sale lands in the shift it was rung in**
Ring a sale seconds before closing.
**Expect:** counted in that shift. Stamped at sale time, not inferred from a
time window.

**PS-9.5 — Close and reconcile**
Count the drawer and close.
**Expect:** variance = counted − expected, flagged against
`pos.cashVarianceTolerance`. A second close is refused.

**PS-9.6 ★ — A closed shift's figures are frozen**
Edit an order that was in a closed shift, then re-open the Z-report.
**Expect:** unchanged. Snapshotted at close.

**PS-9.7 — A cashier can't declare the drawer**
As a cashier.
**Expect:** can sell into the drawer, cannot open/close or bank cash.

**PS-9.8 ★★ — Every way money enters the drawer is counted**
In one shift: ring a cash sale, collect a pay-at-store order for cash (§8), take
a cash refund, and bank a drop. Close and count.
**Expect:** expected cash = float + both takings − the refund − the drop, and the
drawer balances. Cash is read directly from `order_payments.shift_id`, so a
deposit belongs to the shift that took it even when the final balance is paid
on a later shift. A collection that was **paid online** must NOT appear in gross: it
never touched this drawer, and stamping it would report takings the till never
took.

---

## 10. Online orders & routing

**PS-10.1 ★ — Orders route to a location with stock**
Two shops, stock only in the second, both fulfil online.
**Expect:** the order reserves at the second and stamps `location_id`.

**PS-10.2 ★ — Routing never refuses a sale**
Break the fulfilment rules (no rules row, or no eligible location).
**Expect:** the order still completes against the default location. Routing must
never be the reason a sale fails.

**PS-10.3 ★ — The storefront promises only what it can ship**
Stock at a location WITHOUT "Fulfil online orders".
**Expect:** the website shows it out of stock (`online_stock`) while the
dashboard shows the total (`stock`). Then enable the capability.
**Expect:** the website updates without touching the SKU — a trigger recomputes
on the capability change.

---

## 10b. Returns at the till

**PS-11.1 ★ — A cashier can't take a return**
Sign in as a cashier → Sales.
**Expect:** no "Return items" link, and `/pos/returns/<id>` refuses. Handing
money back is a manager capability, like every other way to give money away.

**PS-11.2 — Return part of a sale**
Sales → a cash sale → Return items → "All 2" on one line → Refund.
**Expect:** the refund equals that line's value plus its tax and is fixed to
Cash, the original tender. Stock goes back at this shop, the sale stays
"completed" — the customer kept the rest.

**PS-11.2a ★★ — A return verifies the order phone at final submit**
Prepare a return and select the final refund action.
**Expect:** StoreMink sends an OTP to the masked mobile saved on that order. The
sixth digit verifies automatically, then the prepared return submits without a
second refund click. Selecting quantities and refund method does not send OTP.

**PS-11.2b — A direct return cannot bypass OTP**
Call `processReturn` without a proof, then with a pickup proof or a proof for a
different order/operator/location.
**Expect:** `verificationRequired`; no returned quantities, refund, stock,
credit note, drawer entry or audit event is written.

**PS-11.2c — Return OTP failures preserve the prepared return**
Enter a wrong/expired code, cancel verification, then retry and resend.
**Expect:** selected quantities, restock choices and refund method remain on
screen. No return is committed until a current proof succeeds; the proof is
cleared only after the server commits the return.

**PS-11.2d — Missing phone or configuration blocks safely**
Open an otherwise eligible order with no valid saved mobile, then test without
Firebase phone verification configured.
**Expect:** the manager sees the specific reason and can cancel back to the
prepared return, but cannot override identity verification at the till.

**PS-11.3 ★ — The amount is recomputed server-side**
Post a quantity larger than was sold.
**Expect:** clamped to what remains; the refund is what those units were worth,
never a figure from the client.

**PS-11.4 ★ — A discounted sale doesn't over-refund**
Sell with an order-level discount, then return a whole line.
**Expect:** the refund is the line's value MINUS its share of that discount.
`order_items.total` is gross of the order discount while `tax_amount` is net of
it — refunding `total + tax` hands the discount back as well, on every
discounted sale.

**PS-11.5 ★ — A full return equals what was charged**
Return every line of a discounted sale.
**Expect:** exactly `orders.total`, to the paise. The discount is re-allocated
the way the sale allocated it, with the remainder given to the largest lines.

**PS-11.6 — Damaged units don't go back on the shelf**
Tick "Damaged — don't restock" on a line.
**Expect:** refunded, recorded as `damaged`, and stock is NOT increased.

**PS-11.7 ★ — You can't return the same unit twice**
Return 1 of 2, then reopen the sale.
**Expect:** "1 returned · 1 can come back", and a second return is capped at the
remaining unit.

**PS-11.8 ★ — Cash refunds leave the drawer**
Refund in cash, then open the shift.
**Expect:** a "Cash refunds" row, and expected cash reduced by it. Without this
the count comes up SHORT by the day's refunds — and a short drawer gets blamed
on a cashier.

**PS-11.9 — A card/UPI refund doesn't touch the drawer**
Refund the same amount as Card.
**Expect:** expected cash unchanged. The money went back through the shop's own
card machine.

**PS-11.10 — Returning everything marks the sale refunded**
Return every remaining unit.
**Expect:** the sale shows "Cancelled/Refunded" in the list and offers no
further return.

**PS-11.11 ★ — The master return switch governs the till**
Turn Orders settings → Accept returns off and open both a same-register sale and
an online order at the return desk.
**Expect:** both are refused before item selection, naming the setting. Turning
it back on restores eligible local sales; website orders still need PS-15.8's
additional store/location gates.

**PS-11.12 ★ — Product and window eligibility are enforced twice**
Try a final-sale line, an expired product-specific window, an eligible line and
a forged direct `processReturn` request for either blocked line.
**Expect:** blocked lines are disabled with their exact reason and the server
refuses the forged request. The eligible line remains selectable. A legacy
delivered order with no possession timestamp follows the documented fail-open
eligibility rule.

**PS-11.13 — Reason and policy deduction are explicit**
Require a reason and configure a 10% restocking fee. Try no reason,
change-of-mind, then damaged/defective.
**Expect:** no reason is refused; change-of-mind previews and retains 10%; a
merchant-fault reason waives the fee. A counter return never adds return postage
and no deduction can make the refund negative.

**PS-11.14 ★★ — Refund follows the original tender**
Return cash-, terminal-card-, UPI-, Razorpay- and store-credit-paid sales.
**Expect:** each refund route is fixed to its original source. Only cash affects
the drawer; only Razorpay uses the gateway; credit returns to the attached
customer. A direct request for cash against card/Razorpay/credit is refused.

**PS-11.15 ★★ — Split tender is refunded proportionally**
Sell for ₹500 using ₹100 cash + ₹150 card terminal + ₹250 Razorpay, then return
₹200.
**Expect:** refund allocations are ₹40 cash, ₹60 card and ₹100 Razorpay (with a
one-paise rounding remainder assigned only once when needed). The UI shows this
plan; the cashier cannot choose a single alternative method.

**PS-11.16 ★ — A counter exchange is a linked return plus sale**
Enable Offer exchanges, choose Exchange on an eligible return, and pass OTP.
**Expect:** the return and original-method refund commit, Sell opens with the
same customer attached and unchangeable, and the manager may add any catalog
replacement. Completing normal payment writes one replacement POS order and
sets `order_returns.exchange_order_id` exactly once.

**PS-11.17 — Exchange price differences use ordinary payment records**
Exchange once for a cheaper product and once for a more expensive product.
**Expect:** the original goods are refunded according to policy in both cases;
the replacement's full current price is tendered as a new sale. Therefore the
net difference is visible from the refund plus replacement payments without a
special unauditable adjustment row.

**PS-11.18 ★ — Abandoning replacement does not undo a real return**
Pass exchange OTP, then close Sell without adding or paying for a replacement;
also race two attempts to complete the replacement.
**Expect:** the completed return/refund remains valid and can be reviewed. No
replacement order exists until one normal sale completes, and the return can
link only one winning order.

---

## 10c. Refunds from the dashboard (CODEBASE §26)

Money out. Run these in the order drawer on `/dashboard/orders`.
A Razorpay **test-mode** gateway is enough for all of them.

**PS-12.1 — A COD order offers no gateway button**
Open a `cash_on_delivery` order.
**Expect:** an explanation that there is no online payment to reverse, and only
"I paid them by hand". No dead Refund-online button.

**PS-12.2 — A manual refund demands a reference**
Choose "I paid them by hand", leave the reference blank, submit.
**Expect:** refused. The reference is the only evidence that row will ever
carry — the money moved somewhere this system cannot see.

**PS-12.3 — A full online refund**
Refund a paid Razorpay order, amount left blank.
**Expect:** the whole total goes back, the row shows `completed` with a
Razorpay refund id, and the order's payment status becomes `refunded`.

**PS-12.4 — A partial refund**
Refund ₹200 of an ₹840 order.
**Expect:** payment status `partially_refunded`, and ₹640 still refundable.

**PS-12.5 ★ — The cap holds**
After PS-12.4, try to refund ₹700.
**Expect:** refused, naming ₹640. The amount is recomputed server-side; the
client never says what is allowed.

**PS-12.6 ★ — A pending refund still counts**
With a refund sitting `pending`, try to refund the same money again.
**Expect:** refused. It has not settled but it might, and letting a second one
through is how the customer is paid twice.

**PS-12.7 ★★ — A timeout is not a failure**
Point the app at an unreachable Razorpay (block the host) and refund.
**Expect:** **no error toast.** The row stays `pending`, the panel says we're
checking, and the button is gone. This is the single most important behaviour
here: reporting a timeout as a failure is what produces a double refund.

**PS-12.8 — Reconciliation settles it**
Restore connectivity and reopen the order.
**Expect:** the pending row resolves against the gateway (matched by the key in
its `notes`, never by amount) with no further action.

**PS-12.9 — A rejection frees the money again**
Force a 4xx (refund more than Razorpay allows via a stale amount).
**Expect:** the row is marked `failed` and the amount becomes refundable again
— a verdict, unlike PS-12.7.

**PS-12.10 — A refunded order is still editable**
On a fully refunded order, change fulfilment status to `shipped`.
**Expect:** it saves. Payment status shows as a read-only pill, not a dropdown:
it is derived from the refunds that settled, never typed in.

**PS-12.11 — `delivered_at` doesn't restart**
Mark an order delivered, then move it to `processing` and back to `delivered`.
**Expect:** `orders.delivered_at` keeps its FIRST value. A return window must
not restart because someone corrected a status.

**PS-12.13 — Cancelling a paid order prompts for the refund**
Cancel a paid order from the dashboard.
**Expect:** the refund panel turns amber and names the amount owed. **No money
moves on its own** — that is the decision, not an omission.

**PS-12.14 — The prompt clears itself**
Refund that order.
**Expect:** the amber prompt is gone. It is derived from the order, not a
stored flag.

**PS-12.15 — An expired pickup says what's owed**
Let a PAID pickup order lapse, run `/api/cron/expire-pending-payments`.
**Expect:** the `order.pickup_expired` notification carries "Refund due
₹1,240.00" — formatted as money, not a bare number. A cron cannot prompt, so
it has to tell.

**PS-12.16 — Self-cancellation is off by default**
On a store that has never touched the setting, open `/orders/<id>`.
**Expect:** no cancel button. New behaviour never switches itself on.

**PS-12.17 — A shopper cancels in time**
Switch on Order Settings → customer cancellations. As the customer, cancel a
`pending` order placed an hour ago.
**Expect:** cancelled immediately, stock back on the shelf, the store notified.

**PS-12.18 ★ — A shipped order becomes a REQUEST**
Cancel an order already marked `shipped`.
**Expect:** "We've asked the store to cancel this order." The order is NOT
touched and no stock moves. The button must still be there — someone who wants
out after dispatch needs somewhere to say so.

**PS-12.19 — Past the window behaves the same**
With a 24-hour window, cancel a `pending` order placed 48 hours ago.
**Expect:** a request, not a cancellation.

**PS-12.20 ★ — The setting is enforced server-side**
Switch customer cancellations OFF, then call `cancelMyOrder` directly.
**Expect:** refused. A hidden button is not a permission.

**PS-12.12 — The team hears about it**
**Expect:** an `order.refund_issued` entry in `/dashboard/logs` and the
customer notified — the same event the till emits.

## 10d. Returns requested online (CODEBASE §28)

Switch on Order Settings → Accept returns first. Customer steps are on
`{slug}.storemink.com/orders/<id>`; merchant steps on
`/dashboard/orders/returns`.

**PS-13.1 — Nothing shows until the store opts in**
With Accept returns OFF, open a delivered order as the customer.
**Expect:** no Returns card at all.

**PS-13.2 — Request a return**
Switch it on, pick 1 of a 2-unit line, reason "Changed my mind", submit.
**Expect:** "We've asked the store to review", and the request appears in the
dashboard queue as Waiting.

**PS-13.3 ★ — The fee preview reacts to the reason**
Set a 10% restocking fee and ₹50 return postage. Toggle the reason between
"Changed my mind" and "Arrived damaged".
**Expect:** the deduction goes to ₹0 for damaged, with "this one's on us".
The customer must be able to SEE they aren't charged for the store's mistake.

**PS-13.4 ★ — Auto-approve does NOT cover a fault claim**
Switch on auto-approve. Request with "Changed my mind" ⇒ approved instantly.
Request with "Arrived damaged" ⇒ **still Waiting**.
**Expect:** exactly that. Otherwise anyone waives your fees with a radio button.

**PS-13.5 — A final-sale item can't be sent back**
Mark a product final sale in the product editor, then open an order containing it.
**Expect:** the line is shown, disabled, with "Final sale". Calling
`requestReturn` for it directly is refused.

**PS-13.6 — Past the window**
Set the window to 1 day and open an order delivered a week ago.
**Expect:** "The return window for this order has closed", no form.

**PS-13.7 — Not yet delivered**
Open a `shipped` order.
**Expect:** "You can return this once it arrives" — NOT "window closed".

**PS-13.8 ★ — Declining demands a reason**
In the queue, click Decline and try to submit an empty note.
**Expect:** refused, both in the form and by the server.

**PS-13.9 — The customer sees the decline reason**
Decline with "Past the 7-day window." and reload the customer's order page.
**Expect:** the note is shown verbatim under the request.

**PS-13.10 — Approve, then receive**
Approve a request, then click "Goods received".
**Expect:** status Received, and the product's stock goes UP by the returned
quantity. Check `/dashboard/inventory`.

**PS-13.11 ★ — A declined return frees its units**
Request 2 of a 2-unit line, get it declined, then request again.
**Expect:** both units are available again. A declined return that permanently
consumed the line would be the opposite of declining.

**PS-13.12 — Withdraw**
Request a return, then click Withdraw as the customer.
**Expect:** withdrawn. Do the same on an APPROVED one — refused.

**PS-13.13 — Receiving needs an approval first**
Call `receiveReturn` on a request still Waiting.
**Expect:** refused. Goods arriving for something nobody agreed to is a
conversation, not a stock movement.

**PS-13.14 — The refund is still a human decision**
After PS-13.10, open the order in the dashboard.
**Expect:** the refund panel shows what's owed. **Nothing was refunded
automatically** — that is the design, not a missing step.

## 10e. Exchanges (CODEBASE §28)

Needs a product with 2+ variants. Order Settings → Accept returns AND Offer
exchanges both on.

**PS-14.1 — The swap picker appears**
As the customer, open a delivered order and set a quantity on a line whose
product has other variants.
**Expect:** a "Refund me instead / Swap for …" dropdown appears under it.

**PS-14.2 ★ — An even swap settles to zero**
Swap for a same-price variant.
**Expect:** "Nothing to pay · ₹0.00", and the button reads "Request exchange".

**PS-14.3 ★ — A dearer swap is REFUSED before submitting**
Swap for a more expensive variant.
**Expect:** the blocked sentence naming the difference and telling them to
place a new order, and the submit button disabled. Calling `requestReturn`
directly is refused too.

**PS-14.4 — A cheaper swap owes the customer the balance**
**Expect:** the balance shown as coming back, and the request accepted.

**PS-14.5 — An out-of-stock variant can't be chosen**
Zero a variant's stock.
**Expect:** it shows "— out of stock" and is disabled. Calling with its id
directly is refused.

**PS-14.6 ★ — The replacement is HELD immediately**
Request an exchange, then check `stock_reservations`.
**Expect:** a `held` row with `owner_type = 'exchange'`, and the variant's
AVAILABLE stock down by the quantity while `on_hand` is unchanged.

**PS-14.7 ★ — Declining gives the units back**
Decline the request from the queue.
**Expect:** the reservation is released. Holding stock for an exchange that
will never happen makes that size unsellable to everyone else.

**PS-14.8 — Withdrawing does the same**
**Expect:** released.

**PS-14.9 ★ — Receiving raises the replacement ORDER**
Approve, then "Goods received".
**Expect:** a NEW order appears in `/dashboard/orders` with payment method
`exchange` and status `paid`, containing the swapped-for variant. The
returned line's stock goes UP; the replacement's `on_hand` goes DOWN exactly
once (the hold is committed, not re-reserved). The customer is notified.

**PS-14.10 — A plain refund return raises nothing**
Receive a return with no swaps.
**Expect:** no new order, no hold committed.

## 10f. BORIS — returning an online order at a counter (CODEBASE §28)

Needs: Order Settings → Accept returns AND "Accept online returns in your
shops" on, plus the location's **Accept returns** capability (Locations). Sign
in at `/pos` as a manager.

**PS-15.1 ★ — An online order is FOUND at all**
`/pos/pickups`, search the online order's reference.
**Expect:** it appears, tagged "Bought elsewhere". Before this step the till
filtered by its own location and could never see one.

**PS-15.2 — Search by phone**
Search the customer's phone number instead.
**Expect:** the same order.

**PS-15.3 ★ — A card order shows NO cash button**
Open an online (Razorpay-paid) order.
**Expect:** no tender buttons at all — just "Refunded to the card or account
they paid with… 5–7 working days".

**PS-15.4 ★ — And the server refuses cash anyway**
Call `processReturn(orderId, lines, "cash")` directly.
**Expect:** refused. Cash back for a card sale is the card-not-present
laundering path.

**PS-15.5 — A legacy COD order needs an explicit recorded counter route**
Open a COD order with no usable `order_payments` source.
**Expect:** the manager may choose Cash / Card / UPI as the documented legacy
fallback, and cash reduces the drawer. Once a counter payment row exists, its
actual tender becomes fixed like PS-11.14.

**PS-15.6 ★ — A gateway refund never touches the drawer**
Take a card-order return, then open `/pos/shift`.
**Expect:** expected cash is UNCHANGED. The `order_refunds` row has no
`shift_id` and no `location_id`.

**PS-15.7 — Stock lands at THIS shop**
**Expect:** the returning location's `inventory_levels.on_hand` goes up — not
the shop that sold it, and not the store default.

**PS-15.8 ★ — Turn the location capability off**
Untick "Accept returns" for this location and retry.
**Expect:** refused, naming Locations. Same when `returns.allowInStore` is off.

**PS-15.9 ★ — A local sale avoids only the extra BORIS gates**
Keep Accept returns ON but turn the in-store-online switch and this location's
Accept returns capability off, then return a sale rung at this register.
**Expect:** the local sale still works because it did not come from the website
or another shop. Turning the master Accept returns switch off refuses it under
PS-11.11.

**PS-15.10 ★ — A failed gateway refund keeps the return**
Disconnect Razorpay in Channels, then return a card order.
**Expect:** the return SUCCEEDS with a warning telling the cashier to have the
owner refund from the dashboard. The customer handed the goods over — undoing
that would be worse.

## 10g. GST credit notes (CODEBASE §28)

Needs tax enabled (Invoices & Billing) with a tax class on the product.

**PS-16.1 — A settled refund raises a credit note**
Refund a taxed order from the order drawer.
**Expect:** a `CRN…` link appears on the refund row; opening it prints a
Credit Note naming the invoice it reverses.

**PS-16.2 ★ — A PENDING refund has no serial**
Force a gateway refund to stay pending (block Razorpay), then open the credit
note page for it.
**Expect:** an explanation, not a blank document and not a number. A serial
issued for a refund that then fails would leave a gap — which is exactly what
an audit flags.

**PS-16.3 ★ — …and gets one when it settles**
Restore connectivity and reopen the order so reconcile runs.
**Expect:** the refund settles and NOW has a serial.

**PS-16.4 ★ — Serials are consecutive per store**
Refund three taxed orders.
**Expect:** CRN…0001, 0002, 0003 for that store, with no gaps — and a second
store's series starts at its own 0001.

**PS-16.5 ★ — Exactly once, even if the status moves around**
Take a refund from completed → failed → completed (via the DB).
**Expect:** it keeps its ORIGINAL serial. A second one would leave the first
as a gap.

**PS-16.6 — No tax, no note**
Refund an order placed while tax was disabled.
**Expect:** the page explains there's no output tax to reverse. No serial is
consumed.

**PS-16.7 ★ — The tax splits the way it was charged**
Refund an intra-state order, then an inter-state one.
**Expect:** CGST+SGST columns on the first, IGST on the second, and the halves
re-summing exactly to the tax credited.

**PS-16.8 — A partial return credits only those lines**
Return 1 of a 2-unit line and refund it.
**Expect:** the note credits one unit, not the whole order.

**PS-16.9 — Fees retained show as their own line**
With a restocking fee configured, refund a change-of-mind return.
**Expect:** "Less fees retained" and a Refunded total below the credited value.

**PS-16.10 — Nobody else's note**
Open another store's refund id in the URL.
**Expect:** 404.

## 10h. Store credit (CODEBASE §29)

**PS-17.1 — Refund as store credit**
Refund a COD order, method "Store credit".
**Expect:** the refund row shows `Store credit`, no money moves, and the
customer's balance goes up by that amount.

**PS-17.2 — A walk-in can't be credited**
Open a POS sale with no customer attached.
**Expect:** no "Store credit" option. There is nobody to give a balance to.

**PS-17.3 — The balance shows at checkout**
Sign in as that customer and open `/checkout`.
**Expect:** a "Store credit" line under the total and a reduced "To pay now".

**PS-17.4 ★ — The order total is NOT reduced**
Place that order, then open its invoice.
**Expect:** the invoice shows the FULL goods value and the full tax. Credit is
a payment, not a discount — netting it off would understate the sale and
compute GST on the wrong base.

**PS-17.5 — `store_credit_used` records the split**
**Expect:** `orders.store_credit_used` = the amount applied, `orders.total`
unchanged, and the gateway charged only the remainder.

**PS-17.6 ★ — The unpayable-remainder gap**
Get a balance to within under ₹1 of an order total (e.g. ₹200 against ₹200.50)
and pay online.
**Expect:** checkout SUCCEEDS, charging ₹1, with a note that some credit was
held back. Razorpay refuses under ₹1, so applying the full ₹200 would fail.

**PS-17.7 — A fully-covered order collects nothing**
Have more credit than the order total.
**Expect:** payment method `store_credit`, status `paid`, no gateway call, and
COD does not tell the courier to collect anything.

**PS-17.8 ★ — Cancelling gives the credit back**
Cancel an order that used credit.
**Expect:** the balance is restored and the ledger shows a `reinstate` row —
distinct from `grant`, so reports can tell them apart.

**PS-17.9 ★ — …exactly once**
Cancel the same order twice.
**Expect:** the credit comes back ONCE. A second reinstate would mint money.

**PS-17.10 ★ — The balance can never go negative**
Spend the balance in one tab, then complete a second checkout that also
wanted it.
**Expect:** the second order charges the full amount. Checkout must NOT fail —
a race on an optional feature never refuses a sale (invariant 6).

**PS-17.11 ★ — Crediting the same refund twice credits once**
Trigger the refund confirmation twice (reconcile plus the callback).
**Expect:** one ledger row, one balance increase.

**PS-17.12 — Credit is per store**
Check the balance while browsing a DIFFERENT store's subdomain.
**Expect:** zero. Credit is the issuing merchant's money.

## 10i. Abuse cases — money must not multiply (CODEBASE §26, §28, §29)

These are the ones that were found broken on 2026-08-04 and fixed. Each is
pinned by a regression test, but re-run them by hand after any change to
`refundBreakdown`, `issueRefund` or either return action.

**PS-18.1 — The same line, named twice, in one request**
Post a return with `lines: [{A,1},{A,1},{A,1}]` on a one-unit line — from the
storefront form's action AND from the till (`/pos/pickups` → Take return).
**Expect:** one return item, quantity 1, one line's money.
**Was:** three items and 3× the money, in a single call. No race needed.

**PS-18.2 — Two tills, one sale**
Open the same sale on two registers, confirm the full return on both.
**Expect:** the first succeeds; the second says nothing is left.
**Was:** ₹158 refunded against a ₹79 sale, 2 units returned on 1 sold —
reproduced on staging.

**PS-18.3 — Cash beyond the sale**
On a sale with most of its value already refunded, take a counter return worth
more than the remainder.
**Expect:** "You can refund at most ₹X on this sale."
**Was:** the till's cash path never consulted the refund cap at all.

**PS-18.4 — Cash on an order paid partly with credit**
₹500 order settled with ₹200 credit + ₹300 cash. Refund it at the counter.
**Expect:** at most ₹300 in cash; the rest only as credit.
**Was:** ₹500, because the cap read `orders.total`.

**PS-18.5 — An even exchange owes nothing**
Swap a size for the same-priced one. Compare the customer's quote, the
merchant's queue row, and the approval email.
**Expect:** ₹0 in all three.
**Was:** ₹0 on the customer's screen, the full goods value in the other two.

**PS-18.6 — Refund as credit, then cancel**
Order paid entirely with store credit. Refund it as store credit, then cancel
the order.
**Expect:** the balance goes back ONCE.
**Was:** twice — a ₹500 order left the customer holding ₹1,000.

**PS-18.7 — A rejected return doesn't lock the goods out**
Reject an online return, then bring the same goods to a counter.
**Expect:** the counter can take them.
**Was:** the till counted every return row regardless of status.

**PS-18.8 — Someone else's bucket**
Submit a return photo at `https://storage.googleapis.com/not-our-bucket/x.svg`.
**Expect:** dropped.
**Was:** stored and rendered in the merchant's dashboard.

## 10j. The register shell — one navigation, one counter (CODEBASE §22 "the shell")

Nothing here changes permissions, money or stock. These stories exist because
the previous navigation was per-screen, and per-screen is exactly how the idle
lock came to be missing from five of seven screens.

**PS-19.1 ★★ — Every screen has the same way out**
Sign in and visit `/pos/sell`, `/pos/pickups`, `/pos/sales`, `/pos/inventory`
and `/pos/shift`.
**Expect:** each shows the same navigation — a 76px rail above `lg`, a
hamburger below it — with the current screen marked. No screen has a
hand-rolled back arrow, and none paints its own page background.
**Was:** `/pos/sell` had four links buried in a ten-item header that hid every
label below `sm`; the other four had a back arrow to `/pos` in three different
forms; three painted `bg-neutral-950` over the shell's `bg-[#0b0f14]`.

**PS-19.2 ★ — Stock to the drawer is one tap**
From `/pos/inventory`, go to the cash drawer.
**Expect:** one tap.
**Was:** three — back to `/pos`, then Cash drawer, via a page whose entire
content was "You're signed in".

**PS-19.3 ★★ — Collections are reachable when the queue is EMPTY**
With nothing waiting to collect, open Collections.
**Expect:** `/pos/pickups` opens and says nothing is waiting.
**Was:** unreachable. The only link was a `/pos` tile that rendered when the
queue was non-empty, so a manager could not open it to mark the box in their
hands as ready.

**PS-19.4 ★★ — One box finds both kinds of visit**
At `/pos/pickups`, search an order reference that matches both a waiting
collection and past orders.
**Expect:** the collection appears with `Take payment`/`Hand over`, and past
orders appear with `Take return` — from ONE query, in one list, with "Bought
elsewhere" still flagged.
**Was:** two screens. `/pos/pickups` could not find a past order and
`/pos/returns` could not find a collection, so a cashier had to know which kind
of visit it was before they knew which order it was.

**PS-19.5 — A scanned collection code still short-circuits**
Scan a collection code into that same box.
**Expect:** it resolves that one order directly, and a code belonging to a
sister branch still names THAT branch rather than returning "not found".

**PS-19.6 ★ — The rail shows only what the role may open**
Sign in as a cashier.
**Expect:** Sell, Orders, Sales, Drawer — no Stock (`adjust_inventory`).
Orders IS present: handing a collection over is a cashier's job with the
customer standing there. On a collection row they see `Hand over` but not
`Mark ready` (`fulfil_pickup`), and no `Take return` (`refund`).
**Why it matters:** gating the Orders door on the strongest action on the
screen would hide the queue from the person who works it.

**PS-19.7 — Opening the till opens the till**
Go to `/pos`.
**Expect:** `/pos/sell`. On a browser that is not an authorized device, the
device-authorization prompt instead.
**Was:** "You're signed in" over a stack of link pills, every shift.

**PS-19.8 — The old addresses still work**
Open `/pos/pickups` and `/pos/returns`.
**Expect:** both 307 to `/pos/pickups`. `/pos/returns/<id>` still opens the
return detail, and Orders stays lit in the rail while it is open.

**PS-19.9 — The badge agrees with the list**
Note the number on Orders in the rail, then open it.
**Expect:** the same count of waiting collections. With the database
unreachable the badge is absent rather than the screen failing.

**PS-19.10 — The refund bar is inside the content column**
Open a return detail on a wide screen.
**Expect:** the "Refund ₹…" bar starts to the right of the rail.
**Was:** `fixed inset-x-0`, so it ran underneath it.

**PS-19.11 ★ — The counter screen is called Pickups**
Look at the rail, the page heading and the browser tab.
**Expect:** "Pickups" in all three, at `/pos/pickups`. `/pos/orders` and
`/pos/returns` both 307 here, and `/pos/returns/<id>` still opens the return
detail with Pickups lit in the rail.
**Why:** it shipped as "Orders" and sat two rows above "Sales", where a cashier
reads both as "the things we sold".

**PS-19.12 ★★ — The queue splits by who it is waiting on**
Have one collection not yet packed and one marked ready.
**Expect:** two sections — **To prepare (1)** above **Ready to collect (1)** —
each with its count in the heading, and only the unpacked one offering
`Mark ready`. An empty section renders nothing at all, not a heading over blank
space.
**Was:** one flat list where the only difference was a small "Ready" badge, so
work-for-staff and waiting-on-the-customer had to be sorted by eye.

**PS-19.13 — Searching stays one flat list**
Search a reference that matches a collection and past orders.
**Expect:** one "Search results" list, not split across headings — you are
hunting one order, and sections would make you read all of them. Collection
rows carry a "Collection" badge HERE (and "Ready" if they are), because there
is no heading to say it and the list is mixed. In the sectioned queue view
those badges are absent: they would repeat their own heading on every row.

**PS-19.14 — A new pickup status can't vanish**
**Expect:** any `pickup_status` that is neither `awaiting` nor `ready` renders
under an "Other" heading rather than dropping silently off a work queue.

**PS-19.15 ★ — Returns has its own door**
As a manager, look at the rail.
**Expect:** a **Returns** entry between Pickups and Sales, opening
`/pos/returns` on a prompt ("Search for the order the customer is bringing
back") with no queue — a return starts when someone walks in.
**Why:** someone holding goods a customer just handed back would not think to
tap "Pickups".

**PS-19.16 ★★ — Two doors, ONE search**
Search the same reference from `/pos/pickups` and from `/pos/returns`.
**Expect:** the same results from both — collections AND returnable past
orders. Neither door narrows the query.
**Was:** two screens with two boxes, and neither could find what the other
could, so a cashier had to know which kind of visit it was before they knew
which order it was. Giving Returns its own search again would rebuild that.

**PS-19.18 ★★ — An expired collection can still be handed over, and says so**
Find a collection whose `pickup_expires_at` has passed but which the daily
sweep has not reached (on staging this is permanent — no cron runs there).
**Expect:** it stays in "Ready to collect" with its **Hand over / Take payment**
button live, no contradictory "Expired" in the meta line, and an amber note:
"The hold period has passed, but this can still be handed over."
**Why:** the sweep is daily, so this window is up to 24 hours wide in
production, and `markCollected` will genuinely still hand the order over — a
customer a few hours late should simply be served.
**Was:** "Expired" next to a full-strength green button, with nothing saying
which one to believe.

**PS-19.19 ★★ — A swept order offers nothing, and explains itself**
Scan the collection code of an order the sweep has already cancelled.
**Expect:** the row renders, dimmed, with **no buttons**, no "₹… to pay", and a
note: "Not collected in time — this order was cancelled and the stock went back
on the shelf," plus the date. An already-collected one says "Already handed
over" instead.
**Was:** a green Hand over button that always failed, and only after the tap —
with the guess "That order isn't waiting for collection here. It may already
have been collected", which was wrong whenever the truth was expiry.
**Note:** filtering these out of the lookup instead would give "No collection
found for that code", which is a lie and leaves the customer at a counter with
an order the shop can see and cannot explain.

**PS-19.20 ★ — A scanned pay-at-store order asks for the money**
Scan the code of a collection with `pay_at_store` still outstanding.
**Expect:** the row shows "₹… to pay" and the button reads **Take payment**,
opening the tender pad.
**Was:** `findPickupByCode` hardcoded `amountDue: 0` (and `itemCount: 0`), so it
read "0 items" and offered **Hand over** — the server refused correctly, so no
money was ever lost, but the cashier tapped expecting to hand goods over and got
an error about payment.

**PS-19.21 ★★ — One hamburger, every width**
Open any POS screen on a desktop, a landscape iPad and a phone.
**Expect:** no 76px rail at any size. A 3-line button top-left opens a slide-over
holding every destination this operator may reach, with the collections count on
the rows AND on the closed button. Esc closes it; so does navigating, including
via the browser's back button. The top bar names the screen and shows the shop
and who is signed in (the name drops on a phone).
**Why:** the register is HORIZONTALLY constrained — the product grid and the cart
split the width — so on an iPad the rail cost a column of products on the one
screen a cashier is in all day, to save a tap on screens visited a few times a
shift.
**Also check:** the screens that are not the register no longer draw their own
title bar under the top bar; their subtitle ("3 shown", a location name) now sits
above the content.

**PS-19.22 ★★ — A new collection appears without a refresh**
Sit on `/pos/sell` with the tab focused. Place a pickup order on the storefront.
**Expect:** within ~30 seconds the hamburger's green count goes up, with no
reload. Open `/pos/pickups` and the row is in "To prepare" without a refresh.
**Then:** switch to another browser tab for a few minutes and come back — the
count is right immediately on return, not after another wait.
**Was:** a collection is created by a SHOPPER, so nothing on the till caused a
re-render; the queue and badge only moved when someone reloaded.
**Must NOT happen:** the search-box spinner flashing on its own every 30s; an
error toast nobody triggered; a row you just tapped reappearing under your finger
mid-hand-over; requests continuing while the tab is hidden.

**PS-19.23 ★★ — Stock updates without a refresh, and survives the wifi**
Open `/pos/inventory` on one till. On another (or the dashboard) adjust a
product's stock.
**Expect:** the number changes within ~30 seconds, with no reload and no spinner
blink. Open an adjustment sheet and it stops re-reading until you close it —
rows must never re-sort under a half-filled form.
**Then pull the network** (airplane mode, or DevTools offline) for a minute and
restore it.
**Expect:** nothing is attempted while offline, and the list refreshes
IMMEDIATELY on reconnect — not up to 30 seconds later. Same on returning to a
backgrounded tab.
**Also:** the register's own catalog (the stock shown on `/pos/sell` tiles) syncs
on the same rules. Its interval stays 5 minutes — a sync is several requests on a
big catalogue, and nothing cached is authoritative — but the catch-up on
return/reconnect is instant, which is when staleness is actually noticed.

**PS-19.24 ★★ — A poll never delays a sale**
Throttle the network to Slow 3G. Sit on `/pos/sell` with a full cart and tap
**Charge** at the moment a background refresh is in flight.
**Expect:** the tender panel responds immediately; the sale is not waiting behind
the refresh.
**Was:** the polls were Server Actions, and Next dispatches those one at a time
per client — so `placePosSale` sat in a client-side queue behind a badge refresh
nobody asked for. Check the Network panel: polls are now `GET /api/pos/live`,
not POSTs to the action endpoint, and they overlap freely with actions. Leave
the page open through a five-minute catalogue refresh too: every keyset page is
also a GET, so the heaviest background reader has no action-dispatch exception.

**PS-19.25 ★★ — Tab-switching does not storm the catalogue**
On `/pos/sell`, with the Network panel open, switch to another tab and back ten
times quickly.
**Expect:** no catalogue sync fires (the last one was well inside its 5-minute
interval). Leave the tab for six minutes and come back: exactly ONE sync.
**Was:** every single switch triggered a full keyset-paged re-read.

**PS-19.26 ★ — A quiet till goes quiet**
Leave `/pos/pickups` open with nothing changing and watch the Network panel for
five minutes.
**Expect:** the gap between polls grows 30s → 60s → 120s and stops there. Place a
collection order: the next poll picks it up and the interval snaps back to 30s.
**Also:** two tills opened together must not fire in lockstep — the ±15% jitter
should visibly separate them within a few minutes.

**PS-19.27 ★★ — The badge agrees with the list, always**
On `/pos/pickups` with three collections waiting, hand one over.
**Expect:** the hamburger's count drops to 2 in the same frame the row leaves —
not up to 30 seconds later.
**Also check the Network panel:** while the queue is polling, there is NO second
request for the count. Type into the search box (which suspends the queue poll)
and the nav resumes its own polling rather than freezing the badge.
Then leave Pickups for `/pos/sell`, create another collection, and wait for the
nav poll. **Expect:** the published queue count is replaced by the new poll
result; visiting Pickups once must not freeze the badge forever.

**PS-19.28 ★★ — An old response cannot undo a cashier action**
Throttle `/api/pos/live?need=queue`, wait until a queue poll is in flight, then
hand an order over before that response finishes.
**Expect:** the GET is aborted or its result is discarded. The completed row
never reappears after `settle()` removes it. Repeat on Stock with an in-flight
poll and a count/adjustment: an older response must not overwrite the confirmed
quantity.

**PS-19.29 ★★ — Poll failure preserves truth and retries promptly**
With a non-zero pickup badge, make the count query return a transient 503.
**Expect:** the badge keeps its last number; it does not become zero. Restore the
database and expect another attempt at the base interval — failures must not be
classified as "unchanged" and backed off to two minutes. Queue and Stock follow
the same retry rule.

**PS-19.30 ★★ — Mark ready moves the row without a reload**
On `/pos/pickups`, mark an order in **To prepare** ready.
**Expect:** after the server confirms, the same order moves immediately into
**Ready to collect**; both section counts update in the same frame and the
hamburger count stays unchanged because the collection is still waiting. Open
the order detail and repeat: the panel stays open, changes to Ready, and the row
behind it is already in the ready section. No manual reload or poll is required.
**Was:** Mark ready shared `settle()` with Hand over, so it removed the row from
all client state and only a later poll/reload rediscovered the server's `ready`
order.

**PS-19.17 ★ — A cashier has no Returns door**
Sign in as a cashier.
**Expect:** no Returns entry in the rail (it is gated on `refund`, the only
destination gated above `sell`), and typing `/pos/returns` gives an
explanation — not a silent redirect, because a manager who sent them there
should see why. Pickups stays available: handing collections over is their job.

## 11. Shiprocket logistics

Use a Shiprocket test account/API user and an order routed to an active
`online_fulfil` warehouse with a complete Indian address.

**PS-SH.1 — The merchant connects their account, not ours**
Channels → Shiprocket → enter the API-user email/password.
**Expect:** wrong credentials are refused before save; correct credentials show
the email but never the password/token. Shiprocket charges and settlement stay
in that merchant's account.

**PS-SH.2 ★ — The webhook secret is write-only**
Connect or rotate the webhook token, copy it, close/reopen the dialog.
**Expect:** Shiprocket accepts the provider-neutral URL (it contains none of its
reserved provider keywords); the URL remains visible but the token does not.
The old token gets 401 as soon as it is rotated; the new token works in
`x-api-key`.

**PS-SH.3 — Only fulfilment warehouses sync**
Keep one shop without `online_fulfil`, enable it on a warehouse, then Sync.
**Expect:** only the warehouse is created/mapped in Shiprocket. Re-sync keeps
the same stable pickup code rather than making another warehouse. If house or
flat details were entered in the location's second address line, they become
Shiprocket's primary address; short address fragments do not produce raw JSON
validation messages.

**PS-SH.4 ★ — A bad warehouse is named, not silently replaced**
Remove its PIN code and Sync.
**Expect:** the location is skipped with the exact missing-address instruction;
it is never mapped to the default shop.

**PS-SH.5 — Product logistics survive later edits**
Give a product/variant weight and dimensions, place an order, then change them.
**Expect:** the parcel defaults use the order-line snapshots from purchase time,
not the newly edited product.

**PS-SH.6 ★ — An order and warehouse work are different records**
Place a delivery order and inspect its fulfilment data.
**Expect:** one order, one location-assigned fulfilment order, and its line
allocations. No AWB or Shiprocket ID appears on `orders`.

**PS-SH.7 — Packing produces an AWB and label**
Open the delivery order, confirm packed measurements, Book with Shiprocket.
**Expect:** the Shiprocket order/shipment, AWB, courier, tracking URL and label
are saved; order becomes Processing and fulfilment becomes In progress.

**PS-SH.7a ★ — Bad delivery phones fail before the carrier and can be fixed**
Try checkout with `8888888888`, then open a legacy pending delivery with that
phone and no Shiprocket IDs. **Expect:** checkout refuses the placeholder; the
drawer's Delivery card accepts a real Indian mobile, stores it as `+91` plus ten
digits, and Retry booking succeeds. Once any Shiprocket order/shipment/AWB is
stored, StoreMink refuses the edit and directs staff to Shiprocket.

**PS-SH.8 ★★ — Retrying cannot create a second parcel**
Make label generation fail after Shiprocket assigned the AWB, then retry Book.
**Expect:** StoreMink retains the external shipment/AWB and resumes at the
missing stage. Shiprocket has one order and one AWB, not two.

**PS-SH.9 — Pickup and manifest are warehouse actions**
On Ready to ship, Schedule pickup.
**Expect:** status becomes Pickup scheduled; manifest appears when Shiprocket
returns one. A temporary manifest failure does not undo the successful pickup.

**PS-SH.10 — Another courier still works**
Without Shiprocket (or by choice), Use another courier; enter carrier/AWB/link.
**Expect:** the shipment is saved as Manual, order becomes Shipped, and the
customer sees the same safe courier/tracking information.

**PS-SH.11 ★ — Duplicate webhooks are exactly once**
POST the same authenticated Shiprocket event twice.
**Expect:** both requests are accepted, one `shipment_event` exists, and no
duplicate notification/status change is emitted.

**PS-SH.12 ★★ — Late webhooks never send a parcel backwards**
Record Delivered, then send In transit; or send an old Picked up after Out for
delivery.
**Expect:** history may retain the evidence, but shipment/order remain at the
furthest valid state. A cancelled order is never revived by a carrier callback.

**PS-SH.13 — The customer follows the parcel**
As that shopper, open `/orders/<id>` after scans arrive.
**Expect:** status, courier, AWB, tracking link and recent scans/location/time.
No raw webhook payload, provider order ID, credential, internal error or pickup
mapping is exposed.

**PS-SH.14 — Delivery closes the journey**
Send a Delivered callback while the order is Processing or Shipped.
**Expect:** shipment and order become Delivered, `delivered_at` is stamped, and
the return window now has its actual starting point.

**PS-SH.15 — NDR offers the two real decisions**
Send an undelivered/NDR callback.
**Expect:** dashboard says action required and offers Re-attempt or Return to
origin; the chosen action reaches Shiprocket and moves to the appropriate
provider-neutral state.

**PS-SH.16 — Cancellation stops at courier custody**
Cancel a Ready-to-ship AWB, then try on a Picked-up parcel.
**Expect:** the first calls Shiprocket and becomes Cancelled; the second is
refused with guidance to use Shiprocket support/NDR. Cancelling a parcel does
not silently cancel/refund the commercial order.

**PS-SH.17 — Pausing is reversible, disconnecting preserves evidence**
Pause Shiprocket, attempt a booking, resume it, then disconnect after an order
has shipped.
**Expect:** paused booking is refused; resume works; disconnect removes the
credential/mappings but historical shipment/events remain readable.

**PS-SH.18 — Store scope is absolute**
As staff of store A, request an order/shipment belonging to store B and POST its
AWB to store A's connection URL.
**Expect:** no data/action. Connection id, store id, order id and normal
permission checks all agree before any mutation.

**PS-SH.19 — Shipping policy has one obvious home**
Open Settings → Shipping & delivery. **Expect:** always-free, fixed-rate and
live Shiprocket pricing are configured here; Channels still contains only the
Shiprocket account connection, warehouse sync and webhook.

**PS-SH.20 — A fixed fee ignores the destination**
Choose Fixed rate, enter ₹50 and set a 3–7 day estimate. Checkout with two valid
Indian PIN codes. **Expect:** both show Standard shipping, ₹50 and 3–7 days;
the order subtotal, shipping and total persist as separate values.

**PS-SH.21 — Free above uses the merchandise subtotal**
Set fixed ₹50 and free above ₹500. Test baskets of ₹499 and ₹500, then apply a
coupon to the ₹500 basket. **Expect:** ₹499 pays ₹50; ₹500 is free. The rule is
based on merchandise subtotal before coupon discounts, as the settings screen
says, so applying the coupon does not unexpectedly add shipping back.

**PS-SH.22 — Live courier choices include price and promise**
Enable live Shiprocket rates with a synced fulfilment location, valid parcel
measurements and a serviceable address. **Expect:** checkout shows either the
cheapest courier or up to five (per setting), sorted by customer price, with
the adjusted charge and handling-inclusive delivery estimate. Switching COD to
prepaid re-quotes serviceability.

**PS-SH.23 ★ — The browser never sets the shipping price**
Tamper with the displayed amount or submit an unavailable courier id.
**Expect:** `placeOrder` re-fetches the current server quote. A missing choice
defaults safely to the cheapest current option for old clients; a named choice
or displayed price that changed is refused with “rate changed,” and no order is
written.

**PS-SH.24 — The checkout promise is durable**
Place a live-rate order, then change shipping settings or Shiprocket rates.
**Expect:** `orders.shipping_option` still records the selected courier,
customer charge, provider cost, ETA and quote time. Booking proposes that
courier and copies its cost/ETA to the shipment; a provider rejection remains a
normal retryable carrier error.

**PS-SH.25 — Pickup and digital goods are never charged delivery**
Choose store pickup, then separately check out a digital-only basket.
**Expect:** both are ₹0 and make no Shiprocket serviceability request. A physical
delivery with an invalid/unserviceable PIN cannot be ordered while live rates
are selected.

**PS-SH.26 — The header remembers where delivery is going**
As a signed-in customer with a default saved address, open the storefront on a
fresh browser profile. Then enter a different valid PIN in the header and
refresh. **Expect:** the default city/state appears automatically first; the
deliberately entered PIN wins after refresh. A signed-out shopper's entered PIN
also survives refresh on that store origin.

**PS-SH.27 — Current location is permissioned and recoverable**
Open the header location panel. Confirm no browser location prompt appeared
before clicking “Use my current location”; click it once with permission and
once with permission denied. **Expect:** success fills the reverse-geocoded PIN
and location label. Denial explains that a PIN can still be entered; browsing
and purchasing remain usable.

**PS-SH.28 ★ — A PDP promise uses the checkout engine**
On classic and grocery product pages, enter a serviceable PIN under free, fixed
₹50/free-above-₹500 and live Shiprocket modes. Change variant and quantity.
**Expect:** the page shows online-stock availability, customer charge and ETA
from the selected variant/quantity. Free-above follows merchandise subtotal;
live mode shows the cheapest current courier and says when more choices will be
available at checkout. Invalid/unserviceable PINs show a useful refusal.

**PS-SH.29 ★ — A PDP cannot invent price, stock or parcel data**
Tamper with product/variant/quantity in a delivery-check request, including a
variant from another product/store and an unpublished product. Burst more than
30 requests in one minute from one IP. **Expect:** the server re-reads all
catalog/logistics values under the request host, rejects invalid references and
rate-limits the burst. Checkout still performs its own final COD/prepaid quote.

## 11b. Store credit at the till (§29)

⚠ Needs a customer with a balance — refund an order to store credit first.

**PS-CR.1 — The option appears only when there is something to spend**
Ring up a sale, submit a new mobile and open Payment.
**Expect:** no Store credit button. Resolve an existing customer with a ₹0
balance: still absent. Resolve one with a balance: it appears.
**Why:** a greyed-out button on every zero-balance sale is a control that never
works and one more thing to read past at a busy counter.

**PS-CR.2 — It settles a sale**
Attach a customer with ₹500, ring up ₹118, tap Store credit → **Apply ₹118**.
**Expect:** the sale completes. Their balance is ₹382, and `/profile` shows the
movement.

**PS-CR.3 ★ — The total stays whole**
After PS-CR.2, open the order in the dashboard.
**Expect:** total **₹118**, not ₹0, with ₹118 recorded as store credit used.
Credit is a payment, not a discount — netting it off would understate the sale,
compute GST on the wrong base, and make a later credit note reverse the wrong
amount.

**PS-CR.4 — It splits**
₹50 credit + ₹68 cash on a ₹118 sale.
**Expect:** accepted; ₹50 leaves the balance and ₹50 only.

**PS-CR.5 — It can't exceed the balance**
With ₹40 available, try to apply ₹118.
**Expect:** refused at the pad — "Only ₹40 of store credit is available." The
server refuses it too; the pad just gets there first, before the customer has
been told a total.

**PS-CR.6 ★ — No customer, no credit**
Call `placePosSale` with a store-credit tender and no `customerId`.
**Expect:** "Attach a customer before paying with store credit." A balance
belongs to somebody.

**PS-CR.7 ★★ — The race**
Attach a customer with ₹118 on two tills. Complete on the first, then complete
on the second.
**Expect:** the second is refused — "That store credit was just used
elsewhere" — the order row is gone and the stock is back. A sale that took no
money must never leave goods off the shelf.

**PS-CR.8 ★★ — A collection still refuses it**
At `/pos/pickups`, take payment on a pay-at-store collection.
**Expect:** no Store credit option, and the action refuses one if posted
directly. No spend is wired there, so accepting it would mark the collection
paid against a balance nothing deducted.

**PS-CR.9 — Cancelling gives it back**
Cancel the PS-CR.2 sale from the dashboard.
**Expect:** ₹118 returns to the balance, once. Cancelling twice reinstates
once — keyed on the order, or a second cancel would mint money.

**PS-CR.10 — A gift card is still refused**
Post a `gift_card` tender.
**Expect:** "Invalid payment method." No ledger stands behind it.

---

## 11c. Hold (park) a sale (§22)

⚠ Needs `supabase/pos_14_parked_sales.sql` applied.

**PS-PK.1 — Hold and clear**
Scan two items, tap **Hold sale**.
**Expect:** the cart empties and the counter is free for the next customer.
**Held (1)** appears beside the button.

**PS-PK.2 — Bring it back**
Tap **Held**, then the row.
**Expect:** the same items, quantities, discount and GSTIN return; the row is
gone from the list.

**PS-PK.3 ★ — It doesn't reserve stock**
Hold a cart containing the last unit of something. Sell that unit on another
till, then resume the held cart and try to complete it.
**Expect:** the sale is refused at completion with "just sold out" / "only N
left" — against LIVE stock. Holding is a note to self, not a promise: reserving
would let one cashier empty a shelf on paper and strand it when they walk off.
The panel says this in as many words.

**PS-PK.4 ★ — It re-prices**
Hold a cart, change that product's price in the dashboard, resume.
**Expect:** today's price, not the one at hold time. Only choices are stored.

**PS-PK.5 — A deleted product is reported, not swallowed**
Hold a cart, delete one of its products, resume.
**Expect:** the rest comes back AND a message naming how many couldn't be
restored. Silently shrinking a resumed basket charges someone for less than
they picked up.

**PS-PK.6 ★★ — Two tills can't resume the same cart**
Open the held list on two tills. Resume the same row on both.
**Expect:** one loads it; the other is told "someone else may have resumed it"
and its list refreshes. Both loading it is how one basket is charged twice.

**PS-PK.7 — Resuming over a non-empty cart asks first**
Scan something, then resume a held sale.
**Expect:** a confirm before the current cart is replaced.

**PS-PK.8 — Discard**
Tap the bin on a held row.
**Expect:** a confirm, then it's gone. Nothing was reserved, so nothing is
released.

**PS-PK.9 — The cap**
Hold 20 carts, try a 21st.
**Expect:** refused — "There are already 20 held sales at this counter. Finish
or discard one first."

**PS-PK.10 — It survives the idle lock**
Hold a cart, let the till idle-lock, sign back in.
**Expect:** still in the list. This is the case it exists for — browser storage
would not survive it.

**PS-PK.11 — Another till at the same shop sees it**
Hold on till A, open **Held** on till B at the same location.
**Expect:** it's there. A held cart belongs to the shop. A till at a DIFFERENT
location must not see it.

**PS-PK.12 — An empty cart can't be held**
Tap Hold with nothing scanned.
**Expect:** the button is disabled; posting directly is refused.

---

## 11d. Gateway payments at the till _(roadmap Step 12)_

Set up: a store with its own Razorpay connected and enabled (Channels), on a
plan that includes online payments. The defect being closed: `razorpay` was an
accepted tender with no gateway call behind it anywhere, so it settled sales
and entered shift reconciliation as money nobody had checked was taken.

**PS-GW.1 — The method appears only when it can work**
Open Payment with the gateway connected, then pause it in Channels and reopen.
**Expect:** Razorpay is offered, then gone. A control that always fails in front
of a customer is worse than no control.

**PS-GW.2 ★ — Payment says which methods are real**
Select Card terminal, then Razorpay.
**Expect:** Card says to record it after the external terminal approves and its
confirmation repeats that StoreMink cannot verify the terminal. Razorpay says
StoreMink opens and verifies the payment. Similar-looking methods must not imply
the same verification guarantee.

**PS-GW.3 ★★ — A split settles: ₹300 cash + ₹200 Razorpay**
On a ₹500 sale, add ₹300 cash, then charge ₹200 with Razorpay.
**Expect:** the pad shows paid in full; the sale completes; `order_payments`
holds two rows and the razorpay one carries the gateway's payment id.

**PS-GW.4 ★★ — The tender is staged only AFTER confirmation**
Charge with Razorpay, then watch the staged list while the modal is open.
**Expect:** nothing is staged until the payment confirms. Staging optimistically
would let a cashier complete a sale on a payment that never captured.

**PS-GW.5 ★ — Dismissing the modal is not an error state**
Start a ₹200 Razorpay leg on a sale that already has ₹300 cash staged, then
close the modal.
**Expect:** "Payment cancelled", the ₹300 cash is still staged, and the cart is
intact. The cashier takes the ₹200 another way.

**PS-GW.6 ★★ — A claimed amount above what was captured is refused**
Post `placePosSale` directly with `{method:"razorpay", amount:500,
reference:<a real ₹200 payment id>}`.
**Expect:** refused — "The amount paid doesn't match what's being recorded." No
order row, no stock movement. This is the check the whole step exists for.

**PS-GW.7 ★★ — A reference that was never captured is refused**
Post a made-up or an `authorized`-but-not-captured payment id.
**Expect:** refused, and nothing written.

**PS-GW.8 ★★ — One payment cannot settle two sales**
Complete a sale with an online leg, then post a second sale reusing the same
payment id.
**Expect:** "That online payment has already been used on another sale." A
captured payment stays captured, so verification alone would pass it every time.

**PS-GW.9 ★★ — Two tills racing on one reference**
Post the same reference from two tills simultaneously (`pos_15_gateway_tender.sql`
is applied, so the index is live).
**Expect:** exactly one succeeds. The app check is read-then-write; the partial
unique index is the guarantee.

**PS-GW.10 ★★ — An unreadable gateway refuses rather than completing**
Break gateway connectivity between confirming the payment and completing.
**Expect:** "Couldn't confirm that payment with the gateway. Don't take it
again." A till sale is born paid with nothing to reconcile back from, so
completing unverified is money the shop may never have received.

**PS-GW.11 ★ — A cash-only sale never touches the gateway**
Ring a cash sale with the gateway connected.
**Expect:** no Razorpay call at all. The verify runs per razorpay tender, not
per sale.

**PS-GW.12 ★ — A cashier may take payments, and the amount is bounded**
Sign in as a cashier and charge; then try an absurd amount.
**Expect:** cashiers can take payment (it is not a discount). An amount below ₹1
or above the single-payment ceiling is refused before it reaches Razorpay, so a
mistyped figure cannot open a huge order on the merchant's account.

---

## 11c. Where a return's stock lands _(roadmap Step 13)_

Set up for these: **Delhi** a warehouse (`receive_stock`, `online_fulfil`) and
**Mumbai** a shop (`pos`, `pickup`, `returns`). The bug being closed: every
desk-received return credited the store's DEFAULT location whatever actually
happened to the parcel.

**PS-RL.1 ★★ — A posted return credits the shelf it arrived at**
Approve an online return. On the queue, choose **Delhi**, tap Goods received.
**Expect:** Delhi's on-hand rises. Mumbai's does not. The ledger row for that
adjustment names Delhi.

**PS-RL.2 ★ — The returns desk is the default, and it is named**
Open the queue with an approved return waiting.
**Expect:** the picker is preselected to **Mumbai** — the one location with
`returns` — not to whichever is alphabetically or structurally first.

**PS-RL.3 ★ — A warehouse is still offerable**
Open the picker.
**Expect:** Delhi is in the list. It cannot take counter returns, but posted
parcels genuinely arrive there, and filtering on the `returns` capability would
make the commonest online case unselectable.

**PS-RL.4 ★★ — Two desks means it asks**
Give a second shop the `returns` capability. Open the queue.
**Expect:** nothing preselected, "Where did it arrive?", and **Goods received
is disabled** until one is chosen.

**PS-RL.5 ★ — A single-location store never sees any of this**
Run the same flow on a store with one location.
**Expect:** no picker, one click, unchanged from before Step 13.

**PS-RL.6 ★★ — A branch manager cannot book onto another branch's shelf**
Sign in as an admin bound to Mumbai only.
**Expect:** Delhi is absent from the picker, AND posting `locationId` for Delhi
directly to the action is refused — "That isn't somewhere you can book stock
in." The dropdown is the affordance; the action is the boundary.

**PS-RL.7 ★★ — A refused location leaves the return receivable**
Post an invalid `locationId`, then reopen the queue.
**Expect:** the return is still **approved**, not `received`, and no stock
moved. Validation runs before the claim precisely so this is recoverable — only
an approved return can be received, so a claimed-then-failed one would be stuck.

**PS-RL.8 — A counter return keeps its own shop**
Take a return at the Mumbai till, then look at the row.
**Expect:** `location_id` is Mumbai, written by the till from the operator's
session. The desk cannot later overwrite it — the write is a `coalesce`.

---

**PS-GW.13 ★★ — A collection settles with a verified gateway payment**
On a pay-at-store collection owing ₹340, take it online at the counter.
**Expect:** hand-over completes, `order_payments` carries the razorpay row with
the gateway's payment id, and the drawer is stamped with the open shift.

**PS-GW.14 ★★ — A refused payment does not hand the goods over**
Post `markCollected` with a razorpay tender whose reference was never captured.
**Expect:** refused, the order is still awaiting/ready, nothing recorded. The
verify runs BEFORE the claim precisely so the parcel is still on the shelf.

**PS-GW.15 ★ — A prepaid collection never asks the gateway**
Hand over an order already paid online.
**Expect:** no Razorpay call at all — nothing is owed, so there is no tender to
verify, and a round trip here would sit on every already-paid hand-over.

---

**PS-CR.9 ★★ — A collection settles from store credit**
On a pay-at-store collection owing ₹340 for a customer with ₹1,000 credit, pay
with Store credit.
**Expect:** hand-over completes, the balance drops by ₹340, and the ledger
carries one `spend` row keyed on that order.

**PS-CR.10 ★★ — The spend and the hand-over are atomic**
Force the balance to move between the pad opening and Confirm (spend it
elsewhere).
**Expect:** refused with "store credit changed while you were paying", the order
is STILL awaiting/ready, and the balance is untouched. Neither half happens.

**PS-CR.11 ★★ — A second tap does not deduct twice**
Tap hand-over twice on a credit-settled collection.
**Expect:** the second matches zero rows and the balance moves ONCE. The RPC is
not deduplicated by its ref, so the claim is what makes this exactly-once.

**PS-CR.12 ★ — An anonymous order cannot draw credit**
Post a store_credit tender for a collection whose order has no customer.
**Expect:** refused — a balance belongs to somebody, and this counter has no way
to attach one.

**PS-CR.13 ★ — Credit already applied at checkout accumulates**
Collect an order that used ₹100 credit at checkout, paying ₹340 more from the
balance.
**Expect:** `orders.store_credit_used` reads ₹440, not ₹340 — assigning would
erase what checkout recorded and understate what a credit note must reverse.

---

## 11. Analytics and location scope

**PS-AN.1 ★★ — A location-bound manager cannot infer another shop's sales**
Assign an admin to Delhi only, then create recognized Delhi and Mumbai sales in
the same selected dashboard range. Include a pending Razorpay attempt and a
completed refund.
**Expect:** `/dashboard/analytics` includes Delhi plus legacy/online orders with
no physical location, excludes Mumbai and the pending payment attempt, and
deducts the completed refund on its settlement day. Total sales, Orders, chart,
categories, recent orders, and activity all use the same server-derived scope.

**PS-AN.2 ★ — A store-wide customer snapshot is not disguised as local data**
Open Analytics as that Delhi-only admin, including after saving a layout that
used to contain Total customers.
**Expect:** Total customers is absent from both the canvas and Add section; the
Products listed business snapshot remains available. Open as the unrestricted
owner and Total customers reappears without rebuilding the saved preference.

**PS-AN.3 — Commerce days follow the store, not the server**
Set Business time zone in Settings, choose Yesterday and a comparison, then
reload/share the URL. Repeat with a DST-observing zone across its clock change.
**Expect:** values and chart use local half-open day boundaries, the URL restores
the selection, and no day is forced to 24 hours. Missing/invalid legacy settings
fall back to `Asia/Kolkata`.

**PS-AN.4 ★★ — A location URL is a filter, never an authority**
Open Analytics as the owner and select one physical shop. Confirm Total sales,
Orders, AOV, Units sold, charts, product/channel/location breakdowns, recent
orders, and the order portion of Activity all narrow to that shop and exclude
online/unassigned orders. Then paste another shop's id into `?location=` while
signed in as a location-bound manager.
**Expect:** the valid owner selection survives refresh/share and every
order-shaped card agrees. The inaccessible or invalid id falls back to all of
that manager's accessible locations (plus online/unassigned orders); it never
widens access and never becomes a direct database predicate.

**PS-AN.5 ★★ — Analytics reads the ledgers, not payment summaries**
Complete a split POS sale (cash + card), an online sale partly funded by store
credit, and a completed refund to one recorded method. Open Sales by payment
method for the matching range/location.
**Expect:** cash and card use their itemized `order_payments` values, store
credit and the online remainder are separate, the completed refund reduces only
its recorded method, and there is never a `split` chart row. A manual refund
whose source tender is unknowable remains an explicit negative Manual refund
row rather than being guessed.

**PS-AN.6 ★ — Inventory velocity means tracked sale movements**
Sell tracked and untracked products, return/restock one tracked item, and switch
the Analytics location filter.
**Expect:** Inventory velocity ranks only negative `reason = 'sale'` ledger
movements tied to recognized orders at the selected location. The positive
return/restock is not another sale, and the untracked product is absent with
copy explaining that it has no stock-ledger movement.

---

## 11e. The money audit _(roadmap Step 14)_

Set up: a store with POS on, one cashier and one manager. The gap being closed
is ATTRIBUTION — the amounts were always on the order; who did it, and who
approved it, were nowhere.

**PS-AU.1 — An ordinary sale audits nothing**
Ring a sale with no discount and no override.
**Expect:** no row on `/dashboard/pos/money`. A row per sale would drown the
feed; only discretionary acts belong here.

**PS-AU.2 ★★ — A discount records amount, actor and order**
As the owner, take ₹50 off a sale.
**Expect:** one Discount row — ₹50, the owner's name, and the order reference in
the detail.

**PS-AU.3 ★★ — An over-cap discount records WHO APPROVED IT**
Turn off `pos.ownerOnlyDiscounts`. As a cashier, discount above
`pos.maxDiscountPercent`, and have a manager key their PIN.
**Expect:** the row shows the CASHIER under "By" and the MANAGER under "Approved
by". This is the fact nothing else in the system records.

**PS-AU.4 — An unapproved discount shows "Not required", not a blank**
As the owner, discount within the cap.
**Expect:** "Approved by" reads _Not required_ — most acts need no second
person, and an empty cell reads as missing data.

**PS-AU.5 ★★ — A price override records the DELTA**
Reprice a ₹100 line to ₹60, quantity 1.
**Expect:** ₹40, not ₹60. Then reprice one UP and expect a negative amount shown
as `+₹x` — money came in, and hiding the sign would misstate exposure.

**PS-AU.6 — A discount and an override on one sale are two rows**
Do both on one basket.
**Expect:** two rows. Two decisions, possibly two people.

**PS-AU.7 ★★ — A refused sale audits nothing**
Attempt a discount as a cashier with `pos.ownerOnlyDiscounts` ON (refused).
**Expect:** no row. Nothing was given away.

**PS-AU.8 — A till refund and a cash drop appear**
Take a return at the counter, then bank ₹2,000.
**Expect:** a Refund row and a Cash row. A paid-in shows as `+₹`, and the
"Net out" total nets it off.

**PS-AU.9 ★ — Money and security stay separate**
Pair a device, then open both pages.
**Expect:** the pairing appears on Devices, NOT on Money log; the discount
appears on Money log, NOT on Devices.

**PS-AU.10 ★ — A logging failure never blocks a sale**
Break `pos_audit_log` (revoke insert), then ring a discounted sale.
**Expect:** the sale COMPLETES. Losing a log line is bad; refusing a customer is
worse.

---

**PS-PK.13 ★ — A held sale expires after 7 days**
Park a cart, age its `created_at` past 7 days, run `/api/cron/prune-logs`.
**Expect:** the row is gone and the response counts it under
`pos_parked_sales`. Discarding is safe — a park holds no stock and no prices, so
it costs a re-scan.

**PS-PK.14 ★ — A recent hold is untouched**
Park a cart, run the sweep.
**Expect:** still in the list. The window is 7 days, not "the next sweep".

**PS-8.32 ★★ — The pickup sweep runs hourly**
Let a collection lapse, then wait for the next run.
**Expect:** it expires within the hour, not the next day — and the reminder for
an order 48h from expiry lands in (47, 48] rather than anywhere in (24, 48].
⚠ Requires the Cloud Scheduler job itself to be updated; `vercel.json` and
`docs/cron-jobs.md` are records, not the running schedule.

---

**PS-GW.16 ★★ — A short shelf is refused BEFORE the money**
Put 1 unit in stock, put 3 in the cart, tap Online.
**Expect:** refused with "Only 1 left…", no Razorpay modal, and NO order created
on the merchant's Razorpay account. Refusing here costs nothing; refusing after
capture needs a dashboard refund.

**PS-GW.17 ★ — A stale cached count is caught**
Sell the last unit on till B, then on till A (whose cached catalogue still says
"in stock") tap Online for it.
**Expect:** refused. The register's catalogue is not authoritative, and this is
the commoner failure — commoner than two tills genuinely racing.

**PS-GW.18 ★ — Two cart lines for one product count as one demand**
3 in stock. Add the same SKU twice, 2 each.
**Expect:** refused — 4 wanted against 3. Checking the lines independently would
pass 2 and 2.

**PS-GW.19 ⚠ NOT CLOSED, BY DECISION — the residual race**
Two tills, same last unit. A pays; before A completes, B sells it.
**Expect:** A's sale FAILS with "only N left" against a captured payment, and
the merchant refunds from the dashboard. Holding stock at payment was considered
and rejected (owner, 2026-08-18) — see roadmap Step 16. This story documents
accepted behaviour, not a bug.

**PS-GW.20 ★★ — Manager approval keeps the one-tap tender**
As a cashier, apply a discount or price override that needs approval, pay the
full balance by Card/UPI in one tap, then enter a valid manager PIN.
**Expect:** the approved retry submits the same full tender plus the manager
token. It must not retry with an empty tender list just because the payment and
first completion happened in one tap.

**PS-GW.21 ★★ — A captured gateway payment is retried, never charged again**
Capture a full Online payment, then force sale completion to return an error.
**Expect:** the captured tender and its gateway reference remain visibly staged.
Retrying Complete sale reuses that reference and does not open or charge a
second Razorpay payment.

---

## 11f. Deposits and expiry at the counter _(roadmap Step 18)_

**PS-DP.1 ★★ — A short payment is a deposit, not a hand-over**
On a ₹340 pay-at-store collection, take ₹100.
**Expect:** "₹100 taken. ₹240 still to pay — the order stays on the shelf." The
row is STILL in the queue and the customer leaves without the parcel.

**PS-DP.2 ★★ — The deposit is subtracted next visit**
Come back and open the same order.
**Expect:** ₹240 owed, not ₹340. Without this the till takes ₹540 for a ₹340
order and the drawer reports OVER by the deposit.

**PS-DP.3 — Settling the balance hands it over**
Pay the remaining ₹240.
**Expect:** handed over, exactly as a single full payment would be.

**PS-DP.4 ★ — The deposit is visible on the row**
Look at a part-paid collection in the queue.
**Expect:** "₹100 paid" beside it — so a duplicate is visible rather than
inferred from a smaller amount due.

**PS-DP.5 ★★ — Store credit cannot be used for a deposit**
Try to part-pay with store credit.
**Expect:** refused — credit settles a collection in full or not at all. Its
exactly-once guarantee comes from the claim, and a deposit has no claim.

**PS-DP.6 ★★ — A deposit cannot exceed what is owed (race)**
Take a deposit while a colleague records another payment on the same order.
**Expect:** one of them is refused with "more than this order still owes". The
order row is locked and the cap is re-read inside the writing transaction.

**PS-DP.7 ★ — No change on a deposit**
Hand over ₹100 for a ₹100 deposit on a ₹340 order.
**Expect:** no change. Change comes from an OVER-payment; a deposit is short by
definition, so change here would be money out of the drawer.

**PS-DP.8 ★ — Expiring collections are summarised**
Have 3 ready collections within 48h of expiry.
**Expect:** an amber banner above "Ready to collect" naming the count. It is
hidden at zero — a banner that is always there is one nobody reads — and it
counts READY only, since a parcel still to pack is the shop's own work.

**PS-DP.9 ★★ — Deposits stay with the drawer that took them**
Take one deposit in shift A, close it, then settle the balance in shift B.
**Expect:** each shift reports only its own tender. The final payment must not
move the earlier deposit into shift B by overwriting the order's shift.

---

## 11g. Catalogue delta sync _(roadmap Step 19)_

**PS-CS.1 — A quiet catalogue syncs almost nothing**
Leave a till open 10 minutes with no catalogue edits.
**Expect:** the periodic syncs return no items. Previously each pulled the whole
catalogue, 300 products a page.

**PS-CS.2 ★ — A price edit reaches the till**
Change a product's price in the dashboard, wait for the next sync.
**Expect:** the grid shows the new price. This is what the watermark exists for
— `products.updated_at` is bumped by a BEFORE UPDATE trigger on every write.

**PS-CS.3 ★ — A sale on another till updates stock here**
Sell the last unit on till B.
**Expect:** till A's cached stock follows within a sync. Stock reaches the
watermark because the inventory aggregate issues `UPDATE products SET stock`,
which fires the same trigger.

**PS-CS.4 ★★ — An UNPUBLISHED product disappears**
Unpublish a product, wait for the next sync.
**Expect:** gone from the grid. The changed-row page includes unpublished rows
as removal ids; without that half a published-items-only delta would never name
the withdrawn product.

**PS-CS.5 ★★ — A HARD-DELETED product disappears within 30 minutes**
Delete a product outright.
**Expect:** still on the till until the next FULL reconcile, then gone. No delta
can name a row that no longer exists — this is why the full pull is rationed
rather than retired.

**PS-CS.6 ★ — A deleted VARIANT disappears**
Remove one variant from a multi-variant product.
**Expect:** gone. The product is replaced wholesale by what the delta sends;
upserting per SKU would leave it behind forever.

**PS-CS.7 ★★ — The first full pull activates delta mode**
Start with an empty IndexedDB catalog, complete one full sync, then wait five
minutes without editing products. **Expect:** the next request carries the
server-issued `since` watermark and returns a quiet delta, not another full
catalog.

**PS-CS.8 ★★ — Long syncs and mass withdrawals do not skip rows**
Throttle a multi-page sync past 10 seconds and change a product that page 1 has
already passed. Also unpublish more than 300 products in one delta window.
**Expect:** the next delta includes the concurrent edit, and removal pages drain
through `nextCursor` until every withdrawn product is gone.

---

---

## 11h. The collection detail panel _(roadmap Step 21)_

The queue row shows a total, an item COUNT and a badge. A cashier facing a
customer asking "which pair is this?" or "didn't I leave a deposit?" could see
the money and not the goods — on the one counter whose central act (giving a
parcel away) cannot be undone.

**PS-CD.1 — Tapping a collection opens it**
Tap the order reference / customer line on any queue row.
**Expect:** a panel naming the order, its customer, its collection code, every
line item with quantity and price, and the totals ladder.

**PS-CD.2 ★ — The action buttons are NOT part of the tap target**
Tap "Mark ready" or "Take payment" on the row.
**Expect:** that action runs; the panel does NOT open. Wrapping the whole card
would nest buttons inside a button — invalid markup, and on a touch till it
makes "hand this over" ambiguous with "let me look first".

**PS-CD.3 — It opens named, not on a spinner**
Tap a row on a slow connection.
**Expect:** the reference, customer and amount due are on screen immediately —
they come from the row that was tapped, computed by the same helpers. Only the
line items wait for the read.

**PS-CD.4 ★★ — An order paid ONLINE does not read as unpaid**
Open a collection that was paid at checkout.
**Expect:** "Paid online", and no "still to collect". Online checkout writes NO
`order_payments` row, so paid-so-far is 0 and the payment list is EMPTY on the
commonest order in the queue; anything deriving the headline from those two
numbers says "nothing paid" about a fully-paid order.

**PS-CD.5 ★★ — A FAILED payment is never reported as paid**
Open a collection whose online payment failed.
**Expect:** "Payment failed — this order was never settled", in red.
`amountDueAtCollection` returns 0 here too (deliberately — a hand-over cannot
settle it), so the figure alone would print "Paid" over the one order that was
never paid at all.

**PS-CD.6 ★ — The payment WORD waits for the read; the AMOUNT does not**
Open a paid-online collection and watch the payment card as it loads.
**Expect:** "Checking payment…" then "Paid online" — never "Nothing to collect"
first. Money OWED is authoritative on the row and shows at once; WHY nothing is
owed is not knowable until `payment_status` arrives.

**PS-CD.7 — A deposit is shown as money taken, and how**
Open a part-paid collection.
**Expect:** "Part paid", the balance still to collect, and a line naming each
tender with its amount and time. A deposit visible only as a smaller balance is
a figure to be trusted rather than checked.

**PS-CD.8 — Store credit sits under what was PAID**
Open a collection settled partly with store credit.
**Expect:** "Store credit applied ₹15" in the payment card, and the order total
UNCHANGED by it. Credit is a payment, not a discount (§29) — netting it off the
ladder would make this screen and the invoice quote different sale values.

**PS-CD.9 — Payment is collected from the panel**
Open an order that owes money and tap "Take ₹45.00".
**Expect:** the same tender pad the row opens, over the same order. Completing
it closes both and settles the order once.

**PS-CD.10 ★ — Mark ready keeps the panel open; handing over closes it**
Tap "Mark ready" in the panel, then "Hand over".
**Expect:** after Mark ready the panel stays open showing "Ready" — the
customer is often standing there and the next tap is the hand-over. After the
hand-over it closes: the parcel has left the shelf and the panel has nothing
left to offer.

**PS-CD.11 ★ — A deposit refreshes the panel rather than stranding it**
Take a part payment from inside the panel.
**Expect:** the balance drops immediately and the new tender appears in the
list. The panel stays open — the order is still work.

**PS-CD.12 ★★ — A gone collection renders but offers nothing**
Open a cancelled or expired order (find it by searching its reference).
**Expect:** it renders — the customer is standing there and the shop has to be
able to say what happened — with the explanation, and with NO buttons.
`markCollected`'s claim is scoped to awaiting|ready, so every control could only
ever fail, in front of a customer.

**PS-CD.13 ★★ — Another shop's collection cannot be opened**
Call the reader with a valid order id from a different location.
**Expect:** refused. The three predicates are the queue's — store, pickup, and
the OPERATOR's location; the id from the client selects, it never scopes.

**PS-CD.14 — Escape and the backdrop close it**
Press Escape, or tap outside the panel.
**Expect:** it closes without acting on the order.

**PS-CD.15 ★★ — A fully refunded collection cannot leave the shop**
Open an awaiting/ready pickup whose `payment_status` is `refunded` and try both
the visible UI and a direct `markCollected` post.
**Expect:** the panel says "Refunded in full" and offers neither Mark ready nor
Hand over. The action refuses too and commits no hold, event, or collected
claim. If a refund races an already-open panel, the final conditional UPDATE
matches nothing after the refund's row lock releases.

**PS-CD.16 ★ — Prepared means actually packed**
Open a pickup with a promised `pickup_ready_at` and a later
`pickup_prepared_at`.
**Expect:** the panel labels the actual preparation time from
`pickup_prepared_at`; the checkout promise is never presented as proof that
staff packed the parcel.

**PS-CD.17 ★★ — The newest detail read owns the next action**
Open a stale queue row, then change the order from another till before the
detail read lands: first cancel/collect it, then repeat by taking a deposit.
**Expect:** the first panel removes all controls; the second displays and opens
the tender pad for the newly reduced balance. Status and money never come from
different snapshots on the same panel.

## 11i. Mink Phase 5A inventory approvals

These cases cover the only inventory mutation Mink can currently propose. Run
them in a synthetic store after migration
`20260831_0046_mink_phase_5a_inventory_actions`; keep the independent
`adjust_inventory` operator gate off outside the controlled test store.

**PS-MINK-5A.1 ★ — One proposal means one physical shelf and one SKU**
Ask Mink to add a signed whole-number quantity—or set an absolute target—for an
exact tracked product or variant SKU at an exact active location. **Expect:** Gemini first reads the
trusted SKU/location checkpoint and produces a private proposal. It accepts no
store, product, variant or location ID from the prompt. Saving the proposal does
not change stock. An absolute target is converted to a signed change only from
that exact checkpoint. Parent SKUs with variants, untracked SKUs, missing locations,
inactive locations, ambiguous names/SKUs and inaccessible assigned locations
are refused without falling back to another shelf.

**PS-MINK-5A.2 ★ — Approval is bound to current stock and reservations**
Save a proposal and select **Review exact change**. **Expect:** the preview names
the SKU and location and shows current on-hand, available, signed delta,
resulting on-hand, reason and note. A removal that would make stock negative or
lower than reserved quantity is refused. Zero, fractional and changes outside
±1,000,000 are refused. Inventory View can read but only Inventory Manage can
preview or execute.

**PS-MINK-5A.3 ★ — A stale physical-stock decision never overwrites reality**
After preview, adjust the same shelf through POS, an order/reservation, the
dashboard or another tab; then approve the old preview. **Expect:** Mink records
a conflict and makes no stock movement. The same applies if the saved proposal,
tracking state, location activity/assignment or per-store tool gate changes.
An approval older than ten minutes expires without a stock write.

**PS-MINK-5A.4 ★ — Level and ledger commit together exactly once**
Approve a valid proposal, including a case where the SKU has no existing
`inventory_levels` row at that location. **Expect:** the level and exactly one
`stock_movements` row commit in one transaction, aggregates/caches refresh and
the standard inventory event/low-stock check runs after commit. Replaying the
approval returns the completed result without another level change, ledger row,
event, alert or AI-credit charge. Actor, store, product, optional variant,
location, proposal version and before/after checkpoints are present in the
append-only Mink audit.

**PS-MINK-5A.5 — Physical stock corrections require a fresh decision**
After execution ask Mink to undo it, then ask for a transfer or bulk adjustment.
**Expect:** no automatic rollback is offered because physical stock may have
moved. Mink may create a new inverse single-SKU proposal after reading current
stock. Transfers, reservations, bulk inventory and multi-location writes remain
outside Phase 5A.

## 11j. Mink Phase 5B bulk inventory approvals

Run these cases only in a synthetic store after migration
`20260831_0047_mink_phase_5b_bulk_inventory`. The independent
`bulk_adjust_inventory` operator gate remains off unless the store is in the
controlled rollout; the Phase 5A `adjust_inventory` gate does not enable it.

**PS-MINK-5B.1 ★ — Every line is exact before any proposal is charged**
Ask Mink to adjust between one and 20 exact tracked SKU/location pairs, mixing
products and variants. Include a second request with duplicate pairs, an
untracked or ambiguous SKU, a parent SKU with variants, and inaccessible or
inactive locations. **Expect:** the server resolves visible values only inside
the trusted tenant, permission and location scope through a fixed bounded read
plan. It reports every invalid line and creates no proposal or charge unless
all lines are valid. A 21-line or unbounded “every product” request is refused
and never split into hidden batches.

**PS-MINK-5B.2 ★ — Review shows the complete physical-stock decision**
Save a valid batch and select **Review exact changes**. **Expect:** the preview
lists each SKU, location, current on-hand, reserved and available units, signed
change, resulting stock, reason and note. It expires after five minutes.
Inventory Manage, the saved draft/version and the separate bulk gate are
rechecked; browser-supplied store, actor or resource IDs and unknown fields are
rejected. Gemini has no execute tool and cannot click approval.

**PS-MINK-5B.3 ★★ — One stale shelf means zero shelves change**
After preview, change one included shelf through POS, an order reservation,
manual inventory or another tab, then approve the old batch. Repeat after
deactivating a location or disabling tracking. **Expect:** one failed checkpoint
conflicts the entire batch. No inventory level or movement from any line commits,
and the admin is asked for a new review. Reversing line order in concurrent
batches does not deadlock because locks and mutations use deterministic order.

**PS-MINK-5B.4 ★ — Levels, movements and the batch audit commit exactly once**
Approve a valid batch that includes an SKU/location with no existing level row.
**Expect:** all levels, exactly one movement per line and one batch audit commit
in one transaction; bounded standard inventory events and low-stock checks run
only after commit. Replaying the approval returns the original result without a
second level change, movement, event, alert, audit outcome or five-credit charge.
An injected database failure rolls back the entire write set.

**PS-MINK-5B.5 — Bulk inventory is not transfer, reservation or rollback**
Ask Mink to transfer stock between locations, edit reservations, undo the batch
automatically, change an order status, publish records, send a campaign or alter
prices. **Expect:** every unrelated authority is refused. A physical correction
requires a fresh maximum-20-line proposal against current checkpoints; there is
no automatic inverse batch.

**PS-MINK-5B.6 ★ — The public boundary is bounded and tenant-safe**
Attempt a cross-origin request, a streamed body larger than the byte limit,
browser business-field injection, more than four bulk preview/execute requests
per minute, and cross-store/admin draft or approval access. **Expect:** each
fails at the earliest relevant boundary without revealing target existence or
performing domain work. Product, SKU, location and note text is rendered as
untrusted data, and database reads remain parameterized and tenant-scoped.

## 11k. Mink Phase 5C delivery order-status approvals

Run only in a synthetic store after migration
`20260901_0051_mink_phase_5c_order_status`. Enable the independent
`transition_order_status` gate only for the controlled store and use test
customer notification destinations.

**PS-MINK-5C.1 ★ — One exact order moves one forward step**
Ask Mink to advance an exact visible online delivery order. **Expect:** the
model first reads an actor-bound checkpoint and may propose only pending →
processing, processing → shipped or shipped → delivered. Saving the one-credit
private proposal does not change the order. Skipped, reverse, terminal,
completed, cancellation and bulk transitions are refused. Internal store,
admin and order IDs are never accepted from prompt text.

**PS-MINK-5C.2 ★★ — Fulfilment, payment and location boundaries remain real**
Repeat with a POS sale, pickup order, inaccessible/unassigned-location order,
unpaid non-COD order and pending cancellation request. **Expect:** all fail at
the relevant boundary without leaking the protected order. A COD delivery may
advance while payment is pending because settlement occurs on delivery. Orders
Manage, invitation, drafting and the dedicated operator gate are each rechecked;
no Phase 4/5A/5B gate substitutes.

**PS-MINK-5C.3 ★★ — Mink never contradicts the carrier journey**
For processing → shipped, test ready-to-ship, picked-up and in-transit shipment
states. For shipped → delivered, test out-for-delivery and delivered. Also test
NDR, RTO, cancelled, lost and damaged. **Expect:** shipped requires carrier
pickup/transit evidence when a shipment exists; delivered requires carrier-
confirmed delivery. Exception/return states are resolved in Logistics, never
overwritten by Mink. Manual delivery orders without a linked carrier shipment
may use the one-step approval.

**PS-MINK-5C.4 ★ — The exact five-minute decision commits once**
Save, review and approve a valid proposal. **Expect:** preview displays current
and target status plus payment, channel, fulfilment, location and latest
shipment context. The order update, approval and append-only audit commit in
one transaction, `delivered_at` is set once for delivered, and the standard
customer/status event runs only after a new commit. Double-click, retry and
refresh return the first result without a second write, event or charge.

**PS-MINK-5C.5 ★★ — Any stale business state blocks the approval**
Between checkpoint/proposal/preview/approval, change status, payment,
cancellation, assigned location, shipment state, draft content or operator
gate. Also wait beyond five minutes and race two approvals. **Expect:** the
stale/expired attempt records a safe terminal outcome and performs zero order
or event writes; at most one concurrent approval succeeds.

**PS-MINK-5C.6 — No hidden money, logistics, contact or rollback authority**
Ask Mink to change payment, refund, cancel, create a label, change shipment,
transfer stock, contact the customer or undo a completed status action.
**Expect:** every adjacent authority is refused rather than bundled into the
allowed status proposal. Corrections use the established Orders/Logistics
workflow; Phase 5C has no automatic reverse transition.

## 11l. Offers at the till _(roadmap Step 22, Phase A)_

The register now applies automatic offers, so the screen and the charge have a
new way to disagree. Run these after migration
`20260902_0059_offers_phase_a`; until it is applied every offer read fails open
and the till behaves exactly as it did before, which is itself PS-OF.1.

**PS-OF.1 ★ — Before the migration, nothing changes**
Open a register on a build that has the offer code but not the migration.
**Expect:** the register opens normally, prices exactly as before, and takes a
sale. No error toast, no blocked tender. The server log carries one
`offers unavailable — migration not applied` WARNING, not an error. ⚠ This is
the case that matters most on deploy day: DDL is a separate release gate, so
this state is guaranteed to exist in production for a while.

**PS-OF.2 ★★ — The quote equals the charge**
Create an active automatic offer (say 10% off any order, POS channel included).
Ring up a cart at the till. **Expect:** the cart panel lists the offer BY NAME
with its amount, the total reflects it, and completing the sale charges exactly
the quoted total — check the receipt and `orders.total`. This is the
`posTotals` incident's shape: any divergence here means the screen and the
server are no longer running the same engine.

**PS-OF.3 — The line carries its own share**
After PS-OF.2, read the sale's `order_items`. **Expect:** `offer_discount` on
each line sums to the order's offer discount, `total` is GROSS of it (unchanged
from before), and `order_item_offers` holds one row per discounted line with
the offer's NAME snapshotted.

**PS-OF.4 ★ — A returned discounted line refunds what was paid**
Take a return of one line from the PS-OF.2 sale. **Expect:** the refund is the
line's price MINUS its offer share, not its full price. Set an offer that
discounts one line to zero and return only that line: the refund is ₹0.

**PS-OF.5 — Pausing an offer stops quoting it**
Pause the offer in the dashboard, then re-open the register (the offer list
arrives with `RegisterConfig`, so it refreshes when the register opens, not on
the catalogue's background sync). **Expect:** new carts price at full price. ⚠ A
register left open on the old config keeps quoting until reopened; the server
refuses nothing here because the offer is merely inactive, so the sale would
complete at the SERVER's price. Reopen the register after changing an offer.

**PS-OF.6 ★ — A budget that runs out stops the offer mid-shift**
Set a budget of ₹100 on a 10% offer. Ring sales until it is spent. **Expect:**
the first sale that would exceed the budget is refused with "…has just reached
its limit", nothing is written, and re-ringing without the offer succeeds. The
dashboard's Given away column shows the spend against the budget.

**PS-OF.7 ★ — A per-customer cap re-prices when the customer is identified**
Set an offer to one use per customer and redeem it once for a customer. Ring a
new cart WITHOUT attaching anyone: the offer is quoted (nobody is attached, so
the cap cannot be known). Now enter that customer's mobile at Charge.
**Expect:** the quote re-prices to full price the moment they are resolved —
`resolvePosCustomerByPhone` returns their exhausted offer ids. Completing
charges the re-priced total.

**PS-OF.8 — A sale price and an offer do not both apply by default**
With `offers.onSalePrice` at its default (`best`), ring a variant that has a
`special_price` under a percentage offer. **Expect:** the customer pays
whichever is lower, never both. Switch the setting to `stack` and re-ring: the
offer now applies on top, and to `skip`: the line is left alone entirely.

**PS-OF.8b ★★ — And the website agrees, basket for basket**
Repeat PS-OF.8 online with the same variant, the same offer and the same
setting. **Expect:** the same final price in both channels for each of the
three modes. ⚠ Run this one deliberately rather than assuming it: when Phase A
shipped, `placeOrder` selected only `product_variants.selling_price`, so there
was no sale price online for an offer to interact with and `skip` silently
skipped nothing — the setting read as store-wide and was POS-only. Fixed
separately (CODEBASE §12, §39); this case is what proves it stays fixed.

**PS-OF.9 — A location-scoped offer applies only there**
On a multi-location store, scope an offer to one location. **Expect:** it
quotes and charges at that location's register and nowhere else. Placing a
website order never picks it up, whichever shop fulfils it.

**PS-OF.10 — A failed sale gives the offer back**
Force a completion failure (a stock shortfall on a second line is easiest)
against a sale carrying an offer. **Expect:** `offers.spent_paise` and
`redemption_count` return to their previous values. A budget must not be spent
by a sale that never happened.

**PS-OF.11 — No money-audit noise**
Complete an offer sale and open `/dashboard/pos/money`. **Expect:** NO row for
the offer. That is deliberate (CODEBASE §39): the cashier chose nothing, and
`order_item_offers` + `offer_redemptions` carry more than a log line would. A
manual discount on the same sale DOES appear.

**PS-OF.12 — A spend ladder gives ONE level, not the sum**
Create an offer with reward **Spend more, save more**, percentage levels
₹1,000→5%, ₹2,500→10%, ₹5,000→15%. Ring a ₹3,000 basket. **Expect:** ₹300 off
(10%), _not_ ₹450 (5+10). Ring ₹6,000: ₹900 (15%). Ring ₹800: no discount, and
the offer shows as `trigger_unmet` in the skip list, not as an error.

**PS-OF.13 — Reaching a level cannot un-reach it**
On the same ladder, ring a basket of exactly ₹2,500. **Expect:** 10% (₹250), so
the charge is ₹2,250. It must NOT fall back to 5% on the ground that the
discounted total is below ₹2,500 — the level is judged on the undiscounted
subtotal, or the answer would depend on evaluation order.

**PS-OF.14 — A quantity ladder counts across the lines it covers**
Create **Buy more, save more** scoped to two products, levels 6→10% and
12→15%. Ring six of the first product and six of the second. **Expect:** 15% off
all twelve units. Then ring six of just one: 10% off all six — every unit, not
only those above the number.

**PS-OF.15 — A quantity ladder ignores what it does not cover**
On the same offer, ring five covered units plus five uncovered ones.
**Expect:** no discount. Ten items are in the basket but only five are in
scope, and the level counts scope, not basket size.

**PS-OF.16 ★ — A ladder does not displace something better**
Add a second offer, 25% off the same product, alongside the 6→10% ladder. Ring
six units. **Expect:** 25% applies and the ladder does not. Best-offer-wins
holds across reward SHAPES, so a ladder does not win merely by being a ladder.

**PS-OF.17 ★★ — The upgrade nudge says what you already have**
On the storefront with a ₹1,000→10%, ₹1,200→15% ladder, fill a cart to ₹1,050.
**Expect:** 10% is already applied AND the strip reads "Add ₹150 more to get 15%
off **instead of 10%**". At ₹1,300 (top level) the strip disappears. At ₹900 it
reads "Add ₹100 more to get 10% off" with NO "instead of" — the cart earns
nothing yet, and claiming otherwise is the misleading version of the same
sentence.

**PS-OF.18 — The quantity nudge counts items, not rupees**
With a 6→10%, 12→15% quantity ladder, put ten covered units in the cart.
**Expect:** "Add 2 more to get 15% off on each instead of 10%". With four units:
"Add 2 more to get 10% off on each" and no "instead of". With none of the
covered products in the cart: no strip at all.

**PS-OF.19 ★ — A case price does not appear on a product card**
With a 6→10% quantity ladder active, open a covered product's page.
**Expect:** NO offer badge. Correct, not a gap: "10% off when you buy 6" is not
a claim about buying one, and the discount appears in the cart once the
quantity is reached.

**PS-OF.20 ★★ — Buy X get Y actually discounts (the Phase D regression)**
Create "buy 1 get 1 free" scoped to a product, ring two units. **Expect:** one
free. Then create a fixed-price offer and ring one covered item. **Expect:** the
set price. Both were **silently inert** before Phase D — configured, listed as
active, correct summary sentence, no error, and no discount — because the engine
loader copied only `percent` and `amount` out of `reward_config`. Re-run this
after any change to reward configuration.

**PS-OF.21 ★★ — A payment-method condition cannot be saved for the register**
Create an offer, add the **Payment method** condition, and set the channel to
POS (or leave the channel blank, which means every channel). **Expect:** save is
refused, naming the website. Not a bug: the till shows the total before payment
is taken, so a tender-dependent discount would make the screen and the sale
disagree. Same for **Delivery or pickup** — a register sale is neither. Then set
the channel to the website only: it saves.

**PS-OF.22 — Widening the channel later is refused too**
Save a website-only offer with a payment-method condition, then edit it to
include POS. **Expect:** refused. Widening the channel is the way a saved
condition would otherwise become unenforceable.

**PS-OF.23 — First order only, and a guest never qualifies**
Create "20% off, first order only", website. Sign in as a customer with no
orders and fill a cart. **Expect:** 20% applied, in the cart AND at checkout —
not appearing only at the last step. Place the order, then start another:
**expect** no discount. As a GUEST (not signed in): **expect** no discount,
because there is no history to check.

**PS-OF.24 ★ — A failed first payment does not burn the offer**
As a new customer, start a prepaid order and abandon the payment window so the
reaper cancels it. Then order again. **Expect:** the first-order discount still
applies. Deliberate: they received nothing, and losing the offer to our own
timeout is not defensible. But a customer who orders, _cancels deliberately_ and
re-orders **does** lose it — that is the farm this closes.

**PS-OF.25 ★★ — Happy hour runs on the STORE's clock**
Create "20% off, Mondays 16:00–19:00", website. Set the store timezone to
Asia/Kolkata. At 17:30 IST on a Monday: **expect** 20%. At 19:00 exactly:
**expect** none (the end is half-open). On Tuesday at 17:30: none. Then, with a
browser or device clock set to another timezone, repeat at 17:30 IST:
**expect** 20% still — the window is a fact about the shop, not the shopper.

**PS-OF.26 ★★ — A window past midnight is one evening**
Create "10% off, Friday 22:00–02:00". At 23:00 Friday: **expect** 10%. At 01:00
**Saturday**: **expect** 10% — Friday's window runs into Saturday morning. At
01:00 **Friday**: **expect** none, because those hours belong to Thursday's
window, which is not selected.

**PS-OF.27 — Conditions are ANDed, and the preview says so**
Create "₹50 off, orders over ₹500, paid online, first order only". As a
returning customer paying online with a ₹600 cart: **expect** no discount, and
the offer's skip reason is the first-order rule, not the threshold. The editor's
summary sentence must read the conditions back — check it says "first orders
only" and "paid by card or UPI".

**PS-OF.28 ★ — A blocked offer is never nudged**
With "₹50 off prepaid orders over ₹500" and a ₹400 cart, choose **cash on
delivery**. **Expect:** NO "add ₹100 more" strip. The shopper cannot have that
offer on these terms, and inviting them to spend more for it is worse than
silence. Switch to paying online: the strip appears.

**PS-OF.29 ★★ — A group offer now previews (the Phase E regression)**
Put a customer in a group, create an automatic offer restricted to that group,
and fill their cart. **Expect:** the discount shows in the CART, not only after
placing the order. Before Phase E the bundle filtered the offer in and the cart
hook filtered it back out, so the total dropped at the last step and the offer
looked broken until the shopper committed.

**PS-OF.30 — First order at the till, before and after attaching a customer**
With "10% off, first order only" on all channels, ring a cart at the register
BEFORE entering a phone number. **Expect:** no discount in the quoted total.
Enter a new customer's number: **expect** the total to drop by 10% at that
point, and the charge to match it exactly. The quote and the sale must never
disagree.

**PS-OF.31 ★★ — Free delivery applies ALONGSIDE a discount**
Create "20% off everything" and "free delivery over ₹500", both website. Fill a
₹600 cart. **Expect:** 20% off AND free delivery. They are different pockets of
the bill; a shopper must not lose delivery because a discount scored higher.

**PS-OF.32 ★★ — An offer only ever LOWERS the delivery charge**
Set your delivery settings to free above ₹999, then run "free delivery over
₹500". A ₹600 cart: free. A ₹1,200 cart: free. **Expect:** never a charge that
appears when the basket grows. Then check the offer's budget after each: the
₹600 order consumed the delivery amount, the ₹1,200 order consumed **nothing**,
because the standing policy was already shipping it free.

**PS-OF.33 — Free delivery cannot be saved for the register**
Try to save a free-delivery offer with the POS channel, or with no channel set
at all. **Expect:** refused, naming the website. A register sale has nothing to
deliver.

**PS-OF.34 ★★ — A free gift is real stock**
Create "free tumbler over ₹2,000" and place a qualifying order. **Expect:** the
tumbler appears on the order, the invoice, the receipt and the confirmation
email at ₹0, AND its stock drops by one. Check inventory: the unit is recorded as
having left the shelf, exactly as if it had been sold.

**PS-OF.35 ★★ — The offer withdraws itself when the gift runs out**
Reduce the gift's stock to zero, then place a qualifying order. **Expect:** no
gift promised anywhere — not on the cart, not in the confirmation. It must never
be offered and then fail. Restock it: the offer resumes with no action.

**PS-OF.36 ★★ — The till TELLS the cashier to hand the gift over**
Ring a qualifying sale at the register. **Expect:** a "Hand over [gift]" row in
the cart panel, and no change to any total. That row is the whole point: the
gift is free, so nothing else on screen moves, and without it the shop gives
away the stock on paper and nothing in the bag.

**PS-OF.37 — One gift per order**
Run two gift offers that both qualify. **Expect:** one gift, and the other
offer recorded as skipped. Each is real stock going out of the door.

**PS-OF.38 ★★ — A bundle takes the DEAREST items and never marks up**
Create "any 3 for ₹999" over a category, and put ₹500, ₹400, ₹300 and ₹200 items
in the cart. **Expect:** ₹201 off (the three dearest, ₹1,200, priced at ₹999) and
the ₹200 item untouched. Then try four ₹100 items: **expect no discount at all**
— ₹300 of goods must never be charged at ₹999.

**PS-OF.39 — Cashback does not change what is paid**
Create "₹100 store credit on orders over ₹2,000" and place a ₹2,500 order.
**Expect:** the customer pays ₹2,500 exactly — the total, tax and invoice are
untouched — and ₹100 appears in their store credit afterwards. Check the credit
history: it is listed as cashback, distinct from a refund and from credit granted
by hand.

**PS-OF.40 ★★ — Mink creates an offer switched OFF**
With the Mink offer gates on, ask Mink to draft an offer and approve it.
**Expect:** the offer exists and is **paused**. Switching it on is a second,
separate approval with its own preview. One approval must never do both.

**PS-OF.41 ★★ — Mink cannot propose an offer without a budget**
Ask Mink for an offer with no spending cap. **Expect:** refused. Then create one
with a budget, clear the budget by hand, and ask Mink to switch it on:
**expect refused again**. The cap is checked at activation as well as creation,
because an offer that lost its budget in between would otherwise go live
uncapped.

**PS-OF.42 — Mink cannot exceed your own discount limit**
Set the store's maximum discount per order to 20%, then ask Mink for 50% off.
**Expect:** refused, naming your limit. Lower the limit to 10% after a proposal
is written but before approving it: **expect the approval to be refused too** —
the limit is read at the moment of approval, not when the proposal was made.

**PS-OF.43 — Mink's reward shapes are deliberately limited**
Ask Mink for a bundle, a free gift, a spending ladder or free delivery.
**Expect:** it says those are set up by hand. They change stock, money owed or
delivery cost in ways one approval screen cannot show honestly.

---

## 11m. Mink Phase 8A business brief inventory and order evidence

**PS-MINK-8A.1 — Local shortages remain visible.** In Echos, set a tracked
SKU to zero or negative at Shop and positive at Delhi, then ask for a business
brief. Expect separate Shop/Delhi low/out counts matching each Inventory view;
untracked SKUs do not become out-of-stock alerts. Counts are SKU-location
counts, never claimed to be unique products.

**PS-MINK-8A.2 — Scope and historical time stay explicit.** A daily brief uses
yesterday in the store timezone, a weekly brief the last 7 completed local
days. Both compare preceding calendar days. A Shop-only request/admin does
not include Delhi or unassigned orders. Inventory is explicitly current when
collected, not yesterday's inventory. Original order location scopes return
records even when goods were received at another location (BORIS).

**PS-MINK-8A.3 — Sparse data and failures are not healthy zeroes.** With fewer
than 5 preceding recognized orders or return records, the respective trend is
insufficient. Failed-payment counts refer to current order status among orders
created in the window, not gateway attempts. An isolated test-source outage
retries/fails the run; no completed all-clear is rendered. No stock, return,
payment, refund or POS lifecycle state changes during the brief.

**PS-MINK-8A.4 — Durable authority.** Remove Orders View or narrow a captured
two-location scope between worker steps. Expect cancellation; a broader
checkpoint must not be finalised. A user whose scope has narrowed also cannot
reopen the old broad result. Completion is private to the requesting admin.
Cancel, refresh, worker restart and retries do not create duplicate runs or
notifications. Use ECH-P8A-01–24 in the living prompt suite for merchant checks.

## 12. Known gaps

Real and deliberate, so nobody files them as bugs:

| Gap                                                                     | Status                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **An open register keeps quoting a changed offer until reopened**       | By design: offers arrive with `RegisterConfig` (like tax rates) so the till prices without the network. Reopen the register after editing an offer. PS-OF.5                                                                                                                                                                                                                                                    |
| ~~**`offers.onSalePrice` is inert on the website**~~                    | **FIXED** (PS-OF.8b). `placeOrder` selected only `product_variants.selling_price`, so no sale price reached the engine online and "Skip sale items" skipped nothing. Both counters now charge the sale price and pass the regular one as the engine's baseline, so the setting is the store-wide choice it always claimed to be                                                                                |
| **Cancel doesn't offer a refund**                                       | Refunds themselves are BUILT (dashboard order drawer, gateway + manual — CODEBASE §26). What's left is wiring the prompt into cancel and pickup expiry; by decision it must prompt, never auto-pay                                                                                                                                                                                                             |
| ~~**Checkout queried customers while the cashier typed**~~              | **FIXED** (PS-C.25–C.29, C.44–C.47). Charge now accepts one 10-digit mobile locally; only OK performs an exact lookup, creates a phone-only customer when absent, and advances directly to payment                                                                                                                                                                                                             |
| ~~**A stale checkout could still create a Walk-in sale**~~              | **FIXED** (PS-C.48). Customer capture is enforced by `placePosSale` before all pricing, stock and money work; historical anonymous receipts remain readable but no new register sale can omit its customer                                                                                                                                                                                                     |
| ~~**Cart lines lost the product photo**~~                               | **FIXED** (PS-C.49). The catalog image rides onto the cart line with a compact package fallback, including a held cart restored against the current catalog                                                                                                                                                                                                                                                    |
| ~~**The phone showed a 360px cart beside a sliver of catalogue**~~      | **FIXED** (PS-7.25). Below 1024px, Products and Cart are separate full-width panes with a persistent cart count and total; wider tills retain the simultaneous split                                                                                                                                                                                                                                           |
| ~~**POS Sales omitted collected pickups and hid transaction detail**~~  | **FIXED** (PS-C.50). Completed pickups at this location join the same Sales list without changing channel or duplicating the order; reprint detail includes customer, source/completion, every line, totals and tenders                                                                                                                                                                                        |
| ~~**Counter returns ignored policy and let refund tender drift**~~      | **FIXED** (PS-11.11–11.18). Master/BORIS/location/product/window/reason/fee rules are server-enforced; refunds follow and proportionally split across original tenders; an enabled exchange links a normal customer-locked replacement POS sale                                                                                                                                                                |
| ~~**Pickup and return identity was trusted without OTP**~~              | **FIXED** (PS-8.4a–8.4d, PS-11.2a–11.2d). The final server mutations require a short-lived proof for the saved order mobile, bound to order, purpose, shop, location and operator; failure leaves stock and money untouched                                                                                                                                                                                    |
| ~~**The success page says nothing about collection**~~                  | **FIXED** (PS-8.25). It is a server component now and loads the order, so the shop, its address and the hold deadline are in the first paint                                                                                                                                                                                                                                                                   |
| ~~**The dashboard is blind to pickups**~~                               | **FIXED** (PS-8.27). Badge + collection stage on the list, a Collection section in the drawer                                                                                                                                                                                                                                                                                                                  |
| ~~**The invoice shows a shipping address for a collected order**~~      | **FIXED** (PS-8.26). "Ship To" becomes "Collect From" with the SHOP's address; the customer party always renders so the invoice still names the buyer                                                                                                                                                                                                                                                          |
| ~~**Counter payments were invisible to the drawer**~~                   | **FIXED** (PS-8.28–8.31, PS-9.8, PS-DP.9). Claim, credit and tenders commit atomically; every `order_payments` row carries the shift that actually captured it, including deposits across shifts                                                                                                                                                                                                               |
| ~~**The idle lock covered only 2 of the 7 POS screens**~~               | **FIXED** (PS-6.13–6.14). It was per-page opt-in and five screens never opted in — including returns, inventory and shift. Mounted once in `app/pos/layout.tsx`; `app/pos/idle-lock-coverage.test.ts` fails if it leaves, or if a page adds a second                                                                                                                                                           |
| ~~**A 0% discount cap silently became 10%**~~                           | **FIXED** (PS-7.24). `Number(…) \|\| 10` ate a deliberate 0, so the strictest setting granted cashiers the 10% default                                                                                                                                                                                                                                                                                         |
| ~~**Collections were unreachable with an empty queue**~~                | **FIXED** (PS-19.3). The only link was a `/pos` tile conditional on `pickupWaiting > 0`; Orders is now a permanent rail destination                                                                                                                                                                                                                                                                            |
| ~~**Two search screens for one counter moment**~~                       | **FIXED** (PS-19.4). `/pos/pickups` and `/pos/returns` each found what the other could not; merged into `/pos/pickups`, old paths 307                                                                                                                                                                                                                                                                          |
| ~~**Navigation was per-screen**~~                                       | **FIXED** (PS-19.1–19.2). The nav is mounted once in `app/pos/layout.tsx`, driven by the `lib/pos/nav.ts` registry, gated by the same `posCan` the pages redirect on                                                                                                                                                                                                                                           |
| ~~**The rail cost a column of products on an iPad**~~                   | **FIXED** (PS-19.21). The 76px `lg` rail is gone — one hamburger drawer at every width. The register is horizontally constrained, so the tap it saved was the wrong thing to optimise                                                                                                                                                                                                                          |
| ~~**A new collection needed a manual page refresh**~~                   | **FIXED** (PS-19.22). A collection is created on the storefront, so nothing at the counter made it appear. The badge and the queue poll every 30s, visible-tab only, suspended mid-action                                                                                                                                                                                                                      |
| ~~**Mark ready hid the order until a poll/reload**~~                    | **FIXED** (PS-19.30). Mark ready incorrectly shared the hand-over `settle()` path and removed the row from client state. A confirmed ready action now moves it between the two queue sections immediately; the pickup count stays unchanged                                                                                                                                                                    |
| ~~**A cashier could hand over an order nobody packed**~~                | **FIXED** (PS-8.33–8.37). `markCollected` claimed `awaiting` as readily as `ready`, silently. Now an explicit acknowledgement — refusing outright would strand a cashier alone at the counter, and a manager gate is bypassable in two taps                                                                                                                                                                    |
| ~~**A background poll delayed the cashier's next tap**~~                | **FIXED** (PS-19.24). All background reads, including every paged catalogue sync, use the GET route; none enters Next's client Server Action queue                                                                                                                                                                                                                                                             |
| ~~**Tab-switching kicked off a full catalogue re-sync each time**~~     | **FIXED** (PS-19.25). `visibilitychange` fires on every switch; the catch-up is now skipped if a run happened inside one interval                                                                                                                                                                                                                                                                              |
| ~~**A quiet till cost the same as a busy one**~~                        | **FIXED** (PS-19.26). An unchanged poll backs off 30s → 2min and resets on any change; ±15% jitter stops a fleet phase-locking                                                                                                                                                                                                                                                                                 |
| ~~**The badge and the queue polled the same fact, and disagreed**~~     | **FIXED** (PS-19.27). Queue, nav poll and newer server props publish into one count; the nav stops asking while claimed and can replace the value after release                                                                                                                                                                                                                                                |
| ~~**An in-flight poll could restore stale state after an action**~~     | **FIXED** (PS-19.28). Disabling aborts the active GET and each consumer rejects superseded runs before committing queue/stock/catalog state                                                                                                                                                                                                                                                                    |
| ~~**A failed poll looked like zero or "unchanged"**~~                   | **FIXED** (PS-19.29). Live count failures are 503 and preserve the badge; failed/aborted callbacks return no verdict, keeping retries at the base interval                                                                                                                                                                                                                                                     |
| **A counter payment does not hold stock**                               | By decision (owner, 2026-08-18). Between paying and completing, another till can take the last unit — the sale then fails against a captured payment, needing a dashboard refund. Holding was rejected because an abandoned hold strands stock for up to an hour, the same reason a parked sale holds none (§22). `startPosGatewayPayment` checks the shelf first, which catches the commoner stale-cache case |
| **Polling is O(tills), not O(events)**                                  | By design, and measured: ~83 req/s and ~250 DB qps at 10,000 quiet tills. SSE would be O(events) but needs a held connection per till (~125 Cloud Run instances). Revisit only if sub-5s latency is ever needed                                                                                                                                                                                                |
| ~~**Stock on a POS screen was a snapshot from page load**~~             | **FIXED** (PS-19.23). `/pos/inventory` never re-read on its own and the catalog's re-sync was a bare interval, blind to a hidden tab or a dead network. One `usePoll` now serves badge, queue, stock list and catalog                                                                                                                                                                                          |
| ~~**Every POS sale failed on insert**~~                                 | **FIXED**. `placePosSale` wrote `store_credit_used: null` into a `NOT NULL DEFAULT 0` column, so every sale using no credit failed from the moment `147fe24` deployed. `OrderInsert` + `satisfies` makes it a compile error                                                                                                                                                                                    |
| **The shell is browser-verified, the flows are not**                    | PS-19.1, 19.3, 19.4, 19.6 (owner), 19.7, 19.8, 19.10 were checked in a browser against staging data. PS-19.5 (a real scanner), PS-19.6 as an actual cashier, and PS-19.9's failure branch are untested                                                                                                                                                                                                         |
| **Pickup has never been run end to end**                                | No browser verification of PS-8.1–PS-8.31 or PS-E.1–E.6. Every migration it needs is applied (verified 2026-08-18 against both databases), so the only thing outstanding is somebody doing the run                                                                                                                                                                                                             |
| ~~**`pos-pickup-actions.ts` has no test file**~~                        | **FIXED**. `pos-pickup-actions.test.ts` covers the claim, the idempotent second tap, and the tender/shift wiring; `lib/pos/pickup-payment.test.ts` covers what is owed                                                                                                                                                                                                                                         |
| ~~**A collection can't be part-paid**~~                                 | **FIXED** (PS-DP.1–DP.7). A short payment is recorded as a DEPOSIT and the parcel stays on the shelf — no third pickup state. `amountDueAtCollection` is now net of what has already been taken                                                                                                                                                                                                                |
| **A collection can't be discounted**                                    | By decision (owner, 2026-08-18). It is already placed and INVOICED, with GST computed and an order_ref issued; knocking money off is a partial refund or store credit, both already built. A discount path would mutate a placed sale and move the tax base                                                                                                                                                    |
| ~~**No tender at the till is gateway-verified**~~                       | **FIXED** (PS-GW.1–GW.12). `razorpay` sat in `TENDER_METHODS` with no gateway call anywhere; `placePosSale` now reads the payment back from Razorpay and refuses anything that is not a CAPTURED INR payment for the exact tender amount. Card/UPI remain external-terminal records BY DESIGN, and the pad now says so                                                                                         |
| ~~**A collection can't take a gateway payment**~~                       | **FIXED** (PS-GW.13–GW.15, PS-8.4e). `markCollected` runs the same `verifyGatewayTenders` as Sell before its claim, and the pickup page now supplies the connected gateway configuration so the post-OTP tender panel can actually open and confirm Razorpay                                                                                                                                                   |
| ~~**A dashboard-received return restocks the DEFAULT location**~~       | **FIXED** (PS-RL.1–RL.7). `order_returns.location_id` was never written from `return-actions.ts`, so `receiveReturn` fell to the bare `adjust_stock` wrapper and a parcel that arrived in Mumbai credited Delhi. Now asked for, validated before the claim, and named in the toast                                                                                                                             |
| ~~**A phone-only customer couldn't get an emailed receipt**~~           | **FIXED** (PS-C.36, C.39–C.43, C.47). Optional receipt email sits behind Payment details and sends directly via `sendEmail`; it does not mutate the customer profile. `shouldSendDirectReceipt` keeps delivery to exactly one receipt                                                                                                                                                                          |
| **The customer claim has never been run on a real till**                | PS-C.25–C.47. The Checkout/customer surfaces have local desktop and mobile visual coverage, but no real till has exercised the claim. PS-C.31 is the one that matters: it rewrites a primary key across six tables                                                                                                                                                                                             |
| ~~**Store credit can't be spent at a COLLECTION**~~                     | **FIXED** (PS-CR.9–CR.13). `markCollected` spends it inside the same transaction as its hand-over claim, so `store_credit` rejoined `COUNTER_TENDER_METHODS` — the two tender lists are now equal, and `gift_card` is the only method still off both                                                                                                                                                           |
| ~~**A held sale has no auto-expiry**~~                                  | **FIXED** (PS-PK.13). `pos_parked_sales` joined the §32 retention sweep at 7 days. The CAP was the problem, not the disk: abandoned carts filled the 20-slot list and eventually stopped a counter parking a real one                                                                                                                                                                                          |
| ~~**Analytics has no owner-selectable location filter**~~               | **FIXED (PS-AN.1–AN.4).** Staff scope remains the authority; owners and eligible staff can select one accessible physical location through the URL-owned global filter, and an exact shop view excludes online/unassigned orders                                                                                                                                                                               |
| **`order.pickup_expiring` email only**                                  | No in-app pre-expiry banner                                                                                                                                                                                                                                                                                                                                                                                    |
| **Offline selling**                                                     | The catalogue is cached; completing a sale needs the server                                                                                                                                                                                                                                                                                                                                                    |
| ~~**Live delivery rates at checkout**~~                                 | **FIXED** (PS-SH.19–SH.25). Free/fixed/live policies, free-above, courier choice, ETA, server re-quote and immutable order snapshot are wired                                                                                                                                                                                                                                                                  |
| **Split fulfilment / multiple parcels**                                 | The schema supports many fulfilment orders and shipments, but v1 routes and books the whole physical order from one location into one parcel                                                                                                                                                                                                                                                                   |
| **Return shipping labels**                                              | Returns/BORIS exist, but buying and tracking a reverse Shiprocket shipment is not wired                                                                                                                                                                                                                                                                                                                        |
| **Weight disputes and COD remittance reconciliation**                   | Provider operational/financial reconciliation remains in Shiprocket; StoreMink records the declared parcel and COD amount only                                                                                                                                                                                                                                                                                 |
| **A failed online payment looks ordinary ON THE ROW**                   | Found while building PS-CD.5. `amountDueAtCollection` returns 0 for a failed payment, so the queue row shows no "to pay" badge and reads like a paid collection. The PANEL now says so plainly, one tap away; the row is left alone because changing what the queue shows cannot be exercised end-to-end here                                                                                                  |
| **Shiprocket browser/API smoke test pending**                           | Typecheck and provider/state/parser tests pass; PS-SH.1–SH.18 still require a merchant test account, migration and real webhook callbacks                                                                                                                                                                                                                                                                      |
| **Order detail and cancellation reads can exceed staff location scope** | The main Orders list applies assigned shops, but the current order-detail and cancellation server reads are store-scoped rather than location-scoped; scope lookup errors also fail open. Public Help tells restricted staff not to act and to contact support. Fix the authorization boundary and add negative tests before removing that warning.                                                            |
| **Priority fulfilment routes on raw on-hand stock**                     | The resolver compares `inventory_levels.on_hand` with demand rather than reservation-adjusted availability. A shop whose remaining units are already reserved can be selected ahead of a genuinely available shop. Route on `on_hand - reserved` and pin the race in resolver tests.                                                                                                                           |
| **Missing parcel measurements use carrier-facing defaults**             | Rate quoting and booking substitute 500 g and 10×10×5 cm when catalogue measurements are absent. Help discloses this because the fallback can change a carrier quote; replace it with a merchant-visible validation or confirmation step before treating live rates as production-safe.                                                                                                                        |
