# StoreMink WhatsApp Commerce Plan

> Status: **idea / planning** — nothing here is built yet. Written 2026-10-04 in
> simple language to understand the feature before designing it.

---

## 1. Overview

WhatsApp Commerce lets a StoreMink seller sell, send order updates and talk to
customers on WhatsApp — the app their customers already use every day.

**How Shopify does it:** Shopify has no built-in WhatsApp. Merchants install
third-party apps (Interakt, Wati, Gallabox) or sync products to Meta through the
"Facebook & Instagram" channel — two or three apps glued together.

**StoreMink's chance:** build it in, under **Dashboard → Channels**, next to
Razorpay, Shiprocket and Twilio. One place, no extra apps — a real advantage over
Shopify.

---

## 2. Seller journey — connecting WhatsApp

Works like connecting Razorpay today: the seller links **their own** account. The
difference is that Meta (who owns WhatsApp) gives a guided popup, so the seller
never copies any keys.

1. **Open Channels** — Dashboard → Channels → **WhatsApp** → **Connect WhatsApp**.
2. **Meta's popup**
   - Log in with Facebook.
   - Pick their business (or create one in a few clicks).
   - Enter the phone number customers will message.
   - Verify the number with an OTP.
3. **Back in StoreMink**
   - Shows: "✅ WhatsApp connected: +91 98xxx xxxxx".
   - Set display name and profile photo (prefilled with the store logo).
   - Turn on the features they want (section 3).
4. **Get verified (optional, later)** — Meta can verify the business for higher
   daily message limits and the green tick. Not needed on day one.

**Plan:** likely a Basic / Pro feature, like online payments.

---

## 3. Features the seller gets

| # | Feature | What it does |
| - | --- | --- |
| 1 | **Connect WhatsApp** | Dashboard → Channels → WhatsApp, Facebook login, OTP. |
| 2 | **Order updates** | Customers get "Order confirmed", "Shipped — track here", "Delivered", "Ready for pickup, your code is ABCD" automatically. |
| 3 | **COD confirmation** | COD orders get "Confirm ✅ / Cancel ❌" buttons → fewer fake orders and returned parcels. |
| 4 | **Ordering inside WhatsApp** | Customer browses, adds to cart, gives address and pays — all in the chat. The order appears in the dashboard like any other. |
| 5 | **Product catalogue** | Products sync to WhatsApp automatically, prices and photos always current. |
| 6 | **Chat inbox in the dashboard** | All customer chats in one place. Staff reply, see the customer's past orders, hand a chat to a teammate. |
| 7 | **Auto-replies** | Welcome message, "we're closed" message, instant answers to "Where is my order?". Mink AI can answer product questions (section 5). |
| 8 | **Abandoned cart reminders** | "You left items in your cart" with a link back. |
| 9 | **Offers / broadcasts** | Send sale and coupon messages — only to customers who agreed. Cost shown before sending. Customers can reply **STOP**. |
| 10 | **Chat button + QR code** | "Chat with us on WhatsApp" button on the website, and a QR code for the shop counter. |

**Bonus:** POS bills sent on WhatsApp instead of printed paper.

---

## 4. Customer journeys

### A. Buying on the website (most common)

1. Customer places an order. At checkout a ticked box says "Get updates on
   WhatsApp".
2. They get: "Hi Rohan, order #ORD1234 confirmed, ₹840". If COD — a confirm button.
3. When shipped: "Your order is on the way 🚚 — track here".
4. Then "Delivered ✅" and maybe "How was it? Rate us ⭐".

### B. Ordering inside WhatsApp — no website needed

1. **Open the chat** — tap "Chat on WhatsApp" on the store's Instagram/website,
   scan the counter QR, or just message "Hi".
2. **Browse** — a "View catalogue" button shows products inside WhatsApp (photo,
   price, description).
3. **Build a cart** — WhatsApp has a built-in cart. Tap "Add to cart", change
   quantities.
4. **Send the cart** — one tap sends it to the store.
5. **Give an address** — a small form opens inside the chat (name, address, PIN
   code). Returning customers see "Deliver to your saved address? ✅".
6. **See the summary** — items, offer discount, delivery charge, total, with
   **Pay now** or **Cash on Delivery** buttons.
7. **Pay**
   - **Inside WhatsApp** — in India Meta supports UPI/card payment in the chat
     through a gateway like Razorpay. Never leaves WhatsApp.
   - **Payment link** — a Razorpay payment page opens briefly, then back to the
     chat. Not the store website, just a payment screen. Simpler to build first.
8. **Confirmation** — "Order #ORD1234 confirmed ✅", then shipping and delivery
   updates in the same chat.

**Behind the scenes in StoreMink**

- The order shows in **Dashboard → Orders**, marked as coming from WhatsApp.
- Prices, stock, offers and delivery are checked by StoreMink, exactly like a
  website order — the customer cannot change a price from the chat.
- Stock is reserved and shipping works the same as website orders.
- Nothing extra for the seller to manage — just another place orders come from.

**Keep simple at first**

- Products with sizes/colours appear as separate items in the WhatsApp catalogue.
  Works fine, slightly less polished than the website.
- Show automatic offers in the summary first; typed coupon codes can come later.
- Start with payment link + COD; add in-chat payment later (needs the seller to
  switch on WhatsApp Payments once in their Meta account).

### C. Coming back

- Left items in the cart → reminder with a link straight back.
- Agreed to promotions → "Diwali sale, 20% off — tap to shop".
- Doesn't want promotions → types **STOP**, never gets them again.

### D. Asking a question

