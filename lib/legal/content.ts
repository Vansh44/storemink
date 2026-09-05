// ---------------------------------------------------------------------------
// StoreMink's own policies.
//
// ⚠ NOT LEGAL ADVICE. This was written by engineers, not lawyers. It covers the
// risks this product structurally has — platform-not-seller, funds settling
// directly to merchants, merchant-as-data-controller, AI output the merchant
// approves and relies on, liability capped at fees — and it is a serious
// starting point, not a substitute for review by counsel qualified in the
// jurisdictions you operate in. Have it reviewed before you take real money.
// The `⚠ REVIEW` markers below flag the clauses where wording most affects
// your exposure.
//
// ══ ⚠ BLOCKED — TWO CLAUSES STILL CARRY THEIR v1 WORDING ══════════════════
// These need facts only the business can supply, and inventing them would be
// worse than leaving them:
//
//   1. THE CONTRACTING ENTITY. §1 says "StoreMink" and never names a legal
//      person. Until the registered name, form and address are known, there is
//      nothing to put here. A contract that does not identify who you are
//      contracting with is the first thing an opponent attacks.
//
//   2. GOVERNING LAW AND SEAT (§23). The v1 clause gives jurisdiction to "the
//      courts at your registered place of business" — the MERCHANT's home
//      court, anywhere in India. That is the opposite of the usual platform
//      posture: it means defending a claim in any state a merchant happens to
//      sit in. Replace it with your own seat (and decide courts vs
//      arbitration) before this matters.
//
// ⚠ NEVER put a bracketed placeholder in a body below. These strings are
// published verbatim into an immutable table; `legal.test.ts` fails the build
// if one appears, because a placeholder that reaches production is a policy
// that says nothing at the exact moment it is relied on.
//
// WHY THE CONTENT LIVES IN CODE: it is reviewable in a diff, version-controlled
// alongside the product it describes, and seeded into legal_documents by an
// idempotent publish (lib/legal/seed.ts) the same way ensureHomepage() seeds a
// store_pages row. Once published, the DB row is the source of truth and is
// immutable — editing this file does not change what anyone already accepted.
// ---------------------------------------------------------------------------

export interface LegalContent {
  kind: string;
  title: string;
  version: number;
  body: string;
}

const COMPANY = "StoreMink";

/** House style: a section with a heading and paragraphs. */
function section(heading: string, ...paras: string[]): string {
  return `<h2>${heading}</h2>\n${paras.map((p) => `<p>${p}</p>`).join("\n")}`;
}

/** A section whose last block is a list — used where prose would hide items. */
function listSection(
  heading: string,
  intro: string,
  items: string[],
  ...after: string[]
): string {
  const list = items.map((i) => `<li>${i}</li>`).join("\n");
  return [
    `<h2>${heading}</h2>`,
    `<p>${intro}</p>`,
    `<ul>\n${list}\n</ul>`,
    ...after.map((p) => `<p>${p}</p>`),
  ].join("\n");
}

