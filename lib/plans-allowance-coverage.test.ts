import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";

// ---------------------------------------------------------------------------
// COVERAGE GUARD — nothing reads the included Mink allowance straight off the
// constants.
//
// The allowance is the one plan limit an operator can move without a deploy
// (`mink_plan_allowances`, migration 0115). `aiAllowanceFor` takes the resolved
// overrides REQUIRED, so a call site that forgets them is a build error — but
// `PLAN_LIMITS[plan].aiGenerationsPerMonth` still typechecks perfectly and
// silently enforces or advertises the compiled-in number instead.
//
// That is not hypothetical: lib/mink/drafts.ts did exactly this, so a draft
// proposal would have metered against the legacy 3/10/50 cap the moment
// MINK_CHARGE_CREDITS was switched on while a conversational run metered
// against 20/100/300 — two halves of one credit pool quoting different caps,
// with nothing failing anywhere. TypeScript cannot catch it. This can.
//
// The rule: read it through `aiAllowanceFor` or `includedMinkCredits`. The only
// module allowed to touch the fields directly is lib/plans.ts, which is where
// the defaults and the merge live.
// ---------------------------------------------------------------------------

/** The two PlanLimits fields the override replaces. */
const ALLOWANCE_FIELDS = "aiGenerationsPerMonth|aiCreditsPerMonth";

/**
 * Where the fields legitimately appear: the catalog itself. Everything else
 * must go through the resolvers.
 *
 * ⚠ `lib` is scanned as well as `app` — the enforcement path lives entirely in
 * `lib` (quota, drafts, run-credits, store-detail), so a guard that scanned
 * only `app` would watch none of the sites that actually matter.
 */
const ALLOWED_FILES = ["lib/plans.ts"];

function grepLines(pattern: string): string[] {
  let out = "";
  try {
    out = execFileSync(
      "grep",
      ["-rEn", "--include=*.ts", "--include=*.tsx", pattern, "app", "lib"],
      {
        encoding: "utf8",
      },
    );
  } catch {
    return []; // grep exits 1 when nothing matches
  }
  return out
    .split("\n")
    .filter(Boolean)
    .filter((line) => !/\.test\.tsx?[-:]/.test(line));
}

describe("★★ included Mink credits are never read from the constants", () => {
  it("routes every consumer through aiAllowanceFor / includedMinkCredits", () => {
    const offenders = grepLines(`\\.(${ALLOWANCE_FIELDS})`).filter((line) => {
      const file = line.split(":")[0];
      if (ALLOWED_FILES.includes(file)) return false;
      // A comment explaining why the field is NOT read here is not a read.
      const code = line.slice(line.indexOf(":", line.indexOf(":") + 1) + 1);
      return !/^\s*(\/\/|\*|\/\*)/.test(code);
    });

    expect(
      offenders,
      `Read the allowance through aiAllowanceFor(plan, charging, allowances) or ` +
        `includedMinkCredits(allowances, charging) — reading PLAN_LIMITS directly ` +
        `ignores the operator override (lib/plans/allowances.ts).`,
    ).toEqual([]);
  });

  it("still finds the fields where they are defined, so the scan is real", () => {
    // A guard that silently matches nothing passes forever. Pin that the
    // pattern and the grep invocation actually work.
    const inCatalog = grepLines(`\\.(${ALLOWANCE_FIELDS})`).filter((line) =>
      line.startsWith("lib/plans.ts:"),
    );
    expect(inCatalog.length).toBeGreaterThan(0);
  });
});