"Is this in size M?" → staff reply from the dashboard inbox, or Mink AI replies
automatically (section 5).

---

## 5. Who answers customer questions

Three layers. The seller chooses how much Mink does.

### Layer 1 — Fixed replies (no AI)

Set once by the seller, always the same, instant and free:

- **Welcome:** "Hi! Welcome to Echos 👋 Tap below to browse, track an order, or
  talk to us."
- **Closed:** "We're closed right now, we'll reply at 10 AM."
- **Menu buttons:** Browse products / Track my order / Talk to us.

### Layer 2 — Mink AI answers common questions

| Customer asks | Mink does |
| --- | --- |
| "Where is my order?" | Looks up **that customer's** order: "Shipped, arriving Thursday, track here" |
| "Is this in size M?" | Checks stock and replies |
| "Do you deliver to 110001?" | Checks delivery, shares charge and expected days |
| "What's your return policy?" | Answers from the store's own policy page |
| "Any offers right now?" | Lists current offers |

### Layer 3 — A human takes over

Mink hands the chat to the seller's team when:

- the customer types "talk to a person"
- it's a complaint, refund, or damaged item
- Mink isn't sure of the answer

The team sees it in the **dashboard inbox** marked "Needs reply", with the full
chat and the customer's orders beside it.

### Seller settings

- **Off** — no AI. Fixed replies only; staff answer everything else.
- **Mink helps** (recommended) — Mink answers simple questions, hands the rest
  to staff.
- **Mink drafts** — Mink writes a suggested reply; staff approve before it's sent.

### Safety rules for customer-facing Mink

- Sees **only that customer's own orders** — never anyone else's.
- Can **only answer** — cannot cancel orders, give refunds, or change prices.
- Doesn't make things up — if it isn't in the store's data, it hands over to a
  person.

### Cost

WhatsApp replies are free (the customer messaged first). The AI part uses the
seller's **Mink credits** — about 1 credit per answer.

> Note: today Mink only talks to the seller inside the dashboard. This would be a
> new, limited, customer-facing version built just for WhatsApp.

---

## 6. Costs

Meta charges per message. The price depends on the message type.

### Meta's prices in India (October 2026)

| Message type | Example | Cost per message |
| --- | --- | --- |
| **Utility** | Order confirmed, shipped, delivered, pickup ready, COD confirm | **₹0.115** |
| **Marketing** | Offers, sales, abandoned-cart reminders, new arrivals | **₹0.86** |
| **Authentication** | OTP / login codes | **₹0.115** |
| **Replies** | Customer messages first, shop answers | **Free** |

Plus **18% GST**.

### What's free

- **Replies within 24 hours** — once a customer messages, every reply for the next
  24 hours is free, including order updates sent in that time.
- **Ad clicks** — a customer who taps a "Click to WhatsApp" ad on
  Instagram/Facebook opens a **72-hour free window** where every message is free,
  offers included.
- **Setup** — connecting WhatsApp and getting message templates approved costs
  nothing.

### Example monthly bills

| Seller | What they send | Monthly cost |
| --- | --- | --- |
| Small shop, 100 orders/month | ~4 updates per order = 400 utility messages | **≈ ₹46** |
| Medium shop, 1,000 orders/month | 4,000 utility messages | **≈ ₹460** |
| + an offer to 1,000 customers | 1,000 marketing messages | **+ ≈ ₹863** |
| + abandoned-cart reminders, 300/month | 300 marketing messages | **+ ≈ ₹259** |

(Add 18% GST to each.)

**Takeaway:** order updates are very cheap — under half a rupee per order.
Promotional messages are where the bill grows, so the dashboard should show the
cost before sending a broadcast: "This will go to 1,200 customers — about ₹1,036."

### Who pays

- The seller adds a card in **their own Meta account** and Meta bills them
  directly. StoreMink doesn't touch this money — same as Razorpay fees.
- Apps like Wati/Interakt charge a monthly platform fee (~₹1,000–3,000) on top of
  Meta's prices. StoreMink connects straight to Meta, so the seller pays only
  Meta's prices, plus whatever plan price StoreMink sets for the feature.
- Prices change from time to time, so the dashboard should show current rates,
  not hard-coded ones.

---

## 7. Meta rules to keep in mind

These are Meta's rules, not ours. If StoreMink hides them well, the seller barely
notices them.

- **Business can't start a chat freely.** Any message the shop sends first (order
  update, offer) must use a **template** Meta approved in advance. StoreMink can
  ship ready-made templates so the seller never has to write or submit them.
- **24-hour window.** After a customer messages, the shop can reply freely for 24
  hours. After that, templates only again.
- **Opt-in for promotions.** Offers only go to customers who agreed to receive
  them, and STOP must always work.

---

## 8. Build order

| Phase | What | Why first |
| --- | --- | --- |
| **Phase 1** | Connect WhatsApp, order updates, COD confirmation, chat button + QR | Biggest value, smallest build |
| **Phase 2** | Dashboard inbox, catalogue sync, abandoned-cart reminders | Turns WhatsApp into a sales channel |
| **Phase 3** | Ordering inside WhatsApp, offers/broadcasts, Mink AI replies | Full WhatsApp commerce |

---

## Sources

- [WhatsApp Business API Pricing in India 2026 (ChatMaxima)](https://chatmaxima.com/whatsapp-api-pricing/india/)
- [WhatsApp API Pricing India rate card (Whautomate)](https://whautomate.com/whatsapp-business-api-pricing-india)
- [Is the WhatsApp API Free? What is free and what is not in 2026 (Unipile)](https://www.unipile.com/is-the-whatsapp-api-free/)
