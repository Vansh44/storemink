import { describe, expect, it } from "vitest";
import {
  MINK_DRAFT_CONFIG,
  estimateMinkDraftIntent,
  normalizeMinkDraftContent,
} from "./draft-types";

describe("Mink draft contracts", () => {
  it("keeps the documented weighted-credit schedule stable", () => {
    expect(
      Object.fromEntries(
        Object.entries(MINK_DRAFT_CONFIG).map(([kind, config]) => [
          kind,
          config.expectedCredits,
        ]),
      ),
    ).toEqual({
      product_description: 2,
      product_seo: 1,
      blog: 5,
      coupon_email: 2,
      customer_message: 2,
      product_create: 3,
      coupon_create: 1,
      coupon_update: 1,
      customer_group_create: 1,
      customer_group_update: 1,
      inventory_adjustment: 1,
      bulk_inventory_adjustment: 5,
      order_status_transition: 1,
      bulk_price_update: 5,
      offer_create: 1,
      offer_update: 1,
      // ★ ZERO. Activation writes one boolean, and the proposal it switches on
      // has already been charged for — billing again would bill the merchant
      // twice for one piece of work. It is a separate APPROVAL, not a separate
      // piece of drafting.
      offer_activate: 0,
      storefront_custom_code: 5,
    });
  });

  it("strictly normalizes and caps Phase 5B bulk inventory lines", () => {
    const lines = [
      {
        sku: " TEA-500 ",
        location: " Delhi ",
        quantity_change: -2,
        reason: "damaged",
        note: " Counted twice. ",
      },
      {
        sku: "COFFEE",
        location: "Shop",
        quantity_change: 10,
        reason: "received",
        note: "",
      },
    ];
    const normalized = normalizeMinkDraftContent("bulk_inventory_adjustment", {
      lines_json: JSON.stringify(lines),
    });
    expect(JSON.parse(normalized.lines_json)).toEqual([
      {
        ...lines[0],
        sku: "TEA-500",
        location: "Delhi",
        note: "Counted twice.",
      },
      lines[1],
    ]);
    expect(() =>
      normalizeMinkDraftContent("bulk_inventory_adjustment", {
        lines_json: JSON.stringify([lines[0], lines[0]]),
      }),
    ).toThrow("duplicates the same SKU and location");
    expect(() =>
      normalizeMinkDraftContent("bulk_inventory_adjustment", {
        lines_json: JSON.stringify(
          Array.from({ length: 21 }, (_, index) => ({
            ...lines[1],
            sku: `SKU-${index}`,
          })),
        ),
      }),
    ).toThrow("1-20 lines");
    expect(() =>
      normalizeMinkDraftContent("bulk_inventory_adjustment", {
        lines_json: JSON.stringify([{ ...lines[0], product_id: "forbidden" }]),
      }),
    ).toThrow("unsupported fields");
  });

  it("bounds single-SKU inventory proposals and requires accountable reasons", () => {
    expect(
      normalizeMinkDraftContent("inventory_adjustment", {
        quantity_change: " -12 ",
        reason: "damaged",
        note: "Counted by the warehouse manager.",
        product_id: "must be ignored",
      }),
    ).toEqual({
      quantity_change: "-12",
      reason: "damaged",
      note: "Counted by the warehouse manager.",
    });
    for (const quantity_change of ["0", "1.5", "1000001", "-1000001"]) {
      expect(() =>
        normalizeMinkDraftContent("inventory_adjustment", {
          quantity_change,
          reason: "correction",
        }),
      ).toThrow("non-zero whole number");
    }
    expect(() =>
      normalizeMinkDraftContent("inventory_adjustment", {
        quantity_change: "2",
        reason: "other",
        note: "",
      }),
    ).toThrow("audit note is required");
  });

  it("normalizes only the fields allowed by each draft kind", () => {
    expect(
      normalizeMinkDraftContent("product_seo", {
        seo_title: "  Summer shoes ",
        seo_description: " Shop the collection. ",
        unsafe: "ignored",
      }),
    ).toEqual({
      seo_title: "Summer shoes",
      seo_description: "Shop the collection.",
    });
  });

  it("allowlists only Phase 5C forward order targets and an internal note", () => {
    expect(
      normalizeMinkDraftContent("order_status_transition", {
        target_status: " shipped ",
        note: " Handed to local courier. ",
        payment_status: "paid",
        customer_email: "must-be-ignored@example.com",
      }),
    ).toEqual({
      target_status: "shipped",
      note: "Handed to local courier.",
    });
    for (const target_status of [
      "pending",
      "cancelled",
      "completed",
      "refunded",
    ]) {
      expect(() =>
        normalizeMinkDraftContent("order_status_transition", {
          target_status,
          note: "",
        }),
      ).toThrow("processing, shipped, delivered");
    }
  });

  it("rejects missing required fields and bounded overflows", () => {
    expect(() =>
      normalizeMinkDraftContent("customer_message", { body: "" }),
    ).toThrow("Message is required");
    expect(() =>
      normalizeMinkDraftContent("product_seo", {
        seo_title: "a".repeat(71),
        seo_description: "Valid",
      }),
    ).toThrow("SEO title must be at most 70");
  });

  it("shows a deterministic client estimate without treating it as billing", () => {
    expect(
      estimateMinkDraftIntent("Write a blog post about summer care"),
    ).toEqual({
      kind: "blog",
      label: "Blog post",
      expectedCredits: 5,
    });
    expect(estimateMinkDraftIntent("How many blogs do I have?")).toBeNull();
    expect(
      estimateMinkDraftIntent("Create a new product for masala tea"),
    ).toMatchObject({
      kind: "product_create",
      expectedCredits: 3,
    });
    expect(estimateMinkDraftIntent("Update coupon SAVE10")).toMatchObject({
      kind: "coupon_update",
      expectedCredits: 1,
    });
    expect(
      estimateMinkDraftIntent("Create a customer group for VIPs"),
    ).toMatchObject({
      kind: "customer_group_create",
      expectedCredits: 1,
    });
    expect(
      estimateMinkDraftIntent("Adjust stock for SKU TEA-500 by -2 in Delhi"),
    ).toMatchObject({ kind: "inventory_adjustment", expectedCredits: 1 });
    expect(
      estimateMinkDraftIntent("Bulk update inventory for multiple SKUs"),
    ).toMatchObject({
      kind: "bulk_inventory_adjustment",
      expectedCredits: 5,
    });
    expect(
      estimateMinkDraftIntent("Mark order ORD-1001 as shipped"),
    ).toMatchObject({
      kind: "order_status_transition",
      expectedCredits: 1,
    });
    expect(
      estimateMinkDraftIntent(
        "Redesign the Echos homepage hero and generate custom code",
      ),
    ).toMatchObject({
      kind: "storefront_custom_code",
      expectedCredits: 5,
    });
  });

  // ★ The storefront branch runs FIRST in the cascade, so an over-broad match
  // there shadows every more specific branch and quotes the wrong credit count
  // for it. A generic verb beside "website"/"homepage" is not a code request.
  it("does not let the storefront branch shadow more specific draft intents", () => {
    expect(
      estimateMinkDraftIntent("Create a new product for my website"),
    ).toMatchObject({ kind: "product_create", expectedCredits: 3 });
    expect(
      estimateMinkDraftIntent("Write a blog post for the homepage"),
    ).toMatchObject({ kind: "blog", expectedCredits: 5 });
    expect(
      estimateMinkDraftIntent("Create a coupon code for the website"),
    ).toMatchObject({ kind: "coupon_create", expectedCredits: 1 });
    // An explicit code or design signal still reaches the storefront branch.
    expect(
      estimateMinkDraftIntent("Update the CSS on my storefront hero"),
    ).toMatchObject({ kind: "storefront_custom_code", expectedCredits: 5 });
  });

  it("preserves generated code byte-for-byte while normalizing proposal metadata", () => {
    const content = normalizeMinkDraftContent("storefront_custom_code", {
      page_slug: " home ",
      section_id: " section-1 ",
      expected_page_version: " 2026-09-04T10:20:30.123456+00:00 ",
      expected_section_digest: ` ${"a".repeat(64)} `,
      patch_digest: ` ${"b".repeat(64)} `,
      html: "  <section>Keep whitespace</section>\n",
      css: "\n.hero { color: red; }\n",
      js: "  const label = 'é';\n",
      height_mode: " auto ",
      fixed_height: " 480 ",
      explanation: "  A private preview.  ",
    });
    expect(content).toMatchObject({
      page_slug: "home",
      section_id: "section-1",
      html: "  <section>Keep whitespace</section>\n",
      css: "\n.hero { color: red; }\n",
      js: "  const label = 'é';\n",
      height_mode: "auto",
      fixed_height: "480",
      explanation: "A private preview.",
    });
  });

  // ★★ THE 96 KiB COMBINED CAP GOVERNS GENERATED OUTPUT, NOT THE `before`
  // SNAPSHOT. `custom_code` legally holds 64 KiB in EACH of html/css/js, so an
  // existing section can exceed 96 KiB combined and still be a valid saved
  // section. Enforcing the AI-patch limit against that copy rejected the whole
  // proposal — after 5 credits had been charged — with an error that blamed the
  // proposal's own code.
  it("holds a historical before snapshot to its shape, not the patch size cap", () => {
    const oversized = {
      page_slug: "home",
      section_id: "section-1",
      expected_page_version: "2026-09-04 10:20:30.123456+00",
      expected_section_digest: "a".repeat(64),
      patch_digest: "b".repeat(64),
      html: "x".repeat(60 * 1024),
      css: "y".repeat(50 * 1024),
      js: "",
      height_mode: "auto",
      fixed_height: "400",
      explanation: "Current Website Builder code before this proposal.",
    };
    expect(
      normalizeMinkDraftContent("storefront_custom_code", oversized, {
        historicalSnapshot: true,
      }).html.length,
    ).toBe(60 * 1024);
    // Newly generated content is still capped.
    expect(() =>
      normalizeMinkDraftContent("storefront_custom_code", oversized),
    ).toThrow("Combined storefront code must be at most 96 KiB.");
    // A snapshot is still held to its shape.
    expect(() =>
      normalizeMinkDraftContent(
        "storefront_custom_code",
        { ...oversized, height_mode: "tall" },
        { historicalSnapshot: true },
      ),
    ).toThrow("Height mode must be auto or fixed.");
  });
});
