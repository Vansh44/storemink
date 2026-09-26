import { describe, expect, it } from "vitest";
import corpus from "@/evals/theme-studio/phase0.json";

const REQUIRED_CATEGORIES = [
  "vertical_quality",
  "responsive",
  "reference_security",
  "copyright",
  "assets",
  "capability_gap",
  "commerce",
  "ambiguity",
] as const;

const OUTCOMES = new Set(["candidate", "clarify", "capability_gap", "refuse"]);

describe("Theme Studio Phase 0 evaluation corpus", () => {
  it("keeps a bounded, uniquely named golden set", () => {
    expect(corpus.version).toBe(1);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(25);
    expect(corpus.cases.length).toBeLessThanOrEqual(50);
    expect(new Set(corpus.cases.map((entry) => entry.id)).size).toBe(
      corpus.cases.length,
    );
  });

  it("covers every required quality and misuse category", () => {
    const categories = new Set(corpus.cases.map((entry) => entry.category));
    for (const category of REQUIRED_CATEGORIES)
      expect(categories).toContain(category);
  });

  it("gives every brief an actionable expected result", () => {
    for (const entry of corpus.cases) {
      expect(entry.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(entry.prompt.trim().length).toBeGreaterThan(10);
      expect(OUTCOMES.has(entry.expectedOutcome)).toBe(true);
      expect(entry.checks.length).toBeGreaterThan(0);
      expect(entry.forbidden.length).toBeGreaterThan(0);
      expect(new Set(entry.checks).size).toBe(entry.checks.length);
      expect(new Set(entry.forbidden).size).toBe(entry.forbidden.length);
    }
  });
});
