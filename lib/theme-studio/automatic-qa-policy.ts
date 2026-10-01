import { GATE_LABELS, type GateResult } from "./acceptance-gates";

// Migration 0144 constrains version/run/capture/QA iterations to 0..2.
export const MAX_AUTOMATIC_QA_REPAIRS = 2;

/** A model cannot overrule deterministic gates or repair a broken runtime. */
export function automaticQaDecision(
  gates: readonly GateResult[],
  modelPassed: boolean,
  iteration: number,
) {
  if (Object.keys(GATE_LABELS).some((id) => !gates.some((g) => g.id === id)))
    return "attention" as const;
  const failed = gates.filter((g) => g.required && g.status !== "pass");
  if (failed.some((g) => g.id === "package.security"))
    return "blocked" as const;
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