// ── Terms of Service ────────────────────────────────────────────────────────
const TERMS_BODY = [
  `<p><em>Version 2</em></p>`,

  section(
    "1. Who we are, and what this covers",
    `${COMPANY} provides software that lets you create and run an online store, sell in person, and manage the operations behind both. These Terms are the agreement between you (the merchant) and ${COMPANY}. By creating an account, or by continuing to use the service after we publish a new version, you agree to them.`,
    `If you are agreeing on behalf of a company, you confirm you are authorised to bind that company, and "you" means that company.`,
  ),

  // ⚠ REVIEW — this is the single most important clause for your exposure.
  section(
    "2. We are a platform, not the seller",
    `${COMPANY} provides tools. <strong>You are the seller of every product listed in your store.</strong> You alone are responsible for your products, their description, pricing, legality, safety, quality, packaging, delivery, warranties, returns and after-sales support.`,
    `${COMPANY} is not a party to any contract between you and your customers. Any dispute about goods, delivery or refunds is between you and your customer. We may, but are not obliged to, provide information to help resolve such a dispute.`,
    `This applies to everything published through your account however it was produced, <strong>including text, images and code produced with our AI features</strong>. Nothing we generate is reviewed by us for accuracy, legality or fitness before it reaches your customers.`,
    `You are responsible for identifying yourself accurately to your customers, including your legal name, business address and contact details.`,
  ),

  // ⚠ REVIEW — this reflects the BYO-gateway model (CODEBASE §18).
  section(
    "3. Payments settle to you, not to us",
    `Where you connect your own payment gateway, your customers' payments settle <strong>directly to your account with that provider</strong>. ${COMPANY} does not receive, hold, or control those funds at any point, and does not act as a payment processor, escrow agent or money transmitter.`,
    `Your relationship with your payment provider is governed by your agreement with them. Chargebacks, settlement timing, holds, payout failures and refunds out of your own balance are matters between you and that provider.`,
    `Where you accept cash or take payment on an external card or UPI terminal, ${COMPANY} records what your staff enter. We do not verify that the money was received, and a record in the dashboard is not proof of payment.`,
  ),

  section(
    "4. Subscription fees, automatic payment and plan changes",
    `You pay ${COMPANY} for the software itself. Fees are those published on our pricing page at the time of your billing cycle, exclusive of taxes unless stated. Fees already paid are non-refundable except where the law requires otherwise.`,
    `If you authorise automatic payment, you permit us to collect each cycle's fee up to the limit shown when you authorised it, until you cancel. We may issue an invoice for a cycle before we collect it.`,
    `If a payment fails we may allow a short grace period and then reduce your account to a free plan. <strong>A reduction does not delete your data.</strong> Content and settings above the free plan's limits stay in place but stop being served or editable until an eligible plan resumes. An open register shift may be closed automatically when this happens.`,
    `We may change prices. A change applies from your next billing cycle after we give notice, and never retroactively to a cycle you have paid for.`,
  ),

  listSection(
    "5. Accounts and services you connect",
    `Some features work by connecting an account you hold with someone else. Where you do that, the account and everything done through it remain yours, and you are responsible for complying with that provider's terms and with any registration the law requires. This includes:`,
    [
      `<strong>Payment gateways</strong> — your merchant account, your settlement, your chargebacks.`,
      `<strong>Shipping and logistics</strong> — rates, bookings, pickups, loss, damage and delay are between you and the carrier. Where measurements are missing we may use conservative defaults to obtain a quote, and a quote is an estimate, not a promise.`,
      `<strong>SMS</strong> — you are responsible for your sender registration, your approved message templates, and for the consent behind every number you message.`,
      `<strong>Analytics and advertising tags</strong> — anything you add sends your customers' data to your own accounts, on your own instructions.`,
      `<strong>Domains</strong> — you control the DNS. If a domain stops resolving to us we may stop serving it and fall back to your ${COMPANY} address so that your store stays reachable.`,
    ],
    `We are not responsible for a third party's availability, pricing, accuracy or decisions, and disconnecting one may disable the features that depend on it.`,
  ),

  section(
    "6. Selling in person",
    `Where you use the register, you are responsible for the people you authorise to use it, for the devices you approve, and for the credentials you issue them. Staff act for you, not for us.`,
    `You are responsible for counting your own cash. Drawer figures, shift reports and variance in the dashboard are a record of what your staff entered and what our software calculated from it. They are not an audit, and we do not reconcile them against your bank.`,
  ),

  section(
    "7. Invoices, tax documents and customer balances",
    `Our software can produce invoices, credit notes and tax breakdowns from the settings and rates <strong>you</strong> configure. Those documents are yours. <strong>You are responsible for whether they are correct, whether they are the right document, and for your own filings and record-keeping.</strong> We do not provide tax advice and do not verify a rate, a registration number or a serial against any authority.`,
    `Where you issue store credit, a gift balance or any other amount owed to a customer, that amount is owed by <strong>you</strong>. Our software records it. Closing your account does not discharge it, and we do not become liable for it.`,
  ),

  // ⚠ REVIEW — AI is the newest and least settled area of exposure here.
  section(
    "8. AI features",
    `Some features use automated systems, including third-party models, to read your store's data and to draft text, images or code. They are provided to help you work, not to make decisions for you.`,
    `<strong>Output can be wrong, incomplete or misleading.</strong> Figures, summaries, recommendations and drafts are not advice — not legal, tax, financial, medical or professional advice of any kind — and must be checked against your own records before you rely on them or publish them.`,
    `Where a feature can change your store, it acts only on a change you are shown and explicitly approve. <strong>Your approval is your instruction</strong>, and what follows is your responsibility as if you had made the change yourself, including anything published to your live storefront.`,
    `AI features consume the allowance or credits described on your plan, may be rate-limited, and may be changed or withdrawn. Some are offered as a beta and are excluded from any availability expectation.`,
    `We do not use your data to train our own models. Providers who process it for us are bound by contract; their terms, not ours, govern what they may do with it.`,
  ),

  section(
    "9. Code and scripts you add",
    `You may add your own HTML, CSS and JavaScript to your storefront. We run it inside a restricted frame to limit what it can reach, but <strong>that is a precaution, not a guarantee</strong>, and it does not make the code safe or lawful.`,
    `Code you add — or code you approve from an AI feature — is your content under clause 2. You are responsible for what it does to your customers, for anything it loads from elsewhere, and for any consent its behaviour requires. We may disable code that harms your customers, other merchants, or the platform.`,
  ),

  section(
    "10. Your responsibilities",
    `You must comply with all laws that apply to your business, including consumer protection, product safety, labelling, advertising, tax, and data protection law. You must obtain any licence or registration your trade requires.`,
    `You are responsible for everything posted through your account, for keeping your credentials secure, and for the actions of anyone you invite to your dashboard or authorise on a register.`,
    `You must publish your own store policies to your customers — at least how returns, refunds, delivery and privacy work in your business — and keep them accurate.`,
    `You must comply with our Acceptable Use Policy, which forms part of these Terms.`,
  ),

  section(
    "11. Your data and your customers' data",
    `You keep ownership of your content and your customer data. You grant us the limited licence needed to host, process, back up, transmit and display it in order to run the service for you, including sending it to the providers listed in our Privacy Policy.`,
    `In relation to your customers' personal data, <strong>you are the controller and ${COMPANY} is a processor</strong> acting on your instructions. You are responsible for having a lawful basis to collect that data, for the notices and consents your customers are entitled to, and for the instructions you give us through the settings you choose.`,
    `Our Privacy Policy explains what we do with the data we hold.`,
  ),

  section(
    "12. Availability, beta features, and changes to the service",
    `We work to keep the service available, but we do not guarantee uninterrupted or error-free operation. We may change, add or remove features. Where a change materially reduces core functionality on a paid plan, we will give reasonable notice.`,
    `Features labelled beta, preview or alpha are made available so you can try them. They may be incomplete, may change without notice, and may be withdrawn. They carry no availability expectation and, to the extent the law allows, no liability.`,
    `Some functionality depends on third parties — payment gateways, logistics, email and SMS delivery, hosting, maps, AI models. Their outages, rate limits and decisions are not within our control.`,
  ),

  section(
    "13. Suspension and termination",
    `You may stop using the service at any time.`,
    `We may suspend or terminate an account that breaches these Terms or the Acceptable Use Policy, that exposes us or our other users to legal risk or harm, or where required by law. Where practical and lawful, we will tell you why and give you an opportunity to put it right. We may suspend immediately and without notice where the risk is serious.`,
    `You can export your own data at any time while your account is active, and for a reasonable period after termination, after which we may delete it. Deletion is permanent and includes the media you uploaded. It does not remove records we must keep — for example a record that you accepted these Terms, or an invoice we must retain for tax.`,
  ),

  // ⚠ REVIEW — an "as is" disclaimer's enforceability varies by jurisdiction
  // and is often limited against consumers.
  section(
    "14. No warranties",
    `The service is provided <strong>"as is" and "as available"</strong>. To the fullest extent permitted by law, we disclaim all warranties, express or implied, including merchantability, fitness for a particular purpose, and non-infringement.`,
    `We do not warrant that the service will meet your requirements, that it will be secure against every attack, that any defect will be corrected, or that any figure, report or generated output is accurate or fit for the use you put it to.`,
  ),

  // ⚠ REVIEW — the cap and the carve-outs are the clauses counsel will focus on.
  section(
    "15. Limitation of liability",
    `To the fullest extent permitted by law, ${COMPANY} is not liable for indirect, incidental, special, consequential or punitive damages, nor for lost profits, lost revenue, lost sales, lost goodwill or lost or corrupted data, however caused.`,
    `We are also not liable for loss arising from a decision you took on the basis of a figure, report or generated output, from a third-party service you connected, from cash or tender handling at your counter, or from a tax document our software produced from settings you configured.`,
    `Our total aggregate liability arising out of or relating to the service is limited to the <strong>subscription fees you actually paid to ${COMPANY} in the twelve months before the event giving rise to the claim</strong>.`,
    `Nothing in these Terms excludes liability that cannot lawfully be excluded, including liability for death or personal injury caused by negligence, or for fraud.`,
  ),

  section(
    "16. You indemnify us",
    `You will defend and indemnify ${COMPANY}, its officers and employees against any claim, loss, liability or cost (including reasonable legal fees) arising from your products, your content, your use of the service, your breach of these Terms or the Acceptable Use Policy, or your breach of any law or third-party right — including any claim brought by one of your customers, by your staff, by a provider you connected, or by an authority.`,
    `This includes claims arising from output you approved or published from an AI feature, from code or scripts you added, from messages you sent, and from tax documents issued through your store.`,
  ),

  section(
    "17. Feedback",
    `If you send us ideas, suggestions or bug reports, you allow us to use them to improve the service without obligation or payment to you. You keep whatever rights you already had; we simply do not owe you anything for acting on a suggestion.`,
  ),

  section(
    "18. Events outside our control",
    `Neither party is liable for a failure to perform caused by something beyond its reasonable control, including a failure of a network, hosting or payment provider, a cyber attack, an act of a public authority, industrial action, or a natural event. Your obligation to pay for a period you used the service is not excused by this clause.`,
  ),

  section(
    "19. Transfer of this agreement",
    `You may not assign or transfer these Terms without our written consent. We may assign them to a group company, or to a buyer of our business or assets, on notice to you.`,
  ),

  section(
    "20. Notices",
    `We give notice by email to the address on your account, or in the dashboard. Keeping that address current and monitored is your responsibility, and a notice we send to it is effective whether or not you read it. Write to us at <a href="mailto:support@storemink.com">support@storemink.com</a>.`,
  ),

  section(
    "21. General",
    `You may not resell, sublicense, or offer the service to others as your own product without our written agreement.`,
    `If a provision is held unenforceable, the rest stays in force and that provision applies to the maximum extent permitted. A delay in enforcing a right is not a waiver of it.`,
    `These Terms, together with the Acceptable Use Policy and the Privacy Policy, are the entire agreement between us about the service, and replace anything said before.`,
  ),

  section(
    "22. Changes to these Terms",
    `We may update these Terms. Every version is published with a version number and an effective date, and previous versions are retained. Where a change is material we will ask you to accept the new version before you continue to use the service.`,
  ),

  // ⚠⚠ BLOCKED — v1 WORDING, AND IT FAVOURS THE MERCHANT. See the header note:
  // this sends every dispute to the merchant's own local courts. Replace with
  // your seat once the entity is settled.
  section(
    "23. Governing law",
    `These Terms are governed by the laws of India, and the courts at your registered place of business in India have exclusive jurisdiction, unless mandatory local law provides otherwise.`,
  ),

  section(
    "24. Contact",
    `Questions about these Terms: <a href="mailto:support@storemink.com">support@storemink.com</a>.`,
  ),
].join("\n");

