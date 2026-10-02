import { GATE_LABELS, type GateResult } from "./acceptance-gates";

// Migration 0145 constrains version/run/capture/QA iterations to 0..3, so
// three automatic repairs (iterations 0 -> 1 -> 2 -> 3) is the ceiling the
// database allows. Raising this further needs a migration first.
export const MAX_AUTOMATIC_QA_REPAIRS = 3;

/** A model cannot overrule deterministic gates or repair a broken runtime. */
export function automaticQaDecision(
  gates: readonly GateResult[],
  modelPassed: boolean,
  iteration: number,
  phase: "layout" | "final" = "final",
) {
  const requiredIds =
    phase === "layout"
      ? [
          "browser.coverage",
          "browser.overflow",
          "browser.clipped_text",
          "browser.tap_targets",
          "browser.image_crops",
          "browser.accessibility",
          "browser.media",
          "browser.performance",
        ]
      : Object.keys(GATE_LABELS);
  if (requiredIds.some((id) => !gates.some((g) => g.id === id)))
    return "attention" as const;
  const failed = gates.filter((g) => g.required && g.status !== "pass");
  if (failed.some((g) => g.id === "package.security"))
    return "blocked" as const;
  // A preview too slow to check (a page timing out, or the whole budget
  // spent) is not a theme defect a paid revision can be trusted to fix, nor a
  // blip a recapture would clear.
  if (
    failed.some((g) =>
      g.findings.some((f) => f.code === "budget" || f.code === "timeout"),
    )
  )
    return "attention" as const;
  if (
    failed.some(
      (g) =>
        ["demo.materialize", "browser.coverage", "assets.integrity"].includes(
          g.id,
        ) ||
        (g.id === "routes.render" &&
          g.findings.some((f) =>
            ["indexable", "fetch", "unthemed", "token"].includes(f.code),
          )),
    )
  )
    return "attention" as const;
  if (!failed.length && modelPassed) return "pass" as const;
  if (iteration >= MAX_AUTOMATIC_QA_REPAIRS) return "attention" as const;
  return "revise" as const;
}

export function automaticAcceptanceFailures(
  gates: readonly GateResult[],
): string[] {
  return gates
    .filter((g) => g.required && g.status !== "pass")
    .map(
      (g) =>
        `${g.label}: ${
          g.findings
            .slice(0, 5)
            .map((f) => `${f.where ? `${f.where}: ` : ""}${f.message}`)
            .join("; ") || "not passed"
        }`,
    );
}
