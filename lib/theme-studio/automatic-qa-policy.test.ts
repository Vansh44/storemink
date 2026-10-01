import { describe, expect, it } from "vitest";
import {
  automaticQaDecision,
  automaticAcceptanceFailures,
} from "./automatic-qa-policy";
import { gate, GATE_LABELS, type GateId } from "./acceptance-gates";

const passing = () =>
  (Object.keys(GATE_LABELS) as GateId[]).map((id) =>
    gate(id, [], { required: id !== "browser.performance" }),
  );
const failing = (id: GateId, code = "quality") =>
  passing().map((g) =>
    g.id === id
      ? gate(id, [{ code, where: "phone360 · home", message: "Fix this" }])
      : g,
  );

describe("automatic completion policy", () => {
  it("sends an exhausted route-check budget to attention, never a paid revision", () => {
    for (const id of ["routes.render", "routes.links"] as const) {
      for (const code of ["budget", "timeout"]) {
        expect(automaticQaDecision(failing(id, code), true, 0)).toBe(
          "attention",
        );
      }
    }
    // An ordinary broken link at the first iteration is still repaired.
    expect(
      automaticQaDecision(failing("routes.links", "broken"), true, 0),
    ).toBe("revise");
  });
  it("requires every acceptance gate and a passing visual verdict", () => {
    expect(automaticQaDecision(passing(), true, 0)).toBe("pass");
    expect(automaticQaDecision(passing(), false, 0)).toBe("revise");
    expect(automaticQaDecision([], true, 0)).toBe("attention");
    expect(automaticQaDecision(passing().slice(1), true, 0)).toBe("attention");
  });
  it("repairs acceptance failures even when vision says pass and stops after the bounded budget", () => {
    expect(automaticQaDecision(failing("browser.accessibility"), true, 0)).toBe(
      "revise",
    );
    expect(automaticQaDecision(failing("package.design"), true, 1)).toBe(
      "revise",
    );
    expect(automaticQaDecision(failing("browser.accessibility"), true, 2)).toBe(
      "attention",
    );
    expect(automaticQaDecision(passing(), true, 2)).toBe("pass");
    expect(
      automaticAcceptanceFailures(failing("browser.accessibility"))[0],
    ).toContain("phone360 · home: Fix this");
  });
  it("blocks security and stops unrepairable runtime faults without requesting paid redesigns", () => {
    expect(automaticQaDecision(failing("package.security"), true, 0)).toBe(
      "blocked",
    );
    expect(
      automaticQaDecision(failing("routes.render", "indexable"), true, 0),
    ).toBe("attention");
    expect(automaticQaDecision(failing("browser.coverage"), true, 0)).toBe(
      "attention",
    );
  });
  it("keeps performance advisory", () => {
    const gates = passing().map((g) =>
      g.id === "browser.performance"
        ? gate(g.id, [{ code: "slow", message: "Slow" }], { required: false })
        : g,
    );
    expect(automaticQaDecision(gates, true, 0)).toBe("pass");
  });
});