// ── Privacy Policy ──────────────────────────────────────────────────────────
const PRIVACY_BODY = [
  `<p><em>Version 2</em></p>`,

  section(
    "1. Two different roles",
    `This policy covers data ${COMPANY} holds as a <strong>controller</strong> — your merchant account, your billing, your staff accounts, and your use of our dashboard.`,
    `For the personal data your <strong>customers</strong> give to <strong>your</strong> store — names, addresses, order history — the merchant is the controller and ${COMPANY} is a <strong>processor</strong> acting on their instructions. If you shopped at a store built on ${COMPANY} and want your data changed or removed, contact that store first; we will assist them.`,
  ),

  section(
    "2. What we collect",
    `<strong>Account data</strong>: name, email address, phone number, password (hashed — we never see it in the clear), and the business location you give at signup.`,
    `<strong>Staff data</strong>: for people you invite to the dashboard or a register, their name, email, role, the locations you assign them, and their register credential (stored hashed).`,
    `<strong>Store data</strong>: what you create in the product — products, pages, orders, customers, and settings.`,
    `<strong>Usage and technical data</strong>: IP address, browser and device information, and logs of requests, errors, emails and messages sent. Some of this is security evidence rather than analytics — for example, we record the IP and browser used when someone accepts our Terms, and when a register device is authorised.`,
    `<strong>AI interactions</strong>: the questions you put to our AI features, the context we assembled to answer them, the output returned, and any rating or issue report you send us about an answer. See clause 5.`,
    `<strong>Payment data</strong>: we do <strong>not</strong> store card numbers. Payments are handled by payment providers; we store only identifiers, amounts and status returned by them.`,
  ),

  section(
    "3. Why we use it",
    `To provide and secure the service; to bill you; to send transactional messages you need (order alerts, security notices, billing); to run the features you switch on, including AI features; to support you when you ask; to detect abuse and fraud; and to meet legal obligations.`,
    `We do not sell personal data, and we do not use your data or your customers' data to train our own models.`,
  ),

  listSection(
    "4. Who we share it with",
    `Providers who process data on our behalf under contract, so that the service works. Currently:`,
    [
      `<strong>Google Cloud</strong> — hosting, database and file storage.`,
      `<strong>Google Identity Platform</strong> — accounts, sign-in, and the SMS one-time codes used to verify a phone number.`,
      `<strong>Google Vertex AI and the Gemini API</strong> — our AI features. See clause 5 for what reaches them.`,
      `<strong>Resend</strong> — email delivery, including delivery outcomes such as bounces and complaints.`,
      `<strong>Razorpay</strong> — our own subscription and credit payments.`,
      `<strong>Google Maps</strong> and <strong>BigDataCloud</strong> — turning a location or coordinates into an address, when someone asks us to. The BigDataCloud lookup is made by the browser at the moment a merchant or a shopper chooses to use it.`,
      `<strong>Google Search Console</strong> — search performance for launched stores and their sitemaps.`,
    ],
    `Where <strong>you</strong> connect an account of your own — a payment gateway, a logistics provider such as <strong>Shiprocket</strong>, an SMS provider such as <strong>Twilio</strong>, or an analytics or advertising tag — our software sends data to it <strong>on your instructions</strong>. Those providers act for you, under your agreement with them, and this policy does not govern what they do with it. Shipping a parcel sends your customer's name, address and phone to the carrier; sending an SMS sends their number and the message.`,
    `We may also disclose data where required by law, or to protect the rights and safety of our users or the public.`,
  ),

  // ⚠ REVIEW — confirm the provider terms this clause describes before relying
  // on the second paragraph; it states our position, not a warranty from them.
  section(
    "5. AI features and your data",
    `When you use an AI feature we send the model only what it needs for that request: your store profile and brand settings, and the specific catalogue, sales, inventory, order or Website Builder content the request is about. Where an answer involves orders or customers, direct contact details are minimised or masked before they are sent.`,
    `Our provider processes this to return an answer. It is bound by contract, and we do not permit it or ourselves to use your data to train general-purpose models. Their contractual terms, not this policy, govern what they may do; if that changes materially we will say so here.`,
    `We keep your AI conversations so you can reopen them, and to investigate a problem you report. They are visible only to your own account, are retained for a limited period and are then deleted. Where our support team needs to look at a reported answer, the detail we store for that purpose is reduced first.`,
    `Public Help Centre answers work the same way: the question you type and the published guides we retrieved are sent to the model. Do not put passwords, card numbers or anyone else's personal details into an AI prompt.`,
  ),

  section(
    "6. Where it is held, and for how long",
    `Data is hosted on Google Cloud infrastructure. Some providers may process data outside your country; where they do, we rely on the safeguards those providers offer.`,
    `We keep data for as long as your account is active, then for a period afterwards where we need it for legal, tax or dispute-resolution reasons. Operational records are pruned on a rolling basis — activity records after one year, notification, email and message records after ninety days, AI conversations after ninety days, and raw storefront analytics events after fourteen days once they have been aggregated. Search performance history is kept longer because the source only reports a limited window.`,
  ),

  section(
    "7. Your rights",
    `Depending on where you live, you may ask us to give you a copy of your data, correct it, delete it, restrict how we use it, or object to a use. Write to <a href="mailto:support@storemink.com">support@storemink.com</a> and we will respond within the period the applicable law allows.`,
    `You can export most of your store data yourself from the dashboard at any time.`,
    `Deleting a store is permanent. It removes the store's records, its uploaded media, and the sign-in accounts that existed only for that store; an account that is also used elsewhere is kept. Some data cannot be deleted on request — a record that you accepted our Terms, or an invoice we must keep for tax, are examples. If you need an account or its order history removed, contact us rather than deleting piecemeal, so that linked records are handled correctly.`,
  ),

  section(
    "8. If you shopped at a store built on StoreMink",
    `The merchant decides what to collect and why; we process it for them. Ask them first — they can change or remove your details, and we will help them do it.`,
    `A merchant may add their own analytics or advertising tags to their storefront. Those send data to the merchant's own accounts, not ours, and only after you allow that category on their site. You can withdraw that choice on the same site at any time. First-party measurement, where the merchant has switched it on, uses a key we rotate daily and does not store an identifier in your browser.`,
  ),

  section(
    "9. Security",
    `We use encryption in transit, tenant isolation enforced in the database, hashed credentials, scoped access for staff you invite, and least-privilege access internally. Credentials you give us for a provider you connect are encrypted before storage and are never shown back to you.`,
    `No system is perfectly secure; if a breach affects your data we will notify you as the law requires.`,
  ),

  section(
    "10. Children",
    `The service is not intended for anyone under 18, and we do not knowingly collect their data.`,
  ),

  section(
    "11. Changes and contact",
    `We publish each version of this policy with a version number and effective date. Questions or requests: <a href="mailto:support@storemink.com">support@storemink.com</a>.`,
  ),
].join("\n");

