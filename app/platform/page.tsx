import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  Check,
  ChevronDown,
  CircleCheck,
  Globe2,
  LayoutTemplate,
  Megaphone,
  Package,
  Receipt,
  RefreshCcw,
  ShoppingBag,
  Smartphone,
  Store,
  Users,
} from "lucide-react";
import { PLATFORM_URL, POS_URL, THEMES_URL } from "@/lib/site";
import {
  BRAND_DESCRIPTION,
  SUPPORT_EMAIL,
  platformOrganizationSchema,
  platformWebsiteSchema,
} from "@/lib/seo/brand-identity";
import {
  PLAN_FEATURE_MATRIX,
  PLAN_LIMITS,
  PLAN_META,
  type PlanMatrixValue,
} from "@/lib/plans";
import { getPlanPricing } from "@/lib/plans/pricing";
import { BrandMark } from "./brand-mark";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";
import { PricingCards, type PricingCard } from "./pricing-cards";
import { BuilderArt, InvoiceArt, StorefrontArt } from "./product-art";
import "./homepage.css";

// The homepage stays a server component. The only client JavaScript is the
// isolated monthly/yearly switch inside PricingCards and the mobile menu;
// everything else remains fast, crawlable and keyboard-friendly.

const PLANS = [
  {
    meta: PLAN_META.free,
    who: "Try everything. Launch your first store.",
    features: [
      "Storefront on your own subdomain",
      "Website builder — every section type",
      `Up to ${PLAN_LIMITS.free.maxProducts} products`,
      "Blogs, reviews and enquiries",
      "GST invoicing and tax classes",
      "Cash on delivery checkout",
      "Full admin dashboard",
      `${PLAN_LIMITS.free.aiGenerationsPerMonth} AI generations a month`,
    ],
    cta: "Start free",
    popular: false,
  },
  {
    meta: PLAN_META.basic,
    who: "For new brands getting their first orders.",
    features: [
      "Everything in Free, plus:",
      "Online payments — your own gateway, 0% to us",
      `${PLAN_LIMITS.basic.maxProducts} products`,
      `${PLAN_LIMITS.basic.maxStaff} staff accounts with roles`,
      "Customer groups and blog submissions",
      "Shiprocket fulfilment and custom code",
      `${PLAN_LIMITS.basic.aiGenerationsPerMonth} AI generations a month`,
    ],
    cta: `Choose ${PLAN_META.basic.name}`,
    popular: true,
  },
  {
    meta: PLAN_META.pro,
    who: "For growing brands, a team, and a counter.",
    features: [
      `Everything in ${PLAN_META.basic.name}, plus:`,
      "Point of Sale — till, staff PINs, shifts",
      `${PLAN_LIMITS.pro.posLocationsIncluded} shop locations, ${PLAN_LIMITS.pro.posDevicesPerLocation} tills each`,
      "Stock per location, and transfers",
      "Buy online, collect in store",
      "Email campaigns",
      "Your own custom domain",
      "Advanced analytics — GA4, Meta Pixel and conversion insights",
      "Unlimited products and staff",
      `${PLAN_LIMITS.pro.aiGenerationsPerMonth} AI generations a month`,
    ],
    cta: `Choose ${PLAN_META.pro.name}`,
    popular: false,
  },
];

function MatrixValue({ value }: { value: PlanMatrixValue }) {
  if (value === true) {
    return (
      <span className="smh-matrix-yes" aria-label="Included">
        <Check size={17} aria-hidden="true" />
      </span>
    );
  }
  if (value === false || value === "—") {
    return (
      <span className="smh-matrix-no" aria-label="Not included">
        —
      </span>
    );
  }
  return <span>{value}</span>;
}

