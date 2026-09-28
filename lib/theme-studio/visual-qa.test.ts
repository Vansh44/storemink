import { describe, expect, it } from "vitest";
import { parseVisualQaReport, VISUAL_QA_SCHEMA } from "./visual-qa";

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