// ── Acceptable Use ──────────────────────────────────────────────────────────
const AUP_BODY = [
  `<p><em>Version 2</em></p>`,
  `<p>This policy forms part of the Terms of Service. It exists so that one merchant's conduct cannot put every other merchant on the platform at risk.</p>`,

  listSection(
    "1. What you may not sell",
    `Anything illegal where you or your customer are located, and in particular:`,
    [
      `Weapons, ammunition, explosives and their components.`,
      `Illegal drugs, controlled substances, drug paraphernalia, and prescription medicines or medical devices without the licence to sell them.`,
      `Counterfeit, replica or infringing goods, and anything you are not authorised to resell.`,
      `Stolen property, and stolen or scraped data of any kind.`,
      `Human remains or body parts, protected wildlife, and products made from them.`,
      `Sexually explicit material, and adult services.`,
      `Tobacco, vaping, cannabis and alcohol products where you lack the required licence, and anything age-restricted you cannot verify age for.`,
      `Financial instruments, securities, virtual currency, and anything that functions as a deposit-taking, lending, insurance or investment product.`,
      `Gambling, betting, lotteries and games of chance where you are not licensed.`,
      `Government identity documents, licences and official credentials.`,
      `Hazardous or dangerous goods you are not licensed and packaged to ship.`,
      `Tools, services or instructions whose main purpose is to break into systems, defeat security, or harass someone.`,
    ],
  ),

  listSection("2. What you may not do", `Whatever you sell, you may not:`, [
    `Mislead customers about who you are, what you are selling, what it costs, what it is made of, or when it will arrive.`,
    `Take payment for goods you cannot supply, or refuse a remedy the law gives your customer.`,
    `Run a scheme whose returns depend on recruitment rather than sales, or make earnings or health claims you cannot substantiate.`,
    `Send unsolicited bulk email or SMS, or message addresses and numbers you did not collect lawfully and with consent. <strong>Our email sending domain is shared with every other merchant</strong>; spam sent from your store damages deliverability for all of them, and we enforce this strictly.`,
    `Ignore an unsubscribe or opt-out, or route around a suppression list.`,
    `Attempt to access another store's data, probe or attack the platform, bypass usage limits or plan entitlements, scrape at a scale that degrades service, or reverse-engineer the software.`,
    `Upload malware, or use a store to phish or impersonate someone else.`,
    `Use the platform mainly to host files, run a link farm, or manipulate search rankings rather than to sell.`,
    `Share a register credential, or let someone use a register or dashboard account that is not theirs.`,
  ]),

  section(
    "3. Using AI features responsibly",
    `You may not use our AI features to generate content that would breach this policy if you had written it yourself. In particular: do not publish generated claims about a product's effects, safety, ingredients or origin without checking them; do not present generated text as professional, medical, legal or financial advice; and do not use generated copy or code to impersonate a person or business.`,
    `Do not put other people's personal data, credentials or payment details into a prompt. Do not attempt to make a feature act outside what you were shown and approved, extract another store's data, or produce code intended to defeat the restrictions it runs under.`,
    `Automating or scripting these features to consume allowance beyond normal interactive use is a breach of this policy.`,
  ),

  section(
    "4. Shared infrastructure and fair use",
    `Sending reputation, rate limits and capacity are shared. Behaviour that degrades them for others — sustained abnormal load, mass automated requests, or sending patterns that trigger provider penalties — may be limited or stopped even where no other clause is breached. Where a feature has a published limit, working around it is a breach.`,
  ),

  section(
    "5. Intellectual property complaints",
    `If you believe a store on ${COMPANY} is using your work, brand or listing without permission, write to <a href="mailto:support@storemink.com">support@storemink.com</a> with the store address, what you own, where it appears, and a statement that you are the rights holder or authorised to act for them. We may remove or disable the content while we look into it, and we will pass your complaint to the merchant so they can respond.`,
    `Repeated substantiated complaints against the same store may end that account.`,
  ),

  section(
    "6. How we enforce it",
    `We may investigate suspected breaches and may suspend a store, disable a feature, withhold a message, or terminate an account. Serious cases — fraud, harm to others, or anything we are legally required to report — may be referred to the authorities.`,
    `Where practical and lawful, we will tell you what the problem is and give you a chance to fix it first. Where the risk to customers, to other merchants or to the platform is serious, we may act first and explain afterwards.`,
  ),

  section(
    "7. Reporting",
    `To report a store or content that breaches this policy, write to <a href="mailto:support@storemink.com">support@storemink.com</a> with the store address and what you have seen.`,
  ),
].join("\n");

/**
 * The CURRENT source text of each policy — not "version 1".
 *
 * To change a published policy: edit the body above AND bump its `version`,
 * then run `scripts/publish-legal.ts --publish`. Bumping the number is what
 * tells the publisher this is a new version rather than a re-run; editing the
 * body without it does nothing, because the DB row is immutable once published
 * and the publisher refuses to go backwards or sideways.
 *
 * The old version stays in the table forever — people accepted it.
 *
 * ⚠ PUBLISHING v2 INTERRUPTS EVERY MERCHANT. The re-acceptance gate in the
 * dashboard layout holds them until they accept, so publish all three together
 * rather than three times.
 */
export const LEGAL_CONTENT: LegalContent[] = [
  { kind: "terms", title: "Terms of Service", version: 2, body: TERMS_BODY },
  { kind: "privacy", title: "Privacy Policy", version: 2, body: PRIVACY_BODY },
  {
    kind: "acceptable-use",
    title: "Acceptable Use Policy",
    version: 2,
    body: AUP_BODY,
  },
];
