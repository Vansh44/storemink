import { describe, expect, it } from "vitest";
import { THEME_STUDIO_INDUSTRIES } from "./contracts";
import {
  INDUSTRY_PLAYBOOKS,
  industryPlaybookPrompt,
  industryStartingPattern,
} from "./industry-playbooks";

describe("Theme Studio industry starting patterns", () => {
  it("covers every accepted industry with all four pattern dimensions", () => {
    expect(Object.keys(INDUSTRY_PLAYBOOKS).sort()).toEqual(
      [...THEME_STUDIO_INDUSTRIES].sort(),
    );
    for (const playbook of Object.values(INDUSTRY_PLAYBOOKS)) {
      expect(playbook.pageStructure.length).toBeGreaterThan(2);
      expect(playbook.homeSections.length).toBeGreaterThan(4);
      expect(playbook.colourFamilies.length).toBeGreaterThan(2);
      expect(playbook.imageStyle.length).toBeGreaterThan(20);
    }
  });

  it("uses a specific industry ahead of the general fallback", () => {
    expect(industryStartingPattern(["general", "beauty"]).industry).toBe(
      "beauty",
    );
    expect(industryStartingPattern([]).industry).toBe("general");
    expect(industryPlaybookPrompt(["beauty"])).toContain(
      '"industry": "beauty"',
    );
  });
});
