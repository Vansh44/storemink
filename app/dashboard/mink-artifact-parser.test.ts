import { describe, expect, it } from "vitest";
import { readMinkArtifacts } from "./mink-artifact-parser";

describe("readMinkArtifacts", () => {
  it("restores proposal cards alongside read-only artifacts", () => {
    const artifacts = [
      {
        type: "clarification",
        title: "Choose inventory scope",
        question: "Which inventory scope should I use?",
        choices: [{ label: "Shop", prompt: "Show Shop inventory" }],
      },
      { type: "metrics", marker: "metrics" },
      {
        type: "catalog",
        marker: "catalog",
        counts: {},
        items: [],
        filters: [],
      },
      { type: "records", marker: "records" },
      { type: "sources", marker: "sources" },
      { type: "proposal", marker: "proposal" },
      {
        type: "workflow",
        runId: "11111111-1111-4111-8111-111111111111",
        template: "weekly_trading_report",
        title: "Weekly trading report",
        description: "Building a durable report.",
        status: "queued",
        currentStep: 0,
        totalSteps: 3,
      },
    ];

    expect(readMinkArtifacts(artifacts).map((item) => item.type)).toEqual([
      "clarification",
      "metrics",
      "catalog",
      "records",
      "sources",
      "proposal",
    ]);
  });

  it("accepts only bounded, known workflow cards", () => {
    const valid = {
      type: "workflow",
      runId: "11111111-1111-4111-8111-111111111111",
      template: "weekly_trading_report",
      title: "Weekly trading report",
      description: "Building a durable report.",
      status: "running",
      currentStep: 1,
      totalSteps: 3,
    };
    expect(readMinkArtifacts([valid])).toEqual([valid]);
    expect(
      readMinkArtifacts([
        { ...valid, template: "revenue_decline_investigation" },
        { ...valid, template: "product_launch_preparation" },
        { ...valid, template: "slow_inventory_promotion" },
        { ...valid, template: "delayed_pickup_review" },
      ]),
    ).toHaveLength(4);
    expect(
      readMinkArtifacts([
        { ...valid, runId: "not-a-uuid" },
        { ...valid, template: "delete_everything" },
        { ...valid, status: "unknown" },
        { ...valid, currentStep: 4 },
        { ...valid, totalSteps: 21 },
      ]),
    ).toEqual([]);
  });

  it("rejects unknown values and preserves the six-artifact bound", () => {
    const valid = Array.from({ length: 8 }, () => ({ type: "metrics" }));
    expect(
      readMinkArtifacts([null, { type: "unknown" }, ...valid]),
    ).toHaveLength(6);
  });

  it("rejects malformed or oversized catalogue artifacts", () => {
    expect(
      readMinkArtifacts([
        { type: "catalog" },
        {
          type: "catalog",
          counts: {},
          items: Array.from({ length: 21 }, () => ({})),
          filters: [],
        },
      ]),
    ).toEqual([]);
  });

  it("rejects unsafe or oversized clarification choices", () => {
    expect(
      readMinkArtifacts([
        {
          type: "clarification",
          question: "Choose",
          choices: [{ label: "Shop", prompt: "" }],
        },
        {
          type: "clarification",
          question: "Choose",
          choices: Array.from({ length: 7 }, () => ({
            label: "Location",
            prompt: "Show this location",
          })),
        },
      ]),
    ).toEqual([]);
  });

  it("accepts only a small, integrity-bound storefront preview artifact", () => {
    const valid = {
      type: "storefront_code_proposal",
      draftId: "11111111-1111-4111-8111-111111111111",
      title: "Storefront code for Home",
      destinationLabel: "Home · custom code",
      destinationPath: "/dashboard/builder?page=home&section=hero-code",
      explanation: "A responsive, private hero preview.",
      target: {
        pageSlug: "home",
        sectionId: "hero-code",
        expectedPageVersion: "2026-09-04T10:20:30.123456+00:00",
        expectedSectionDigest: "a".repeat(64),
      },
      patchDigest: "b".repeat(64),
      changedFields: ["html", "css"],
      beforeCharacters: 120,
      afterCharacters: 180,
      validationChecks: ["Exact target matched", "No write authority granted"],
      status: "private_preview",
      expectedCredits: 5,
      chargedCredits: 5,
      creditSource: "plan",
    };
    expect(readMinkArtifacts([valid])).toEqual([valid]);
    expect(
      readMinkArtifacts([
        { ...valid, destinationPath: "https://attacker.example" },
        { ...valid, patchDigest: "not-a-digest" },
        { ...valid, changedFields: ["database"] },
        { ...valid, creditSource: "attacker" },
      ]),
    ).toEqual([]);
  });

  it("★ RE-CHECKS EVERY DESIGN COLOUR ON THE WAY OUT OF STORED HISTORY", () => {
    // The card writes these into an inline `style` attribute, and stored
    // conversation JSON is the one surface that never went through
    // `validateStorefrontDesign` — so hex is proved again here rather than
    // merely length-bounded.
    const valid = {
      type: "storefront_design_proposal",
      draftId: "11111111-1111-4111-8111-111111111111",
      title: "Storefront design",
      destinationLabel: "Storefront design · Basket",
      destinationPath: "/dashboard/builder",
      explanation: "Warm the page background.",
      target: { expectedDesignDigest: "a".repeat(64) },
      patchDigest: "b".repeat(64),
      summary: {
        palette: [
          {
            token: "cream",
            before: null,
            after: "#fffdf8",
            themeDefault: "#fbf7ef",
          },
        ],
        fonts: [
          { slot: "body", before: null, after: "jost", themeDefault: "inter" },
        ],
        shape: [{ key: "card", before: null, after: 4, themeDefault: 16 }],
        contrastIssues: [],
      },
      status: "private_preview",
      expectedCredits: 2,
      chargedCredits: 2,
      creditSource: "plan",
    };
    expect(readMinkArtifacts([valid])).toEqual([valid]);

    const palette = (after: unknown) => ({
      ...valid,
      summary: {
        ...valid.summary,
        palette: [
          { token: "cream", before: null, after, themeDefault: "#fbf7ef" },
        ],
      },
    });
    expect(
      readMinkArtifacts([
        palette("url(javascript:alert(1))"),
        palette("red"),
        palette("#fff"),
        { ...valid, target: { expectedDesignDigest: "short" } },
        { ...valid, destinationPath: "https://attacker.example" },
        {
          ...valid,
          summary: {
            ...valid.summary,
            shape: [
              { key: "card", before: null, after: 9_999, themeDefault: 16 },
            ],
          },
        },
        {
          ...valid,
          summary: {
            ...valid.summary,
            // Eight tokens is the whole palette, so a longer list is forged.
            palette: Array.from({ length: 9 }, () => ({
              token: "cream",
              before: null,
              after: "#fffdf8",
              themeDefault: "#fbf7ef",
            })),
          },
        },
      ]),
    ).toEqual([]);
  });

  it("★★ PINS A RESTORED GENERATED IMAGE TO THIS PLATFORM'S OWN MEDIA HOST", () => {
    // The card draws `<img src={url}>` from stored conversation JSON. Without
    // this, a forged history row would have the dashboard fetch an arbitrary
    // third-party address the moment a merchant reopens the thread — a
    // tracking beacon at best, and the one field here that becomes a live
    // request rather than text on a page.
    const valid = {
      type: "media_image_proposal",
      draftId: "22222222-2222-4222-8222-222222222222",
      title: "Hero image",
      destinationLabel: "Media Library · Hero image",
      destinationPath: "/dashboard/media",
      url: "https://storage.googleapis.com/sm-media/stores/a0000000-0000-4000-8000-000000000001/mink-generated/33333333-3333-4333-8333-333333333333.jpg",
      alt: "Grains and pulses arranged on a linen cloth",
      prompt: "A warm overhead still life of loose grains on linen.",
      referenceImageCount: 2,
      purpose: "hero",
      aspectRatio: "16:9",
      placement: "The full-width banner at the top of a page",
      saved: false,
      status: "private_preview",
      expectedCredits: 3,
      chargedCredits: 3,
      creditSource: "plan",
    };
    expect(readMinkArtifacts([valid])).toEqual([valid]);

    expect(
      readMinkArtifacts([
        { ...valid, url: "https://attacker.example/pixel.jpg" },
        // A real host, a real-looking path, and NOT under mink-generated: the
        // near miss a prefix-only check would let through.
        {
          ...valid,
          url: "https://storage.googleapis.com/sm-media/stores/a0000000-0000-4000-8000-000000000001/media/33333333-3333-4333-8333-333333333333.jpg",
        },
        { ...valid, url: "http://storage.googleapis.com/a/b" },
        { ...valid, purpose: "product_photo" },
        { ...valid, aspectRatio: "3000:1" },
        { ...valid, destinationPath: "/dashboard/builder" },
        { ...valid, saved: "yes" },
        { ...valid, referenceImageCount: 5 },
        { ...valid, alt: "" },
        { ...valid, creditSource: "attacker" },
      ]),
    ).toEqual([]);
  });
});
