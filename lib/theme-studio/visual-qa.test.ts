import { describe, expect, it } from "vitest";
import {
  parseVisualQaReport,
  VISUAL_QA_SCHEMA,
  visualQaContext,
} from "./visual-qa";
import { operatorImagePackage } from "./_test-helpers";

const scores = {
  artDirection: 4,
  distinctness: 4,
  commerceClarity: 5,
  typography: 4,
  imagery: 4,
  responsiveComposition: 4,
  detailQuality: 4,
  brandAdaptability: 5,
};

describe("visual QA contract", () => {
  it("sends complete semantic evidence including settings and capability gaps, without image manifests", () => {
    const pkg = operatorImagePackage();
    pkg.capabilityGaps = [
      {
        code: "unsupported_interaction",
        requestedCapability: "Quick view",
        reason: "Unavailable",
        blocking: false,
      },
    ];
    const context = visualQaContext(pkg, {
      evidence: {
        samples: [
          {
            viewport: "phone360",
            path: "/shop",
            width: 360,
            height: 800,
            unrelatedProbeData: "x".repeat(60000),
          },
        ],
      },
    });
    expect(context.capabilityGaps).toEqual(pkg.capabilityGaps);
    expect(context.settings.length).toBeGreaterThan(20);
    expect(context.pages).toEqual([
      { viewport: "phone360", path: "/shop", width: 360, height: 800 },
    ]);
    const text = JSON.stringify(context);
    expect(JSON.parse(text).sections).toHaveLength(
      pkg.definition.preset.pages.length,
    );
    expect(text).not.toContain("licenseNote");
    expect(text.length).toBeLessThan(40000);
  });
  it("accepts the closed eight-row scorecard", () => {
    expect(
      parseVisualQaReport({
        verdict: "pass",
        scores,
        rejections: [],
        findings: [],
        revisionBrief: null,
      }),
    ).toEqual({
      verdict: "pass",
      scores,
      rejections: [],
      findings: [],
      revisionBrief: null,
    });
    expect(VISUAL_QA_SCHEMA.additionalProperties).toBe(false);
  });

  it("rejects invented dimensions, out-of-range scores and rejection keys", () => {
    expect(
      parseVisualQaReport({
        verdict: "pass",
        scores: { ...scores, vibes: 5 },
        rejections: [],
        findings: [],
        revisionBrief: null,
      }),
    ).toBeNull();
    expect(
      parseVisualQaReport({
        verdict: "pass",
        scores: { ...scores, imagery: 6 },
        rejections: [],
        findings: [],
        revisionBrief: null,
      }),
    ).toBeNull();
    expect(
      parseVisualQaReport({
        verdict: "revise",
        scores,
        rejections: ["looks_bad"],
        findings: ["Fix it"],
        revisionBrief: "Use a stronger hierarchy.",
      }),
    ).toBeNull();
  });
});