function PlanComparison() {
  return (
    <div className="smh-matrix-wrap">
      <h3>Compare every feature</h3>
      <div className="smh-matrix-scroll">
        <table className="smh-matrix">
          <thead>
            <tr>
              <th scope="col">Feature</th>
              <th scope="col">Free</th>
              <th scope="col">Basic</th>
              <th scope="col">Pro</th>
            </tr>
          </thead>
          <tbody>
            {PLAN_FEATURE_MATRIX.flatMap((section) => [
              <tr className="smh-matrix-section" key={section.title}>
                <th colSpan={4} scope="colgroup">
                  {section.title}
                </th>
              </tr>,
              ...section.rows.map((row) => (
                <tr key={`${section.title}-${row.label}`}>
                  <th scope="row">{row.label}</th>
                  <td>
                    <MatrixValue value={row.free} />
                  </td>
                  <td>
                    <MatrixValue value={row.basic} />
                  </td>
                  <td>
                    <MatrixValue value={row.pro} />
                  </td>
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
      <p className="smh-matrix-note">
        If a payment fails or you downgrade, StoreMink keeps your existing
        products, settings, content and history. Lower-plan limits only pause
        gated features and new over-limit additions; upgrading restores access.
      </p>
    </div>
  );
}

const FAQS = [
  {
    q: "Can I start without paying?",
    a: "Yes. The Free plan lets you build and publish a working StoreMink storefront without a credit card. When you need your own domain, online payments, more products or Point of Sale, you can upgrade without rebuilding anything.",
  },
  {
    q: "Does StoreMink charge a transaction fee?",
    a: "No. Connect your own supported payment gateway and customer payments settle directly to you. StoreMink charges the plan price, not a percentage of your sales.",
  },
  {
    q: "Can my website and physical shop share inventory?",
    a: "Yes. StoreMink Point of Sale uses the same catalogue, customer records and location-aware inventory as your online store. Sales, returns, pickup orders and stock transfers stay connected.",
  },
  {
    q: "Do I need a developer to design my store?",
    a: "No. Choose a theme, add your brand, and arrange ready-made sections in the visual website builder. You can preview changes before publishing them.",
  },
  {
    q: "Can I sell both D2C and B2B?",
    a: "Yes. A single StoreMink store can handle regular online purchases alongside enquiry-based and wholesale selling, so your catalogue and customer data do not split into separate systems.",
  },
  {
    q: "Is StoreMink built for Indian businesses?",
    a: "Yes. Plans are priced in rupees, GST tax classes and invoices are built in, and StoreMink supports the payment and fulfilment workflows Indian brands use every day.",
  },
  {
    q: "What can Mink AI do?",
    a: "Mink AI is StoreMink's built-in assistant, currently in beta. It can answer permission-aware questions from your store data and prepare private, editable content drafts. Guarded dashboard actions will expand as their approval controls are ready.",
  },
];

const priceInr = (value: number) => `₹${value.toLocaleString("en-IN")}`;

function CommerceCommandCentre() {
  const orders = [
    ["#1028", "Aarav Mehta", "₹2,490", "Paid"],
    ["#1027", "Naina Kapoor", "₹1,280", "Ready"],
    ["#1026", "Riya Shah", "₹3,940", "Packed"],
  ];

  return (
    <div className="smh-command" aria-hidden="true">
      <div className="smh-command-window">
        <div className="smh-command-bar">
          <span className="smh-command-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="smh-command-address">app.storemink.com</span>
          <span className="smh-live">
            <i /> Live
          </span>
        </div>
        <div className="smh-command-body">
          <aside className="smh-command-rail">
            <span className="is-brand">
              <BrandMark size={18} />
            </span>
            <span className="is-active">
              <BarChart3 size={15} />
            </span>
            <span>
              <ShoppingBag size={15} />
            </span>
            <span>
              <Package size={15} />
            </span>
            <span>
              <Users size={15} />
            </span>
          </aside>
          <div className="smh-command-main">
            <div className="smh-command-heading">
              <div>
                <small>Tuesday, 25 August</small>
                <b>Good afternoon, Rhea</b>
              </div>
              <span>
                Last 30 days <ChevronDown size={11} />
              </span>
            </div>
            <div className="smh-metrics">
              <div>
                <span>Net sales</span>
                <b>₹48,420</b>
                <small>↗ 18.4%</small>
              </div>
              <div>
                <span>Orders</span>
                <b>128</b>
                <small>↗ 12.1%</small>
              </div>
              <div>
                <span>Customers</span>
                <b>94</b>
                <small>↗ 8.7%</small>
              </div>
            </div>
            <div className="smh-command-grid">
              <div className="smh-chart-card">
                <span>Sales across your store</span>
                <div className="smh-chart">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
                <div className="smh-chart-labels">
                  <span>1 Aug</span>
                  <span>15 Aug</span>
                  <span>Today</span>
                </div>
              </div>
              <div className="smh-channel-card">
                <span>Sales by channel</span>
                <div className="smh-donut">
                  <i>76%</i>
                </div>
                <small>
                  <i className="online" /> Online store
                </small>
                <small>
                  <i className="retail" /> Retail POS
                </small>
              </div>
            </div>
            <div className="smh-orders-card">
              <div>
                <b>Latest orders</b>
                <span>View all</span>
              </div>
              {orders.map(([id, customer, amount, status]) => (
                <p key={id}>
                  <b>{id}</b>
                  <span>{customer}</span>
                  <strong>{amount}</strong>
                  <em>{status}</em>
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="smh-float-store">
        <span>
          <Globe2 size={15} />
        </span>
        <div>
          <small>Online store</small>
          <b>yourbrand.com</b>
        </div>
        <em>Live</em>
      </div>
      <div className="smh-float-pos">
        <span>
          <Store size={16} />
        </span>
        <div>
          <small>Retail POS</small>
          <b>Connaught Place</b>
        </div>
        <em>Online</em>
      </div>
      <div className="smh-float-order">
        <CircleCheck size={16} />
        <span>
          <b>New order</b>
          <small>₹2,490 · just now</small>
        </span>
      </div>
    </div>
  );
}

function OrderFlowArt() {
  return (
    <div className="smh-order-art" aria-hidden="true">
      <div className="smh-order-top">
        <span>Orders</span>
        <em>All locations</em>
      </div>
      <div className="smh-order-tabs">
        <b>All</b>
        <span>Unfulfilled</span>
        <span>Ready</span>
        <span>Delivered</span>
      </div>
      <div className="smh-order-row is-head">
        <span>Order</span>
        <span>Customer</span>
        <span>Channel</span>
        <span>Total</span>
      </div>
      <div className="smh-order-row">
        <b>#1028</b>
        <span>Aarav Mehta</span>
        <span>
          <i className="smh-dot-purple" /> Online
        </span>
        <strong>₹2,490</strong>
      </div>
      <div className="smh-order-row">
        <b>#1027</b>
        <span>Naina Kapoor</span>
        <span>
          <i className="smh-dot-green" /> POS
        </span>
        <strong>₹1,280</strong>
      </div>
      <div className="smh-order-row">
        <b>#1026</b>
        <span>Riya Shah</span>
        <span>
          <i className="smh-dot-purple" /> Online
        </span>
        <strong>₹3,940</strong>
      </div>
      <div className="smh-sync-pill">
        <RefreshCcw size={13} /> Inventory synced across 2 locations
      </div>
    </div>
  );
}

function GrowthArt() {
  return (
    <div className="smh-growth-art" aria-hidden="true">
      <div className="smh-growth-stat">
        <small>Returning customer rate</small>
        <b>34.8%</b>
        <span>+6.2% this month</span>
      </div>
      <div className="smh-growth-bars">
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="smh-growth-actions">
        <span>
          <Megaphone size={15} /> Campaign sent <b>2,840</b>
        </span>
        <span>
          <Receipt size={15} /> Coupon orders <b>126</b>
        </span>
      </div>
    </div>
  );
}

export default async function StoreminkLanding() {
  const pricing = await getPlanPricing();
  const cheapestPaidInr = Math.min(
    ...PLANS.map((plan) => pricing[plan.meta.id].monthlyInr).filter(
      (price) => price > 0,
    ),
  );

  const pricingCards: PricingCard[] = PLANS.map((plan) => ({
    id: plan.meta.id,
    name: plan.meta.name,
    who: plan.who,
    features: plan.features,
    cta: plan.cta,
    popular: plan.popular,
    ...pricing[plan.meta.id],
  }));

  const planOffers = PLANS.map((plan) => ({
    "@type": "Offer",
    name: `StoreMink ${plan.meta.name}`,
    description: plan.meta.tagline,
    priceCurrency: "INR",
    price: pricing[plan.meta.id].monthlyInr,
    url: `${PLATFORM_URL}/#pricing`,
    availability: "https://schema.org/InStock",
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      priceCurrency: "INR",
      price: pricing[plan.meta.id].monthlyInr,
      billingDuration: 1,
      billingIncrement: 1,
      unitCode: "MON",
      referenceQuantity: {
        "@type": "QuantitativeValue",
        value: 1,
        unitCode: "MON",
      },
    },
  }));

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      platformOrganizationSchema(),
      platformWebsiteSchema(),
      {
        "@type": "SoftwareApplication",
        "@id": `${PLATFORM_URL}/#software`,
        name: "StoreMink",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web",
        url: PLATFORM_URL,
        description: BRAND_DESCRIPTION,
        publisher: { "@id": `${PLATFORM_URL}/#organization` },
        offers: {
          "@type": "AggregateOffer",
          priceCurrency: "INR",
          lowPrice: 0,
          highPrice: pricing.pro.monthlyInr,
          offerCount: PLANS.length,
          offers: planOffers,
        },
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="smh">
        <a className="smh-skip" href="#main-content">
          Skip to content
        </a>

        <SiteHeader />

        <main id="main-content">
          <section className="smh-hero">
            <div className="smh-hero-wash" aria-hidden="true" />
            <div className="smh-container smh-hero-copy">
              <p className="smh-eyebrow">
                <span>AI-powered</span> commerce, made for India{" "}
                <ArrowRight size={13} />
              </p>
              <h1>
                Create your store. <em>Sell everywhere.</em> Grow with AI.
              </h1>
              <p className="smh-hero-lead">
                Create your online store in minutes, then manage products,
                orders, customers, inventory, locations, online sales and POS
                from one connected dashboard. Mink AI, currently in beta, helps
                you understand your business and prepare everyday work using
                simple prompts.
              </p>
              <div className="smh-hero-actions">
                <Link href="/signup" className="smh-button smh-button-primary">
                  Create your store free <ArrowRight size={17} />
                </Link>
                <a href="#platform" className="smh-button smh-button-soft">
                  Explore the platform
                </a>
              </div>
              <div className="smh-hero-proof">
                <span>
                  <Check size={15} /> Free plan forever
                </span>
                <span>
                  <Check size={15} /> No credit card
                </span>
                <span>
                  <Check size={15} /> 0% transaction fee
                </span>
              </div>
            </div>
            <div className="smh-container smh-command-wrap">
              <CommerceCommandCentre />
            </div>
          </section>

          <section className="smh-outcomes" aria-label="StoreMink advantages">
            <div className="smh-container smh-outcome-grid">
              <div>
                <b>₹0</b>
                <span>to start building</span>
              </div>
              <div>
                <b>0%</b>
                <span>StoreMink transaction fee</span>
              </div>
              <div>
                <b>D2C + B2B</b>
                <span>in one storefront</span>
              </div>
              <div>
                <b>Online + POS</b>
                <span>one connected operation</span>
              </div>
            </div>
          </section>

          <section className="smh-intro" id="platform">
            <div className="smh-container">
              <p className="smh-section-label">
                The complete commerce platform
              </p>
              <h2>
                Everything your brand needs.
                <br />
                <em>Nothing to stitch together.</em>
              </h2>
              <p className="smh-section-lead">
                Start with a storefront. Add a counter, a team and new locations
                when you are ready. Your data stays in one place through every
                stage.
              </p>
            </div>
          </section>

          <section
            className="smh-bento smh-container"
            aria-label="Commerce platform features"
          >
            <article className="smh-bento-card smh-bento-store">
              <div className="smh-bento-copy">
                <span className="smh-icon-chip">
                  <LayoutTemplate size={20} />
                </span>
                <p className="smh-card-label">Online store</p>
                <h3>A storefront that feels like your brand.</h3>
                <p>
                  Choose a theme, arrange sections, add your own domain and
                  publish—without waiting on a developer.
                </p>
                <a href={THEMES_URL}>
                  Explore themes <ArrowRight size={15} />
                </a>
              </div>
              <div className="smh-store-art">
                <StorefrontArt />
              </div>
            </article>

            <article className="smh-bento-card smh-bento-builder">
              <div className="smh-bento-copy">
                <span className="smh-icon-chip">
                  <Globe2 size={20} />
                </span>
                <p className="smh-card-label">Visual builder</p>
                <h3>Make every page yours.</h3>
                <p>
                  Build with ready-made sections, preview every change and
                  publish when it is right.
                </p>
              </div>
              <BuilderArt />
            </article>

            <article className="smh-bento-card smh-bento-orders">
              <div className="smh-bento-copy">
                <span className="smh-icon-chip">
                  <Package size={20} />
                </span>
                <p className="smh-card-label">Orders & inventory</p>
                <h3>Every order. Every location. One clear view.</h3>
                <p>
                  Track fulfilment, pickup, returns and stock without hopping
                  between systems.
                </p>
              </div>
              <OrderFlowArt />
            </article>

            <article className="smh-bento-card smh-bento-growth">
              <div className="smh-bento-copy">
                <span className="smh-icon-chip">
                  <BarChart3 size={20} />
                </span>
                <p className="smh-card-label">Customers & growth</p>
                <h3>Turn first orders into lasting relationships.</h3>
                <p>
                  Use customer groups, coupons, reviews, blogs and email
                  campaigns—all fed by the same customer history.
                </p>
              </div>
              <GrowthArt />
            </article>
          </section>

          <section className="smh-pos">
            <div className="smh-container smh-pos-grid">
              <div className="smh-pos-copy">
                <p className="smh-section-label">StoreMink Point of Sale</p>
                <h2>
                  Your website and your counter, finally on the same page.
                </h2>
                <p>
                  Sell from a computer, tablet or phone. Products, customers and
                  location stock stay connected to your online store in real
                  time.
                </p>
                <ul>
                  <li>
                    <CircleCheck size={18} />
                    <span>
                      <b>Fast in-store checkout</b> with barcode search, held
                      sales and split payments.
                    </span>
                  </li>
                  <li>
                    <CircleCheck size={18} />
                    <span>
                      <b>Live multi-location inventory</b> with transfers and
                      low-stock visibility.
                    </span>
                  </li>
                  <li>
                    <CircleCheck size={18} />
                    <span>
                      <b>Connected fulfilment</b> for pickup, returns and store
                      credit.
                    </span>
                  </li>
                </ul>
                <Link href={POS_URL} className="smh-button smh-button-light">
                  Explore Point of Sale <ArrowRight size={17} />
                </Link>
              </div>
              <div className="smh-pos-media">
                <Image
                  src="/brand/storemink-pos-multidevice.png"
                  alt="StoreMink Point of Sale running on a desktop, tablet and phone"
                  width={1536}
                  height={1024}
                  sizes="(max-width: 900px) 100vw, 56vw"
                />
                <span className="smh-pos-badge">
                  <Smartphone size={16} /> Works across your devices
                </span>
              </div>
            </div>
          </section>

          <section className="smh-journey">
            <div className="smh-container">
              <div className="smh-journey-head">
                <div>
                  <p className="smh-section-label">From idea to first order</p>
                  <h2>Open your store today.</h2>
                </div>
                <p>
                  No agency handoff. No app checklist. Just three focused steps
                  inside one dashboard.
                </p>
              </div>
              <ol className="smh-journey-steps">
                <li>
                  <span>01</span>
                  <div className="smh-step-icon">
                    <Store size={22} />
                  </div>
                  <h3>Create your store</h3>
                  <p>
                    Choose your name and your storefront is ready immediately.
                  </p>
                </li>
                <li>
                  <span>02</span>
                  <div className="smh-step-icon">
                    <LayoutTemplate size={22} />
                  </div>
                  <h3>Make it unmistakably yours</h3>
                  <p>Add products, colours, content and your own domain.</p>
                </li>
                <li>
                  <span>03</span>
                  <div className="smh-step-icon">
                    <ShoppingBag size={22} />
                  </div>
                  <h3>Start selling everywhere</h3>
                  <p>
                    Take online orders, counter sales, enquiries and pickups.
                  </p>
                </li>
              </ol>
            </div>
          </section>

          <section className="smh-tax smh-container">
            <div className="smh-tax-copy">
              <p className="smh-section-label">Built for the way India sells</p>
              <h2>GST-ready from the first invoice.</h2>
              <p>
                Set your tax classes and place of supply once. StoreMink
                prepares clear, printable invoices for every order—online or in
                store.
              </p>
              <div className="smh-tax-points">
                <span>
                  <Check size={16} /> Inclusive or exclusive pricing
                </span>
                <span>
                  <Check size={16} /> HSN and tax breakdowns
                </span>
                <span>
                  <Check size={16} /> Downloadable invoices
                </span>
              </div>
            </div>
            <div className="smh-tax-art">
              <InvoiceArt />
            </div>
          </section>

          <section className="smh-pricing-area" id="pricing">
            <div className="smh-container">
              <div className="smh-pricing-head">
                <p className="smh-section-label">Simple pricing</p>
                <h2>Start free. Grow for less.</h2>
                <p>
                  Every plan includes a real storefront and 0% StoreMink
                  transaction fees. Paid plans start at{" "}
                  {priceInr(cheapestPaidInr)} per month.
                </p>
              </div>
              <div className="smh-pricing-component">
                <PricingCards plans={pricingCards} />
              </div>
              <PlanComparison />
              <p className="smh-pricing-foot">
                <CircleCheck size={16} /> Your store data is never deleted by a
                plan downgrade or failed payment.
              </p>
            </div>
          </section>

          <section className="smh-faq" id="faq">
            <div className="smh-container smh-faq-grid">
              <div className="smh-faq-copy">
                <p className="smh-section-label">Good to know</p>
                <h2>Questions before you begin?</h2>
                <p>
                  Find step-by-step guides in the{" "}
                  <a href="https://help.storemink.com">StoreMink Help Centre</a>
                  , or email us at{" "}
                  <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
                </p>
              </div>
              <div className="smh-faq-list">
                {FAQS.map((faq) => (
                  <details key={faq.q}>
                    <summary>
                      {faq.q}
                      <ChevronDown size={19} />
                    </summary>
                    <p>{faq.a}</p>
                  </details>
                ))}
              </div>
            </div>
          </section>

          <section className="smh-final">
            <div className="smh-container smh-final-card">
              <div className="smh-final-glow" aria-hidden="true" />
              <p className="smh-section-label">Your next chapter starts here</p>
              <h2>Build a store people remember.</h2>
              <p>
                Start free today. Bring your products, your brand and your
                ambition.
              </p>
              <div>
                <Link href="/signup" className="smh-button smh-button-light">
                  Create your store free <ArrowRight size={17} />
                </Link>
                <a href="#pricing" className="smh-button smh-button-outline">
                  See plans
                </a>
              </div>
            </div>
          </section>
        </main>

        <SiteFooter />
      </div>
    </>
  );
}
