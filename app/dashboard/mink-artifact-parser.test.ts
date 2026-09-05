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
});
