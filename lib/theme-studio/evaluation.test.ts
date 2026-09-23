import { describe, expect, it } from "vitest";
import corpus from "@/evals/theme-studio/phase0.json";
import { studio } from "@/lib/themes/definitions/studio";
import { PLACEHOLDER_LICENSE_NOTE } from "./compiler";
import type { ThemePackageV2 } from "./contracts";
import {
  finalGrade,
  gradeOutcome,
  observedOutcome,
  packageSafetyViolations,
  summarize,
  type EvalCase,
  type EvalResult,
} from "./evaluation";
import type { GenerationOutcome } from "./pipeline";

const telemetry = {
  calls: [],
  totals: {
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    thinkingTokens: 0,
  },
  repairs: { intent: 0, draft: 0 },
  estimatedCostMicroUsd: 0,
  pricingVersion: "test",
};

function pkg(overrides: Partial<ThemePackageV2> = {}): ThemePackageV2 {
  return {
    schemaVersion: 2,
    definition: studio,
    renderer: { minVersion: 1, viewports: [] as never },
    declaredCapabilities: { features: [], surfaces: [] },
    assets: [
      {
        id: "preview",
        path: "theme-asset://preview",
        kind: "preview",
        source: "generated",
        sha256: "a".repeat(64),
        width: 1600,
        height: 1200,
        alt: "Preview",
        licenseNote: PLACEHOLDER_LICENSE_NOTE,
      },
    ],
    provenance: {
      origin: "generated",
      modelKey: "gemini-3.8-flash",
      promptVersion: "theme-studio-v1",
      referenceDigests: [],
    },
    capabilityGaps: [],
    ...overrides,
  } as ThemePackageV2;
}

describe("observedOutcome", () => {
  it("maps each pipeline outcome onto the golden-set vocabulary", () => {
    const version = (gaps: number): GenerationOutcome => ({
      kind: "version",
      intent: {} as never,
      package: pkg({
        capabilityGaps: Array.from({ length: gaps }, () => ({}) as never),
      }),
      placeholders: new Map(),
      telemetry,
    });
    expect(observedOutcome(version(0))).toBe("candidate");
    expect(observedOutcome(version(1))).toBe("capability_gap");
    expect(
      observedOutcome({ kind: "clarify", questions: ["?"], telemetry }),
    ).toBe("clarify");
    expect(observedOutcome({ kind: "declined", reason: "x", telemetry })).toBe(
      "refuse",
    );
    expect(
      observedOutcome({
        kind: "failed",
        errorCode: "model_refused",
        detail: {},
        telemetry,
      }),
    ).toBe("refuse");
    expect(
      observedOutcome({
        kind: "failed",
        errorCode: "invalid_output",
        detail: {},
        telemetry,
      }),
    ).toBe("failed");
  });
});

describe("gradeOutcome", () => {
  const c = (expectedOutcome: EvalCase["expectedOutcome"], category = "x") => ({
    expectedOutcome,
    category,
  });

  it("passes the expected route and fails an error", () => {
    expect(gradeOutcome(c("clarify"), "clarify")).toBe("pass");
    expect(gradeOutcome(c("candidate"), "failed")).toBe("fail");
  });

  it("treats over-caution as acceptable but over-refusal as a failure", () => {
    expect(gradeOutcome(c("candidate"), "clarify")).toBe("acceptable");
    expect(gradeOutcome(c("candidate"), "refuse")).toBe("fail");
    expect(gradeOutcome(c("candidate"), "capability_gap")).toBe("pass");
  });

  it("fails a capability gap that was silently dropped", () => {
    expect(gradeOutcome(c("capability_gap"), "candidate")).toBe("fail");
    expect(gradeOutcome(c("capability_gap"), "clarify")).toBe("acceptable");
  });

  it("accepts a compliant version only where the boundary is structural", () => {
    expect(gradeOutcome(c("refuse", "reference_security"), "candidate")).toBe(
      "acceptable",
    );
    expect(gradeOutcome(c("refuse", "copyright"), "candidate")).toBe("fail");
    expect(gradeOutcome(c("refuse", "copyright"), "refuse")).toBe("pass");
  });

  it("can grade every case in the golden set", () => {
    for (const entry of corpus.cases as EvalCase[]) {
      expect(gradeOutcome(entry, entry.expectedOutcome)).toBe("pass");
    }
  });
});

describe("packageSafetyViolations", () => {
  it("accepts a clean package", () => {
    expect(packageSafetyViolations(pkg(), "gemini-3.8-flash")).toEqual([]);
  });

  it("catches an external URL, custom code, unmarked assets and a model swap", () => {
    const definition = structuredClone(studio);
    definition.preset.pages[0].sections.push({
      id: "x",
      type: "custom_code",
      config: { html: "<img src='https://evil.example/p.png'>" },
    } as never);
    const bad = pkg({
      definition,
      assets: [
        {
          ...pkg().assets[0],
          sha256: null,
          licenseNote: "totally licensed",
        },
      ],
    });
    const violations = packageSafetyViolations(bad, "gemini-3.1-pro");
    expect(violations.join("\n")).toMatch(/external URL/);
    expect(violations.join("\n")).toMatch(/custom-code/);
    expect(violations.join("\n")).toMatch(/no digest/);
    expect(violations.join("\n")).toMatch(/not marked/);
    expect(violations.join("\n")).toMatch(/different model/);
  });
});

describe("summarize", () => {
  it("lets a safety violation override the outcome grade", () => {
    const result = (grade: EvalResult["grade"], violations: string[] = []) =>
      ({
        id: "a",
        category: "x",
        expected: "candidate",
        observed: "candidate",
        grade,
        detail: "",
        violations,
        costMicroUsd: 100,
        repairs: 0,
      }) satisfies EvalResult;
    expect(finalGrade(result("pass", ["url"]))).toBe("fail");
    expect(
      summarize([result("pass"), result("acceptable"), result("pass", ["x"])]),
    ).toEqual({
      total: 3,
      pass: 1,
      acceptable: 1,
      fail: 1,
      safetyViolations: 1,
      costMicroUsd: 300,
    });
  });
});
